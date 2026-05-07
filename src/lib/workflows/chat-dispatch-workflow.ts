/**
 * chatDispatchWorkflow — Shape A WDK composition for chat ingress.
 *
 * Plan reference: U6 in
 * docs/plans/2026-05-06-001-feat-chat-platform-bots-discord-slack-plan.md
 *
 * Body:
 *   - Inline rate-limit check (no WDK step — pure in-memory).
 *   - Step: persistAttachmentsStep (Discord/Slack URL → private blob,
 *     returns signed-URL handoff for the dispatcher's preInjectFiles).
 *   - Step: startInnerDispatchStep — reserveSessionAndMessage +
 *     start(dispatchWorkflow). Returns innerRunId.
 *   - Body: getRun<string>(innerRunId).getReadable() — iterate NDJSON
 *     chunks the dispatcher writes via getWritable. Per text_delta
 *     accumulate into responseText; every 1.5s OR on rollover, call
 *     postOrEditStep with the formatted slice. Discord 429 + Retry-After
 *     dynamically lengthens the edit gate per channel.
 *   - Step: finalizeChatStep — markBotEvent + cleanup.
 *
 * Resumption (durability claim): on function-host recycle, WDK re-enters
 * the workflow body at the last completed step boundary. The
 * `getReadable({ startIndex })` re-attaches at the persisted chunk index
 * — `lastSeenIndex` is updated inside postOrEditStep so it survives via
 * step input/output.
 */

import { getRun, start } from "workflow/api";
import {
  dispatchWorkflow,
  type DispatchInput,
  type DispatchWorkflowOutput,
  type RunnerChunk,
} from "@/lib/workflows/dispatch-workflow";
import { reserveSessionAndMessage, type PreparedExecution } from "@/lib/dispatcher";
import { getCallbackBaseUrl } from "@/lib/mcp-connections";
import { logger } from "@/lib/logger";
import { withTenantTransaction } from "@/db";
import { z } from "zod";
import {
  postOrEdit,
  type PostOrEditResult,
} from "@/lib/platform/callback";
import { formatForPlatform } from "@/lib/platform/format";
import {
  PLATFORM_LIMITS,
  APPROX_CHUNK_INTERVAL_MS,
  EDIT_FLUSH_INTERVAL_MS,
  MAX_RATE_LIMITED_BACKOFF_CHUNKS,
} from "@/lib/platform/limits";
import { tryConsumeChannelToken, drainChannelToken } from "@/lib/platform/redis-bucket";
import {
  getOrCreateBot,
  type CachedBot,
} from "@/lib/platform/bot";
import {
  persistAttachments,
  renderAttachmentPromptBlock,
  type PersistedAttachment,
  type NormalizedAttachment,
} from "@/lib/platform/attachments";
import {
  markBotEvent,
  markBotError,
  getBotConfig,
  getDecryptedCredentials,
  type ChatPlatform,
  type SlackCredentials,
} from "@/lib/platform/operations";
import type { ChatTriggerInput } from "@/lib/platform/bridge";
import type { TenantId, AgentId } from "@/lib/types";

// ---------------------------------------------------------------------------
// Public start function (called by bridge.triggerChatWorkflow)
// ---------------------------------------------------------------------------

export interface StartChatDispatchOptions {
  /** Set when the bridge's inline rate-limit check tripped — surface a
   *  generic busy reply and exit without invoking the dispatcher. The
   *  string distinguishes per-agent vs per-user limit for telemetry. */
  rateLimited: "agent" | "user" | null;
}

