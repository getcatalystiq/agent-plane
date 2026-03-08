import { NextRequest } from "next/server";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { query, execute } from "@/db";
import { reconnectSandbox } from "@/lib/sandbox";
import { logger } from "@/lib/logger";
import { z } from "zod";
import { verifyCronSecret } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";

// Buffer added beyond agent's max_runtime_seconds before marking as stuck
const BUFFER_SECONDS = 120;
// Absolute fallback for runs without an agent (shouldn't happen, but fail-safe)
const FALLBACK_THRESHOLD_SECONDS = 10 * 60 + BUFFER_SECONDS;

export const GET = withErrorHandler(async (request: NextRequest) => {
  verifyCronSecret(request);

  // Find stuck runs: created longer ago than their agent's max_runtime + buffer
  const stuckRuns = await query(
    z.object({
      id: z.string(),
      tenant_id: z.string(),
      sandbox_id: z.string().nullable(),
      started_at: z.coerce.string().nullable(),
    }),
    `SELECT r.id, r.tenant_id, r.sandbox_id, r.started_at FROM runs r
     LEFT JOIN agents a ON a.id = r.agent_id
     WHERE r.status IN ('pending', 'running')
       AND r.created_at < NOW() - INTERVAL '1 second' * (COALESCE(a.max_runtime_seconds, $1) + $2)`,
    [FALLBACK_THRESHOLD_SECONDS, BUFFER_SECONDS],
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

  logger.info("Sandbox cleanup completed", { cleaned });

  return jsonResponse({ cleaned });
});
