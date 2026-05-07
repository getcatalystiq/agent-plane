---
module: src/lib/workflows/chat-dispatch-workflow.ts
date: 2026-05-07
problem_type: architecture_pattern
component: service_object
severity: high
applies_when:
  - "A step calls an external system (start workflow, register job, dispatch HTTP) that is durable and can't be undone"
  - "The step also writes a coordination row (dedupe placeholder, idempotency token) tying the local state to the external id"
  - "Failure between the external call and the local write would orphan the external resource and let a retry double-dispatch"
related_components:
  - background_job
  - database
tags:
  - dispatch
  - durability
  - idempotency
  - retry-semantics
  - placeholder-rows
  - wdk
---

# Two-stage write around external `start()` to bound retry semantics

## Context

A common shape in workflow code: the step (a) reserves local resources (session row, message row), (b) calls an external durable system (`start(dispatchWorkflow)`, queue enqueue, RPC), and (c) writes the resulting external id back to a coordination row.

If those three operations are wrapped in a "register intent → side-effect → record result" sequence and the third step fails, naive code throws and lets the runtime retry. But the side-effect already fired — the external system has the work. A retry that re-runs steps (a) and (b) creates a duplicate.

The pattern: split the local write into two stages around the external call. Pin the local resource row BEFORE the external call so a retry can detect "already started." Record the external id AFTER the call. If the post-call write fails, log loudly but do NOT throw — return a "this succeeded but recording it failed" sentinel and let the cleanup sweep reap the inconsistency.

## Guidance

### Three rules

**Rule 1.** Stage 1 writes (local reservation + dedupe pin) commit BEFORE the external call. A retry that observes the stage-1 row knows the external call may have happened and must not duplicate it.

**Rule 2.** Stage 2 (recording the external id) gets bounded retry on transient failure. After exhaustion, return a sentinel — do NOT throw. (See `architecture-patterns/sentinel-returns-vs-throws-in-wdk-steps-2026-05-07.md`.)

**Rule 3.** A cleanup sweep eventually reaps stage-1 rows whose stage-2 never landed. Until it does, retries observe the stage-1 row and should poll/wait rather than re-dispatch.

### The shape

```ts
// Stage 0 (atomic claim — separate concern; see sentinel-returns doc)
const won = await insertPlaceholder(input);
if (!won) return await recoverLostClaim(input);

// Stage 1 — local reservation + pin to dedupe row, BEFORE external call
const prepared = await reserveSessionAndMessage(dispatchInput);
await withTenantTransaction(input.tenantId, async (tx) => {
  await tx.execute(
    `UPDATE chat_event_dedupe
     SET session_id = $4, message_id = $5
     WHERE tenant_id = $1 AND platform = $2 AND event_id = $3
       AND inner_run_id IS NULL`,
    [tenantId, platform, eventId, prepared.session.id, prepared.messageId],
  );
});

// External durable call — if THIS fails, no orphan: stage-1 row exists but
// no external id; retry sees session_id+message_id pinned and can poll.
const run = await start(dispatchWorkflow, [dispatchInput, prepared]);

// Stage 2 — record the external id with bounded retry
const filled = await retryPlaceholderInnerRunUpdate(input, run.runId);
return filled
  ? { kind: "started", innerRunId: run.runId }
  : { kind: "orphan", innerRunId: run.runId };  // sentinel, NOT throw
```

### Stage-2 retry helper

```ts
async function retryPlaceholderInnerRunUpdate(
  input: ChatTriggerInput,
  innerRunId: string,
): Promise<boolean> {
  const BACKOFFS_MS = [100, 250, 500];
  let lastErr: unknown;
  for (let i = 0; i <= BACKOFFS_MS.length; i++) {
    try {
      await withTenantTransaction(input.tenantId, async (tx) => {
        await tx.execute(`UPDATE ... SET inner_run_id = $4 WHERE ...`, [...]);
      });
      return true;
    } catch (err) {
      lastErr = err;
      if (i < BACKOFFS_MS.length) {
        await new Promise((r) => setTimeout(r, BACKOFFS_MS[i]));
      }
    }
  }
  // Caller must NOT throw on false. Inner workflow IS running; user
  // gets their reply this turn. Cleanup sweep reaps the orphan.
  logger.error("placeholder UPDATE retries exhausted; orphaned", { ... });
  return false;
}
```

