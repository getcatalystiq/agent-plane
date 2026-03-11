import { z } from "zod";
import { query, queryOne, execute, withTenantTransaction } from "@/db";
import { RunRow, AgentRowInternal, AgentInternal } from "./validation";
import { generateId } from "./crypto";
import { logger } from "./logger";
import {
  NotFoundError,
  ForbiddenError,
  BudgetExceededError,
  ConcurrencyLimitError,
} from "./errors";
import type { RunStatus, RunTriggeredBy, TenantId, AgentId, RunId, ScheduleId } from "./types";
import { VALID_TRANSITIONS } from "./types";

const MAX_CONCURRENT_RUNS = 10;

const TenantBudgetRow = z.object({
  status: z.enum(["active", "suspended"]),
  monthly_budget_usd: z.coerce.number(),
  current_month_spend: z.coerce.number(),
});

/**
 * Check tenant suspension status and budget within a transaction.
 * Throws ForbiddenError if suspended, BudgetExceededError if over budget.
 * Returns remaining budget in USD.
 */
export async function checkTenantBudget(
  tx: { queryOne: <T>(schema: z.ZodSchema<T>, sql: string, params?: unknown[]) => Promise<T | null> },
  tenantId: TenantId,
): Promise<number> {
  const row = await tx.queryOne(
    TenantBudgetRow,
    "SELECT status, monthly_budget_usd, current_month_spend FROM tenants WHERE id = $1",
    [tenantId],
  );
  if (row?.status === "suspended") {
    throw new ForbiddenError("Tenant is suspended");
  }
  if (row && row.current_month_spend >= row.monthly_budget_usd) {
    throw new BudgetExceededError(
      `Monthly budget of $${row.monthly_budget_usd} exceeded (spent: $${row.current_month_spend.toFixed(2)})`,
    );
  }
  return row ? row.monthly_budget_usd - row.current_month_spend : Infinity;
}

const BILLABLE_TERMINAL_STATUSES: RunStatus[] = [
  "completed",
  "failed",
  "cancelled",
  "timed_out",
];

// Atomic run creation with concurrent run check (prevents TOCTOU)
export async function createRun(
  tenantId: TenantId,
  agentId: AgentId,
  prompt: string,
  options?: { triggeredBy?: RunTriggeredBy; scheduleId?: ScheduleId; sessionId?: string; createdByKeyId?: string },
): Promise<{ run: z.infer<typeof RunRow>; agent: AgentInternal; remainingBudget: number }> {
  return withTenantTransaction(tenantId, async (tx) => {
    // Load agent (including internal Composio MCP cache fields)
    const agent = await tx.queryOne(
      AgentRowInternal,
      "SELECT * FROM agents WHERE id = $1 AND tenant_id = $2",
      [agentId, tenantId],
    );
    if (!agent) throw new NotFoundError("Agent not found");

    const remainingBudget = await checkTenantBudget(tx, tenantId);

    // Atomic insert with concurrent run limit check
    const runId = generateId();
    const triggeredBy = options?.triggeredBy ?? "api";
    const scheduleId = options?.scheduleId ?? null;
    const sessionId = options?.sessionId ?? null;
    const createdByKeyId = options?.createdByKeyId ?? null;
    const inserted = await tx.queryOne(
      RunRow,
      `INSERT INTO runs (id, agent_id, tenant_id, status, prompt, triggered_by, schedule_id, session_id, created_by_key_id, created_at)
       SELECT $1, $2, $3, 'pending', $4, $5, $6, $7, $8, NOW()
       WHERE (SELECT COUNT(*) FROM runs WHERE tenant_id = $3 AND status IN ('pending', 'running')) < $9
       RETURNING *`,
      [runId, agentId, tenantId, prompt, triggeredBy, scheduleId, sessionId, createdByKeyId, MAX_CONCURRENT_RUNS],
    );

    if (!inserted) {
      throw new ConcurrencyLimitError(
        `Maximum of ${MAX_CONCURRENT_RUNS} concurrent runs per tenant`,
      );
    }

    logger.info("Run created", { run_id: runId, agent_id: agentId, tenant_id: tenantId });
    return { run: inserted, agent, remainingBudget };
  });
}

