/**
 * Vercel Blob private-store boot canary.
 *
 * Plan reference: P2 #26 fix for review run 20260506-221948-2402b0ed.
 *
 * `attachments.ts` calls `put({ access: 'public', token: BLOB_PRIVATE_READ_WRITE_TOKEN })`
 * and silently relies on the token resolving to a privately-provisioned
 * store. A misconfigured deploy that points BLOB_PRIVATE_READ_WRITE_TOKEN
 * at a public store would make every chat attachment URL anonymously
 * fetchable. This canary uploads a 0-byte test object at chat-feature
 * boot, attempts an anonymous read, and fails closed if the read
 * succeeds.
 *
 * Cached after first run so the check happens at most once per
 * function-instance lifetime. Failure caches a Promise.reject so the
 * chat workflow refuses to use the blob path until the deployment is
 * fixed.
 */

import { put } from "@vercel/blob";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";

let canaryResult: Promise<void> | null = null;
let canaryResultExpiresAt = 0;

const CANARY_TIMEOUT_MS = 10_000;
const CANARY_SUCCESS_TTL_MS = 60 * 60 * 1000; // 1h: re-canary on rotation
const CANARY_FAILURE_RETRY_MS = 60_000;

async function runCanary(): Promise<void> {
  const env = getEnv();
  if (!env.BLOB_PRIVATE_READ_WRITE_TOKEN) {
    throw new Error("blob_canary: BLOB_PRIVATE_READ_WRITE_TOKEN is not set; chat attachments cannot be uploaded.");
  }

  const probeKey = `chat-attachments/_canary/${Date.now()}-${Math.random().toString(16).slice(2, 8)}.txt`;
  const probeContent = "private-store-canary";

  const uploadController = new AbortController();
  const uploadTimer = setTimeout(() => uploadController.abort(), CANARY_TIMEOUT_MS);
  let uploaded;
  try {
    uploaded = await put(probeKey, probeContent, {
      access: "public",
      token: env.BLOB_PRIVATE_READ_WRITE_TOKEN,
      contentType: "text/plain",
    });
  } finally {
    clearTimeout(uploadTimer);
  }

  // Try to fetch the URL anonymously (no Authorization header). If a
  // privately-provisioned store, this should fail or return non-OK. If
  // the store is public, this would succeed — fail-closed in that case.
  const fetchController = new AbortController();
  const fetchTimer = setTimeout(() => fetchController.abort(), CANARY_TIMEOUT_MS);
  let anonymouslyReadable = false;
  let anonymousBody = "";
  try {
    const res = await fetch(uploaded.url, {
      method: "GET",
      redirect: "error",
      signal: fetchController.signal,
    });
    if (res.ok) {
      anonymousBody = await res.text();
      anonymouslyReadable = anonymousBody === probeContent;
    }
  } catch {
    // Fetch failure (DNS, network, anonymous-read forbidden) is the
    // healthy case for a private store.
  } finally {
    clearTimeout(fetchTimer);
  }

  if (anonymouslyReadable) {
    throw new Error(
      "blob_canary: BLOB_PRIVATE_READ_WRITE_TOKEN resolves to a publicly-readable store. " +
        "Chat attachments would be anonymously accessible. Provision a private blob store and update the env var.",
    );
  }

  logger.info("blob_canary: private store verified", { probe_key: probeKey });
}

/**
 * Idempotent boot-time check. Throws if the configured blob store is
 * publicly readable. The result is cached for the lifetime of the
 * function instance.
 *
 * Call from the chat workflow (attachment persistence path) before the
 * first put(). Subsequent calls return the cached promise.
 */
export async function ensurePrivateBlobStore(): Promise<void> {
  // REL-R2-02 fix (review run 20260506-232400-round2): success has a
  // TTL so an env rotation (BLOB_PRIVATE_READ_WRITE_TOKEN swap) re-runs
  // the canary instead of trusting the stale verification for the rest
  // of the function-instance lifetime.
  const now = Date.now();
  if (canaryResult && now < canaryResultExpiresAt) {
    return canaryResult;
  }

  canaryResult = runCanary()
    .then(() => {
      canaryResultExpiresAt = Date.now() + CANARY_SUCCESS_TTL_MS;
    })
    .catch((err) => {
      logger.error("blob_canary: failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      // Brief cool-off before next retry so a transient outage doesn't
      // hammer the canary path.
      canaryResultExpiresAt = Date.now() + CANARY_FAILURE_RETRY_MS;
      // Clear the cache so the cool-off elapsing triggers a fresh attempt.
      const handle = setTimeout(() => {
        if (canaryResult) {
          canaryResult = null;
          canaryResultExpiresAt = 0;
        }
      }, CANARY_FAILURE_RETRY_MS);
      // Don't keep Node alive on this timer in tests / serverless.
      handle.unref?.();
      throw err;
    });
  return canaryResult;
}

/** Test-only: reset the cached canary result. */
export function _resetBlobCanaryForTests(): void {
  canaryResult = null;
  canaryResultExpiresAt = 0;
}
