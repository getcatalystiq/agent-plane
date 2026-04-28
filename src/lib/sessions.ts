import { z } from "zod";
import { query, queryOne, execute, withTenantTransaction } from "@/db";
import { SessionRow, AgentRowInternal, type AgentInternal } from "./validation";
import { checkTenantBudget } from "./session-messages";
import { supportsClaudeRunner } from "./models";
import { logger } from "./logger";
import {
  NotFoundError,
  ConcurrencyLimitError,
} from "./errors";
import type { SessionStatus, TenantId, AgentId, RunTriggeredBy } from "./types";
import { SESSION_VALID_TRANSITIONS } from "./types";

/**
 * Tenant cap on concurrent active sessions. The cap counts only sessions in
 * `creating` or `active` — `idle` does NOT count. The check uses a single
 * SQL statement that both reads count and inserts atomically (TOCTOU-safe),
 * mirroring the legacy `MAX_CONCURRENT_RUNS` pattern.
 */
export const MAX_CONCURRENT_SESSIONS = 50;

/**
 * FIX #15: alias re-exported from session-messages.ts callers. Single source
 * of truth lives here; session-messages.ts re-exports for backward-compat.
 */
export const MAX_CONCURRENT_ACTIVE_SESSIONS = MAX_CONCURRENT_SESSIONS;

/** Hard wall-clock cap on a session's lifetime regardless of idle TTL. */
export const SESSION_EXPIRES_AFTER_INTERVAL = "4 hours";

/** Per-trigger idle TTL mapping (seconds). See R3/R4 in the plan. */
export function defaultIdleTtlSeconds(triggeredBy: RunTriggeredBy): number {
  switch (triggeredBy) {
    case "schedule":
      return 300; // 5 min — short operator follow-up window
    case "playground":
    case "chat":
      return 600; // 10 min default
    case "api":
    case "webhook":
    case "a2a":
    default:
      return 600;
  }
}

export type Session = z.infer<typeof SessionRow>;

/**
 * Atomic session creation with concurrent-session cap (TOCTOU-safe). The cap
 * counts only `status IN ('creating', 'active')` — idle sessions are free
 * until cleanup. Mirrors the legacy `MAX_CONCURRENT_RUNS` pattern.
 *
 * Sets `expires_at` to created_at + 4h.
 */
export async function createSession(
  tenantId: TenantId,
  agentId: AgentId,
  options?: {
    contextId?: string;
    ephemeral?: boolean;
    idleTtlSeconds?: number;
    triggeredBy?: RunTriggeredBy;
  },
): Promise<{ session: Session; agent: AgentInternal; remainingBudget: number }> {
  return withTenantTransaction(tenantId, async (tx) => {
    // FIX #3 (adv-001): TOCTOU-safe concurrency cap via tx-scoped advisory
    // lock keyed on tenant_id. Plain INSERT...WHERE (SELECT COUNT) is not
    // serializable under READ COMMITTED. The lock auto-releases on commit.
    await tx.execute(
      `SELECT pg_advisory_xact_lock(hashtext('session_cap:' || $1::text))`,
      [tenantId],
    );

    const agent = await tx.queryOne(
      AgentRowInternal,
      "SELECT * FROM agents WHERE id = $1 AND tenant_id = $2",
      [agentId, tenantId],
    );
    if (!agent) throw new NotFoundError("Agent not found");

    const isSubscriptionRun = supportsClaudeRunner(agent.model);
    const remainingBudget = await checkTenantBudget(tx, tenantId, { isSubscriptionRun });

    const contextId = options?.contextId ?? null;
    const ephemeral = options?.ephemeral ?? false;
    const idleTtlSeconds = options?.idleTtlSeconds ?? defaultIdleTtlSeconds(options?.triggeredBy ?? "api");

    const result = await tx.queryOne(
      SessionRow,
      `INSERT INTO sessions (tenant_id, agent_id, status, context_id, ephemeral, idle_ttl_seconds, expires_at)
       SELECT $1, $2, 'creating', $4, $5, $6, NOW() + INTERVAL '${SESSION_EXPIRES_AFTER_INTERVAL}'
       WHERE (SELECT COUNT(*) FROM sessions WHERE tenant_id = $1 AND status IN ('creating', 'active')) < $3
       RETURNING *`,
      [tenantId, agentId, MAX_CONCURRENT_SESSIONS, contextId, ephemeral, idleTtlSeconds],
    );

    if (!result) {
      throw new ConcurrencyLimitError(
        `Maximum of ${MAX_CONCURRENT_SESSIONS} concurrent active sessions per tenant`,
      );
    }

    logger.info("Session created", {
      session_id: result.id,
      agent_id: agentId,
      tenant_id: tenantId,
      context_id: contextId,
      ephemeral,
      idle_ttl_seconds: idleTtlSeconds,
    });
    return { session: result, agent, remainingBudget };
  });
}

