---
module: src/lib/workflows/chat-dispatch-workflow.ts
date: 2026-05-07
problem_type: logic_error
component: service_object
severity: high
symptoms:
  - "Code that should bound retries lets retries proceed at the boundary"
  - "Comments say 'must be ≥ X' but the predicate actually proves only '> X'"
  - "Two timeout constants set equal at the boundary, with the predicate using strict <"
  - "Reviewer trace finds 'predicate evaluates true for any positive ε past the threshold'"
root_cause: logic_error
resolution_type: code_fix
tags:
  - boundary-defect
  - off-by-one
  - threshold-pair
  - timing-predicate
  - strict-inequality
---

# Strict-inequality boundary defect with adjacent constants

## Problem

When two timeouts feed into the same predicate (one defines a budget, the other a threshold compared against it), setting them equal at the boundary and using strict `<` lets the boundary case pass when intent was to block it. The class of bug: comment says one thing, algebra proves another, and the gap is invisible until a reviewer traces concrete values.

## Symptoms

- A predicate `claimed_at < now() - 30s` paired with a poll that exits after 30 seconds: at exactly the boundary, the predicate is `T0 < T0+ε`, true for any positive ε.
- A circuit-breaker `attempts > 5` paired with a counter that increments by 1 per attempt within a single retry-bounded run: the counter never reaches 6 within one run.
- Two adjacent timing constants documented as "must be ≥ X" but actually equal at the boundary, with no buffer.

## What Didn't Work

Trying to "tune" the values without restructuring the relationship. As long as the two constants are independent inputs and the predicate is `<`, any shared boundary value lets the equal case pass.

## Solution

Two complementary fixes:

### 1. Derive the threshold strictly from the budget plus a buffer

```ts
// BEFORE — equal at the boundary, predicate uses strict <
const POLL_MAX_DURATION_MS = 30_000;
const STALE_CLAIM_THRESHOLD_SECONDS = 30;  // hand-set

// AFTER — threshold derived from budget, with explicit buffer
const POLL_MAX_DURATION_MS = 30_000;
const STALE_CLAIM_THRESHOLD_SECONDS = Math.ceil(POLL_MAX_DURATION_MS / 1000) + 60;
```

The buffer (60s here) absorbs:
- Tail-latency variance on the work the budget bounds (cold sandbox boot, MCP refresh, plugin sync).
- Clock skew between the row's `claimed_at` and the predicate's `now()`.
- Future tuning of `POLL_MAX_DURATION_MS` without re-introducing the boundary defect.

### 2. Pin the relationship in a unit test

```ts
// Round-5 review residual rel-005: regression guard for the bound.
expect(() =>
  CreateAgentSchema.parse({ name: "test", max_runtime_seconds: 14400 }),
).toThrow();
expect(
  CreateAgentSchema.parse({ name: "test", max_runtime_seconds: 3600 })
    .max_runtime_seconds,
).toBe(3600);
```

A future change that bumps the cap silently regresses the relationship — the test catches it before it ships.

## Why This Works

The bug is structural: two constants that must satisfy `A < B` (or `A + buffer ≤ B`) become independent of each other when set inline. Comments asserting the relationship rot. Refactoring `B = f(A) + buffer` makes the relationship a property of the code, not a property of the documentation.

The strict-inequality side: `<` and `≤` differ only at the boundary. When the boundary case is unreachable in practice, either operator works. When it's reachable (timing-derived comparisons, integer counters that increment exactly to the limit), the choice matters. Default to the operator that excludes the boundary AND derive operands so the boundary is unreachable.

## Prevention

- **Rule of thumb**: when two timeouts feed into the same predicate, derive one strictly from the other plus a buffer. Never let them be configured equal.
- **Audit pattern**: grep for paired constants and check whether their relationship is enforced anywhere or only documented. Examples in this codebase that should follow the pattern: `POLL_MAX_DURATION_MS` ↔ `STALE_CLAIM_THRESHOLD_SECONDS`, `MAX_RUNTIME_SECONDS_CEILING` ↔ session `expires_at` cap.
- **Test guards**: when the relationship bounds something user-facing (validation cap, retry budget), add a regression test that asserts the boundary case fails.
- **Naming hint**: when one constant is "the budget" and the other is "the threshold past which we declare X stale," prefer compound names that surface the relationship: `STALE_AFTER_POLL_BUDGET_PLUS_60S` is uglier but harder to misuse than `STALE_CLAIM_THRESHOLD_SECONDS`.

## Concrete instances on this branch

Three sites surfaced the same shape across rounds 5–6:

1. **`STALE_CLAIM_THRESHOLD_SECONDS`** vs **`POLL_MAX_DURATION_MS`** (round-5). Comment said "must be ≥ POLL_MAX_DURATION_MS so a still-running winner cannot be stolen by a loser that finished its poll early" — algebra showed the predicate fired true at exactly the boundary. Fix: derived from the budget plus 60s.

2. **`MAX_STEAL_ATTEMPTS = 5` with predicate `attempts > 5`** (round-5). The counter incremented once per attempt; with the WDK retry budget of ~4, the predicate never fired within a single bounded run. Fix wasn't re-tuning the threshold — it was switching the retry semantics from "throw and let WDK retry" to sentinel return so the counter persists across WDK retries via the DB row. (See `architecture-patterns/sentinel-returns-vs-throws-in-wdk-steps-2026-05-07.md`.)

3. **`max_runtime_seconds.max(14400)` vs `expires_at = 4h`** (round-5 rel-005, fixed in round-7). The watchdog horizon (`max_runtime_seconds + 120s grace`) had to stay below the 4h `expires_at` ceiling. At 14400, the horizon was 14520s — past the ceiling. The grace window was unreachable. Fix: lower the validation cap to 3600 with a unit test pinning the boundary.

## References

- **Reference implementations:**
  - `src/lib/workflows/chat-dispatch-workflow.ts` — `STALE_CLAIM_THRESHOLD_SECONDS = Math.ceil(POLL_MAX_DURATION_MS / 1000) + 60`
  - `src/lib/validation.ts` — `MAX_RUNTIME_SECONDS_CEILING = 3600`
  - `tests/unit/validation.test.ts` — `rejects max_runtime_seconds outside 60..3600` regression guard
- **Origin commits:**
  - `413a38e` — round-4: STALE_CLAIM threshold derivation
  - `c00dcd8` — round-5 rel-005: max_runtime_seconds cap lowered + boundary test
