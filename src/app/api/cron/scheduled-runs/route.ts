import { NextRequest } from "next/server";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { query, execute } from "@/db";
import { verifyCronSecret } from "@/lib/cron-auth";
import { computeNextRunAt, buildScheduleConfig } from "@/lib/schedule";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { z } from "zod";
import { ScheduleFrequencySchema } from "@/lib/validation";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CLAIM_LIMIT = 50;
const DISPATCH_CONCURRENCY = 10;

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

/**
 * Resolve the base URL for dispatching to the executor endpoint.
 * On Vercel, VERCEL_PROJECT_PRODUCTION_URL gives the stable production domain
 * (e.g. "agentplane-nine.vercel.app"), avoiding issues with deployment-specific
 * or internal URLs that may not route correctly for self-referencing fetches.
 */
function getDispatchBaseUrl(request: NextRequest): string {
  const vercelUrl = process.env.VERCEL_PROJECT_PRODUCTION_URL;
  if (vercelUrl) {
    return `https://${vercelUrl}`;
  }
  return new URL(request.url).origin;
}

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

  // Dispatch to executor endpoint — fire-and-forget via separate function invocations.
  // Each executor gets its own maxDuration: 300 for the full sandbox run.
  const baseUrl = getDispatchBaseUrl(request);
  const cronSecret = getEnv().CRON_SECRET;
  let triggered = 0;
  let failed = 0;

  for (let i = 0; i < dueAgents.length; i += DISPATCH_CONCURRENCY) {
    const batch = dueAgents.slice(i, i + DISPATCH_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((agent) =>
        fetch(`${baseUrl}/api/cron/scheduled-runs/execute`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cronSecret}`,
          },
          body: JSON.stringify({ agent_id: agent.id }),
        }),
      ),
    );

    for (const result of results) {
      if (result.status === "fulfilled" && result.value.ok) {
        triggered++;
      } else {
        failed++;
        const reason = result.status === "rejected"
          ? result.reason
          : `HTTP ${result.value.status}`;
        logger.warn("Executor dispatch failed", { error: String(reason) });
      }
    }
  }

  logger.info("Scheduled runs dispatched", {
    claimed: dueAgents.length,
    triggered,
    failed,
  });

  return jsonResponse({ triggered, failed, claimed: dueAgents.length });
});
