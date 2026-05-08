---
module: src/lib/workflows/chat-dispatch-workflow.ts
date: 2026-05-08
problem_type: architecture_pattern
component: workflow
severity: high
applies_when:
  - "A WDK step needs to run for longer than the function host's per-invocation cap"
  - "The step consumes a stream produced by a sibling workflow's getReadable()"
  - "The orchestrating workflow body can serialize a small POJO of state across step boundaries"
  - "External side effects (Slack chat.startStream, Discord post/edit) tolerate visible seams between steps OR can thread per-iteration state to stay continuous"
related_components:
  - background_job
  - service_object
tags:
  - wdk
  - workflow
  - bounded-iteration
  - state-serialization
  - function-host-timeout
  - getReadable
  - replay-determinism
---

# Bounded consume steps in a workflow-body loop

## Context

Chat reply consumption in `chatDispatchWorkflow` reads NDJSON events
from the inner `dispatchWorkflow`'s `getReadable()` stream and posts
them to Slack/Discord. Pre-fix the entire consume ran inside one
`"use step"` invocation that lived for the full duration of the agent
reply.

In production we observed three independent runs of `consumeAndPostStep`
dying at exactly **120.52 seconds** (1.05% variance). The function
returned with `attempt: 1, status: completed` — no WDK retry, no
error log surfacing — yet the user-visible Slack reply was silently
truncated mid-token, and the inner dispatch workflow then churned
**12+ minutes more** producing transcript bytes the user never saw.

