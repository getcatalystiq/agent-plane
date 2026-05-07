---
module: src/app/api/cron/cleanup-sessions/route.ts
date: 2026-05-07
problem_type: convention
component: database
severity: medium
applies_when:
  - "A helper accepts a SQL predicate fragment to interpolate into a query"
  - "Today's callers all pass literals; tomorrow's caller could pass a user-derived value"
  - "The helper has a small fixed set of predicate variants (cohorts)"
related_components:
  - background_job
tags:
  - sql-injection
  - type-safety
  - discriminated-union
  - sql-predicates
  - defense-in-depth
---

# Cohort-typed predicate maps over string predicates

## Context

A helper that takes `predicate: string` and interpolates into a SQL query is a SQL-injection footgun even when every current caller passes a hardcoded literal. The signature doesn't encode the contract; a future caller can pass a user-derived predicate without anything refusing to compile, run, or fail review.

The pattern: replace the string parameter with a discriminated union of cohort literals + a frozen `Record<Cohort, string>` mapping each cohort to its predicate. The helper looks up the predicate by cohort. SQL injection is closed at the type level — there's no syntax for passing an arbitrary string anymore.

## Guidance

### The shape

```ts
// Discriminated union of allowed cohorts. Adding a new cohort requires
// extending both this type AND the predicate map below — TypeScript
// enforces the symmetry.
type DedupeSweepCohort = "stale-placeholder" | "expired-filled";

const DEDUPE_SWEEP_PREDICATES: Record<DedupeSweepCohort, string> = {
  "stale-placeholder": "inner_run_id IS NULL AND claimed_at < now() - INTERVAL '15 minutes'",
  "expired-filled":    "created_at < now() - INTERVAL '7 days'",
};

async function sweepDedupeBatched(cohort: DedupeSweepCohort): Promise<number> {
  const predicate = DEDUPE_SWEEP_PREDICATES[cohort];
  // ... use predicate in the SQL ...
}

// Callers can ONLY pass cohort literals; SQL fragments aren't a valid input.
await sweepDedupeBatched("stale-placeholder");
```

### Three rules

**Rule 1.** The cohort union is closed. Every literal must appear in both the type and the predicate map.

**Rule 2.** The map is `as const` or `Record<Cohort, string>`-typed so TS catches missing entries. Don't use a plain object literal that allows extra keys.

**Rule 3.** The cohort name is a stable identifier, not a description. Renaming the cohort breaks every caller (good — that's the point). Renaming the predicate text is internal and safe.

## Why This Matters

The string-parameter shape was written because it looked clean:

```ts
async function sweepDedupeBatched(predicate: string): Promise<number> { ... }
sweepDedupeBatched("inner_run_id IS NULL AND claimed_at < now() - INTERVAL '15 minutes'");
sweepDedupeBatched("created_at < now() - INTERVAL '7 days'");
```

Two callers, two literals, no security issue today. But the function signature ratifies "predicate: string" as the contract. A future engineer adding a third cohort copies the existing pattern, accepts a parameter from elsewhere, and the helper happily executes it. By the time review catches it, it's shipped.

The discriminated union closes the door at the type level. A user-derived string can't satisfy `DedupeSweepCohort`; the compiler refuses. The cost is one type definition + one map entry per cohort — paid once, defended forever.

## When to Apply

Use cohort-typed predicates when:

- A helper interpolates SQL fragments AND
- The set of valid fragments is small and known at compile time.

Don't use:

- For helpers that legitimately need arbitrary user-supplied predicates — those need parameterized SQL with `$1, $2, …`, not predicate strings.
- For one-off SQL — inline the predicate at the call site.
- When the cohort grows unboundedly (e.g., per-user filter combinations) — fall back to a query builder with parameterized placeholders.

## Examples

### BEFORE — string parameter footgun

```ts
async function sweepDedupeBatched(predicate: string): Promise<number> {
  let total = 0;
  for (let i = 0; i < SWEEP_MAX_BATCHES; i++) {
    const result = await execute(
      `DELETE FROM chat_event_dedupe
        WHERE ctid IN (SELECT ctid FROM chat_event_dedupe WHERE ${predicate} LIMIT $1)`,
      [SWEEP_BATCH_SIZE],
    );
    total += result.rowCount;
    if (result.rowCount < SWEEP_BATCH_SIZE) break;
  }
  return total;
}

// Two safe callers today...
await sweepDedupeBatched("inner_run_id IS NULL AND claimed_at < now() - INTERVAL '15 minutes'");
await sweepDedupeBatched("created_at < now() - INTERVAL '7 days'");

// ...one unsafe caller tomorrow:
await sweepDedupeBatched(`tenant_id = '${userInput}'`);  // injection
```

### AFTER — cohort union closes the type

```ts
type DedupeSweepCohort = "stale-placeholder" | "expired-filled";

const DEDUPE_SWEEP_PREDICATES: Record<DedupeSweepCohort, string> = {
  "stale-placeholder": "inner_run_id IS NULL AND claimed_at < now() - INTERVAL '15 minutes'",
  "expired-filled":    "created_at < now() - INTERVAL '7 days'",
};

async function sweepDedupeBatched(cohort: DedupeSweepCohort): Promise<number> {
  const predicate = DEDUPE_SWEEP_PREDICATES[cohort];
  // ... same SQL body, no longer accepts arbitrary strings ...
}

await sweepDedupeBatched("stale-placeholder");
await sweepDedupeBatched("expired-filled");
await sweepDedupeBatched(userInput);   // ❌ TS error: not assignable to DedupeSweepCohort
```

### Adding a new cohort

```ts
// 1. Extend the type
type DedupeSweepCohort = "stale-placeholder" | "expired-filled" | "abandoned-after-circuit-breaker";

// 2. TS error here forces you to add the entry
const DEDUPE_SWEEP_PREDICATES: Record<DedupeSweepCohort, string> = {
  "stale-placeholder": "...",
  "expired-filled":    "...",
  "abandoned-after-circuit-breaker": "steal_attempts > 5 AND inner_run_id IS NULL",
};
```

## References

- **Reference implementation:** `src/app/api/cron/cleanup-sessions/route.ts:526-565` (`sweepDedupeBatched`, `DedupeSweepCohort`, `DEDUPE_SWEEP_PREDICATES`)
- **Companion pattern:** `architecture-patterns/ctid-batched-delete-for-cron-sweeps-2026-05-07.md`
- **Origin commit:** `f3cfec3` — round-6 /simplify: switched `predicate: string` to cohort union
