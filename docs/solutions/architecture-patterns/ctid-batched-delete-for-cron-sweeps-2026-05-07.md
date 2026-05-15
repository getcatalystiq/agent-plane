---
module: src/app/api/cron/cleanup-sessions/route.ts
date: 2026-05-07
problem_type: architecture_pattern
component: database
severity: medium
applies_when:
  - "Cron sweep deletes rows by predicate from a high-volume table"
  - "An unbounded backlog can accumulate (cron outage, prolonged staleness)"
  - "Single-statement DELETE risks a long ACCESS EXCLUSIVE lock that blocks ingress"
  - "Steady-state delete count is small, but catch-up after backlog could be 100k+ rows"
related_components:
  - background_job
tags:
  - postgres
  - cron
  - delete
  - batched-sql
  - ctid
  - cleanup-sweep
---

# CTID-batched DELETE for cron catch-up sweeps

## Context

Cron sweeps that DELETE rows by predicate (`WHERE created_at < now() - INTERVAL '7 days'`, `WHERE inner_run_id IS NULL AND claimed_at < ...`) work fine in steady state when the row count is small. After a backlog — cron outage, prolonged staleness, mass migration — a single-statement DELETE can scan and lock millions of rows, holding ACCESS EXCLUSIVE locks long enough to block ingress traffic on the same table.

The pattern: cap each DELETE at a fixed batch size and bound the loop at a fixed iteration count per cron tick. Steady-state delete in one iteration; backlog drains across successive ticks without long locks.

## Guidance

Two constants govern the sweep:

```ts
const SWEEP_BATCH_SIZE = 5_000;   // rows per DELETE statement
const SWEEP_MAX_BATCHES = 20;     // iterations per cron tick → 100k row cap
```

The DELETE uses `ctid IN (SELECT ctid FROM ... WHERE <predicate> LIMIT N)` so PostgreSQL only locks the N target rows, not a planner-chosen sweep of the whole index range. Loop until `rowCount < BATCH_SIZE` (caught up) or hit `MAX_BATCHES` (out of budget; resume next tick).

```ts
async function sweepDedupeBatched(cohort: DedupeSweepCohort): Promise<number> {
  const predicate = DEDUPE_SWEEP_PREDICATES[cohort];
  let total = 0;
  for (let i = 0; i < SWEEP_MAX_BATCHES; i++) {
    const result = await execute(
      `DELETE FROM chat_event_dedupe
        WHERE ctid IN (
          SELECT ctid FROM chat_event_dedupe
          WHERE ${predicate}
          LIMIT $1
        )`,
      [SWEEP_BATCH_SIZE],
    );
    total += result.rowCount;
    if (result.rowCount < SWEEP_BATCH_SIZE) break;
  }
  return total;
}
```

Predicate is type-checked via discriminated union (`DedupeSweepCohort = "stale-placeholder" | "expired-filled"`) so callers can't pass arbitrary SQL. See `conventions/cohort-typed-sql-predicate-maps-2026-05-07.md` for that companion pattern.

## Why This Matters

A single `DELETE FROM t WHERE created_at < now() - INTERVAL '7 days'` on a multi-million-row backlog:

1. Acquires an ACCESS EXCLUSIVE lock at planning time on every targeted row.
2. Holds the lock for the entire DELETE — typically tens of seconds to minutes.
3. Blocks every concurrent INSERT or UPDATE on the table.
4. If the cron's `maxDuration` fires mid-statement, the transaction rolls back. Next tick faces the same backlog again, plus another wasted lock window.

Batching with `ctid IN (... LIMIT N)` makes each iteration a tiny lock window (5000 rows × index lookup ≈ tens of ms) and lets ingress traffic interleave between batches. Backlog drains across cron ticks instead of hostage-taking one tick.

The naive batching alternative — `DELETE FROM t WHERE id IN (SELECT id FROM t WHERE <pred> LIMIT N)` — works but adds an index lookup on `id` after the predicate filter. CTID is the row's physical address; the planner uses it directly as a TidScan, avoiding the second index hit.

## When to Apply

Use this pattern whenever:

- A cron sweep deletes by predicate from a table that ingress writes to live.
- The delete count can spike under backlog (the steady-state count being small is irrelevant — design for the catch-up case).
- The table has an index supporting the predicate (so the inner SELECT is fast).

Do NOT use:

- For one-shot administrative DELETEs (use `LIMIT` directly without the `ctid IN` wrapper if a row cap is needed).
- When the predicate is unindexed — batching doesn't fix a sequential scan; add the index first.
- When you need transactional cleanup of a referenced FK chain — batching breaks the all-or-nothing semantic.

## Examples

### BEFORE — single unbounded DELETE

```ts
// Steady state: fine. Backlog after a 6-hour cron outage: ACCESS
// EXCLUSIVE lock held for minutes; ingress webhooks 5xx during the
// hold; cron times out mid-statement and rolls back, repeat.
await execute(
  `DELETE FROM chat_event_dedupe
    WHERE created_at < now() - INTERVAL '7 days'`,
);
```

### AFTER — CTID-batched with iteration cap

```ts
// 5000 rows × up to 20 iterations = 100k row cap per tick.
// Each iteration: ms-scale lock window. Backlog drains across ticks.
let total = 0;
for (let i = 0; i < 20; i++) {
  const r = await execute(
    `DELETE FROM chat_event_dedupe
      WHERE ctid IN (
        SELECT ctid FROM chat_event_dedupe
        WHERE created_at < now() - INTERVAL '7 days'
        LIMIT $1
      )`,
    [5_000],
  );
  total += r.rowCount;
  if (r.rowCount < 5_000) break;  // caught up
}
```

### Sizing the batch + max-iterations

`SWEEP_BATCH_SIZE` should be small enough that the lock window is tens of ms but large enough that the per-iteration overhead (BEGIN, plan, LIMIT scan, COMMIT) doesn't dominate. 5k rows is a reasonable default for tables with simple row shapes; bump to 10k for narrow rows, drop to 1k for wide rows or under high contention.

`SWEEP_MAX_BATCHES` should bound a single cron tick to a comfortable fraction of `maxDuration`. With cron every 5 min and a 100k cap at ~50 ms/batch, the worst-case sweep is ~5s — far inside the 300s function ceiling.

## References

- **Reference implementation:** `src/app/api/cron/cleanup-sessions/route.ts:526-565` (`sweepChatEventDedupe`, `sweepDedupeBatched`)
- **Related docs:**
  - `conventions/cohort-typed-sql-predicate-maps-2026-05-07.md` — type-safe predicate dispatch (companion pattern)
- **Origin commits:**
  - `41148c3` — round-4 residual: introduced batched DELETE
  - `f3cfec3` — round-6 /simplify: switched `predicate: string` to `cohort: DedupeSweepCohort`
