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
import { z } from "zod";
import { queryOne } from "@/db";
import { getSession } from "@/lib/sessions";
import {
  dispatchSessionMessage,
  type DispatchInput,
  type DispatchResult,
} from "@/lib/dispatcher";
import { start } from "workflow/api";
import { dispatchWorkflow } from "@/lib/workflows/dispatch-workflow";
import { renderRest, renderRestHeaders } from "@/lib/workflows/render-rest";
import { shouldUseWorkflow } from "@/lib/workflows/toggle";
import { logger } from "@/lib/logger";
import { WORKFLOW_RUN_ID_PREFIX } from "@/lib/types";
import type { TenantId, RunTriggeredBy } from "@/lib/types";

const POLL_INTERVAL_MS = 100;
const POLL_BUDGET_MS = 5_000;

const SessionByRunIdRow = z.object({
  id: z.string(),
});

const RunningMessageRow = z.object({
  id: z.string(),
});

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
  // Start the workflow. `start()` returns immediately; the workflow body
  // executes async and the reserve step persists `workflow_run_id` on
  // the session row.
  const run = await start(
    dispatchWorkflow as unknown as (input: DispatchInput) => Promise<{
      sessionId: string;
      messageId: string;
    }>,
    [input],
  );

  const expectedRunId = `${WORKFLOW_RUN_ID_PREFIX}${run.runId}`;

  // Poll for reserve-step commit. Typical: 100-300ms cold-start; faster
  // when the WDK runtime is warm. Bounded at 5s — if reserve doesn't
  // commit by then, the workflow is broken and we throw.
  const ids = await pollForReserveCommit(expectedRunId, input.tenantId);
  if (!ids) {
    logger.error("dispatchViaWorkflow: reserve step never committed", {
      run_id: run.runId,
      tenant_id: input.tenantId,
    });
    throw new Error(
      `Workflow reserve step did not commit within ${POLL_BUDGET_MS}ms`,
    );
  }

  const stream = renderRest({
    runId: run.runId,
    sessionId: ids.sessionId,
    messageId: ids.messageId,
  });

  return {
    sessionId: ids.sessionId,
    messageId: ids.messageId,
    stream,
    response: () =>
      new Response(stream, {
        status: 200,
        headers: {
          ...renderRestHeaders(),
          "X-Session-Id": ids.sessionId,
          "X-Message-Id": ids.messageId,
        },
      }),
  };
}

async function pollForReserveCommit(
  expectedRunId: string,
  tenantId: TenantId,
): Promise<{ sessionId: string; messageId: string } | null> {
  const start = Date.now();
  while (Date.now() - start < POLL_BUDGET_MS) {
    // 1. Find the session this workflow run reserved.
    const session = await queryOne(
      SessionByRunIdRow,
      `SELECT id FROM sessions
       WHERE workflow_run_id = $1 AND tenant_id = $2
       LIMIT 1`,
      [expectedRunId, tenantId],
    );
    if (session) {
      // 2. Find the latest 'running' message on that session — the one
      // this dispatch reserved. There's only ever one in-flight message
      // per session (in-session concurrency cap = 1), so this is
      // unambiguous.
      const message = await queryOne(
        RunningMessageRow,
        `SELECT id FROM session_messages
         WHERE session_id = $1 AND tenant_id = $2 AND status = 'running'
         ORDER BY created_at DESC
         LIMIT 1`,
        [session.id, tenantId],
      );
      if (message) {
        return { sessionId: session.id, messageId: message.id };
      }
    }
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
  }
  return null;
}
