import { NextRequest, after } from "next/server";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { query, queryOne, execute } from "@/db";
import { verifyCronSecret } from "@/lib/cron-auth";
import { computeNextRunAt, buildScheduleConfig } from "@/lib/schedule";
import { createRun } from "@/lib/runs";
import { executeRunInBackground } from "@/lib/run-executor";
import { logger } from "@/lib/logger";
import { z } from "zod";
import { AgentRowInternal, TenantRow, ScheduleFrequencySchema } from "@/lib/validation";
import type { AgentId, RunId, TenantId } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CLAIM_LIMIT = 50;

// The claim query guarantees schedule_enabled = true, so these fields are non-null
// per the DB CHECK constraints (chk_schedule_time_required, chk_schedule_day_of_week_weekly).
const DueAgentRow = z.object({
  id: z.string(),
  tenant_id: z.string(),
  schedule_frequency: ScheduleFrequencySchema,
  schedule_time: z.string().nullable(),
  schedule_day_of_week: z.coerce.number().nullable(),
  timezone: z.string(),
});

export const GET = withErrorHandler(async (request: NextRequest) => {
  verifyCronSecret(request);

  // Stuck-job reaper: recover agents stuck with NULL schedule_next_run_at.
  // Recompute next_run_at from NOW() to guarantee a future timestamp.
  // Covers both agents with schedule_last_run_at set and newly enabled agents
  // whose first dispatch failed (schedule_last_run_at IS NULL).
  const stuckAgents = await query(
    DueAgentRow,
    `SELECT a.id, a.schedule_frequency, a.schedule_time, a.schedule_day_of_week,
            COALESCE((SELECT t.timezone FROM tenants t WHERE t.id = a.tenant_id), 'UTC') AS timezone,
            a.tenant_id
     FROM agents a
     WHERE a.schedule_enabled = true
       AND a.schedule_frequency != 'manual'
       AND a.schedule_next_run_at IS NULL
       AND (a.schedule_last_run_at < NOW() - INTERVAL '5 minutes'
            OR a.schedule_last_run_at IS NULL)`,
  );
  if (stuckAgents.length > 0) {
    const stuckIds: string[] = [];
    const stuckNextRunAts: (string | null)[] = [];
    for (const agent of stuckAgents) {
      try {
        const config = buildScheduleConfig(agent.schedule_frequency, agent.schedule_time, agent.schedule_day_of_week);
        const nextRun = computeNextRunAt(config, agent.timezone, new Date());
        stuckIds.push(agent.id);
        stuckNextRunAts.push(nextRun?.toISOString() ?? null);
      } catch (err) {
        logger.error("Stuck-job reaper: failed to recompute next run", {
          agent_id: agent.id,
          error: err instanceof Error ? err.message : String(err),
        });
        // Push null so the agent doesn't stay stuck forever
        stuckIds.push(agent.id);
        stuckNextRunAts.push(null);
      }
    }
    if (stuckIds.length > 0) {
      await execute(
        `UPDATE agents SET schedule_next_run_at = v.next_run_at::timestamptz
         FROM unnest($1::uuid[], $2::text[]) AS v(id, next_run_at)
         WHERE agents.id = v.id`,
        [stuckIds, stuckNextRunAts],
      );
    }
  }

  // Claim due agents atomically with FOR UPDATE SKIP LOCKED
  const dueAgents = await query(
    DueAgentRow,
    `WITH due AS (
      SELECT a.id
      FROM agents a
      WHERE a.schedule_enabled = true
        AND a.schedule_next_run_at <= NOW()
      ORDER BY a.schedule_next_run_at ASC
      LIMIT $1
      FOR UPDATE OF a SKIP LOCKED
    )
    UPDATE agents
    SET schedule_last_run_at = NOW(),
        schedule_next_run_at = NULL
    FROM due
    WHERE agents.id = due.id
    RETURNING agents.id, agents.tenant_id,
              agents.schedule_frequency, agents.schedule_time,
              agents.schedule_day_of_week,
              (SELECT t.timezone FROM tenants t WHERE t.id = agents.tenant_id) AS timezone`,
    [CLAIM_LIMIT],
  );

  if (dueAgents.length === 0) {
    return jsonResponse({ triggered: 0, failed: 0 });
  }

  // Compute next_run_at for each claimed agent
  const ids: string[] = [];
  const nextRunAts: (string | null)[] = [];
  for (const agent of dueAgents) {
    try {
      const config = buildScheduleConfig(agent.schedule_frequency, agent.schedule_time, agent.schedule_day_of_week);
      const nextRun = computeNextRunAt(config, agent.timezone);
      ids.push(agent.id);
      nextRunAts.push(nextRun?.toISOString() ?? null);
    } catch (err) {
      logger.warn("Failed to compute next run", {
        agent_id: agent.id,
        error: err instanceof Error ? err.message : String(err),
      });
      ids.push(agent.id);
      nextRunAts.push(null);
    }
  }

  // Batch update schedule_next_run_at in a single query
  await execute(
    `UPDATE agents SET schedule_next_run_at = v.next_run_at::timestamptz
     FROM unnest($1::uuid[], $2::text[]) AS v(id, next_run_at)
     WHERE agents.id = v.id`,
    [ids, nextRunAts],
  );

  // Execute each claimed agent's scheduled run via after()
  const platformApiUrl = new URL(request.url).origin;
  let triggered = 0;
  let failed = 0;

  for (const dueAgent of dueAgents) {
    try {
      const result = await dispatchScheduledRun(dueAgent.id, platformApiUrl);
      if (result === "triggered") {
        triggered++;
      } else {
        failed++;
      }
    } catch (err) {
      failed++;
      logger.warn("Scheduled run dispatch failed", {
        agent_id: dueAgent.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info("Scheduled runs dispatched", {
    claimed: dueAgents.length,
    triggered,
    failed,
  });

  return jsonResponse({ triggered, failed, claimed: dueAgents.length });
});

async function dispatchScheduledRun(
  agentId: string,
  platformApiUrl: string,
): Promise<"triggered" | "skipped"> {
  const agent = await queryOne(
    AgentRowInternal,
    "SELECT * FROM agents WHERE id = $1",
    [agentId],
  );
  if (!agent || !agent.schedule_enabled || !agent.schedule_prompt) {
    logger.warn("Scheduled run skipped: agent not found or not schedulable", { agent_id: agentId });
    return "skipped";
  }

  const tenant = await queryOne(TenantRow, "SELECT * FROM tenants WHERE id = $1", [agent.tenant_id]);
  if (!tenant || tenant.status === "suspended") {
    logger.warn("Scheduled run skipped: tenant suspended or not found", { agent_id: agentId, tenant_id: agent.tenant_id });
    return "skipped";
  }

  const tenantId = agent.tenant_id as TenantId;

  let runId: RunId;
  let remainingBudget: number;
  try {
    const result = await createRun(tenantId, agentId as AgentId, agent.schedule_prompt, { triggeredBy: "schedule" });
    runId = result.run.id as RunId;
    remainingBudget = result.remainingBudget;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.warn("Scheduled run creation failed", { agent_id: agentId, error: msg });
    return "skipped";
  }

  const effectiveBudget = Math.min(agent.max_budget_usd, remainingBudget);

  // Execute the run in after() so we return quickly
  after(async () => {
    try {
      await executeRunInBackground({
        agent,
        tenantId,
        runId,
        prompt: agent.schedule_prompt!,
        platformApiUrl,
        effectiveBudget,
        effectiveMaxTurns: agent.max_turns,
      });
    } catch (err) {
      logger.error("Scheduled run execution failed", {
        agent_id: agentId,
        run_id: runId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  logger.info("Scheduled run triggered", { agent_id: agentId, run_id: runId });
  return "triggered";
}
