/**
 * Dispatch entry point — always routes through the WDK workflow path.
 *
 * Was a shim that branched between legacy `dispatchSessionMessage` and
 * the workflow path based on `WORKFLOW_DISPATCH_*` env toggles plus
 * per-tenant overrides. The legacy path was removed; this file now
 * just owns the prompt-injection scan + the start(dispatchWorkflow)
 * dance + the render-rest stream construction.
 *
 * The function name `dispatchOrWorkflowDispatch` is kept for call-site
 * stability — all of `app/api/sessions/route.ts`, `admin/sessions/...`,
 * `webhooks/[sourceId]/route.ts`, `lib/a2a.ts`, and friends import this
 * symbol. Renaming is a follow-up cleanup.
 */
import { setWorkflowRunId } from "@/lib/sessions";
import {
  reserveSessionAndMessage,
  type DispatchInput,
  type DispatchResult,
  type PreparedExecution,
} from "@/lib/dispatcher";
import { transitionMessageStatus } from "@/lib/session-messages";
import { start } from "workflow/api";
import { dispatchWorkflow } from "@/lib/workflows/dispatch-workflow";
import { renderRest, renderRestHeaders } from "@/lib/workflows/render-rest";
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
 * Scan the prompt for injection patterns, then dispatch via the WDK
 * workflow path. Returns a `DispatchResult` shaped identically to the
 * pre-removal API so call sites are unchanged.
 *
 * Throws `PromptRejectedError` (caught by `withErrorHandler` → 400)
 * when the scan + tenant policy decides to block the prompt.
 */
export async function dispatchOrWorkflowDispatch(
  input: DispatchInput,
): Promise<DispatchResult> {
  const trigger = input.triggeredBy as RunTriggeredBy;

  // Prompt-injection scan — runs before workflow dispatch so blocked
  // prompts don't allocate session/message rows. The verdict + tenant
  // enforce_mode are threaded through DispatchInput so the workflow's
  // INSERT into session_messages persists them.
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
    // Constant jitter to dampen the latency oracle. See plan for why
    // this is a fixed delay, not a per-call random one.
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

  const scannedInput: DispatchInput = {
    ...input,
    injectionScan: scan,
    injectionEnforceMode: enforceMode,
  };

  return await dispatchViaWorkflow(scannedInput);
}

async function dispatchViaWorkflow(
  input: DispatchInput,
): Promise<DispatchResult> {
  // PERF: reserve session + message in-process BEFORE starting the
  // workflow. This makes both ids available immediately for
  // `X-Session-Id` / `X-Message-Id` response headers and removes a
  // step boundary from the workflow's first-byte path.
  //
  // Trade-off: reserve no longer participates in WDK retry. If reserve
  // fails here we surface the error to the caller (5xx); if it
  // succeeds and start() then fails, we transition the message to
  // failed before throwing.
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
    // Workflow failed to start — message is already reserved as
    // `running`. Mark it failed so it doesn't sit forever waiting
    // for the runner.
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

  // Best-effort: persist runId on the session row for cleanup/cancel
  // lookup. The workflow body also persists this via
  // persistWorkflowRunIdStep — that covers the case where this
  // in-process write loses to a function-host crash here.
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
