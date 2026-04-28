import { z } from "zod";
import { query, queryOne, execute, withTenantTransaction } from "@/db";
import { SessionRow, AgentRowInternal, type AgentInternal } from "./validation";
import { checkTenantBudget } from "./session-messages";
import { supportsClaudeRunner } from "./models";
import { logger } from "./logger";
import {
  NotFoundError,
  ConflictError,
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

/** Hard wall-clock cap on a session's lifetime regardless of idle TTL. */
const SESSION_EXPIRES_AFTER_INTERVAL = "4 hours";

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

/**
 * Stop a session: transition to stopped, clear sandbox_id. Throws ConflictError
 * only when the row is in a state with no `stopped` successor — which never
 * happens with the current state machine (every state lists `stopped`), so
 * this is essentially the public-route wrapper around `casToStopped`.
 */
export async function stopSession(sessionId: string, tenantId: TenantId): Promise<Session> {
  const session = await getSession(sessionId, tenantId);

  if (session.status === "stopped") {
    return session;
  }

  const transitioned = await transitionSessionStatus(
    sessionId,
    tenantId,
    session.status as SessionStatus,
    "stopped",
    { sandbox_id: null, idle_since: null },
  );

  if (!transitioned) {
    throw new ConflictError(`Cannot stop session in status '${session.status}'`);
  }

  logger.info("Session stopped", { session_id: sessionId, tenant_id: tenantId });
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
 */
export async function getIdleSessions(): Promise<Session[]> {
  return query(
    SessionRow,
    `SELECT * FROM sessions
     WHERE status = 'idle'
       AND idle_since IS NOT NULL
       AND idle_since < NOW() - INTERVAL '1 second' * idle_ttl_seconds`,
    [],
  );
}

/**
 * Watchdog: sessions stuck in `creating` (sandbox-boot timed out) for
 * >5 minutes, or `active` (runner crashed mid-message) for >30 minutes.
 * No RLS — used by cleanup cron.
 */
export async function getStuckSessions(): Promise<Session[]> {
  return query(
    SessionRow,
    `SELECT * FROM sessions
     WHERE (status = 'creating' AND created_at < NOW() - INTERVAL '5 minutes')
        OR (status = 'active' AND updated_at < NOW() - INTERVAL '30 minutes')`,
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
     WHERE status <> 'stopped' AND expires_at < NOW()`,
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
