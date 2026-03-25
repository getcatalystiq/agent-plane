import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Mocks ────────────────────────────────────────────────────────────────
vi.mock("@/db", () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn().mockResolvedValue({ rowCount: 1 }),
  withTenantTransaction: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/transcripts", () => ({
  uploadTranscript: vi.fn().mockResolvedValue("https://blob.test/transcript.ndjson"),
}));

vi.mock("@/lib/runs", () => ({
  transitionRunStatus: vi.fn().mockResolvedValue(true),
  createRun: vi.fn(),
  checkTenantBudget: vi.fn(),
}));

vi.mock("@/lib/sessions", () => ({
  transitionSessionStatus: vi.fn().mockResolvedValue(true),
  incrementMessageCount: vi.fn().mockResolvedValue(undefined),
  getSession: vi.fn(),
  updateSessionSandbox: vi.fn(),
  updateSessionMcpRefreshedAt: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/session-files", () => ({
  backupSessionFile: vi.fn().mockResolvedValue("https://blob.test/session.jsonl"),
  restoreSessionFile: vi.fn(),
}));

vi.mock("@/lib/crypto", () => ({
  generateRunToken: vi.fn().mockResolvedValue("test-token"),
  generateId: vi.fn().mockReturnValue("generated-id"),
}));

vi.mock("@/lib/sandbox", () => ({
  createSessionSandbox: vi.fn(),
  reconnectSessionSandbox: vi.fn(),
}));

vi.mock("@/lib/mcp", () => ({
  buildMcpConfig: vi.fn().mockResolvedValue({ servers: [], errors: [] }),
}));

vi.mock("@/lib/plugins", () => ({
  fetchPluginContent: vi.fn().mockResolvedValue({ skillFiles: [], agentFiles: [] }),
}));

vi.mock("@/lib/env", () => ({
  getEnv: vi.fn().mockReturnValue({
    AI_GATEWAY_API_KEY: "test-key",
    ENCRYPTION_KEY: "a".repeat(64),
  }),
}));

vi.mock("@/lib/transcript-utils", () => ({
  parseResultEvent: vi.fn(),
  captureTranscript: vi.fn(),
}));

vi.mock("@/lib/streaming", () => ({
  createNdjsonStream: vi.fn().mockReturnValue(new ReadableStream()),
  ndjsonHeaders: vi.fn().mockReturnValue({ "Content-Type": "application/x-ndjson" }),
}));

import { finalizeSessionMessage, createSessionStreamResponse, prepareSessionSandbox } from "@/lib/session-executor";
import { uploadTranscript } from "@/lib/transcripts";
import { transitionRunStatus } from "@/lib/runs";
import { transitionSessionStatus, incrementMessageCount, updateSessionSandbox } from "@/lib/sessions";
import { backupSessionFile, restoreSessionFile } from "@/lib/session-files";
import { parseResultEvent } from "@/lib/transcript-utils";
import { createSessionSandbox, reconnectSessionSandbox } from "@/lib/sandbox";
import type { RunId, TenantId } from "@/lib/types";
import type { SessionSandboxInstance } from "@/lib/sandbox";

const tenantId = "tenant-1" as TenantId;
const runId = "run-1" as RunId;
const sessionId = "session-1";
const sdkSessionId = "sdk-session-1";

const mockSandbox = {
  id: "sandbox-1",
  readSessionFile: vi.fn(),
  extendTimeout: vi.fn(),
  runMessage: vi.fn(),
  sandboxRef: { writeFiles: vi.fn() },
} as unknown as SessionSandboxInstance;

// ── finalizeSessionMessage ───────────────────────────────────────────────

