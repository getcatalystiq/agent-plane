import { describe, it, expect, vi, beforeEach } from "vitest";
import { VALID_TRANSITIONS } from "@/lib/types";

vi.mock("@/db", () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn().mockResolvedValue({ rowCount: 1 }),
  withTenantTransaction: vi.fn(),
}));

vi.mock("@/lib/crypto", () => ({
  generateId: vi.fn().mockReturnValue("generated-id"),
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

import { transitionRunStatus, createRun, getRun, listRuns } from "@/lib/runs";
import { execute, queryOne, query, withTenantTransaction } from "@/db";
import {
  NotFoundError,
  ForbiddenError,
  BudgetExceededError,
  ConcurrencyLimitError,
} from "@/lib/errors";
import type { TenantId, AgentId, RunId } from "@/lib/types";

const tenantId = "tenant-1" as TenantId;
const agentId = "agent-1" as AgentId;
const runId = "run-1" as RunId;

// Mock agent row (matches AgentRowInternal schema)
const mockAgent = {
  id: agentId,
  tenant_id: tenantId,
  name: "test-agent",
  description: null,
  git_repo_url: null,
  git_branch: "main",
  composio_toolkits: [],
  composio_mcp_server_id: null,
  composio_mcp_server_name: null,
  composio_mcp_url: null,
  composio_mcp_api_key_enc: null,
  skills: [],
  model: "claude-sonnet-4-6",
  allowed_tools: ["Read"],
  permission_mode: "bypassPermissions" as const,
  max_turns: 100,
  max_budget_usd: 1.0,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

// Mock run row
const mockRun = {
  id: runId,
  agent_id: agentId,
  tenant_id: tenantId,
  status: "pending" as const,
  prompt: "test",
  result_summary: null,
  total_input_tokens: 0,
  total_output_tokens: 0,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
  cost_usd: 0,
  num_turns: 0,
  duration_ms: 0,
  duration_api_ms: 0,
  model_usage: null,
  transcript_blob_url: null,
  error_type: null,
  error_messages: [],
  sandbox_id: null,
  started_at: null,
  completed_at: null,
  created_at: new Date().toISOString(),
};

describe("VALID_TRANSITIONS", () => {
  it("pending can transition to running, failed, cancelled", () => {
    expect(VALID_TRANSITIONS.pending).toContain("running");
    expect(VALID_TRANSITIONS.pending).toContain("failed");
    expect(VALID_TRANSITIONS.pending).toContain("cancelled");
  });

  it("pending cannot transition to completed or timed_out", () => {
    expect(VALID_TRANSITIONS.pending).not.toContain("completed");
    expect(VALID_TRANSITIONS.pending).not.toContain("timed_out");
  });

  it("running can transition to completed, failed, cancelled, timed_out", () => {
    expect(VALID_TRANSITIONS.running).toContain("completed");
    expect(VALID_TRANSITIONS.running).toContain("failed");
    expect(VALID_TRANSITIONS.running).toContain("cancelled");
    expect(VALID_TRANSITIONS.running).toContain("timed_out");
  });

  it("terminal statuses have no valid transitions", () => {
    expect(VALID_TRANSITIONS.completed).toHaveLength(0);
    expect(VALID_TRANSITIONS.failed).toHaveLength(0);
    expect(VALID_TRANSITIONS.cancelled).toHaveLength(0);
    expect(VALID_TRANSITIONS.timed_out).toHaveLength(0);
  });
});

describe("transitionRunStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(execute).mockResolvedValue({ rowCount: 1 });
  });

  it("returns false for invalid transition without calling execute", async () => {
    const result = await transitionRunStatus(runId, tenantId, "pending", "completed");
    expect(result).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns true for valid transition (pending→running)", async () => {
    const result = await transitionRunStatus(runId, tenantId, "pending", "running");
    expect(result).toBe(true);
    expect(execute).toHaveBeenCalled();
  });

  it("returns false when execute returns rowCount=0 (stale state)", async () => {
    vi.mocked(execute).mockResolvedValue({ rowCount: 0 });
    const result = await transitionRunStatus(runId, tenantId, "pending", "running");
    expect(result).toBe(false);
  });

  it("calls execute twice for billable terminal status with cost_usd", async () => {
    const result = await transitionRunStatus(runId, tenantId, "running", "completed", {
      cost_usd: 0.05,
    });
    expect(result).toBe(true);
    expect(execute).toHaveBeenCalledTimes(2); // update run + update tenant spend
  });

  it("calls execute once for terminal status without cost_usd", async () => {
    const result = await transitionRunStatus(runId, tenantId, "running", "completed");
    expect(result).toBe(true);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("serializes model_usage as JSON string", async () => {
    await transitionRunStatus(runId, tenantId, "pending", "running", {
      model_usage: { "claude-sonnet-4-6": { input: 100, output: 50 } },
    });
    const params = vi.mocked(execute).mock.calls[0][1] as unknown[];
    const modelUsageParam = params.find(
      (p) => typeof p === "string" && p.includes("claude-sonnet"),
    );
    expect(modelUsageParam).toBeDefined();
    expect(typeof modelUsageParam).toBe("string");
  });

  it("throws for invalid column name in updates", async () => {
    await expect(
      transitionRunStatus(runId, tenantId, "pending", "running", {
        ["malicious; DROP TABLE runs--"]: "x",
      } as any),
    ).rejects.toThrow("Invalid column name");
  });
});

describe("createRun", () => {
  let mockTx: {
    queryOne: ReturnType<typeof vi.fn>;
    execute: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockTx = { queryOne: vi.fn(), execute: vi.fn() };
    vi.mocked(withTenantTransaction).mockImplementation(async (_, cb) => cb(mockTx as any));
  });

  it("throws NotFoundError when agent not found", async () => {
    mockTx.queryOne.mockResolvedValueOnce(null);
    await expect(createRun(tenantId, agentId, "prompt")).rejects.toThrow(NotFoundError);
  });

  it("throws ForbiddenError when tenant is suspended", async () => {
    mockTx.queryOne
      .mockResolvedValueOnce(mockAgent)
      .mockResolvedValueOnce({
        status: "suspended",
        monthly_budget_usd: 100,
        current_month_spend: 0,
      });
    await expect(createRun(tenantId, agentId, "prompt")).rejects.toThrow(ForbiddenError);
  });

  it("throws BudgetExceededError when spend >= budget", async () => {
    mockTx.queryOne
      .mockResolvedValueOnce(mockAgent)
      .mockResolvedValueOnce({
        status: "active",
        monthly_budget_usd: 10,
        current_month_spend: 10,
      });
    await expect(createRun(tenantId, agentId, "prompt")).rejects.toThrow(BudgetExceededError);
  });

  it("throws ConcurrencyLimitError when INSERT returns null", async () => {
    mockTx.queryOne
      .mockResolvedValueOnce(mockAgent)
      .mockResolvedValueOnce({
        status: "active",
        monthly_budget_usd: 100,
        current_month_spend: 0,
      })
      .mockResolvedValueOnce(null);
    await expect(createRun(tenantId, agentId, "prompt")).rejects.toThrow(ConcurrencyLimitError);
  });

  it("returns { run, agent, remainingBudget } on success", async () => {
    mockTx.queryOne
      .mockResolvedValueOnce(mockAgent)
      .mockResolvedValueOnce({
        status: "active",
        monthly_budget_usd: 100,
        current_month_spend: 20,
      })
      .mockResolvedValueOnce(mockRun);
    const result = await createRun(tenantId, agentId, "prompt");
    expect(result.run).toEqual(mockRun);
    expect(result.agent).toEqual(mockAgent);
    expect(result.remainingBudget).toBe(80);
  });

  it("sets remainingBudget to Infinity when no budget row", async () => {
    mockTx.queryOne
      .mockResolvedValueOnce(mockAgent)
      .mockResolvedValueOnce(null) // no budget row
      .mockResolvedValueOnce(mockRun);
    const result = await createRun(tenantId, agentId, "prompt");
    expect(result.remainingBudget).toBe(Infinity);
  });
});

describe("getRun", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns run when found", async () => {
    vi.mocked(queryOne).mockResolvedValue(mockRun);
    const run = await getRun(runId, tenantId);
    expect(run).toEqual(mockRun);
  });

  it("throws NotFoundError when run not found", async () => {
    vi.mocked(queryOne).mockResolvedValue(null);
    await expect(getRun(runId, tenantId)).rejects.toThrow(NotFoundError);
  });
});

describe("listRuns", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(query).mockResolvedValue([]);
  });

  it("queries all runs for tenant with no filters", async () => {
    await listRuns(tenantId, { limit: 20, offset: 0 });
    expect(query).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("tenant_id"),
      expect.arrayContaining([tenantId]),
    );
  });

  it("adds agent_id condition when agentId provided", async () => {
    await listRuns(tenantId, { agentId, limit: 20, offset: 0 });
    const sql = vi.mocked(query).mock.calls[0][1] as string;
    expect(sql).toContain("agent_id");
  });

  it("adds status condition when status provided", async () => {
    await listRuns(tenantId, { status: "running", limit: 20, offset: 0 });
    const sql = vi.mocked(query).mock.calls[0][1] as string;
    expect(sql).toContain("status");
  });
});
