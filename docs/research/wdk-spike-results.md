---
title: WDK Spike Results
date: 2026-05-05
plan: docs/plans/2026-05-05-001-refactor-workflow-sdk-dispatch-plan.md
status: in-progress
---

# WDK Spike Results

This file records the outcome of the U0 spike from the workflow-dispatch refactor plan. Per the plan, items 1, 2, 5, and 7 are **blocking** — the plan returns to brainstorm if any of those fail. Other items can proceed with documented mitigations.

Run the spike with `bun run scripts/wdk-spike.ts` (local dev mode) or against a deployed Vercel preview by setting `WDK_SPIKE_BASE_URL`.

## Pinned package version

- `workflow@4.2.4` (added to `package.json` 2026-05-05)
- Peer: `@opentelemetry/api@1` (already present)
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

**Plan refinements implied by type-level findings (do NOT block):**
- The `WorkflowMetadata` type at runtime (from `@workflow/core/dist/workflow/get-workflow-metadata.d.ts`) carries `workflowRunId` — the per-run id is accessible inside the workflow body. Plan's original `reserve`-step persistence sketch is fine.
- A different `WorkflowMetadata` exists in `start.d.ts` with only `workflowId` — that's the static workflow-function identifier (used as input to `start()`, not for runId access). Do not confuse them when reading WDK source.

## Runtime verification (TO BE RUN)

Each scenario below has a one-line slot for `verified | unverified | failed` plus notes. Run the spike and fill in.

### Local dev mode

```bash
bun run scripts/wdk-spike.ts
```

| # | Scenario | Status | Notes |
|---|---|---|---|
| 1 | createHook + resumeHook with custom token | _pending_ | |
| 2 | Hook resumed before iterator parks (queue holds value) | _pending_ | |
| 3 | getWritable inside step + getReadable from outside | _pending_ | |
| 4 | Reconnect by runId + startIndex (no duplicate, no skip) | _pending_ | |
| 5 | getRun(runId).cancel() during hook iteration | _pending_ | |
| 6 | Step retry with stable stepId | _pending_ | Local dev may show `unverified`; deployed preview is authoritative |
| 7 | Long-idle workflow (function compute not held) | _pending_ | Local dev runs a real timer; deployed preview is authoritative |
| 8 | Package + Next.js framework integration | _pending_ | |

### Deployed-preview mode (authoritative for items 3, 6, 7)

```bash
# Push branch, wait for Vercel auto-deploy, then:
WDK_SPIKE_BASE_URL=https://<your-preview>.vercel.app \
WDK_SPIKE_LONG_IDLE_MS=1800000 \
bun run scripts/wdk-spike.ts
```

| # | Scenario | Status | Notes |
|---|---|---|---|
| 1 | createHook + resumeHook with custom token | _pending_ | |
| 2 | Hook resumed before iterator parks (queue holds value) | _pending_ | |
| 3 | getWritable inside step + getReadable from outside (incl. survives function host restart) | _pending_ | Trigger a redeploy mid-stream to verify the survives-restart sub-claim |
| 4 | Reconnect by runId + startIndex (no duplicate, no skip) | _pending_ | |
| 5 | getRun(runId).cancel() during hook iteration | _pending_ | |
| 6 | Step retry with stable stepId | _pending_ | |
| 7 | Long-idle workflow (function compute not held) | _pending_ | Verify in Vercel function-invocation logs that no function was held during the 30min sleep |
| 8 | Package + Next.js framework integration | _pending_ | |

## Outcome gate

- **All 8 verified:** U1 may proceed (per plan U0 verification criteria).
- **Items 1, 2, 5, or 7 failed:** plan returns to brainstorm to evaluate Pattern B (status-polling). Do NOT proceed with U1.
- **Items 3, 4, 6, or 8 failed:** document mitigation below; U1 may still proceed.

## Mitigations recorded

(Empty — populate as failures are observed.)

## Decision

(To be set after the spike runs.)

- [ ] Verified — proceed with U1
- [ ] Partial-verified with mitigations — proceed with U1, plan refinements applied
- [ ] Blocking failure — return to ce-brainstorm