describe("finalizeSessionMessage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(transitionRunStatus).mockResolvedValue(true);
    vi.mocked(transitionSessionStatus).mockResolvedValue(true);
    vi.mocked(incrementMessageCount).mockResolvedValue(undefined);
    vi.mocked(uploadTranscript).mockResolvedValue("https://blob.test/t.ndjson");
    vi.mocked(backupSessionFile).mockResolvedValue("https://blob.test/s.jsonl");
    vi.mocked(parseResultEvent).mockResolvedValue({
      status: "completed",
      updates: { result_summary: "success", cost_usd: 0.01 },
    });
  });

  it("persists transcript, increments message count, backs up session, transitions to idle", async () => {
    const chunks = [
      JSON.stringify({ type: "assistant", text: "hi" }),
      JSON.stringify({ type: "result", subtype: "success" }),
    ];

    await finalizeSessionMessage(runId, tenantId, sessionId, chunks, 1.0, mockSandbox, sdkSessionId);

    expect(uploadTranscript).toHaveBeenCalledWith(tenantId, runId, expect.stringContaining("assistant"));
    expect(transitionRunStatus).toHaveBeenCalledWith(
      runId, tenantId, "running", "completed",
      expect.objectContaining({ transcript_blob_url: "https://blob.test/t.ndjson" }),
      expect.objectContaining({ expectedMaxBudgetUsd: 1.0 }),
    );
    expect(incrementMessageCount).toHaveBeenCalledWith(sessionId, tenantId);
    expect(backupSessionFile).toHaveBeenCalledWith(mockSandbox, tenantId, sessionId, sdkSessionId);
    expect(transitionSessionStatus).toHaveBeenCalledWith(
      sessionId, tenantId, "active", "idle",
      expect.objectContaining({
        sdk_session_id: sdkSessionId,
        session_blob_url: "https://blob.test/s.jsonl",
      }),
    );
  });

  it("skips transcript upload when chunks are empty", async () => {
    await finalizeSessionMessage(runId, tenantId, sessionId, [], 1.0, mockSandbox, sdkSessionId);

    expect(uploadTranscript).not.toHaveBeenCalled();
    expect(transitionRunStatus).not.toHaveBeenCalled();
    // Should still increment message count and transition
    expect(incrementMessageCount).toHaveBeenCalled();
    expect(transitionSessionStatus).toHaveBeenCalled();
  });

  it("skips session backup when sdkSessionId is null", async () => {
    await finalizeSessionMessage(runId, tenantId, sessionId, [], 1.0, mockSandbox, null);

    expect(backupSessionFile).not.toHaveBeenCalled();
    // Transition should NOT include sdk_session_id or session_blob_url
    const updates = vi.mocked(transitionSessionStatus).mock.calls[0][4] as Record<string, unknown>;
    expect(updates).not.toHaveProperty("sdk_session_id");
    expect(updates).not.toHaveProperty("session_blob_url");
  });

  it("recovers gracefully when transcript upload fails (the bug we fixed)", async () => {
    vi.mocked(uploadTranscript).mockRejectedValue(
      new Error("Vercel Blob: This blob already exists"),
    );

    const chunks = [JSON.stringify({ type: "result", subtype: "success" })];

    // Should NOT throw — catch block handles recovery
    await finalizeSessionMessage(runId, tenantId, sessionId, chunks, 1.0, mockSandbox, sdkSessionId);

    // Best-effort: try to mark run as failed
    expect(transitionRunStatus).toHaveBeenCalledWith(
      runId, tenantId, "running", "failed",
      expect.objectContaining({ error_type: "session_finalize_error" }),
    );

    // Best-effort: transition session to idle (but only with idle_since)
    expect(transitionSessionStatus).toHaveBeenCalledWith(
      sessionId, tenantId, "active", "idle",
      expect.objectContaining({ idle_since: expect.any(String) }),
    );

    // Should NOT have called incrementMessageCount (step 2 never reached)
    expect(incrementMessageCount).not.toHaveBeenCalled();
  });

  it("transitions session to idle even when run status transition fails on stale state", async () => {
    // Internal endpoint already completed the run — transitionRunStatus returns false
    vi.mocked(transitionRunStatus).mockResolvedValue(false);

    const chunks = [JSON.stringify({ type: "result", subtype: "success" })];

    await finalizeSessionMessage(runId, tenantId, sessionId, chunks, 1.0, mockSandbox, sdkSessionId);

    // Should still complete remaining steps
    expect(incrementMessageCount).toHaveBeenCalled();
    expect(backupSessionFile).toHaveBeenCalled();
    expect(transitionSessionStatus).toHaveBeenCalledWith(
      sessionId, tenantId, "active", "idle",
      expect.objectContaining({ sdk_session_id: sdkSessionId }),
    );
  });

  it("handles session backup failure without crashing", async () => {
    vi.mocked(backupSessionFile).mockResolvedValue(null);

    await finalizeSessionMessage(runId, tenantId, sessionId, [], 1.0, mockSandbox, sdkSessionId);

    // Transition should NOT include session_blob_url
    const updates = vi.mocked(transitionSessionStatus).mock.calls[0][4] as Record<string, unknown>;
    expect(updates).not.toHaveProperty("session_blob_url");
    expect(updates).not.toHaveProperty("last_backup_at");
  });

  it("handles error in catch block recovery without double-throwing", async () => {
    vi.mocked(uploadTranscript).mockRejectedValue(new Error("upload failed"));
    // Recovery run transition also fails
    vi.mocked(transitionRunStatus).mockRejectedValue(new Error("db error"));
    // Recovery session transition also fails
    vi.mocked(transitionSessionStatus).mockRejectedValue(new Error("db error"));

    const chunks = [JSON.stringify({ type: "result", subtype: "success" })];

    // Should NOT throw — double-catch protects
    await finalizeSessionMessage(runId, tenantId, sessionId, chunks, 1.0, mockSandbox, sdkSessionId);
  });
});

