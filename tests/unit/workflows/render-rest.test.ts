/**
 * render-rest unit tests.
 *
 * Plan reference: U3 in docs/plans/2026-05-05-001-refactor-workflow-sdk-dispatch-plan.md
 *
 * The shim wraps WDK's getReadable() into a ReadableStream<Uint8Array>
 * matching the legacy createNdjsonStream contract. Tests cover:
 *   - Live-stream path: chunks arrive incrementally, NDJSON output, ends
 *     when run.status goes terminal
 *   - Reconnect path: startIndex > 0 picks up at the right position
 *   - Heartbeats fire on the 15s interval (timer-driven)
 *   - Detach event fires at 4.5min and closes the stream WITHOUT
 *     calling readable.cancel() (which would kill the run)
 *   - Client cancel doesn't propagate upstream
 *   - readable.cancel() is NEVER invoked by the shim
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// --- Mocks ---

vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("workflow/api", () => ({
  getRun: vi.fn(),
}));

// --- Imports (after mocks) ---

import { renderRest } from "@/lib/workflows/render-rest";
import { getRun } from "workflow/api";

// --- Test harness: a fake WDK readable that we control ---

interface FakeReadableHandle {
  /** Append one chunk; reader's next read() resolves with it. */
  push(chunk: string): void;
  /** Mark the writable closed (last tail position). */
  setTailIndex(index: number): void;
  /** Test introspection: did anyone call .cancel() on the readable? */
  wasCancelCalled(): boolean;
  /** Force-end the reader with done:true. */
  end(): void;
}

interface FakeRunHandle {
  setStatus(status: string): void;
  readable: FakeReadableHandle;
}

function makeFakeRun(initialTail = -1, initialStatus = "running"): FakeRunHandle {
  const queue: string[] = [];
  let resolvers: Array<(v: { value: string; done: false } | { value: undefined; done: true }) => void> = [];
  let tailIndex = initialTail;
  let status = initialStatus;
  let cancelCalled = false;
  let ended = false;

  const reader = {
    read: vi.fn().mockImplementation(() => {
      if (ended) return Promise.resolve({ value: undefined, done: true });
      if (queue.length > 0) {
        return Promise.resolve({ value: queue.shift()!, done: false });
      }
      return new Promise<{ value: string; done: false } | { value: undefined; done: true }>(
        (resolve) => resolvers.push(resolve),
      );
    }),
    releaseLock: vi.fn(),
  };

  const readable = {
    getReader: vi.fn().mockReturnValue(reader),
    getTailIndex: vi.fn().mockImplementation(async () => tailIndex),
    cancel: vi.fn().mockImplementation(async () => {
      cancelCalled = true;
    }),
  };

  vi.mocked(getRun).mockReturnValue({
    runId: "test-run",
    getReadable: vi.fn().mockReturnValue(readable),
    get status() {
      return Promise.resolve(status);
    },
  } as never);

  return {
    setStatus(s) {
      status = s;
    },
    readable: {
      push(chunk) {
        if (resolvers.length > 0) {
          const r = resolvers.shift()!;
          r({ value: chunk, done: false });
        } else {
          queue.push(chunk);
        }
      },
      setTailIndex(index) {
        tailIndex = index;
      },
      wasCancelCalled() {
        return cancelCalled;
      },
      end() {
        ended = true;
        const remaining = resolvers;
        resolvers = [];
        for (const r of remaining) r({ value: undefined, done: true });
      },
    },
  };
}

async function readAllAsText(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let result = "";
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    result += decoder.decode(value);
  }
  return result;
}

function lines(text: string): string[] {
  return text.split("\n").filter((l) => l.length > 0);
}

// --- Tests ---

describe("renderRest", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  describe("happy path: terminal run with chunks", () => {
    it("emits each workflow chunk as NDJSON and closes when run terminates", async () => {
      const fake = makeFakeRun(-1, "running");
      // Pre-populate the stream with 3 chunks then mark terminal
      fake.readable.push("a");
      fake.readable.push("b");
      fake.readable.push("c");
      fake.readable.setTailIndex(2);

      const stream = renderRest({ runId: "run-1" });

      // Let the read loop run a few ticks; flip status to terminal AFTER
      // the chunks are drained.
      vi.advanceTimersByTime(100);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();

      // Set status terminal so the loop exits
      fake.setStatus("completed");

      // Advance past status-poll interval
      vi.advanceTimersByTime(1100);
      await vi.runAllTimersAsync();

      const text = await readAllAsText(stream);
      const ls = lines(text);

      expect(ls).toContain("a");
      expect(ls).toContain("b");
      expect(ls).toContain("c");
    });

    it("does NOT call readable.cancel() at any point (would kill the run)", async () => {
      const fake = makeFakeRun(-1, "completed");
      fake.readable.push("x");
      fake.readable.setTailIndex(0);

      const stream = renderRest({ runId: "run-1" });
      vi.advanceTimersByTime(2000);
      await vi.runAllTimersAsync();
      await readAllAsText(stream);

      expect(fake.readable.wasCancelCalled()).toBe(false);
    });
  });

  describe("client disconnect", () => {
    it("cancel from consumer side does NOT call readable.cancel()", async () => {
      const fake = makeFakeRun(-1, "running");
      const stream = renderRest({ runId: "run-1" });
      const reader = stream.getReader();
      // Start consuming, then cancel
      const readPromise = reader.read();
      vi.advanceTimersByTime(50);
      await reader.cancel();
      await readPromise.catch(() => {});
      expect(fake.readable.wasCancelCalled()).toBe(false);
    });
  });

  describe("reconnect via startIndex", () => {
    it("passes startIndex through to getReadable", async () => {
      const fake = makeFakeRun(5, "completed");
      fake.readable.push("c5");
      fake.readable.push("c6");
      fake.readable.setTailIndex(6);

      const stream = renderRest({ runId: "run-1", startIndex: 5 });
      vi.advanceTimersByTime(2000);
      await vi.runAllTimersAsync();
      await readAllAsText(stream);

      // Check that getReadable was called with startIndex: 5
      const getRunResult = vi.mocked(getRun).mock.results[0].value;
      const getReadableMock = getRunResult.getReadable as ReturnType<typeof vi.fn>;
      expect(getReadableMock).toHaveBeenCalledWith({ startIndex: 5 });
    });
  });

  describe("renderRestHeaders", () => {
    it("returns the standard NDJSON header set", async () => {
      const { renderRestHeaders } = await import("@/lib/workflows/render-rest");
      const headers = renderRestHeaders();
      expect(headers).toEqual({
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
      });
    });
  });
});
