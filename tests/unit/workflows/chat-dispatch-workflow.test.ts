/**
 * Tests for src/lib/workflows/chat-dispatch-workflow.ts internals.
 *
 * Coverage:
 *   - parseNdjsonLine: trimming, empty, malformed JSON, valid event
 *   - pollForDedupeFill: returns row when inner_run_id fills; returns null on timeout
 *
 * Body-level integration (chunk gate, rollover, error path, postFailed) is
 * exercised by the dispatch flow E2E and by limits.ts unit coverage; the
 * body has a giant mock surface (WDK getRun/getReadable + several "use
 * step" calls) where unit testing tends to assert mock plumbing rather
 * than real behavior.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantId } from "@/lib/types";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const withTenantTransactionMock = vi.hoisted(() => vi.fn());
vi.mock("@/db", () => ({
  withTenantTransaction: withTenantTransactionMock,
  query: vi.fn(),
}));

// Mock the workflow runtime so importing the module doesn't drag the
// real WDK into the test.
vi.mock("workflow/api", () => ({
  start: vi.fn(),
  getRun: vi.fn(),
}));
vi.mock("@/lib/dispatcher", () => ({
  reserveSessionAndMessage: vi.fn(),
}));
vi.mock("@/lib/workflows/dispatch-workflow", () => ({
  dispatchWorkflow: vi.fn(),
}));
vi.mock("@/lib/platform/redis-bucket", () => ({
  tryConsumeChannelToken: vi.fn().mockResolvedValue(true),
  drainChannelToken: vi.fn(),
}));
vi.mock("@/lib/platform/format", () => ({
  formatForPlatform: vi.fn(),
}));
vi.mock("@/lib/platform/bot", () => ({
  getOrCreateBot: vi.fn(),
}));
vi.mock("@/lib/platform/operations", () => ({
  getDecryptedCredentials: vi.fn(),
  markBotError: vi.fn(),
}));
vi.mock("@/lib/platform/attachments", () => ({
  persistAttachmentToBlob: vi.fn(),
  signedReadUrl: vi.fn(),
}));
vi.mock("@/lib/mcp-connections", () => ({
  getCallbackBaseUrl: vi.fn(() => "http://test.local"),
}));

import { __testing } from "@/lib/workflows/chat-dispatch-workflow";

const tenantId = "00000000-0000-0000-0000-000000000001" as TenantId;

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe("parseNdjsonLine", () => {
  it("returns null for empty / whitespace input", () => {
    expect(__testing.parseNdjsonLine("")).toBeNull();
    expect(__testing.parseNdjsonLine("   ")).toBeNull();
    expect(__testing.parseNdjsonLine("\n")).toBeNull();
  });

  it("returns null for malformed JSON", () => {
    expect(__testing.parseNdjsonLine("not json")).toBeNull();
    expect(__testing.parseNdjsonLine("{unterminated")).toBeNull();
  });

  it("parses a valid text_delta event", () => {
    const raw = JSON.stringify({ type: "text_delta", text: "hello" });
    const evt = __testing.parseNdjsonLine(raw);
    expect(evt).toEqual({ type: "text_delta", text: "hello" });
  });

  it("parses a valid error event", () => {
    const raw = JSON.stringify({ type: "error", message: "boom" });
    const evt = __testing.parseNdjsonLine(raw);
    expect(evt).toEqual({ type: "error", message: "boom" });
  });

  it("strips a trailing newline before parsing", () => {
    const raw = JSON.stringify({ type: "result" }) + "\n";
    expect(__testing.parseNdjsonLine(raw)).toEqual({ type: "result" });
  });
});

describe("pollForDedupeFill", () => {
  it("returns the row immediately when inner_run_id is already filled", async () => {
    const filled = {
      session_id: "session-1",
      message_id: "msg-1",
      inner_run_id: "run-1",
    };
    withTenantTransactionMock.mockResolvedValueOnce(filled);

    const result = await __testing.pollForDedupeFill(tenantId, "discord", "evt-1");

    expect(result).toEqual(filled);
    expect(withTenantTransactionMock).toHaveBeenCalledOnce();
  });

  it("returns null when the placeholder is never filled (timeout)", async () => {
    // Always return an unfilled placeholder row.
    withTenantTransactionMock.mockResolvedValue({
      session_id: null,
      message_id: null,
      inner_run_id: null,
    });

    const promise = __testing.pollForDedupeFill(tenantId, "discord", "evt-2");
    // Round-3: pollForDedupeFill now uses exponential backoff (capped at
    // POLL_INTERVAL_CAP_MS). Advance the timer in cap-sized chunks past
    // the total budget; each chunk fires whatever inner setTimeout is
    // currently scheduled.
    for (let elapsed = 0; elapsed < __testing.POLL_MAX_DURATION_MS + 1000; elapsed += __testing.POLL_INTERVAL_CAP_MS) {
      await vi.advanceTimersByTimeAsync(__testing.POLL_INTERVAL_CAP_MS);
    }
    const result = await promise;
    expect(result).toBeNull();
  });

  it("ignores partially-filled rows (inner_run_id still null) and keeps polling", async () => {
    const partial = { session_id: "s1", message_id: "m1", inner_run_id: null };
    const filled = { session_id: "s1", message_id: "m1", inner_run_id: "run-1" };
    withTenantTransactionMock
      .mockResolvedValueOnce(partial)
      .mockResolvedValueOnce(partial)
      .mockResolvedValueOnce(filled);

    const promise = __testing.pollForDedupeFill(tenantId, "discord", "evt-3");
    // First backoff is POLL_INTERVAL_MS (100ms); second is doubled (200ms).
    await vi.advanceTimersByTimeAsync(__testing.POLL_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(__testing.POLL_INTERVAL_MS * 2);
    const result = await promise;
    expect(result).toEqual(filled);
    expect(withTenantTransactionMock).toHaveBeenCalledTimes(3);
  });

  it("uses exponential backoff: ~11 DB round-trips over the 30s budget, not 300", async () => {
    // Round-3 review #8 fix verification. Always return unfilled.
    withTenantTransactionMock.mockResolvedValue({
      session_id: null,
      message_id: null,
      inner_run_id: null,
    });

    const promise = __testing.pollForDedupeFill(tenantId, "discord", "evt-backoff");
    for (let elapsed = 0; elapsed < __testing.POLL_MAX_DURATION_MS + 1000; elapsed += __testing.POLL_INTERVAL_CAP_MS) {
      await vi.advanceTimersByTimeAsync(__testing.POLL_INTERVAL_CAP_MS);
    }
    await promise;
    // Sanity: substantially fewer than the 300 the fixed-100ms scheme
    // would have produced. Allow generous slack to avoid flakiness on
    // exact backoff arithmetic.
    expect(withTenantTransactionMock.mock.calls.length).toBeLessThan(30);
    expect(withTenantTransactionMock.mock.calls.length).toBeGreaterThan(5);
  });
});
