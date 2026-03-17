import { NextRequest } from "next/server";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { execute } from "@/db";
import { reconnectSandbox } from "@/lib/sandbox";
import { getIdleSessions, getStuckSessions } from "@/lib/sessions";
import { deleteSessionFile } from "@/lib/session-files";
import { logger } from "@/lib/logger";
import { verifyCronSecret } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";

const IDLE_TIMEOUT_MINUTES = 10;

export const GET = withErrorHandler(async (request: NextRequest) => {
  verifyCronSecret(request);

  let cleaned = 0;

  // 1. Clean up idle sessions past threshold
  const idleSessions = await getIdleSessions(IDLE_TIMEOUT_MINUTES);

  for (const session of idleSessions) {
    try {
      // Lock row to prevent race with incoming messages
      const locked = await execute(
        `UPDATE sessions SET status = 'stopped', sandbox_id = NULL, idle_since = NULL
         WHERE id = $1 AND status = 'idle'`,
        [session.id],
      );

      if (locked.rowCount === 0) {
        // Another process already handled this session (message arrived, or another cron instance)
        continue;
      }

      // Stop sandbox
      if (session.sandbox_id) {
        try {
          const sandbox = await reconnectSandbox(session.sandbox_id);
          if (sandbox) await sandbox.stop();
        } catch (err) {
          logger.warn("Failed to stop session sandbox", {
            session_id: session.id,
            sandbox_id: session.sandbox_id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Delete session file backup from Vercel Blob
      if (session.session_blob_url) {
        await deleteSessionFile(session.session_blob_url);
      }

      cleaned++;
      logger.info("Idle session cleaned up", {
        session_id: session.id,
        tenant_id: session.tenant_id,
        sandbox_id: session.sandbox_id,
        idle_since: session.idle_since,
      });
    } catch (err) {
      logger.error("Failed to clean up idle session", {
        session_id: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 2. Watchdog: clean up stuck sessions
  const stuckSessions = await getStuckSessions();

  for (const session of stuckSessions) {
    try {
      await execute(
        `UPDATE sessions SET status = 'stopped', sandbox_id = NULL, idle_since = NULL
         WHERE id = $1 AND status IN ('creating', 'active')`,
        [session.id],
      );

      if (session.sandbox_id) {
        try {
          const sandbox = await reconnectSandbox(session.sandbox_id);
          if (sandbox) await sandbox.stop();
        } catch (err) {
          logger.warn("Failed to stop stuck session sandbox", {
            session_id: session.id,
            sandbox_id: session.sandbox_id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Delete session file backup from Vercel Blob
      if (session.session_blob_url) {
        await deleteSessionFile(session.session_blob_url);
      }

      cleaned++;
      logger.warn("Stuck session cleaned up", {
        session_id: session.id,
        tenant_id: session.tenant_id,
        status: session.status,
        created_at: session.created_at,
      });
    } catch (err) {
      logger.error("Failed to clean up stuck session", {
        session_id: session.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  logger.info("Session cleanup completed", {
    idle_cleaned: idleSessions.length,
    stuck_cleaned: stuckSessions.length,
    total_cleaned: cleaned,
  });

  return jsonResponse({
    cleaned,
    idle: idleSessions.length,
    stuck: stuckSessions.length,
  });
});
