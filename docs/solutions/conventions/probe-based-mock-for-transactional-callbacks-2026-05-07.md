---
module: tests/unit/workflows/chat-dispatch-workflow.test.ts
date: 2026-05-07
problem_type: convention
component: testing_framework
severity: medium
applies_when:
  - "Testing code that calls a transaction wrapper with a callback (e.g. withTenantTransaction(id, async (tx) => ...))"
  - "The callback issues multiple SQL operations and the test needs to assert behavior depending on which SQL ran"
  - "A flat mockResolvedValue would bypass the callback entirely and miss real behavior"
related_components:
  - testing_framework
tags:
  - vitest
  - mocking
  - transactions
  - withtenanttransaction
  - probe-mock
  - test-fidelity
---

# Probe-based mock pattern for transactional callbacks

## Context

Tests that need to verify a function's transactional behavior — what SQL it runs, in what order, with what response — face a fidelity choice. The simple option is `mockResolvedValue(filled)`: vitest returns the canned value and never invokes the callback. That works when the test only cares about the *return* shape, but it misses every assertion about *what the callback did inside the transaction*.

When the callback issues multiple SQL operations (a poll SELECT, then an UPDATE that returns a row, then a re-poll), the test needs to:
- Distinguish each operation by the SQL it issues.
- Return a different canned response per operation.
- Assert that the callback actually ran (didn't silently bypass via mock-result-only semantics).

The pattern: instead of mocking the wrapper's *result*, mock its *behavior* — invoke the production callback with a probe transaction that records the SQL it observes and dispatches canned responses based on substring matching.

## Guidance

### The probe transaction

```ts
import type { TxClient } from "@/db";

withTenantTransactionMock.mockImplementation(
  async (_tenantId: string, cb: (tx: TxClient) => Promise<unknown>) => {
    let observed = false;
    const probeTx: TxClient = {
      queryOne: async (_schema, sql) => {
        observed = true;
        if (sql.toUpperCase().includes("UPDATE")) {
          // The atomic-steal UPDATE … RETURNING — return the steal-shaped row.
          return { steal_attempts: 1, stole: false } as never;
        }
        // Otherwise it's a poll SELECT — return the next queued response.
        return nextPollResponse() as never;
      },
      execute: async () => {
        observed = true;
        return { rowCount: 0 };
      },
      query: async () => [],
    };
    const result = await cb(probeTx);
    if (!observed) throw new Error("test mock: callback didn't invoke tx");
    return result;
  },
);
```

### Three rules

**Rule 1.** Distinguish operations by SQL substring (or by the specific schema passed to `queryOne`). Substrings keep the test resilient to whitespace/casing changes; schemas are tighter but require importing the schema into the test.

**Rule 2.** Track an `observed` flag and assert the callback ran. Without it, a test where the callback silently returns early (e.g. an early `if` with no SQL) passes for the wrong reason.

**Rule 3.** Type the probe with the real `TxClient` interface. `tx: unknown` works at compile time but loses the safety net — a future signature drift on `TxClient` won't surface until production. Use `as never` casts on the response side only when the test response shape doesn't exactly match the call's generic.

### Queueing per-operation responses

For tests that need responses to vary across multiple poll iterations:

```ts
function mockTxQueueWithProbe(responses: DedupeRowShape[]): void {
  let idx = 0;
  withTenantTransactionMock.mockImplementation(async (_tenantId, cb) => {
    let observed = false;
    const probeTx: TxClient = {
      queryOne: async () => {
        observed = true;
        const r = responses[idx] ?? EMPTY_DEDUPE_ROW;  // fallback empty
        idx += 1;
        return r as never;
      },
      execute: async () => { observed = true; return { rowCount: 0 }; },
      query: async () => [],
    };
    const result = await cb(probeTx);
    if (!observed) throw new Error("test mock: callback didn't invoke tx");
    return result;
  });
}
```

## Why This Matters

The flat `mockResolvedValue` shortcut is tempting because it's one line. It passes the test. It even tests *something* — the callback's return value flows through. But three failure modes slip past:

1. **Silent bypass**: a test where the callback never runs (early return, conditional skipping) passes because the mocked return value is what the test asserts. Adding `observed` catches this.
2. **Order-of-operations regressions**: a refactor that swaps `queryOne` with `execute`, or reorders SQL within the callback, changes what the production code does. The flat mock returns the same value either way; the probe distinguishes them via SQL substring.
3. **Schema drift**: a test that doesn't type its mock as `TxClient` won't fail when the interface gains/loses a method. The probe-based mock surfaces it as a TS error at compile time.

The fidelity cost (a function helper, ~20 lines per test file) is small relative to the regression resistance.

## When to Apply

Use probe-based mocking when:

- The callback issues 2+ distinct SQL operations the test needs to distinguish.
- The test asserts something beyond the wrapper's return value (e.g. counter increments, error throws on specific SQL).
- The codebase has stable `TxClient`-like interfaces the test can type against.

Stick with `mockResolvedValue` when:

- The callback issues exactly one operation and the test only cares about the result shape.
- The test is a smoke test for plumbing, not a behavioral test.

Don't mix the two patterns in one test file without comment — readers shouldn't have to guess which idiom a given test uses. The chat-dispatch tests consolidated on probe-based after starting with `mockResolvedValue` and growing to a point where the inconsistency was confusing.

## Examples

### BEFORE — flat mock bypasses the callback

```ts
it("returns the row when poll observes a fill", async () => {
  const filled = { session_id: "s1", message_id: "m1", inner_run_id: "run-1" };
  withTenantTransactionMock.mockResolvedValueOnce(filled);

  const result = await pollForDedupeFill(tenantId, "discord", "evt-1");
  expect(result).toEqual(filled);
});
// Looks fine — but if pollForDedupeFill silently returned filled before
// invoking the callback, the test would still pass.
```

### AFTER — probe-based, asserts callback ran AND drove the response

```ts
it("returns the row when poll observes a fill", async () => {
  const filled = { session_id: "s1", message_id: "m1", inner_run_id: "run-1" };
  mockTxQueueWithProbe([filled]);   // queues filled as the first poll response

  const result = await pollForDedupeFill(tenantId, "discord", "evt-1");

  expect(result).toEqual(filled);
  expect(withTenantTransactionMock).toHaveBeenCalledOnce();
  // Plus: the probe's `observed` check ensured the callback actually ran.
});
```

### Distinguishing poll vs update by SQL substring

```ts
withTenantTransactionMock.mockImplementation(async (_tenantId, cb) => {
  const probeTx: TxClient = {
    queryOne: async (_schema, sql) => {
      if (sql.toUpperCase().includes("UPDATE")) {
        // The atomic-steal UPDATE … RETURNING — return the steal-shaped row.
        return { steal_attempts: 6, stole: false } as never;
      }
      // Otherwise SELECT poll → return queued response or empty.
      return EMPTY as never;
    },
    execute: async () => ({ rowCount: 0 }),
    query: async () => [],
  };
  return cb(probeTx);
});
```

## References

- **Reference implementation:** `tests/unit/workflows/chat-dispatch-workflow.test.ts` — `mockTxQueueWithProbe`, `mockTxByCallType`
- **TxClient interface:** `src/db/index.ts:106-110`
- **Origin commits:**
  - `41148c3` — round-4 residual: introduced `mockTxByCallType` for `recoverLostClaim` tests
  - `f3cfec3` — round-6 /simplify: consolidated `pollForDedupeFill` tests onto the probe pattern
