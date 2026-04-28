import { NextRequest } from "next/server";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { execute, query } from "@/db";
import { reconnectSandbox } from "@/lib/sandbox";
import { invalidateSandboxHandle } from "@/lib/dispatcher";
import {
  getIdleSessions,
  getStuckSessions,
  getExpiredSessions,
  getOrphanedSandboxSessions,
  forceStopSession,
  casExpireToStopped,
  type Session,
  type CleanupReason,
  type CleanupErrorType,
} from "@/lib/sessions";
import { deleteSessionFile } from "@/lib/session-files";
import { logger } from "@/lib/logger";
import { verifyCronSecret } from "@/lib/cron-auth";
import { withConcurrency } from "@/lib/utils";
import { z } from "zod";

export const dynamic = "force-dynamic";

const CREATING_WATCHDOG_MINUTES = 5;
const ACTIVE_WATCHDOG_MINUTES = 30;
const SANDBOX_STOP_CONCURRENCY = 5;

/**
 * Stop a sandbox by id. Returns true on success, false on failure (so the
 * caller can decide whether to clear `sandbox_id` from the DB row).
 *
 * FIX #23: callers MUST gate the `sandbox_id` clear on this returning true —
 * otherwise the orphan sweep cannot retry next tick.
 */
async function stopSandboxBestEffort(
  sandboxId: string | null,
  context: { session_id: string; reason: CleanupReason },
): Promise<boolean> {
  if (!sandboxId) return true;
  // OPTIMIZATION A — drop any cached sandbox handle for this session so
  // subsequent dispatches don't reuse a handle whose sandbox we just stopped.
  invalidateSandboxHandle(context.session_id);
  try {
    const sandbox = await reconnectSandbox(sandboxId);
    if (sandbox) await sandbox.stop();
    return true;
  } catch (err) {
    logger.warn("Failed to stop sandbox during cleanup", {
      ...context,
      sandbox_id: sandboxId,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/**
 * Mark the in-flight `running` message for a session as a watchdog terminal
 * status. Used by both creating-timeout and active-timeout watchdogs.
 */
async function markInFlightMessage(
  sessionId: string,
  toStatus: "failed" | "timed_out",
  errorType: CleanupErrorType,
  errorMessage: string,
): Promise<void> {
  await execute(
    `UPDATE session_messages
     SET status = $2,
         completed_at = NOW(),
         error_type = $3,
         error_messages = ARRAY[$4]::text[]
     WHERE session_id = $1 AND status = 'running'`,
    [sessionId, toStatus, errorType, errorMessage],
  );
}

/**
 * Best-effort blob cleanup for terminal sessions. Persistent sessions back up
 * their SDK session JSON; on stop we remove that backup.
 */
async function cleanupBlob(session: Pick<Session, "session_blob_url">) {
  if (session.session_blob_url) {
    try {
      await deleteSessionFile(session.session_blob_url);
    } catch (err) {
      logger.warn("Failed to delete session blob", {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

function countSweepResults<T>(
  results: PromiseSettledResult<T | false>[],
  errorLabel: string,
): number {
  let cleaned = 0;
  for (const r of results) {
    if (r.status === "fulfilled" && r.value === true) {
      cleaned++;
    } else if (r.status === "rejected") {
      logger.error(errorLabel, {
        error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      });
    }
  }
  return cleaned;
}

// Expires_at sweep — ONLY transitions `creating` / `idle` sessions, never
// `active` (FIX #5 adv-004). Genuinely stuck active sessions are caught by
// the active-watchdog (30 min) below.
async function sweepExpired(): Promise<number> {
  const expired = await getExpiredSessions();
  const results = await withConcurrency(expired, SANDBOX_STOP_CONCURRENCY, async (session) => {
    if (session.status === "active") return false;
    const previousSandboxId = await casExpireToStopped(session.id);
    if (previousSandboxId === null) return false;
    if (previousSandboxId) {
      await stopSandboxBestEffort(previousSandboxId, { session_id: session.id, reason: "expired" });
    }
    await markInFlightMessage(
      session.id,
      "timed_out",
      "session_expired",
      "Session exceeded 4h wall-clock cap; stopped by cleanup cron.",
    );
    await cleanupBlob(session);
    logger.info("Expired session cleaned up", {
      session_id: session.id,
      tenant_id: session.tenant_id,
      expires_at: session.expires_at,
      previous_status: session.status,
    });
    return true;
  });
  return countSweepResults(results, "Failed to clean up expired session");
}

// Idle-TTL sweep — sessions in `idle` past their per-row `idle_ttl_seconds`.
// Atomic CAS `idle → stopped` so we never race with a concurrent dispatcher
// `idle → active`.
async function sweepIdle(): Promise<number> {
  const idleSessions = await getIdleSessions();
  const results = await withConcurrency(idleSessions, SANDBOX_STOP_CONCURRENCY, async (session) => {
    const cas = await query(
      z.object({ sandbox_id: z.string().nullable() }),
      `UPDATE sessions
       SET status = 'stopped', sandbox_id = NULL, idle_since = NULL
       WHERE id = $1 AND status = 'idle'
       RETURNING sandbox_id`,
      [session.id],
    );
    if (cas.length === 0) return false;
    const previousSandboxId = cas[0]?.sandbox_id ?? null;
    if (previousSandboxId) {
      await stopSandboxBestEffort(previousSandboxId, { session_id: session.id, reason: "idle_ttl" });
    }
    await cleanupBlob(session);
    logger.info("Idle session cleaned up", {
      session_id: session.id,
      tenant_id: session.tenant_id,
      idle_since: session.idle_since,
      idle_ttl_seconds: session.idle_ttl_seconds,
    });
    return true;
  });
  return countSweepResults(results, "Failed to clean up idle session");
}

async function sweepCreatingWatchdog(): Promise<number> {
  const stuckCreating = await getStuckSessions("creating", CREATING_WATCHDOG_MINUTES);
  const results = await withConcurrency(stuckCreating, SANDBOX_STOP_CONCURRENCY, async (session) => {
    const previousSandboxId = await forceStopSession(session.id);
    if (previousSandboxId) {
      await stopSandboxBestEffort(previousSandboxId, { session_id: session.id, reason: "creating_watchdog" });
    }
    await markInFlightMessage(
      session.id,
      "failed",
      "watchdog_creating_timeout",
      `Session stuck in 'creating' for >${CREATING_WATCHDOG_MINUTES} minutes.`,
    );
    await cleanupBlob(session);
    logger.warn("Creating-watchdog fired", {
      session_id: session.id,
      tenant_id: session.tenant_id,
      created_at: session.created_at,
    });
    return true;
  });
  return countSweepResults(results, "Failed creating-watchdog cleanup");
}

async function sweepActiveWatchdog(): Promise<number> {
  const stuckActive = await getStuckSessions("active", ACTIVE_WATCHDOG_MINUTES);
  const results = await withConcurrency(stuckActive, SANDBOX_STOP_CONCURRENCY, async (session) => {
    const previousSandboxId = await forceStopSession(session.id);
    if (previousSandboxId) {
      await stopSandboxBestEffort(previousSandboxId, { session_id: session.id, reason: "active_watchdog" });
    }
    await markInFlightMessage(
      session.id,
      "timed_out",
      "watchdog_active_timeout",
      `Session stuck in 'active' for >${ACTIVE_WATCHDOG_MINUTES} minutes; runner presumed dead.`,
    );
    await cleanupBlob(session);
    logger.warn("Active-watchdog fired", {
      session_id: session.id,
      tenant_id: session.tenant_id,
      updated_at: session.updated_at,
    });
    return true;
  });
  return countSweepResults(results, "Failed active-watchdog cleanup");
}

// Orphan-sandbox sweep — terminal (`stopped`) sessions that still carry a
// non-null `sandbox_id`. Defense-in-depth for finalize paths that wrote
// `stopped` without clearing the column. FIX #23: only clear `sandbox_id`
// after the stop succeeds; on failure leave the row alone so the next tick
// can retry.
async function sweepOrphans(): Promise<number> {
  const orphaned = await getOrphanedSandboxSessions();
  const results = await withConcurrency(orphaned, SANDBOX_STOP_CONCURRENCY, async (session) => {
    const stopped = await stopSandboxBestEffort(session.sandbox_id, {
      session_id: session.id,
      reason: "orphan_sandbox",
    });
    if (!stopped) return false;
    await execute(
      `UPDATE sessions SET sandbox_id = NULL
       WHERE id = $1 AND status = 'stopped'`,
      [session.id],
    );
    logger.info("Orphan sandbox stopped", {
      session_id: session.id,
      tenant_id: session.tenant_id,
      sandbox_id: session.sandbox_id,
    });
    return true;
  });
  return countSweepResults(results, "Failed orphan-sandbox cleanup");
}

export const GET = withErrorHandler(async (request: NextRequest) => {
  verifyCronSecret(request);

  // Sweeps operate on disjoint state subsets (different status filters), so
  // there is no race risk in running them concurrently. ~5x latency reduction
  // at peak load.
  const [
    expiredCleaned,
    idleCleaned,
    creatingWatchdog,
    activeWatchdog,
    orphansCleaned,
  ] = await Promise.all([
    sweepExpired(),
    sweepIdle(),
    sweepCreatingWatchdog(),
    sweepActiveWatchdog(),
    sweepOrphans(),
  ]);

  const total = expiredCleaned + idleCleaned + creatingWatchdog + activeWatchdog + orphansCleaned;
  logger.info("Session cleanup completed", {
    expired_cleaned: expiredCleaned,
    idle_cleaned: idleCleaned,
    creating_watchdog: creatingWatchdog,
    active_watchdog: activeWatchdog,
    orphans_cleaned: orphansCleaned,
    total,
  });

  return jsonResponse({
    cleaned: total,
    expired: expiredCleaned,
    idle: idleCleaned,
    creating_watchdog: creatingWatchdog,
    active_watchdog: activeWatchdog,
    orphans: orphansCleaned,
  });
});
