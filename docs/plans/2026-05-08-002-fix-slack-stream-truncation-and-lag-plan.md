---
title: "fix: Slack streaming truncates long replies and lags well after the bot finishes"
type: fix
status: draft
date: 2026-05-08
---

# fix: Slack streaming truncates long replies and lags well after the bot finishes

## Summary

For long agent replies (~3–4 KB+), the message rendered in Slack is missing the
tail (cut off mid-sentence, often inside a `**bold**` span) and the streaming UI
keeps "typing" for many seconds after the agent has already produced its full
output. The agent's full text is correct on our side — only the Slack render is
truncated/lagged. This plan diagnoses the pipeline, names the most likely root
causes, and lays out targeted mitigations for the `consumeAndStreamSlack` path.
No code changes here — review of approach first.

---

## Symptom (from the field, 2026-05-08)

A long EU-AI-regulation reply was correctly produced by the runner end-to-end
(captured in transcript), but the Slack message ends with `**Until formally
adopted,` — losing roughly the last 30 % of the reply (multiple paragraphs
including "Practical takeaway", a follow-up question, and the source link).
Concurrently the user reports that streaming continues to "tick" in Slack for a
long time after the agent has finished generating.

---

## Pipeline (current state)

1. Sandbox runner emits per-token `text_delta` NDJSON lines via the per-message
   transcript HTTP endpoint (`includePartialMessages: true` is on for the
   Claude SDK runner — see `src/lib/sandbox.ts:934, 1359`).
2. Inner `dispatchWorkflow` body iterates the WDK hook, dispatches each batch
   into `writeChunkStep` (`src/lib/workflows/dispatch-workflow.ts:194, 685`),
   which writes lines into the workflow's `getWritable<string>()`. Per-line and
   top-level errors are intentionally swallowed (commits `faef716`,
   `d5dd1e8`).
3. Outer `chatDispatchWorkflow.consumeAndPostStep` opens
   `getRun(innerRunId).getReadable<string>()`, parses NDJSON, and on Slack
   yields each `text_delta` string into an `AsyncIterable` that is handed to
   `adapter.stream(threadKey, textStream, { recipientUserId, recipientTeamId })`
   (`src/lib/workflows/chat-dispatch-workflow.ts:476–569`).
