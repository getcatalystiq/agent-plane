import { NextRequest } from "next/server";
import { queryOne } from "@/db";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { verifyCronSecret } from "@/lib/cron-auth";
import { AgentRowInternal, TenantRow, ScheduleRow } from "@/lib/validation";
import { createRun, transitionRunStatus } from "@/lib/runs";
import { prepareRunExecution } from "@/lib/run-executor";
import { getCallbackBaseUrl } from "@/lib/mcp-connections";
import { logger } from "@/lib/logger";
import { z } from "zod";
import type { AgentId, RunId, TenantId, ScheduleId } from "@/lib/types";

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
  const scheduleId = schedule.id as ScheduleId;

  let runId: RunId;
  let remainingBudget: number;
  try {
    const result = await createRun(tenantId, agentId, schedule.prompt, {
      triggeredBy: "schedule",
      scheduleId,
    });
    runId = result.run.id as RunId;
    remainingBudget = result.remainingBudget;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("Scheduled run creation failed", { schedule_id, agent_id: agent.id, error: msg });
    return jsonResponse({ status: "skipped", reason: msg });
  }

  const effectiveBudget = Math.min(agent.max_budget_usd, remainingBudget);

  try {
    await prepareRunExecution({
      agent,
      tenantId,
      runId,
      prompt: schedule.prompt,
      platformApiUrl: getCallbackBaseUrl(),
      effectiveBudget,
      effectiveMaxTurns: agent.max_turns,
      maxRuntimeSeconds: agent.max_runtime_seconds,
    });
  } catch (err) {
    logger.error("Scheduled run sandbox creation failed", {
      schedule_id,
      agent_id: agent.id,
      run_id: runId,
      error: err instanceof Error ? err.message : String(err),
    });
    await transitionRunStatus(runId, tenantId, "pending", "failed", {
      completed_at: new Date().toISOString(),
      result_summary: "Sandbox creation failed",
    }).catch((transitionErr) => {
      logger.error("Failed to transition run to failed status", {
        run_id: runId,
        error: transitionErr instanceof Error ? transitionErr.message : String(transitionErr),
      });
    });
    return jsonResponse({ status: "failed", run_id: runId, reason: "sandbox_creation_error" });
  }

  logger.info("Scheduled run started", { schedule_id, agent_id: agent.id, run_id: runId });
  return jsonResponse({ status: "triggered", run_id: runId });
});
