/**
 * Platform callback wrappers — wraps Chat SDK adapter posts/edits and
 * surfaces 429 + Retry-After cleanly so the workflow's edit-gate can lengthen.
 *
 * Plan reference: U6 in
 * docs/plans/2026-05-06-001-feat-chat-platform-bots-discord-slack-plan.md
 */

import type { CachedBot } from "@/lib/platform/bot";

export interface PostOrEditInput {
  bot: CachedBot;
  channelId: string;
  text: string;
  /** When set, edit the existing message instead of posting a new one. */
  existingMessageId?: string;
  /** When seal=true, append the rollover suffix `…` to the flushed slice. */
  seal?: boolean;
  /** When true, prefix `[continued] ` to a freshly-posted continuation. */
  continuation?: boolean;
  /** Reply-to id for first post in a Discord thread. */
  replyToMessageId?: string;
}

export type PostOrEditResult =
  | { ok: true; messageId: string }
  | { ok: false; rateLimited: true; retryAfterMs: number }
  | { ok: false; rateLimited: false; error: string };

interface MessagePostable {
  postMessage?: (text: string, opts?: { replyToMessageId?: string }) => Promise<{ id: string } | string>;
  editMessage?: (messageId: string, text: string) => Promise<void>;
}

/**
 * Post or edit a chat message. Returns 429 details when the platform
 * rate-limits us so the caller can drain its channel bucket.
 */
export async function postOrEdit(input: PostOrEditInput): Promise<PostOrEditResult> {
  const text = composeText(input);
  // The Chat SDK exposes per-channel post/edit on the adapter instance.
  // The exact surface varies by adapter; wrap in any-cast and pattern-match.
  const adapter = input.bot.adapter as unknown as {
    postMessage?: (channelId: string, text: string, opts?: Record<string, unknown>) => Promise<{ id: string } | string>;
    editMessage?: (channelId: string, messageId: string, text: string) => Promise<void>;
    channels?: Record<string, MessagePostable>;
  };

  try {
    if (input.existingMessageId && typeof adapter.editMessage === "function") {
      await adapter.editMessage(input.channelId, input.existingMessageId, text);
      return { ok: true, messageId: input.existingMessageId };
    }
    if (typeof adapter.postMessage === "function") {
      const opts: Record<string, unknown> = {};
      if (input.replyToMessageId) opts.replyToMessageId = input.replyToMessageId;
      const result = await adapter.postMessage(input.channelId, text, opts);
      const id = typeof result === "string" ? result : result.id;
      return { ok: true, messageId: id };
    }
    return { ok: false, rateLimited: false, error: "adapter_missing_post_method" };
  } catch (err) {
    const parsed = parseRateLimit(err);
    if (parsed) return { ok: false, rateLimited: true, retryAfterMs: parsed };
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
 */
export function parseRateLimit(err: unknown): number | null {
  if (!err) return null;
  const msg = String((err as { message?: string })?.message ?? err);
  const status = (err as { status?: number; statusCode?: number })?.status ?? (err as { statusCode?: number })?.statusCode;
  const retryAfter = (err as { retryAfter?: number; retry_after?: number })?.retryAfter ?? (err as { retry_after?: number })?.retry_after;

  if (status === 429 || /\b429\b|rate.?limit/i.test(msg)) {
    if (typeof retryAfter === "number" && retryAfter > 0) {
      // Both Discord and Slack return seconds in the JSON body and most
      // SDK errors normalize to seconds; bump anything <50 to milliseconds.
      return retryAfter < 50 ? Math.ceil(retryAfter * 1000) : Math.ceil(retryAfter);
    }
    // Default to 1 second backoff when no header is provided.
    return 1000;
  }
  return null;
}

/**
 * Per-channel token bucket — Discord's per-channel cap is 5 edits / 5 sec.
 * In-process bucket; cross-instance burst is bounded by the per-user rate
 * limit at the bridge.
 */
export class ChannelTokenBucket {
  private tokens: number;
  private lastRefill: number;

  constructor(public readonly capacity: number, public readonly windowMs: number) {
    this.tokens = capacity;
    this.lastRefill = Date.now();
  }

  tryConsume(): boolean {
    this.refill();
    if (this.tokens >= 1) {
      this.tokens -= 1;
      return true;
    }
    return false;
  }

  drain(): void {
    this.tokens = 0;
    this.lastRefill = Date.now();
  }

  private refill(): void {
    const now = Date.now();
    const elapsed = now - this.lastRefill;
    if (elapsed >= this.windowMs) {
      this.tokens = this.capacity;
      this.lastRefill = now;
    } else if (elapsed > 0) {
      const refillRate = this.capacity / this.windowMs;
      this.tokens = Math.min(this.capacity, this.tokens + elapsed * refillRate);
      this.lastRefill = now;
    }
  }
}
