---
status: complete
priority: p1
issue_id: "001"
tags: [code-review, architecture, performance, correctness]
dependencies: []
---

# Missing `finalizeRun()` — sandbox leak, no transcript, no billing

## Problem Statement

`SandboxAgentExecutor.execute()` calls `prepareRunExecution()` which returns `{ sandbox, logIterator, transcriptChunks }`, but never calls `finalizeRun()` after consuming the log stream. This means:

1. **Sandbox is never stopped** — leaked until cleanup cron (every 5 min)
2. **Transcript is never uploaded** — `transcriptChunks` populated but never persisted to Vercel Blob
3. **Billing never recorded** — `cost_usd`, token counts, `duration_ms` never set
4. **Run status may not finalize properly** — `finalizeRun()` handles `running → completed/failed` with all side effects

Compare with `executeRunInBackground()` in `src/lib/run-executor.ts` (line 149) which always calls `finalizeRun()`.

## Findings

- **Performance Oracle**: Flagged as Critical — 100 orphaned sandboxes/day at moderate load
- **Architecture Strategist**: Flagged as HIGH RISK blocker — breaks transcript, billing, sandbox lifecycle
- **TypeScript Reviewer**: Flagged as Critical bug — `sandbox` and `transcriptChunks` destructured but unused
- **Code Simplicity Reviewer**: Noted unused destructured variables

## Proposed Solutions

### Option A: Call `finalizeRun()` in finally block (Recommended)
Add a `finally` block after log consumption that calls `finalizeRun(runId, tenantId, transcriptChunks, sandbox, effectiveBudget)`, mirroring `executeRunInBackground()`.

**Pros**: Follows existing pattern, handles all cleanup
**Cons**: None
**Effort**: Small
**Risk**: Low

### Option B: Extract shared finalization logic
Create a shared `withRunFinalization()` wrapper used by both A2A executor and `executeRunInBackground()`.

**Pros**: DRY, prevents future divergence
**Cons**: More refactoring for Phase 1
**Effort**: Medium
**Risk**: Low

## Recommended Action

Option A for Phase 1, Option B for Phase 2.

## Technical Details

- **Affected files**: `src/lib/a2a.ts` (SandboxAgentExecutor.execute, ~line 316-418)
- **Reference**: `src/lib/run-executor.ts` lines 129-150 (`executeRunInBackground`)

## Acceptance Criteria

- [ ] `finalizeRun()` called after log stream consumption in `SandboxAgentExecutor.execute()`
- [ ] Sandbox is stopped after A2A run completes
- [ ] Transcript is uploaded to Vercel Blob for A2A runs
- [ ] `cost_usd` and token counts are recorded for A2A runs
- [ ] Run status transitions to terminal state with billing

## Work Log

| Date | Action | Learnings |
|------|--------|-----------|
| 2026-03-10 | Created from code review | Flagged by 4/5 review agents |

## Resources

- PR #14: https://github.com/getcatalystiq/agent-plane/pull/14
- `src/lib/run-executor.ts` — reference implementation of `finalizeRun()` usage
