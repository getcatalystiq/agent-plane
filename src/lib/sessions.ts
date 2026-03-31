import { z } from "zod";
import { query, queryOne, execute, withTenantTransaction } from "@/db";
import { SessionRow, AgentRowInternal, AgentInternal } from "./validation";
import { checkTenantBudget } from "./runs";
import { supportsClaudeRunner } from "./models";
import { logger } from "./logger";
import {
  NotFoundError,
  ConflictError,
  ConcurrencyLimitError,
} from "./errors";
import type { SessionStatus, TenantId, AgentId } from "./types";
import { SESSION_VALID_TRANSITIONS } from "./types";

const MAX_CONCURRENT_SESSIONS = 50;

export type Session = z.infer<typeof SessionRow>;

// Atomic session creation with concurrent session check (prevents TOCTOU)
export async function createSession(
  tenantId: TenantId,
  agentId: AgentId,
  options?: { contextId?: string },
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
    const result = await tx.queryOne(
      SessionRow,
      `INSERT INTO sessions (tenant_id, agent_id, status, context_id)
       SELECT $1, $2, 'creating', $4
       WHERE (SELECT COUNT(*) FROM sessions WHERE tenant_id = $1 AND status IN ('creating', 'active', 'idle')) < $3
       RETURNING *`,
      [tenantId, agentId, MAX_CONCURRENT_SESSIONS, contextId],
    );

    if (!result) {
      throw new ConcurrencyLimitError(
        `Maximum of ${MAX_CONCURRENT_SESSIONS} concurrent sessions per tenant`,
      );
    }

    logger.info("Session created", { session_id: result.id, agent_id: agentId, tenant_id: tenantId, context_id: contextId });
    return { session: result, agent, remainingBudget };
  });
}

// Find an active or idle session by contextId for a given agent + tenant.
// Used by A2A multi-turn to reuse an existing sandbox.
export async function findSessionByContextId(
  tenantId: TenantId,
  agentId: AgentId,
  contextId: string,
): Promise<Session | null> {
  return queryOne(
    SessionRow,
    `SELECT * FROM sessions
     WHERE tenant_id = $1 AND agent_id = $2 AND context_id = $3
       AND status IN ('active', 'idle')
     LIMIT 1`,
    [tenantId, agentId, contextId],
  );
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

// Status state machine transition
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
    last_message_at?: string;
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
    "message_count", "last_backup_at", "mcp_refreshed_at", "idle_since", "last_message_at",
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

// Stop a session: transition to stopped, clear sandbox_id
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

// Increment message count and update last_message_at atomically
export async function incrementMessageCount(sessionId: string, tenantId: TenantId): Promise<void> {
  await execute(
    `UPDATE sessions SET message_count = message_count + 1, last_message_at = NOW()
     WHERE id = $1 AND tenant_id = $2`,
    [sessionId, tenantId],
  );
}

// Find idle sessions past threshold — no RLS, used by cleanup cron
export async function getIdleSessions(maxIdleMinutes: number): Promise<Session[]> {
  return query(
    SessionRow,
    `SELECT * FROM sessions
     WHERE status = 'idle' AND idle_since < NOW() - INTERVAL '1 minute' * $1`,
    [maxIdleMinutes],
  );
}

// Find stuck sessions — no RLS, used by cleanup cron watchdog
export async function getStuckSessions(): Promise<Session[]> {
  return query(
    SessionRow,
    `SELECT * FROM sessions
     WHERE (status = 'creating' AND created_at < NOW() - INTERVAL '5 minutes')
        OR (status = 'active' AND updated_at < NOW() - INTERVAL '30 minutes')`,
    [],
  );
}

// Update sandbox_id for a session (used after sandbox creation or reconnection)
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

// Update mcp_refreshed_at timestamp (used after MCP token refresh)
export async function updateSessionMcpRefreshedAt(
  sessionId: string,
  tenantId: TenantId,
): Promise<void> {
  await execute(
    "UPDATE sessions SET mcp_refreshed_at = now() WHERE id = $1 AND tenant_id = $2",
    [sessionId, tenantId],
  );
}
