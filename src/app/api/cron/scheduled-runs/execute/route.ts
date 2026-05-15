import { NextRequest } from "next/server";
import { queryOne } from "@/db";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { verifyCronSecret } from "@/lib/cron-auth";
import { AgentRowInternal, TenantRow, ScheduleRow, SessionMessageRow } from "@/lib/validation";
import {
  reserveSessionAndMessage,
  type DispatchInput,
  type PreparedExecution,
} from "@/lib/dispatcher";
import { findWarmScheduleSession, setWorkflowRunId } from "@/lib/sessions";
import { transitionMessageStatus } from "@/lib/session-messages";
import { BudgetExceededError, ConcurrencyLimitError, PromptRejectedError } from "@/lib/errors";
import { getCallbackBaseUrl } from "@/lib/mcp-connections";
import { logger } from "@/lib/logger";
import { start } from "workflow/api";
import { dispatchWorkflow } from "@/lib/workflows/dispatch-workflow";
import {
  deliverScheduleReplyToChannel,
  extractAgentReplyText,
} from "@/lib/platform/scheduled-delivery";
import { z } from "zod";
import type { AgentId, TenantId } from "@/lib/types";

export const dynamic = "force-dynamic";

const ExecuteSchema = z.object({
  schedule_id: z.string().uuid(),
});

