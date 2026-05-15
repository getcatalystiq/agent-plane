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
 *   - markBotEvent tail folded into consumeAndPostStep (was a separate
 *     finalizeChatStep boundary).
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
import { ConcurrencyLimitError } from "@/lib/errors";
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
import { streamToSlack, type StreamChunk as SlackOutChunk } from "@/lib/platform/slack-streamer";
import type { ChatTriggerInput } from "@/lib/platform/bridge";

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}
import type { TenantId, AgentId } from "@/lib/types";

// ---------------------------------------------------------------------------
// Public start function (called by bridge.triggerChatWorkflow)
// ---------------------------------------------------------------------------

export interface StartChatDispatchOptions {
  /** Set when the bridge's inline rate-limit check tripped — surface a
   *  generic busy reply and exit without invoking the dispatcher. The
   *  string distinguishes per-agent vs per-user limit for telemetry. */
  rateLimited: "agent" | "user" | null;
  /**
   * True when the bridge's pre-claim INSERT into chat_event_dedupe
   * succeeded — this workflow run owns the dedupe row and
   * `startInnerDispatchStep` can skip its own INSERT and go straight to
   * `reserveSessionAndMessage`. Eliminates one Neon round-trip on the
   * common chat hot path.
   *
   * False means either the bridge skipped the pre-claim (older path,
   * dedupe-claim threw) or the bridge's INSERT lost the race AND the
   * existing claim looked stale — in either case the workflow runs
   * through its existing claim/recovery logic to handle the race.
   *
   * On a WDK retry of the workflow body, the input is replayed verbatim
   * so this flag is still set on retries. The retry-idempotency
   * contract sits on chat_event_dedupe.session_id /
   * inner_run_id columns, which are already populated after the first
   * attempt — see `startInnerDispatchStepBody` for the retry probe. */
  bridgeClaimed: boolean;
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
// Bounded chat-consume state
// ---------------------------------------------------------------------------

/**
 * Per-iteration result for the bounded consume step. The workflow body
 * loops on these results, re-invoking the step from `nextIndex` with
 * the updated `state` until `done` is true.
 *
 * `done`        — set when the inner readable yielded a terminal event
 *                 (`result` / `error` / `kind: "terminal"`) OR when the
 *                 readable closed naturally (rare; means the inner run
 *                 finished without us seeing a terminal — treated as a
 *                 silent end).
 * `sawTerminal` — true only on the terminal-event path. Drives the
 *                 zombie-cancel guard in the workflow body: if the body
 *                 exits without sawTerminal, we fire a cancel against
 *                 the inner run so it doesn't churn for another 12 min.
 */
export interface ChatConsumeStepResult {
  nextIndex: number;
  state: ChatConsumeState;
  done: boolean;
  sawTerminal: boolean;
}

/**
 * Serializable consume-side state that survives WDK step boundaries.
 *
 * The workflow body holds this between successive `consumeAndPostStep`
 * invocations and threads it back in. WDK serializes step inputs and
 * outputs via JSON-friendly serde; everything here is plain data
 * (no Maps, Sets, or class instances).
 *
 * Fields are platform-mixed because the workflow body doesn't know the
 * platform until startInnerDispatchStep returns and it routes into
 * `consumeAndPostStep`. Slack ignores the Discord-only fields and
 * vice versa.
 */
export interface ChatConsumeState {
  // Common — accumulated across iterations
  /** Full agent reply text accumulated so far (delta + assistant). */
  responseText: string;
  /** Chars sealed into prior (rolled-over / posted) messages. The
   *  current open message displays `responseText.slice(committedLength)`. */
  committedLength: number;
  /** Per-turn delta accumulator for the assistant-event remainder
   *  logic. Cleared on each assistant event end. */
  perTurnDeltaText: string;
  /** tool_use_id -> tool name (for task_update titles on tool_result
   *  arrival or terminal sweep). */
  toolTitles: Record<string, string>;
  /** tool_use ids that have NOT yet received a tool_result. Swept on
   *  terminal so the Slack StreamingPlan UI doesn't render stale
   *  in_progress tasks as red ⚠️ failures. */
  openToolIds: string[];
  /** Set when any text has been emitted to the platform (text_delta
   *  or assistant.text). Used by the empty-readable guard. */
  emittedAnyText: boolean;
  /** Captured `result.result` text when the runner only emitted a
   *  final result (no streaming text). Used as the post body for the
   *  result-fallback path. */
  resultFallbackText: string | null;
  /** Sticky agent-error message string. When set on terminal, the
   *  finalize step calls markBotError. */
  sawAgentError: string | null;