### Cleanup sweep contract

The cleanup cron sweeps stage-1 rows whose stage-2 never landed (`inner_run_id IS NULL` past a TTL — 15min in this codebase, comfortably past the watchdog horizon). Once the sweep reaps the orphan, a future retry observing the same external event-id sees no row and can INSERT cleanly.

## Why This Matters

Single-statement local write AFTER the external call has a window where the external system holds work the local state doesn't know about:

1. `start()` succeeds, returns `runId`.
2. UPDATE fails (DB connectivity blip).
3. Naive code throws.
4. WDK retries the entire step.
5. Retry runs `reserveSessionAndMessage` + `start()` AGAIN.
6. Now TWO inner workflows are running for one event.

The two-stage shape bounds the failure to "user's reply ran but the dedupe row is incomplete." That's a benign orphan — the cleanup sweep handles it. No double-dispatch, no double-billing, no two-replies-to-one-message.

The companion patterns:

- **`sentinel-returns-vs-throws-in-wdk-steps-2026-05-07.md`** — the orphan return is a sentinel, not a throw. Throwing would defeat the whole pattern by triggering WDK retry.
- **`pg-advisory-locks-for-per-tenant-resource-caps-2026-05-07.md`** — the stage-0 atomic claim uses `INSERT ... ON CONFLICT DO NOTHING` to serialize concurrent first-fires.

## When to Apply

Use this pattern whenever:

- A step calls an external durable system (workflow `start`, queue enqueue, signed-URL upload, etc.) AND
- The local state must record the external id for future replays/retries to be coherent.

Do NOT use:

- For idempotent external calls where the runtime can't distinguish "first call" from "retry after failure" anyway — let the runtime retry.
- For local-only multi-write transactions — wrap in one `BEGIN…COMMIT` instead.
- When the cleanup sweep can't reap orphans (no TTL, no watchdog) — fix the sweep first; without it, orphans accumulate.

## Examples

### BEFORE — single UPDATE after start()

```ts
const prepared = await reserveSessionAndMessage(input);
const run = await start(dispatchWorkflow, [input, prepared]);
await withTenantTransaction(tenantId, async (tx) => {
  await tx.execute(
    `UPDATE chat_event_dedupe
     SET session_id = $4, message_id = $5, inner_run_id = $6
     WHERE tenant_id = $1 AND platform = $2 AND event_id = $3 AND inner_run_id IS NULL`,
    [...]
  );
});
return { innerRunId: run.runId };
// If the UPDATE throws → WDK retry → reserve+start runs again → DUPLICATE INNER WORKFLOW.
```

### AFTER — two-stage with sentinel

```ts
const prepared = await reserveSessionAndMessage(input);

// Stage 1: pin session+message BEFORE start()
await withTenantTransaction(tenantId, async (tx) => {
  await tx.execute(
    `UPDATE chat_event_dedupe SET session_id = $4, message_id = $5 WHERE ...`,
    [...]
  );
});

const run = await start(dispatchWorkflow, [input, prepared]);

// Stage 2: bounded retry; sentinel on exhaustion
const filled = await retryPlaceholderInnerRunUpdate(input, run.runId);
return filled
  ? { kind: "started", innerRunId: run.runId }
  : { kind: "orphan", innerRunId: run.runId };
```

## References

- **Reference implementation:** `src/lib/workflows/chat-dispatch-workflow.ts:512-536` (`startInnerDispatchStep`), `:540-590` (`retryPlaceholderInnerRunUpdate`)
- **Cleanup sweep that reaps orphans:** `src/app/api/cron/cleanup-sessions/route.ts` `sweepChatEventDedupe`
- **Related docs:**
  - `architecture-patterns/sentinel-returns-vs-throws-in-wdk-steps-2026-05-07.md` — why stage-2 returns instead of throws
  - `architecture-patterns/pg-advisory-locks-for-per-tenant-resource-caps-2026-05-07.md` — stage-0 atomic claim
- **Origin commits:**
  - `e55f1c6` — round-5: introduced 2-stage shape (initially with retry-throw)
  - `82cbf49` — round-6: switched stage-2 retry to sentinel return
