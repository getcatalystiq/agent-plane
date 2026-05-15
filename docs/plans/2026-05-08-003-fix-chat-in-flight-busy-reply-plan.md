---
title: "fix: post a busy reply when a chat dispatch hits the per-session in-flight cap"
type: fix
status: active
date: 2026-05-08
---

# fix: post a busy reply when a chat dispatch hits the per-session in-flight cap

## Summary

When a Slack/Discord user sends a second message in the same thread while the first is still running, the dispatcher correctly rejects the second via the per-session in-flight cap of 1 (`ConcurrencyLimitError` at `src/lib/dispatcher.ts:562`). Today the chat workflow's `startInnerDispatchStep` catches every error generically, logs, and returns `{kind: "abandoned"}` — the user's second message vanishes silently. This plan distinguishes `ConcurrencyLimitError` from generic failures and posts a short, friendly busy reply ("Still working on your last message — one moment.") in the same thread before abandoning. Reuses the existing `postBusyReplyStep` infrastructure by extending its `which` parameter to a third variant.

---

## Requirements

- R1. When `startInnerDispatchStep` catches a `ConcurrencyLimitError`, post one user-visible message in the same thread explaining the bot is still working on the previous message.
- R2. Other thrown errors continue to take the existing `markBotErrorStep` + abandoned path — no behavior change for them.
- R3. The busy-reply post must NOT throw out of the step. A platform 4xx/5xx logs and falls through; the step still returns `{kind: "abandoned"}`. (Throwing would re-introduce the WDK retry storm the existing comment at `chat-dispatch-workflow.ts:905-914` was written to prevent.)
- R4. The busy reply fires exactly once per inbound chat event that hits the in-flight cap. No duplicate posts on WDK retry.
- R5. The detection is type-safe (`instanceof ConcurrencyLimitError`), not string-matching, so future error-message wording changes don't silently break the gate.
- R6. Pure helper `classifyDispatchFailure(err)` is unit-testable in isolation — the body-level integration of `startInnerDispatchStep` stays out of unit-test scope per the existing convention in `tests/unit/workflows/chat-dispatch-workflow.test.ts` ("body has a giant mock surface where unit testing tends to assert mock plumbing rather than real behavior").

---

## Scope Boundaries

- **No queueing of the second message.** The user's second message is acknowledged with the busy reply and then dropped. Actually queueing + dispatching after the first completes (option 1 from the prior conversation) is a larger design change and is out of scope here.
- **No suppression of the typing indicator.** The "Thinking…" status set by `fireReceiptAckEarly` clears naturally when the first message's response posts. Leaving it in place during the busy reply is acceptable.
- **No dedup/cooldown of repeated busy replies.** If the user sends 5 messages in 5 seconds, they get 5 busy replies. That's the same shape as today's repeated-failure noise tolerance — operators want signal, not silence.
- **No changes to `markBotErrorStep`.** Generic-error path is untouched.
- **No changes to `dispatcher.ts:562`.** The throw site, error class, and message stay as-is.

---

## Context & Research

### Relevant Code and Patterns

- `src/lib/workflows/chat-dispatch-workflow.ts:898-929` — `startInnerDispatchStep`'s catch block; the change site.
- `src/lib/workflows/chat-dispatch-workflow.ts:1430-1448` — `postBusyReplyStep`, the existing helper to extend.
- `src/lib/workflows/chat-dispatch-workflow.ts:135-138` — current call site of `postBusyReplyStep` for the rate-limited path; reference for invocation shape.
- `src/lib/errors.ts:45-49` — `ConcurrencyLimitError` definition. Extends `AppError`, code `concurrency_limit`, status 429.
- `src/lib/dispatcher.ts:562` — sole throw site for the in-flight conflict. Message string is "ContextId session has an in-flight message".
- `src/lib/platform/bridge.ts:140-155` — `fireReceiptAckEarly` documents the typing indicator vs reaction split. The "Thinking…" is `assistant.threads.setStatus`-shaped (transient typing indicator), NOT a posted message that could be edited in place.
- `tests/unit/workflows/chat-dispatch-workflow.test.ts` — testing convention: pure helpers get unit coverage, the workflow body is intentionally not unit-tested.

### Institutional Learnings

