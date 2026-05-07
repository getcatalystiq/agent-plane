/**
 * stream-bridge-server unit tests.
 *
 * Plan reference: U3 in docs/plans/2026-05-05-001-refactor-workflow-sdk-dispatch-plan.md
 *
 * Covers the helpers used by the refactored internal transcript endpoint:
 *   - checkBatchDedup / markBatchSeen — (messageId, attemptSeq, batchSeq) dedup
 *   - reserveLines — per-message line cap with lazy initialization
 *   - resumeHookBatch — calls resumeHook(token, payload) per chunk; surfaces
 *     HookNotFoundError separately from other failures so the route can
 *     return retryable 5xx
 *   - parseRunnerLine — NDJSON → RunnerChunkPayload classification
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("workflow/api", () => ({
  resumeHook: vi.fn(),
}));

import {
  checkBatchDedup,
  markBatchSeen,
  reserveLines,
  resumeHookBatch,
  parseRunnerLine,
  __resetDedupForTests,
  __resetLineCountersForTests,
  type RunnerChunkPayload,
} from "@/lib/workflows/stream-bridge-server";
import { resumeHook } from "workflow/api";

// --- Tests ---

describe("checkBatchDedup + markBatchSeen", () => {
  beforeEach(() => __resetDedupForTests());

  it("returns 'first' on never-seen tuple", () => {
    expect(checkBatchDedup("msg-1", 0, 0)).toBe("first");
  });

  it("returns 'duplicate' after markBatchSeen", () => {
    markBatchSeen("msg-1", 0, 0);
    expect(checkBatchDedup("msg-1", 0, 0)).toBe("duplicate");
  });

  it("different (attemptSeq, batchSeq) tuples don't collide", () => {
    markBatchSeen("msg-1", 0, 0);
    expect(checkBatchDedup("msg-1", 0, 1)).toBe("first");
    expect(checkBatchDedup("msg-1", 1, 0)).toBe("first");
    expect(checkBatchDedup("msg-2", 0, 0)).toBe("first");
  });

  it("markBatchSeen is idempotent — subsequent calls don't fail", () => {
    markBatchSeen("msg-1", 0, 0);
    markBatchSeen("msg-1", 0, 0);
    expect(checkBatchDedup("msg-1", 0, 0)).toBe("duplicate");
  });
});

describe("reserveLines", () => {
  beforeEach(() => __resetLineCountersForTests());

  it("first call initializes counter at the default cap", () => {
    const result = reserveLines("msg-1", 5, 1000);
    expect(result.allowed).toBe(true);
    expect(result.cap).toBe(1000);
    expect(result.remaining).toBe(995);
  });

  it("subsequent calls deduct from remaining", () => {
    reserveLines("msg-1", 5, 1000);
    const r2 = reserveLines("msg-1", 10, 1000);
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(985);
  });

  it("cap exceeded → allowed=false and counter unchanged", () => {
    reserveLines("msg-1", 990, 1000);
    const result = reserveLines("msg-1", 20, 1000);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(10); // The 10 still available
    // Verify the cap-exceeded path didn't consume the lines
    const recheck = reserveLines("msg-1", 5, 1000);
    expect(recheck.allowed).toBe(true);
    expect(recheck.remaining).toBe(5);
  });

  it("different messageIds have independent counters", () => {
    reserveLines("msg-1", 999, 1000);
    const r2 = reserveLines("msg-2", 5, 1000);
    expect(r2.allowed).toBe(true);
    expect(r2.remaining).toBe(995);
  });

  it("default cap is per-message — first message's cap doesn't override later", () => {
    // First message uses cap=1000
    reserveLines("msg-1", 100, 1000);
    // Second message with a different cap — should use its own
    const r2 = reserveLines("msg-2", 100, 5000);
    expect(r2.allowed).toBe(true);
    expect(r2.cap).toBe(5000);
    expect(r2.remaining).toBe(4900);
  });
});

describe("resumeHookBatch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("delivers all chunks to resumeHook with the deterministic transcript token", async () => {
    vi.mocked(resumeHook).mockResolvedValue({} as never);
    const payloads: RunnerChunkPayload[] = [
      { kind: "chunk", line: '{"type":"assistant"}', eventType: "assistant" },
      { kind: "chunk", line: '{"type":"tool_use"}', eventType: "tool_use" },
      { kind: "terminal", line: '{"type":"result"}', eventType: "result" },
    ];

    const result = await resumeHookBatch("msg-1", payloads);

    expect(result).toEqual({ delivered: 3, hookNotFound: false, otherError: null });
    expect(resumeHook).toHaveBeenCalledTimes(3);
    expect(resumeHook).toHaveBeenNthCalledWith(1, "transcript:msg-1", payloads[0]);
    expect(resumeHook).toHaveBeenNthCalledWith(2, "transcript:msg-1", payloads[1]);
    expect(resumeHook).toHaveBeenNthCalledWith(3, "transcript:msg-1", payloads[2]);
  });

  it("HookNotFoundError → returns hookNotFound=true with delivered count of prior successes", async () => {
    vi.mocked(resumeHook)
      .mockResolvedValueOnce({} as never)
      .mockRejectedValueOnce(new Error("HookNotFoundError: Hook not found"));
    const payloads: RunnerChunkPayload[] = [
      { kind: "chunk", line: "a", eventType: "assistant" },
      { kind: "chunk", line: "b", eventType: "assistant" },
      { kind: "chunk", line: "c", eventType: "assistant" },
    ];

    const result = await resumeHookBatch("msg-1", payloads);

    expect(result.hookNotFound).toBe(true);
    expect(result.delivered).toBe(1);
    expect(result.otherError).toBeNull();
    // After the failure we stop iterating so the remaining payloads are
    // not delivered (the route returns 5xx; the runner retries the entire
    // batch).
    expect(resumeHook).toHaveBeenCalledTimes(2);
  });

  it("non-hook-not-found error → returns otherError with the message", async () => {
    vi.mocked(resumeHook)
      .mockResolvedValueOnce({} as never)
      .mockRejectedValueOnce(new Error("transient WDK error"));
    const payloads: RunnerChunkPayload[] = [
      { kind: "chunk", line: "a", eventType: "assistant" },
      { kind: "chunk", line: "b", eventType: "assistant" },
    ];

    const result = await resumeHookBatch("msg-1", payloads);

    expect(result.hookNotFound).toBe(false);
    expect(result.otherError).toContain("transient WDK error");
    expect(result.delivered).toBe(1);
  });

  it("empty batch → delivered=0 with no resumeHook calls", async () => {
    const result = await resumeHookBatch("msg-1", []);
    expect(result).toEqual({ delivered: 0, hookNotFound: false, otherError: null });
    expect(resumeHook).not.toHaveBeenCalled();
  });
});

describe("parseRunnerLine", () => {
  it("parses an assistant event as kind='chunk'", () => {
    const result = parseRunnerLine('{"type":"assistant","content":"hi"}');
    expect(result).toEqual({
      kind: "chunk",
      line: '{"type":"assistant","content":"hi"}',
      eventType: "assistant",
    });
  });

  it("parses a result event as kind='terminal'", () => {
    const result = parseRunnerLine('{"type":"result","status":"completed"}');
    expect(result).toEqual({
      kind: "terminal",
      line: '{"type":"result","status":"completed"}',
      eventType: "result",
    });
  });

  it("parses an error event as kind='terminal'", () => {
    const result = parseRunnerLine('{"type":"error","message":"boom"}');
    expect(result).toEqual({
      kind: "terminal",
      line: '{"type":"error","message":"boom"}',
      eventType: "error",
    });
  });

  it("text_delta is a chunk (not terminal)", () => {
    const result = parseRunnerLine('{"type":"text_delta","content":"x"}');
    expect(result?.kind).toBe("chunk");
    expect(result?.eventType).toBe("text_delta");
  });

  it("empty / whitespace-only line returns null", () => {
    expect(parseRunnerLine("")).toBeNull();
    expect(parseRunnerLine("   ")).toBeNull();
    expect(parseRunnerLine("\n")).toBeNull();
  });

  it("malformed JSON falls back to {kind:'chunk', eventType:'unknown'} (no throw)", () => {
    const result = parseRunnerLine("not valid json");
    expect(result).toEqual({
      kind: "chunk",
      line: "not valid json",
      eventType: "unknown",
    });
  });

  it("JSON without type field is classified eventType='unknown', kind='chunk'", () => {
    const result = parseRunnerLine('{"content":"hi"}');
    expect(result?.kind).toBe("chunk");
    expect(result?.eventType).toBe("unknown");
  });

  it("non-object JSON (string, number) → kind='chunk', eventType='unknown'", () => {
    expect(parseRunnerLine('"just a string"')?.eventType).toBe("unknown");
    expect(parseRunnerLine("42")?.eventType).toBe("unknown");
  });
});
