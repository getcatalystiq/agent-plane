import { describe, it, expect, vi, beforeEach } from "vitest";
import { SESSION_VALID_TRANSITIONS } from "@/lib/types";

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

import {
  createSession,
  getSession,
  listSessions,
  transitionSessionStatus,
  stopSession,
  incrementMessageCount,
  getIdleSessions,
  getStuckSessions,
  updateSessionSandbox,
} from "@/lib/sessions";
import { execute, queryOne, query, withTenantTransaction } from "@/db";
import {
  NotFoundError,
  ConflictError,
  ConcurrencyLimitError,
} from "@/lib/errors";
import type { TenantId, AgentId } from "@/lib/types";

const tenantId = "tenant-1" as TenantId;
const agentId = "agent-1" as AgentId;
const sessionId = "session-1" as unknown as string;

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
  composio_allowed_tools: [],
  skills: [],
  plugins: [],
  model: "claude-sonnet-4-6",
  allowed_tools: ["Read"],
  permission_mode: "bypassPermissions" as const,
  max_turns: 100,
  max_budget_usd: 1.0,
  max_runtime_seconds: 600,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
};

const mockSession = {
  id: sessionId,
  tenant_id: tenantId,
  agent_id: agentId,
  sandbox_id: null,
  sdk_session_id: null,
  session_blob_url: null,
  status: "creating" as const,
  message_count: 0,
  last_backup_at: null,
  idle_since: null,
  created_at: new Date().toISOString(),
  updated_at: new Date().toISOString(),
  last_message_at: null,
};

describe("SESSION_VALID_TRANSITIONS", () => {
  it("creating can transition to active, idle, stopped", () => {
    expect(SESSION_VALID_TRANSITIONS.creating).toContain("active");
    expect(SESSION_VALID_TRANSITIONS.creating).toContain("idle");
    expect(SESSION_VALID_TRANSITIONS.creating).toContain("stopped");
  });

  it("active can transition to idle, stopped", () => {
    expect(SESSION_VALID_TRANSITIONS.active).toContain("idle");
    expect(SESSION_VALID_TRANSITIONS.active).toContain("stopped");
    expect(SESSION_VALID_TRANSITIONS.active).not.toContain("creating");
  });

  it("idle can transition to active, stopped", () => {
    expect(SESSION_VALID_TRANSITIONS.idle).toContain("active");
    expect(SESSION_VALID_TRANSITIONS.idle).toContain("stopped");
  });

  it("stopped has no valid transitions", () => {
    expect(SESSION_VALID_TRANSITIONS.stopped).toHaveLength(0);
  });
});

describe("createSession", () => {
  let mockTx: {
    queryOne: ReturnType<typeof vi.fn>;
    execute: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockTx = { queryOne: vi.fn(), execute: vi.fn() };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.mocked(withTenantTransaction).mockImplementation(async (_, cb) => cb(mockTx as any));
  });

  it("throws NotFoundError when agent not found", async () => {
    mockTx.queryOne.mockResolvedValueOnce(null);
    await expect(createSession(tenantId, agentId)).rejects.toThrow(NotFoundError);
  });

  it("throws ConcurrencyLimitError when max sessions reached", async () => {
    mockTx.queryOne
      .mockResolvedValueOnce(mockAgent)
      .mockResolvedValueOnce({ status: "active", monthly_budget_usd: 100, current_month_spend: 0 })
      .mockResolvedValueOnce(null); // INSERT returns null = limit reached
    await expect(createSession(tenantId, agentId)).rejects.toThrow(ConcurrencyLimitError);
  });

  it("returns session and agent on success", async () => {
    mockTx.queryOne
      .mockResolvedValueOnce(mockAgent)
      .mockResolvedValueOnce({ status: "active", monthly_budget_usd: 100, current_month_spend: 0 })
      .mockResolvedValueOnce(mockSession);
    const result = await createSession(tenantId, agentId);
    expect(result.session).toEqual(mockSession);
    expect(result.agent).toEqual(mockAgent);
    expect(result.remainingBudget).toBe(100);
  });
});

describe("getSession", () => {
  beforeEach(() => vi.clearAllMocks());

  it("returns session when found", async () => {
    vi.mocked(queryOne).mockResolvedValue(mockSession);
    const session = await getSession(sessionId, tenantId);
    expect(session).toEqual(mockSession);
  });

  it("throws NotFoundError when not found", async () => {
    vi.mocked(queryOne).mockResolvedValue(null);
    await expect(getSession(sessionId, tenantId)).rejects.toThrow(NotFoundError);
  });
});

describe("listSessions", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(query).mockResolvedValue([]);
  });

  it("queries with tenant_id filter", async () => {
    await listSessions(tenantId, { limit: 20, offset: 0 });
    expect(query).toHaveBeenCalledWith(
      expect.anything(),
      expect.stringContaining("tenant_id"),
      expect.arrayContaining([tenantId]),
    );
  });

  it("adds agent_id condition when provided", async () => {
    await listSessions(tenantId, { agentId, limit: 20, offset: 0 });
    const sql = vi.mocked(query).mock.calls[0][1] as string;
    expect(sql).toContain("agent_id");
  });

  it("adds status condition when provided", async () => {
    await listSessions(tenantId, { status: "idle", limit: 20, offset: 0 });
    const sql = vi.mocked(query).mock.calls[0][1] as string;
    expect(sql).toContain("status");
  });
});

