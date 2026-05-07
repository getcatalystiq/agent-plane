import { NextRequest } from "next/server";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { execute, query } from "@/db";
import { reconnectSandbox, salvageRunnerTranscript } from "@/lib/sandbox";
import { invalidateSandboxHandle } from "@/lib/dispatcher";
import { WORKFLOW_RUN_ID_PREFIX } from "@/lib/types";
import {
  getIdleSessions,
  getStuckCreatingSessions,
  getStuckActiveSessions,
  getExpiredSessions,
  getOrphanedSandboxSessions,
  getActiveSessionsWithoutRunningMessage,
  forceStopSession,
  casExpireToStopped,
  type Session,
  type CleanupReason,
  type CleanupErrorType,
} from "@/lib/sessions";
import { deleteSessionFile } from "@/lib/session-files";
import { uploadTranscript } from "@/lib/transcripts";
import { logger } from "@/lib/logger";
import { verifyCronSecret } from "@/lib/cron-auth";
import { withConcurrency } from "@/lib/utils";
import { z } from "zod";

export const dynamic = "force-dynamic";

const CREATING_WATCHDOG_MINUTES = 5;
// The active-watchdog uses each agent's `max_runtime_seconds` plus this grace
// (covers post-termination upload latency + the 5-min cron cadence). An agent
// configured for 600s (default) gets caught at ~600+grace; an agent configured
// for 3600s gets caught at ~3600+grace. Agents with very short runtimes still
// see the cron's 5-min tick floor in practice.
const ACTIVE_WATCHDOG_GRACE_SECONDS = 120;
const ACTIVE_NO_RUNNING_MESSAGE_MINUTES = 5;
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
 * status. Used by both creating-timeout and active-timeout watchdogs. When a
 * salvaged transcript URL is supplied we attach it so the user can still see
 * what the runner executed before the watchdog fired.
 */
