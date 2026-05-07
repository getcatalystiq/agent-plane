/**
 * Dispatcher characterization tests.
 *
 * Per U2's execution note (docs/plans/2026-05-05-001-refactor-workflow-sdk-dispatch-plan.md),
 * these tests pin the legacy dispatcher's behavior on edge cases that are
 * already-fixed in production. They land BEFORE the workflow code so the
 * workflow path's parity bar is measurable against an immutable baseline.
 *
 * Each test names the originating commit sha. The U2 workflow path's test
 * suite (`tests/unit/workflows/dispatch-workflow.test.ts`) will run the
 * same scenarios against the workflow body to assert byte-identical
 * outcomes.
 *
 * Scope: dispatcher-level edge cases (finalizeMessage). Schedule + cleanup
 * cron edge cases (ca384ff, 09ed4f0, 375d826) are tested in their own
 * route-level test files when those are added in U6/U7.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TenantId } from "@/lib/types";

// --- Mocks ---

vi.mock("@/db", () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn().mockResolvedValue({ rowCount: 1 }),
  withTenantTransaction: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

vi.mock("@/lib/session-messages", () => ({
  transitionMessageStatus: vi.fn().mockResolvedValue(true),
  checkTenantBudget: vi.fn(),
}));

vi.mock("@/lib/sessions", async () => {
  const actual = await vi.importActual<typeof import("@/lib/sessions")>("@/lib/sessions");
  return {
    ...actual,
    transitionSessionStatus: vi.fn().mockResolvedValue(true),
    casToStopped: vi.fn().mockResolvedValue({}),
    incrementMessageCount: vi.fn().mockResolvedValue(undefined),
    updateSessionMcpRefreshedAt: vi.fn().mockResolvedValue(undefined),
  };
});

vi.mock("@/lib/transcripts", () => ({
  uploadTranscript: vi.fn().mockResolvedValue("https://blob.example/transcript.ndjson"),
}));

vi.mock("@/lib/session-files", () => ({
  backupSessionFile: vi.fn().mockResolvedValue("https://blob.example/session.json"),
  restoreSessionFile: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("@/lib/transcript-utils", async () => {
  const actual = await vi.importActual<typeof import("@/lib/transcript-utils")>(
    "@/lib/transcript-utils",
  );
  return {
    ...actual,
    parseResultEvent: vi.fn(),
  };
});

// --- Imports (must come AFTER vi.mock calls) ---

import { finalizeMessage } from "@/lib/dispatcher";
import { transitionMessageStatus } from "@/lib/session-messages";
import { transitionSessionStatus, casToStopped, incrementMessageCount } from "@/lib/sessions";
import { uploadTranscript } from "@/lib/transcripts";
import { backupSessionFile } from "@/lib/session-files";
import { parseResultEvent, NO_TERMINAL_EVENT_FALLBACK } from "@/lib/transcript-utils";
import { queryOne } from "@/db";

// --- Fixtures ---

const tenantId = "tenant-1" as TenantId;
const messageId = "550e8400-e29b-41d4-a716-446655440000";

function makePersistentSession() {
  return {
    id: "session-1",
    tenant_id: tenantId,
    agent_id: "agent-1",
    sandbox_id: "sandbox-1",
    sdk_session_id: "sdk-1",
    session_blob_url: null,
    status: "active" as const,
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
  };
}

function makeEphemeralSession() {
  return { ...makePersistentSession(), ephemeral: true };
}

function makeSandbox() {
  return {
    id: "sandbox-1",
    stop: vi.fn().mockResolvedValue(undefined),
    logs: vi.fn(),
    runMessage: vi.fn(),
    writeSessionFile: vi.fn(),
    updateMcpConfig: vi.fn(),
    extendTimeout: vi.fn(),
    sandboxRef: undefined,
  };
}

// --- Tests ---

describe("dispatcher characterization (legacy behavior pins)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(uploadTranscript).mockResolvedValue("https://blob.example/transcript.ndjson");
    vi.mocked(transitionMessageStatus).mockResolvedValue(true);
    vi.mocked(transitionSessionStatus).mockResolvedValue(true);
    vi.mocked(casToStopped).mockResolvedValue({} as ReturnType<typeof casToStopped> extends Promise<infer T> ? T : never);
    vi.mocked(incrementMessageCount).mockResolvedValue(undefined);
    vi.mocked(backupSessionFile).mockResolvedValue("https://blob.example/session.json");
  });

  describe("finalizeMessage — empty stream path", () => {
    // Pins behavior from 277a5e5 fix(dispatcher): finalize message on empty
    // stream + iterator throw. Before the fix, an empty transcriptChunks
    // array left the message stuck in `running` because finalizeMessage's
    // transition only ran in the `chunks.length > 0` branch.

    it("277a5e5: empty transcript chunks → message marked 'failed' with error_type='empty_stream'", async () => {
      // currentStatus query returns 'running' so finalize is not idempotent-skipped
      vi.mocked(queryOne).mockResolvedValueOnce({ status: "running" });

      await finalizeMessage({
        messageId,
        tenantId,
        session: makePersistentSession(),
        sandbox: makeSandbox() as unknown as Parameters<typeof finalizeMessage>[0]["sandbox"],
        sdkSessionId: "sdk-1",
        transcriptChunks: [],
        effectiveBudget: 1.0,
      });

      // The empty-stream branch transitions message to failed with the
      // specific error_type so the schedule cron's outer fallback isn't
      // doing double-duty.
      expect(transitionMessageStatus).toHaveBeenCalledWith(
        messageId,
        tenantId,
        "running",
        "failed",
        expect.objectContaining({
          error_type: "empty_stream",
          error_messages: expect.arrayContaining([expect.stringMatching(/no non-text_delta events/i)]),
          completed_at: expect.any(String),
        }),
      );
      // No transcript blob is uploaded (no chunks)
      expect(uploadTranscript).not.toHaveBeenCalled();
    });

    it("277a5e5: empty stream + persistent session → session transitions active→idle via tail", async () => {
      vi.mocked(queryOne).mockResolvedValueOnce({ status: "running" });

      await finalizeMessage({
        messageId,
        tenantId,
        session: makePersistentSession(),
        sandbox: makeSandbox() as unknown as Parameters<typeof finalizeMessage>[0]["sandbox"],
        sdkSessionId: "sdk-1",
        transcriptChunks: [],
        effectiveBudget: 1.0,
      });

      // sessionTail runs even on empty path — incrementMessageCount + idle transition
      expect(incrementMessageCount).toHaveBeenCalledWith("session-1", tenantId);
      expect(transitionSessionStatus).toHaveBeenCalledWith(
        "session-1",
        tenantId,
        "active",
        "idle",
        expect.any(Object),
      );
    });
  });

  describe("finalizeMessage — happy path with chunks", () => {
    it("non-empty chunks: parses last-line result event, uploads transcript, transitions message to result.status", async () => {
      vi.mocked(queryOne).mockResolvedValueOnce({ status: "running" });
      vi.mocked(parseResultEvent).mockResolvedValueOnce({
        status: "completed",
        updates: { cost_usd: 0.05, num_turns: 3, total_input_tokens: 100, total_output_tokens: 200 },
      });

      await finalizeMessage({
        messageId,
        tenantId,
        session: makePersistentSession(),
        sandbox: makeSandbox() as unknown as Parameters<typeof finalizeMessage>[0]["sandbox"],
        sdkSessionId: "sdk-1",
        transcriptChunks: [
          '{"type":"assistant","content":"hi"}',
          '{"type":"result","status":"completed","cost_usd":0.05}',
        ],
        effectiveBudget: 1.0,
      });

      expect(uploadTranscript).toHaveBeenCalledWith(
        tenantId,
        messageId,
        expect.stringContaining('"type":"assistant"'),
      );
      expect(transitionMessageStatus).toHaveBeenCalledWith(
        messageId,
        tenantId,
        "running",
        "completed",
        expect.objectContaining({
          transcript_blob_url: "https://blob.example/transcript.ndjson",
          cost_usd: 0.05,
        }),
        { expectedMaxBudgetUsd: 1.0 },
      );
    });

    it("non-empty chunks but unparseable last-line: falls back to NO_TERMINAL_EVENT_FALLBACK", async () => {
      vi.mocked(queryOne).mockResolvedValueOnce({ status: "running" });
      vi.mocked(parseResultEvent).mockResolvedValueOnce(null);

      await finalizeMessage({
        messageId,
        tenantId,
        session: makePersistentSession(),
        sandbox: makeSandbox() as unknown as Parameters<typeof finalizeMessage>[0]["sandbox"],
        sdkSessionId: "sdk-1",
        transcriptChunks: ['{"type":"assistant","content":"hi"}'],
        effectiveBudget: 1.0,
      });

      expect(transitionMessageStatus).toHaveBeenCalledWith(
        messageId,
        tenantId,
        "running",
        NO_TERMINAL_EVENT_FALLBACK.status,
        expect.objectContaining(NO_TERMINAL_EVENT_FALLBACK.updates),
        { expectedMaxBudgetUsd: 1.0 },
      );
    });
  });

  describe("finalizeMessage — idempotency", () => {
    // Pins the runner-driven internal-upload race protection: when the
    // runner has already POSTed the terminal event and the internal
    // endpoint finalized the message, the dispatcher's finalizeMessage
    // must short-circuit without re-uploading the transcript or
    // re-transitioning state.

    it("status != 'running' → short-circuit (no upload, no transition, no tail)", async () => {
      // currentStatus is 'completed' — runner-uploaded path won the race
      vi.mocked(queryOne).mockResolvedValueOnce({ status: "completed" });

      await finalizeMessage({
        messageId,
        tenantId,
        session: makePersistentSession(),
        sandbox: makeSandbox() as unknown as Parameters<typeof finalizeMessage>[0]["sandbox"],
        sdkSessionId: "sdk-1",
        transcriptChunks: ['{"type":"result"}'],
        effectiveBudget: 1.0,
      });

      expect(uploadTranscript).not.toHaveBeenCalled();
      expect(transitionMessageStatus).not.toHaveBeenCalled();
      expect(incrementMessageCount).not.toHaveBeenCalled();
      expect(transitionSessionStatus).not.toHaveBeenCalled();
    });

    it("status='failed' (runner-uploaded an error) → short-circuit identically", async () => {
      vi.mocked(queryOne).mockResolvedValueOnce({ status: "failed" });

      await finalizeMessage({
        messageId,
        tenantId,
        session: makePersistentSession(),
        sandbox: makeSandbox() as unknown as Parameters<typeof finalizeMessage>[0]["sandbox"],
        sdkSessionId: "sdk-1",
        transcriptChunks: ['{"type":"error"}'],
        effectiveBudget: 1.0,
      });

      expect(uploadTranscript).not.toHaveBeenCalled();
      expect(transitionMessageStatus).not.toHaveBeenCalled();
      expect(incrementMessageCount).not.toHaveBeenCalled();
    });
  });

  describe("finalizeMessage — ephemeral vs persistent tail", () => {
    it("ephemeral session → casToStopped + sandbox.stop", async () => {
      vi.mocked(queryOne).mockResolvedValueOnce({ status: "running" });
      vi.mocked(parseResultEvent).mockResolvedValueOnce({
        status: "completed",
        updates: {},
      });
      const sandbox = makeSandbox();

      await finalizeMessage({
        messageId,
        tenantId,
        session: makeEphemeralSession(),
        sandbox: sandbox as unknown as Parameters<typeof finalizeMessage>[0]["sandbox"],
        sdkSessionId: "sdk-1",
        transcriptChunks: ['{"type":"result"}'],
        effectiveBudget: 1.0,
      });

      expect(casToStopped).toHaveBeenCalledWith("session-1", tenantId);
      expect(sandbox.stop).toHaveBeenCalled();
      // Ephemeral path skips session-blob backup — saves I/O under high
      // webhook/schedule fan-in.
      expect(backupSessionFile).not.toHaveBeenCalled();
    });

    it("persistent session → backupSessionFile + transitionSessionStatus active→idle", async () => {
      vi.mocked(queryOne).mockResolvedValueOnce({ status: "running" });
      vi.mocked(parseResultEvent).mockResolvedValueOnce({
        status: "completed",
        updates: {},
      });

      await finalizeMessage({
        messageId,
        tenantId,
        session: makePersistentSession(),
        sandbox: makeSandbox() as unknown as Parameters<typeof finalizeMessage>[0]["sandbox"],
        sdkSessionId: "sdk-1",
        transcriptChunks: ['{"type":"result"}'],
        effectiveBudget: 1.0,
      });

      expect(backupSessionFile).toHaveBeenCalled();
      expect(transitionSessionStatus).toHaveBeenCalledWith(
        "session-1",
        tenantId,
        "active",
        "idle",
        expect.objectContaining({
          idle_since: expect.any(String),
          session_blob_url: "https://blob.example/session.json",
        }),
      );
      expect(casToStopped).not.toHaveBeenCalled();
    });
  });

  describe("finalizeMessage — error path", () => {
    // Best-effort: when the finalize machinery itself throws (e.g., DB
    // hiccup during transitionMessageStatus), the catch block marks the
    // message failed and idles/stops the session so the row doesn't leak.

    it("upload failure → message marked 'failed' with error_type='finalize_error', session still transitions", async () => {
      vi.mocked(queryOne).mockResolvedValueOnce({ status: "running" });
      vi.mocked(uploadTranscript).mockRejectedValueOnce(new Error("Blob upload exploded"));

      await finalizeMessage({
        messageId,
        tenantId,
        session: makePersistentSession(),
        sandbox: makeSandbox() as unknown as Parameters<typeof finalizeMessage>[0]["sandbox"],
        sdkSessionId: "sdk-1",
        transcriptChunks: ['{"type":"result"}'],
        effectiveBudget: 1.0,
      });

      // The catch block marks the message failed with finalize_error
      expect(transitionMessageStatus).toHaveBeenCalledWith(
        messageId,
        tenantId,
        "running",
        "failed",
        expect.objectContaining({
          error_type: "finalize_error",
          error_messages: expect.arrayContaining([expect.stringContaining("Blob upload exploded")]),
        }),
      );
      // The catch block also idles the session (persistent) so the row
      // doesn't leak in `active` forever.
      expect(transitionSessionStatus).toHaveBeenCalledWith(
        "session-1",
        tenantId,
        "active",
        "idle",
        expect.objectContaining({ idle_since: expect.any(String) }),
      );
    });
  });
});
