import { NextRequest } from "next/server";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { query, execute } from "@/db";
import { reconnectSandbox } from "@/lib/sandbox";
import { logger } from "@/lib/logger";
import { z } from "zod";

export const dynamic = "force-dynamic";

// Default timeout + 30 min buffer
const STUCK_THRESHOLD_MS = (10 + 30) * 60 * 1000;

export const GET = withErrorHandler(async (request: NextRequest) => {
  // Verify CRON_SECRET — reject if not configured or mismatched
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return jsonResponse(
      { error: { code: "unauthorized", message: "Invalid cron secret" } },
      401,
    );
  }

  const cutoff = new Date(Date.now() - STUCK_THRESHOLD_MS);

  // Find stuck runs
  const stuckRuns = await query(
    z.object({
      id: z.string(),
      tenant_id: z.string(),
      sandbox_id: z.string().nullable(),
      started_at: z.coerce.string().nullable(),
    }),
    `SELECT id, tenant_id, sandbox_id, started_at FROM runs
     WHERE status IN ('pending', 'running')
       AND created_at < $1`,
    [cutoff.toISOString()],
  );

  let cleaned = 0;
  for (const run of stuckRuns) {
    // Try to stop the sandbox
    if (run.sandbox_id) {
      const sandbox = await reconnectSandbox(run.sandbox_id);
      if (sandbox) {
        await sandbox.stop();
      }
    }

    // Mark as timed_out
    await execute(
      `UPDATE runs SET status = 'timed_out', completed_at = NOW(),
       error_type = 'orphaned_sandbox', error_messages = ARRAY['Run timed out and was cleaned up by cron']
       WHERE id = $1 AND status IN ('pending', 'running')`,
      [run.id],
    );
    cleaned++;

    logger.info("Orphaned run cleaned up", {
      run_id: run.id,
      tenant_id: run.tenant_id,
      sandbox_id: run.sandbox_id,
    });
  }

  logger.info("Sandbox cleanup completed", {
    cleaned,
    threshold_ms: STUCK_THRESHOLD_MS,
  });

  return jsonResponse({ cleaned });
});
