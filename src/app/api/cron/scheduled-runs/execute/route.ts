import { NextRequest } from "next/server";
import { queryOne } from "@/db";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { verifyCronSecret } from "@/lib/cron-auth";
import { AgentRowInternal, TenantRow } from "@/lib/validation";
import { createRun } from "@/lib/runs";
import { prepareRunExecution } from "@/lib/run-executor";
import { logger } from "@/lib/logger";
import { z } from "zod";
import type { AgentId, RunId, TenantId } from "@/lib/types";

export const dynamic = "force-dynamic";

function getPlatformApiUrl(request: NextRequest): string {
  const vercelUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (vercelUrl) return `https://${vercelUrl}`;
  return new URL(request.url).origin;
}

const ExecuteSchema = z.object({
  agent_id: z.string().uuid(),
});

export const POST = withErrorHandler(async (request: NextRequest) => {
  verifyCronSecret(request);

  const body = await request.json();
  const { agent_id } = ExecuteSchema.parse(body);

  const agent = await queryOne(
    AgentRowInternal,
    "SELECT * FROM agents WHERE id = $1",
    [agent_id],
  );
  if (!agent || !agent.schedule_enabled || !agent.schedule_prompt) {
    logger.warn("Scheduled run skipped: agent not found or not schedulable", { agent_id });
    return jsonResponse({ status: "skipped", reason: "not_schedulable" });
  }

  const tenant = await queryOne(TenantRow, "SELECT * FROM tenants WHERE id = $1", [agent.tenant_id]);
  if (!tenant || tenant.status === "suspended") {
    logger.warn("Scheduled run skipped: tenant suspended or not found", { agent_id, tenant_id: agent.tenant_id });
    return jsonResponse({ status: "skipped", reason: "tenant_suspended" });
  }

  const tenantId = agent.tenant_id as TenantId;
  const agentId = agent.id as AgentId;

  let runId: RunId;
  let remainingBudget: number;
  try {
    const result = await createRun(tenantId, agentId, agent.schedule_prompt, { triggeredBy: "schedule" });
    runId = result.run.id as RunId;
    remainingBudget = result.remainingBudget;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("Scheduled run creation failed", { agent_id, error: msg });
    return jsonResponse({ status: "skipped", reason: msg });
  }

  const effectiveBudget = Math.min(agent.max_budget_usd, remainingBudget);

  // Start the sandbox — the detached runner handles execution and uploads
  // the transcript via /api/internal/runs/:id/transcript when complete.
  // Same pattern as regular runs: prepareRunExecution creates the sandbox,
  // transitions to "running", and the sandbox runs independently.
  try {
    await prepareRunExecution({
      agent,
      tenantId,
      runId,
      prompt: agent.schedule_prompt!,
      platformApiUrl: getPlatformApiUrl(request),
      effectiveBudget,
      effectiveMaxTurns: agent.max_turns,
      maxRuntimeSeconds: agent.max_runtime_seconds,
    });
  } catch (err) {
    logger.error("Scheduled run sandbox creation failed", {
      agent_id,
      run_id: runId,
      error: err instanceof Error ? err.message : String(err),
    });
    return jsonResponse({ status: "failed", run_id: runId, reason: "sandbox_creation_error" });
  }

  logger.info("Scheduled run started", { agent_id, run_id: runId });
  return jsonResponse({ status: "triggered", run_id: runId });
});
