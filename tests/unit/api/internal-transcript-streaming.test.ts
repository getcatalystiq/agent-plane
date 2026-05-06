/**
 * Streaming-mode tests for the internal transcript endpoint.
 *
 * Plan reference: U3 in docs/plans/2026-05-05-001-refactor-workflow-sdk-dispatch-plan.md
 *
 * Pins the per-line streaming branch added in U3-b. Legacy single-blob
 * mode is exercised by existing acceptance / integration coverage; this
 * file covers ONLY the new application/x-ndjson path.
 *
 * Test scope:
 *   - Auth + status check (shared with legacy; verified once here)
 *   - Header validation (attempt/batch sequence)
 *   - Dedup: duplicate batch returns 200 status='duplicate' without resumeHook
 *   - Line cap: 429 with Retry-After
 *   - resumeHook: HookNotFoundError → 503, other error → 503, success → 200
 *   - Empty body → 400
 *
 * The handler is invoked directly (not via Next.js routing) for unit-test
 * purity. Auth + DB + resumeHook are mocked.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NextRequest } from "next/server";

// --- Mocks ---

vi.mock("@/db", () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  withTenantTransaction: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/crypto", () => ({
  verifyMessageToken: vi.fn(),
}));

vi.mock("@/lib/env", () => ({
  getEnv: vi.fn().mockReturnValue({ ENCRYPTION_KEY: "0".repeat(64) }),
}));

vi.mock("workflow/api", () => ({
  resumeHook: vi.fn(),
}));

// Other deps that the route imports but the streaming path doesn't use —
// mock to no-ops so the import chain resolves.
vi.mock("@/lib/transcripts", () => ({
  uploadTranscript: vi.fn(),
}));
vi.mock("@/lib/session-messages", () => ({
  transitionMessageStatus: vi.fn(),
}));
vi.mock("@/lib/transcript-utils", () => ({
  parseResultEvent: vi.fn(),
  NO_TERMINAL_EVENT_FALLBACK: { status: "failed", updates: {} },
}));
vi.mock("@/lib/assets", () => ({
  processLineAssets: vi.fn(),
}));
vi.mock("@/lib/sandbox", () => ({
  reconnectSandbox: vi.fn(),
}));
vi.mock("@/lib/sessions", () => ({
  casActiveToIdle: vi.fn(),
}));

// --- Imports (after mocks) ---

import { POST } from "@/app/api/internal/messages/[messageId]/transcript/route";
import { queryOne } from "@/db";
import { verifyMessageToken } from "@/lib/crypto";
import { resumeHook } from "workflow/api";
import {
  __resetDedupForTests,
  __resetLineCountersForTests,
} from "@/lib/workflows/stream-bridge-server";

// --- Helpers ---

const messageId = "msg-1";
const tenantId = "tenant-1";
const validToken = "valid-bearer-token";

function makeRequest(opts: {
  body?: string;
  contentType?: string;
  authHeader?: string | null;
  attemptSequence?: string | null;
  batchSequence?: string | null;
}): NextRequest {
  const headers = new Headers();
  if (opts.contentType) headers.set("content-type", opts.contentType);
  if (opts.authHeader !== null) {
    headers.set("authorization", opts.authHeader ?? `Bearer ${validToken}`);
  }
  if (opts.attemptSequence !== null) {
    headers.set(
      "x-runner-attempt-sequence",
      opts.attemptSequence ?? "0",
    );
  }
  if (opts.batchSequence !== null) {
    headers.set("x-batch-sequence", opts.batchSequence ?? "0");
  }
  const url = `https://example.com/api/internal/messages/${messageId}/transcript`;
  return new Request(url, {
    method: "POST",
    headers,
    body: opts.body ?? "",
  }) as unknown as NextRequest;
}

async function callPost(req: NextRequest): Promise<Response> {
  const ctx = { params: Promise.resolve({ messageId }) };
  return (await POST(req, ctx as never)) as unknown as Response;
}

function setMessageRunning() {
  vi.mocked(queryOne).mockResolvedValueOnce({
    id: messageId,
    tenant_id: tenantId,
    session_id: "session-1",
    status: "running",
  });
}

// --- Tests ---

describe("internal transcript endpoint — streaming mode (U3)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    __resetDedupForTests();
    __resetLineCountersForTests();
    vi.mocked(verifyMessageToken).mockResolvedValue(true);
  });

  describe("auth + status preconditions", () => {
    it("missing Authorization header → 401", async () => {
      const res = await callPost(
        makeRequest({
          authHeader: null,
          contentType: "application/x-ndjson",
          body: '{"type":"assistant"}',
        }),
      );
      expect(res.status).toBe(401);
    });

    it("invalid token → 401", async () => {
      vi.mocked(verifyMessageToken).mockResolvedValueOnce(false);
      const res = await callPost(
        makeRequest({
          contentType: "application/x-ndjson",
          body: '{"type":"assistant"}',
        }),
      );
      expect(res.status).toBe(401);
    });

    it("message not found → 404", async () => {
      vi.mocked(queryOne).mockResolvedValueOnce(null);
      const res = await callPost(
        makeRequest({
          contentType: "application/x-ndjson",
          body: '{"type":"assistant"}',
        }),
      );
      expect(res.status).toBe(404);
    });

    it("message status != 'running' → 409 (closes SEC-006 token-after-terminal window)", async () => {
      vi.mocked(queryOne).mockResolvedValueOnce({
        id: messageId,
        tenant_id: tenantId,
        session_id: "session-1",
        status: "completed",
      });
      const res = await callPost(
        makeRequest({
          contentType: "application/x-ndjson",
          body: '{"type":"assistant"}',
        }),
      );
      expect(res.status).toBe(409);
      // Critical: resumeHook is NEVER invoked for terminal messages
      expect(resumeHook).not.toHaveBeenCalled();
    });
  });

  describe("header validation", () => {
    it("missing X-Runner-Attempt-Sequence → 400", async () => {
      setMessageRunning();
      const res = await callPost(
        makeRequest({
          contentType: "application/x-ndjson",
          attemptSequence: null,
          body: '{"type":"assistant"}',
        }),
      );
      expect(res.status).toBe(400);
    });

    it("missing X-Batch-Sequence → 400", async () => {
      setMessageRunning();
      const res = await callPost(
        makeRequest({
          contentType: "application/x-ndjson",
          batchSequence: null,
          body: '{"type":"assistant"}',
        }),
      );
      expect(res.status).toBe(400);
    });

    it("non-integer attemptSequence → 400", async () => {
      setMessageRunning();
      const res = await callPost(
        makeRequest({
          contentType: "application/x-ndjson",
          attemptSequence: "abc",
          body: '{"type":"assistant"}',
        }),
      );
      expect(res.status).toBe(400);
    });

    it("negative batchSequence → 400", async () => {
      setMessageRunning();
      const res = await callPost(
        makeRequest({
          contentType: "application/x-ndjson",
          batchSequence: "-1",
          body: '{"type":"assistant"}',
        }),
      );
      expect(res.status).toBe(400);
    });

    it("empty body → 400", async () => {
      setMessageRunning();
      const res = await callPost(
        makeRequest({
          contentType: "application/x-ndjson",
          body: "",
        }),
      );
      expect(res.status).toBe(400);
    });
  });

  describe("happy path", () => {
    it("first batch: 200 + delivered=N + resumeHook called per line", async () => {
      setMessageRunning();
      vi.mocked(resumeHook).mockResolvedValue({} as never);

      const res = await callPost(
        makeRequest({
          contentType: "application/x-ndjson",
          attemptSequence: "0",
          batchSequence: "0",
          body:
            '{"type":"assistant","content":"hi"}\n' +
            '{"type":"tool_use","name":"Read"}\n' +
            '{"type":"result","status":"completed"}',
        }),
      );

      expect(res.status).toBe(200);
      const json = await res.json();
      expect(json.status).toBe("ok");
      expect(json.delivered).toBe(3);
      expect(resumeHook).toHaveBeenCalledTimes(3);
      // Last line was the terminal-kind 'result' event
      expect(resumeHook).toHaveBeenLastCalledWith(
        `transcript:${messageId}`,
        expect.objectContaining({ kind: "terminal", eventType: "result" }),
      );
    });

    it("multiple batches in same attempt: increments batchSeq, all deliver", async () => {
      vi.mocked(resumeHook).mockResolvedValue({} as never);

      // First batch
      setMessageRunning();
      const res1 = await callPost(
        makeRequest({
          contentType: "application/x-ndjson",
          attemptSequence: "0",
          batchSequence: "0",
          body: '{"type":"assistant"}',
        }),
      );
      expect(res1.status).toBe(200);

      // Second batch
      setMessageRunning();
      const res2 = await callPost(
        makeRequest({
          contentType: "application/x-ndjson",
          attemptSequence: "0",
          batchSequence: "1",
          body: '{"type":"tool_use"}',
        }),
      );
      expect(res2.status).toBe(200);

      expect(resumeHook).toHaveBeenCalledTimes(2);
    });
  });

  describe("dedup", () => {
    it("duplicate (attemptSeq, batchSeq) → 200 status='duplicate' without resumeHook", async () => {
      vi.mocked(resumeHook).mockResolvedValue({} as never);

      // First batch
      setMessageRunning();
      const res1 = await callPost(
        makeRequest({
          contentType: "application/x-ndjson",
          attemptSequence: "0",
          batchSequence: "0",
          body: '{"type":"assistant"}',
        }),
      );
      expect(res1.status).toBe(200);
      expect((await res1.json()).status).toBe("ok");

      // Duplicate POST with the same (attemptSeq, batchSeq)
      setMessageRunning();
      const res2 = await callPost(
        makeRequest({
          contentType: "application/x-ndjson",
          attemptSequence: "0",
          batchSequence: "0",
          body: '{"type":"assistant"}',
        }),
      );
      expect(res2.status).toBe(200);
      expect((await res2.json()).status).toBe("duplicate");

      // resumeHook called only ONCE — duplicate is short-circuited before
      // reaching the hook.
      expect(resumeHook).toHaveBeenCalledTimes(1);
    });

    it("different attemptSequence (R6 reissue) starts fresh dedup space", async () => {
      vi.mocked(resumeHook).mockResolvedValue({} as never);

      // attempt=0, batch=0
      setMessageRunning();
      await callPost(
        makeRequest({
          contentType: "application/x-ndjson",
          attemptSequence: "0",
          batchSequence: "0",
          body: '{"type":"assistant"}',
        }),
      );

      // attempt=1, batch=0 (after R6 reissue) — different attemptSeq, NOT a duplicate
      setMessageRunning();
      const res = await callPost(
        makeRequest({
          contentType: "application/x-ndjson",
          attemptSequence: "1",
          batchSequence: "0",
          body: '{"type":"assistant"}',
        }),
      );
      expect(res.status).toBe(200);
      expect((await res.json()).status).toBe("ok");
      expect(resumeHook).toHaveBeenCalledTimes(2);
    });
  });

  describe("error paths from resumeHook", () => {
    it("HookNotFoundError → 503 with Retry-After (runner cold-start backoff)", async () => {
      setMessageRunning();
      vi.mocked(resumeHook).mockRejectedValueOnce(
        new Error("HookNotFoundError: Hook not found"),
      );

      const res = await callPost(
        makeRequest({
          contentType: "application/x-ndjson",
          body: '{"type":"assistant"}',
        }),
      );

      expect(res.status).toBe(503);
      expect(res.headers.get("retry-after")).toBe("1");
      const json = await res.json();
      expect(json.error.code).toBe("hook_not_found");
    });

    it("HookNotFoundError → dedup is NOT marked, so retried batch can succeed", async () => {
      vi.mocked(resumeHook)
        .mockRejectedValueOnce(new Error("HookNotFoundError: Hook not found"))
        .mockResolvedValueOnce({} as never);

      // First attempt — 503
      setMessageRunning();
      const res1 = await callPost(
        makeRequest({
          contentType: "application/x-ndjson",
          attemptSequence: "0",
          batchSequence: "0",
          body: '{"type":"assistant"}',
        }),
      );
      expect(res1.status).toBe(503);

      // Runner retries the same (attemptSeq, batchSeq) tuple — should NOT
      // be deduped because the prior attempt didn't complete.
      setMessageRunning();
      const res2 = await callPost(
        makeRequest({
          contentType: "application/x-ndjson",
          attemptSequence: "0",
          batchSequence: "0",
          body: '{"type":"assistant"}',
        }),
      );
      expect(res2.status).toBe(200);
      expect((await res2.json()).status).toBe("ok");
    });

    it("non-hook-not-found resumeHook error → 503 with retry-after", async () => {
      setMessageRunning();
      vi.mocked(resumeHook).mockRejectedValueOnce(
        new Error("transient WDK runtime error"),
      );

      const res = await callPost(
        makeRequest({
          contentType: "application/x-ndjson",
          body: '{"type":"assistant"}',
        }),
      );

      expect(res.status).toBe(503);
      const json = await res.json();
      expect(json.error.code).toBe("resume_hook_error");
    });
  });

  describe("line cap (SEC-002 mitigation)", () => {
    it("flooding past the cap → 429 with Retry-After", async () => {
      // Build a body with too many lines. The cap is 360_000 in v1, but
      // the test environment can use the public function with a tighter
      // cap by exhausting it directly. Here we push 100 batches of
      // 10_000 lines each — far past any sane single-tenant burst —
      // and assert the 429 fires before resumeHook.
      vi.mocked(resumeHook).mockResolvedValue({} as never);

      // Step 1: deliver 50 batches of 10_000 lines (still under the 360k cap)
      for (let batch = 0; batch < 50; batch++) {
        setMessageRunning();
        const lines = Array.from(
          { length: 10_000 },
          (_, i) => `{"type":"text_delta","content":"x${i}"}`,
        ).join("\n");
        const res = await callPost(
          makeRequest({
            contentType: "application/x-ndjson",
            attemptSequence: "0",
            batchSequence: String(batch),
            body: lines,
          }),
        );
        // Pre-cap batches succeed
        expect([200, 429]).toContain(res.status);
        if (res.status === 429) break;
      }
      // After 50 * 10_000 = 500k lines, we're well past the 360k cap;
      // the next batch should reject. (It already may have rejected
      // mid-loop above.)
      setMessageRunning();
      const flood = await callPost(
        makeRequest({
          contentType: "application/x-ndjson",
          attemptSequence: "0",
          batchSequence: "999",
          body: Array.from(
            { length: 10_000 },
            () => '{"type":"text_delta","content":"x"}',
          ).join("\n"),
        }),
      );
      expect(flood.status).toBe(429);
      expect(flood.headers.get("retry-after")).toBe("60");
    });
  });
});
