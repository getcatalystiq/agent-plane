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
import { getSession, setWorkflowRunId, clearWorkflowRunId } from "@/lib/sessions";
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
import { scanForInjection } from "@/lib/safety/injection-scanner";
import {
  applyInjectionPolicy,
  getTenantInjectionEnforceMode,
} from "@/lib/safety/policy";
import { PromptRejectedError } from "@/lib/errors";

const INJECTION_BLOCK_JITTER_MS = 100;

/**
 * Dispatch via workflow when the toggle is on for `(triggeredBy, tenantId)`
 * AND the session (when present) is NOT pinned to legacy. Otherwise call
 * the legacy `dispatchSessionMessage`.
 */
export async function dispatchOrWorkflowDispatch(
  input: DispatchInput,
): Promise<DispatchResult> {
  const trigger = input.triggeredBy as RunTriggeredBy;

  // STEP 0 — prompt-injection scan. Runs BEFORE the legacy/workflow branch
  // decision so workflow-enabled tenants are covered too. The verdict (and
  // the resolved tenant enforce_mode) are threaded through DispatchInput so
  // both branches' INSERT into session_messages can persist them.
  const enforceMode = await getTenantInjectionEnforceMode(input.tenantId);
  const scan = scanForInjection(input.prompt);
  const decision = applyInjectionPolicy(scan, trigger, enforceMode);

  if (decision === "block") {
    logger.warn("injection_scan_blocked", {
      tenant_id: input.tenantId,
      triggered_by: trigger,
      confidence: scan.confidence,
      patterns: scan.patterns,
      prompt_length: input.prompt.length,
      enforce_mode: enforceMode,
    });
    // Constant jitter to dampen the latency oracle. Not a literal floor —
    // see Key Technical Decisions in the plan for why.
    await new Promise((resolve) =>
      setTimeout(resolve, INJECTION_BLOCK_JITTER_MS),
    );
    throw new PromptRejectedError();
  }

  if (scan.detected) {
    logger.info("injection_scan_logged", {
      tenant_id: input.tenantId,
      triggered_by: trigger,
      confidence: scan.confidence,
      patterns: scan.patterns,
      prompt_length: input.prompt.length,
      enforce_mode: enforceMode,
    });
  }

  // Thread the verdict + mode through to the downstream branches so the
  // INSERT picks them up and the cache key incorporates them.
  const scannedInput: DispatchInput = {
    ...input,
    injectionScan: scan,
    injectionEnforceMode: enforceMode,
  };

  // Existing session: pick the fastest path that's still safe.
  if (scannedInput.sessionId) {
    try {
      const session = await getSession(scannedInput.sessionId, scannedInput.tenantId);

      // PERF — warm follow-up bypass: when a session already has a live
      // sandbox AND isn't stopped, the legacy in-process path is strictly
      // faster than any workflow path because it skips every WDK step
      // boundary (reserve, prepare, write per batch, finalize). Each step
      // costs ~100-500ms of cross-function overhead; for a chatty
      // follow-up the workflow can pay 1-3s of overhead on top of the
      // actual work. Legacy reuses the same warm sandbox via
      // reconnectSessionSandbox in-process, so we get all of the
      // warm-reconnect benefit with none of the WDK tax.
      //
      // Safety: each MESSAGE creates its own workflow run anyway, so
      // dropping the workflow for one follow-up doesn't leave anything
      // partially-orchestrated. We clear session.workflow_run_id (if any)
      // so cancelSession / cleanup-cron don't try to WDK-cancel a run
      // that's not actually orchestrating this message.
      if (session.sandbox_id && session.status !== "stopped") {
        if (session.workflow_run_id) {
          await clearWorkflowRunId(session.id, scannedInput.tenantId).catch((err) => {
            logger.warn(
              "dispatchOrWorkflowDispatch: clearWorkflowRunId failed (best-effort)",
              {
                session_id: session.id,
                error: err instanceof Error ? err.message : String(err),
              },
            );
          });
        }
        return await dispatchSessionMessage(scannedInput);
      }

      // Cold session that's already workflow-pinned (no live sandbox, but
      // an in-flight workflow run): append via workflow even if the
      // toggle is now off, so the runner registered with the existing
      // hook keeps working.
      if (session.workflow_run_id) {
        return await dispatchViaWorkflow(scannedInput);
      }
      // Cold legacy-pinned session: stay on legacy path.
      return await dispatchSessionMessage(scannedInput);
    } catch {
      // Session lookup failed → fall through to toggle-based decision; the
      // legacy dispatcher will surface 404/410 if appropriate.
    }
  }

  if (await shouldUseWorkflow(trigger, scannedInput.tenantId)) {
    return await dispatchViaWorkflow(scannedInput);
  }
  return await dispatchSessionMessage(scannedInput);
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
