---
module: src/lib/workflows/dispatch-workflow.ts
date: 2026-05-07
problem_type: logic_error
component: service_object
severity: high
symptoms:
  - "fetch() resolves quickly (response headers received) but arrayBuffer() hangs on slow body"
  - "Request appears to time out at platform maxDuration instead of the AbortController's bound"
  - "clearTimeout fires before the body is consumed; signal stops bounding the operation"
  - "Slow-streaming server can pin a function instance for minutes despite a 30s timeout"
root_cause: async_timing
resolution_type: code_fix
tags:
  - aborcontroller
  - settimeout
  - fetch
  - arraybuffer
  - body-download
  - timeout
---

# AbortController spanning fetch() AND arrayBuffer() — body download must be inside the timeout

## Problem

A common timeout pattern wraps `fetch()` with `AbortController`, calls `clearTimeout` after the fetch resolves, and then calls `response.arrayBuffer()` (or `.text()`, `.json()`) to consume the body. The bug: `fetch()` resolves as soon as response headers arrive, NOT when the body finishes downloading. `clearTimeout` runs before the body is consumed. The `AbortController` no longer bounds anything. A slow-streaming server then pins the function instance for as long as it can stream, up to the platform's `maxDuration` ceiling.

## Symptoms

- Function timeouts at `maxDuration` (e.g. 300s on Vercel) when the AbortController was set to 30s.
- Slow-streaming server can drag out a request that the timeout was meant to bound.
- `clearTimeout` fires before any body bytes are read.
- Reviewer trace: "the AbortController signal cancels both the fetch AND the body download — but only if the timeout is still alive when the body is being consumed."

## What Didn't Work

The naive `try { fetch } finally { clearTimeout }` pattern. `clearTimeout` is the deactivation point; once it runs, the AbortController's signal will never fire, even though the body consumption is still ahead.

```ts
// BUG — clearTimeout deactivates the timeout before arrayBuffer() runs
const ctl = new AbortController();
const tm = setTimeout(() => ctl.abort(), 30_000);
let res: Response;
try {
  res = await fetch(url, { signal: ctl.signal });
} finally {
  clearTimeout(tm);  // ← timeout disarmed here
}
const ab = await res.arrayBuffer();  // ← but body still downloading; no longer bounded
```

## Solution

Move `clearTimeout` to AFTER the body is consumed. The `signal` propagates through `fetch()` to the underlying response stream, so an `abort()` while `arrayBuffer()` is reading cancels the stream.

```ts
const ctl = new AbortController();
const tm = setTimeout(() => ctl.abort(), 30_000);
try {
  const res = await fetch(url, { signal: ctl.signal });
  if (!res.ok) throw new Error(`http_${res.status}`);
  const ab = await res.arrayBuffer();
  // ... use ab ...
} finally {
  clearTimeout(tm);  // ← timeout active across BOTH fetch AND arrayBuffer
}
```

## Why This Works

`fetch()` resolves when the server sends the response status + headers — typically the first packet. The body arrives as a stream backed by the response's `ReadableStream`. The `AbortController.signal` is plumbed through both: aborting cancels the headers-pending fetch (if not yet resolved) AND cancels the response body's ReadableStream (if mid-consumption). Both cancellation points share the same signal.

By keeping `clearTimeout` past the body read, the timeout's `abort()` call remains armed for the entire duration of the operation. A slow-streaming server stops draining bytes when the signal fires, the body read rejects with `AbortError`, and the `finally` clears the timer.

## Prevention

- **Rule of thumb**: when wrapping `fetch()` with an AbortController, the `clearTimeout` (or signal-deactivation) must be the LAST thing that runs after every body-consuming await. If the response is consumed in 3 places (`.text()`, `.json()`, manual stream read), the timer covers all 3.
- **Pattern**: prefer a single `try { ...fetch + body... } finally { clearTimeout }` block over splitting fetch and body into separate try blocks.
- **Audit**: grep for `clearTimeout` immediately after `await fetch(`. If the body is consumed AFTER, that's the bug.
- **Type hint**: `Response.body` is a `ReadableStream` and a slow stream can outlive headers indefinitely. Treat fetch() response as "headers ready" not "request done."

## Concrete instance

In `src/lib/workflows/dispatch-workflow.ts`, both the warm-reconnect and cold-start paths for `preInjectFiles` fetched signed URLs and consumed the body via `arrayBuffer()`. Round-3 review flagged `clearTimeout(tm)` running between the fetch and the arrayBuffer in BOTH paths. A slow signed-URL server (Vercel Blob, signed-URL HTTPS) could drag the body download past the 30s budget and into the function's `maxDuration` ceiling.

Round-4 fix: moved `clearTimeout` to after `arrayBuffer()` in both warm and cold paths. The 30s now bounds the entire operation including body download, not just the headers.

## References

- **Reference implementation:** `src/lib/workflows/dispatch-workflow.ts` — `preInjectFiles` warm and cold paths
- **Origin commit:** `413a38e` — round-4 review #5 fix
- **Related learning:** `conventions/probe-based-mock-for-transactional-callbacks-2026-05-07.md` (unrelated topic, same review batch)