async function markInFlightMessage(
  sessionId: string,
  toStatus: "failed" | "timed_out",
  errorType: CleanupErrorType,
  errorMessage: string,
  transcriptBlobUrl: string | null = null,
): Promise<void> {
  if (transcriptBlobUrl) {
    await execute(
      `UPDATE session_messages
       SET status = $2,
           completed_at = NOW(),
           error_type = $3,
           error_messages = ARRAY[$4]::text[],
           transcript_blob_url = $5
       WHERE session_id = $1 AND status = 'running'`,
      [sessionId, toStatus, errorType, errorMessage, transcriptBlobUrl],
    );
    return;
  }
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
 * Find the in-flight `running` message id for a session, if any. The
 * watchdog sweeps use this to address the salvage upload to the right blob
 * path. Returns null when no running message exists (e.g. a `creating`
 * session whose runner hasn't started yet).
 */
async function findRunningMessageId(sessionId: string): Promise<string | null> {
  const rows = await query(
    z.object({ id: z.string() }),
    `SELECT id FROM session_messages
     WHERE session_id = $1 AND status = 'running'
     ORDER BY started_at DESC
     LIMIT 1`,
    [sessionId],
  );
  return rows[0]?.id ?? null;
}

/**
 * Best-effort transcript salvage from a still-alive sandbox. Reads the
 * runner's NDJSON transcript file and uploads it to blob storage. Returns
 * the blob URL on success; null on any failure (sandbox gone, file missing,
 * upload error). Always non-fatal — callers proceed to stop the sandbox
 * regardless.
 */
async function salvageAndUpload(
  sandboxId: string,
  tenantId: string,
  messageId: string,
  context: { session_id: string; reason: CleanupReason },
): Promise<string | null> {
  try {
    const content = await salvageRunnerTranscript(sandboxId, messageId);
    if (!content) return null;
    const blobUrl = await uploadTranscript(tenantId, messageId, content);
    logger.info("Watchdog salvaged transcript", {
      ...context,
      sandbox_id: sandboxId,
      message_id: messageId,
      transcript_size: content.length,
      transcript_blob_url: blobUrl,
    });
    return blobUrl;
  } catch (err) {
    logger.warn("Watchdog transcript salvage failed (non-fatal)", {
      ...context,
      sandbox_id: sandboxId,
      message_id: messageId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
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

/**
 * U6: try the workflow-cancel path first. Returns true if the workflow
 * reached terminal status within `awaitMs` so the caller skips the
 * legacy salvage-and-stop branch (the workflow's finalize step handled
 * it). Returns false on any of:
 *   - No workflow_run_id (legacy session)
 *   - Malformed runId (post-rollback)
 *   - getRun(runId).cancel() throws
 *   - Run doesn't reach terminal status within timeout
 *
 * Caller falls through to the legacy direct-stop path on false. This is
 * the belt-and-suspenders fallback the plan specifies for cron timeouts:
 * the row ends up `stopped` either way.
 */
async function tryWorkflowCancel(
  session: { id: string; tenant_id: string; workflow_run_id?: string | null },
  reason: string,
  awaitMs = 30_000,
): Promise<boolean> {
  if (!session.workflow_run_id) return false;
  if (!session.workflow_run_id.startsWith(WORKFLOW_RUN_ID_PREFIX)) {
    logger.warn("cleanup: unexpected workflow_run_id format; falling back to legacy", {
      session_id: session.id,
      stored: session.workflow_run_id,
    });
    return false;
  }
  const rawRunId = session.workflow_run_id.slice(WORKFLOW_RUN_ID_PREFIX.length);
  const TERMINAL = new Set(["completed", "failed", "cancelled", "stopped"]);
  try {
    const { getRun } = await import("workflow/api");
    const run = getRun(rawRunId);
    await run.cancel();
    const start = Date.now();
    while (Date.now() - start < awaitMs) {
      const status = await run.status;
      if (TERMINAL.has(status as string)) {
        logger.info("cleanup: workflow run reached terminal via cancel", {
          session_id: session.id,
          run_id: rawRunId,
          reason,
          status,
          elapsed_ms: Date.now() - start,
        });
        return true;
      }
      await new Promise((r) => setTimeout(r, 1_000));
    }
    logger.warn("cleanup: workflow cancel timeout — falling back to legacy", {
      session_id: session.id,
      run_id: rawRunId,
      reason,
      timeout_ms: awaitMs,
    });
    return false;
  } catch (err) {
    logger.warn("cleanup: workflow cancel threw — falling back to legacy", {
      session_id: session.id,
      run_id: rawRunId,
      reason,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
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
// the active-watchdog below (per-agent threshold).
async function sweepExpired(): Promise<number> {
  const expired = await getExpiredSessions();
  const results = await withConcurrency(expired, SANDBOX_STOP_CONCURRENCY, async (session) => {
    if (session.status === "active") return false;
    // U6: workflow-backed sessions are cancelled via WDK; the workflow's
    // finalize step does salvage + DB CAS. On success, skip the legacy
    // salvage/stop/markInFlight code below.
    if (await tryWorkflowCancel(session, "expired")) {
      invalidateSandboxHandle(session.id);
      logger.info("Expired session cleaned up via workflow cancel", {
        session_id: session.id,
        tenant_id: session.tenant_id,
      });
      return true;
    }
    // Salvage anything the runner managed to emit before the 4h cap. For
    // expired sessions the sandbox is usually long gone, but try anyway —
    // the helper is null-on-failure.
    const messageId = await findRunningMessageId(session.id);
    let salvagedBlobUrl: string | null = null;
    if (session.sandbox_id && messageId) {
      salvagedBlobUrl = await salvageAndUpload(
        session.sandbox_id,
        session.tenant_id,
        messageId,
        { session_id: session.id, reason: "expired" },
      );
    }
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
      salvagedBlobUrl,
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
    if (await tryWorkflowCancel(session, "idle_ttl")) {
      invalidateSandboxHandle(session.id);
      logger.info("Idle session cleaned up via workflow cancel", {
        session_id: session.id,
        tenant_id: session.tenant_id,
      });
      return true;
    }
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
  const stuckCreating = await getStuckCreatingSessions(CREATING_WATCHDOG_MINUTES);
  const results = await withConcurrency(stuckCreating, SANDBOX_STOP_CONCURRENCY, async (session) => {
    if (await tryWorkflowCancel(session, "creating_watchdog")) {
      invalidateSandboxHandle(session.id);
      logger.warn("Creating-watchdog cleared via workflow cancel", {
        session_id: session.id,
        tenant_id: session.tenant_id,
      });
      return true;
    }
    // Boot may have completed enough for the runner to start emitting before
    // the CAS-to-active raced; try salvage. Most often returns null.
    const messageId = await findRunningMessageId(session.id);
    let salvagedBlobUrl: string | null = null;
    if (session.sandbox_id && messageId) {
      salvagedBlobUrl = await salvageAndUpload(
        session.sandbox_id,
        session.tenant_id,
        messageId,
        { session_id: session.id, reason: "creating_watchdog" },
      );
    }
    const previousSandboxId = await forceStopSession(session.id);
    if (previousSandboxId) {
      await stopSandboxBestEffort(previousSandboxId, { session_id: session.id, reason: "creating_watchdog" });
    }
    await markInFlightMessage(
      session.id,
      "failed",
      "watchdog_creating_timeout",
      `Session stuck in 'creating' for >${CREATING_WATCHDOG_MINUTES} minutes.`,
      salvagedBlobUrl,
    );
    await cleanupBlob(session);
    logger.warn("Creating-watchdog fired", {
      session_id: session.id,
      tenant_id: session.tenant_id,
      created_at: session.created_at,
      transcript_salvaged: salvagedBlobUrl !== null,
    });
    return true;
  });
  return countSweepResults(results, "Failed creating-watchdog cleanup");
}

async function sweepActiveWatchdog(): Promise<number> {
  const stuckActive = await getStuckActiveSessions(ACTIVE_WATCHDOG_GRACE_SECONDS);
  const results = await withConcurrency(stuckActive, SANDBOX_STOP_CONCURRENCY, async (session) => {
    // U6: workflow-backed sessions are cancelled via WDK; the workflow's
    // finalize step does salvage-before-stop ordering itself, matching
    // the legacy cleanup ordering preserved here. The plan calls this
    // out specifically — most-fixed area in recent commit history.
    if (await tryWorkflowCancel(session, "active_watchdog")) {
      invalidateSandboxHandle(session.id);
      logger.warn("Active-watchdog cleared via workflow cancel", {
        session_id: session.id,
        tenant_id: session.tenant_id,
      });
      return true;
    }
    // Salvage the runner's NDJSON transcript BEFORE killing the sandbox, so
    // tool calls, partial outputs, and errors emitted up to the watchdog cut
    // survive on the message row. Without this the message row carries only
    // a "presumed dead" stub and users have no view into what executed.
    const messageId = await findRunningMessageId(session.id);
    let salvagedBlobUrl: string | null = null;
    if (session.sandbox_id && messageId) {
      salvagedBlobUrl = await salvageAndUpload(
        session.sandbox_id,
        session.tenant_id,
        messageId,
        { session_id: session.id, reason: "active_watchdog" },
      );
    }
    const previousSandboxId = await forceStopSession(session.id);
    if (previousSandboxId) {
      await stopSandboxBestEffort(previousSandboxId, { session_id: session.id, reason: "active_watchdog" });
    }
    await markInFlightMessage(
      session.id,
      "timed_out",
      "watchdog_active_timeout",
      `Session exceeded agent max_runtime_seconds + ${ACTIVE_WATCHDOG_GRACE_SECONDS}s grace; runner presumed dead.`,
      salvagedBlobUrl,
    );
    await cleanupBlob(session);
    logger.warn("Active-watchdog fired", {
      session_id: session.id,
      tenant_id: session.tenant_id,
      updated_at: session.updated_at,
      transcript_salvaged: salvagedBlobUrl !== null,
    });
    return true;
  });
  return countSweepResults(results, "Failed active-watchdog cleanup");
}

// Active-without-running-message sweep. Backstop for the schedule cron's
// "stuck running → failed" fallback: when that fallback flips the only
// message to `failed` but the session never transitions out of `active`, the
// active-watchdog skips the row (its EXISTS clause requires a running
// message). Without this sweep the row leaks until expires_at, and even then
// `sweepExpired` skips active. Force-stop after a short window — by the time
// no message is running, no more bytes are coming.
async function sweepActiveWithoutRunning(): Promise<number> {
  const orphans = await getActiveSessionsWithoutRunningMessage(
    ACTIVE_NO_RUNNING_MESSAGE_MINUTES,
  );
  const results = await withConcurrency(orphans, SANDBOX_STOP_CONCURRENCY, async (session) => {
    if (await tryWorkflowCancel(session, "active_no_running_message")) {
      invalidateSandboxHandle(session.id);
      logger.warn("Active-without-running-message cleared via workflow cancel", {
        session_id: session.id,
        tenant_id: session.tenant_id,
      });
      return true;
    }
    const previousSandboxId = await forceStopSession(session.id);
    if (previousSandboxId) {
      await stopSandboxBestEffort(previousSandboxId, {
        session_id: session.id,
        reason: "active_no_running_message",
      });
    }
    await cleanupBlob(session);
    logger.warn("Active-without-running-message sweep fired", {
      session_id: session.id,
      tenant_id: session.tenant_id,
      updated_at: session.updated_at,
    });
    return true;
  });
  return countSweepResults(results, "Failed active-without-running-message cleanup");
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

// chat_event_dedupe sweep. Two cohorts:
//   (a) STALE PLACEHOLDERS — winner crashed between INSERT and UPDATE.
//       claimed_at is older than the workflow step's max wall clock.
//       Round-4 review #3: bumped 5min → 15min so a cold sandbox boot
//       (snapshot miss + npm install + heavy MCP refresh + plugin sync)
//       cannot be reaped mid-start. Above 15min the active-watchdog
//       (per-agent max_runtime + 120s grace, default 720s) has already
//       fired, so the placeholder is genuinely orphaned.
//   (b) FILLED ROWS PAST 7-DAY TTL — long-tail cleanup. The 7-day
//       window is the workflow body's max useful idempotency horizon
//       (inner workflow runs are gone well before then). Without this
//       sweep filled rows accumulate forever.
//
// Round-4 review #8: returns a single integer total to match sibling
// sweeps. Per-cohort counts surface in the structured log line below.
async function sweepChatEventDedupe(): Promise<number> {
  const stalePromise = execute(
    `DELETE FROM chat_event_dedupe
      WHERE inner_run_id IS NULL
        AND claimed_at < now() - INTERVAL '15 minutes'`,
  );
  const expiredPromise = execute(
    `DELETE FROM chat_event_dedupe
      WHERE created_at < now() - INTERVAL '7 days'`,
  );
  const [stale, expired] = await Promise.all([stalePromise, expiredPromise]);
  if (stale.rowCount > 0 || expired.rowCount > 0) {
    logger.info("chat_event_dedupe sweep", {
      stale_placeholders_deleted: stale.rowCount,
      expired_filled_deleted: expired.rowCount,
    });
  }
  return stale.rowCount + expired.rowCount;
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
    activeNoRunning,
    orphansCleaned,
    chatDedupeCleaned,
  ] = await Promise.all([
    sweepExpired(),
    sweepIdle(),
    sweepCreatingWatchdog(),
    sweepActiveWatchdog(),
    sweepActiveWithoutRunning(),
    sweepOrphans(),
    sweepChatEventDedupe(),
  ]);

  const total =
    expiredCleaned +
    idleCleaned +
    creatingWatchdog +
    activeWatchdog +
    activeNoRunning +
    orphansCleaned +
    chatDedupeCleaned;
  logger.info("Session cleanup completed", {
    expired_cleaned: expiredCleaned,
    idle_cleaned: idleCleaned,
    creating_watchdog: creatingWatchdog,
    active_watchdog: activeWatchdog,
    active_no_running_message: activeNoRunning,
    orphans_cleaned: orphansCleaned,
    chat_dedupe_cleaned: chatDedupeCleaned,
    total,
  });

  return jsonResponse({
    cleaned: total,
    expired: expiredCleaned,
    idle: idleCleaned,
    creating_watchdog: creatingWatchdog,
    active_watchdog: activeWatchdog,
    active_no_running_message: activeNoRunning,
    orphans: orphansCleaned,
    chat_dedupe: chatDedupeCleaned,
  });
});
