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
import type { TenantId, AgentId } from "@/lib/types";
import type { TxClient } from "@/db";

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

import {
  __testing,
  StaleClaimError,
  classifyDispatchFailure,
} from "@/lib/workflows/chat-dispatch-workflow";
import {
  ConcurrencyLimitError,
  BudgetExceededError,
} from "@/lib/errors";

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

// Round-5 review #9: consolidated test mock pattern. All tests now use
// the probe-based mockImplementation that invokes the production
// callback (rather than mockResolvedValue which bypasses it). This
// keeps test semantics consistent with what production does.
type DedupeRowShape = { session_id: string | null; message_id: string | null; inner_run_id: string | null };
const EMPTY_DEDUPE_ROW: DedupeRowShape = { session_id: null, message_id: null, inner_run_id: null };

function mockTxQueueWithProbe(responses: DedupeRowShape[]): void {
  let idx = 0;
  withTenantTransactionMock.mockImplementation(async (_tenantId: string, cb: (tx: TxClient) => Promise<unknown>) => {
    let observed = false;
    const probeTx: TxClient = {
      queryOne: async () => {
        observed = true;
        const r = responses[idx] ?? EMPTY_DEDUPE_ROW;
        idx += 1;
        return r as never;
      },
      execute: async () => {
        observed = true;
        return { rowCount: 0 };
      },
      query: async () => [],
    };
    const result = await cb(probeTx);
    if (!observed) throw new Error("test mock: callback didn't invoke tx");
    return result;
  });
}

describe("pollForDedupeFill", () => {
  it("returns the row immediately when inner_run_id is already filled", async () => {
    const filled = { session_id: "session-1", message_id: "msg-1", inner_run_id: "run-1" };
    mockTxQueueWithProbe([filled]);

    const result = await __testing.pollForDedupeFill(tenantId, "discord", "evt-1");

    expect(result).toEqual(filled);
    expect(withTenantTransactionMock).toHaveBeenCalledOnce();
  });

  it("returns null when the placeholder is never filled (timeout)", async () => {
    mockTxQueueWithProbe([]); // every call falls through to empty default

    const promise = __testing.pollForDedupeFill(tenantId, "discord", "evt-2");
    for (let elapsed = 0; elapsed < __testing.POLL_MAX_DURATION_MS + 1000; elapsed += __testing.POLL_INTERVAL_CAP_MS) {
      await vi.advanceTimersByTimeAsync(__testing.POLL_INTERVAL_CAP_MS);
    }
    const result = await promise;
    expect(result).toBeNull();
  });

  it("ignores partially-filled rows (inner_run_id still null) and keeps polling", async () => {
    const partial = { session_id: "s1", message_id: "m1", inner_run_id: null };
    const filled = { session_id: "s1", message_id: "m1", inner_run_id: "run-1" };
    mockTxQueueWithProbe([partial, partial, filled]);

    const promise = __testing.pollForDedupeFill(tenantId, "discord", "evt-3");
    // First backoff is POLL_INTERVAL_MS (100ms); second is doubled (200ms).
    await vi.advanceTimersByTimeAsync(__testing.POLL_INTERVAL_MS);
    await vi.advanceTimersByTimeAsync(__testing.POLL_INTERVAL_MS * 2);
    const result = await promise;
    expect(result).toEqual(filled);
    expect(withTenantTransactionMock).toHaveBeenCalledTimes(3);
  });

  it("uses exponential backoff: ~11 DB round-trips over the 30s budget, not 300", async () => {
    mockTxQueueWithProbe([]);

    const promise = __testing.pollForDedupeFill(tenantId, "discord", "evt-backoff");
    for (let elapsed = 0; elapsed < __testing.POLL_MAX_DURATION_MS + 1000; elapsed += __testing.POLL_INTERVAL_CAP_MS) {
      await vi.advanceTimersByTimeAsync(__testing.POLL_INTERVAL_CAP_MS);
    }
    await promise;
    expect(withTenantTransactionMock.mock.calls.length).toBeLessThan(30);
    expect(withTenantTransactionMock.mock.calls.length).toBeGreaterThan(5);
  });
});