export const POST = withErrorHandler(async (request: NextRequest) => {
  verifyCronSecret(request);

  const body = await request.json();
  const { schedule_id } = ExecuteSchema.parse(body);

  // Load schedule from DB (never trust POST body for anything besides schedule_id)
  const schedule = await queryOne(
    ScheduleRow,
    "SELECT * FROM schedules WHERE id = $1",
    [schedule_id],
  );
  if (!schedule || !schedule.enabled || !schedule.prompt) {
    logger.warn("Scheduled run skipped: schedule not found or not enabled", { schedule_id });
    return jsonResponse({ status: "skipped", reason: "not_schedulable" });
  }

  const agent = await queryOne(
    AgentRowInternal,
    "SELECT * FROM agents WHERE id = $1",
    [schedule.agent_id],
  );
  if (!agent) {
    logger.warn("Scheduled run skipped: agent not found", { schedule_id, agent_id: schedule.agent_id });
    return jsonResponse({ status: "skipped", reason: "agent_not_found" });
  }

  const tenant = await queryOne(TenantRow, "SELECT * FROM tenants WHERE id = $1", [agent.tenant_id]);
  if (!tenant || tenant.status === "suspended") {
    logger.warn("Scheduled run skipped: tenant suspended or not found", {
      schedule_id,
      agent_id: agent.id,
      tenant_id: agent.tenant_id,
    });
    return jsonResponse({ status: "skipped", reason: "tenant_suspended" });
  }

  const tenantId = agent.tenant_id as TenantId;
  const agentId = agent.id as AgentId;

  // U4: dispatch through the unified chokepoint. Schedule runs are PERSISTENT
  // (ephemeral=false) so a short follow-up window (idle TTL of 300s, set by
  // the dispatcher's per-trigger default) lets a follow-up cron tick reuse
  // the warm sandbox. The cleanup cron stops idle schedule sessions after
  // the per-row TTL elapses.
  // FIX #6 (adv-003): try to reuse a warm session created by a previous
  // schedule tick. The dispatcher's CAS handles the race with the cleanup
  // cron (and falls back gracefully — for internal triggers a stopped
  // session does NOT throw, the dispatcher auto-creates).
  let warmSessionId: string | undefined;
  try {
    const warm = await findWarmScheduleSession(tenantId, agentId);
    if (warm) warmSessionId = warm.id;
  } catch (err) {
    logger.warn("findWarmScheduleSession lookup failed (non-fatal)", {
      schedule_id,
      agent_id: agent.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  // DIAG: log the schedule's target fields up front so we can see
  // whether channel delivery should fire for this run. Helps diagnose
  // \"schedule fired but didn't post\" reports — if these are null,
  // the schedule wasn't saved with target fields and delivery is
  // intentionally a no-op.
  logger.info("Scheduled run: dispatching", {
    schedule_id,
    agent_id: agent.id,
    tenant_id: tenantId,
    target_platform: schedule.target_platform,
    target_channel: schedule.target_channel,
    has_target: !!(schedule.target_platform && schedule.target_channel),
  });

  // All scheduled runs go through the WDK workflow path. The legacy
  // in-process drain loop (used to live below) was deleted when the
  // dispatch toggle infra was retired; cleanup-sessions' workflow-aware
  // stuck-active watchdog is the backstop if the runner never emits
  // a terminal event.
  return await runViaWorkflow({
    tenantId,
    agentId,
    sessionId: warmSessionId,
    prompt: schedule.prompt,
    schedule_id,
    targetPlatform: schedule.target_platform,
    targetChannel: schedule.target_channel,
  });
});

// ---------------------------------------------------------------------------
// U7: Workflow-path runner.
// ---------------------------------------------------------------------------

/**
 * Replaces the legacy 30s-per-read drain loop with a maxDuration-bounded
 * race against `run.returnValue`. The plan's "drain pain relocated, not
 * removed" framing applies here:
 *
 *   - For runs that complete within `maxDuration - 30s`, the cron returns
 *     `{ status: 'completed' }` with the full result.
 *   - For runs that take longer (e.g., agent.max_runtime_seconds=1800),
 *     the cron returns `{ status: 'detached' }` and the workflow keeps
 *     running. The cleanup cron's workflow-aware stuck-active watchdog
 *     is the backstop if the runner never emits terminal.
 */
async function runViaWorkflow(args: {
  tenantId: TenantId;
  agentId: AgentId;
  sessionId: string | undefined;
  prompt: string;
  schedule_id: string;
  targetPlatform: "slack" | "discord" | null;
  targetChannel: string | null;
}): Promise<Response> {
  // Build the same DispatchInput shape the shim uses, so reserve and the
  // workflow body see identical inputs.
  const input: DispatchInput = {
    tenantId: args.tenantId,
    agentId: args.agentId,
    sessionId: args.sessionId,
    prompt: args.prompt,
    triggeredBy: "schedule",
    ephemeral: false,
    callerKeyId: null,
    platformApiUrl: getCallbackBaseUrl(),
  };

  // Reserve session + message BEFORE start() — same pattern as
  // src/lib/workflows/dispatch-shim.ts:168. dispatchWorkflow's body reads
  // `prepared.messageId` on its very first line; passing prepared=undefined
  // (the prior bug) made every workflow-backed schedule tick crash with
  // `TypeError: Cannot read properties of undefined (reading 'messageId')`
  // before any session/message row was written, so the schedule looked like
  // it "didn't run". Reserve runs in-process so it surfaces budget /
  // concurrency errors via the same catch as the legacy path.
  let prepared: PreparedExecution;
  try {
    prepared = await reserveSessionAndMessage(input);
  } catch (err) {
    if (err instanceof ConcurrencyLimitError || err instanceof BudgetExceededError) {
      const reason =
        err instanceof ConcurrencyLimitError ? "concurrency_limit" : "budget_exceeded";
      logger.warn("Scheduled run (workflow) skipped", {
        schedule_id: args.schedule_id,
        reason,
        error: err.message,
      });
      return jsonResponse({ status: "skipped", reason });
    }
    if (err instanceof PromptRejectedError) {
      logger.warn("Scheduled run (workflow) skipped", {
        schedule_id: args.schedule_id,
        reason: "prompt_rejected",
      });
      return jsonResponse({ status: "skipped", reason: "prompt_rejected" });
    }
    logger.error("Scheduled run (workflow) reserve failed", {
      schedule_id: args.schedule_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return jsonResponse({ status: "failed", reason: "reserve_error" });
  }

  try {
    const run = await start(
      dispatchWorkflow as unknown as (
        input: DispatchInput,
        prepared: PreparedExecution,
      ) => Promise<{ sessionId: string; messageId: string }>,
      [input, prepared],
    ).catch(async (err: unknown) => {
      // start() failed — message is reserved as 'running'. Mark it failed so
      // it doesn't sit forever waiting for a runner that won't spawn. Same
      // shape as dispatch-shim.ts:182.
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
    });

    // Persist the workflow_run_id on the session row IMMEDIATELY after
    // start() so the cleanup-sessions cron can call WDK's cancel API on
    // the active-watchdog path. Previously this was only written from
    // inside `prepareSandboxAndLaunchStep` — meaning if that step
    // retried for 12+ minutes (the symptom that caused this fix), the
    // watchdog tried to cancel a session whose workflow_run_id was null,
    // fell through to the legacy stop-sandbox path, and left the
    // workflow run zombied for hours iterating its hook waiting for
    // chunks that would never come (cancelled at the WDK 4h expiry).
    // Mirrors the equivalent write in `src/lib/workflows/dispatch-shim.ts`.
    await setWorkflowRunId(
      prepared.session.id,
      input.tenantId,
      `wdk_v1_${run.runId}`,
    ).catch((err) => {
      logger.warn("Scheduled run (workflow): setWorkflowRunId failed (best-effort)", {
        schedule_id: args.schedule_id,
        session_id: prepared.session.id,
        run_id: run.runId,
        error: err instanceof Error ? err.message : String(err),
      });
    });

    // Race the workflow's return value against a maxDuration-30s timeout.
    // Cron functions inherit the platform default (300s on Fluid Compute);
    // the 30s headroom covers post-detach cleanup latency.
    const TIMEOUT_MS = 270_000;
    const timeoutSentinel = Symbol("schedule-detached");
    const result = await Promise.race([
      run.returnValue.then((value) => ({ kind: "terminal" as const, value })),
      new Promise<{ kind: "timeout"; sentinel: symbol }>((resolve) =>
        setTimeout(
          () => resolve({ kind: "timeout", sentinel: timeoutSentinel }),
          TIMEOUT_MS,
        ),
      ),
    ]);

    if (result.kind === "terminal") {
      const out = result.value as { sessionId: string; messageId: string };
      logger.info("Scheduled run (workflow) completed", {
        schedule_id: args.schedule_id,
        run_id: run.runId,
        message_id: out.messageId,
      });

      // Channel delivery — if the schedule has a target_platform +
      // target_channel set, post the agent's reply text there. The
      // CHECK constraint `chk_sched_target_paired` (migration 041)
      // guarantees both fields are set or both null, so seeing one
      // implies the other. PR #51's removal of the legacy drain loop
      // dropped this hookup; this re-wires it onto the workflow path.
      if (args.targetPlatform && args.targetChannel) {
        try {
          const message = await queryOne(
            SessionMessageRow,
            "SELECT * FROM session_messages WHERE id = $1",
            [out.messageId],
          );
          const blobUrl = message?.transcript_blob_url ?? null;
          const text = blobUrl ? await extractAgentReplyText(blobUrl) : null;
          if (text) {
            await deliverScheduleReplyToChannel({
              tenantId: args.tenantId,
              agentId: args.agentId,
              scheduleId: args.schedule_id,
              targetPlatform: args.targetPlatform,
              targetChannel: args.targetChannel,
              text,
            });
          } else {
            logger.warn("Scheduled run (workflow): no reply text to post", {
              schedule_id: args.schedule_id,
              message_id: out.messageId,
              has_blob: !!blobUrl,
            });
          }
        } catch (err) {
          // Best-effort delivery — don't fail the cron if posting fails.
          logger.warn("Scheduled run (workflow): channel delivery threw", {
            schedule_id: args.schedule_id,
            message_id: out.messageId,
            target_platform: args.targetPlatform,
            target_channel: args.targetChannel,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      return jsonResponse({
        status: "completed",
        message_id: out.messageId,
        workflow_run_id: run.runId,
      });
    }

    // Detached — workflow continues; cleanup cron is the backstop.
    logger.info("Scheduled run (workflow) detached at maxDuration", {
      schedule_id: args.schedule_id,
      run_id: run.runId,
    });
    return jsonResponse({
      status: "detached",
      workflow_run_id: run.runId,
    });
  } catch (err) {
    if (err instanceof ConcurrencyLimitError || err instanceof BudgetExceededError) {
      const reason =
        err instanceof ConcurrencyLimitError ? "concurrency_limit" : "budget_exceeded";
      logger.warn("Scheduled run (workflow) skipped", {
        schedule_id: args.schedule_id,
        reason,
        error: err.message,
      });
      return jsonResponse({ status: "skipped", reason });
    }
    if (err instanceof PromptRejectedError) {
      logger.warn("Scheduled run (workflow) skipped", {
        schedule_id: args.schedule_id,
        reason: "prompt_rejected",
      });
      return jsonResponse({ status: "skipped", reason: "prompt_rejected" });
    }
    logger.error("Scheduled run (workflow) failed", {
      schedule_id: args.schedule_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return jsonResponse({ status: "failed", reason: "dispatch_error" });
  }
}
