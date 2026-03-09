import { NextRequest } from "next/server";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { getPool } from "@/db";
import { verifyCronSecret } from "@/lib/cron-auth";
import { batchComputeNextRuns } from "@/lib/schedule";
import { getCallbackBaseUrl } from "@/lib/mcp-connections";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import { z } from "zod";
import { ScheduleFrequencySchema } from "@/lib/validation";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const CLAIM_LIMIT = 50;
const DISPATCH_CONCURRENCY = 10;

const DueScheduleRow = z.object({
  id: z.string(),
  agent_id: z.string(),
  tenant_id: z.string(),
  frequency: ScheduleFrequencySchema,
  time: z.string().nullable(),
  day_of_week: z.coerce.number().nullable(),
  timezone: z.string(),
});

export const GET = withErrorHandler(async (request: NextRequest) => {
  verifyCronSecret(request);

  const pool = getPool();
  const client = await pool.connect();
  let dueSchedules: z.infer<typeof DueScheduleRow>[] = [];

  try {
    await client.query("BEGIN");

    // Stuck-job reaper: recover schedules stuck with NULL next_run_at
    const stuckResult = await client.query(
      `SELECT s.id, s.agent_id, s.tenant_id, s.frequency, s.time, s.day_of_week,
              COALESCE((SELECT t.timezone FROM tenants t WHERE t.id = s.tenant_id), 'UTC') AS timezone
       FROM schedules s
       WHERE s.enabled = true
         AND s.frequency != 'manual'
         AND s.next_run_at IS NULL
         AND (s.last_run_at < NOW() - INTERVAL '5 minutes'
              OR s.last_run_at IS NULL)`,
    );
    const stuckSchedules = stuckResult.rows.map((r: unknown) => DueScheduleRow.parse(r));

    if (stuckSchedules.length > 0) {
      const { ids: stuckIds, nextRunAts: stuckNextRunAts } = batchComputeNextRuns(stuckSchedules, {
        fromDate: new Date(),
        onError: (id, err) => {
          logger.error("Stuck-job reaper: failed to recompute next run, skipping", {
            schedule_id: id,
            error: err instanceof Error ? (err as Error).message : String(err),
          });
        },
      });
      if (stuckIds.length > 0) {
        await client.query(
          `UPDATE schedules SET next_run_at = v.next_run_at::timestamptz
           FROM unnest($1::uuid[], $2::text[]) AS v(id, next_run_at)
           WHERE schedules.id = v.id`,
          [stuckIds, stuckNextRunAts],
        );
      }
    }

    // Claim due schedules with FOR UPDATE SKIP LOCKED.
    // Two-step: first pick one schedule per agent, then lock those specific rows.
    const dueResult = await client.query(
      `WITH candidates AS (
        SELECT DISTINCT ON (s.agent_id) s.id
        FROM schedules s
        WHERE s.enabled = true
          AND s.next_run_at <= NOW()
        ORDER BY s.agent_id, s.next_run_at ASC
      ),
      locked AS (
        SELECT s.id
        FROM schedules s
        JOIN candidates c ON c.id = s.id
        FOR UPDATE OF s SKIP LOCKED
        LIMIT $1
      )
      UPDATE schedules
      SET last_run_at = NOW(),
          next_run_at = NULL
      FROM locked
      WHERE schedules.id = locked.id
      RETURNING schedules.id, schedules.agent_id, schedules.tenant_id,
                schedules.frequency, schedules.time, schedules.day_of_week,
                (SELECT t.timezone FROM tenants t WHERE t.id = schedules.tenant_id) AS timezone`,
      [CLAIM_LIMIT],
    );
    dueSchedules = dueResult.rows.map((r: unknown) => DueScheduleRow.parse(r));

    // Recompute next_run_at for claimed schedules within the same transaction
    if (dueSchedules.length > 0) {
      const { ids, nextRunAts } = batchComputeNextRuns(dueSchedules);

      await client.query(
        `UPDATE schedules SET next_run_at = v.next_run_at::timestamptz
         FROM unnest($1::uuid[], $2::text[]) AS v(id, next_run_at)
         WHERE schedules.id = v.id`,
        [ids, nextRunAts],
      );
    }

    await client.query("COMMIT");
  } catch (err) {
    try { await client.query("ROLLBACK"); } catch { /* connection may already be broken */ }
    throw err;
  } finally {
    client.release();
  }

  if (dueSchedules.length === 0) {
    return jsonResponse({ triggered: 0, failed: 0 });
  }

  // Dispatch to executor endpoint — fire-and-forget via separate function invocations
  const baseUrl = getCallbackBaseUrl();
  const cronSecret = getEnv().CRON_SECRET;
  let triggered = 0;
  let failed = 0;

  for (let i = 0; i < dueSchedules.length; i += DISPATCH_CONCURRENCY) {
    const batch = dueSchedules.slice(i, i + DISPATCH_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((sched) =>
        fetch(`${baseUrl}/api/cron/scheduled-runs/execute`, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${cronSecret}`,
          },
          body: JSON.stringify({ schedule_id: sched.id }),
        }),
      ),
    );

    for (let j = 0; j < results.length; j++) {
      const result = results[j];
      if (result.status === "fulfilled" && result.value.ok) {
        triggered++;
      } else {
        failed++;
        const sched = batch[j];
        const reason = result.status === "rejected"
          ? result.reason
          : `HTTP ${result.value.status}`;
        logger.warn("Executor dispatch failed", {
          schedule_id: sched.id,
          agent_id: sched.agent_id,
          error: String(reason),
        });
      }
    }
  }

  logger.info("Scheduled runs dispatched", {
    claimed: dueSchedules.length,
    triggered,
    failed,
  });

  return jsonResponse({ triggered, failed, claimed: dueSchedules.length });
});