describe("recoverLostClaim", () => {
  // recoverLostClaim is the round-3-fix recovery branch: poll → steal → re-poll → throw.
  // It uses withTenantTransaction for both the poll SELECT and the steal UPDATE.
  // Tests drive both via withTenantTransactionMock — order matters:
  //   poll calls return DedupeRow shape ({ session_id, message_id, inner_run_id })
  //   steal calls return { rowCount } from tx.execute

  const triggerInput = {
    tenantId,
    agentId: "00000000-0000-0000-0000-000000000099" as AgentId,
    platform: "discord" as const,
    threadKey: "discord:g:c:t",
    channelId: "C123",
    prompt: "hi",
    authorId: "U1",
    authorDisplayName: "alice",
    eventId: "evt-1",
  };

  it("returns 'attached' when the initial poll observes a filled row", async () => {
    const filled = { session_id: "s1", message_id: "m1", inner_run_id: "run-1" };
    withTenantTransactionMock.mockResolvedValueOnce(filled);

    const result = await __testing.recoverLostClaim(triggerInput);

    expect(result).toEqual({ kind: "attached", innerRunId: "run-1" });
    // Only one tx for the poll; steal should not run.
    expect(withTenantTransactionMock).toHaveBeenCalledOnce();
  });

  // Helper: drain enough fake-timer budget for ONE pollForDedupeFill cycle
  // to exhaust. Each iteration fires whatever setTimeout the poll loop
  // just installed.
  async function drainPollBudget(): Promise<void> {
    for (let elapsed = 0; elapsed < __testing.POLL_MAX_DURATION_MS + 1000; elapsed += __testing.POLL_INTERVAL_CAP_MS) {
      await vi.advanceTimersByTimeAsync(__testing.POLL_INTERVAL_CAP_MS);
    }
  }

  // Reset the mock between tests so mockResolvedValueOnce queues don't
  // leak. (vi.clearAllMocks clears history but not pending implementations.)
  beforeEach(() => {
    withTenantTransactionMock.mockReset();
  });

  // Mock that distinguishes poll calls (return DedupeRow shape) from
  // steal/UPDATE calls (return rowCount shape). Detection is by the SQL
  // text of the callback's first execute/queryOne — we wrap the production
  // tx with a probe.
  function mockTxByCallType(opts: {
    pollResponses: Array<{ session_id: string | null; message_id: string | null; inner_run_id: string | null }>;
    stealResponse: { rowCount: number };
    rePollResponses?: Array<{ session_id: string | null; message_id: string | null; inner_run_id: string | null }>;
  }) {
    const empty = { session_id: null, message_id: null, inner_run_id: null };
    let pollIdx = 0;
    let stealCalled = false;
    let rePollIdx = 0;
    withTenantTransactionMock.mockImplementation(async (_tenantId: string, cb: (tx: TxClient) => Promise<unknown>) => {
      // Probe the callback by passing a tx that records the SQL it sees
      // and returns the appropriate canned response. Round-5 review #12:
      // recoverLostClaim's steal now uses queryOne(UPDATE ... RETURNING)
      // instead of execute(). Distinguish poll calls (SELECT) from
      // steal calls (UPDATE) by SQL substring.
      let observedSql = "";
      const probeTx: TxClient = {
        queryOne: async (_schema, sql) => {
          observedSql = sql;
          if (sql.toUpperCase().includes("UPDATE")) {
            // This is the atomic-steal UPDATE … RETURNING.
            stealCalled = true;
            return {
              steal_attempts: 1,
              stole: opts.stealResponse.rowCount === 1,
            } as never;
          }
          // SELECT — pollForDedupeFill or its re-poll.
          if (!stealCalled) {
            const r = opts.pollResponses[pollIdx] ?? empty;
            pollIdx += 1;
            return r as never;
          }
          const r = opts.rePollResponses?.[rePollIdx] ?? empty;
          rePollIdx += 1;
          return r as never;
        },
        execute: async (sql) => {
          observedSql = sql;
          return { rowCount: 0 };
        },
        query: async () => [],
      };
      const result = await cb(probeTx);
      // Sanity: every callback must have actually executed something.
      if (!observedSql) throw new Error("test mock: callback didn't invoke tx");
      return result;
    });
  }

  it("returns 'promoted' when poll times out and steal UPDATEs one row", async () => {
    mockTxByCallType({
      pollResponses: [], // every call falls through to empty default
      stealResponse: { rowCount: 1 }, // steal succeeds
    });

    const promise = __testing.recoverLostClaim(triggerInput);
    await drainPollBudget();
    const result = await promise;

    expect(result).toEqual({ kind: "promoted" });
  });

  it("returns 'attached' when steal lost the race but the row filled in the steal window", async () => {
    const filled = { session_id: "s2", message_id: "m2", inner_run_id: "run-2" };
    mockTxByCallType({
      pollResponses: [],
      stealResponse: { rowCount: 0 }, // someone else stole it
      rePollResponses: [filled], // re-poll observes the filled row
    });

    const promise = __testing.recoverLostClaim(triggerInput);
    await drainPollBudget();
    const result = await promise;

    expect(result).toEqual({ kind: "attached", innerRunId: "run-2" });
  });

  it("throws when both poll and steal fail (caller hands off to WDK retry)", async () => {
    mockTxByCallType({
      pollResponses: [],
      stealResponse: { rowCount: 0 },
      rePollResponses: [], // re-poll never observes a fill either
    });

    const promise = __testing.recoverLostClaim(triggerInput);
    // Catch eagerly so vitest doesn't flag the rejection as unhandled
    // while we drain the second poll budget.
    const settled = promise.catch((err) => err);
    await drainPollBudget(); // initial poll exhausts → steal fires
    await drainPollBudget(); // re-poll exhausts → throw
    const err = await settled;
    expect(err).toBeInstanceOf(StaleClaimError);
    expect((err as Error).message).toMatch(/claim race lost and steal failed/);
  });

  it("returns 'abandoned' once steal_attempts crosses MAX_STEAL_ATTEMPTS", async () => {
    // Round-6 review #B fix: the abandonment branch now returns
    // `{ kind: "abandoned", attempts }` instead of throwing. This
    // test exercises that branch via a custom mock that reports
    // steal_attempts: 6 (above the threshold of 5).
    const empty = { session_id: null, message_id: null, inner_run_id: null };
    withTenantTransactionMock.mockImplementation(async (_tenantId: string, cb: (tx: TxClient) => Promise<unknown>) => {
      let observed = false;
      const probeTx: TxClient = {
        queryOne: async (_schema, sql) => {
          observed = true;
          if (sql.toUpperCase().includes("UPDATE")) {
            return { steal_attempts: 6, stole: false } as never;
          }
          return empty as never;
        },
        execute: async () => {
          observed = true;
          return { rowCount: 0 };
        },
        query: async () => [],
      };
      const result = await cb(probeTx);
      if (!observed) throw new Error("test mock: callback didn't invoke tx");
      return result;
    });

    const promise = __testing.recoverLostClaim(triggerInput);
    await drainPollBudget(); // initial poll exhausts → steal returns rowCount=0 + attempts=6
    await drainPollBudget(); // re-poll exhausts → returns abandoned (no throw)
    const result = await promise;
    expect(result).toEqual({ kind: "abandoned", attempts: 6 });
  });
});