- The existing comment at `chat-dispatch-workflow.ts:905-914` is the load-bearing constraint: a thrown error in `startInnerDispatchStep` triggers WDK auto-retry, which production traces showed adding 1-3 minutes of latency per chat run. Any new code path inside this catch must preserve the no-throw posture.
- `docs/runbooks/chat-platform-bots.md` covers the chat ingress flow but does NOT yet have a section on user-experience around the in-flight cap — adding a one-paragraph note is part of U2.

### External References

- None needed. Slack/Discord posting primitives are already wired through `postOrEdit` and `resolveCachedBot` in `chat-dispatch-workflow.ts`.

---

## Key Technical Decisions

- **Reuse `postBusyReplyStep`, don't add a sibling step.** The signature already takes a `which` discriminant; extending it to `"agent" | "user" | "in_flight"` is one new branch in the message-string switch. The dispatch path (`resolveCachedBot` → `postOrEdit` → swallowed errors) is identical for all three.
- **Pure classifier helper for type narrowing.** Extract `classifyDispatchFailure(err: unknown): "in_flight" | "other"` as a non-step pure function in `chat-dispatch-workflow.ts` (not a separate file — single-call site, low gravity). Unit-testable; the catch block becomes a one-liner switch.
- **`instanceof ConcurrencyLimitError`, not message-string match.** The throw site at `dispatcher.ts:562` is the only producer of this specific error in the chat dispatch path, and the class is exported. Future wording changes to the message don't break the gate.
- **No dedup against the dedupe table.** WDK retry safety lives in the existing dedupe-row idempotency: `bridgeClaimed=true` means the bridge already owns the chat_event_dedupe row; a WDK retry of `startInnerDispatchStep` re-enters with the same `bridgeClaimed=true`, the same `reserveSessionAndMessage` call still throws `ConcurrencyLimitError` (the inner session is still active), and the catch fires the busy reply again. To prevent that double-post, the catch sets a guard column on the dedupe row before posting — only one retry can win the post. **Decision deferred** — see Open Questions; first pass uses the simpler "best-effort, may double-post on retry" posture and we tighten only if production traces show it.
- **Keep the message short and human.** Wording: `"Still working on your last message — one moment."` Friendly, not error-toned, parallels the rate-limited replies' tone.

---

## Open Questions

### Resolved During Planning

- **Edit the bridge's "Thinking…" placeholder vs post a new message?** Post a new message. The "Thinking…" is a typing-indicator status (Slack `assistant.threads.setStatus`), not a posted message, so there's nothing to edit. Confirmed via `src/lib/platform/bridge.ts:140-155` and the comment at `chat-dispatch-workflow.ts:436`.
- **Reuse `postBusyReplyStep` or sibling?** Reuse — extend the `which` discriminant.
- **Wording.** "Still working on your last message — one moment." (see Key Technical Decisions).
- **Detection method.** `instanceof ConcurrencyLimitError`.

### Deferred to Implementation

- **Whether to add a dedupe-row guard against double-posting on WDK retry.** Today's catch returns `{kind: "abandoned"}`, which the workflow body treats as a clean exit (no retry trigger). In practice the only way to double-post is if the catch itself runs twice, which would only happen if WDK retried the step *despite* the abandoned return — a contract WDK shouldn't violate. Implementation should verify this in `workflow inspect events` traces against a live in-flight collision before adding a guard. If verified safe, no guard needed; if a double-post is observed, add a `posted_busy_reply_at` column or reuse an existing dedupe-row column as the gate.

---

## Implementation Units

### U1. Extend `postBusyReplyStep` with an "in_flight" variant + pure classifier

**Goal:** Make the busy-reply step capable of posting an in-flight-collision message, and provide a unit-testable classifier that maps caught errors to the right routing decision.

**Requirements:** R1, R3, R5, R6

**Dependencies:** None

**Files:**
- Modify: `src/lib/workflows/chat-dispatch-workflow.ts`
- Test: `tests/unit/workflows/chat-dispatch-workflow.test.ts`

