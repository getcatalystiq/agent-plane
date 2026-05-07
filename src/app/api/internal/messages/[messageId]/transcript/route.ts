import { NextRequest } from "next/server";
import { z } from "zod";
import { queryOne, withTenantTransaction } from "@/db";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { verifyMessageToken } from "@/lib/crypto";
import { getEnv } from "@/lib/env";
import { uploadTranscript } from "@/lib/transcripts";
import { transitionMessageStatus } from "@/lib/session-messages";
import { parseResultEvent, NO_TERMINAL_EVENT_FALLBACK } from "@/lib/transcript-utils";
import { processLineAssets } from "@/lib/assets";
import { reconnectSandbox } from "@/lib/sandbox";
import { casActiveToIdle } from "@/lib/sessions";
import { logger } from "@/lib/logger";
import {
  checkBatchDedup,
  markBatchSeen,
  reserveLines,
  resumeHookBatch,
  parseRunnerLine,
  type RunnerChunkPayload,
} from "@/lib/workflows/stream-bridge-server";
import type { TenantId } from "@/lib/types";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ messageId: string }> };

/**
 * Per-message line cap. Bounds stolen-token blast radius (SEC-002 in the
 * plan). The plan recommended `max_runtime_seconds * 100` per-message;
 * v1 hard-codes the worst-case (3600s * 100 = 360k) since the agent's
 * runtime cap is enforced at the runner-spawn level. Cap can be tightened
 * to per-message-from-agent in a follow-up if production traffic shows
 * abuse.
 */
const MAX_TRANSCRIPT_LINES_PER_MESSAGE = 360_000;

const MessageRow = z.object({
  id: z.string(),
  tenant_id: z.string(),
  session_id: z.string(),
  status: z.string(),
});

const SessionRowMin = z.object({
  id: z.string(),
  sandbox_id: z.string().nullable(),
  ephemeral: z.boolean(),
  status: z.string(),
});

const StoppedSandboxRow = z.object({ sandbox_id: z.string().nullable() });

/**
 * Internal endpoint called by the sandbox runner to upload transcripts.
 * Authenticated via an HMAC-based message token bound to the URL
 * `messageId`.
 *
 * Two modes distinguished by header presence:
 *
 *   - **streaming** (U3): when `X-Runner-Attempt-Sequence` is set, the
 *     POST is a per-batch streaming chunk. Body is one or more NDJSON
 *     lines; each is parsed, dedup-checked, line-cap-checked, and
 *     forwarded to the workflow's hook via `resumeHook(transcript:msgId,
 *     payload)`. Headers also carry `X-Batch-Sequence` (within an
 *     attempt). Both legacy and streaming runners use the same
 *     `Content-Type: application/x-ndjson`, so dispatching by Content-Type
 *     would route legacy POSTs into the streaming handler — the
 *     `X-Runner-Attempt-Sequence` header is the disambiguator.
 *
 *   - **legacy** (single-blob terminal POST): runner submits the full
 *     transcript at the end; endpoint owns finalize, blob upload,
 *     ephemeral-stop, and casActiveToIdle for detached persistent
 *     runs. Kept until U10 retirement.
 *
 * The streaming mode does NOT finalize the message — the workflow's
 * `finalizeStep` does that after the workflow body's `for await` breaks
 * on the terminal-kind chunk. Legacy mode finalizes inline.
 */