describe("classifyDispatchFailure", () => {
  it("returns 'in_flight' for ConcurrencyLimitError with the in-flight message", () => {
    const err = new ConcurrencyLimitError(
      "ContextId session has an in-flight message",
    );
    expect(classifyDispatchFailure(err)).toBe("in_flight");
  });

  it("returns 'in_flight' for ConcurrencyLimitError with the default message (no message-string match)", () => {
    expect(classifyDispatchFailure(new ConcurrencyLimitError())).toBe(
      "in_flight",
    );
  });

  it("returns 'other' for a plain Error", () => {
    expect(classifyDispatchFailure(new Error("anything else"))).toBe("other");
  });

  it("returns 'other' for adjacent AppError subclasses (e.g. BudgetExceededError)", () => {
    expect(classifyDispatchFailure(new BudgetExceededError())).toBe("other");
  });

  it("returns 'other' for non-Error inputs from the unknown catch type", () => {
    expect(classifyDispatchFailure(undefined)).toBe("other");
    expect(classifyDispatchFailure(null)).toBe("other");
    expect(classifyDispatchFailure("a string")).toBe("other");
    expect(classifyDispatchFailure(42)).toBe("other");
    expect(classifyDispatchFailure({ message: "duck-typed" })).toBe("other");
  });
});

// ---------------------------------------------------------------------------
// Bounded-consume state machine — PR #85 + post-review fixes.
// ---------------------------------------------------------------------------

