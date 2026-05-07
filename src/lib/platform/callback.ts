/**
 * Platform callback wrappers — uses the Chat SDK's actual `Adapter.postMessage`
 * (threadId: string, AdapterPostableMessage) and `Adapter.editMessage`
 * (threadId: string, messageId: string, AdapterPostableMessage) APIs.
 *
 * Plan reference: U6 in
 * docs/plans/2026-05-06-001-feat-chat-platform-bots-discord-slack-plan.md
 *
 * Earlier revisions of this file invented a `(channelId, text, opts)` API
 * via a duck-type cast — that didn't match the real Chat SDK surface and
 * would have failed at runtime on the first chat reply. Code review caught
 * it; this is the corrected wiring (see review run 20260506-221948-2402b0ed,
 * P0 #4 and P2 #22 / API timeout).
 *
 * Surfaces 429 + Retry-After cleanly so the workflow's edit-gate can
 * lengthen. POST_TIMEOUT_MS bounds slow Discord/Slack shards from wedging
 * the workflow loop indefinitely.
 */

import type { CachedBot } from "@/lib/platform/bot";

const POST_TIMEOUT_MS = 10_000;

export interface PostOrEditInput {
  bot: CachedBot;
  /** Encoded thread id, e.g. `discord:guildId:channelId:threadId` or
   *  `slack:teamId:channelId:thread_ts`. The Chat SDK's adapter parses
   *  this string into the platform-specific thread shape internally. */
  threadId: string;
  text: string;
  /** When set, edit the existing message instead of posting a new one. */
  existingMessageId?: string;
  /** When seal=true, append the rollover suffix `…` to the flushed slice. */
  seal?: boolean;
  /** When true, prefix `[continued] ` to a freshly-posted continuation. */
  continuation?: boolean;
}

export type PostOrEditResult =
  | { ok: true; messageId: string }
  | { ok: false; rateLimited: true; retryAfterMs: number }
  | { ok: false; rateLimited: false; error: string };

interface AdapterPostMessageShape {
  postMessage: (threadId: string, message: string) => Promise<{ id: string }>;
  editMessage: (threadId: string, messageId: string, message: string) => Promise<{ id: string }>;
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    p.then((v) => {
      clearTimeout(t);
      resolve(v);
    }).catch((err) => {
      clearTimeout(t);
      reject(err);
    });
  });
}

/**
 * Post or edit a chat message. Returns 429 details when the platform
 * rate-limits us so the caller can drain its channel bucket.
 */
export async function postOrEdit(input: PostOrEditInput): Promise<PostOrEditResult> {
  const text = composeText(input);
  // Adapter.postMessage / editMessage are the documented Chat SDK surface
  // (DiscordAdapter and SlackAdapter both implement Adapter<TThreadId,
  // TRawMessage> with these signatures). The narrow cast below is needed
  // because CachedBot.adapter is the union DiscordAdapter | SlackAdapter
  // and TS can't narrow on the union shape without a discriminator switch.
  const adapter = input.bot.adapter as unknown as AdapterPostMessageShape;

  try {
    if (input.existingMessageId) {
      const result = await withTimeout(
        adapter.editMessage(input.threadId, input.existingMessageId, text),
        POST_TIMEOUT_MS,
        "editMessage",
      );
      return { ok: true, messageId: result.id ?? input.existingMessageId };
    }
    const result = await withTimeout(
      adapter.postMessage(input.threadId, text),
      POST_TIMEOUT_MS,
      "postMessage",
    );
    return { ok: true, messageId: result.id };
  } catch (err) {
    const parsed = parseRateLimit(err);
    if (parsed != null) return { ok: false, rateLimited: true, retryAfterMs: parsed };
    return { ok: false, rateLimited: false, error: err instanceof Error ? err.message : String(err) };
  }
}

function composeText(input: PostOrEditInput): string {
  let text = input.text;
  if (input.continuation) text = `[continued] ${text}`;
  if (input.seal) text = `${text} …`;
  return text;
}

/**
 * Parse a Discord/Slack 429 error and extract the retry-after window in ms.
 * Returns null when the error isn't a rate-limit response.
 *
 * Discord and Slack both report Retry-After as integer/float SECONDS — the
 * earlier `>= 50 means already-ms` heuristic was wrong and 1000× under-shot
 * the Slack backoff (P1 #7 in review run 20260506-221948-2402b0ed). Always
 * treat retry-after as seconds; the caller multiplies to ms.
 */
export function parseRateLimit(err: unknown): number | null {
  if (!err) return null;
  const msg = String((err as { message?: string })?.message ?? err);
  const status = (err as { status?: number; statusCode?: number })?.status ?? (err as { statusCode?: number })?.statusCode;
  const retryAfter = (err as { retryAfter?: number; retry_after?: number })?.retryAfter ?? (err as { retry_after?: number })?.retry_after;

  if (status === 429 || /\b429\b|rate.?limit/i.test(msg)) {
    if (typeof retryAfter === "number" && retryAfter > 0) {
      // Always seconds → milliseconds. Discord retry_after is float seconds;
      // Slack Retry-After header is integer seconds.
      return Math.ceil(retryAfter * 1000);
    }
    // Default to 1 second backoff when no header is provided.
    return 1000;
  }
  return null;
}

// NOTE: the previous `ChannelTokenBucket` in-process class lived here.
// It was workflow-instance-scoped — two parallel chat workflows in the
// same channel each got a fresh budget, exceeding Discord's 5/5sec cap
// (P1 #8 in review run 20260506-221948-2402b0ed). Replaced by the
// Redis-backed `tryConsumeChannelToken` / `drainChannelToken` helpers
// in `src/lib/platform/redis-bucket.ts`.
