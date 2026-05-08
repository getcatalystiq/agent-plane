/**
 * Slack streaming bridge — bypasses `@chat-adapter/slack`'s `adapter.stream`
 * so we can:
 *   - Set a larger `buffer_size` on `client.chatStream` (P4)
 *   - Time every `chat.appendStream` API call (P2) and surface p50/p95/total
 *   - Roll the stream over to a fresh message before Slack's server-side
 *     timeout closes it on us (T1)
 *   - Pre-emptively flush at safe markdown boundaries so a force-close
 *     can never strand content the renderer was holding back (T2)
 *   - Drop empty/whitespace-only deltas (P6)
 *   - Switch to a simple newline-only renderer behind a feature flag (P7)
 *
 * The behavioural contract matches `@chat-adapter/slack`'s `stream()`:
 *   - Plain strings go through `StreamingMarkdownRenderer` (or our simple
 *     newline renderer when `SLACK_STREAM_RAW_NEWLINE === "true"`)
 *   - Structured chunks (`task_update`, `markdown_text`) reuse the
 *     adapter's pattern: flush accumulated markdown delta, then send the
 *     chunk via `streamer.append({ chunks })`
 *   - On structured-chunk failure, fall back to text-only streaming
 *     (mirrors the adapter's degradation path so older Slack apps still
 *     work)
 *
 * Plan reference: docs/plans/2026-05-08-002-fix-slack-stream-truncation-and-lag-plan.md
 */

import { StreamingMarkdownRenderer } from "chat";
import { logger } from "@/lib/logger";
import type { CachedBot } from "@/lib/platform/bot";

// ---------------------------------------------------------------------------
// Tunables (env-overridable; safe defaults)
// ---------------------------------------------------------------------------

/** Slack ChatStreamer buffer size in bytes. SDK default is 256 — too chatty
 *  for long replies (16+ serial appendStream calls on a 4 KB reply). 2048
 *  cuts API call count ~8× without making short replies feel chunky. */
const DEFAULT_BUFFER_SIZE = 2048;

/** Hard cap on how long a single Slack stream may stay open before we
 *  proactively rollover. Slack's server-side timeout is undocumented; 90s
 *  is a conservative ceiling that has room to drop further if we observe
 *  earlier kills in practice. */
const DEFAULT_STREAM_MAX_OPEN_MS = 90_000;

function readPositiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function getBufferSize(): number {
  return readPositiveIntEnv("SLACK_STREAM_BUFFER_SIZE", DEFAULT_BUFFER_SIZE);
}

function getStreamMaxOpenMs(): number {
  return readPositiveIntEnv("SLACK_STREAM_MAX_OPEN_MS", DEFAULT_STREAM_MAX_OPEN_MS);
}

function debugEnabled(): boolean {
  return process.env.SLACK_STREAM_DEBUG === "true";
}