describe("initialChatConsumeState", () => {
  it("returns a fully-zeroed/empty seed state with all fields present", () => {
    const s = __testing.initialChatConsumeState();

    // Common.
    expect(s.responseText).toBe("");
    expect(s.committedLength).toBe(0);
    expect(s.perTurnDeltaText).toBe("");
    expect(s.toolTitles).toEqual({});
    expect(s.openToolIds).toEqual([]);
    expect(s.emittedAnyText).toBe(false);
    expect(s.resultFallbackText).toBeNull();
    expect(s.sawAgentError).toBeNull();

    // Discord-only.
    expect(s.messageId).toBeNull();
    expect(s.hasPosted).toBe(false);
    expect(s.postFailed).toBe(false);
    expect(s.chunksSinceFlush).toBe(0);
    expect(s.backoffChunks).toBe(0);
    expect(s.resultEventCount).toBe(0);
  });

  it("returns a fresh object each call (no shared references)", () => {
    const a = __testing.initialChatConsumeState();
    const b = __testing.initialChatConsumeState();
    expect(a).not.toBe(b);
    expect(a.toolTitles).not.toBe(b.toolTitles);
    expect(a.openToolIds).not.toBe(b.openToolIds);
  });
});

describe("ChatConsumeState JSON round-trip", () => {
  it("preserves all fields verbatim through JSON.parse(JSON.stringify(...))", () => {
    const original = {
      ...__testing.initialChatConsumeState(),
      responseText: "Hello world",
      committedLength: 5,
      perTurnDeltaText: "world",
      toolTitles: { tool_a: "search_docs", tool_b: "FIRECRAWL_SEARCH" },
      openToolIds: ["tool_b"],
      emittedAnyText: true,
      resultFallbackText: "final answer",
      sawAgentError: "rate_limit_exhausted",
      messageId: "1234567890.123",
      hasPosted: true,
      postFailed: false,
      chunksSinceFlush: 3,
      backoffChunks: 0,
      resultEventCount: 1,
    };
    const roundTrip = JSON.parse(JSON.stringify(original));
    expect(roundTrip).toEqual(original);
  });

  it("toolTitles and openToolIds round-trip through Map/Set hydration semantics", () => {
    // The bounded-consume functions hydrate state.toolTitles into a Map
    // and state.openToolIds into a Set, mutate, then serialize back via
    // Object.fromEntries(map) / [...set]. Verify those round-trips.
    const titles: Record<string, string> = { id1: "foo", id2: "bar" };
    const titlesMap = new Map(Object.entries(titles));
    titlesMap.set("id3", "baz");
    titlesMap.delete("id1");
    const titlesBack = Object.fromEntries(titlesMap);
    expect(titlesBack).toEqual({ id2: "bar", id3: "baz" });

    const ids = ["id1", "id2"];
    const idsSet = new Set(ids);
    idsSet.add("id3");
    idsSet.delete("id1");
    const idsBack = [...idsSet];
    expect(idsBack.sort()).toEqual(["id2", "id3"]);
  });
});

describe("consume-step budget constants", () => {
  it("deadline is at least 10s above the quiet timeout (headroom)", () => {
    // The quiet-timeout fires when reads stall; the body re-invokes
    // immediately. The wall-clock deadline is the upper bound on a
    // single iteration. Pinning this invariant catches the round-5
    // STALE_CLAIM-style boundary defect — three independent constants
    // (deadline / quiet / 120s function cap) need a documented relation.
    expect(__testing.CONSUME_STEP_DEADLINE_MS).toBeGreaterThanOrEqual(
      __testing.CONSUME_STEP_QUIET_MS + 10_000,
    );
  });

  it("deadline is comfortably under the empirical 120s function cap", () => {
    // Pre-fix the function host killed steps at ~120s. With the
    // workflow-body loop, each iteration only needs to fit under that
    // cap — but 60s default leaves headroom for fix-iteration overhead
    // and post-stream guards (final flush, markBotEvent, reactions).
    expect(__testing.CONSUME_STEP_DEADLINE_MS).toBeLessThanOrEqual(100_000);
  });

  it("quiet timeout is well above typical Claude Opus thinking pauses", () => {
    // Code-review #6: 12s was below typical Opus thinking pauses
    // (30–40s), forcing a Slack rollover seam on every short pause.
    // 45s tolerates pauses at the high end of typical observed
    // behavior without bouncing iterations.
    expect(__testing.CONSUME_STEP_QUIET_MS).toBeGreaterThanOrEqual(40_000);
  });
});
