/**
 * Public surface of the workflows package. Entry-point routes (U5+ admin,
 * REST, schedule, webhook, A2A migrations) import from here.
 *
 * Plan reference: U2 in docs/plans/2026-05-05-001-refactor-workflow-sdk-dispatch-plan.md
 */
export {
  dispatchWorkflow,
  type DispatchWorkflowOutput,
  type RunnerChunk,
  type DispatchInput,
  type DispatchResult,
} from "./dispatch-workflow";
