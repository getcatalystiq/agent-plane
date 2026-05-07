/**
 * Cross-instance per-channel token bucket via Upstash Redis.
 *
 * Plan reference: A3 fix for review run 20260506-221948-2402b0ed P1 #8.
 *
 * The original in-process ChannelTokenBucket was workflow-instance-scoped:
 * two parallel chat workflows in the same Discord channel each got a
 * fresh budget, exceeding Discord's 5/5sec per-channel ceiling. This
 * helper coordinates via Redis INCR + EXPIRE so the cap holds across
 * instances and parallel workflow runs.
 *
 * Pattern: fixed-window counter keyed on `chat:bucket:${platform}:
 * ${channelId}:${windowStart}`. INCR is atomic in Redis; the first call
 * sets EXPIRE so the key auto-cleans. On rollover into the next window,
 * a fresh counter starts at 1.
 *
 * Trade-off: fixed-window has the classic edge effect (a burst at the
 * end of one window plus the start of the next can briefly exceed the
 * cap). For Discord's 5/5sec ceiling that's acceptable — at worst a
 * single 429 with the dispatcher's existing parseRateLimit + retry-
 * after backoff catching it. Sliding window is overkill for v1.
 */

import { createClient, type RedisClientType } from "redis";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import type { ChatPlatform } from "@/lib/platform/operations";

let sharedClient: RedisClientType | null = null;
let connectPromise: Promise<void> | null = null;

async function getClient(): Promise<RedisClientType> {
  if (!sharedClient) {
    const env = getEnv();
    if (!env.UPSTASH_REDIS_URL) {
      throw new Error("redis-bucket requires UPSTASH_REDIS_URL");
    }
    sharedClient = createClient({ url: env.UPSTASH_REDIS_URL }) as RedisClientType;
    sharedClient.on("error", (err: Error) => {
      logger.warn("redis-bucket: client error", { error: err.message });
    });
  }
  if (!sharedClient.isOpen) {
    if (!connectPromise) {
      // redis@5 returns the client from connect(); cast to void since we
      // re-use the captured reference.
      connectPromise = sharedClient.connect().then(() => undefined);
    }
    await connectPromise;
    connectPromise = null;
  }
  return sharedClient;
}

export interface BucketOpts {
  platform: ChatPlatform;
  channelId: string;
  capacity: number;
  windowMs: number;
}

/**
 * Try to consume one token from the channel's bucket. Returns true when
 * the request fits inside the cap, false when the cap is exhausted in
 * the current window.
 *
 * Fail-open on Redis unavailability: returns true so a Redis outage
 * doesn't take down chat replies. The Discord/Slack 429 handling at
 * postOrEdit is the secondary defense.
 */
export async function tryConsumeChannelToken(opts: BucketOpts): Promise<boolean> {
  try {
    const client = await getClient();
    const windowStart = Math.floor(Date.now() / opts.windowMs);
    const key = `chat:bucket:${opts.platform}:${opts.channelId}:${windowStart}`;
    const count = await client.incr(key);
    if (count === 1) {
      // First request in this window — set TTL so the counter auto-cleans
      // a tick after the window ends. +1s buffer keeps clock-skew safe.
      await client.expire(key, Math.ceil(opts.windowMs / 1000) + 1);
    }
    return count <= opts.capacity;
  } catch (err) {
    logger.warn("redis-bucket: tryConsume failed (fail-open)", {
      platform: opts.platform,
      channel_id: opts.channelId,
      error: err instanceof Error ? err.message : String(err),
    });
    return true;
  }
}

/**
 * Force-drain the channel bucket — used after a 429 to ensure subsequent
 * tryConsume calls deny until the next window starts. Sets the key to
 * `capacity` so further INCR calls return >capacity.
 */
export async function drainChannelToken(opts: BucketOpts): Promise<void> {
  try {
    const client = await getClient();
    const windowStart = Math.floor(Date.now() / opts.windowMs);
    const key = `chat:bucket:${opts.platform}:${opts.channelId}:${windowStart}`;
    await client.set(key, String(opts.capacity + 1), {
      EX: Math.ceil(opts.windowMs / 1000) + 1,
    });
  } catch (err) {
    logger.warn("redis-bucket: drain failed (best-effort)", {
      platform: opts.platform,
      channel_id: opts.channelId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}

/** Test-only: clear the cached client between cases. */
export function _resetRedisBucketForTests(): void {
  sharedClient = null;
  connectPromise = null;
}