**Approach:**
- Widen `postBusyReplyStep`'s `which` parameter from `"agent" | "user"` to `"agent" | "user" | "in_flight"`.
- Add the new branch to the `text` switch with the wording from Key Technical Decisions.
- Leave the `try { resolveCachedBot → postOrEdit } catch { logger.warn }` body unchanged. The new variant inherits the same swallow-and-log error posture (R3).
- Add a non-step pure helper `classifyDispatchFailure(err: unknown): "in_flight" | "other"` to the same file, near the other utility helpers. Returns `"in_flight"` iff `err instanceof ConcurrencyLimitError`. Anything else returns `"other"`.
- Export `classifyDispatchFailure` for unit testing (or co-locate the test in the same file with `vi.mock` of imports — the existing test file already imports internals).

**Patterns to follow:**
- `src/lib/workflows/chat-dispatch-workflow.ts:1430-1448` — exact shape of the step we're extending.
- `tests/unit/workflows/chat-dispatch-workflow.test.ts` — pure-helper unit-test pattern (see `parseNdjsonLine` coverage at the top of the file).

**Test scenarios:**
- Happy path: `classifyDispatchFailure(new ConcurrencyLimitError("ContextId session has an in-flight message"))` returns `"in_flight"`. *Covers R5.*
- Edge case: `classifyDispatchFailure(new ConcurrencyLimitError())` (no-arg / default message) still returns `"in_flight"` — proves we're not message-matching.
- Error path: `classifyDispatchFailure(new Error("anything else"))` returns `"other"`.
- Error path: `classifyDispatchFailure(new BudgetExceededError())` returns `"other"` — proves we don't false-positive on adjacent `AppError` subclasses.
- Edge case: `classifyDispatchFailure(undefined)` and `classifyDispatchFailure("a string")` return `"other"` — non-Error inputs from `unknown` typing.

**Verification:**
- All test scenarios pass under `npm run test`.
- `postBusyReplyStep` remains importable / type-checks against existing call sites (the rate-limited path still passes `"agent"` or `"user"`).

---

### U2. Route `ConcurrencyLimitError` to the busy-reply branch in `startInnerDispatchStep`'s catch

**Goal:** Wire the classifier and the new busy-reply variant together — the catch block that today only logs-and-abandons now posts a busy reply on the in-flight branch before abandoning.

**Requirements:** R1, R2, R3, R4

**Dependencies:** U1

**Files:**
- Modify: `src/lib/workflows/chat-dispatch-workflow.ts` (the catch at lines 915-929)
- Modify: `docs/runbooks/chat-platform-bots.md` (one-paragraph note about the busy-reply UX)

**Approach:**
- Inside the catch, classify the error via `classifyDispatchFailure(err)`. On `"in_flight"`: `await postBusyReplyStep(input, "in_flight")` (the await is fine — `postBusyReplyStep` already swallows its own errors per R3).
- On `"other"`: keep today's behavior — log and return `{kind: "abandoned"}`. Note: today's catch does NOT call `markBotErrorStep`; that's the workflow body's responsibility one level up. We don't change that.
- The `logger.error` call stays for both branches but its `error_name` / `error` fields already capture the class — no extra fields needed.
- Add a 1-2 sentence note to `docs/runbooks/chat-platform-bots.md` describing the in-flight UX: what users see, why we don't queue, and where the wording lives. Section under existing operator-facing notes; not a new top-level heading.

**Patterns to follow:**
- The existing catch at `chat-dispatch-workflow.ts:917-928` (the wrapping is preserved; only the branch logic changes).
- The rate-limited call site at `chat-dispatch-workflow.ts:135-138` (same `await postBusyReplyStep(input, ...)` shape).

**Test scenarios:**
- Test expectation: none — the catch block lives inside `startInnerDispatchStep` which is intentionally outside unit-test scope per the convention documented in `tests/unit/workflows/chat-dispatch-workflow.test.ts` ("body has a giant mock surface where unit testing tends to assert mock plumbing rather than real behavior"). Behavior is verified manually via the Verification section below; the classifier coverage in U1 is the unit-level proof.