export const POST = withErrorHandler(async (request: NextRequest, context) => {
  const { messageId } = await (context as RouteContext).params;

  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return jsonResponse(
      { error: { code: "unauthorized", message: "Missing authorization" } },
      401,
    );
  }
  const token = authHeader.slice(7);
  const env = getEnv();
  const valid = await verifyMessageToken(token, messageId, env.ENCRYPTION_KEY);
  if (!valid) {
    return jsonResponse(
      { error: { code: "unauthorized", message: "Invalid message token" } },
      401,
    );
  }

  const message = await queryOne(
    MessageRow,
    "SELECT id, tenant_id, session_id, status FROM session_messages WHERE id = $1",
    [messageId],
  );
  if (!message) {
    return jsonResponse(
      { error: { code: "not_found", message: "Message not found" } },
      404,
    );
  }
  if (message.status !== "running") {
    return jsonResponse(
      {
        error: {
          code: "conflict",
          message: `Message is ${message.status}, not running`,
        },
      },
      409,
    );
  }

  const tenantId = message.tenant_id as TenantId;

  // --- Mode dispatch by header presence ---
  // Streaming-mode runners emit `X-Runner-Attempt-Sequence`; legacy
  // single-blob runners do not. Dispatch by Content-Type alone would
  // route legacy POSTs (which use application/x-ndjson) into the new
  // streaming handler, breaking backward compatibility.
  if (request.headers.get("x-runner-attempt-sequence") !== null) {
    return await handleStreamingBatch(request, messageId, tenantId);
  }

  // --- Legacy single-blob mode below (kept verbatim until U10) ---

  const body = await request.text();
  const lines = body.split("\n").filter((l) => l.trim());
  if (lines.length === 0) {
    return jsonResponse(
      { error: { code: "validation_error", message: "Empty transcript" } },
      400,
    );
  }

  try {
    const processedLines = await Promise.all(
      lines.map((line) => processLineAssets(line, tenantId, messageId)),
    );
    const transcript = processedLines.join("\n") + "\n";
    const blobUrl = await uploadTranscript(tenantId, messageId, transcript);
    const resultData =
      (await parseResultEvent(lines[lines.length - 1])) ?? NO_TERMINAL_EVENT_FALLBACK;

    await transitionMessageStatus(
      messageId,
      tenantId,
      "running",
      resultData.status,
      {
        completed_at: new Date().toISOString(),
        transcript_blob_url: blobUrl,
        ...resultData.updates,
      },
    );

    logger.info("Internal transcript uploaded", {
      message_id: messageId,
      session_id: message.session_id,
      lines: lines.length,
    });

    // U2 ephemeral-stop responsibility — atomic CAS inside a tenant-scoped tx.
    // Persistent sessions are NEVER stopped here even with a stolen token.
    let sandboxIdToStop: string | null = null;
    await withTenantTransaction(tenantId, async (tx) => {
      const session = await tx.queryOne(
        SessionRowMin,
        "SELECT id, sandbox_id, ephemeral, status FROM sessions WHERE id = $1",
        [message.session_id],
      );
      if (!session) return;
      if (!session.ephemeral) return; // persistent — leave alone
      if (session.status === "stopped") return; // already stopped — idempotent

      const stopped = await tx.queryOne(
        StoppedSandboxRow,
        `UPDATE sessions
         SET status = 'stopped', sandbox_id = NULL, idle_since = NULL
         WHERE id = $1 AND ephemeral = true AND status NOT IN ('stopped')
         RETURNING sandbox_id`,
        [message.session_id],
      );
      if (stopped?.sandbox_id) {
        sandboxIdToStop = stopped.sandbox_id;
      }
    });

    if (sandboxIdToStop) {
      try {
        const sandbox = await reconnectSandbox(sandboxIdToStop);
        if (sandbox) await sandbox.stop();
      } catch (err) {
        logger.warn("Failed to stop ephemeral sandbox after transcript upload", {
          message_id: messageId,
          sandbox_id: sandboxIdToStop,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // FIX #2: persistent (ephemeral=false) detached path.
    // When the dispatcher stream detached at 4.5min, finalizeMessage is
    // skipped — the session remains in 'active' until the 30min watchdog,
    // and subsequent message dispatches 409. CAS active → idle here so
    // follow-up messages can claim the slot. Sandbox stays warm.
    // The helper is a no-op for ephemeral sessions (already stopped above)
    // and races safely with any live dispatcher finalize.
    try {
      const flipped = await casActiveToIdle(
        message.session_id,
        tenantId,
        messageId,
      );
      if (flipped) {
        logger.info("Persistent session flipped active→idle (detached path)", {
          message_id: messageId,
          session_id: message.session_id,
        });
      }
    } catch (err) {
      logger.warn("casActiveToIdle failed (non-fatal)", {
        message_id: messageId,
        session_id: message.session_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    return jsonResponse({ status: "ok" });
  } catch (err) {
    logger.error("Internal transcript upload failed", {
      message_id: messageId,
      error: err instanceof Error ? err.message : String(err),
    });
    await transitionMessageStatus(messageId, tenantId, "running", "failed", {
      completed_at: new Date().toISOString(),
      error_type: "transcript_persist_error",
      error_messages: [err instanceof Error ? err.message : String(err)],
    });
    return jsonResponse(
      { error: { code: "internal_error", message: "Failed to persist transcript" } },
      500,
    );
  }
});

// ---------------------------------------------------------------------------
// Per-line streaming (U3) — Content-Type: application/x-ndjson
// ---------------------------------------------------------------------------

/**
 * Handle a per-batch streaming POST from the runner.
 *
 * Headers:
 *   - X-Runner-Attempt-Sequence (required, integer ≥ 0): monotonic per run,
 *     resets when R6 auto-reissue boots a fresh runner
 *   - X-Batch-Sequence (required, integer ≥ 0): increments per POST within
 *     an attempt
 *
 * Body: NDJSON lines, one per JSON event from the runner.
 *
 * Responses:
 *   - 200 OK: lines forwarded to resumeHook (or duplicate batch — idempotent)
 *   - 400: malformed headers or empty body
 *   - 429 (with Retry-After): per-message line cap exceeded
 *   - 503 (retryable): resumeHook returned HookNotFoundError or transient
 *     WDK error — runner backs off per its policy (100ms→1.6s, 30s budget)
 */
async function handleStreamingBatch(
  request: NextRequest,
  messageId: string,
  tenantId: TenantId,
): Promise<Response> {
  const attemptSeqHeader = request.headers.get("x-runner-attempt-sequence");
  const batchSeqHeader = request.headers.get("x-batch-sequence");
  if (attemptSeqHeader === null || batchSeqHeader === null) {
    return jsonResponse(
      {
        error: {
          code: "validation_error",
          message:
            "Missing X-Runner-Attempt-Sequence or X-Batch-Sequence header",
        },
      },
      400,
    );
  }
  const attemptSequence = Number(attemptSeqHeader);
  const batchSequence = Number(batchSeqHeader);
  if (
    !Number.isInteger(attemptSequence) ||
    attemptSequence < 0 ||
    !Number.isInteger(batchSequence) ||
    batchSequence < 0
  ) {
    return jsonResponse(
      {
        error: {
          code: "validation_error",
          message:
            "X-Runner-Attempt-Sequence and X-Batch-Sequence must be non-negative integers",
        },
      },
      400,
    );
  }

  // Idempotent: a duplicate (attemptSequence, batchSequence) returns 200 OK
  // without re-forwarding to the hook. The runner's retry-on-5xx policy
  // can produce duplicate POSTs under network reorder; the dedup catches
  // those without entering the workflow stream twice.
  if (
    checkBatchDedup(messageId, attemptSequence, batchSequence) === "duplicate"
  ) {
    logger.info("transcript-streaming: duplicate batch ignored", {
      message_id: messageId,
      attempt_sequence: attemptSequence,
      batch_sequence: batchSequence,
    });
    return jsonResponse({ status: "duplicate", delivered: 0 });
  }

  const body = await request.text();
  const rawLines = body.split("\n").filter((l) => l.trim());
  if (rawLines.length === 0) {
    return jsonResponse(
      { error: { code: "validation_error", message: "Empty NDJSON body" } },
      400,
    );
  }

  // Per-message line cap — bounds stolen-token blast radius.
  const reservation = reserveLines(
    messageId,
    rawLines.length,
    MAX_TRANSCRIPT_LINES_PER_MESSAGE,
  );
  if (!reservation.allowed) {
    logger.warn("transcript-streaming: line cap exceeded", {
      message_id: messageId,
      cap: reservation.cap,
      remaining: reservation.remaining,
    });
    return new Response(
      JSON.stringify({
        error: {
          code: "rate_limited",
          message: `Per-message line cap of ${reservation.cap} exceeded`,
        },
      }),
      {
        status: 429,
        headers: {
          "content-type": "application/json",
          "retry-after": "60",
        },
      },
    );
  }

  // Parse NDJSON lines into RunnerChunkPayloads. Empty lines are filtered
  // by parseRunnerLine (returns null); malformed JSON falls back to
  // eventType='unknown' rather than throwing.
  const payloads: RunnerChunkPayload[] = [];
  for (const line of rawLines) {
    const parsed = parseRunnerLine(line);
    if (parsed) payloads.push(parsed);
  }

  // Forward to the workflow's hook. The dedup mark is set ONLY on
  // successful delivery so a HookNotFoundError lets the runner retry
  // the same batch.
  const result = await resumeHookBatch(messageId, payloads);

  if (result.hookNotFound) {
    logger.info("transcript-streaming: hook not found — retryable", {
      message_id: messageId,
      attempt_sequence: attemptSequence,
      batch_sequence: batchSequence,
      delivered_before_failure: result.delivered,
    });
    return new Response(
      JSON.stringify({
        error: {
          code: "hook_not_found",
          message: "Workflow hook not yet registered; retry with backoff",
        },
      }),
      {
        status: 503,
        headers: {
          "content-type": "application/json",
          "retry-after": "1",
        },
      },
    );
  }
  if (result.otherError) {
    logger.warn("transcript-streaming: resumeHook error", {
      message_id: messageId,
      attempt_sequence: attemptSequence,
      batch_sequence: batchSequence,
      error: result.otherError,
      delivered_before_failure: result.delivered,
    });
    return new Response(
      JSON.stringify({
        error: { code: "resume_hook_error", message: result.otherError },
      }),
      {
        status: 503,
        headers: {
          "content-type": "application/json",
          "retry-after": "1",
        },
      },
    );
  }

  // All payloads delivered — mark the dedup tuple as seen.
  markBatchSeen(messageId, attemptSequence, batchSequence);

  logger.debug("transcript-streaming: batch delivered", {
    message_id: messageId,
    attempt_sequence: attemptSequence,
    batch_sequence: batchSequence,
    delivered: result.delivered,
    remaining_lines: reservation.remaining,
  });

  return jsonResponse({
    status: "ok",
    delivered: result.delivered,
    remaining_lines: reservation.remaining,
  });
}