4. The Slack adapter pushes each yielded string into a `StreamingMarkdownRenderer`
   (`node_modules/chat/dist/index.js:904–1018`) and computes a delta via
   `getCommittableText()`. The committable prefix is sent to
   `streamer.append({ markdown_text: delta })`. The renderer holds back content
   that has unclosed inline markers (`**`, `_`, `` ` ``, `[`) via
   `findCleanPrefix`.
5. The Slack `ChatStreamer`
   (`node_modules/@slack/web-api/dist/chat-stream.js`) buffers locally and only
   issues a `chat.appendStream` API call when its buffer hits 256 bytes (default
   `buffer_size`) or when structured chunks are passed. On stop it issues
   `chat.stopStream` to flush the residual buffer.
6. Outer step finally clause swaps the 👀 reaction for ✅/❌ and best-effort
   updates `markBotEvent`.

The whole pipeline from step 3 onward runs inside a single WDK step
(`consumeAndPostStep`) on the function instance that started the workflow body.
Default Vercel function `maxDuration` is 300 s; the Slack webhook ingress
function has no override (`vercel.json` sets `supportsCancellation: true` but no
`maxDuration`).

---

## Diagnostic hypotheses

Ranked by likelihood and grouped by symptom. Confirmation steps in `Investigation`.

### Truncation (mid-`**bold**`, last ~30 % missing)

- **H1 — Slack server-side stream timeout closes the stream mid-flight.**
  Slack's `chat.startStream` opens an interactive stream. If our `appendStream`
  cadence is too slow (we serialize ~16+ appends behind a 256-byte buffer plus
  ~200–500 ms each on the wire), Slack may force-close the stream after an
  inactivity / total-duration ceiling. After that, our `appendStream` calls 4xx
  (or are silently no-op'd) and the message is frozen at the last successful
  append. The fact that the cut sits mid-`**` strongly suggests the stream was
  killed in the middle of a token — not a clean boundary the renderer chose.

- **H2 — WDK step / function instance hits `maxDuration` before
  `streamer.stop()` fires.** `consumeAndPostStep` runs the entire iterate +
  append + finalize lifecycle in one step. With no `maxDuration` override on
  `app/api/webhooks/slack/**` we get the platform 300 s default. Long replies
  with structured chunks for tool turns can plausibly cross that under load.
  Symptom matches: stream is in `in_progress`, last partial append is what the
  user sees, finalize never runs.

- **H3 — `streamer.append` throws inside `adapter.stream` and the catch in
  `consumeAndStreamSlack` posts a fallback that the user is *not* seeing
  because they're looking at the streamed message ID, not the new fallback
  message.** Possible but secondary — the user reports a single truncated
  message, not "two messages, one is the fallback". Rule out by log inspection
  of `consumeAndStreamSlack: adapter.stream failed`.

- **H4 — Per-chunk loss inside `writeChunkStep`.** The step swallows
  per-line errors and a top-level catch. If a malformed chunk or a transient
  exception lands in the middle of the stream, those text_deltas never reach
  the readable. The cumulative effect on a 4 KB reply is plausibly the
  observed gap. Less likely to be the sole cause (we'd expect random-position
  drops, not a clean tail loss).

- **H5 — Renderer holdback never released because the agent's final
  `result`/terminal arrives without a closing token sequence the renderer
  recognizes.** The for-await loop `break`s on `evt.type === "result" || evt.kind === "terminal"`,
  the iterator returns, `adapter.stream` calls `renderer.finish()`, then
  flushes the `finalDelta`. If `finalDelta` is large but `streamer.stop()` only
  flushes via one `chat.stopStream` call, this should still work — unless H1
  has already killed the stream by then.

### Lag (streaming "ticks" for many seconds after agent is done)

- **L1 — Sequential `await streamer.append` per text_delta.** Each yielded
  delta string goes through `pushTextAndFlush`, which awaits
  `streamer.append`. When the buffer crosses 256 bytes, that await turns into
  a real API round trip (~200–500 ms). On a 4 KB reply that's ~16 serialized
  API calls, ~3–8 s of wire latency *after* the agent has already produced
  everything. Compounded by renderer holdback rolling content forward in
  fits.

- **L2 — `buffer_size: 256` is too small.** It's the SDK default. We never
  pass `{ buffer_size }` in `client.chatStream(...)` (the adapter doesn't
  expose it). Increasing the buffer to 1024–2048 collapses 16 calls into
  4–8, halving end-of-stream lag with no effect on visible streaming
  smoothness for short replies.

- **L3 — Renderer's `findCleanPrefix` rolls back through every unclosed
  inline marker on every push.** For markdown that contains a lot of bold
  spans inside long lines (the EU-regulation reply has many), the
  committable prefix oscillates: a `**` opens, a chunk arrives without the
  close, the renderer reports a shorter committable, the next chunk closes
  it and the renderer leaps forward. The leap is fine — but the rollback can
  delay tens of bytes per inline marker for the duration of one delta.

---

## Investigation steps (cheap, do these first)

Goal: pin H1 vs H2 vs H4 with logs from one production occurrence — every
mitigation depends on which one we're paying. Order is "easiest first".

1. **Inspect the most recent failing run's WDK events.**
   `npx workflow inspect events -r <chatRunId>` — look at the
   `consumeAndPostStep` step: did it complete? did it hit a retry? did the
   function host get killed? (Per `reference_wdk_inspect_cli.md`, runtime-logs
   MCP truncates ~30 chars; CLI is the only reliable view.)
2. **Search Vercel runtime logs for `consumeAndStreamSlack: adapter.stream
   failed`** during the window of the failing run. Presence rules H3 in;
   absence rules it out.
3. **Search for `writeChunkStep: per-line processing threw` and
   `writeChunkStep: top-level catch`** for the inner run id over the same
   window. Counts > 0 elevate H4.
4. **Compare the runner's transcript blob to what the user saw in Slack.** The
   transcript is captured up to 600 events (excludes text_delta chunks per
   convention). If transcript has the full text and Slack lost the tail, H4 is
   downgraded — transcript serializes the same source the streamer reads.
5. **Add temporary `logger.info` breadcrumbs at three points (debug-only PR,
   revert when diagnosed):**
   - "consumeAndStreamSlack: yielding delta", every Nth delta, with cumulative
     yielded byte count and elapsed-since-step-start.
   - "consumeAndStreamSlack: result/terminal hit", with cumulative yielded
     bytes.
   - "consumeAndStreamSlack: adapter.stream returned" / "throw", with elapsed.
   These three numbers together separate H1 (we yielded everything fast,
   adapter.stream never returned) from H2 (we yielded slowly and the function
   died) from H4 (we never yielded the tail at all).

---

## Plan

Mitigations grouped so each can ship independently. Order favours
"observability + cheap wins → real fix" so we don't blow scope before we know
which hypothesis we're paying.

### Phase 1 — Observability (ship even if nothing else changes)

P1. **Add the three breadcrumb logs** above to `consumeAndStreamSlack`. Tagged
with `inner_run_id`, `tenant_id`, `agent_id`. Gated on
`process.env.SLACK_STREAM_DEBUG === "true"` so we can flip it on for the next
incident without redeploying. Keep the cumulative-byte counter; it's the
single most useful number for diagnosing this class of bug.

P2. **Persist `chat.appendStream` API timings in a debug counter.** Wrap each
`streamer.append` call with `Date.now()` deltas; log p50/p95/total at end of
stream. Tells us whether L1 is dominating before we touch buffer sizing.

P3. **Surface `adapter.stream` errors with the bytes-yielded count + final
streamer state** in the existing
`logger.error("consumeAndStreamSlack: adapter.stream failed", ...)` to
distinguish "stream rejected our append" (Slack 4xx) from "we never finished
yielding" (function host kill).

### Phase 2 — Lag fix (low risk, big perceived win)

P4. **Bump the Slack `ChatStreamer.buffer_size` to 2048 bytes.** The
`@chat-adapter/slack` `stream` method calls `this.client.chatStream({...})`
without passing `buffer_size`. We need either:
  - a fork/local override that constructs the streamer with a larger buffer,
    OR
  - a thin wrapper around `adapter.stream` that bypasses the adapter and uses
    `client.chatStream` directly (we already type the adapter via duck-typing
    so this is reachable without an SDK rev).
Trade-off: bigger buffer = chunkier user-visible "appearing" updates. 2 KB ≈
2–4 short paragraphs per flush, which is still smooth and cuts API call
count by ~8×.

P5. **Coalesce yields in `consumeAndStreamSlack`.** Today every `text_delta`
becomes one yield → one `streamer.append` await. Coalesce up to N ms or N
bytes (whichever first) at the source. Concretely: maintain a small
in-generator buffer that flushes every 80 ms or 200 bytes. Cuts the number of
serial awaits without changing the renderer's holdback semantics.

P6. **Skip `streamer.append` for empty / whitespace-only deltas.** Cheap
defense — the renderer can produce empty deltas when `findCleanPrefix` rolls
content back across a push. We currently still hand them down as zero-byte
appends; they consume an event-loop tick and contribute nothing.

### Phase 3 — Truncation fix (depends on diagnosis)

If H1 is confirmed (Slack closes the stream while we're still appending):

T1. **Cap stream wall-clock duration; rollover to a second message past the
limit.** Mirror the Discord rollover pattern (`maxPerMessage`) but in the
time domain: if the stream has been open for `STREAM_MAX_OPEN_MS` (start with
90 s, lower if Slack's actual ceiling is lower), cleanly `streamer.stop()`
the current stream, post a continuation indicator (or none — Slack threads
naturally collapse adjacent messages), and start a fresh `streamer` with the
remaining tail. Renderer state can be reused; only the `streamTs` resets.

T2. **Pre-emptively flush the renderer at known safe boundaries** (newline +
no open code fence + no open inline marker) so the buffer never accumulates
content that depends on Slack accepting one more append. Reduces the blast
radius of a stream getting frozen.

If H2 is confirmed (function host `maxDuration` kill):

T3. **Set `app/api/webhooks/slack/**` to `maxDuration: 800`** in
`vercel.json` (matches the Discord gateway entry). Cheapest possible fix if
this is the cause; almost no downside.

T4. **Move `consumeAndPostStep` to detached execution** — fire it from
`after()` or as its own queued workflow start so the inbound webhook
function can return 200 within a few hundred ms and the streaming runs on a
separate function instance with its own duration budget. Heavier change,
keep in reserve.

If H4 is confirmed (chunks lost in `writeChunkStep`):

T5. **Add a per-line retry inside `writeChunkStep`** with an explicit
counter — N retries with jitter, then drop with a loud log. Today we drop on
first throw to avoid 5-min WDK retry hangs; a *bounded in-step* retry has the
same blast-radius guarantee but recovers transient failures.

T6. **Make `writeChunkStep` idempotent on chunk boundaries** so a future PR
can re-introduce WDK step-level retry without doubling content. Out of scope
for this fix; note it as the proper long-term shape.

### Phase 4 — Renderer holdback (only if Phases 1–3 don't close the gap)

P7. **Replace the renderer's `findCleanPrefix` rollback with a "release at
last newline" rule on Slack-only.** Slack's mrkdwn tolerates unclosed `**`
and `_` mid-stream — the user just sees `**word` for a tick, then the bold
applies on the next render. That's strictly better than holding 200+ bytes
behind one `**`. Risk: visible flashing of unclosed markers; verify with a
side-by-side test before changing.

---

## Out of scope

- Rewriting the Discord (`consumeAndEditDiscord`) path. The post-then-edit
  loop has its own well-tuned tradeoffs.
- Replacing the `chat` package or its Slack adapter wholesale. Diagnosis-led
  patches preferred.
- Changing the Claude SDK / Vercel AI SDK runner emission cadence. The
  pipeline downstream of the runner is fast enough; the bottleneck is in
  `streamer.append` cadence + Slack-side stream lifecycle.
- Reintroducing WDK-step retries on `writeChunkStep`. See T6 — that's a
  separate plan.

---

## Risks & rollback

- **P4 (buffer_size bump)**: visible "chunkier" streaming. Rollback is a
  one-line revert.
- **P5 (coalesce yields)**: same risk as P4 in the worst case. The 80 ms /
  200 B knobs are tuneable by env var if we want safety.
- **T1 (stream rollover)**: introduces a second message in the thread under
  Slack-stream-timeout conditions. Tradeoff: visible split vs. truncated
  message. We already do this on Discord; the precedent is set.
- **T3 (maxDuration: 800)**: increases per-invocation cost ceiling, no
  observed downside on the Discord path.
- **P7 (renderer rule change)**: brief mid-stream rendering of unclosed
  markers. Rollback is keeping the existing renderer. Gate behind a feature
  flag during the bake.

Each phase is independently revertable. Phase 1 is purely additive logging
and should land first regardless.

---

## Success criteria

- A reproducer for the EU-regulation-length reply renders in Slack with the
  full agent text — no mid-`**bold**` truncation, no missing tail
  paragraphs.
- End-of-stream lag (time between the runner's terminal `result` event and
  the Slack message reaching its final state) drops below 1.5 s p95 for
  4 KB replies, down from the current multi-second tail.
- No regression in short-reply UX (sub-1 KB replies stay smooth, no
  visibly-chunkier stream after P4 / P5).
- `consumeAndStreamSlack: adapter.stream failed` log volume stays at or
  below the current baseline (we don't trade truncation for new failure
  modes).

---

## Open questions

1. What's the actual Slack server-side ceiling for an open
   `chat.startStream`? Slack docs are vague; we may need to file a support
   ticket or empirically bisect.
2. Is the inner-readable `getReadable({ startIndex })` reliable enough to
   make `consumeAndPostStep` resumable across function-host crashes? If yes,
   T4 becomes much cheaper.
3. Does the Vercel AI SDK runner emit at a different `text_delta` cadence
   than the Claude SDK? If so, the L1 tuning may need per-runner knobs.
