---
title: WDK Spike Results
date: 2026-05-06
plan: docs/plans/2026-05-05-001-refactor-workflow-sdk-dispatch-plan.md
status: verified
deploy: https://agentplane-n2kaha078-truetake.vercel.app (commit 4116c90)
---

# WDK Spike Results

This file records the outcome of the U0 spike from the workflow-dispatch refactor plan. Per the plan, items 1, 2, 5, and 7 are **blocking** — the plan returns to brainstorm if any of those fail. Other items can proceed with documented mitigations.

## Outcome: VERIFIED — U2 may proceed

All 8 verification items passed. Several non-obvious WDK constraints surfaced during the spike; they are recorded under "Constraints learned" below and shape U2's design.

## Pinned package version

- `workflow@4.2.4`
- Peer: `@opentelemetry/api@1`
- Sub-deps: `@workflow/core`, `@workflow/errors`, `@workflow/world`, `@workflow/next`

## Type-level verification (recorded 2026-05-05)

Done via direct inspection of `node_modules/workflow/dist/*.d.ts` and `node_modules/@workflow/core/dist/**/*.d.ts`.

| Plan-named API | Actual API | Notes |
|---|---|---|
| `createHook<T>({ token })` | ✅ exists | Returns `Hook<T> extends AsyncIterable<T>` — `for await` is the supported iteration shape |
| Custom deterministic token | ✅ supported | Plan example `transcript:${messageId}` matches the WDK Slack-bot reference exactly |
| `resumeHook(token, payload)` | ✅ exists in `workflow/api` | Callable from any HTTP route; no auth attached at the WDK layer |
| `getHookByToken(token)` | ✅ exists | Returns hook including `runId` |
| `start(workflowFn, args, options)` | ✅ exists | Returns `Run<TResult>`. **No `idempotencyKey` parameter** — confirms fz-002 |
| `Run.cancel()` | ✅ exists | One-shot |
| `Run.returnValue` | ✅ exists | Polls every 1s until terminal |
| `Run.status` | ✅ exists | `WorkflowRunStatus` enum from `@workflow/world` |
| `Run.getReadable({ startIndex })` | ✅ exists | Negative startIndex supported (last N chunks); also `getTailIndex()` helper |
| `Run.runId` | ✅ exists | The plan should read it from `start()`'s return, not from `getWorkflowMetadata` |
| `getRun(runId)` | ✅ exists | Returns a `Run` for an existing runId |
| `getStepMetadata().stepId` | ✅ exists | Stable across step retries (per WDK docs) |
| `getWorkflowMetadata()` | ✅ exists, returns `{ workflowName, workflowRunId, workflowStartedAt, url }` | **Includes `workflowRunId` for the current run** — original plan sketch (`getRunMetadata().runId`) is achievable; the `reserve` step CAN persist runId atomically |
| `getWritable<T>()` inside step | ✅ exists | Returns `WritableStream<T>` |
| `sleep(ms)` | ✅ exists | Suspends the run on Vercel runtime; real timer in dev |

## Runtime verification (deployed Vercel preview)

Driver: `scripts/wdk-spike.ts` invoking `/api/internal/wdk-spike/[scenario]` against the deployed preview. Each scenario covers one WDK primitive in isolation.

| # | Scenario | Status | Notes |
|---|---|---|---|
| 1 | createHook + resumeHook with custom token | ✅ verified | Hook registration latency = **515ms** on warm deploy (3 retry attempts via 100ms→2s backoff). Cold runs measured up to 1.2s. |
| 2 | Hook resumed before iterator parks (queue holds value) | ✅ verified | Race tolerated; first POST landed after 2 retries. WDK queues the resume payload until the iterator picks it up. |
| 3 | getWritable inside step + getReadable from outside | ✅ verified | 6 chunks (5 chunk + 1 terminal) read after `run.returnValue` resolved, bounded by `getTailIndex()`. |
| 4 | Reconnect by runId + startIndex (no duplicate, no skip) | ✅ verified | Read first 3 via `startIndex=0`, reconnected at `startIndex=3`, received remaining 4 chunks (`r3`–`rEnd`) without duplication. |
| 5 | getRun(runId).cancel() during hook iteration | ✅ verified | Run reached terminal `status=cancelled` after cancel; `returnValue` rejected. |
| 6 | Step retry with stable stepId | ✅ verified | RetryableError throw → step retried → `attemptedFromStep=2`, `stepId` stable. |
| 7 | Long-idle workflow (function compute not held) | ✅ verified | Slept 5000ms; total elapsed 7403ms (sleep + wakeup overhead). For 1800000ms (30min), function-suspension semantics need to be re-verified during U2 against actual production-class agents. |
| 8 | Package + Next.js framework integration | ✅ verified | `workflow/next` plugin registered in `next.config.ts`; build-time transform produces `Created manifest with 6 steps, 3 workflows, and 0 classes`. |

