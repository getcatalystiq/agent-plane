import { NextRequest } from "next/server";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { execute, query } from "@/db";
import { reconnectSandbox } from "@/lib/sandbox";
import {
  getIdleSessions,
  getStuckSessions,
  getExpiredSessions,
  getOrphanedSandboxSessions,
  type Session,
} from "@/lib/sessions";
import { deleteSessionFile } from "@/lib/session-files";
import { logger } from "@/lib/logger";
import { verifyCronSecret } from "@/lib/cron-auth";
import { z } from "zod";

export const dynamic = "force-dynamic";

const CREATING_WATCHDOG_MINUTES = 5;
const ACTIVE_WATCHDOG_MINUTES = 30;
const SANDBOX_STOP_CONCURRENCY = 5;

/**
 * FIX #12: bounded-concurrency helper. Runs `fn` for each item with at most
 * `cap` in flight at a time, and uses Promise.allSettled semantics so a
 * single failing handler doesn't abort the rest of the sweep.
 */
async function withConcurrency<T, R>(
  items: T[],
  cap: number,
  fn: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let i = 0;
  const workerCount = Math.min(cap, items.length);
  const workers = Array.from({ length: workerCount }, async () => {
    while (i < items.length) {
      const idx = i++;
      try {
        results[idx] = { status: "fulfilled", value: await fn(items[idx]) };
      } catch (err) {
        results[idx] = { status: "rejected", reason: err };
      }
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Stop a sandbox by id. Returns true on success, false on failure (so the
 * caller can decide whether to clear `sandbox_id` from the DB row).
 *
 * FIX #23: callers MUST gate the `sandbox_id` clear on this returning true —
 * otherwise the orphan sweep cannot retry next tick.
 */
async function stopSandboxBestEffort(
  sandboxId: string | null,
  context: { session_id: string; reason: string },
): Promise<boolean> {
  if (!sandboxId) return true;
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
 * Force a session to `stopped`, regardless of current state, clearing
 * sandbox_id and idle_since. Returns the sandbox_id that was previously on
 * the row (so the caller can stop the sandbox once and only once).
 */
async function forceStop(sessionId: string): Promise<string | null> {
  const result = await query(
    z.object({ sandbox_id: z.string().nullable() }),
    `UPDATE sessions
     SET status = 'stopped', sandbox_id = NULL, idle_since = NULL
     WHERE id = $1 AND status <> 'stopped'
     RETURNING sandbox_id`,
    [sessionId],
  );
  return result[0]?.sandbox_id ?? null;
}

/**
 * CAS variant of forceStop that ONLY transitions sessions in
 * `creating` / `idle` to `stopped`. Used by the expires_at sweep so we never
 * yank an `active` session out from under a streaming runner mid-message.
 *
 * FIX #5 (adv-004): the legacy expires_at sweep called forceStop()
 * unconditionally, killing active sessions and provoking a 409 race in the
 * runner's transcript upload (the runner then writes a synthetic timeout over
 * the freshly-finalized message). Active sessions that are genuinely stuck
 * are now caught by the active-watchdog (30 min) below.
 */
async function casExpiredStop(sessionId: string): Promise<string | null> {
  const result = await query(
    z.object({ sandbox_id: z.string().nullable() }),
    `UPDATE sessions
     SET status = 'stopped', sandbox_id = NULL, idle_since = NULL
     WHERE id = $1 AND status IN ('creating', 'idle')
     RETURNING sandbox_id`,
    [sessionId],
  );
  return result[0]?.sandbox_id ?? null;
}

/**
 * Mark the in-flight `running` message for a session as a watchdog terminal
 * status. Used by both creating-timeout and active-timeout watchdogs.
 */
async function markInFlightMessage(
  sessionId: string,
  toStatus: "failed" | "timed_out",
  errorType: string,
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

export const GET = withErrorHandler(async (request: NextRequest) => {
  verifyCronSecret(request);

  let expiredCleaned = 0;
  let idleCleaned = 0;
  let creatingWatchdog = 0;
  let activeWatchdog = 0;
  let orphansCleaned = 0;

  // 1. Expires_at sweep — stop sandboxes for sessions past expires_at, but
  //    ONLY when the current state is `creating` or `idle`.
  //
  //    FIX #5 (adv-004): we deliberately do NOT touch `active` sessions here.
  //    Killing an active session mid-stream caused the runner's transcript
  //    upload to 409 and overwrite the just-finalized message with a
  //    synthetic timeout. Genuinely stuck active sessions are caught by the
  //    active-watchdog (30 min) at step 4.
  const expired = await getExpiredSessions();
  // FIX #12: parallelize at SANDBOX_STOP_CONCURRENCY and use allSettled.
  const expiredResults = await withConcurrency(expired, SANDBOX_STOP_CONCURRENCY, async (session) => {
    if (session.status === "active") return false;
    const previousSandboxId = await casExpiredStop(session.id);
    if (previousSandboxId === null) return false;
    if (previousSandboxId) {
      await stopSandboxBestEffort(previousSandboxId, {
        session_id: session.id,
        reason: "expired",
      });
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
  expiredCleaned = expiredResults.filter((r) => r.status === "fulfilled" && r.value === true).length;
  for (const r of expiredResults) {
    if (r.status === "rejected") {
      logger.error("Failed to clean up expired session", {
        error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      });
    }
  }

  // 2. Idle-TTL sweep — sessions in `idle` past their per-row
  //    `idle_ttl_seconds`. Atomic CAS `idle → stopped` so we never race with
  //    a concurrent dispatcher `idle → active`.
  const idleSessions = await getIdleSessions();
  const idleResults = await withConcurrency(idleSessions, SANDBOX_STOP_CONCURRENCY, async (session) => {
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
      await stopSandboxBestEffort(previousSandboxId, {
        session_id: session.id,
        reason: "idle_ttl",
      });
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
  idleCleaned = idleResults.filter((r) => r.status === "fulfilled" && r.value === true).length;
  for (const r of idleResults) {
    if (r.status === "rejected") {
      logger.error("Failed to clean up idle session", {
        error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      });
    }
  }

  // 3. Creating watchdog — sandbox boot timed out (>5 min in `creating`).
  const stuckCreating = await getStuckSessions("creating", CREATING_WATCHDOG_MINUTES);
  const creatingResults = await withConcurrency(stuckCreating, SANDBOX_STOP_CONCURRENCY, async (session) => {
    const previousSandboxId = await forceStop(session.id);
    if (previousSandboxId) {
      await stopSandboxBestEffort(previousSandboxId, {
        session_id: session.id,
        reason: "creating_watchdog",
      });
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
  creatingWatchdog = creatingResults.filter((r) => r.status === "fulfilled" && r.value === true).length;
  for (const r of creatingResults) {
    if (r.status === "rejected") {
      logger.error("Failed creating-watchdog cleanup", {
        error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      });
    }
  }

  // 4. Active watchdog — runner crashed silently (>30 min in `active`).
  const stuckActive = await getStuckSessions("active", ACTIVE_WATCHDOG_MINUTES);
  const activeResults = await withConcurrency(stuckActive, SANDBOX_STOP_CONCURRENCY, async (session) => {
    const previousSandboxId = await forceStop(session.id);
    if (previousSandboxId) {
      await stopSandboxBestEffort(previousSandboxId, {
        session_id: session.id,
        reason: "active_watchdog",
      });
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
  activeWatchdog = activeResults.filter((r) => r.status === "fulfilled" && r.value === true).length;
  for (const r of activeResults) {
    if (r.status === "rejected") {
      logger.error("Failed active-watchdog cleanup", {
        error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      });
    }
  }

  // 5. Orphan-sandbox sweep — terminal (`stopped`) sessions that still carry
  //    a non-null `sandbox_id`. With the unified schema sandboxes are tracked
  //    exclusively via `sessions.sandbox_id`; this is defense-in-depth for
  //    finalize paths that wrote `stopped` without clearing the column or
  //    couldn't reach the sandbox API at the time. The Vercel Sandbox SDK
  //    does not expose a global enumeration API — sandboxes that lost their
  //    DB row entirely will be reaped by the platform's own idle TTL.
  const orphaned = await getOrphanedSandboxSessions();
  // FIX #23: only clear `sandbox_id` after the sandbox-stop call succeeds.
  // On failure leave the row alone so the next tick can retry; otherwise the
  // orphan is "lost" — the platform's idle TTL eventually reaps it but until
  // then we've leaked the sandbox.
  const orphanResults = await withConcurrency(orphaned, SANDBOX_STOP_CONCURRENCY, async (session) => {
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
  orphansCleaned = orphanResults.filter((r) => r.status === "fulfilled" && r.value === true).length;
  for (const r of orphanResults) {
    if (r.status === "rejected") {
      logger.error("Failed orphan-sandbox cleanup", {
        error: r.reason instanceof Error ? r.reason.message : String(r.reason),
      });
    }
  }

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
