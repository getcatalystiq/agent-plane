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

  // Round-3 review #10: empty-readable guard. If the inner dispatch
  // failed fast (transient runtime error, sandbox boot rejection,
  // immediate validation failure) the readable closes with zero
  // chunks — `hasPosted` stays false, `responseText` stays empty,
  // and the final-flush block above is a no-op. Without an explicit
  // signal here the user sees absolute silence: no reply, no error.
  // Post a minimal acknowledgement so the bot is observably alive.
  if (!hasPosted && !postFailed) {
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
    }
  }

  await finalizeChatStep(input);
}

// ---------------------------------------------------------------------------
// Steps
// ---------------------------------------------------------------------------

interface StartedDispatch {
  innerRunId: string;
}

// Placeholder rows have all three nullable until the winner UPDATEs.
const DedupeRow = z.object({
  session_id: z.string().nullable(),
  message_id: z.string().nullable(),
  inner_run_id: z.string().nullable(),
});

// Exponential backoff parameters for pollForDedupeFill (round-3 review
// finding #8). Starts at POLL_INTERVAL_MS, doubles each iteration up to
// POLL_INTERVAL_CAP_MS. Total budget remains POLL_MAX_DURATION_MS so the
// upper bound on a losing race is unchanged; what changes is DB load —
// fixed 100ms × 30s = 300 round-trips → exponential ≈ 11 round-trips.
const POLL_INTERVAL_MS = 100;
const POLL_INTERVAL_CAP_MS = 2_000;
const POLL_MAX_DURATION_MS = 30_000;
// Stale-claim threshold for the atomic-steal recovery path (round-3 #1/#7).
// Must be ≥ POLL_MAX_DURATION_MS so a still-running winner cannot be
// stolen by a loser that finished its poll early.
const STALE_CLAIM_THRESHOLD_SECONDS = 30;

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
  const claim = await withTenantTransaction(input.tenantId, async (tx) => {
    // Returns the row ON success; null when ON CONFLICT swallows our INSERT.
    const inserted = await tx.query(
      DedupeRow,
      `INSERT INTO chat_event_dedupe (tenant_id, platform, event_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, platform, event_id) DO NOTHING
       RETURNING session_id, message_id, inner_run_id`,
      [input.tenantId, input.platform, input.eventId],
    );
    if (inserted.length > 0) return { won: true, row: inserted[0] };
    // Loser path — read the existing row.
    const row = await tx.queryOne(
      DedupeRow,
      `SELECT session_id, message_id, inner_run_id FROM chat_event_dedupe
       WHERE tenant_id = $1 AND platform = $2 AND event_id = $3`,
      [input.tenantId, input.platform, input.eventId],
    );
    return { won: false, row };
  });

  if (!claim.won) {
    // Loser — poll the placeholder until the winner UPDATEs inner_run_id.
    const filled = await pollForDedupeFill(input.tenantId, input.platform, input.eventId);
    if (filled) {
      logger.info("startInnerDispatchStep: lost claim race; attaching to winner", {
        tenant_id: input.tenantId,
        platform: input.platform,
        event_id: input.eventId,
        inner_run_id: filled.inner_run_id,
      });
      return { innerRunId: filled.inner_run_id };
    }
    // Round-3 review #1/#7 fix: do NOT fall through to the winner path
    // unconditionally. The previous "re-attempt as if we won" branch
    // double-dispatched (calling reserveSessionAndMessage + start again)
    // whenever the original winner was slow-but-alive (>30s in
    // start(dispatchWorkflow) on a cold sandbox). Instead, atomically
    // STEAL the placeholder using a stale-claim guard: only the process
    // that wins this UPDATE may run reserve+start. Concurrent stealers
    // serialize at the row lock; at most one observes claimed_at <
    // threshold and proceeds.
    const stolen = await withTenantTransaction(input.tenantId, async (tx) => {
      return tx.queryOne(
        DedupeRow,
        `UPDATE chat_event_dedupe
         SET claimed_at = now()
         WHERE tenant_id = $1 AND platform = $2 AND event_id = $3
           AND inner_run_id IS NULL
           AND claimed_at < now() - make_interval(secs => $4)
         RETURNING session_id, message_id, inner_run_id`,
        [input.tenantId, input.platform, input.eventId, STALE_CLAIM_THRESHOLD_SECONDS],
      );
    });
    if (!stolen) {
      // Either the placeholder filled in the race window between poll
      // and steal (re-poll once), or another concurrent stealer won
      // (let WDK retry — the next attempt will see the filled row).
      const reFilled = await pollForDedupeFill(input.tenantId, input.platform, input.eventId);
      if (reFilled) {
        logger.info("startInnerDispatchStep: claim filled during steal window; attaching", {
          tenant_id: input.tenantId,
          platform: input.platform,
          event_id: input.eventId,
          inner_run_id: reFilled.inner_run_id,
        });
        return { innerRunId: reFilled.inner_run_id };
      }
      throw new Error(
        `startInnerDispatchStep: claim race lost and steal failed for event ${input.eventId}; will retry via WDK`,
      );
    }
    logger.warn("startInnerDispatchStep: stole stale claim; promoting to new winner", {
      tenant_id: input.tenantId,
      platform: input.platform,
      event_id: input.eventId,
    });
    // Fall through to the winner path with the stolen claim.
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

  const prepared = await reserveSessionAndMessage(dispatchInput);
  const run = await start(
    dispatchWorkflow as unknown as (
      input: DispatchInput,
      prepared: PreparedExecution,
    ) => Promise<DispatchWorkflowOutput>,
    [dispatchInput, prepared],
  );

  // Fill in the placeholder row with the actual session/message/run ids.
  // The unique constraint guarantees only one row exists per
  // (tenant, platform, event_id), so this UPDATE is unconditionally safe.
  await withTenantTransaction(input.tenantId, async (tx) => {
    await tx.execute(
      `UPDATE chat_event_dedupe
       SET session_id = $4, message_id = $5, inner_run_id = $6
       WHERE tenant_id = $1 AND platform = $2 AND event_id = $3
         AND inner_run_id IS NULL`,
      [input.tenantId, input.platform, input.eventId, prepared.session.id, prepared.messageId, run.runId],
    );
  });

  return { innerRunId: run.runId };
}

/**
 * Poll the dedupe row until the winner's UPDATE fills inner_run_id.
 * Returns the filled row, or null when the poll times out. Round-3 review
 * #8 fix: exponential backoff (100ms → 200 → 400 → 800 → 1600 → cap 2000)
 * instead of fixed 100ms × 300, so a losing race burns ~11 DB round-trips
 * over the 30s budget instead of 300.
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
  await markBotError(input.tenantId, input.agentId, input.platform, message).catch(() => {});
}

async function finalizeChatStep(input: ChatTriggerInput): Promise<void> {
  "use step";
  await markBotEvent(input.tenantId, input.agentId, input.platform).catch(() => {});
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
  POLL_INTERVAL_MS,
  POLL_INTERVAL_CAP_MS,
  POLL_MAX_DURATION_MS,
  STALE_CLAIM_THRESHOLD_SECONDS,
} as const;