  // Discord-only — Slack iterations ignore these.
  /** Discord: id of the currently-open Slack/Discord message, or null
   *  when we've sealed and the next post creates a new one. */
  messageId: string | null;
  /** Discord: have we successfully posted at least one message yet? */
  hasPosted: boolean;
  /** Discord: sentinel set after any post fails (avoids cascade fails). */
  postFailed: boolean;
  /** Discord: chunks accumulated since the last platform post (drives
   *  flush gate). */
  chunksSinceFlush: number;
  /** Discord: chunks remaining in a 429-driven backoff. */
  backoffChunks: number;
  /** Discord: count of `result` events seen (used by empty-readable
   *  guard). */
  resultEventCount: number;
}

function initialChatConsumeState(): ChatConsumeState {
  return {
    responseText: "",
    committedLength: 0,
    perTurnDeltaText: "",
    toolTitles: {},
    openToolIds: [],
    emittedAnyText: false,
    resultFallbackText: null,
    sawAgentError: null,
    messageId: null,
    hasPosted: false,
    postFailed: false,
    chunksSinceFlush: 0,
    backoffChunks: 0,
    resultEventCount: 0,
  };
}

/**
 * Wall-clock budget per consume step iteration. The workflow body
 * re-invokes consumeAndPostStep until terminal, so this need only be
 * comfortably below the function host's actual cap (Vercel docs say
 * 800s on Pro Fluid, but we observed an empirical 120s wall on the
 * queue HTTP callback path — see PR #84). 60s leaves plenty of
 * headroom for the wind-down (close Slack stream, save state)
 * regardless of which cap is real.
 */
const CONSUME_STEP_DEADLINE_MS = 60_000;

/**
 * Read-side quiet timeout: if the inner readable hasn't yielded a
 * chunk in this long inside one step iteration, we exit with done:
 * false so the workflow body can re-enter with a fresh deadline. The
 * inner run is presumed still active (hot path: the agent is
 * thinking); the cancel guard fires only when the body decides to
 * stop the loop without sawTerminal.
 *
 * Without this, a long agent thinking pause inside one iteration
 * would deplete the deadline budget on a single read() call.
 *
 * Tuned to 45s (well above typical Claude Opus thinking pauses of
 * 30–40s, well below the 60s deadline). 12s bounces iterations on
 * every short pause, producing a Slack rollover seam 5–8× more
 * often than necessary. Pinned: deadline ≥ quiet + 10s headroom.
 */
const CONSUME_STEP_QUIET_MS = 45_000;

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
  //    The receipt ack (👀 + "Thinking…") used to live here as a
  //    parallel `ackReceiptStep`, but waiting for WDK to schedule this
  //    workflow body adds 0.5–2 s of latency before any user-visible
  //    feedback. The ack now fires inside `triggerChatWorkflow` (the
  //    bridge) in parallel with `start(chatDispatchWorkflow)`, so the
  //    eyes land within ~300 ms of the inbound webhook regardless of
  //    how long WDK takes to schedule this body.
  let started: StartedDispatch;
  try {
    started = await startInnerDispatchStep(input, persisted, options.bridgeClaimed);
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

  // 4. Stream consumption — looped from the workflow body across many
  //    bounded sub-step invocations. Each consumeAndPostStep call:
  //      - reads from getReadable({ startIndex }) to resume where the
  //        prior iteration left off
  //      - processes events for at most CONSUME_STEP_DEADLINE_MS
  //      - returns { nextIndex, state, done, sawTerminal }
  //
  //    Why this shape: PR #84's zombie-cancel guard handled the
  //    *symptom* of `consumeAndPostStep` getting cut off at the
  //    Vercel function host's queue-callback cap (~120s in practice
  //    even on Pro Fluid). The body-loop pattern here is the
  //    *architectural* fix — a workflow body has no per-function
  //    timeout (only the WDK 4h run TTL), so the body can re-invoke
  //    a fresh bounded step indefinitely until the agent reply
  //    actually terminates. A 14-minute Slack reply now renders fully
  //    instead of being silently truncated mid-token.
  //
  //    Trade-off (intentional, documented in U0 spike):
  //      - Each step boundary forces a fresh Slack chat.startStream
  //        on the next iteration → one new Slack message per ~60s.
  //        The user already sees this rollover behavior at 90s
  //        (slack-streamer's existing soft cap); we're just making
  //        seams a bit more frequent. Discord's post-then-edit loop
  //        threads `state.messageId` through, so its UX is unchanged.
  //      - A function-host crash mid-iteration restarts that single
  //        iteration from `state` — the Slack message it was filling
  //        gets duplicated, but every prior sealed message is intact.
  //
  //    Replay-determinism note: WDK replays the workflow body on
  //    function recycle by walking the event log of completed steps.
  //    Each consumeAndPostStep call is one event, so the loop length
  //    is bounded by the number of step calls we ever made (typically
  //    1–15 for normal-length replies). Replay must finish within
  //    REPLAY_TIMEOUT_MS (240s in WDK 4.2.x), so the loop scales to
  //    ~hundreds of iterations before that becomes a concern.
  let consumeIndex = 0;
  let consumeState: ChatConsumeState = initialChatConsumeState();
  let consumeDone = false;
  let sawTerminal = false;

  while (!consumeDone) {
    const result: ChatConsumeStepResult = await consumeAndPostStep(
      input,
      started.innerRunId,
      started.kind === "orphan",
      consumeIndex,
      consumeState,
    );
    consumeState = result.state;
    consumeIndex = result.nextIndex;
    consumeDone = result.done;
    sawTerminal = result.sawTerminal;
  }

  // 5. Finalize delivery: reaction swap (👀 → ✅/❌) + markBotEvent.
  //    Lives in its own step because reactions and DB writes are I/O
  //    and must run in step context, not the workflow body. Used to be
  //    folded into the consume step's finally block, but with the loop
  //    now driving multiple iterations there's no single "this is the
  //    last iteration" point inside the consume step — the body knows
  //    when the loop exits.
  await finalizeChatDeliveryStep(input, sawTerminal, consumeState);

  // 6. Zombie-cancel guard. If the body exited the loop without
  //    observing a terminal event, the inner dispatch workflow may
  //    still be running. Cancel it so the dispatcher's finalize path
  //    runs promptly (sandbox stop, message status mark) instead of
  //    waiting for the cleanup-sessions watchdog (`max_runtime + 120s`
  //    grace, 720s default).
  //
  //    Reachable cases:
  //      - The loop terminated because reader.read() returned done
  //        without a terminal event (rare; would mean the inner run
  //        completed via cancel/expiry).
  //      - A future bug in the consume step exits the body abnormally.
  //
  //    With the loop's wall-clock unboundedness, the original "chat
  //    function killed at 120s" path that motivated this guard in
  //    PR #84 should no longer occur. Keeping the guard as belt-and-
  //    suspenders is cheap.
  if (!sawTerminal) {
    await cancelInnerRunStep(started.innerRunId, input.tenantId, input.agentId);
  }
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
 * Consume one bounded slice of the inner dispatchWorkflow's NDJSON
 * readable and post any text/structured chunks to the chat platform.
 *
 * Each invocation is bounded by `CONSUME_STEP_DEADLINE_MS` (60s by
 * default). The workflow body loops these calls, threading
 * `startIndex` and `state` through, until the iteration returns
 * `done: true` (terminal observed OR the inner readable closed).
 *
 * WDK forbids `getRun()` inside a `"use workflow"` body — `getReadable`
 * must run inside a step. This function is that step. The body's
 * loop is the architectural fix that survives any function-host
 * timeout cap (Vercel's queue-callback path empirically dies at
 * ~120s; Pro Fluid's documented max is 800s; either is reachable on
 * a marathon agent reply). One bounded step iteration vastly under
 * either cap, re-invoked many times, equals unbounded total runtime.
 *
 * State machine (now externalized into ChatConsumeState so it
 * survives between iterations):
 *
 *   responseText     — accumulated full agent reply (across all
 *                      iterations; not reset per iteration).
 *   committedLength  — chars sealed into PRIOR (rolled-over) messages.
 *                      Advances ONLY on rollover. The open (current)
 *                      message displays
 *                      responseText.slice(committedLength).
 *   messageId        — Discord-only: id of the open message
 *                      (null = no open message, next post creates one).
 *                      Slack opens a fresh chat.startStream every
 *                      iteration so this is unused there.
 *   openToolIds      — tool_uses without a matching tool_result.
 *                      Swept to "complete" on terminal so Slack's
 *                      StreamingPlan UI doesn't render stale red ⚠️
 *                      icons (sub-agent tool path).
 *
 * Slack iteration shape (one new chat.startStream per call):
 *   - Open a stream session for THIS iteration only.
 *   - Read events until deadline OR terminal.
 *   - Close the stream cleanly. The next iteration opens a new one,
 *     which Slack renders as a fresh message (visible seam — same as
 *     the existing 90s-soft-cap rollover, just more frequent).
 *
 * Discord iteration shape (continuous post-then-edit):
 *   - Reuses `state.messageId` across iterations: a single Discord
 *     message keeps growing via .editMessage until it hits the
 *     character cap and rolls over to a fresh post. The state
 *     threading preserves the existing UX exactly.
 *
 * Durability trade-off: a function-host crash mid-iteration restarts
 * THAT iteration only, re-reading from `startIndex`. Prior iterations
 * are sealed in WDK's event log and not replayed. The Slack message
 * being filled when the crash happened gets duplicated; everything
 * before is intact.
 */
async function consumeAndPostStep(
  input: ChatTriggerInput,
  innerRunId: string,
  isOrphan: boolean,
  startIndex: number,
  state: ChatConsumeState,
): Promise<ChatConsumeStepResult> {
  "use step";

  // Same anti-retry posture as startInnerDispatchStep: a throw out of
  // this step triggers WDK's auto-retry with multi-minute backoff,
  // which on the chat path means the user sits waiting on Slack with
  // no reply while WDK respawns the step. Better to log + return
  // cleanly with done:true so the workflow body exits the loop and
  // the cancel guard fires.
  try {
    return await consumeAndPostStepBody(input, innerRunId, isOrphan, startIndex, state);
  } catch (err) {
    logger.error("consumeAndPostStep: caught — returning cleanly (no WDK retry)", {
      tenant_id: input.tenantId,
      agent_id: input.agentId,
      platform: input.platform,
      thread_key: input.threadKey,
      inner_run_id: innerRunId,
      start_index: startIndex,
      error_name: err instanceof Error ? err.constructor.name : "unknown",
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    // Force loop exit on caught error so we don't tight-loop on a
    // deterministic throw. The workflow body's cancel guard kills the
    // inner run since sawTerminal stays false.
    return { nextIndex: startIndex, state, done: true, sawTerminal: false };
  }
}

async function consumeAndPostStepBody(
  input: ChatTriggerInput,
  innerRunId: string,
  isOrphan: boolean,
  startIndex: number,
  state: ChatConsumeState,
): Promise<ChatConsumeStepResult> {
  // The orphan log used to fire once at the start of the (single)
  // consume step; with the body-loop pattern it would fire on every
  // iteration, which is noisy. Only log on the first iteration
  // (startIndex === 0) so existing observability stays unchanged.
  if (isOrphan && startIndex === 0) {
    logger.warn("consumeAndPostStep: continuing with orphan placeholder", {
      tenant_id: input.tenantId,
      agent_id: input.agentId,
      thread_key: input.threadKey,
      inner_run_id: innerRunId,
    });
  }

  // Platform fork. Slack has a native streaming API on its Chat SDK
  // adapter; Discord uses post-then-edit. Each helper takes the
  // current `state` and `startIndex`, runs ONE bounded iteration, and
  // returns the updated values for the workflow body to thread into
  // the next call.
  return input.platform === "slack"
    ? await consumeAndStreamSlack(input, innerRunId, startIndex, state)
    : await consumeAndEditDiscord(input, innerRunId, startIndex, state);
}

// Slack/Discord both accept emoji shortcodes (no colons) on their
// addReaction/removeReaction adapters. These match the CLAUDE.md UX
// guidelines: 👀 receipt → ✅ done → ❌ error.
const REACTION_RECEIPT = "eyes";
const REACTION_DONE = "white_check_mark";
const REACTION_ERROR = "x";

interface ReactingAdapter {
  addReaction?: (threadId: string, messageId: string, emoji: string) => Promise<void>;
  removeReaction?: (threadId: string, messageId: string, emoji: string) => Promise<void>;
}

interface TypingAdapter {
  startTyping?: (threadId: string, status?: string) => Promise<void>;
}

// `ackReceiptStep` was removed: the receipt 👀 + "Thinking…" indicator
// now fires inside `triggerChatWorkflow` (the bridge) in parallel with
// `start(chatDispatchWorkflow)`, so the user sees feedback within
// ~300 ms of the inbound webhook instead of after WDK schedules this
// workflow body (~0.5–2 s of dead time on cold instances). The receipt
// removal at completion still uses `safeRemoveReaction` below.

async function safeAddReaction(input: ChatTriggerInput, emoji: string): Promise<void> {
  if (!input.replyToMessageId) return;
  try {
    const cached = await resolveCachedBot(input.tenantId, input.agentId, input.platform);
    if (!cached) return;
    const adapter = cached.adapter as unknown as ReactingAdapter;
    if (typeof adapter.addReaction !== "function") return;
    await adapter.addReaction(input.threadKey, input.replyToMessageId, emoji);
  } catch (err) {
    logger.warn("safeAddReaction failed (best-effort, non-blocking)", {
      tenant_id: input.tenantId,
      agent_id: input.agentId,
      thread_key: input.threadKey,
      emoji,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function safeRemoveReaction(input: ChatTriggerInput, emoji: string): Promise<void> {
  if (!input.replyToMessageId) return;
  try {
    const cached = await resolveCachedBot(input.tenantId, input.agentId, input.platform);
    if (!cached) return;
    const adapter = cached.adapter as unknown as ReactingAdapter;
    if (typeof adapter.removeReaction !== "function") return;
    await adapter.removeReaction(input.threadKey, input.replyToMessageId, emoji);
  } catch (err) {
    logger.warn("safeRemoveReaction failed (best-effort, non-blocking)", {
      tenant_id: input.tenantId,
      agent_id: input.agentId,
      thread_key: input.threadKey,
      emoji,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Slack streaming path — bounded single iteration.
 *
 * One invocation runs for at most CONSUME_STEP_DEADLINE_MS, opens a
 * single chat.startStream session for the duration, posts events as
 * they arrive, and closes the stream cleanly on exit. Returns the
 * updated `state` and `nextIndex` so the workflow body can re-invoke
 * with the next slice.
 *
 * Each iteration creates a fresh Slack message (chat.startStream
 * returns a new ts every time). The user sees rollover seams between
 * iterations — same UX as the existing `slack-streamer` rollover, just
 * driven by step boundaries instead of the streamer's internal
 * 90s soft / 150s hard caps.
 *
 * Behavior:
 * - Reads from getReadable({ startIndex: state.startIndex }) — picks
 *   up where the prior iteration left off.
 * - Tracks per-iteration delta-vs-assistant logic via `state.perTurnDeltaText`
 *   (resets on assistant turn end, not on iteration boundary).
 * - Sticky-state fields (sawAgentError, emittedAnyText, resultFallbackText,
 *   responseText, committedLength) are restored from `state` and updated.
 * - On terminal (`result` / `error`): sweeps openToolIds (open tool_uses
 *   that never got a tool_result, e.g. sub-agent path) so Slack's
 *   StreamingPlan UI doesn't render stale red ⚠️ icons.
 *
 * Post-stream guards (markBotError on agent-emitted error, empty-readable
 * acknowledgement, result-fallback post) run only on `done: true` so they
 * fire exactly once per chat reply, not per iteration.
 */
async function consumeAndStreamSlack(
  input: ChatTriggerInput,
  innerRunId: string,
  startIndex: number,
  state: ChatConsumeState,
): Promise<ChatConsumeStepResult> {
  const cached = await resolveCachedBot(input.tenantId, input.agentId, "slack");
  if (!cached) {
    logger.error("consumeAndStreamSlack: bot config missing", {
      tenant_id: input.tenantId,
      agent_id: input.agentId,
      thread_key: input.threadKey,
    });
    await markBotErrorStep(input, "bot_config_missing");
    // bot config errors are NOT a "didn't see terminal" condition — there's
    // no inner run to cancel because we never started consuming. Force
    // loop exit with sawTerminal so the cancel guard doesn't fire.
    //
    // Set sawAgentError so finalizeChatDeliveryStep computes success=false
    // and lands the ❌ reaction. Without this the user's message gets a
    // ✅ reaction even though no agent reply was ever posted (the bot
    // literally couldn't connect).
    return {
      nextIndex: startIndex,
      state: { ...state, sawAgentError: "bot_config_missing" },
      done: true,
      sawTerminal: true,
    };
  }

  // We bypass `adapter.stream` and call `client.chatStream` directly via the
  // local `streamToSlack` shim so we can tune buffer_size, time every API
  // call, and roll the stream over before Slack's server-side timeout.
  // Detect the underlying client to surface a useful error if a future SDK
  // upgrade changes the adapter shape.
  const slackClient = (cached.adapter as unknown as { client?: { chatStream?: unknown } }).client;
  if (!slackClient || typeof slackClient.chatStream !== "function") {
    logger.warn("consumeAndStreamSlack: adapter.client.chatStream missing — falling back to edit loop", {
      tenant_id: input.tenantId,
      agent_id: input.agentId,
    });
    return await consumeAndEditDiscord(input, innerRunId, startIndex, state);
  }

  // Resume from prior iteration's state, then track local mutations.
  // Sticky-across-iterations: sawAgentError, emittedAnyText, resultFallbackText.
  // These move back into `state` at the bottom of the function.
  let sawAgentError: string | null = state.sawAgentError;
  let emittedAnyText = state.emittedAnyText;
  let resultFallbackText: string | null = state.resultFallbackText;
  let sawTerminal = false;
  let perTurnDeltaText = state.perTurnDeltaText;

  // Hydrate Map/Set from the serialized state.
  const toolTitleById = new Map<string, string>(Object.entries(state.toolTitles));
  const openToolIds = new Set<string>(state.openToolIds);

  let nextIndex = startIndex;
  const deadline = Date.now() + CONSUME_STEP_DEADLINE_MS;
  let lastReadAt = Date.now();
  // Set true when we deliberately stop iterating because we hit
  // either bound — wall-clock deadline OR read-quiet timeout.
  // Distinguishes "ran out of budget, body should re-invoke" from
  // "saw terminal" / "readable closed naturally". Same name as
  // Discord's flag for parallel structure.
  let exitedDueToBudget = false;

  const readable = getRun<string>(innerRunId).getReadable<string>({ startIndex });

  // P5 — coalesce yields: bunching small text_deltas before they cross the
  // streamToSlack boundary collapses N small `streamer.append` awaits into
  // ~N/k. Set deliberately small so streaming still feels live for the
  // user; tuneable via env if we want to push harder.
  const COALESCE_FLUSH_MS = readPositiveIntEnv("SLACK_STREAM_COALESCE_MS", 80);
  const COALESCE_FLUSH_BYTES = readPositiveIntEnv("SLACK_STREAM_COALESCE_BYTES", 200);

  const textStream: AsyncIterable<SlackOutChunk> = (async function* () {
    const reader = readable.getReader();
    let pendingText = "";
    let pendingSince = 0;
    function shouldFlush(): boolean {
      if (pendingText.length === 0) return false;
      if (pendingText.length >= COALESCE_FLUSH_BYTES) return true;
      return Date.now() - pendingSince >= COALESCE_FLUSH_MS;
    }
    try {
      while (true) {
        // Bounded-iteration guards. The body re-invokes with our
        // returned `nextIndex` so deferred chunks are not dropped.
        if (Date.now() > deadline) {
          exitedDueToBudget = true;
          break;
        }
        // Quiet timeout: if the readable hasn't yielded anything in
        // CONSUME_STEP_QUIET_MS, exit cleanly so the body can re-enter
        // with a fresh deadline. The agent is presumed still active
        // (likely thinking); the cancel guard fires only when the
        // body decides to stop the loop without sawTerminal.
        if (Date.now() - lastReadAt > CONSUME_STEP_QUIET_MS) {
          exitedDueToBudget = true;
          break;
        }

        const { value, done } = await reader.read();
        if (done) break;
        lastReadAt = Date.now();
        nextIndex += 1;
        if (typeof value !== "string") continue;
        const evt = parseNdjsonLine(value);
        if (!evt) continue;

        if (evt.type === "text_delta" && typeof evt.text === "string" && evt.text.length > 0) {
          emittedAnyText = true;
          perTurnDeltaText += evt.text;
          if (pendingText.length === 0) pendingSince = Date.now();
          pendingText += evt.text;
          if (shouldFlush()) {
            yield pendingText;
            pendingText = "";
          }
        } else if (evt.type === "assistant" && evt.message && typeof evt.message === "object") {
          const blocks = evt.message.content ?? [];
          for (const block of blocks) {
            if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
              // Streaming runners: rely on text_delta events. When all
              // deltas arrived, the assistant event's text is fully
              // covered and yielding it again would double the reply.
              // When deltas were partially dropped (writeChunkStep
              // PR #62 swallows per-chunk errors; runner POST retries
              // can exhaust under load), the partial deltas already
              // form a clean prefix of the final assistant text — we
              // yield the missing tail. On a prefix mismatch (rare:
              // would mean delta and assistant texts diverge mid-
              // stream), suppress the assistant text to keep the bug
              // d5dd1e8 was fixing dead — partial-text in Slack is
              // strictly better UX than scrambled-text.
              //
              // Non-streaming runners: perTurnDeltaText.length === 0,
              // assistantTailAfterDeltas returns the full text so the
              // user gets a reply at all.
              const tail = assistantTailAfterDeltas(block.text, perTurnDeltaText);
              if (tail.length > 0) {
                emittedAnyText = true;
                if (pendingText.length > 0) {
                  yield pendingText;
                  pendingText = "";
                }
                yield tail;
              }
            } else if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
              // Flush any pending text before structured chunks so they
              // land at the correct visual position.
              if (pendingText.length > 0) {
                yield pendingText;
                pendingText = "";
              }
              const title = block.name;
              const details = summarizeToolInput(block.input);
              toolTitleById.set(block.id, title);
              openToolIds.add(block.id);
              yield {
                type: "task_update",
                id: block.id,
                title,
                status: "in_progress",
                ...(details ? { details } : {}),
              };
            }
          }
          perTurnDeltaText = "";
        } else if (evt.type === "user" && evt.message && typeof evt.message === "object") {
          // The Claude Agent SDK delivers tool results inside a `user` role
          // message wrapper. content[] holds tool_result blocks correlated
          // to the originating tool_use via `tool_use_id`. Honor the
          // SDK's `is_error` flag so genuinely-failed tools render as the
          // Slack ⚠️ task state instead of a misleading green checkmark.
          const blocks = evt.message.content ?? [];
          for (const block of blocks) {
            if (block.type === "tool_result" && typeof block.tool_use_id === "string") {
              if (pendingText.length > 0) {
                yield pendingText;
                pendingText = "";
              }
              const title = toolTitleById.get(block.tool_use_id) ?? block.tool_use_id;
              const output = typeof block.content === "string"
                ? block.content
                : Array.isArray(block.content)
                  ? block.content.filter((b) => b.type === "text").map((b) => b.text ?? "").join("\n")
                  : undefined;
              const status: "complete" | "error" = block.is_error === true ? "error" : "complete";
              openToolIds.delete(block.tool_use_id);
              yield {
                type: "task_update",
                id: block.tool_use_id,
                title,
                status,
                ...(output && output.length > 0 ? { output: output.length > 200 ? output.slice(0, 197) + "…" : output } : {}),
              };
            }
          }
        } else if (evt.type === "error") {
          sawAgentError = typeof evt.message === "string" ? evt.message : "agent_error";
          sawTerminal = true;
          // Surface the error as a final yielded line so it appears in
          // the streamed message tail (Slack's stream API doesn't have
          // a separate error channel — the user reads it in-thread).
          if (emittedAnyText) {
            if (pendingText.length > 0) {
              yield pendingText;
              pendingText = "";
            }
            yield `\n\n_(agent stopped early: ${sawAgentError})_`;
          }
          break;
        } else if (evt.type === "result" || evt.kind === "terminal") {
          sawTerminal = true;
          if (!emittedAnyText && typeof evt.result === "string" && evt.result.length > 0) {
            // Non-streaming runner that only emitted a final result —
            // captured here so the empty-readable guard below can post
            // it as a one-shot message instead of a stream.
            resultFallbackText = evt.result;
          }
          break;
        }
      }
      // Sweep tool_uses on TERMINAL ONLY. On a deadline-driven exit we
      // want openToolIds to carry forward into the next iteration so a
      // tool_result that arrives later can still close the matching
      // task_update. Sweeping on deadline would mark every still-running
      // tool as "complete", causing a flicker (complete then re-opens
      // when the next iteration sees the SDK's tool_use again).
      if (sawTerminal) {
        for (const openId of openToolIds) {
          if (pendingText.length > 0) {
            yield pendingText;
            pendingText = "";
          }
          const title = toolTitleById.get(openId) ?? openId;
          yield {
            type: "task_update",
            id: openId,
            title,
            status: "complete",
          };
        }
        openToolIds.clear();
      }
      // Drain any pending coalesced text on close. Safe even on
      // deadline-exit — we yield the partial text now, and the next
      // iteration's chat.startStream picks up from there in a fresh
      // Slack message (visible seam, but no dropped bytes).
      if (pendingText.length > 0) {
        yield pendingText;
        pendingText = "";
      }
    } finally {
      try { reader.releaseLock(); } catch { /* ignore */ }
    }
  })();

  let bytesYieldedAtFailure = 0;
  let streamFailed = false;
  try {
    const result = await streamToSlack({
      bot: cached,
      threadKey: input.threadKey,
      chunks: textStream,
      recipientUserId: input.authorId || undefined,
      recipientTeamId: cached.slackTeamId ?? undefined,
      diagContext: {
        tenantId: input.tenantId,
        agentId: input.agentId,
        innerRunId,
      },
    });
    bytesYieldedAtFailure = result.bytesYielded;
  } catch (err) {
    streamFailed = true;
    // P3 — surface bytes-yielded so we can tell "Slack rejected our append"
    // (we yielded everything, API kicked us out) from "we never finished
    // yielding" (function host kill / readable closed early). The render
    // layer is the only place that knows this.
    logger.error("consumeAndStreamSlack: streamToSlack failed", {
      tenant_id: input.tenantId,
      agent_id: input.agentId,
      thread_key: input.threadKey,
      inner_run_id: innerRunId,
      bytes_yielded_at_failure: bytesYieldedAtFailure,
      saw_agent_error: sawAgentError,
      error_name: err instanceof Error ? err.constructor.name : "unknown",
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    // On stream failure inside this iteration, try a one-shot post so
    // the agent's reply still lands somewhere visible. Best-effort.
    try {
      const fallbackText = resultFallbackText
        ?? (sawAgentError ? `_(agent stopped early: ${sawAgentError})_` : "_(agent reply unavailable)_");
      await postOrEditStep({
        tenantId: input.tenantId,
        agentId: input.agentId,
        platform: input.platform,
        threadId: input.threadKey,
        text: fallbackText,
        existingMessageId: null,
        seal: false,
        continuation: false,
      });
    } catch {
      // ignore — will be retried by user
    }
  }

  // Save back the iteration's mutations into the state object so the
  // body's next call resumes correctly.
  const updatedState: ChatConsumeState = {
    ...state,
    perTurnDeltaText,
    toolTitles: Object.fromEntries(toolTitleById),
    openToolIds: [...openToolIds],
    emittedAnyText,
    resultFallbackText,
    sawAgentError,
  };

  // Decide whether the body's loop should exit (`done: true`) or
  // re-invoke (`done: false`).
  //
  //   sawTerminal=true                → done (terminal observed).
  //   streamFailed=true               → done (don't loop on a broken
  //                                     Slack stream; the fallback post
  //                                     above already wrote what we had).
  //   exitedDueToBudget=true        → not done (re-invoke with new deadline).
  //   exitedDueToBudget=false &&
  //     readable returned done        → done (rare; inner run ended
  //                                     without a terminal event).
  const done = sawTerminal || streamFailed || !exitedDueToBudget;

  // Post-stream guards run ONCE per chat reply — only on the
  // last iteration (`done: true`) and only when we observed terminal
  // (no point in firing the silent-bot guard if we exited because the
  // body decided to stop without terminal — the cancel guard in the
  // workflow body handles that case).
  if (done && sawTerminal) {
    if (sawAgentError) {
      await markBotErrorStep(input, sawAgentError);
    } else if (!emittedAnyText && resultFallbackText !== null) {
      // Result-fallback path: non-streaming runner that yielded no
      // assistant text but had a final `result` string. Post it as a
      // single message (no stream).
      await postOrEditStep({
        tenantId: input.tenantId,
        agentId: input.agentId,
        platform: input.platform,
        threadId: input.threadKey,
        text: resultFallbackText,
        existingMessageId: null,
        seal: false,
        continuation: false,
      });
    } else if (!emittedAnyText && resultFallbackText === null) {
      // Empty-readable guard: agent produced no output. Surface the
      // silent-bot UX so the user gets some signal.
      logger.warn("consumeAndStreamSlack: inner dispatch produced no output", {
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
        logger.error("consumeAndStreamSlack: empty-readable acknowledgement failed", {
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

  return { nextIndex, state: updatedState, done, sawTerminal };
}

/**
 * Discord (and adapter.stream-unavailable) path — bounded single
 * iteration. Mirrors `consumeAndStreamSlack`'s shape: takes/returns
 * `state` + `nextIndex`, runs for at most CONSUME_STEP_DEADLINE_MS,
 * exits cleanly on terminal OR deadline. The workflow body re-invokes
 * with the updated values.
 *
 * Discord has no streaming API, so we use the post-then-edit loop:
 * the same Discord message is updated in place via .editMessage as
 * text accumulates, and rolled over to a fresh post when the
 * 2000-char cap approaches. The state's `messageId` threads the
 * currently-open Discord message id across iterations so the user
 * sees one continuous message that grows over time (no extra seams
 * from step boundaries — all visible rollovers are real character-cap
 * rollovers).
 */
async function consumeAndEditDiscord(
  input: ChatTriggerInput,
  innerRunId: string,
  startIndex: number,
  state: ChatConsumeState,
): Promise<ChatConsumeStepResult> {
  const readable = getRun<string>(innerRunId).getReadable<string>({ startIndex });
  const reader = readable.getReader();
  const limits = PLATFORM_LIMITS[input.platform];
  const SEAL_SUFFIX_OVERHEAD = 4;
  const maxPerMessage = limits.maxPerMessage - SEAL_SUFFIX_OVERHEAD;
  const CHUNKS_PER_FLUSH = Math.max(1, Math.ceil(EDIT_FLUSH_INTERVAL_MS / APPROX_CHUNK_INTERVAL_MS));

  // Restore from state.
  let responseText = state.responseText;
  let committedLength = state.committedLength;
  let messageId: string | null = state.messageId;
  let backoffChunks = state.backoffChunks;
  let chunksSinceFlush = state.chunksSinceFlush;
  let hasPosted = state.hasPosted;
  let postFailed = state.postFailed;
  let resultEventCount = state.resultEventCount;
  let perTurnDeltaText = state.perTurnDeltaText;
  let sawTerminal = false;

  let nextIndex = startIndex;
  const deadline = Date.now() + CONSUME_STEP_DEADLINE_MS;
  let lastReadAt = Date.now();
  // Tracks an early-return path so we don't post-flush twice on
  // already-handled terminal/error branches.
  let earlyReturn = false;
  // Set TRUE at each break-out site so the post-loop done-flag
  // derivation knows whether we exited because of a budget cap
  // (re-invoke) or natural end (loop is done). Recomputing
  // post-loop as `Date.now() > deadline` is wrong on the quiet-
  // timeout break path (deadline hasn't elapsed yet) — that
  // mistake sets `done=true` on any agent thinking pause >quiet,
  // killing the inner run mid-thought via the cancel guard.
  let exitedDueToBudget = false;

  try {
    while (true) {
      // Bounded-iteration guard — mirror of consumeAndStreamSlack.
      if (Date.now() > deadline) {
        exitedDueToBudget = true;
        break;
      }
      if (Date.now() - lastReadAt > CONSUME_STEP_QUIET_MS) {
        exitedDueToBudget = true;
        break;
      }

      const { value: ndjsonLine, done } = await reader.read();
      if (done) break;
      lastReadAt = Date.now();
      nextIndex += 1;
      if (typeof ndjsonLine !== "string") continue;
      const evt = parseNdjsonLine(ndjsonLine);
      if (!evt) continue;

      if (evt.type === "text_delta" && typeof evt.text === "string") {
        // Streaming runner path: per-token deltas accumulate into responseText.
        responseText += evt.text;
        chunksSinceFlush += 1;
        perTurnDeltaText += evt.text;
      } else if (evt.type === "assistant" && evt.message && typeof evt.message === "object") {
        // The Claude Agent SDK emits BOTH text_delta deltas AND a final
        // assistant message carrying the same text. Append only the
        // remainder so responseText doesn't double when both fire, while
        // still capturing trailing characters the deltas may have missed.
        // Non-streaming runners (no text_delta) get the full text via the
        // remainder helper's empty-deltas branch.
        const blocks = evt.message.content ?? [];
        for (const block of blocks) {
          if (block.type === "text" && typeof block.text === "string" && block.text.length > 0) {
            const remainder = textRemainderAfterDeltas(block.text, perTurnDeltaText);
            if (remainder.length > 0) {
              responseText += remainder;
              chunksSinceFlush += 1;
            }
          }
        }
        perTurnDeltaText = "";
      } else if (evt.type === "error") {
        const errorText = typeof evt.message === "string" ? evt.message : "error";
        sawTerminal = true;
        if (!postFailed) {
          const tail = responseText.slice(committedLength);
          const tailWithError = `${tail}\n\n_(agent stopped early: ${errorText})_`;
          await flushAndFinishStep({ input, text: tailWithError, existingMessageId: messageId });
        }
        await markBotErrorStep(input, errorText);
        earlyReturn = true;
        break;
      } else if (evt.type === "result" || evt.kind === "terminal") {
        sawTerminal = true;
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
    earlyReturn = true;
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // ignore
    }
  }

  // Save back the iteration's mutations into the state object for the
  // next call.
  const updatedState: ChatConsumeState = {
    ...state,
    responseText,
    committedLength,
    perTurnDeltaText,
    messageId,
    hasPosted,
    postFailed,
    chunksSinceFlush,
    backoffChunks,
    resultEventCount,
  };

  // Decide whether the body's loop should exit.
  //   sawTerminal=true                  → done (terminal observed).
  //   earlyReturn=true                  → done (inner-iteration error
  //                                       already markBotError'd).
  //   exitedDueToBudget=true            → not done (re-invoke).
  //                                       Set in-loop on BOTH the
  //                                       wall-clock deadline AND the
  //                                       quiet-timeout break sites.
  //   readable returned done w/o budget → done (rare; inner run ended
  //                                       without a terminal event).
  const done = sawTerminal || earlyReturn || !exitedDueToBudget;

  // On the final iteration only, run the post-stream guards: final
  // flush of remaining open-message text, then empty-readable guard.
  // These must NOT fire on intermediate iterations or we'd post the
  // empty-readable banner mid-reply.
  //
  // Skip when `earlyReturn` — the agent_error branch already called
  // flushAndFinishStep with the error suffix appended, and a second
  // flush of `responseText.slice(committedLength)` would re-edit the
  // same Discord message with a suffix-less tail, clobbering the
  // user-visible error message.
  if (done && sawTerminal && !earlyReturn) {
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

    // Empty-readable guard. `hasPosted` only becomes true after a real
    // flush succeeds. Native typing indicator auto-clears when no
    // message arrives, so a silent run leaves no residue beyond this
    // acknowledgement post.
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

  return { nextIndex, state: updatedState, done, sawTerminal };
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
  bridgeClaimed: boolean,
): Promise<StartedDispatch> {
  "use step";

  // Wrapped in try/catch so a thrown error does NOT trigger WDK's
  // automatic step retry. Production trace via `workflow inspect events`
  // showed startInnerDispatchStep retrying multiple times — adding 1-3
  // minutes of latency per chat run. WDK's retry backoff is the wrong
  // contract for an interactive chat reply: the user is waiting and
  // would rather see a quick "I had trouble" than a delayed reply 5
  // minutes later. On any caught error: log loudly, return `abandoned`
  // (clean exit path that the workflow body already handles), and let
  // the cleanup-sessions cron sweep any orphan rows we created before
  // the throw.
  try {
    return await startInnerDispatchStepBody(input, persisted, bridgeClaimed);
  } catch (err) {
    const failureKind = classifyDispatchFailure(err);
    logger.error("startInnerDispatchStep: caught — returning abandoned (no WDK retry)", {
      tenant_id: input.tenantId,
      agent_id: input.agentId,
      platform: input.platform,
      event_id: input.eventId,
      thread_key: input.threadKey,
      failure_kind: failureKind,
      error_name: err instanceof Error ? err.constructor.name : "unknown",
      error: err instanceof Error ? err.message : String(err),
      stack: err instanceof Error ? err.stack : undefined,
    });
    // For the per-session in-flight cap (user sent a second chat message
    // before the first finished), post a short busy reply so the user
    // sees a response rather than a stuck "Thinking…" indicator.
    // postBusyReplyStep already swallows its own errors, so this can't
    // re-introduce the WDK retry storm the outer try/catch is preventing.
    if (failureKind === "in_flight") {
      await postBusyReplyStep(input, "in_flight");
    }
    return { kind: "abandoned" };
  }
}

async function startInnerDispatchStepBody(
  input: ChatTriggerInput,
  persisted: PersistedAttachment[],
  bridgeClaimed: boolean,
): Promise<StartedDispatch> {
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
    bridge_claimed: bridgeClaimed,
  });

  // PERF — bridge-claim fast path: when triggerChatWorkflow already
  // INSERTed and won the dedupe row, this step skips its own INSERT
  // and goes straight to reserveSessionAndMessage. Saves one Neon
  // round-trip on the common chat hot path.
  //
  // WDK retry idempotency: the dedupe row's session_id / inner_run_id
  // columns are the retry gate — see startInnerDispatchStepBody
  // comments below. The first retry hits the same row; if a previous
  // attempt already filled inner_run_id we attach via the loser path's
  // pollForDedupeFill helper. If session_id was filled but
  // inner_run_id wasn't, the existing recovery path (poll → steal)
  // handles it the same way it does today.
  let won: boolean;
  if (bridgeClaimed) {
    // The bridge already INSERTed; skip the second INSERT. Treat as
    // winner. WDK retry safety: on retry, the bridge's input is
    // replayed, but the bridge runs in a separate process from this
    // step — its INSERT happened in the *original* invocation. The
    // retry of this step does NOT re-INSERT (because we skip below);
    // instead, the dedupe row is checked via the post-reserve UPDATE
    // path. If a prior attempt completed reserveSessionAndMessage
    // before crashing, the row's session_id is already populated and
    // the placeholder UPDATE below is a no-op (`WHERE inner_run_id IS
    // NULL` guard preserves the prior winner). The orphan-session
    // sweep cleans up any duplicated session_messages.
    won = true;
  } else {
    // A6 + REL-R2-01 fix (review runs 20260506-221948-2402b0ed and
    // 20260506-232400-round2): claim-then-reserve pattern. Two
    // concurrent step retries race on the placeholder INSERT; only
    // ONE winner runs reserveSessionAndMessage + start(...). The
    // loser polls the placeholder until the winner's UPDATE fills in
    // inner_run_id, then attaches to the same run.
    won = await withTenantTransaction(input.tenantId, async (tx) => {
      const inserted = await tx.execute(
        `INSERT INTO chat_event_dedupe (tenant_id, platform, event_id)
         VALUES ($1, $2, $3)
         ON CONFLICT (tenant_id, platform, event_id) DO NOTHING`,
        [input.tenantId, input.platform, input.eventId],
      );
      return inserted.rowCount === 1;
    });
  }
  logger.info("startInnerDispatchStep: dedupe INSERT result", {
    event_id: input.eventId,
    won,
    bridge_claimed: bridgeClaimed,
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

  // OPT — chat hot path: chatDedupeUpdate folds the post-reserve UPDATE
  // of `chat_event_dedupe.session_id` / `message_id` into the SAME
  // Neon transaction as session + session_message creation inside
  // `reserveSessionAndMessage`. Saves one round-trip vs. the prior
  // sequential pair (reserve tx + standalone UPDATE tx).
  //
  // Durability is preserved: the UPDATE still runs BEFORE start() and
  // is guarded with `inner_run_id IS NULL` so a winner that already
  // populated the row (e.g. WDK retry) is not overwritten. The
  // pre-start ordering is unchanged — a failed inner_run_id UPDATE
  // (later) still leaves a recoverable orphan; WDK retry through the
  // poll → steal recovery path behaves identically to before this
  // change. The previously-separate UPDATE block was removed; its
  // try/catch logging was diagnostic-only.
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
    chatDedupeUpdate: {
      platform: input.platform,
      eventId: input.eventId,
    },
  };

  let prepared: PreparedExecution;
  try {
    prepared = await reserveSessionAndMessage(dispatchInput);
    logger.info("startInnerDispatchStep: reserveSessionAndMessage OK (dedupe folded)", {
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

/**
 * Cancel an inner dispatch workflow run when the chat side gave up
 * before observing a terminal event. Best-effort — swallows errors
 * (logs them) so a cancel failure can't itself trigger a WDK retry
 * storm on this step. The cleanup-sessions watchdog is the ultimate
 * safety net (catches stuck `active` sessions past
 * `max_runtime_seconds + 120s` grace).
 *
 * Why this lives in a step: `getRun()` is forbidden inside a
 * `"use workflow"` body (it throws USER_ERROR — see the existing
 * project memory note `reference_wdk_getrun_in_step`). The cancel
 * call has to live in a `"use step"` function.
 */
async function cancelInnerRunStep(
  innerRunId: string,
  tenantId: TenantId,
  agentId: AgentId,
): Promise<void> {
  "use step";

  try {
    await getRun(innerRunId).cancel();
    logger.info("cancelInnerRunStep: cancelled inner run after chat early-exit", {
      tenant_id: tenantId,
      agent_id: agentId,
      inner_run_id: innerRunId,
    });
  } catch (err) {
    logger.error("cancelInnerRunStep: cancel failed (cleanup-sessions watchdog will reap)", {
      tenant_id: tenantId,
      agent_id: agentId,
      inner_run_id: innerRunId,
      error_name: err instanceof Error ? err.constructor.name : "unknown",
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Final-delivery step: reaction swap (👀 → ✅/❌) + markBotEvent. Runs
 * once after the workflow body's consume loop terminates (whether
 * normally on terminal or abnormally on a future bug exit). Lives in
 * its own step because reactions and DB writes are I/O and must run
 * in step context, not the workflow body.
 *
 * Pre-refactor (PR #84 and earlier), this work lived in
 * `consumeAndPostStepBody`'s `finally` block. With the body-loop
 * pattern that block would fire on every iteration — for a 14-minute
 * agent reply, that's ~14 markBotEvent writes and ~14 reaction swaps,
 * polluting the operator UI's last_event timestamp and Slack's
 * reaction history. Pulling it into a single tail step keeps
 * observability clean.
 *
 * Best-effort throughout: reactions are decorative, markBotEvent is
 * an operator-visibility write. Failures are logged and swallowed so
 * a transient API hiccup here doesn't trigger a WDK retry storm.
 */
async function finalizeChatDeliveryStep(
  input: ChatTriggerInput,
  sawTerminal: boolean,
  state: ChatConsumeState,
): Promise<void> {
  "use step";
  // Treat sawAgentError OR an early body-exit-without-terminal as
  // "error" for the reaction swap. The user gets a visible signal
  // without us having to thread additional bookkeeping through the
  // loop.
  const success = sawTerminal && !state.sawAgentError;

  // Swap the receipt 👀 for ✅/❌. Best-effort.
  await safeRemoveReaction(input, REACTION_RECEIPT);
  await safeAddReaction(input, success ? REACTION_DONE : REACTION_ERROR);

  // markBotEvent — populates last_event timestamp the operator UI
  // surfaces. Best-effort.
  try {
    await markBotEvent(input.tenantId, input.agentId, input.platform);
  } catch (err) {
    logger.error("finalizeChatDeliveryStep: markBotEvent failed", {
      tenant_id: input.tenantId,
      agent_id: input.agentId,
      platform: input.platform,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

async function postBusyReplyStep(
  input: ChatTriggerInput,
  which: "agent" | "user" | "in_flight",
): Promise<void> {
  "use step";

  const text = busyReplyText(which);

  try {
    const cached = await resolveCachedBot(input.tenantId, input.agentId, input.platform);
    if (!cached) return;
    await postOrEdit({ bot: cached, threadId: input.threadKey, text });
  } catch (err) {
    logger.warn("postBusyReplyStep: failed", {
      tenant_id: input.tenantId,
      agent_id: input.agentId,
      which,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

function busyReplyText(which: "agent" | "user" | "in_flight"): string {
  switch (which) {
    case "user":
      return "I'm rate-limited for you specifically — wait a minute before retrying.";
    case "in_flight":
      return "Still working on your last message — one moment.";
    case "agent":
    default:
      return "I'm currently busy across the board — wait a few minutes before retrying.";
  }
}

/**
 * Pure error classifier for the `startInnerDispatchStep` catch block.
 * Returns `"in_flight"` iff the caught error is a `ConcurrencyLimitError`
 * (the per-session in-flight cap from `dispatcher.ts`). All other inputs
 * — including non-Error values from the `unknown` catch type — return
 * `"other"`. Pure: no I/O, no side effects, safe to unit-test.
 */
export function classifyDispatchFailure(
  err: unknown,
): "in_flight" | "other" {
  return err instanceof ConcurrencyLimitError ? "in_flight" : "other";
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

// ---------------------------------------------------------------------------
// NDJSON parser — chunks the dispatcher writeChunkStep emits via getWritable
// ---------------------------------------------------------------------------

interface AssistantContentBlock {
  type?: string;
  text?: string;
  // tool_use blocks. Claude Agent SDK emits these inside assistant messages
  // when the agent calls a tool. We map them to TaskUpdateChunk events
  // (status: "in_progress") so Slack's StreamingPlan UI surfaces tool calls
  // as visible task steps.
  id?: string;
  name?: string;
  input?: unknown;
  // tool_result blocks (live in `user` role messages, not assistant). The
  // `tool_use_id` correlates with the originating tool_use block's id so
  // we can mark that task complete. `is_error` (Claude Agent SDK) signals
  // a failed tool execution — surfaced to Slack as task_update status
  // "error" so users see the ⚠️ state instead of a misleading green ✅.
  tool_use_id?: string;
  is_error?: boolean;
  content?: string | Array<{ type?: string; text?: string }>;
}

interface AssistantMessage {
  content?: AssistantContentBlock[];
  // Claude Agent SDK includes a role on the SDK message — "assistant" for
  // agent turns, "user" for tool_result delivery. We branch on role so we
  // know whether content[] holds tool_use (assistant→tool) or tool_result
  // (tool→assistant).
  role?: string;
}

interface ParsedEvent {
  type?: string;
  kind?: string;
  text?: string;
  // `message` is overloaded across event types in the inner stream.
  // - On `type: "error"` it's a string (error message text).
  // - On `type: "assistant"` it's the SDK message object with content blocks
  //   carrying the agent reply text.
  // - On `type: "user"` (Claude SDK's tool_result message wrapper) it's the
  //   SDK message with content blocks of `type: "tool_result"`.
  message?: string | AssistantMessage;
  // On `type: "result"` Claude SDK emits a top-level `result` field with the
  // final assembled string — used as a fallback if the assistant blocks were
  // somehow empty.
  result?: string;
}

/**
 * Compute the portion of the final assistant text that wasn't already
 * streamed via per-token text_delta events. Returns "" when the deltas
 * match the assistant text exactly (the steady-state) — yielding "" is a
 * no-op to the Slack/Discord renderer. Returns the trailing remainder
 * when the assistant carries content the deltas don't (e.g. a final
 * newline, end-of-message punctuation, or text held back by the
 * StreamingMarkdownRenderer waiting for a safe markdown boundary).
 *
 * Falls back to the full assistant text when deltas don't appear as a
 * prefix — that case shouldn't happen in practice (the SDK emits text_delta
 * events whose concatenation equals the final assistant block), but the
 * fallback keeps the assistant text on screen rather than silently
 * dropping it. A pathological mismatch is preferable to a missing reply.
 */
function textRemainderAfterDeltas(assistantText: string, deltaText: string): string {
  if (deltaText.length === 0) return assistantText;
  if (assistantText.startsWith(deltaText)) {
    return assistantText.slice(deltaText.length);
  }
  return assistantText;
}

/**
 * Slack-path variant of `textRemainderAfterDeltas` that does NOT fall back
 * to the full assistant text on a prefix mismatch.
 *
 * Slack's renderer streams via `streamer.append({ markdown_text: delta })`,
 * which appends to the in-flight message's body. Yielding the full assistant
 * text on a prefix mismatch would APPEND it to the partial deltas already
 * in the renderer's buffer, producing the doubled-and-scrambled reply that
 * commit `d5dd1e8 fix(slack): skip assistant.text when any deltas arrived`
 * was originally fixing.
 *
 * On the clean prefix case (deltas are a strict prefix of assistant.text —
 * the common shape when writeChunkStep dropped trailing text_delta lines),
 * yielding only the missing tail recovers the dropped content without any
 * doubling risk: the renderer's accumulated buffer already contains the
 * prefix, so appending only the suffix produces the full final message.
 *
 * On a real mismatch (rare), we yield "" — the user sees the partial
 * deltas only. Partial-text in Slack is strictly better UX than scrambled
 * text, matching the trade-off `d5dd1e8` made.
 */
function assistantTailAfterDeltas(assistantText: string, deltaText: string): string {
  if (deltaText.length === 0) return assistantText;
  if (assistantText.startsWith(deltaText)) {
    return assistantText.slice(deltaText.length);
  }
  return "";
}

/** Render a tool_use input as a one-line task subtitle. */
function summarizeToolInput(input: unknown): string | undefined {
  if (input === null || input === undefined) return undefined;
  if (typeof input === "string") {
    return input.length > 120 ? input.slice(0, 117) + "…" : input;
  }
  try {
    const json = JSON.stringify(input);
    if (json === "{}") return undefined;
    return json.length > 120 ? json.slice(0, 117) + "…" : json;
  } catch {
    return undefined;
  }
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
  // Bounded-consume internals (PR #85 + post-review fixes).
  initialChatConsumeState,
  CONSUME_STEP_DEADLINE_MS,
  CONSUME_STEP_QUIET_MS,
} as const;
