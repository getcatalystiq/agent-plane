import { z } from "zod";
import { query, queryOne, execute } from "@/db";
import { SessionMessageRow, type SessionMessageStatus } from "./validation";
import { logger } from "./logger";
import {
  ForbiddenError,
  BudgetExceededError,
} from "./errors";
import type { TenantId, RunTriggeredBy } from "./types";

/**
 * Concurrency cap, mirrors the legacy MAX_CONCURRENT_RUNS.
 * The cap counts only sessions in `creating` or `active` — `idle` sessions
 * do NOT count toward this cap, they are free until the cleanup cron stops
 * them per their per-session idle TTL.
 *
 * FIX #15: single source of truth lives in `sessions.ts`; this re-export
 * preserves the existing import surface used by dispatcher / webhook routes.
 */
export { MAX_CONCURRENT_ACTIVE_SESSIONS } from "./sessions";

const TenantBudgetRow = z.object({
  status: z.enum(["active", "suspended"]),
  monthly_budget_usd: z.coerce.number(),
  current_month_spend: z.coerce.number(),
  has_subscription_token: z.boolean(),
});

/**
 * Check tenant suspension status and budget within a transaction.
 *
 * Throws ForbiddenError if suspended, BudgetExceededError if over budget.
 *
 * When `isSubscriptionRun` is true (Claude model on a subscription tenant),
 * budget enforcement is bypassed since usage is billed through the subscription.
 * Non-Claude models on the same tenant still enforce the budget.
 *
 * Returns remaining budget in USD (Infinity for subscription runs).
 *
 * Preserves the legacy `src/lib/runs.ts::checkTenantBudget` semantics — the
 * `subscription_token_enc IS NOT NULL AND supportsClaudeRunner(agent.model)`
 * short-circuit is wired here. Callers MUST gate on
 * `supportsClaudeRunner(agent.model)` before passing `isSubscriptionRun: true`.
 */
export async function checkTenantBudget(
  tx: { queryOne: <T>(schema: z.ZodSchema<T>, sql: string, params?: unknown[]) => Promise<T | null> },
  tenantId: TenantId,
  options?: { isSubscriptionRun?: boolean },
): Promise<number> {
  const row = await tx.queryOne(
    TenantBudgetRow,
    "SELECT status, monthly_budget_usd, current_month_spend, subscription_token_enc IS NOT NULL AS has_subscription_token FROM tenants WHERE id = $1",
    [tenantId],
  );
  if (row?.status === "suspended") {
    throw new ForbiddenError("Tenant is suspended");
  }
  // Subscription runs (Claude model + subscription token) bypass budget enforcement
  if (options?.isSubscriptionRun && row?.has_subscription_token) {
    return Infinity;
  }
  if (row && row.current_month_spend >= row.monthly_budget_usd) {
    throw new BudgetExceededError(
      `Monthly budget of $${row.monthly_budget_usd} exceeded (spent: $${row.current_month_spend.toFixed(2)})`,
    );
  }
  return row ? row.monthly_budget_usd - row.current_month_spend : Infinity;
}

const BILLABLE_TERMINAL_STATUSES: SessionMessageStatus[] = [
  "completed",
  "failed",
  "cancelled",
  "timed_out",
];

const VALID_MESSAGE_TRANSITIONS: Record<SessionMessageStatus, SessionMessageStatus[]> = {
  queued: ["running", "failed", "cancelled"],
  running: ["completed", "failed", "cancelled", "timed_out"],
  completed: [],
  failed: [],
  cancelled: [],
  timed_out: [],
};

const ALLOWED_UPDATE_COLUMNS = new Set([
  "started_at",
  "completed_at",
  "result_summary",
  "cost_usd",
  "total_input_tokens",
  "total_output_tokens",
  "cache_read_tokens",
  "cache_creation_tokens",
  "num_turns",
  "duration_ms",
  "duration_api_ms",
  "model_usage",
  "transcript_blob_url",
  "error_type",
  "error_messages",
  "runner",
]);

/**
 * Transition a session_message between statuses. On a terminal billable
 * status with a non-zero `cost_usd` update, also bumps
 * `tenants.current_month_spend` and emits a cost-anomaly warning if the
 * recorded cost exceeds the message's expected budget.
 *
 * Preserves the legacy `transitionRunStatus` rollup semantics from
 * `src/lib/runs.ts` lines ~192-211. The dispatcher's finalize path uses this
 * helper inside its transactional message-status update to keep monthly
 * budget enforcement working.
 */