**Verification:**
- `npm run test` and `npm run build` both clean.
- Manual Slack smoke: configure a slow agent (e.g., one that takes 30+ seconds to respond), send msg1 in a thread, send msg2 within ~5 seconds, observe:
  1. msg1 receives the normal 👀 + final reply.
  2. msg2 receives the 👀 + a busy-reply post ("Still working on your last message — one moment.") in the same thread.
  3. No `markBotErrorStep` is called (no error indicator on the bot status).
  4. After msg1 completes, msg2 does NOT also get a real reply (this confirms it's the "drop after busy reply" behavior, not accidental queueing).
- `workflow inspect events -r <runId>` for msg2 shows the catch fired, the busy reply posted, and the run ended cleanly with no WDK retry.
- Error path smoke: force a non-ConcurrencyLimitError throw inside `startInnerDispatchStepBody` (e.g., temporarily wrap `reserveSessionAndMessage` to throw a TypeError); confirm today's behavior is preserved — log loudly, abandoned, no busy reply posted.

---

## System-Wide Impact

- **Interaction graph:** the catch block now calls `postBusyReplyStep` → `resolveCachedBot` (cached, fast) → `postOrEdit` (network call to Slack/Discord). Same dispatch path the rate-limited branch already uses; no new external surface.
- **Error propagation:** `postBusyReplyStep` swallows its own errors; the catch in `startInnerDispatchStep` continues to return `{kind: "abandoned"}` regardless of the busy-reply outcome. WDK never sees a throw from this branch.
- **State lifecycle risks:** none — no DB writes added in the catch path. The dedupe row, session row, and message row are all untouched by this change. The user's second message is still abandoned at the dispatcher level.
- **API surface parity:** none — the public REST and A2A surfaces don't go through `startInnerDispatchStep`; this catch is chat-specific.
- **Integration coverage:** the manual Slack smoke in U2's Verification is the integration test. No unit-level integration coverage warranted given the file's existing convention.
- **Unchanged invariants:**
  - Per-session in-flight cap of 1 stays. No queueing is added.
  - `dispatcher.ts:562` throw site, message, and class are unchanged.
  - `markBotErrorStep` still fires for non-`ConcurrencyLimitError` failures via the workflow body's own catch (`chat-dispatch-workflow.ts:155-165`) — this plan only touches the step-level catch.
  - WDK retry posture: `startInnerDispatchStep` continues to never throw; the no-retry guarantee stays intact.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| WDK re-runs the step despite the abandoned return, double-posting the busy reply. | First pass tolerates the rare double-post (R4 says "exactly once per inbound chat event"; in practice WDK respects abandoned returns). If production traces show double-posts, add the dedupe-row guard described in Open Questions / Deferred. |
| `postOrEdit` blocks for >3-5 seconds and degrades the step's wall-clock latency. | `postBusyReplyStep` already has implicit per-call timeout via the platform adapter; same posture as the rate-limited path. No new SLA risk vs. that already-shipped code path. |
| The wording sounds robotic or curt. | Wording is in one place (`postBusyReplyStep`'s switch); easy to tune from operator feedback after rollout. |
| A future contributor adds a new throw inside `startInnerDispatchStepBody` that's structurally similar to `ConcurrencyLimitError` and expects busy-reply UX without explicitly opting in. | The classifier is `instanceof ConcurrencyLimitError`-only; new error classes default to "other". Adding future variants is a one-line change in the classifier with a paired test. |
| User sends N messages rapidly → N busy replies → channel spam. | Acceptable per scope: operators want signal, not silence. If real users complain, revisit with a 30-second per-thread cooldown on busy replies (separate plan). |

---

## Documentation / Operational Notes

- One-paragraph addition to `docs/runbooks/chat-platform-bots.md`: under the existing chat-flow notes, document the in-flight-cap UX (user sends two messages in one thread, second receives a busy reply, second is dropped at the dispatcher). Operators encountering complaints should know this is by-design rather than a bug.
- No new monitoring required. Existing `startInnerDispatchStep: caught — returning abandoned` log line continues to fire; an operator searching for "ContextId session has an in-flight" already sees the signal. The new busy-reply POST is best-effort and uninteresting to alert on.
- No migration, env var, or feature flag.

---

## Sources & References

- Throw site: `src/lib/dispatcher.ts:562`
- Catch site: `src/lib/workflows/chat-dispatch-workflow.ts:898-929`
- Helper to extend: `src/lib/workflows/chat-dispatch-workflow.ts:1430-1448`
- Bridge typing-indicator (not a placeholder message): `src/lib/platform/bridge.ts:140-155`
- Error class: `src/lib/errors.ts:45-49`
- Test convention: `tests/unit/workflows/chat-dispatch-workflow.test.ts` header comment
- Related runbook: `docs/runbooks/chat-platform-bots.md`
