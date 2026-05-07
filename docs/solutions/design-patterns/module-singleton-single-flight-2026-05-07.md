---
module: src/lib/platform/blob-canary.ts
date: 2026-05-07
problem_type: design_pattern
component: service_object
severity: medium
applies_when:
  - "Module-level idempotent operation that's expensive (network call, canary upload, schema check)"
  - "Multiple concurrent callers should share the result of a single in-flight execution"
  - "Both success TTL and brief failure cool-off are needed (don't hammer on transient errors)"
  - "The function instance is the lifetime — process recycles between"
related_components:
  - service_object
tags:
  - single-flight
  - module-singleton
  - in-flight-promise
  - canary
  - ttl-cache
  - cool-off
---

# Module-singleton single-flight pattern

## Context

Some module-level operations are expensive, idempotent, and need to run before the module's primary functionality is safe to use. The Vercel Blob private-store canary is the canonical instance: every chat-attachment upload must verify (once per function-instance lifetime) that `BLOB_PRIVATE_READ_WRITE_TOKEN` actually points at a private store. The check uploads a probe object and tries to fetch it anonymously; success means the store is misconfigured (publicly readable) and the module must fail closed.

Naive invocations from multiple concurrent callers would each run the full canary independently — wasted uploads, wasted fetches, race-conditional state on the cached result. The pattern: single-flight the in-flight Promise so concurrent callers share one execution. Cache success for a TTL; cache failure for a shorter cool-off.

## Guidance

### State

```ts
let canaryResult: Promise<void> | null = null;
let canaryResultExpiresAt = 0;

const CANARY_SUCCESS_TTL_MS = 60 * 60 * 1000;   // 1h
const CANARY_FAILURE_RETRY_MS = 60_000;          // 1m cool-off
```

### The single-flight check

```ts
export async function ensurePrivateBlobStore(): Promise<void> {
  const now = Date.now();
  // Single-flight: in-flight (expiresAt === 0) AND completed-and-cached.
  // Returns the existing Promise if either case holds.
  if (canaryResult && (canaryResultExpiresAt === 0 || now < canaryResultExpiresAt)) {
    return canaryResult;
  }

  canaryResult = runCanary()
    .then(() => {
      canaryResultExpiresAt = Date.now() + CANARY_SUCCESS_TTL_MS;
    })
    .catch((err) => {
      logger.error("blob_canary: failed", { error: ... });
      canaryResultExpiresAt = Date.now() + CANARY_FAILURE_RETRY_MS;
      const handle = setTimeout(() => {
        // After cool-off, clear the cache so the NEXT caller re-runs.
        if (canaryResult) {
          canaryResult = null;
          canaryResultExpiresAt = 0;
        }
      }, CANARY_FAILURE_RETRY_MS);
      handle.unref?.();  // don't keep Node alive on this timer
      throw err;
    });
  return canaryResult;
}
```

### Three rules

**Rule 1.** The `canaryResult` Promise is the single-flight handle. Concurrent callers all `await` the same Promise. First success caches the resolution; first failure caches the rejection.

**Rule 2.** `canaryResultExpiresAt === 0` means "in-flight" (the Promise hasn't resolved yet, so we haven't set the TTL). The check `expiresAt === 0 || now < expiresAt` correctly returns the Promise while in-flight (concurrent callers join the existing run) AND while cached (subsequent calls within TTL skip the work).

**Rule 3.** Failure path: cache the rejection for a short cool-off. Schedule a clear so the next call AFTER the cool-off re-runs. `handle.unref?.()` ensures the timer doesn't keep the function instance alive in tests or serverless.

## Why This Matters

The naive shape is two pieces of state racing each other:

```ts
// BUG — concurrent callers each schedule their own canary
let cachedResult: Promise<void> | null = null;

export async function ensurePrivateBlobStore() {
  if (cachedResult) return cachedResult;
  cachedResult = runCanary();   // ← if two callers reach here simultaneously,
  return cachedResult;          //   the second's assignment overwrites the first
}
```

The single-flight Promise is the deduplication primitive. Every state transition (in-flight → success, in-flight → failure → cool-off → cleared) is reachable through the Promise's lifecycle, so concurrent callers always observe a consistent view.

The success-TTL + failure-cool-off split matters operationally: success is rare and expensive to repeat (canary upload is ~100ms + an anonymous fetch); failure is also expensive but typically transient (Blob temporarily unavailable). A 1h success TTL absorbs the 99% case where the deploy is healthy. A 60s failure cool-off lets a brief outage clear without hammering the canary path or pinning function instances on serial retries.

## When to Apply

Use module-singleton single-flight when:

- An operation is expensive AND idempotent.
- Concurrent callers can safely share one result.
- The result has a meaningful TTL (long enough to amortize cost; short enough to detect config rotation).
- Failure should briefly back off but not permanently cache.

Don't use:

- For per-call state (each call needs its own answer) — just `await` the operation each time.
- For state that must be tenant-scoped — module singletons aren't tenant-aware.
- For shared state across function instances — Vercel functions are isolated; module singletons are per-instance only.

## Examples

### BEFORE — racy

```ts
let cached: Promise<void> | null = null;
export async function ensurePrivateBlobStore() {
  if (cached) return cached;
  cached = runCanary();
  return cached;
}
```

Two concurrent callers can both pass the `if (cached)` check (because both see `null` before the first assignment commits to memory in some runtimes), then both run `runCanary()`, then both assign — second overwrites first. The first caller is awaiting an orphan Promise.

### AFTER — single-flight + TTL + cool-off

```ts
let canaryResult: Promise<void> | null = null;
let canaryResultExpiresAt = 0;

const CANARY_SUCCESS_TTL_MS = 60 * 60 * 1000;
const CANARY_FAILURE_RETRY_MS = 60_000;

export async function ensurePrivateBlobStore() {
  const now = Date.now();
  if (canaryResult && (canaryResultExpiresAt === 0 || now < canaryResultExpiresAt)) {
    return canaryResult;  // in-flight OR within success TTL OR within failure cool-off
  }
  canaryResult = runCanary()
    .then(() => { canaryResultExpiresAt = Date.now() + CANARY_SUCCESS_TTL_MS; })
    .catch((err) => {
      canaryResultExpiresAt = Date.now() + CANARY_FAILURE_RETRY_MS;
      const handle = setTimeout(() => {
        if (canaryResult) { canaryResult = null; canaryResultExpiresAt = 0; }
      }, CANARY_FAILURE_RETRY_MS);
      handle.unref?.();
      throw err;
    });
  return canaryResult;
}
```

### Test-only escape hatch

For deterministic testing, expose a reset:

```ts
export function _resetBlobCanaryForTests(): void {
  canaryResult = null;
  canaryResultExpiresAt = 0;
}
```

Underscore prefix signals "tests only." Call from `beforeEach` to isolate cases.

## References

- **Reference implementation:** `src/lib/platform/blob-canary.ts`
- **Origin commits:**
  - `2db6aa7` — round-2: introduced the canary with naive caching (REL-R2-02 baseline)
  - `f19f1a3` — round-3: added TTL + failure-cool-off + handle.unref (REL-R2-02 fix)
  - `82cbf49` — round-6: refined in-flight detection (`canaryResultExpiresAt === 0`) to prevent double-runs during cold start