function rawNewlineRenderEnabled(): boolean {
  return process.env.SLACK_STREAM_RAW_NEWLINE === "true";
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export type StreamChunk =
  | string
  | { type: "markdown_text"; text: string }
  | {
      type: "task_update";
      id: string;
      title: string;
      status: "pending" | "in_progress" | "complete" | "error";
      details?: string;
      output?: string;
    };

export interface StreamToSlackInput {
  bot: CachedBot;
  /** Encoded by the Slack adapter as `slack:channel[:threadTs]`. */
  threadKey: string;
  /** AsyncIterable of strings or structured chunks. */
  chunks: AsyncIterable<StreamChunk>;
  /** The Slack user the stream is being delivered to (for AI assistant context). */
  recipientUserId: string | undefined;
  /** The Slack workspace id (for AI assistant context). */
  recipientTeamId: string | undefined;
  /** Diagnostic context — flows through every log line. */
  diagContext: {
    tenantId: string;
    agentId: string;
    innerRunId: string;
  };
}

export interface StreamToSlackResult {
  /** Total raw bytes yielded to the renderer (sum of all string chunks). */
  bytesYielded: number;
  /** Number of `chat.appendStream` API calls observed. */
  appendApiCalls: number;
  /** p50 / p95 / total wall-clock for `streamer.append` (ms). */
  appendMs: { p50: number; p95: number; total: number };
  /** Number of times we proactively rolled the stream over (T1). */
  rolloverCount: number;
}

// ---------------------------------------------------------------------------
// Slack ChatStreamer / WebClient duck types — keeps this module free of a
// hard dependency on @slack/web-api types. Mirror the runtime shape from
// node_modules/@slack/web-api/dist/chat-stream.js.
// ---------------------------------------------------------------------------

interface SlackChatStreamer {
  append(args: {
    markdown_text?: string;
    chunks?: unknown[];
    token?: string;
  }): Promise<unknown>;
  stop(args?: { blocks?: unknown }): Promise<unknown>;
}

interface SlackWebClient {
  chatStream(params: {
    channel: string;
    thread_ts?: string;
    recipient_user_id?: string;
    recipient_team_id?: string;
    buffer_size?: number;
  }): SlackChatStreamer;
}

// ---------------------------------------------------------------------------
// Decoder for adapter-encoded thread ids
// ---------------------------------------------------------------------------

function decodeThreadId(threadId: string): { channel: string; threadTs: string } {
  // The Slack adapter encodes thread ids as `slack:channel[:threadTs]`. The
  // helper in slack.ts speaks of a 4-part variant (`slack:teamId:channelId:thread_ts`)
  // but the @chat-adapter/slack runtime never produces that shape — see
  // node_modules/@chat-adapter/slack/dist/index.js:3826 (decodeThreadId).
  // Accept 2 or 3 parts; reject anything else.
  const parts = threadId.split(":");
  if (parts.length < 2 || parts.length > 3 || parts[0] !== "slack") {
    throw new Error(`Invalid Slack thread id: ${threadId}`);
  }
  return {
    channel: parts[1] ?? "",
    threadTs: parts.length === 3 ? (parts[2] ?? "") : "",
  };
}

// ---------------------------------------------------------------------------
// Renderers
// ---------------------------------------------------------------------------

/**
 * Renderer interface — both the Chat-SDK markdown renderer and our newline-
 * only fallback satisfy this. `getCommittableText` returns the maximal safe
 * prefix; `finish` switches to "drain everything" mode.
 */
interface IRenderer {
  push(text: string): void;
  getCommittableText(): string;
  finish(): void;
  getAccumulatedLength(): number;
}

class WrappedMarkdownRenderer implements IRenderer {
  private readonly inner: StreamingMarkdownRenderer;
  private accumulated = "";
  constructor() {
    // wrapTablesForAppend: false matches the Slack adapter's call. We don't
    // want code-fence wrapping on Slack streams — Slack mrkdwn renders pipes
    // as literal text already.
    this.inner = new StreamingMarkdownRenderer({ wrapTablesForAppend: false });
  }
  push(text: string): void {
    this.accumulated += text;
    this.inner.push(text);
  }
  getCommittableText(): string {
    return this.inner.getCommittableText();
  }
  finish(): void {
    this.inner.finish();
  }
  getAccumulatedLength(): number {
    return this.accumulated.length;
  }
}

/**
 * Newline-only renderer (P7) — flushes everything up to and including the
 * last newline in the buffer, no markdown holdback. Slack mrkdwn tolerates
 * mid-stream unclosed `**`/`_` for a tick, then renders correctly once the
 * close arrives. Strictly better than holding 200+ bytes behind one `**`
 * for the entire remainder of a paragraph.
 */
class NewlineOnlyRenderer implements IRenderer {
  private accumulated = "";
  private finished = false;
  push(text: string): void {
    this.accumulated += text;
  }
  getCommittableText(): string {
    if (this.finished) return this.accumulated;
    const lastNewline = this.accumulated.lastIndexOf("\n");
    return lastNewline >= 0 ? this.accumulated.slice(0, lastNewline + 1) : "";
  }
  finish(): void {
    this.finished = true;
  }
  getAccumulatedLength(): number {
    return this.accumulated.length;
  }
}

function makeRenderer(): IRenderer {
  return rawNewlineRenderEnabled() ? new NewlineOnlyRenderer() : new WrappedMarkdownRenderer();
}

// ---------------------------------------------------------------------------
// Append timing tracker (P2)
// ---------------------------------------------------------------------------

class AppendTimings {
  private samples: number[] = [];
  private total = 0;
  recordMs(ms: number): void {
    this.samples.push(ms);
    this.total += ms;
  }
  count(): number {
    return this.samples.length;
  }
  summarize(): { p50: number; p95: number; total: number } {
    if (this.samples.length === 0) {
      return { p50: 0, p95: 0, total: 0 };
    }
    const sorted = [...this.samples].sort((a, b) => a - b);
    const idx = (q: number): number => Math.min(sorted.length - 1, Math.floor(q * sorted.length));
    return {
      p50: sorted[idx(0.5)] ?? 0,
      p95: sorted[idx(0.95)] ?? 0,
      total: this.total,
    };
  }
}

// ---------------------------------------------------------------------------
// Per-stream session (one chatStream lifecycle)
// ---------------------------------------------------------------------------

class SlackStreamSession {
  private readonly client: SlackWebClient;
  private readonly channel: string;
  private readonly threadTs: string | undefined;
  private readonly recipientUserId: string | undefined;
  private readonly recipientTeamId: string | undefined;
  private readonly bufferSize: number;
  private readonly token: string;
  private streamer: SlackChatStreamer | null = null;
  private firstAppend = true;
  private openedAt = 0;
  /** Bytes already committed to THIS stream (renderer-output). Used to
   *  compute deltas on each push. Resets on rollover. */
  private lastAppended = "";

  constructor(opts: {
    client: SlackWebClient;
    channel: string;
    threadTs: string | undefined;
    recipientUserId: string | undefined;
    recipientTeamId: string | undefined;
    bufferSize: number;
    token: string;
  }) {
    this.client = opts.client;
    this.channel = opts.channel;
    this.threadTs = opts.threadTs;
    this.recipientUserId = opts.recipientUserId;
    this.recipientTeamId = opts.recipientTeamId;
    this.bufferSize = opts.bufferSize;
    this.token = opts.token;
  }

  open(): void {
    this.streamer = this.client.chatStream({
      channel: this.channel,
      ...(this.threadTs ? { thread_ts: this.threadTs } : {}),
      ...(this.recipientUserId ? { recipient_user_id: this.recipientUserId } : {}),
      ...(this.recipientTeamId ? { recipient_team_id: this.recipientTeamId } : {}),
      buffer_size: this.bufferSize,
    });
    this.openedAt = Date.now();
    this.firstAppend = true;
    this.lastAppended = "";
  }

  isOpen(): boolean {
    return this.streamer !== null;
  }

  elapsedMs(): number {
    return this.openedAt === 0 ? 0 : Date.now() - this.openedAt;
  }

  /** Append a markdown delta. Returns the wall-clock cost (ms). */
  async appendMarkdown(delta: string, timings: AppendTimings): Promise<void> {
    if (delta.length === 0) return; // P6 — skip empty deltas
    if (!this.streamer) throw new Error("Stream not open");
    const t0 = Date.now();
    if (this.firstAppend) {
      await this.streamer.append({ markdown_text: delta, token: this.token });
      this.firstAppend = false;
    } else {
      await this.streamer.append({ markdown_text: delta });
    }
    timings.recordMs(Date.now() - t0);
    this.lastAppended += delta;
  }

  /** Append structured chunks. Falls back to text-only on failure. */
  async appendStructured(
    chunks: unknown[],
    timings: AppendTimings,
  ): Promise<{ ok: boolean; error?: unknown }> {
    if (!this.streamer) throw new Error("Stream not open");
    const t0 = Date.now();
    try {
      if (this.firstAppend) {
        await this.streamer.append({ chunks, token: this.token });
        this.firstAppend = false;
      } else {
        await this.streamer.append({ chunks });
      }
      timings.recordMs(Date.now() - t0);
      return { ok: true };
    } catch (err) {
      timings.recordMs(Date.now() - t0);
      return { ok: false, error: err };
    }
  }

  /** Close this stream. Idempotent — safe to call after rollover. */
  async stop(): Promise<void> {
    if (!this.streamer) return;
    try {
      await this.streamer.stop();
    } finally {
      this.streamer = null;
    }
  }

  /** How many renderer-output chars have been appended to THIS stream. */
  appendedLength(): number {
    return this.lastAppended.length;
  }
}

// ---------------------------------------------------------------------------
// Public entry point
// ---------------------------------------------------------------------------

export async function streamToSlack(input: StreamToSlackInput): Promise<StreamToSlackResult> {
  const { bot, threadKey, chunks, recipientUserId, recipientTeamId, diagContext } = input;
  const { channel, threadTs: rawThreadTs } = decodeThreadId(threadKey);
  if (!rawThreadTs) {
    throw new Error("Slack streaming requires a non-empty thread context");
  }
  if (!recipientUserId || !recipientTeamId) {
    throw new Error("Slack streaming requires recipientUserId and recipientTeamId");
  }

  // The cached bot's adapter is the SlackAdapter instance. `client` is a
  // private field per the published types but a regular property at runtime;
  // we type it through a duck-typed interface and never widen the public
  // surface.
  const adapterUnknown = bot.adapter as unknown as { client: SlackWebClient };
  const client = adapterUnknown.client;
  if (!client || typeof client.chatStream !== "function") {
    throw new Error("Slack adapter does not expose a `client.chatStream` — SDK version mismatch?");
  }

  const bufferSize = getBufferSize();
  const streamMaxOpenMs = getStreamMaxOpenMs();
  const debug = debugEnabled();
  const startedAt = Date.now();
  const timings = new AppendTimings();
  let rolloverCount = 0;
  let bytesYielded = 0;

  let renderer: IRenderer = makeRenderer();
  let session = new SlackStreamSession({
    client,
    channel,
    threadTs: rawThreadTs,
    recipientUserId,
    recipientTeamId,
    bufferSize,
    token: bot.botToken,
  });

  if (debug) {
    logger.info("streamToSlack: opening stream", {
      ...diagContext,
      channel,
      thread_ts: rawThreadTs,
      buffer_size: bufferSize,
      stream_max_open_ms: streamMaxOpenMs,
      raw_newline_render: rawNewlineRenderEnabled(),
    });
  }

  // Lazy-open: don't open the Slack stream until we have something to send.
  // This matches the renderer's "no committable yet" semantics and avoids
  // creating an empty stream when the agent emits nothing.
  const ensureOpen = (): void => {
    if (!session.isOpen()) session.open();
  };

  /** Flush as much of the renderer's committable prefix as we haven't
   *  already sent on the current stream. Always called before structured
   *  chunks so they slot into the right position. */
  const flushDelta = async (): Promise<void> => {
    const committable = renderer.getCommittableText();
    if (committable.length <= session.appendedLength()) return;
    const delta = committable.slice(session.appendedLength());
    if (delta.length === 0) return;
    ensureOpen();
    await session.appendMarkdown(delta, timings);
  };

  /** Roll the current stream over to a fresh one. The current message is
   *  sealed via streamer.stop(), then a fresh streamer + renderer are
   *  installed for the rest of the reply. We do this proactively when the
   *  current stream has been open longer than `streamMaxOpenMs` and we hit
   *  a clean boundary (whitespace-terminated committable). */
  const rollover = async (reason: string): Promise<void> => {
    if (!session.isOpen()) return;
    // Drain whatever the renderer can release on the current stream before
    // closing — finish() releases anything held back, and the resulting
    // delta lands on the message we're about to seal.
    renderer.finish();
    await flushDelta();
    await session.stop();
    rolloverCount += 1;
    if (debug) {
      logger.info("streamToSlack: rollover", {
        ...diagContext,
        reason,
        rollover_count: rolloverCount,
        bytes_yielded: bytesYielded,
        elapsed_ms: Date.now() - startedAt,
      });
    }
    renderer = makeRenderer();
    session = new SlackStreamSession({
      client,
      channel,
      threadTs: rawThreadTs,
      recipientUserId,
      recipientTeamId,
      bufferSize,
      token: bot.botToken,
    });
  };

  /** True when we're at a markdown boundary safe to seal a message at —
   *  the committable prefix ends in a newline or the renderer is empty.
   *  Used so rollover never cuts mid-token. */
  const atSafeBoundary = (): boolean => {
    const committable = renderer.getCommittableText();
    if (committable.length === 0) return true;
    return committable.endsWith("\n");
  };

  let structuredChunksSupported = true;
  let lastDebugLogBytes = 0;
  const DEBUG_LOG_BYTE_INTERVAL = 1024;

  try {
    for await (const chunk of chunks) {
      if (typeof chunk === "string") {
        if (chunk.length === 0) continue; // P6 — skip empty
        bytesYielded += chunk.length;
        renderer.push(chunk);

        // T1 — proactively rollover before Slack's server-side timeout.
        if (
          session.isOpen() &&
          session.elapsedMs() > streamMaxOpenMs &&
          atSafeBoundary()
        ) {
          await rollover("max_open_ms_exceeded");
        }

        await flushDelta();

        if (debug && bytesYielded - lastDebugLogBytes >= DEBUG_LOG_BYTE_INTERVAL) {
          lastDebugLogBytes = bytesYielded;
          logger.info("streamToSlack: progress", {
            ...diagContext,
            bytes_yielded: bytesYielded,
            append_calls: timings.count(),
            elapsed_ms: Date.now() - startedAt,
            stream_open_ms: session.elapsedMs(),
            rollover_count: rolloverCount,
          });
        }
      } else if (chunk.type === "markdown_text") {
        if (chunk.text.length === 0) continue;
        bytesYielded += chunk.text.length;
        renderer.push(chunk.text);
        if (
          session.isOpen() &&
          session.elapsedMs() > streamMaxOpenMs &&
          atSafeBoundary()
        ) {
          await rollover("max_open_ms_exceeded");
        }
        await flushDelta();
      } else {
        // Structured chunk (task_update). Flush pending text first so the
        // chunk lands at the correct visual position, then send the chunk.
        if (!structuredChunksSupported) continue;
        await flushDelta();
        ensureOpen();
        const result = await session.appendStructured([chunk], timings);
        if (!result.ok) {
          structuredChunksSupported = false;
          logger.warn("streamToSlack: structured chunk failed; falling back to text-only", {
            ...diagContext,
            chunk_type: chunk.type,
            error: result.error instanceof Error ? result.error.message : String(result.error),
          });
        }
      }
    }

    // Drain end-of-stream: switch the renderer to finished mode (releases
    // any held-back markdown) and flush the residual.
    renderer.finish();
    await flushDelta();
    if (session.isOpen()) {
      const stopT0 = Date.now();
      await session.stop();
      timings.recordMs(Date.now() - stopT0);
    }
  } catch (err) {
    // Best-effort close so the stream doesn't sit `in_progress` on Slack
    // if our caller doesn't immediately retry. Swallow stop() errors —
    // we're already in the failure path.
    try {
      await session.stop();
    } catch {
      // ignore
    }
    throw err;
  }

  const summary = timings.summarize();
  // Always log the timing summary — this is the single most useful number
  // for diagnosing future "Slack lags after the bot is done" reports, and
  // it's one structured log line per chat reply.
  logger.info("streamToSlack: complete", {
    ...diagContext,
    bytes_yielded: bytesYielded,
    append_calls: timings.count(),
    append_p50_ms: summary.p50,
    append_p95_ms: summary.p95,
    append_total_ms: summary.total,
    rollover_count: rolloverCount,
    elapsed_ms: Date.now() - startedAt,
    buffer_size: bufferSize,
    raw_newline_render: rawNewlineRenderEnabled(),
  });

  return {
    bytesYielded,
    appendApiCalls: timings.count(),
    appendMs: summary,
    rolloverCount,
  };
}