// ── prepareSessionSandbox ────────────────────────────────────────────────

describe("prepareSessionSandbox", () => {
  const baseParams = {
    sessionId,
    tenantId,
    agent: {
      id: "agent-1",
      tenant_id: tenantId,
      name: "test",
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
      model: "claude-sonnet-4-6" as const,
      allowed_tools: ["Read"],
      permission_mode: "bypassPermissions" as const,
      max_turns: 100,
      max_budget_usd: 1.0,
      max_runtime_seconds: 600,
      a2a_enabled: false,
      a2a_tags: [],
      slug: "test-agent",
      runner: null,
      soul_md: null,
      identity_md: null,
      style_md: null,
      agents_md: null,
      heartbeat_md: null,
      user_template_md: null,
      examples_good_md: null,
      examples_bad_md: null,
      soul_spec_version: "0.5",
      identity: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    },
    prompt: "test",
    platformApiUrl: "https://example.com",
    effectiveBudget: 1.0,
    effectiveMaxTurns: 100,
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("hot path: reconnects to existing sandbox", async () => {
    const existingSandbox = { ...mockSandbox, id: "sbx-existing" };
    vi.mocked(reconnectSessionSandbox).mockResolvedValue(existingSandbox as unknown as SessionSandboxInstance);

    const session = {
      id: sessionId,
      tenant_id: tenantId,
      agent_id: "agent-1",
      sandbox_id: "sbx-existing",
      sdk_session_id: "sdk-1",
      session_blob_url: null,
      status: "active" as const,
      message_count: 1,
      last_backup_at: null,
      mcp_refreshed_at: null,
      idle_since: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_message_at: null,
    };

    const sandbox = await prepareSessionSandbox(baseParams, session);

    expect(reconnectSessionSandbox).toHaveBeenCalledWith("sbx-existing", expect.any(Object));
    expect(createSessionSandbox).not.toHaveBeenCalled();
    expect(sandbox).toBe(existingSandbox);
  });

  it("cold path: creates new sandbox when reconnect fails", async () => {
    vi.mocked(reconnectSessionSandbox).mockResolvedValue(null);
    const newSandbox = { ...mockSandbox, id: "sbx-new" };
    vi.mocked(createSessionSandbox).mockResolvedValue(newSandbox as unknown as SessionSandboxInstance);
    vi.mocked(updateSessionSandbox).mockResolvedValue(undefined);

    const session = {
      id: sessionId,
      tenant_id: tenantId,
      agent_id: "agent-1",
      sandbox_id: "sbx-dead",
      sdk_session_id: null,
      session_blob_url: null,
      status: "active" as const,
      message_count: 0,
      last_backup_at: null,
      mcp_refreshed_at: null,
      idle_since: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_message_at: null,
    };

    const sandbox = await prepareSessionSandbox(baseParams, session);

    expect(reconnectSessionSandbox).toHaveBeenCalled();
    expect(createSessionSandbox).toHaveBeenCalled();
    expect(updateSessionSandbox).toHaveBeenCalledWith(sessionId, tenantId, "sbx-new");
    expect(sandbox).toBe(newSandbox);
  });

  it("cold path: restores session file from blob when resuming", async () => {
    vi.mocked(reconnectSessionSandbox).mockResolvedValue(null);
    const newSandbox = { ...mockSandbox, id: "sbx-new" };
    vi.mocked(createSessionSandbox).mockResolvedValue(newSandbox as unknown as SessionSandboxInstance);
    vi.mocked(updateSessionSandbox).mockResolvedValue(undefined);
    vi.mocked(restoreSessionFile).mockResolvedValue(undefined);

    const session = {
      id: sessionId,
      tenant_id: tenantId,
      agent_id: "agent-1",
      sandbox_id: "sbx-dead",
      sdk_session_id: "sdk-session-abc",
      session_blob_url: "https://blob.test/session.jsonl",
      status: "active" as const,
      message_count: 3,
      last_backup_at: "2026-01-01T00:00:00Z",
      mcp_refreshed_at: null,
      idle_since: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_message_at: new Date().toISOString(),
    };

    await prepareSessionSandbox(baseParams, session);

    expect(restoreSessionFile).toHaveBeenCalledWith(
      newSandbox,
      "https://blob.test/session.jsonl",
      "sdk-session-abc",
    );
  });

  it("cold path: skips restore when no blob URL or sdk_session_id", async () => {
    vi.mocked(reconnectSessionSandbox).mockResolvedValue(null);
    const newSandbox = { ...mockSandbox, id: "sbx-new" };
    vi.mocked(createSessionSandbox).mockResolvedValue(newSandbox as unknown as SessionSandboxInstance);
    vi.mocked(updateSessionSandbox).mockResolvedValue(undefined);

    const session = {
      id: sessionId,
      tenant_id: tenantId,
      agent_id: "agent-1",
      sandbox_id: null,
      sdk_session_id: null,
      session_blob_url: null,
      status: "creating" as const,
      message_count: 0,
      last_backup_at: null,
      mcp_refreshed_at: null,
      idle_since: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_message_at: null,
    };

    await prepareSessionSandbox(baseParams, session);

    expect(restoreSessionFile).not.toHaveBeenCalled();
  });

  it("creates new sandbox when no existing sandbox_id", async () => {
    const newSandbox = { ...mockSandbox, id: "sbx-fresh" };
    vi.mocked(createSessionSandbox).mockResolvedValue(newSandbox as unknown as SessionSandboxInstance);
    vi.mocked(updateSessionSandbox).mockResolvedValue(undefined);

    const session = {
      id: sessionId,
      tenant_id: tenantId,
      agent_id: "agent-1",
      sandbox_id: null,
      sdk_session_id: null,
      session_blob_url: null,
      status: "creating" as const,
      message_count: 0,
      last_backup_at: null,
      mcp_refreshed_at: null,
      idle_since: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      last_message_at: null,
    };

    await prepareSessionSandbox(baseParams, session);

    expect(reconnectSessionSandbox).not.toHaveBeenCalled();
    expect(createSessionSandbox).toHaveBeenCalled();
  });
});

// ── createSessionStreamResponse ──────────────────────────────────────────

describe("createSessionStreamResponse", () => {
  it("returns a Response with correct headers", () => {
    const result = {
      runId,
      sandbox: mockSandbox,
      logIterator: (async function* () {})(),
      transcriptChunks: [] as string[],
      sdkSessionIdRef: { value: null as string | null },
    };

    const response = createSessionStreamResponse(result, tenantId, sessionId, 1.0);
    expect(response).toBeInstanceOf(Response);
    expect(response.status).toBe(200);
  });
});
