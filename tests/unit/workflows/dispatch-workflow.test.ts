/**
 * dispatchWorkflow unit tests — pin each step's behavior in isolation.
 *
 * Plan reference: U2 in docs/plans/2026-05-05-001-refactor-workflow-sdk-dispatch-plan.md
 *
 * The workflow's step bodies are exported (see dispatch-workflow.ts comment
 * about test-only exports) and called directly with mocked dependencies.
 * Workflow semantics (start, hook iteration, runtime retry) are NOT
 * exercised here — they were verified once on a deployed Vercel preview
 * during the U0 spike (docs/research/wdk-spike-results.md).
 *
 * Each test covers one step's contract:
 *   - reserveStep: persists workflow_run_id with wdk_v1_ prefix after
 *     reserveSessionAndMessage commits
 *   - launchRunnerStep: markRunnerStarted CAS as spawn idempotency; replay
 *     skips spawn when already-started
 *   - writeChunkStep: scrub + asset-persist BEFORE getWritable.write
 *   - finalizeStep: drains workflow stream via getTailIndex, calls
 *     finalizeMessage with assembled chunks
 *   - tailStep: delegates to existing sessionTail
 *
 * The workflow body's for-await + try/catch logic is tested indirectly
 * via the dispatcher characterization tests, which pin the same
 * finalizeMessage edge cases the workflow's finalizeStep delegates to.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TenantId } from "@/lib/types";

// --- Mocks ---

vi.mock("@/db", () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn().mockResolvedValue({ rowCount: 1 }),
  withTenantTransaction: vi.fn().mockImplementation(async (_, cb) => cb({})),
}));

vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/dispatcher", () => ({
  reserveSessionAndMessage: vi.fn(),
  coldStartSandbox: vi.fn(),
  finalizeMessage: vi.fn(),
  sessionTail: vi.fn(),
}));

vi.mock("@/lib/sessions", () => ({
  setWorkflowRunId: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/session-messages", () => ({
  markRunnerStarted: vi.fn(),
}));

vi.mock("@/lib/tenant-auth", () => ({
  resolveSandboxAuth: vi.fn().mockResolvedValue({ token: "auth-token" }),
}));

vi.mock("@/lib/models", () => ({
  resolveEffectiveRunner: vi.fn().mockReturnValue("claude-agent-sdk"),
}));

vi.mock("@/lib/mcp", () => ({
  buildMcpConfig: vi.fn().mockResolvedValue({ servers: {}, errors: [] }),
}));

vi.mock("@/lib/plugins", () => ({
  fetchPluginContent: vi
    .fn()
    .mockResolvedValue({ skillFiles: [], agentFiles: [], warnings: [] }),
}));

vi.mock("@/lib/env", () => ({
  getEnv: vi.fn().mockReturnValue({
    AI_GATEWAY_API_KEY: "gateway-key",
    ENCRYPTION_KEY: "0".repeat(64),
  }),
}));

vi.mock("@/lib/crypto", () => ({
  generateMessageToken: vi.fn().mockResolvedValue("message-token"),
  timingSafeEqual: vi.fn(),
}));

vi.mock("@/lib/transcript-utils", () => ({
  scrubSecrets: vi.fn().mockImplementation((s: string) => s.replace(/SECRET/g, "[REDACTED]")),
  parseResultEvent: vi.fn(),
  NO_TERMINAL_EVENT_FALLBACK: { status: "failed" as const, updates: {} },
  captureTranscript: vi.fn(),
}));

vi.mock("@/lib/assets", () => ({
  processLineAssets: vi.fn().mockImplementation(async (line: string) => line),
}));

// WDK runtime mocks — these are the trickiest. The step bodies invoke
// getWorkflowMetadata, getWritable, getRun. We stub them per-test.
vi.mock("workflow", () => ({
  createHook: vi.fn(),
  getWorkflowMetadata: vi.fn().mockReturnValue({
    workflowName: "dispatchWorkflow",
    workflowRunId: "test-run-id-1",
    workflowStartedAt: new Date(),
    url: "https://test.example/.well-known/workflow/v1/flow",
  }),
  getWritable: vi.fn(),
}));

vi.mock("workflow/api", () => ({
  getRun: vi.fn(),
  resumeHook: vi.fn(),
  start: vi.fn(),
}));

// --- Imports (after vi.mock) ---

import {
  reserveStep,
  ensureSandboxStep,
  launchRunnerStep,
  writeChunkStep,
  finalizeStep,
  tailStep,
  type RunnerChunk,
} from "@/lib/workflows/dispatch-workflow";
import {
  reserveSessionAndMessage,
  coldStartSandbox,
  finalizeMessage,
  sessionTail,
  type DispatchInput,
  type PreparedExecution,
} from "@/lib/dispatcher";
import { setWorkflowRunId } from "@/lib/sessions";
import { markRunnerStarted } from "@/lib/session-messages";
import { scrubSecrets } from "@/lib/transcript-utils";
import { processLineAssets } from "@/lib/assets";
import { getWritable } from "workflow";
import { getRun } from "workflow/api";

// --- Fixtures ---

const tenantId = "tenant-1" as TenantId;
const messageId = "msg-1";

function makeDispatchInput(): DispatchInput {
  return {
    tenantId,
    agentId: "agent-1" as never,
    prompt: "hello",
    triggeredBy: "api",
    platformApiUrl: "https://platform.example",
  };
}

function makePrepared(): PreparedExecution {
  return {
    session: {
      id: "session-1",
      tenant_id: tenantId,
      agent_id: "agent-1",
      sandbox_id: null,
      sdk_session_id: null,
      session_blob_url: null,
      status: "creating",
      ephemeral: false,
      idle_ttl_seconds: 600,
      expires_at: new Date(Date.now() + 4 * 3600_000).toISOString(),
      context_id: null,
      message_count: 0,
      idle_since: null,
      last_backup_at: null,
      mcp_refreshed_at: null,
      workflow_run_id: null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
    } as never,
    agent: {
      id: "agent-1",
      tenant_id: tenantId,
      name: "test-agent",
      model: "claude-sonnet-4-6",
      runner: null,
      plugins: [],
      max_turns: 10,
      max_budget_usd: 1.0,
      max_runtime_seconds: 600,
    } as never,
    messageId,
    effectiveBudget: 1.0,
    effectiveMaxTurns: 10,
  };
}

function makeSandbox() {
  return {
    id: "sandbox-1",
    stop: vi.fn().mockResolvedValue(undefined),
    logs: vi.fn(),
    runMessage: vi.fn().mockResolvedValue({ logs: () => ({ [Symbol.asyncIterator]: () => ({ next: async () => ({ done: true, value: "" }) }) }) }),
    writeSessionFile: vi.fn(),
    readSessionFile: vi.fn(),
    updateMcpConfig: vi.fn(),
    extendTimeout: vi.fn(),
    sandboxRef: undefined as never,
  };
}

// --- Tests ---

describe("dispatchWorkflow steps", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("reserveStep", () => {
    it("delegates to reserveSessionAndMessage and persists workflow_run_id with wdk_v1_ prefix", async () => {
      const prepared = makePrepared();
      vi.mocked(reserveSessionAndMessage).mockResolvedValueOnce(prepared);
      const input = makeDispatchInput();

      const result = await reserveStep(input, "abc123");

      expect(reserveSessionAndMessage).toHaveBeenCalledWith(input);
      expect(setWorkflowRunId).toHaveBeenCalledWith(
        prepared.session.id,
        tenantId,
        "wdk_v1_abc123",
      );
      expect(result).toBe(prepared);
    });

    it("persists runId AFTER reserve commits — order matters for crash safety", async () => {
      const prepared = makePrepared();
      const callOrder: string[] = [];
      vi.mocked(reserveSessionAndMessage).mockImplementationOnce(async () => {
        callOrder.push("reserve");
        return prepared;
      });
      vi.mocked(setWorkflowRunId).mockImplementationOnce(async () => {
        callOrder.push("setRunId");
      });

      await reserveStep(makeDispatchInput(), "xyz");

      expect(callOrder).toEqual(["reserve", "setRunId"]);
    });
  });

  describe("launchRunnerStep", () => {
    it("markRunnerStarted=true (fresh) → calls sandbox.runMessage", async () => {
      vi.mocked(markRunnerStarted).mockResolvedValueOnce(true);
      const prepared = makePrepared();
      const sandbox = makeSandbox();

      await launchRunnerStep(makeDispatchInput(), prepared, sandbox as never);

      expect(markRunnerStarted).toHaveBeenCalledWith(messageId, tenantId);
      expect(sandbox.runMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          prompt: "hello",
          messageId,
          messageToken: "message-token",
          maxTurns: 10,
          maxBudgetUsd: 1.0,
        }),
      );
    });

    it("markRunnerStarted=false (replay) → skips spawn (DB-backed idempotency)", async () => {
      vi.mocked(markRunnerStarted).mockResolvedValueOnce(false);
      const prepared = makePrepared();
      const sandbox = makeSandbox();

      await launchRunnerStep(makeDispatchInput(), prepared, sandbox as never);

      expect(markRunnerStarted).toHaveBeenCalledWith(messageId, tenantId);
      // Critical: the spawn is NOT re-issued on replay. This is the
      // primitive that prevents double-billing on workflow runtime retry.
      expect(sandbox.runMessage).not.toHaveBeenCalled();
    });
  });

  describe("writeChunkStep", () => {
    it("runs scrubSecrets + processLineAssets BEFORE getWritable.write", async () => {
      const callOrder: string[] = [];
      vi.mocked(processLineAssets).mockImplementationOnce(async (s: string) => {
        callOrder.push("processLineAssets");
        return s;
      });
      vi.mocked(scrubSecrets).mockImplementationOnce((s: string) => {
        callOrder.push("scrubSecrets");
        return s.replace(/SECRET/g, "[REDACTED]");
      });
      const writer = {
        write: vi.fn().mockImplementation(async () => {
          callOrder.push("write");
        }),
        releaseLock: vi.fn(),
      };
      vi.mocked(getWritable).mockReturnValueOnce({
        getWriter: () => writer,
      } as never);

      const chunk: RunnerChunk = {
        kind: "chunk",
        line: '{"type":"assistant","content":"hi SECRET=foo"}',
        eventType: "assistant",
      };
      await writeChunkStep(tenantId, messageId, chunk);

      // Order is asset-process → scrub → write. Both transforms run before
      // any byte enters the workflow stream — preserving the institutional
      // learning from transcript-capture-and-streaming-fixes.md.
      expect(callOrder).toEqual(["processLineAssets", "scrubSecrets", "write"]);
      expect(writer.write).toHaveBeenCalledWith(
        expect.stringContaining("[REDACTED]"),
      );
      expect(writer.releaseLock).toHaveBeenCalled();
    });

    it("releases the writer lock even when write throws", async () => {
      const writer = {
        write: vi.fn().mockRejectedValueOnce(new Error("stream closed")),
        releaseLock: vi.fn(),
      };
      vi.mocked(getWritable).mockReturnValueOnce({
        getWriter: () => writer,
      } as never);

      await expect(
        writeChunkStep(tenantId, messageId, {
          kind: "chunk",
          line: "x",
          eventType: "assistant",
        }),
      ).rejects.toThrow("stream closed");

      // Critical: lock release happens in `finally` so a write error
      // doesn't leave the writable in a stuck-locked state.
      expect(writer.releaseLock).toHaveBeenCalled();
    });
  });

  describe("finalizeStep", () => {
    it("drains workflow stream via getTailIndex (NOT plain for-await done)", async () => {
      const reader = {
        read: vi
          .fn()
          .mockResolvedValueOnce({ value: "line-0", done: false })
          .mockResolvedValueOnce({ value: "line-1", done: false }),
        releaseLock: vi.fn(),
      };
      const readable = {
        getReader: vi.fn().mockReturnValue(reader),
        getTailIndex: vi.fn().mockResolvedValue(1), // 0-based: tail=1 = 2 chunks
      };
      vi.mocked(getRun).mockReturnValueOnce({
        getReadable: vi.fn().mockReturnValue(readable),
      } as never);

      await finalizeStep(makePrepared(), makeSandbox() as never, {
        cancelled: false,
      });

      // Bounded read: getTailIndex returned 1, so we read exactly 2 chunks.
      // Critically NOT calling reader.read until {done: true} (that hangs
      // because WDK's writable doesn't auto-close on workflow termination —
      // U0 spike scenarios 3+4 verified this constraint).
      expect(readable.getTailIndex).toHaveBeenCalled();
      expect(reader.read).toHaveBeenCalledTimes(2);
      expect(finalizeMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          messageId,
          tenantId,
          transcriptChunks: ["line-0", "line-1"],
        }),
      );
    });

    it("empty stream (tailIndex < 0) → calls finalizeMessage with empty chunks", async () => {
      const readable = {
        getReader: vi.fn(),
        getTailIndex: vi.fn().mockResolvedValue(-1),
      };
      vi.mocked(getRun).mockReturnValueOnce({
        getReadable: vi.fn().mockReturnValue(readable),
      } as never);

      await finalizeStep(makePrepared(), makeSandbox() as never, {
        cancelled: false,
      });

      // No reader created when tailIndex is -1 — short-circuit.
      expect(readable.getReader).not.toHaveBeenCalled();
      // finalizeMessage's empty-stream characterization (tested separately
      // in dispatcher-characterization.test.ts) handles the empty path —
      // marks message failed with error_type='empty_stream'.
      expect(finalizeMessage).toHaveBeenCalledWith(
        expect.objectContaining({
          transcriptChunks: [],
        }),
      );
    });

    it("releases reader lock and does NOT call readable.cancel() (would kill the run)", async () => {
      const reader = {
        read: vi.fn().mockResolvedValueOnce({ value: "x", done: false }),
        releaseLock: vi.fn(),
      };
      const readable = {
        getReader: vi.fn().mockReturnValue(reader),
        getTailIndex: vi.fn().mockResolvedValue(0),
        cancel: vi.fn(), // present but should NEVER be called by finalizeStep
      };
      vi.mocked(getRun).mockReturnValueOnce({
        getReadable: vi.fn().mockReturnValue(readable),
      } as never);

      await finalizeStep(makePrepared(), makeSandbox() as never, {
        cancelled: false,
      });

      expect(reader.releaseLock).toHaveBeenCalled();
      // U0 spike confirmed calling .cancel() on WorkflowReadableStream
      // propagates upstream and cancels the workflow run itself.
      // The render-shim and finalize step must never call it.
      expect(readable.cancel).not.toHaveBeenCalled();
    });

    it("propagates cancellation flag to logging path (no special finalize args yet — that's deferred)", async () => {
      const readable = {
        getReader: vi.fn(),
        getTailIndex: vi.fn().mockResolvedValue(-1),
      };
      vi.mocked(getRun).mockReturnValueOnce({
        getReadable: vi.fn().mockReturnValue(readable),
      } as never);

      await finalizeStep(makePrepared(), makeSandbox() as never, {
        cancelled: true,
        cancelReason: "user requested",
      });

      // For U2 v1, finalize on cancel still calls finalizeMessage with
      // whatever chunks landed before cancel. The salvage-from-sandbox
      // ordering enhancement is a U2 follow-up (TODO in the file).
      expect(finalizeMessage).toHaveBeenCalled();
    });
  });

  describe("tailStep", () => {
    it("delegates to sessionTail with the prepared lifecycle inputs", async () => {
      const prepared = makePrepared();
      const sandbox = makeSandbox();

      await tailStep(prepared, sandbox as never);

      expect(sessionTail).toHaveBeenCalledWith({
        sessionId: prepared.session.id,
        tenantId,
        sandbox,
        sdkSessionId: prepared.session.sdk_session_id,
        ephemeral: prepared.session.ephemeral,
      });
    });
  });

  describe("ensureSandboxStep", () => {
    it("resolves auth + MCP + plugins in parallel before coldStartSandbox", async () => {
      vi.mocked(coldStartSandbox).mockResolvedValueOnce(makeSandbox() as never);
      const prepared = makePrepared();

      await ensureSandboxStep(makeDispatchInput(), prepared);

      expect(coldStartSandbox).toHaveBeenCalledWith(
        expect.objectContaining({
          agent: prepared.agent,
          tenantId,
          sessionId: prepared.session.id,
          mcpResult: { servers: {}, errors: [] },
          pluginResult: { skillFiles: [], agentFiles: [], warnings: [] },
          auth: { token: "auth-token" },
          effectiveBudget: 1.0,
          effectiveMaxTurns: 10,
        }),
      );
    });
  });
});