describe("transitionSessionStatus", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(execute).mockResolvedValue({ rowCount: 1 });
  });

  it("returns false for invalid transition", async () => {
    const result = await transitionSessionStatus(sessionId, tenantId, "stopped", "active");
    expect(result).toBe(false);
    expect(execute).not.toHaveBeenCalled();
  });

  it("returns true for valid transition (creating→active)", async () => {
    const result = await transitionSessionStatus(sessionId, tenantId, "creating", "active");
    expect(result).toBe(true);
    expect(execute).toHaveBeenCalled();
  });

  it("returns false when execute returns rowCount=0", async () => {
    vi.mocked(execute).mockResolvedValue({ rowCount: 0 });
    const result = await transitionSessionStatus(sessionId, tenantId, "creating", "active");
    expect(result).toBe(false);
  });

  it("passes updates to the query", async () => {
    await transitionSessionStatus(sessionId, tenantId, "creating", "idle", {
      sandbox_id: "sandbox-1",
      idle_since: "2026-01-01T00:00:00Z",
    });
    const sql = vi.mocked(execute).mock.calls[0][0] as string;
    expect(sql).toContain("sandbox_id");
    expect(sql).toContain("idle_since");
  });

  it("throws for invalid column name", async () => {
    await expect(
      transitionSessionStatus(sessionId, tenantId, "creating", "active", {
        ["malicious; DROP TABLE"]: "x",
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any),
    ).rejects.toThrow("Invalid column name");
  });
});

describe("stopSession", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns session as-is if already stopped", async () => {
    const stoppedSession = { ...mockSession, status: "stopped" as const };
    vi.mocked(queryOne).mockResolvedValue(stoppedSession);
    const result = await stopSession(sessionId, tenantId);
    expect(result.status).toBe("stopped");
    expect(execute).not.toHaveBeenCalled();
  });

  it("transitions to stopped and returns updated session", async () => {
    const idleSession = { ...mockSession, status: "idle" as const };
    const stoppedSession = { ...mockSession, status: "stopped" as const };
    vi.mocked(queryOne)
      .mockResolvedValueOnce(idleSession) // getSession
      .mockResolvedValueOnce(stoppedSession); // getSession after stop
    vi.mocked(execute).mockResolvedValue({ rowCount: 1 });
    const result = await stopSession(sessionId, tenantId);
    expect(result.status).toBe("stopped");
  });

  it("throws ConflictError when transition fails", async () => {
    const activeSession = { ...mockSession, status: "active" as const };
    vi.mocked(queryOne).mockResolvedValue(activeSession);
    vi.mocked(execute).mockResolvedValue({ rowCount: 0 });
    await expect(stopSession(sessionId, tenantId)).rejects.toThrow(ConflictError);
  });
});

describe("incrementMessageCount", () => {
  beforeEach(() => vi.clearAllMocks());

  it("calls execute with increment query", async () => {
    vi.mocked(execute).mockResolvedValue({ rowCount: 1 });
    await incrementMessageCount(sessionId, tenantId);
    const sql = vi.mocked(execute).mock.calls[0][0] as string;
    expect(sql).toContain("message_count = message_count + 1");
  });
});

describe("getIdleSessions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("queries idle sessions past per-session TTL", async () => {
    vi.mocked(query).mockResolvedValue([]);
    await getIdleSessions();
    const sql = vi.mocked(query).mock.calls[0][1] as string;
    expect(sql).toContain("status = 'idle'");
    expect(sql).toContain("idle_since");
    // Per-session TTL column is now read from the row, not a global parameter.
    expect(sql).toContain("idle_ttl_seconds");
  });
});

describe("getStuckSessions", () => {
  beforeEach(() => vi.clearAllMocks());

  it("queries stuck creating sessions when called with creating", async () => {
    vi.mocked(query).mockResolvedValue([]);
    await getStuckSessions("creating", 5);
    const sql = vi.mocked(query).mock.calls[0][1] as string;
    expect(sql).toContain("status = $1");
    const params = vi.mocked(query).mock.calls[0][2] as unknown[];
    expect(params).toContain("creating");
    expect(params).toContain(5);
  });

  it("queries stuck active sessions when called with active", async () => {
    vi.mocked(query).mockResolvedValue([]);
    await getStuckSessions("active", 30);
    const params = vi.mocked(query).mock.calls[0][2] as unknown[];
    expect(params).toContain("active");
    expect(params).toContain(30);
  });
});

describe("updateSessionSandbox", () => {
  beforeEach(() => vi.clearAllMocks());

  it("updates sandbox_id", async () => {
    vi.mocked(execute).mockResolvedValue({ rowCount: 1 });
    await updateSessionSandbox(sessionId, tenantId, "sandbox-1");
    expect(execute).toHaveBeenCalledWith(
      expect.stringContaining("sandbox_id"),
      ["sandbox-1", sessionId, tenantId],
    );
  });

  it("throws NotFoundError when session not found", async () => {
    vi.mocked(execute).mockResolvedValue({ rowCount: 0 });
    await expect(updateSessionSandbox(sessionId, tenantId, "sandbox-1")).rejects.toThrow(NotFoundError);
  });
});
