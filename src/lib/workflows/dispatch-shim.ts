/**
 * Dispatch shim — picks workflow vs legacy based on `shouldUseWorkflow` and
 * returns a result shape compatible with the existing legacy
 * `dispatchSessionMessage`. Routes that previously called
 * `dispatchSessionMessage(input)` directly can call
 * `dispatchOrWorkflowDispatch(input)` instead and the path is selected
 * transparently.
 *
 * Plan reference: U5 in docs/plans/2026-05-05-001-refactor-workflow-sdk-dispatch-plan.md
 *
 * Workflow path: starts dispatchWorkflow via `start()`, polls for the
 * reserve-step commit (typically <500ms) to recover `sessionId` +
 * `messageId`, then returns a render-rest stream the route relays to
 * the client. Same NDJSON wire format as legacy; same `X-Session-Id`
 * + `X-Message-Id` response headers possible.
 *
 * Coexistence rule (per the plan): a session's path is fixed at first
 * dispatch. Sessions with `workflow_run_id IS NULL` continue on legacy;
 * sessions with non-null `workflow_run_id` continue on workflow. The
 * toggle only affects NEW dispatches.
 */
import { getSession, setWorkflowRunId } from "@/lib/sessions";
import {
  dispatchSessionMessage,
  reserveSessionAndMessage,
  type DispatchInput,
  type DispatchResult,
  type PreparedExecution,
} from "@/lib/dispatcher";
import { transitionMessageStatus } from "@/lib/session-messages";
import { start } from "workflow/api";
import { dispatchWorkflow } from "@/lib/workflows/dispatch-workflow";
import { renderRest, renderRestHeaders } from "@/lib/workflows/render-rest";
import { shouldUseWorkflow } from "@/lib/workflows/toggle";
import { logger } from "@/lib/logger";
import type { RunTriggeredBy } from "@/lib/types";

/**
 * Dispatch via workflow when the toggle is on for `(triggeredBy, tenantId)`
 * AND the session (when present) is NOT pinned to legacy. Otherwise call
 * the legacy `dispatchSessionMessage`.
 */
export async function dispatchOrWorkflowDispatch(
  input: DispatchInput,
): Promise<DispatchResult> {
  const trigger = input.triggeredBy as RunTriggeredBy;

  // Coexistence rule: existing session pins the path.
  if (input.sessionId) {
    try {
      const session = await getSession(input.sessionId, input.tenantId);
      if (session.workflow_run_id) {
        // Existing workflow-backed session: append a message via workflow
        // path even if the toggle is now off.
        return await dispatchViaWorkflow(input);
      }
      // Existing legacy-pinned session: stay on legacy path.
      return await dispatchSessionMessage(input);
    } catch {
      // Session lookup failed → fall through to toggle-based decision; the
      // legacy dispatcher will surface 404/410 if appropriate.
    }
  }

  if (await shouldUseWorkflow(trigger, input.tenantId)) {
    return await dispatchViaWorkflow(input);
  }
  return await dispatchSessionMessage(input);
}

async function dispatchViaWorkflow(
  input: DispatchInput,
): Promise<DispatchResult> {
  // PERF: reserve session + message in-process BEFORE starting the workflow.
  // Pre-fix this happened inside the workflow's reserveStep, so the shim had
  // to pollForReserveCommit (100ms-5s) to recover sessionId/messageId for
  // the response headers. Doing it here makes both ids available immediately
  // and removes a step boundary from the workflow's first-byte path.
  //
  // Trade-off: reserve no longer participates in WDK retry. If reserve fails
  // here we surface the error to the caller (5xx); if it succeeds and
  // start() then fails, we transition the message to failed before throwing.
  const prepared = await reserveSessionAndMessage(input);

  let runId: string;
  try {
    const run = await start(
      dispatchWorkflow as unknown as (
        input: DispatchInput,
        prepared: PreparedExecution,
      ) => Promise<{ sessionId: string; messageId: string }>,
      [input, prepared],
    );
    runId = run.runId;
  } catch (err) {
    // Workflow failed to start — message is already reserved as 'running'.
    // Mark it failed so it doesn't sit forever waiting for the runner.
    await transitionMessageStatus(
      prepared.messageId,
      input.tenantId,
      "running",
      "failed",
      {
        completed_at: new Date().toISOString(),
        error_type: "workflow_start_failed",
        error_messages: [err instanceof Error ? err.message : String(err)],
      },
    ).catch(() => {});
    throw err;
  }

  // Best-effort: persist runId on the session row for cleanup/cancel lookup.
  // The workflow body also persists this via persistWorkflowRunIdStep — that
  // covers the case where this in-process write loses to a function-host
  // crash here.
  await setWorkflowRunId(
    prepared.session.id,
    input.tenantId,
    `wdk_v1_${runId}`,
  ).catch((err) => {
    logger.warn("dispatchViaWorkflow: setWorkflowRunId failed (best-effort)", {
      session_id: prepared.session.id,
      run_id: runId,
      error: err instanceof Error ? err.message : String(err),
    });
  });

  const stream = renderRest({
    runId,
    sessionId: prepared.session.id,
    messageId: prepared.messageId,
  });

  return {
    sessionId: prepared.session.id,
    messageId: prepared.messageId,
    stream,
    response: () =>
      new Response(stream, {
        status: 200,
        headers: {
          ...renderRestHeaders(),
          "X-Session-Id": prepared.session.id,
          "X-Message-Id": prepared.messageId,
        },
      }),
  };
}