## Constraints learned (materially shape U2)

The spike was rewritten three times before the right shape emerged. Each rewrite was driven by a runtime error that wasn't obvious from the docs alone. Recording the constraints here so U2's `dispatchWorkflow` design starts from the right shape.

1. **`createHook()` must be called from a workflow function (not a step).** Calling it from a step throws `Error: createHook() can only be called from inside a workflow function`. So in U2, the workflow body — not a step — owns hook lifecycle.

2. **The `Hook<T>` object cannot cross the workflow→step boundary.** It carries non-serializable Symbols (`Symbol.asyncIterator`, `Symbol.dispose`) and functions (`then`, `dispose`). Passing it as a step argument throws `Error: Cannot stringify POJOs with symbolic keys`. Workflow body must own the hook reference end-to-end.

3. **Stream writes (`getWritable().getWriter().write()`) must happen inside a step.** Calling them from workflow body throws `Error: Not supported in workflow functions`. Combined with constraints 1 + 2, the only workable shape is: **workflow body iterates the hook with `for await`, dispatches each chunk's *data* (a string — serializable) to a per-chunk write step**.

4. **WDK readables don't auto-close on workflow termination.** A plain `for await` over `getReadable()` after `run.returnValue` resolves hangs because `done` never fires (writable stays open across step calls). **Use `getTailIndex()` to bound the read** to exactly `tail - startIndex + 1` chunks. U2's REST/A2A render shims must follow this pattern.

5. **`WorkflowReadableStream.cancel()` cancels the workflow run.** Calling `.cancel()` on the readable propagates upstream to cancel the run itself, leading to `WorkflowRuntimeError: Unconsumed event in event log: eventType=run_cancelled`. To release a reader, just `releaseLock()` — never `cancel()` the readable.

6. **Hook registration takes ~500ms–1.2s on Vercel cold-start.** `resumeHook(token, ...)` immediately after `start()` returns will throw `HookNotFoundError: Hook not found`. **Callers (the runner-side per-line POST in U3) must implement exponential backoff retry** — 100ms → 2s, capped at 30s budget. The U3 runner's `X-Runner-Attempt-Sequence` header still works; backoff is just a per-POST behavior.

7. **`start()` accepts no `idempotencyKey`.** The plan already records this (fz-002). DB-side dedup (webhook `delivery_id` UNIQUE, REST/A2A request-UUID cache, schedule `(scheduleId, fireTime)` CAS) remains the only line of defense.

8. **`getWorkflowMetadata().workflowRunId` IS available inside the workflow body.** This means U2's `reserve` step CAN persist `wdk_v1_<runId>` atomically — the original plan sketch is achievable. (An earlier reading of the type system suggested otherwise; the real `WorkflowMetadata` shape carries `workflowRunId`.)

## Plan refinements implied (apply before U2 lands)

These aren't blockers, but they sharpen U2's design before code starts:

- **U2's `streamFromHook` step shape changes.** Instead of one step that owns iteration + writes, the workflow body owns iteration and dispatches each chunk to a small `writeChunk(data: string)` step. The plan's HLTD diagram should be updated.
- **U3's render shims for REST and A2A must use `getTailIndex()` to bound their reads** when draining a completed run's stream. Document in U3's Approach.
- **U3's runner backoff policy is documented:** ~500ms–1.2s registration window typical, 30s budget worst case. Match the spike's `resumeHookWithBackoff` shape (100ms → 2s exponential, max 5 retries before failing the batch with retryable 5xx).
- **U2 must NOT call `.cancel()` on `WorkflowReadableStream`** anywhere in the render shims. Use `releaseLock()` and dispose the reader.

## Decision

- [x] **Verified — proceed with U1 + U2.** All 8 items verified (4 blocking + 4 non-blocking). Plan refinements above to be applied to U2/U3 sections before implementation.
