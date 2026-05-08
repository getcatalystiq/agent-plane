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

  if (started.kind === "abandoned") return;

  // 4. Stream consumption + posting moved into a step. WDK forbids
  //    `getRun()` from inside a `"use workflow"` body — the runtime
  //    throws USER_ERROR with "The workflow environment doesn't allow
  //    this runtime usage of getRun". The chat workflow originally did
  //    the iteration inline for replay-deterministic step boundaries,
  //    but that pattern conflicts with the WDK runtime rule. The step
  //    captures the entire iterate-and-post lifecycle; durability now
  //    sits at the step boundary (a function-host crash mid-stream
  //    restarts the whole step, which re-reads from index 0 of the
  //    inner workflow's readable).
  //
  //    Trade-off accepted: less granular durability vs. correctness.
  //    A future PR can re-add per-chunk replay determinism by passing
  //    `startIndex` between successive consumeAndPostStep retries
  //    (WDK supports getReadable({ startIndex })).
  await consumeAndPostStep(input, started.innerRunId, started.kind === "orphan");

  await finalizeChatStep(input);
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

// Sentinels let the step bail without throwing (WDK retries thrown
// errors). `abandoned` returns when the circuit breaker fires after
// markBotError; `orphan` returns when the inner workflow ran but the
// placeholder UPDATE failed (cleanup sweep reaps the row at 15min).
type StartedDispatch =
  | { kind: "started"; innerRunId: string }
  | { kind: "abandoned" }
  | { kind: "orphan"; innerRunId: string };

/**
 * Consume the inner dispatchWorkflow's NDJSON readable and post chunks
 * to the chat platform. WDK forbids `getRun()` from inside a workflow
 * body — it must run inside a step. The step owns the entire iterate-
 * and-post lifecycle so the workflow body stays in pure orchestration
 * mode.
 *
 * State machine (was inlined in the workflow body before WDK runtime
 * rejected the inline getRun() call):
 *
 *   responseText     — accumulated full agent reply.
 *   committedLength  — chars sealed into PRIOR (rolled-over) messages.
 *                      Advances ONLY on rollover, never on edit. The
 *                      open (current) message displays
 *                      responseText.slice(committedLength).
 *   messageId        — id of the open message (null = no open message,
 *                      next post creates one). Goes null on rollover.
 *   chunksSinceFlush — # text_delta chunks since the last successful
 *                      post/edit. Replaces the wall-clock edit gate
 *                      so replay hits the same step boundaries.
 *
 * Durability trade-off: a function-host crash mid-stream restarts the
 * whole step, which re-reads from index 0 of the inner readable. WDK
 * step-result caching means a completed step is replayed verbatim, so
 * normal replays don't re-post. A future PR can re-add per-chunk
 * granularity by passing `startIndex` between successive consume
 * retries (WDK supports `getReadable({ startIndex })`).
 */