export async function transitionMessageStatus(
  messageId: string,
  tenantId: TenantId,
  fromStatus: SessionMessageStatus,
  toStatus: SessionMessageStatus,
  updates?: {
    started_at?: string;
    completed_at?: string;
    result_summary?: string;
    cost_usd?: number;
    total_input_tokens?: number;
    total_output_tokens?: number;
    cache_read_tokens?: number;
    cache_creation_tokens?: number;
    num_turns?: number;
    duration_ms?: number;
    duration_api_ms?: number;
    model_usage?: Record<string, unknown>;
    transcript_blob_url?: string;
    error_type?: string;
    error_messages?: string[];
    runner?: string;
  },
  options?: { expectedMaxBudgetUsd?: number },
): Promise<boolean> {
  if (!VALID_MESSAGE_TRANSITIONS[fromStatus]?.includes(toStatus)) {
    logger.warn("Invalid message status transition", {
      message_id: messageId,
      from: fromStatus,
      to: toStatus,
    });
    return false;
  }

  const setClauses = ["status = $3"];
  const params: unknown[] = [messageId, tenantId, toStatus];
  let idx = 4;

  if (updates) {
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        if (!ALLOWED_UPDATE_COLUMNS.has(key)) {
          throw new Error(`Invalid column name in session_message update: ${key}`);
        }
        setClauses.push(`${key} = $${idx}`);
        params.push(key === "model_usage" ? JSON.stringify(value) : value);
        idx++;
      }
    }
  }

  params.push(fromStatus);
  const result = await execute(
    `UPDATE session_messages SET ${setClauses.join(", ")}
     WHERE id = $1 AND tenant_id = $2 AND status = $${idx}`,
    params,
  );

  if (result.rowCount === 0) {
    logger.warn("Message status transition failed (stale state)", {
      message_id: messageId,
      expected_from: fromStatus,
      to: toStatus,
    });
    return false;
  }

  logger.info("Message status transitioned", { message_id: messageId, from: fromStatus, to: toStatus });

  // Update tenant spend for all billable terminal statuses
  if (BILLABLE_TERMINAL_STATUSES.includes(toStatus) && updates?.cost_usd) {
    await execute(
      `UPDATE tenants SET current_month_spend = current_month_spend + $1
       WHERE id = $2`,
      [updates.cost_usd, tenantId],
    );

    // Cost anomaly detection
    if (
      options?.expectedMaxBudgetUsd !== undefined &&
      updates.cost_usd > options.expectedMaxBudgetUsd
    ) {
      logger.warn("Message cost exceeded expected budget", {
        message_id: messageId,
        tenant_id: tenantId,
        cost_usd: updates.cost_usd,
        expected_max_budget_usd: options.expectedMaxBudgetUsd,
        overage_usd: updates.cost_usd - options.expectedMaxBudgetUsd,
      });
    }
  }

  return true;
}

/**
 * Fetch a session_message by id within a tenant. JOINs the parent session +
 * agent so list/detail callers don't need extra round-trips.
 */
export async function getMessage(messageId: string, tenantId: TenantId) {
  return queryOne(
    SessionMessageRow,
    `SELECT m.*, a.name AS agent_name, a.model AS agent_model, s.agent_id
     FROM session_messages m
     LEFT JOIN sessions s ON m.session_id = s.id
     LEFT JOIN agents a ON s.agent_id = a.id
     WHERE m.id = $1 AND m.tenant_id = $2`,
    [messageId, tenantId],
  );
}

/**
 * List session_messages for a tenant, optionally scoped to a session, agent,
 * or status. Mirrors the legacy `listRuns` shape so admin/tenant route
 * handlers can swap callsites mechanically.
 */
export async function listMessages(
  tenantId: TenantId,
  options: {
    sessionId?: string;
    agentId?: string;
    status?: SessionMessageStatus;
    triggeredBy?: RunTriggeredBy;
    limit: number;
    offset: number;
  },
) {
  const conditions = ["m.tenant_id = $1"];
  const params: unknown[] = [tenantId];
  let idx = 2;

  if (options.sessionId) {
    conditions.push(`m.session_id = $${idx}`);
    params.push(options.sessionId);
    idx++;
  }
  if (options.agentId) {
    conditions.push(`s.agent_id = $${idx}`);
    params.push(options.agentId);
    idx++;
  }
  if (options.status) {
    conditions.push(`m.status = $${idx}`);
    params.push(options.status);
    idx++;
  }
  if (options.triggeredBy) {
    conditions.push(`m.triggered_by = $${idx}`);
    params.push(options.triggeredBy);
    idx++;
  }

  params.push(options.limit, options.offset);
  return query(
    SessionMessageRow,
    `SELECT m.*, a.name AS agent_name, a.model AS agent_model, s.agent_id
     FROM session_messages m
     LEFT JOIN sessions s ON m.session_id = s.id
     LEFT JOIN agents a ON s.agent_id = a.id
     WHERE ${conditions.join(" AND ")}
     ORDER BY m.created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
    params,
  );
}