Vercel's queue HTTP callback path appears to enforce a request
timeout independent of `maxDuration` ([vercel/workflow#1483](https://github.com/vercel/workflow/issues/1483)
captures the same shape from another angle). On Pro Fluid the
documented function `maxDuration` is 800s; the empirical wall on
queue-callbacks is closer to 120s. Whatever the exact source, **no
single step in this codebase can rely on >120s of execution**.

## Pattern: workflow-body loop driving bounded sub-steps

Replace the single long-running step with a workflow-body **loop**
that calls a bounded sub-step many times. Each invocation:

1. Reads `getReadable({ startIndex })` from the prior iteration's
   `nextIndex`.
2. Iterates events for at most `CONSUME_STEP_DEADLINE_MS` (60s).
3. Returns a **serializable** `{ nextIndex, state, done, sawTerminal }`.

The body re-invokes until `done`. Workflow bodies have no
per-function timeout — they're bounded only by the WDK 4-hour run
TTL and the 240s replay-timeout per resumption ([vercel/workflow
constants.js](../../node_modules/@workflow/core/dist/runtime/constants.js)).

```ts
// "use workflow" body
let consumeIndex = 0;
let consumeState = initialChatConsumeState();
let consumeDone = false;
let sawTerminal = false;

while (!consumeDone) {
  const result: ChatConsumeStepResult = await consumeAndPostStep(
    input, innerRunId, isOrphan, consumeIndex, consumeState,
  );
  consumeState = result.state;
  consumeIndex = result.nextIndex;
  consumeDone = result.done;
  sawTerminal = result.sawTerminal;
}
```

```ts
// "use step" body (one bounded iteration)
const deadline = Date.now() + CONSUME_STEP_DEADLINE_MS;
let exitedDueToBudget = false;
let nextIndex = startIndex;

const readable = getRun(innerRunId).getReadable({ startIndex });
const reader = readable.getReader();

while (true) {
  if (Date.now() > deadline) {
    exitedDueToBudget = true;
    break;
  }
  const { value, done } = await reader.read();
  if (done) break;
  nextIndex += 1;
  // ... process event, post to Slack/Discord ...
}

const done = sawTerminal || earlyReturn || !exitedDueToBudget;
return { nextIndex, state: updatedState, done, sawTerminal };
```

## Critical invariants (each one bit us in review)

### 1. Set `exitedDueToBudget` IN-loop at every break site, not post-loop

**Bug pattern caught in code review #1 (cross-flagged by 3 reviewers):**
the Discord variant of this loop had two break sites (wall-clock
deadline + read-quiet timeout) but recomputed budget-exit *post-loop*
as `Date.now() > deadline`. The recomputation was FALSE on the
quiet-timeout exit because the wall-clock deadline hadn't elapsed
yet. Result: `done = !exitedDueToBudget = true`, body exits the
loop, cancel guard fires, **inner run killed mid-thought** — the
exact bug the bounded-consume refactor was meant to fix.

Set the flag in-loop at *every* break site:

```ts
if (Date.now() > deadline)               { exitedDueToBudget = true; break; }
if (Date.now() - lastReadAt > QUIET_MS)  { exitedDueToBudget = true; break; }
```

A discriminated-union `exitReason: 'deadline' | 'quiet' | 'terminal' | 'agent_error' | 'natural_end'` would make this impossible to get wrong — adopt when the next refactor lands.

### 2. State must be JSON-serializable

WDK serializes step inputs and outputs through its event log. Maps
and Sets do not survive the round-trip; convert at the boundary:

```ts
const toolTitleById = new Map(Object.entries(state.toolTitles));   // hydrate
const openToolIds   = new Set(state.openToolIds);                  // hydrate
// ... mutate ...
return {
  state: {
    ...state,
    toolTitles: Object.fromEntries(toolTitleById),                 // freeze
    openToolIds: [...openToolIds],                                 // freeze
  },
  ...
};
```

Validate the round-trip in tests. JSON.parse(JSON.stringify(state))
must equal `state` for any state your iteration could produce.

### 3. Post-stream guards run ONCE per reply, not once per iteration

Things like "swap 👀 for ✅", "fire markBotError if sawAgentError",
"post empty-readable banner if no text emitted", and "sweep
openToolIds to status:complete" must NOT fire on every iteration.
Pre-fix, the consume step's `finally` block ran them on each call.
With the body-loop, that produced ~14 markBotEvent writes and ~14
reaction swaps for a 14-minute reply.

**Pattern:** gate post-stream guards on `done && sawTerminal`, then
move "always-runs-once-at-end" effects (reaction swap, markBotEvent)
into a separate `finalizeChatDeliveryStep` that the body calls after
the loop terminates.

### 4. openToolIds sweep only on terminal, not on deadline exit

The sweep marks every still-`in_progress` tool_use as `status: complete`
so Slack's StreamingPlan UI doesn't render stale red ⚠️ icons. On
a deadline-driven exit you want the open ids to **carry forward**
in `state.openToolIds` so a tool_result arriving in the next
iteration can still close the matching task_update. Sweeping on
deadline marks every in-flight tool complete, then the SDK re-emits
`tool_use` and the task re-opens — visible flicker.

### 5. Each Slack iteration opens a fresh chat.startStream

This is the visible UX trade-off: the user sees one new Slack message
per ~60s of agent reply (the natural step boundary). The slack-streamer
already had a 90s soft-cap rollover; we're just making seams ~33% more
frequent. **Tune the quiet timeout above typical thinking-pause length**
(45s default) so a normal pause doesn't bounce iterations and
multiply seams.

Discord stays as one growing message because `state.messageId`
threads across iterations and the post-then-edit loop reuses it.

### 6. Anti-retry posture in the step's outer try/catch

Per the existing learning at
`docs/solutions/architecture-patterns/sentinel-returns-vs-throws-in-wdk-steps-2026-05-07.md`,
each step body wraps its work in try/catch and returns a sentinel
`{ done: true, sawTerminal: false }` instead of throwing. Throwing
triggers WDK auto-retry with multi-minute backoff, which on the
chat path means the user waits in dead air. Catch + log + return
keeps the flow predictable.

### 7. The body's loop must be replay-deterministic

WDK replays the workflow body by walking completed-step events. For
a body with `while (!consumeDone)` calling `consumeAndPostStep` each
iteration, replay walks every previously-completed step's cached
result, then re-attempts the failed one. With each iteration a full
event-log entry, replay scales to ~hundreds of iterations before the
240s `REPLAY_TIMEOUT_MS` becomes a concern. A 14-min reply at 60s
per iteration is 14 events; a 4-hour ceiling is ~240 events. Comfortable.

## Trade-offs

- **Function-host crash mid-iteration restarts THAT iteration only.**
  Prior iterations are sealed in the WDK event log and not replayed.
  The Slack message being filled at crash time gets duplicated; every
  prior sealed message is intact.
- **Slack rollover seams ~33% more frequent.** Acceptable given the
  alternative was silent mid-reply truncation.
- **State size grows linearly across iterations** (responseText,
  perTurnDeltaText). For a 100KB reply across 14 iterations, that's
  ~1.4MB through WDK's event log — well under any practical limit
  but worth a metric if the cap ever becomes load-bearing.

## When NOT to use this pattern

- The step's external side effect can't be safely repeated across
  step boundaries. (E.g. an external API that doesn't support
  resumption: opening a new transaction or session per iteration
  breaks the upstream invariant.)
- The state genuinely doesn't fit serde — class instances with
  internal pointers, native streams, etc. Refactor to expose a
  serializable view or accept the function-host cap.
- The work fits comfortably in one step (< 90s). Bounded iteration
  adds complexity that's only justified when the cap is actually
  reachable.

## Related patterns

- [`sentinel-returns-vs-throws-in-wdk-steps`](sentinel-returns-vs-throws-in-wdk-steps-2026-05-07.md) — the discriminated-return shape this pattern's `ChatConsumeStepResult` extends.
- [`two-stage-write-around-external-start`](two-stage-write-around-external-start-2026-05-07.md) — the per-iteration external side effects (Slack `chat.startStream`) follow the same retry-doubles concern.
- [`strict-inequality-boundary-defect`](../logic-errors/strict-inequality-boundary-defect-2026-05-07.md) — three-independent-constants shape (deadline / quiet / function cap) is the same shape that bit round-5 STALE_CLAIM. Pin the inequality in a unit test (deadline ≥ quiet + 10s).
- [`transcript-capture-and-streaming-fixes`](../logic-errors/transcript-capture-and-streaming-fixes.md) — bounded-buffer streaming pipelines need explicit allowlists for critical events; verify per-event-type handling across iterations.

## Testing

`tests/unit/workflows/chat-dispatch-workflow.test.ts` covers:

- `initialChatConsumeState()` shape (catches missing-field regressions when the type evolves).
- JSON round-trip of `ChatConsumeState` (catches Map/Set serialization drift).
- Constant-invariant: `CONSUME_STEP_DEADLINE_MS ≥ CONSUME_STEP_QUIET_MS + 10s` (catches the round-5 boundary-defect shape).
- Constant-invariant: deadline ≤ 100s (catches accidentally re-introducing the 120s wall).
- Constant-invariant: quiet ≥ 40s (catches accidentally re-tightening below typical Opus thinking-pause length).

Multi-iteration state-continuity is exercised by integration
testing post-deploy via `npx workflow inspect steps -r <runId>`:
the chat workflow should show many `consumeAndPostStep` events all
`attempt: 1, status: completed`, and the inner dispatch's stream
should match the user-visible Slack rendering byte-for-byte.

## See also

- [Vercel Workflow DevKit constants](../../node_modules/@workflow/core/dist/runtime/constants.js) — `REPLAY_TIMEOUT_MS = 240_000` is the practical upper bound on body-loop iteration count.
- [vercel/workflow#1483](https://github.com/vercel/workflow/issues/1483) — community discussion of the `/.well-known/workflow/v1/flow` cap.
- PR #84: zombie-cancel safety net (the symptom-mitigating predecessor to this architectural fix).
- PR #85: this refactor.