/**
 * Find a non-stopped session by A2A contextId. Preserves the legacy
 * implementation; the unique partial index in migration 033 enforces at most
 * one non-stopped row per (tenant, agent, context_id).
 */
export async function findSessionByContextId(
  tenantId: TenantId,
  agentId: AgentId,
  contextId: string,
): Promise<Session | null> {
  const result = await queryOne(
    SessionRow,
    `SELECT * FROM sessions
     WHERE tenant_id = $1 AND agent_id = $2 AND context_id = $3
       AND status NOT IN ('stopped')
     LIMIT 1`,
    [tenantId, agentId, contextId],
  );
  return result ?? null;
}

export async function getSession(sessionId: string, tenantId: TenantId): Promise<Session> {
  const session = await queryOne(
    SessionRow,
    "SELECT * FROM sessions WHERE id = $1 AND tenant_id = $2",
    [sessionId, tenantId],
  );
  if (!session) throw new NotFoundError("Session not found");
  return session;
}

export async function listSessions(
  tenantId: TenantId,
  options: { agentId?: string; status?: SessionStatus; limit: number; offset: number },
): Promise<Session[]> {
  const conditions = ["tenant_id = $1"];
  const params: unknown[] = [tenantId];
  let idx = 2;

  if (options.agentId) {
    conditions.push(`agent_id = $${idx}`);
    params.push(options.agentId);
    idx++;
  }
  if (options.status) {
    conditions.push(`status = $${idx}`);
    params.push(options.status);
    idx++;
  }

  params.push(options.limit, options.offset);
  return query(
    SessionRow,
    `SELECT * FROM sessions WHERE ${conditions.join(" AND ")}
     ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
    params,
  );
}

/**
 * Generic state-machine transition. Validates against
 * SESSION_VALID_TRANSITIONS, then writes via a CAS UPDATE
 * (`WHERE status = fromStatus`) so concurrent transitions can't bypass the
 * machine. Returns false if the row is in the wrong state.
 */
export async function transitionSessionStatus(
  sessionId: string,
  tenantId: TenantId,
  fromStatus: SessionStatus,
  toStatus: SessionStatus,
  updates?: {
    sandbox_id?: string | null;
    sdk_session_id?: string;
    session_blob_url?: string | null;
    message_count?: number;
    last_backup_at?: string;
    mcp_refreshed_at?: string;
    idle_since?: string | null;
  },
): Promise<boolean> {
  if (!SESSION_VALID_TRANSITIONS[fromStatus]?.includes(toStatus)) {
    logger.warn("Invalid session status transition", {
      session_id: sessionId,
      from: fromStatus,
      to: toStatus,
    });
    return false;
  }

  const setClauses = ["status = $3"];
  const params: unknown[] = [sessionId, tenantId, toStatus];
  let idx = 4;

  const ALLOWED_COLUMNS = new Set([
    "sandbox_id", "sdk_session_id", "session_blob_url",
    "message_count", "last_backup_at", "mcp_refreshed_at", "idle_since",
  ]);

  if (updates) {
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        if (!ALLOWED_COLUMNS.has(key)) {
          throw new Error(`Invalid column name in session update: ${key}`);
        }
        setClauses.push(`${key} = $${idx}`);
        params.push(value);
        idx++;
      }
    }
  }

  params.push(fromStatus);
  const result = await execute(
    `UPDATE sessions SET ${setClauses.join(", ")}
     WHERE id = $1 AND tenant_id = $2 AND status = $${idx}`,
    params,
  );

  if (result.rowCount === 0) {
    logger.warn("Session status transition failed (stale state)", {
      session_id: sessionId,
      expected_from: fromStatus,
      to: toStatus,
    });
    return false;
  }

  logger.info("Session status transitioned", { session_id: sessionId, from: fromStatus, to: toStatus });
  return true;
}

/**
 * Atomic CAS idle → active. Returns the row when it acquired the lock, or
 * `null` when the row was not in `idle` state (caller decides whether to
 * surface 410 Gone or auto-create a fresh session).
 */
export async function casIdleToActive(
  sessionId: string,
  tenantId: TenantId,
): Promise<Session | null> {
  const row = await queryOne(
    SessionRow,
    `UPDATE sessions
     SET status = 'active', idle_since = NULL
     WHERE id = $1 AND tenant_id = $2 AND status = 'idle'
     RETURNING *`,
    [sessionId, tenantId],
  );
  return row ?? null;
}

/**
 * Atomic CAS creating → active. Used after sandbox boot completes for a
 * brand-new session.
 */
export async function casCreatingToActive(
  sessionId: string,
  tenantId: TenantId,
  updates?: { sandbox_id?: string },
): Promise<Session | null> {
  const setClauses = ["status = 'active'"];
  const params: unknown[] = [sessionId, tenantId];
  let idx = 3;
  if (updates?.sandbox_id !== undefined) {
    setClauses.push(`sandbox_id = $${idx}`);
    params.push(updates.sandbox_id);
    idx++;
  }
  const row = await queryOne(
    SessionRow,
    `UPDATE sessions
     SET ${setClauses.join(", ")}
     WHERE id = $1 AND tenant_id = $2 AND status = 'creating'
     RETURNING *`,
    params,
  );
  return row ?? null;
}

/**
 * Atomic CAS active → idle, gated on the message being the most recent
 * message on the session AND already in a terminal status. Used by the
 * internal transcript-upload endpoint when the dispatcher stream detached at
 * 4.5min for a PERSISTENT session (ephemeral=false): finalize is skipped on
 * the dispatcher side, leaving the session stuck in 'active' until the 30min
 * watchdog. This helper unsticks it without racing the (rare) live
 * dispatcher path.
 *
 * FIX #2: detached persistent sessions previously sat in 'active' for 30min.
 * Subsequent message dispatches returned 409 ConcurrencyLimit until the
 * watchdog fired.
 *
 * Returns true when the CAS fired; false when the session was no longer
 * active OR the supplied messageId was not the latest.
 */
export async function casActiveToIdle(
  sessionId: string,
  tenantId: TenantId,
  messageId: string,
): Promise<boolean> {
  const result = await execute(
    `UPDATE sessions
     SET status = 'idle', idle_since = NOW()
     WHERE id = $1 AND tenant_id = $2 AND status = 'active'
       AND EXISTS (
         SELECT 1
         FROM session_messages m
         WHERE m.id = $3 AND m.session_id = $1 AND m.tenant_id = $2
           AND m.status NOT IN ('queued', 'running')
           AND m.created_at = (
             SELECT MAX(created_at) FROM session_messages
             WHERE session_id = $1 AND tenant_id = $2
           )
       )`,
    [sessionId, tenantId, messageId],
  );
  return result.rowCount > 0;
}

/**
 * Atomic CAS to stopped from any non-stopped state. Used by cancel + cleanup
 * cron. Idempotent: returns the row regardless of whether the transition
 * actually fired.
 */
export async function casToStopped(
  sessionId: string,
  tenantId: TenantId,
): Promise<Session> {
  const row = await queryOne(
    SessionRow,
    `UPDATE sessions
     SET status = 'stopped', sandbox_id = NULL, idle_since = NULL
     WHERE id = $1 AND tenant_id = $2 AND status <> 'stopped'
     RETURNING *`,
    [sessionId, tenantId],
  );
  if (row) return row;
  // Already stopped — return current row.
  return getSession(sessionId, tenantId);
}

export async function incrementMessageCount(sessionId: string, tenantId: TenantId): Promise<void> {
  await execute(
    `UPDATE sessions SET message_count = message_count + 1
     WHERE id = $1 AND tenant_id = $2`,
    [sessionId, tenantId],
  );
}

/**
 * Find idle sessions whose per-row idle TTL has elapsed. No RLS — used by
 * cleanup cron. Signature changed from the legacy `(maxIdleMinutes: number)`
 * to `()` since each session now carries its own `idle_ttl_seconds` (set by
 * the dispatcher per the trigger table).
 *
 * FIX #12: bounded by `CLEANUP_SWEEP_LIMIT` so a backlog can't pin the function.
 */
export async function getIdleSessions(): Promise<Session[]> {
  return query(
    SessionRow,
    `SELECT * FROM sessions
     WHERE status = 'idle'
       AND idle_since IS NOT NULL
       AND idle_since < NOW() - INTERVAL '1 second' * idle_ttl_seconds
     LIMIT 500`,
    [],
  );
}

/**
 * Watchdog: sessions stuck in a single non-terminal state past `maxMinutes`.
 * `creating` watchdog should pass 5 (sandbox-boot timed out); `active`
 * watchdog should pass 30 (runner crashed mid-message). Threshold reference:
 * `creating` uses `created_at` (boot started then), `active` uses
 * `updated_at` (last status touch). No RLS — used by cleanup cron.
 */
export async function getStuckSessions(
  state: "creating" | "active",
  maxMinutes: number,
): Promise<Session[]> {
  // FIX #28: for the active-watchdog, use the latest running message's
  // started_at, not sessions.updated_at — every idle→active flip resets
  // updated_at, so a long chat session where each turn finishes within
  // updated_at+30min would never trip. Latest running message timestamp
  // is the true "is the runner stuck" signal.
  // FIX #12: bounded LIMIT keeps the cron tick small under backlog.
  if (state === "active") {
    return query(
      SessionRow,
      `SELECT s.* FROM sessions s
       WHERE s.status = 'active'
         AND EXISTS (
           SELECT 1 FROM session_messages m
           WHERE m.session_id = s.id
             AND m.status = 'running'
             AND m.started_at < NOW() - INTERVAL '1 minute' * $1
         )
       LIMIT 500`,
      [maxMinutes],
    );
  }
  const tsCol = state === "creating" ? "created_at" : "updated_at";
  return query(
    SessionRow,
    `SELECT * FROM sessions
     WHERE status = $1
       AND ${tsCol} < NOW() - INTERVAL '1 minute' * $2
     LIMIT 500`,
    [state, maxMinutes],
  );
}

/**
 * Find sandbox_ids referenced by terminal (`stopped`) sessions — defense in
 * depth for the orphan-sandbox sweep. With the unified schema, sandboxes are
 * tracked exclusively via `sessions.sandbox_id`; a non-null sandbox_id on a
 * stopped session indicates a finalize/stop call that didn't clean the row.
 * No RLS — used by cleanup cron.
 */
export async function getOrphanedSandboxSessions(): Promise<Session[]> {
  return query(
    SessionRow,
    `SELECT * FROM sessions
     WHERE status = 'stopped' AND sandbox_id IS NOT NULL
     LIMIT 500`,
    [],
  );
}

/**
 * Sessions past their hard `expires_at` cap (4h wall-clock from creation),
 * regardless of state. No RLS — used by cleanup cron. Caps the
 * contextId-reuse warm-sandbox attack window.
 */
export async function getExpiredSessions(): Promise<Session[]> {
  return query(
    SessionRow,
    `SELECT * FROM sessions
     WHERE status <> 'stopped' AND expires_at < NOW()
     LIMIT 500`,
    [],
  );
}

export async function updateSessionSandbox(
  sessionId: string,
  tenantId: TenantId,
  sandboxId: string | null,
): Promise<void> {
  const result = await execute(
    "UPDATE sessions SET sandbox_id = $1 WHERE id = $2 AND tenant_id = $3",
    [sandboxId, sessionId, tenantId],
  );
  if (result.rowCount === 0) {
    throw new NotFoundError("Session not found");
  }
}

export async function updateSessionMcpRefreshedAt(
  sessionId: string,
  tenantId: TenantId,
): Promise<void> {
  await execute(
    "UPDATE sessions SET mcp_refreshed_at = now() WHERE id = $1 AND tenant_id = $2",
    [sessionId, tenantId],
  );
}

/**
 * Look up the most recent non-stopped session for (tenant, agent) whose most
 * recent message was triggered by `schedule`. Used by the scheduled-runs
 * dispatcher to reuse a warm sandbox across cron ticks (within the per-row
 * idle TTL).
 *
 * Returns the session row when an idle (or active) reusable candidate is
 * available; otherwise null and the caller creates a fresh session.
 *
 * FIX #6 (adv-003): without this lookup, every schedule tick spun up a new
 * sandbox even though `defaultIdleTtlSeconds('schedule') === 300` is meant
 * for follow-up reuse.
 *
 * Note: caller still passes the candidate sessionId into the dispatcher,
 * which races with the cleanup cron via CAS. Internal triggers fall back
 * to creating a new session if the candidate flipped to stopped.
 */
export async function findWarmScheduleSession(
  tenantId: TenantId,
  agentId: AgentId,
): Promise<Session | null> {
  // Most-recent-non-stopped session for (tenant, agent). We additionally
  // require that the latest message on that session was triggered_by=schedule
  // — otherwise we'd reuse a chat/playground session unintentionally.
  const result = await queryOne(
    SessionRow,
    `SELECT s.*
     FROM sessions s
     WHERE s.tenant_id = $1
       AND s.agent_id = $2
       AND s.status IN ('idle', 'active', 'creating')
       AND EXISTS (
         SELECT 1
         FROM session_messages m
         WHERE m.session_id = s.id
           AND m.tenant_id = $1
           AND m.triggered_by = 'schedule'
         ORDER BY m.created_at DESC
         LIMIT 1
       )
     ORDER BY s.updated_at DESC
     LIMIT 1`,
    [tenantId, agentId],
  );
  return result ?? null;
}