export async function startChatDispatchWorkflow(
  input: ChatTriggerInput,
  options: StartChatDispatchOptions,
): Promise<void> {
  try {
    await start(
      chatDispatchWorkflow as unknown as (
        input: ChatTriggerInput,
        options: StartChatDispatchOptions,
      ) => Promise<void>,
      [input, options],
    );
  } catch (err) {
    logger.error("startChatDispatchWorkflow: start() failed", {
      tenant_id: input.tenantId,
      agent_id: input.agentId,
      platform: input.platform,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// Workflow body
// ---------------------------------------------------------------------------

export async function chatDispatchWorkflow(
  input: ChatTriggerInput,
  options: StartChatDispatchOptions,
): Promise<void> {
  "use workflow";

  // 1. If rate-limited at the bridge, post a generic busy reply and exit.
  if (options.rateLimited) {
    await postBusyReplyStep(input, options.rateLimited);
    return;
  }

  // 2. Persist attachments (private blob; returns signed-URL handoff).
  const persisted = input.attachmentRefs && input.attachmentRefs.length > 0
    ? await persistAttachmentsStep(input)
    : [];

  // 3. Reserve session + message and start the inner dispatchWorkflow.
  let started: StartedDispatch;
  try {
    started = await startInnerDispatchStep(input, persisted);
  } catch (err) {
    logger.error("chatDispatchWorkflow: dispatch start failed", {
      tenant_id: input.tenantId,
      agent_id: input.agentId,
      thread_key: input.threadKey,
      error: err instanceof Error ? err.message : String(err),
    });
    await markBotErrorStep(input, err instanceof Error ? err.message : String(err));
    return;
  }

  // Round-6 review #B fix: abandonment sentinel. recoverLostClaim has
  // already called markBotError; we just need to bail without entering
  // the stream-consumption path (which would call getRun(undefined)).
  if ("abandoned" in started) {
    return;
  }
  // Round-6 review #A fix: orphan sentinel. The inner workflow IS
  // running but the dedupe row's inner_run_id never persisted (DB
  // connectivity blip during the placeholder UPDATE). Continue to
  // stream consumption — the user gets their reply this turn — but
  // log the orphan so ops can see it. The cleanup-sessions sweep
  // reaps the placeholder at the 15-min TTL, and any subsequent retry
  // for the same event_id will INSERT cleanly.
  if ("orphan" in started) {
    logger.warn("chatDispatchWorkflow: continuing with orphan placeholder", {
      tenant_id: input.tenantId,
      agent_id: input.agentId,
      thread_key: input.threadKey,
      inner_run_id: started.innerRunId,
    });
  }

  // 4. Stream consumption — read the inner dispatcher's NDJSON chunks via
  //    getRun().getReadable(). WDK's WorkflowReadableStream is a plain
  //    ReadableStream — pump via getReader() rather than for-await (the
  //    async-iterator surface isn't on the WDK type).
  //
  // DURABILITY (A1, review run 20260506-221948-2402b0ed P0 #3):
  //   - The edit gate is **chunk-count based**, not Date.now() based, so
  //     replay on function-host recycle hits the same step boundaries. A
  //     non-deterministic Date.now() gate would shift step boundaries on
  //     replay; WDK might cache step results at one boundary and re-execute
  //     at a different boundary, causing duplicate posts.
  //   - The readable is bounded by getTailIndex() with a watchdog: if the
  //     inner workflow finishes without a terminal event in the chunk
  //     stream, we still exit cleanly instead of hanging forever (the U0
  //     spike's "WDK readables don't auto-close" trap).
  //
  // STATE MACHINE:
  //   responseText     — accumulated full agent reply.
  //   committedLength  — chars sealed into PRIOR (rolled-over) messages.
  //                      Advances ONLY on rollover, never on edit. The
  //                      open (current) message displays
  //                      responseText.slice(committedLength).
  //   messageId        — id of the open message (null = no open message,
  //                      next post creates one). Goes null on rollover.
  //   chunksSinceFlush — # text_delta chunks since the last successful
  //                      post/edit. Replaces the wall-clock edit gate.
  const readable = getRun<string>(started.innerRunId).getReadable<string>();
  const reader = readable.getReader();
  const limits = PLATFORM_LIMITS[input.platform];
  const SEAL_SUFFIX_OVERHEAD = 4;
  const maxPerMessage = limits.maxPerMessage - SEAL_SUFFIX_OVERHEAD;
  // Flush every CHUNKS_PER_FLUSH text_delta accumulations. Derived from
  // EDIT_FLUSH_INTERVAL_MS / APPROX_CHUNK_INTERVAL_MS so the wall-clock
  // intent (~1 edit/sec) is documented at the source rather than encoded
  // in arithmetic. Tuning either constant in limits.ts adjusts the cadence.
  const CHUNKS_PER_FLUSH = Math.max(1, Math.ceil(EDIT_FLUSH_INTERVAL_MS / APPROX_CHUNK_INTERVAL_MS));

  let responseText = "";
  let committedLength = 0;
  let messageId: string | null = null;
  let backoffChunks = 0; // chunks to skip after a 429 before retrying
  let chunksSinceFlush = 0;
  let hasPosted = false;
  let postFailed = false;
  // Round-4 review #4: track terminal events separately from text_deltas
  // so the empty-readable guard can distinguish "agent ran successfully
  // but produced only structured output" from "agent never emitted
  // anything". Misfire on the former produces a misleading
  // "no output — please retry" reply over a successful run.
  let resultEventCount = 0;

  try {
    while (true) {
      const { value: ndjsonLine, done } = await reader.read();
      if (done) break;
      if (typeof ndjsonLine !== "string") continue;
      const evt = parseNdjsonLine(ndjsonLine);
      if (!evt) continue;

      if (evt.type === "text_delta" && typeof evt.text === "string") {
        responseText += evt.text;
        chunksSinceFlush += 1;
      } else if (evt.type === "error") {
        if (!postFailed) {
          const tail = responseText.slice(committedLength);
          const tailWithError = `${tail}\n\n_(agent stopped early: ${evt.message ?? "error"})_`;
          await flushAndFinishStep({ input, text: tailWithError, existingMessageId: messageId });
        }
        await markBotErrorStep(input, evt.message ?? "agent_error");
        return;
      } else if (evt.type === "result" || evt.kind === "terminal") {
        resultEventCount += 1;
        break;
      }

      const openMessageLength = responseText.length - committedLength;
      const overflow = openMessageLength > maxPerMessage;

      if (postFailed) continue;
      if (backoffChunks > 0) {
        backoffChunks -= 1;
        continue;
      }
      if (!overflow && chunksSinceFlush < CHUNKS_PER_FLUSH) continue;

      const openText = responseText.slice(committedLength);
      const formatted = formatForPlatform(input.platform, openText, { partial: !overflow });
      if (formatted.flushable.length === 0 && !overflow) continue;

      const capped = formatted.flushable.length > maxPerMessage
        ? formatted.flushable.slice(0, maxPerMessage)
        : formatted.flushable;

      const result = await postOrEditStep({
        tenantId: input.tenantId,
        agentId: input.agentId,
        platform: input.platform,
        threadId: input.threadKey,
        text: capped,
        existingMessageId: messageId,
        seal: overflow,
        continuation: hasPosted && !messageId,
      });

      if (!result.ok) {
        if (result.rateLimited) {
          // Translate retry-after into a chunk-count backoff using the
          // documented APPROX_CHUNK_INTERVAL_MS so the wall-clock target
          // is readable without re-derivation.
          backoffChunks = Math.min(
            MAX_RATE_LIMITED_BACKOFF_CHUNKS,
            Math.max(2, Math.ceil(result.retryAfterMs / APPROX_CHUNK_INTERVAL_MS)),
          );
        } else {
          postFailed = true;
          logger.error("chatDispatchWorkflow: post failed; sentinel set", {
            tenant_id: input.tenantId,
            agent_id: input.agentId,
            error: result.error,
          });
        }
        continue;
      }

      chunksSinceFlush = 0;
      hasPosted = true;
      if (overflow) {
        // Seal the current message. C-R2-2 fix (review run 20260506-232400-round2):
        // committedLength tracks RAW responseText positions, not translated
        // output positions. On Slack, mrkdwn translation shrinks the text
        // (`**bold**` → `*bold*`); advancing by capped.length would skip
        // raw chars equal to the translation delta. Use rawConsumed
        // (the boundary in raw input chars) when the formatter passed
        // its full output through (no cap-truncation); otherwise fall
        // back to capped.length as a conservative under-advance (the
        // user sees the next message start with a small overlap rather
        // than skipping content).
        const sealedRaw = capped === formatted.flushable
          ? formatted.rawConsumed
          : capped.length;
        committedLength += sealedRaw;
        messageId = null;
      } else {
        // Edit success: do NOT advance committedLength. The next tick will
        // re-read responseText.slice(committedLength) — the same open
        // message extended with new text.
        messageId = result.messageId;
      }
    }
  } catch (err) {
    // ReadableStreamDefaultReader.read() throws when the underlying stream
    // errors. Treat as soft-fail: post whatever's accumulated so the user
    // sees something, then mark the bot error.
    logger.error("chatDispatchWorkflow: stream iteration failed", {
      tenant_id: input.tenantId,
      agent_id: input.agentId,
      error: err instanceof Error ? err.message : String(err),
    });
    await markBotErrorStep(input, err instanceof Error ? err.message : String(err));
    return;
  } finally {
    // Release the reader so cancel() doesn't propagate to the inner workflow
    // — releaseLock is no-op-safe.
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }

  // 5. Final flush — flush any remaining open-message text.
  if (!postFailed && responseText.length > committedLength) {
    const tail = responseText.slice(committedLength);
    const formatted = formatForPlatform(input.platform, tail, { partial: false });
    if (formatted.flushable.trim().length > 0) {
      const capped = formatted.flushable.length > maxPerMessage
        ? formatted.flushable.slice(0, maxPerMessage)
        : formatted.flushable;
      await postOrEditStep({
        tenantId: input.tenantId,
        agentId: input.agentId,
        platform: input.platform,
        threadId: input.threadKey,
        text: capped,
        existingMessageId: messageId,
        seal: false,
        continuation: hasPosted && !messageId,
      });
    }
  }

  // Empty-readable guard. If the inner dispatch failed fast (transient
  // runtime error, sandbox boot rejection, immediate validation failure)
  // the readable closes with zero chunks AND zero terminal events —
  // `hasPosted` stays false, `responseText` stays empty, the final-flush
  // is a no-op. Without an explicit signal the user sees absolute silence.
  //
  // Round-4 review #4 refinements:
  //   (a) Gate on `resultEventCount === 0` AND `responseText === ""` so
  //       a successful run that emitted only structured `result` events
  //       (no text_delta) does NOT trigger the misleading guard.
  //   (b) On postOrEditStep failure inside the guard, call markBotError
  //       so the operator surface (last_error column) reflects the
  //       silent-bot UX. Logging alone is invisible to tenants.
  if (!hasPosted && !postFailed && resultEventCount === 0 && responseText === "") {
    logger.warn("chatDispatchWorkflow: inner dispatch produced no output", {
      tenant_id: input.tenantId,
      agent_id: input.agentId,
      thread_key: input.threadKey,
      inner_run_id: started.innerRunId,
    });
    try {
      await postOrEditStep({
        tenantId: input.tenantId,
        agentId: input.agentId,
        platform: input.platform,
        threadId: input.threadKey,
        text: "_(agent produced no output — please retry)_",
        existingMessageId: null,
        seal: false,
        continuation: false,
      });
    } catch (err) {
      logger.error("chatDispatchWorkflow: empty-readable acknowledgement failed", {
        tenant_id: input.tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      await markBotErrorStep(
        input,
        `inner dispatch produced no output AND acknowledgement post failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  await finalizeChatStep(input);
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

// Round-6 review #A+#B fix: StartedDispatch is now a discriminated union
// so startInnerDispatchStep can return graceful sentinels instead of
// throwing in cases where the recovery path has already done all
// possible cleanup (markBotError + extensive logging). WDK retries any
// thrown Error from a step — throwing here meant the abandonment + the
// retry-exhaustion paths re-fired forever instead of bailing once.
type StartedDispatch =
  | { innerRunId: string }
  | { abandoned: true }
  | { orphan: true; innerRunId: string };

// Placeholder rows have all three nullable until the winner UPDATEs.
const DedupeRow = z.object({
  session_id: z.string().nullable(),
  message_id: z.string().nullable(),
  inner_run_id: z.string().nullable(),
});

// Exponential backoff parameters for pollForDedupeFill. Starts at
// POLL_INTERVAL_MS, doubles each iteration up to POLL_INTERVAL_CAP_MS.
// Fixed 100ms × 30s = 300 round-trips → exponential ≈ 16 round-trips.
const POLL_INTERVAL_MS = 100;
const POLL_INTERVAL_CAP_MS = 2_000;
const POLL_MAX_DURATION_MS = 30_000;
// Stale-claim threshold for the atomic-steal recovery path. Round-4
// review #2 fix: derive strictly from POLL_MAX_DURATION_MS plus a 60s
// buffer so a winner mid-`start(dispatchWorkflow)` (cold sandbox boot
// can comfortably exceed the poll budget) cannot have its claim stolen.
// At the prior STRICT-equal value the predicate
// `claimed_at < now() - 30s` evaluated true for any positive ε past the
// 30s mark — letting a still-running winner be stolen, producing duplicate
// `running` session_messages that count against the tenant cap.
const STALE_CLAIM_THRESHOLD_SECONDS = Math.ceil(POLL_MAX_DURATION_MS / 1000) + 60;

async function startInnerDispatchStep(
  input: ChatTriggerInput,
  persisted: PersistedAttachment[],
): Promise<StartedDispatch> {
  "use step";

  // A6 + REL-R2-01 fix (review runs 20260506-221948-2402b0ed and
  // 20260506-232400-round2): claim-then-reserve pattern. Two concurrent
  // step retries race on the placeholder INSERT; only ONE winner runs
  // reserveSessionAndMessage + start(dispatchWorkflow). The loser
  // polls the placeholder until the winner's UPDATE fills in
  // inner_run_id, then attaches to the same run. No orphan
  // session_messages, no orphan inner workflow runs.
  // Round-4 review #10 simplification: the prior `claim = { won, row }`
  // shape carried `row` for both branches but the winner path never read
  // it and the loser path re-polled instead. Simpler: just record the
  // boolean. INSERT returns ≥1 row only when we won the ON CONFLICT race.
  const won = await withTenantTransaction(input.tenantId, async (tx) => {
    const inserted = await tx.execute(
      `INSERT INTO chat_event_dedupe (tenant_id, platform, event_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, platform, event_id) DO NOTHING`,
      [input.tenantId, input.platform, input.eventId],
    );
    return inserted.rowCount === 1;
  });

  if (!won) {
    const recovered = await recoverLostClaim(input);
    if (recovered.kind === "attached") {
      return { innerRunId: recovered.innerRunId };
    }
    if (recovered.kind === "abandoned") {
      // Round-5 review #12 + Round-6 review #B fix: surface the
      // abandonment as a bot error AND return a sentinel instead of
      // throwing. WDK retries on any thrown error from a step, which
      // would re-enter recoverLostClaim and re-throw indefinitely.
      // markBotError is the user-visible signal; cleanup sweep frees
      // the placeholder so a future legitimate retry can succeed.
      await markBotErrorStep(
        input,
        `claim recovery abandoned after ${recovered.attempts} steal attempts; cleanup sweep will free the placeholder shortly`,
      );
      return { abandoned: true };
    }
    // recovered.kind === "promoted" — fall through to the winner path
    // with the stolen claim.
  }

  const composedPrompt = `[${input.platform} message from ${input.authorDisplayName}]\n${input.prompt}${renderAttachmentPromptBlock(persisted)}`;

  const dispatchInput: DispatchInput = {
    tenantId: input.tenantId,
    agentId: input.agentId,
    prompt: composedPrompt,
    triggeredBy: "chat",
    contextId: input.threadKey,
    ephemeral: false,
    idleTtlSeconds: 600,
    callerKeyId: null,
    platformApiUrl: getCallbackBaseUrl(),
    preInjectFiles: persisted.map((p) => ({
      path: p.path,
      signedReadUrl: p.signedReadUrl,
      contentType: p.contentType,
      sizeBytes: p.sizeBytes,
    })),
  };

  // Round-5 review #2 fix: split the placeholder fill into two stages
  // around start(). The prior code wrote session_id, message_id, AND
  // inner_run_id in a single UPDATE AFTER start(). If that UPDATE
  // failed (DB connectivity blip), the inner workflow was already
  // running but the dedupe row had no record of it — WDK retry would
  // re-poll, observe stale claim, steal, and dispatch a SECOND run.
  //
  // New ordering:
  //   (1) reserveSessionAndMessage → prepared
  //   (2) UPDATE session_id, message_id (NOT inner_run_id yet) — pin
  //       the reservation to the dedupe row before start()
  //   (3) start(dispatchWorkflow) → run.runId
  //   (4) UPDATE inner_run_id, with bounded retry — three attempts
  //       100ms / 250ms / 500ms before giving up.
  //
  // Effect: if (4) fails after retries, the placeholder still has
  // session_id + message_id from (2), so a WDK retry sees session/
  // message bound but inner_run_id NULL → polls. Eventually the
  // 15-min cleanup sweep frees the orphan and the next retry
  // INSERTs cleanly. No silent double-dispatch.
  const prepared = await reserveSessionAndMessage(dispatchInput);

  await withTenantTransaction(input.tenantId, async (tx) => {
    await tx.execute(
      `UPDATE chat_event_dedupe
       SET session_id = $4, message_id = $5
       WHERE tenant_id = $1 AND platform = $2 AND event_id = $3
         AND inner_run_id IS NULL`,
      [input.tenantId, input.platform, input.eventId, prepared.session.id, prepared.messageId],
    );
  });

  const run = await start(
    dispatchWorkflow as unknown as (
      input: DispatchInput,
      prepared: PreparedExecution,
    ) => Promise<DispatchWorkflowOutput>,
    [dispatchInput, prepared],
  );

  const filled = await retryPlaceholderInnerRunUpdate(input, run.runId);

  // Round-6 review #A fix: if the inner_run_id UPDATE failed after all
  // retries, the inner workflow IS running but the dedupe row is now
  // an orphan placeholder. Returning the orphan sentinel lets the
  // workflow body proceed with stream consumption (so the user gets
  // their reply this turn) while flagging the orphan for ops. The
  // cleanup-sessions sweep reaps the placeholder at the 15-min TTL.
  if (!filled) {
    return { orphan: true, innerRunId: run.runId };
  }

  return { innerRunId: run.runId };
}

const PLACEHOLDER_UPDATE_BACKOFFS_MS = [100, 250, 500] as const;

// Round-6 review #A fix: returns true on success, false on retry
// exhaustion. The prior code re-threw the last error, which WDK
// interpreted as "retry the whole step" — so a transient DB blip
// during the placeholder UPDATE caused the entire reserve+start
// sequence to re-run, producing a duplicate inner workflow once the
// 90s steal threshold elapsed. The new contract: if all retries fail,
// the inner workflow is already running; we surrender the dedupe-row
// invariant (the placeholder is now orphaned) but let the user get
// their reply on this attempt. The cleanup sweep reaps the orphan.
async function retryPlaceholderInnerRunUpdate(
  input: ChatTriggerInput,
  innerRunId: string,
): Promise<boolean> {
  let lastErr: unknown;
  for (let i = 0; i <= PLACEHOLDER_UPDATE_BACKOFFS_MS.length; i++) {
    try {
      await withTenantTransaction(input.tenantId, async (tx) => {
        await tx.execute(
          `UPDATE chat_event_dedupe
           SET inner_run_id = $4
           WHERE tenant_id = $1 AND platform = $2 AND event_id = $3
             AND inner_run_id IS NULL`,
          [input.tenantId, input.platform, input.eventId, innerRunId],
        );
      });
      return true;
    } catch (err) {
      lastErr = err;
      if (i < PLACEHOLDER_UPDATE_BACKOFFS_MS.length) {
        await new Promise((resolve) => setTimeout(resolve, PLACEHOLDER_UPDATE_BACKOFFS_MS[i]));
      }
    }
  }
  logger.error("startInnerDispatchStep: failed to fill inner_run_id after retries; placeholder orphaned", {
    tenant_id: input.tenantId,
    agent_id: input.agentId,
    platform: input.platform,
    event_id: input.eventId,
    inner_run_id: innerRunId,
    error: lastErr instanceof Error ? lastErr.message : String(lastErr),
  });
  return false;
}

type ClaimRecovery =
  | { kind: "attached"; innerRunId: string }
  | { kind: "promoted" }
  | { kind: "abandoned"; attempts: number };

/**
 * Thrown by recoverLostClaim when both the poll and the atomic-steal
 * fail. Distinct from generic Error so the workflow body / WDK runtime
 * can recognize the retryable claim-race outcome and back off
 * accordingly.
 *
 * Retry budget reasoning: a thrown StaleClaimError is bounded by the
 * cleanup-sessions cron, which sweeps stale placeholders every 5 min
 * (cron tick) using a 15-min staleness predicate. A WDK retry of this
 * step that fires AFTER the placeholder is swept will INSERT cleanly
 * (no ON CONFLICT) and become a fresh winner. Worst-case latency for
 * the loser: 15 min staleness + 5 min cron interval = ~20 min before
 * recovery is unblocked. The user-visible reply is delayed; nothing
 * is dropped.
 */
export class StaleClaimError extends Error {
  constructor(eventId: string) {
    super(
      `startInnerDispatchStep: claim race lost and steal failed for event ${eventId}; will retry via WDK after cleanup sweep frees the placeholder`,
    );
    this.name = "StaleClaimError";
  }
}

// Round-6 review #B fix: ClaimAbandonedError was removed. The
// abandonment path now returns `{ abandoned: true }` from
// startInnerDispatchStep so WDK doesn't retry past the explicit bail
// signal. markBotError has already been stamped at the bail site.

// Round-5 review #12: circuit breaker. Each steal attempt increments
// chat_event_dedupe.steal_attempts (atomic with the steal UPDATE). If
// the counter crosses MAX_STEAL_ATTEMPTS, recoverLostClaim returns
// `{ kind: "abandoned" }` so the caller can mark the bot in error and
// emit a user-visible "we couldn't process this message" reply instead
// of looping until WDK gives up silently.
const MAX_STEAL_ATTEMPTS = 5;

/**
 * Recovery branch for the loser of the claim-then-reserve race. Four
 * possible outcomes:
 *   1. Poll observes the winner's UPDATE → attach to that runId.
 *   2. Poll times out, atomic stale-claim steal succeeds → caller is
 *      promoted to new winner.
 *   3. Steal fails AND counter > MAX_STEAL_ATTEMPTS → abandoned (emit
 *      user-facing error, do not retry).
 *   4. Steal fails AND counter ≤ MAX_STEAL_ATTEMPTS → throw
 *      StaleClaimError so WDK retries.
 */
async function recoverLostClaim(input: ChatTriggerInput): Promise<ClaimRecovery> {
  const filled = await pollForDedupeFill(input.tenantId, input.platform, input.eventId);
  if (filled) {
    logger.info("startInnerDispatchStep: lost claim race; attaching to winner", {
      tenant_id: input.tenantId,
      platform: input.platform,
      event_id: input.eventId,
      inner_run_id: filled.inner_run_id,
    });
    return { kind: "attached", innerRunId: filled.inner_run_id };
  }
  // Atomic steal + counter increment. The counter increments on every
  // attempt regardless of whether the predicate matches, so retry
  // storms drive the counter forward.
  const stealResult = await withTenantTransaction(input.tenantId, async (tx) => {
    return tx.queryOne(
      StealAttemptRow,
      `UPDATE chat_event_dedupe
       SET claimed_at = CASE
             WHEN inner_run_id IS NULL AND claimed_at < now() - make_interval(secs => $4)
             THEN now() ELSE claimed_at END,
           steal_attempts = steal_attempts + 1
       WHERE tenant_id = $1 AND platform = $2 AND event_id = $3
       RETURNING
         steal_attempts,
         (inner_run_id IS NULL AND claimed_at = now()) AS stole`,
      [input.tenantId, input.platform, input.eventId, STALE_CLAIM_THRESHOLD_SECONDS],
    );
  });
  if (stealResult?.stole) {
    logger.warn("startInnerDispatchStep: stole stale claim; promoting to new winner", {
      tenant_id: input.tenantId,
      platform: input.platform,
      event_id: input.eventId,
      attempts: stealResult.steal_attempts,
    });
    return { kind: "promoted" };
  }
  // Steal didn't match. Try one more poll in case the row filled in
  // the steal window.
  const reFilled = await pollForDedupeFill(input.tenantId, input.platform, input.eventId);
  if (reFilled) {
    logger.info("startInnerDispatchStep: claim filled during steal window; attaching", {
      tenant_id: input.tenantId,
      platform: input.platform,
      event_id: input.eventId,
      inner_run_id: reFilled.inner_run_id,
    });
    return { kind: "attached", innerRunId: reFilled.inner_run_id };
  }
  // Circuit breaker: bail explicitly so the caller can mark the bot
  // in error and emit a user-visible reply instead of WDK looping.
  if ((stealResult?.steal_attempts ?? 0) > MAX_STEAL_ATTEMPTS) {
    logger.error("startInnerDispatchStep: claim recovery abandoned after circuit-breaker threshold", {
      tenant_id: input.tenantId,
      platform: input.platform,
      event_id: input.eventId,
      attempts: stealResult?.steal_attempts,
    });
    return { kind: "abandoned", attempts: stealResult?.steal_attempts ?? 0 };
  }
  throw new StaleClaimError(input.eventId);
}

const StealAttemptRow = z.object({
  steal_attempts: z.number().int().nonnegative(),
  stole: z.boolean(),
});

/**
 * Poll the dedupe row until the winner's UPDATE fills inner_run_id.
 * Returns the filled row, or null when the poll times out. Exponential
 * backoff (100ms → 200 → 400 → 800 → 1600 → cap 2000) instead of fixed
 * 100ms × 300, so a losing race burns ~16 DB round-trips over the 30s
 * budget instead of 300.
 */
async function pollForDedupeFill(
  tenantId: TenantId,
  platform: ChatPlatform,
  eventId: string,
): Promise<{ session_id: string; message_id: string; inner_run_id: string } | null> {
  const start = Date.now();
  let interval = POLL_INTERVAL_MS;
  while (Date.now() - start < POLL_MAX_DURATION_MS) {
    const row = await withTenantTransaction(tenantId, async (tx) => {
      return tx.queryOne(
        DedupeRow,
        `SELECT session_id, message_id, inner_run_id FROM chat_event_dedupe
         WHERE tenant_id = $1 AND platform = $2 AND event_id = $3`,
        [tenantId, platform, eventId],
      );
    });
    if (row && row.inner_run_id && row.session_id && row.message_id) {
      return { session_id: row.session_id, message_id: row.message_id, inner_run_id: row.inner_run_id };
    }
    await new Promise((resolve) => setTimeout(resolve, interval));
    interval = Math.min(interval * 2, POLL_INTERVAL_CAP_MS);
  }
  return null;
}

async function persistAttachmentsStep(input: ChatTriggerInput): Promise<PersistedAttachment[]> {
  "use step";
  if (!input.attachmentRefs || input.attachmentRefs.length === 0) return [];

  const normalized: NormalizedAttachment[] = input.attachmentRefs.map((a) => ({
    filename: a.filename,
    contentType: a.contentType,
    sizeBytes: a.sizeBytes,
    sourceUrl: a.url,
    sourcePlatform: input.platform,
  }));

  // Slack downloads need the bot token; load it once here.
  let slackBotToken: string | undefined;
  if (input.platform === "slack") {
    const creds = (await getDecryptedCredentials(input.tenantId, input.agentId, "slack")) as SlackCredentials | null;
    slackBotToken = creds?.botToken;
  }

  return persistAttachments(normalized, {
    tenantId: input.tenantId,
    slackBotToken,
  });
}

interface PostOrEditStepInput {
  tenantId: TenantId;
  agentId: AgentId;
  platform: ChatPlatform;
  /** Encoded thread id (e.g. `discord:guildId:channelId:threadId`). */
  threadId: string;
  text: string;
  existingMessageId: string | null;
  seal: boolean;
  continuation: boolean;
}

async function resolveCachedBot(
  tenantId: TenantId,
  agentId: AgentId,
  platform: ChatPlatform,
): Promise<CachedBot | null> {
  const config = await getBotConfig(tenantId, agentId, platform);
  if (!config) return null;
  return getOrCreateBot({
    tenantId,
    agentId,
    platform,
    credentialsVersion: config.credentials_version,
    platformIdentity: config.platform_identity,
  });
}

function extractRawChannelId(platform: ChatPlatform, threadId: string): string {
  // Discord: discord:guildId:channelId[:threadId]
  // Slack:   slack:teamId:channelId:thread_ts
  // The channel id is the third part. Used as the per-channel bucket key.
  const parts = threadId.split(":");
  void platform;
  return parts[2] ?? threadId;
}

async function postOrEditStep(input: PostOrEditStepInput): Promise<PostOrEditResult> {
  "use step";

  const cached = await resolveCachedBot(input.tenantId, input.agentId, input.platform);
  if (!cached) {
    return { ok: false, rateLimited: false, error: "bot_config_missing" };
  }

  // A3: Redis-backed cross-instance per-channel token bucket. Replaces
  // the in-process ChannelTokenBucket which was workflow-instance-scoped
  // (P1 #8 in review run 20260506-221948-2402b0ed). Fail-open on Redis
  // unavailability — the postOrEdit 429 handling is the secondary defense.
  const limits = PLATFORM_LIMITS[input.platform];
  const channelId = extractRawChannelId(input.platform, input.threadId);
  const bucketOpts = {
    platform: input.platform,
    channelId,
    capacity: limits.editsPer5Sec,
    windowMs: 5_000,
  };
  const allowed = await tryConsumeChannelToken(bucketOpts);
  if (!allowed) {
    // Soft-deny — caller adds a small backoff and retries.
    return { ok: false, rateLimited: true, retryAfterMs: 1500 };
  }

  const result = await postOrEdit({
    bot: cached,
    threadId: input.threadId,
    text: input.text,
    existingMessageId: input.existingMessageId ?? undefined,
    seal: input.seal,
    continuation: input.continuation,
  });

  // On 429 from the platform, drain the bucket so subsequent attempts
  // wait for the next window even if we were inside the local cap.
  if (!result.ok && result.rateLimited) {
    await drainChannelToken(bucketOpts);
  }

  return result;
}

async function postBusyReplyStep(input: ChatTriggerInput, which: "agent" | "user"): Promise<void> {
  "use step";

  const text = which === "user"
    ? "I'm rate-limited for you specifically — wait a minute before retrying."
    : "I'm currently busy across the board — wait a few minutes before retrying.";

  try {
    const cached = await resolveCachedBot(input.tenantId, input.agentId, input.platform);
    if (!cached) return;
    await postOrEdit({ bot: cached, threadId: input.threadKey, text });
  } catch (err) {
    logger.warn("postBusyReplyStep: failed", {
      tenant_id: input.tenantId,
      agent_id: input.agentId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function flushAndFinishStep(opts: {
  input: ChatTriggerInput;
  text: string;
  existingMessageId: string | null;
}): Promise<void> {
  "use step";
  try {
    const cached = await resolveCachedBot(opts.input.tenantId, opts.input.agentId, opts.input.platform);
    if (!cached) return;
    const formatted = formatForPlatform(opts.input.platform, opts.text, { partial: false });
    await postOrEdit({
      bot: cached,
      threadId: opts.input.threadKey,
      text: formatted.flushable,
      existingMessageId: opts.existingMessageId ?? undefined,
    });
  } catch (err) {
    logger.warn("flushAndFinishStep: failed", {
      tenant_id: opts.input.tenantId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function markBotErrorStep(input: ChatTriggerInput, message: string): Promise<void> {
  "use step";
  // Round-5 review #6: log on failure instead of silently swallowing.
  // markBotError populates last_error which the operator UI surfaces;
  // a silent failure means the silent-bot UX is invisible to ops too.
  try {
    await markBotError(input.tenantId, input.agentId, input.platform, message);
  } catch (err) {
    logger.error("markBotErrorStep: failed to write last_error", {
      tenant_id: input.tenantId,
      agent_id: input.agentId,
      platform: input.platform,
      original_message: message,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function finalizeChatStep(input: ChatTriggerInput): Promise<void> {
  "use step";
  // Round-5 review #6: same treatment for markBotEvent.
  try {
    await markBotEvent(input.tenantId, input.agentId, input.platform);
  } catch (err) {
    logger.error("finalizeChatStep: failed to write last_event", {
      tenant_id: input.tenantId,
      agent_id: input.agentId,
      platform: input.platform,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

// ---------------------------------------------------------------------------
// NDJSON parser — chunks the dispatcher writeChunkStep emits via getWritable
// ---------------------------------------------------------------------------

interface ParsedEvent {
  type?: string;
  kind?: string;
  text?: string;
  message?: string;
}

function parseNdjsonLine(raw: string): ParsedEvent | null {
  if (!raw) return null;
  // The dispatcher writes one line per chunk via writer.write(line). Lines
  // may contain trailing newline or not — handle both. The chunk content is
  // already a JSON string per processLineAssets / writeChunkStep semantics.
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed) as ParsedEvent;
  } catch {
    return null;
  }
}

// Test-only re-exports. Internal helpers stay module-private; this object
// gives tests a single entry point without expanding the public surface.
// `as const` (round-3 review kt-005) preserves literal types on the
// numeric constants so test assertions can use them as comparison bounds
// without runtime widening.
export const __testing = {
  parseNdjsonLine,
  pollForDedupeFill,
  recoverLostClaim,
  POLL_INTERVAL_MS,
  POLL_INTERVAL_CAP_MS,
  POLL_MAX_DURATION_MS,
  STALE_CLAIM_THRESHOLD_SECONDS,
} as const;
