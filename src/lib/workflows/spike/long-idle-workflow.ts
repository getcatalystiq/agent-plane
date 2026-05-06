/**
 * U0 Phase 0 spike — long-idle workflow.
 *
 * Verifies that the workflow runtime suspends the run during sleep without
 * holding a function instance open. Caller passes the desired sleep duration
 * (typical values: 5s for local dev, 1800s for deployed-preview verification).
 *
 * Plan reference: U0 in docs/plans/2026-05-05-001-refactor-workflow-sdk-dispatch-plan.md
 */
import { getWorkflowMetadata, sleep } from "workflow";

export interface SpikeLongIdleInput {
  sleepMs: number;
}

export interface SpikeLongIdleOutput {
  workflowRunId: string;
  slept: number;
}

export async function spikeLongIdleWorkflow(
  input: SpikeLongIdleInput,
): Promise<SpikeLongIdleOutput> {
  "use workflow";

  await sleep(input.sleepMs);
  const meta = getWorkflowMetadata();
  return { workflowRunId: meta.workflowRunId, slept: input.sleepMs };
}