async function consumeAndPostStep(
  input: ChatTriggerInput,
  innerRunId: string,
  isOrphan: boolean,
): Promise<void> {
  "use step";

  if (isOrphan) {
    // Inner workflow is running but the placeholder UPDATE failed.
    // Cleanup sweep reaps the row at the 15min TTL; retries for the
    // same event_id will INSERT cleanly after that.
    logger.warn("consumeAndPostStep: continuing with orphan placeholder", {
      tenant_id: input.tenantId,
      agent_id: input.agentId,
      thread_key: input.threadKey,
      inner_run_id: innerRunId,
    });
  }

  const readable = getRun<string>(innerRunId).getReadable<string>();
  const reader = readable.getReader();
  const limits = PLATFORM_LIMITS[input.platform];
  const SEAL_SUFFIX_OVERHEAD = 4;
  const maxPerMessage = limits.maxPerMessage - SEAL_SUFFIX_OVERHEAD;
  const CHUNKS_PER_FLUSH = Math.max(1, Math.ceil(EDIT_FLUSH_INTERVAL_MS / APPROX_CHUNK_INTERVAL_MS));

  let responseText = "";
  let committedLength = 0;
  let messageId: string | null = null;
  let backoffChunks = 0;
  let chunksSinceFlush = 0;
  let hasPosted = false;
  let postFailed = false;
  let resultEventCount = 0;

  // Show the platform's native typing indicator so the user sees
  // immediate feedback ("Typing…") while the agent generates its reply.
  // Slack uses `assistant.threads.setStatus` when the bot has the AI
  // Apps feature + assistant:write scope; otherwise falls back to the
  // default typing indicator. Discord uses its standard typing event.
  // The indicator auto-clears when the next message posts to the
  // thread, so no explicit stop call is needed.
  //
  // Replaces the prior "_Thinking…_" placeholder + edit pattern. The
  // placeholder worked but produced an extra message in the thread
  // history (the agent's first turn was always followed by the edited-
  // out placeholder line). Native typing indicators don't leave a
  // residue and work the same way human-to-human chat works.
  //
  // Best-effort: a typing-indicator failure (rate limit, missing scope,
  // adapter error) must NOT block the actual reply. Wrap in try/catch
  // and log a warn.
  try {
    const cached = await resolveCachedBot(input.tenantId, input.agentId, input.platform);
    if (cached) {
      const adapter = cached.adapter as { startTyping?: (threadId: string, status?: string) => Promise<void> };
      if (typeof adapter.startTyping === "function") {
        await adapter.startTyping(input.threadKey);
      }
    }
  } catch (err) {
    logger.warn("consumeAndPostStep: startTyping failed (best-effort, non-blocking)", {
      tenant_id: input.tenantId,
      agent_id: input.agentId,
      thread_key: input.threadKey,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  try {
    while (true) {
      const { value: ndjsonLine, done } = await reader.read();
      if (done) break;
      if (typeof ndjsonLine !== "string") continue;
      const evt = parseNdjsonLine(ndjsonLine);
      if (!evt) continue;

      if (evt.type === "text_delta" && typeof evt.text === "string") {
        // Streaming runner path: per-token deltas accumulate into responseText.
        responseText += evt.text;
        chunksSinceFlush += 1;
      } else if (evt.type === "assistant" && evt.message && typeof evt.message === "object") {
        // Non-streaming runner path (Claude Agent SDK emits full messages,
        // not text_delta chunks). Each `assistant` event carries one
        // complete message in `message.content[].text`. Concatenate the
        // text blocks from this turn into responseText so the final
        // flush has something to post. Multi-turn runs emit multiple
        // assistant events, each with its own message_id and content —
        // appending preserves the chronological order of the agent's
        // turns.
        const blocks = evt.message.content ?? [];
        for (const block of blocks) {
          if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
            responseText += block.text;
            chunksSinceFlush += 1;
          }
        }
      } else if (evt.type === "error") {
        const errorText = typeof evt.message === "string" ? evt.message : "error";
        if (!postFailed) {
          const tail = responseText.slice(committedLength);
          const tailWithError = `${tail}\n\n_(agent stopped early: ${errorText})_`;
          await flushAndFinishStep({ input, text: tailWithError, existingMessageId: messageId });
        }
        await markBotErrorStep(input, errorText);
        return;
      } else if (evt.type === "result" || evt.kind === "terminal") {
        // Fallback: if no `assistant` event seeded responseText (e.g. a
        // runner that only emits the final `result`), use the result
        // string itself. Skip if responseText already has content from
        // assistant or text_delta events.
        if (responseText.length === 0 && typeof evt.result === "string" && evt.result.length > 0) {
          responseText = evt.result;
          chunksSinceFlush += 1;
        }
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
          backoffChunks = Math.min(
            MAX_RATE_LIMITED_BACKOFF_CHUNKS,
            Math.max(2, Math.ceil(result.retryAfterMs / APPROX_CHUNK_INTERVAL_MS)),
          );
        } else {
          postFailed = true;
          logger.error("consumeAndPostStep: post failed; sentinel set", {
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
        const sealedRaw = capped === formatted.flushable
          ? formatted.rawConsumed
          : capped.length;
        committedLength += sealedRaw;
        messageId = null;
      } else {
        messageId = result.messageId;
      }
    }
  } catch (err) {
    logger.error("consumeAndPostStep: stream iteration failed", {
      tenant_id: input.tenantId,
      agent_id: input.agentId,
      error: err instanceof Error ? err.message : String(err),
    });
    await markBotErrorStep(input, err instanceof Error ? err.message : String(err));
    return;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }

  // Final flush — flush any remaining open-message text.
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

  // Empty-readable guard. With native typing indicators (no placeholder
  // post), `hasPosted` is the right tell again — it only becomes true
  // after a real flush succeeds. The native typing indicator auto-clears
  // when no message arrives, so a silent run leaves no residue beyond
  // this acknowledgement post.
  if (!hasPosted && !postFailed && resultEventCount === 0 && responseText === "") {
    logger.warn("consumeAndPostStep: inner dispatch produced no output", {
      tenant_id: input.tenantId,
      agent_id: input.agentId,
      thread_key: input.threadKey,
      inner_run_id: innerRunId,
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
      logger.error("consumeAndPostStep: empty-readable acknowledgement failed", {
        tenant_id: input.tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      await markBotErrorStep(
        input,
        `inner dispatch produced no output AND acknowledgement post failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
}

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

  // DIAG: very-first-line breadcrumb so we can confirm the step body
  // is entered at all. If this log doesn't fire, WDK isn't running our
  // step body (deploy/registration issue). If it fires but later logs
  // don't, the step is throwing in one of the branches below.
  logger.info("startInnerDispatchStep: ENTER", {
    tenant_id: input.tenantId,
    agent_id: input.agentId,
    platform: input.platform,
    event_id: input.eventId,
    thread_key: input.threadKey,
  });

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
  logger.info("startInnerDispatchStep: dedupe INSERT result", {
    event_id: input.eventId,
    won,
  });

  if (!won) {
    logger.info("startInnerDispatchStep: entering loser path", {
      event_id: input.eventId,
    });
    const recovered = await recoverLostClaim(input);
    logger.info("startInnerDispatchStep: recoverLostClaim result", {
      event_id: input.eventId,
      kind: recovered.kind,
    });
    if (recovered.kind === "attached") {
      return { kind: "started", innerRunId: recovered.innerRunId };
    }
    if (recovered.kind === "abandoned") {
      // markBotError gives the user-visible signal; cleanup sweep
      // eventually frees the placeholder so a future retry succeeds.
      await markBotErrorStep(
        input,
        `claim recovery abandoned after ${recovered.attempts} steal attempts; cleanup sweep will free the placeholder shortly`,
      );
      return { kind: "abandoned" };
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

  // Two-stage placeholder fill around start(): pin session_id +
  // message_id BEFORE start() so a failed inner_run_id UPDATE leaves a
  // recoverable orphan instead of silently letting a WDK retry
  // double-dispatch. A single UPDATE after start() would race with
  // WDK retry: an UPDATE-failure → retry-step → poll → steal-after-90s
  // → second start() → duplicate inner workflow.
  let prepared: PreparedExecution;
  try {
    prepared = await reserveSessionAndMessage(dispatchInput);
    logger.info("startInnerDispatchStep: reserveSessionAndMessage OK", {
      event_id: input.eventId,
      session_id: prepared.session.id,
      message_id: prepared.messageId,
      session_status: prepared.session.status,
    });
  } catch (err) {
    logger.error("startInnerDispatchStep: reserveSessionAndMessage threw", {
      event_id: input.eventId,
      thread_key: input.threadKey,
      error_name: err instanceof Error ? err.constructor.name : "unknown",
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  // DIAG: wrap the placeholder UPDATE so we can isolate it as the
  // throw point. Production trace shows `reserveSessionAndMessage OK`
  // fires but `calling start(dispatchWorkflow)` never fires on the
  // winner — meaning the step dies between them. The only thing in
  // between is this UPDATE.
  try {
    await withTenantTransaction(input.tenantId, async (tx) => {
      await tx.execute(
        `UPDATE chat_event_dedupe
         SET session_id = $4, message_id = $5
         WHERE tenant_id = $1 AND platform = $2 AND event_id = $3
           AND inner_run_id IS NULL`,
        [input.tenantId, input.platform, input.eventId, prepared.session.id, prepared.messageId],
      );
    });
    logger.info("startInnerDispatchStep: dedupe UPDATE OK", {
      event_id: input.eventId,
      session_id: prepared.session.id,
      message_id: prepared.messageId,
    });
  } catch (err) {
    logger.error("startInnerDispatchStep: dedupe UPDATE threw", {
      event_id: input.eventId,
      session_id: prepared.session.id,
      message_id: prepared.messageId,
      error_name: err instanceof Error ? err.constructor.name : "unknown",
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }

  // DIAG: log immediately before + after start() so we can correlate
  // the inner runId in Vercel logs and confirm the inner workflow's
  // first step actually fires. The chat path has been observed to
  // produce no /.well-known/workflow/v1/flow POST for the inner run
  // even though start() resolves successfully — narrowing whether the
  // bug is inside start() or downstream (subscription / step replay).
  logger.info("startInnerDispatchStep: calling start(dispatchWorkflow)", {
    tenant_id: input.tenantId,
    agent_id: input.agentId,
    platform: input.platform,
    event_id: input.eventId,
    session_id: prepared.session.id,
    message_id: prepared.messageId,
  });
  let run: { runId: string };
  try {
    run = await start(
      dispatchWorkflow as unknown as (
        input: DispatchInput,
        prepared: PreparedExecution,
      ) => Promise<DispatchWorkflowOutput>,
      [dispatchInput, prepared],
    );
  } catch (err) {
    logger.error("startInnerDispatchStep: start(dispatchWorkflow) THREW", {
      event_id: input.eventId,
      session_id: prepared.session.id,
      message_id: prepared.messageId,
      error_name: err instanceof Error ? err.constructor.name : "unknown",
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    throw err;
  }
  logger.info("startInnerDispatchStep: start(dispatchWorkflow) returned", {
    tenant_id: input.tenantId,
    agent_id: input.agentId,
    platform: input.platform,
    event_id: input.eventId,
    session_id: prepared.session.id,
    message_id: prepared.messageId,
    inner_run_id: run.runId,
  });

  const filled = await retryPlaceholderInnerRunUpdate(input, run.runId);
  return filled
    ? { kind: "started", innerRunId: run.runId }
    : { kind: "orphan", innerRunId: run.runId };
}

const PLACEHOLDER_UPDATE_BACKOFFS_MS = [100, 250, 500] as const;

// Returns true on success, false on retry exhaustion. Caller must NOT
// throw on false: if all retries fail, the inner workflow IS running
// and the user gets their reply this turn — the placeholder is just
// orphaned for the cleanup sweep. Throwing here would cause WDK to
// retry the whole step → duplicate dispatch after the 90s steal.
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
  const attempts = stealResult?.steal_attempts ?? 0;
  if (attempts > MAX_STEAL_ATTEMPTS) {
    logger.error("startInnerDispatchStep: claim recovery abandoned after circuit-breaker threshold", {
      tenant_id: input.tenantId,
      platform: input.platform,
      event_id: input.eventId,
      attempts,
    });
    return { kind: "abandoned", attempts };
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

interface AssistantContentBlock {
  type?: string;
  text?: string;
}

interface AssistantMessage {
  content?: AssistantContentBlock[];
}

interface ParsedEvent {
  type?: string;
  kind?: string;
  text?: string;
  // `message` is overloaded across event types in the inner stream.
  // - On `type: "error"` it's a string (error message text).
  // - On `type: "assistant"` it's the SDK message object with content blocks
  //   carrying the agent reply text.
  message?: string | AssistantMessage;
  // On `type: "result"` Claude SDK emits a top-level `result` field with the
  // final assembled string — used as a fallback if the assistant blocks were
  // somehow empty.
  result?: string;
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
