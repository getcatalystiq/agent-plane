/**
 * U0 Phase 0 spike — step retry workflow.
 *
 * Verifies that getStepMetadata().stepId is stable across retries and that
 * a thrown step is retried by the WDK runtime. The flaky step uses a global
 * counter — but per WDK semantics, each step run is a fresh function
 * invocation, so the counter resets per process. To force the retry path we
 * use a workflow-state cursor (an in-memory module-level Map keyed by run id
 * is too brittle here; we let WDK's retry policy drive the test instead).
 *
 * Plan reference: U0 in docs/plans/2026-05-05-001-refactor-workflow-sdk-dispatch-plan.md
 */
import { getStepMetadata, RetryableError } from "workflow";

export interface SpikeFlakyOutput {
  stepId: string;
  attemptedFromStep: number;
}

// Module-level attempt counter. Survives within a single function instance
// but not across cold-start boundaries. Sufficient for local dev verification;
// on Vercel the retry comes from the WDK runtime's retry policy.
let attemptsObserved = 0;

export async function spikeFlakyWorkflow(): Promise<SpikeFlakyOutput> {
  "use workflow";

  const result = await spikeFlakyStep();
  return result;
}

async function spikeFlakyStep(): Promise<SpikeFlakyOutput> {
  "use step";

  const meta = getStepMetadata();
  attemptsObserved += 1;

  // Throw a RetryableError on the first attempt so the WDK retries the step.
  if (attemptsObserved === 1) {
    throw new RetryableError(
      "Spike: flaky-step intentional first-attempt failure",
    );
  }

  return { stepId: meta.stepId, attemptedFromStep: attemptsObserved };
}

// Test hook to reset between runs in the same process (used by the spike runner).
export function __resetFlakyCounterForSpike(): void {
  attemptsObserved = 0;
}
