---
module: src/lib/workflows/chat-dispatch-workflow.ts
date: 2026-05-07
problem_type: architecture_pattern
component: service_object
severity: high
applies_when:
  - "Code runs inside a WDK / durable workflow step that retries on any thrown error"
  - "The error path has already done all useful cleanup (markBotError, log, etc.)"
  - "Retrying would re-enter the same recovery branch and produce the same outcome"
  - "Outer caller can distinguish 'bail' from 'retry' from 'success' via a typed return"
related_components:
  - background_job
tags:
  - wdk
  - workflow
  - retry-semantics
  - discriminated-union
  - sentinel-return
  - circuit-breaker
---

# Sentinel returns vs throws in WDK-retried steps

## Context

WDK (Vercel Workflow DevKit) and similar durable-workflow runtimes retry any thrown error from a step until the retry budget exhausts. This is the right default for transient errors but the wrong default for *deliberate bail* paths: a circuit breaker that throws gets retried until the budget runs out, defeating the bound; an "abandonment" path that throws gets retried forever even though the abandonment decision was final.

The pattern: when a step has done all useful cleanup and the caller needs to know "this didn't succeed, but don't retry me," return a typed sentinel from a discriminated union instead of throwing. The workflow body inspects the discriminator and bails gracefully.

## Guidance

### 1. Return a discriminated union, not just `T | null`

```ts
type StartedDispatch =
  | { kind: "started"; innerRunId: string }
  | { kind: "abandoned" }
  | { kind: "orphan"; innerRunId: string };
```

Each non-success case has a name. The caller pattern-matches on `kind`. Adding a new case forces every caller to handle it (TypeScript exhaustiveness).

### 2. The body checks the discriminator before any side-effecting work

```ts
const started = await startInnerDispatchStep(input, persisted);
if (started.kind === "abandoned") return;          // bail; markBotError already stamped
if (started.kind === "orphan") {
  logger.warn("continuing with orphan placeholder", { ... });
  // fall through — orphan still has a usable innerRunId
}
const readable = getRun<string>(started.innerRunId).getReadable<string>();
```

### 3. Inside the step, sentinels replace throws on bail paths

```ts
// BEFORE: throw → WDK retries forever
if (recovered.kind === "abandoned") {
  await markBotErrorStep(input, "abandoned after N attempts");
  throw new ClaimAbandonedError(input.eventId, recovered.attempts);
}

// AFTER: return → WDK accepts the result, no retry
if (recovered.kind === "abandoned") {
  await markBotErrorStep(input, "abandoned after N attempts");
  return { kind: "abandoned" };
}
```

### 4. Throws ARE still appropriate for genuinely transient errors

The pattern is NOT "never throw from a step." Throw when retry would plausibly succeed: DB connectivity blip, transient HTTP 503, optimistic-lock conflict. Return a sentinel when retry is futile because the recovery branch has already concluded.

## Why This Matters

Two real bugs from the chat-platform-bots branch traced to this single mistake:

**Circuit-breaker dead.** The round-5 `MAX_STEAL_ATTEMPTS = 5` counter was meant to bound retries on a stale-claim recovery branch. Implementation: when `steal_attempts > 5`, throw `ClaimAbandonedError`. Reality: WDK retried the throw, recoverLostClaim re-entered, observed `steal_attempts: 6`, threw again, recoverLostClaim re-entered with `steal_attempts: 7`... The counter incremented but the bound never fired. The breaker had no circuit.

**Two-stage write double-dispatch.** The round-5 `retryPlaceholderInnerRunUpdate` retried 3× on the inner_run_id UPDATE, then rethrew. WDK retried the entire step. After 90s the stale-claim threshold fired, the retry took the recovery branch, ran `reserveSessionAndMessage + start(dispatchWorkflow)` AGAIN, and produced a duplicate inner workflow for one event.

Both fixes were the same shape: stop throwing, return a typed sentinel, let the caller decide.

## When to Apply

Use sentinels when:

- The step's recovery branch has done irreversible cleanup (markBotError, finalize, etc.) and a retry would re-do or duplicate that work.
- The step needs to surface a non-success outcome that the caller must distinguish from both success and "transient — please retry."
- The downstream consumer naturally pattern-matches on the result (UI rendering, workflow-body branching).

Do NOT use sentinels for:

- Transient errors where retry could succeed (DB blip, HTTP 503, etc.) — throw and let the runtime retry.
- Programmer errors (assertion failures, wrong types, impossible states) — throw; the runtime should NOT mask them.
- Cases where the caller can't or won't pattern-match — `null` returns work but provide no name; sentinel unions are documentation.

## Examples

### BEFORE — circuit breaker that doesn't break

```ts
async function recoverLostClaim(input): Promise<{ kind: "attached"; innerRunId } | { kind: "promoted" }> {
  // ... try recovery ...
  if (attempts > MAX_STEAL_ATTEMPTS) {
    throw new ClaimAbandonedError(input.eventId, attempts);  // WDK retries this
  }
}

// In the step:
const recovered = await recoverLostClaim(input);   // throws, WDK retries the WHOLE step
// Result: infinite retries until WDK budget exhausts; markBotError fires N times.
```

### AFTER — sentinel terminates cleanly

```ts
type ClaimRecovery =
  | { kind: "attached"; innerRunId: string }
  | { kind: "promoted" }
  | { kind: "abandoned"; attempts: number };

async function recoverLostClaim(input): Promise<ClaimRecovery> {
  if (attempts > MAX_STEAL_ATTEMPTS) {
    return { kind: "abandoned", attempts };
  }
  // ... rest of recovery ...
}

// In the step:
if (recovered.kind === "abandoned") {
  await markBotErrorStep(input, `abandoned after ${recovered.attempts}`);
  return { kind: "abandoned" };  // step succeeds; WDK doesn't retry
}
```

### Workflow body pattern

```ts
// chat-dispatch-workflow.ts — the body decides per-discriminator
const started = await startInnerDispatchStep(input, persisted);
if (started.kind === "abandoned") return;        // markBotError stamped; nothing else to do
if (started.kind === "orphan") {                  // inner ran but placeholder isn't filled
  logger.warn("continuing with orphan placeholder", { ... });
}
const readable = getRun<string>(started.innerRunId).getReadable<string>();
// ... stream consumption ...
```

## References

- **Reference implementation:** `src/lib/workflows/chat-dispatch-workflow.ts` — `StartedDispatch`, `ClaimRecovery`, `recoverLostClaim`, `startInnerDispatchStep`, `retryPlaceholderInnerRunUpdate`
- **Related docs:**
  - `architecture-patterns/two-stage-write-around-external-start-2026-05-07.md` — companion pattern that motivated the `orphan` sentinel
- **Origin commits:**
  - `e55f1c6` — round-5: introduced ClaimAbandonedError throw (the failed circuit breaker)
  - `82cbf49` — round-6: replaced throws with sentinels; removed ClaimAbandonedError class
  - `f3cfec3` — round-6 /simplify: switched to `kind:` discriminator convention
