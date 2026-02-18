import { logger } from "./logger";

// In-memory idempotency store (upgrade to Vercel KV for cross-instance protection)
const store = new Map<string, { response: unknown; expiresAt: number }>();

const TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_ENTRIES = 10_000;

export function getIdempotentResponse(key: string): unknown | null {
  const entry = store.get(key);
  if (!entry) return null;

  if (entry.expiresAt < Date.now()) {
    store.delete(key);
    return null;
  }

  logger.debug("Idempotency cache hit", { key });
  return entry.response;
}

export function setIdempotentResponse(key: string, response: unknown): void {
  // Enforce hard cap to prevent unbounded memory growth
  if (store.size >= MAX_ENTRIES) {
    const now = Date.now();
    for (const [k, v] of store) {
      if (v.expiresAt < now) store.delete(k);
    }
    // If still over limit after expiry cleanup, evict oldest entries
    if (store.size >= MAX_ENTRIES) {
      const toDelete = store.size - MAX_ENTRIES + 1000; // free 1000 slots
      let deleted = 0;
      for (const k of store.keys()) {
        if (deleted >= toDelete) break;
        store.delete(k);
        deleted++;
      }
    }
  }

  store.set(key, {
    response,
    expiresAt: Date.now() + TTL_MS,
  });
}
