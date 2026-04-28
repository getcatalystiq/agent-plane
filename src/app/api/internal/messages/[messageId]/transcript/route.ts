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
import type { TenantId } from "@/lib/types";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ messageId: string }> };

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
 * Internal endpoint called by the sandbox runner to upload transcripts when a
 * detached message reaches its terminal state. Authenticated via an HMAC-based
 * message token bound to the URL `messageId`. Owns the U2 ephemeral-stop
 * responsibility: when the parent session is `ephemeral`, atomically CASes
 * it to `stopped` and stops the sandbox once. Persistent sessions are NEVER
 * stopped here.
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