// Status state machine transition
export async function transitionRunStatus(
  runId: RunId,
  tenantId: TenantId,
  fromStatus: RunStatus,
  toStatus: RunStatus,
  updates?: {
    sandbox_id?: string;
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
  },
  options?: { expectedMaxBudgetUsd?: number },
): Promise<boolean> {
  // Validate transition
  if (!VALID_TRANSITIONS[fromStatus]?.includes(toStatus)) {
    logger.warn("Invalid status transition", {
      run_id: runId,
      from: fromStatus,
      to: toStatus,
    });
    return false;
  }

  const setClauses = ["status = $3"];
  const params: unknown[] = [runId, tenantId, toStatus];
  let idx = 4;

  const ALLOWED_COLUMNS = new Set([
    "sandbox_id", "started_at", "completed_at", "result_summary",
    "cost_usd", "total_input_tokens", "total_output_tokens",
    "cache_read_tokens", "cache_creation_tokens", "num_turns",
    "duration_ms", "duration_api_ms", "model_usage",
    "transcript_blob_url", "error_type", "error_messages",
  ]);

  if (updates) {
    for (const [key, value] of Object.entries(updates)) {
      if (value !== undefined) {
        if (!ALLOWED_COLUMNS.has(key)) {
          throw new Error(`Invalid column name in run update: ${key}`);
        }
        setClauses.push(`${key} = $${idx}`);
        params.push(key === "model_usage" ? JSON.stringify(value) : value);
        idx++;
      }
    }
  }

  params.push(fromStatus);
  const result = await execute(
    `UPDATE runs SET ${setClauses.join(", ")}
     WHERE id = $1 AND tenant_id = $2 AND status = $${idx}`,
    params,
  );

  if (result.rowCount === 0) {
    logger.warn("Run status transition failed (stale state)", {
      run_id: runId,
      expected_from: fromStatus,
      to: toStatus,
    });
    return false;
  }

  logger.info("Run status transitioned", { run_id: runId, from: fromStatus, to: toStatus });

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
      logger.warn("Run cost exceeded expected budget", {
        run_id: runId,
        tenant_id: tenantId,
        cost_usd: updates.cost_usd,
        expected_max_budget_usd: options.expectedMaxBudgetUsd,
        overage_usd: updates.cost_usd - options.expectedMaxBudgetUsd,
      });
    }
  }

  return true;
}

export async function getRun(runId: string, tenantId: TenantId) {
  const run = await queryOne(
    RunRow,
    "SELECT * FROM runs WHERE id = $1 AND tenant_id = $2",
    [runId, tenantId],
  );
  if (!run) throw new NotFoundError("Run not found");
  return run;
}

export async function listRuns(
  tenantId: TenantId,
  options: { agentId?: string; sessionId?: string; status?: RunStatus; triggeredBy?: RunTriggeredBy; limit: number; offset: number },
) {
  const conditions = ["tenant_id = $1"];
  const params: unknown[] = [tenantId];
  let idx = 2;

  if (options.agentId) {
    conditions.push(`agent_id = $${idx}`);
    params.push(options.agentId);
    idx++;
  }
  if (options.sessionId) {
    conditions.push(`session_id = $${idx}`);
    params.push(options.sessionId);
    idx++;
  }
  if (options.status) {
    conditions.push(`status = $${idx}`);
    params.push(options.status);
    idx++;
  }
  if (options.triggeredBy) {
    conditions.push(`triggered_by = $${idx}`);
    params.push(options.triggeredBy);
    idx++;
  }

  params.push(options.limit, options.offset);
  return query(
    RunRow,
    `SELECT * FROM runs WHERE ${conditions.join(" AND ")}
     ORDER BY created_at DESC LIMIT $${idx} OFFSET $${idx + 1}`,
    params,
  );
}
