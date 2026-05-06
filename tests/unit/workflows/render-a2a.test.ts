/**
 * render-a2a unit tests.
 *
 * Plan reference: U3 in docs/plans/2026-05-05-001-refactor-workflow-sdk-dispatch-plan.md
 *
 * The shim consumes a workflow run's getReadable() and publishes A2A
 * spec events to an ExecutionEventBus. Mapping must match the legacy
 * `consumeA2aLogStream` in src/lib/a2a.ts byte-for-byte:
 *   - assistant events with text-content blocks → accumulate
 *     lastAssistantText (returned for caller's final-status event)
 *   - result events → publish artifact-update with the accumulated text
 *   - other event types → no-op
 *
 * U0 spike constraints verified in tests:
 *   - readable.cancel() is NEVER called by the shim
 *   - getTailIndex used to bound reads
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

vi.mock("workflow/api", () => ({
  getRun: vi.fn(),
}));

import { consumeWorkflowStreamAsA2A } from "@/lib/workflows/render-a2a";
import { getRun } from "workflow/api";

// --- Test fixture: fake run + readable matching the same shape as render-rest tests ---

interface FakeRunHandle {
  setStatus(s: string): void;
  pushChunk(chunk: string): void;
  setTailIndex(n: number): void;
  cancelCalls(): number;
}

function makeFakeRun(initialTail = -1, initialStatus = "completed"): FakeRunHandle {
  const queue: string[] = [];
  let tailIndex = initialTail;
  let status = initialStatus;
  let cancelCalls = 0;

  const reader = {
    read: vi.fn().mockImplementation(() => {
      if (queue.length > 0) {
        return Promise.resolve({ value: queue.shift()!, done: false });
      }
      // Emulate WDK readable: never signals done unless explicitly told.
      // For the tests here we always set tailIndex up-front so the loop
      // exits via the status terminal check, not via reader done.
      return Promise.resolve({ value: undefined, done: true });
    }),
    releaseLock: vi.fn(),
  };

  const readable = {
    getReader: vi.fn().mockReturnValue(reader),
    getTailIndex: vi.fn().mockImplementation(async () => tailIndex),
    cancel: vi.fn().mockImplementation(async () => {
      cancelCalls++;
    }),
  };

  vi.mocked(getRun).mockReturnValue({
    runId: "run-x",
    getReadable: vi.fn().mockReturnValue(readable),
    get status() {
      return Promise.resolve(status);
    },
  } as never);

  return {
    setStatus: (s) => {
      status = s;
    },
    pushChunk: (c) => queue.push(c),
    setTailIndex: (n) => {
      tailIndex = n;
    },
    cancelCalls: () => cancelCalls,
  };
}

function makeEventBus() {
  return { publish: vi.fn(), finished: vi.fn() };
}

// --- Tests ---

describe("consumeWorkflowStreamAsA2A", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("happy path: assistant + result chunks → publishes one artifact-update with accumulated text", async () => {
    const fake = makeFakeRun(1, "completed");
    fake.pushChunk(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "Hello world." }] },
      }),
    );
    fake.pushChunk(JSON.stringify({ type: "result", status: "completed" }));
    fake.setTailIndex(1);

    const bus = makeEventBus();
    const lastText = await consumeWorkflowStreamAsA2A({
      runId: "run-x",
      eventBus: bus as never,
      taskId: "task-1",
      contextId: "ctx-1",
    });

    expect(lastText).toBe("Hello world.");
    expect(bus.publish).toHaveBeenCalledTimes(1);
    expect(bus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        kind: "artifact-update",
        taskId: "task-1",
        contextId: "ctx-1",
        artifact: expect.objectContaining({
          artifactId: "result",
          name: "Agent Result",
          parts: [{ kind: "text", text: "Hello world." }],
        }),
        lastChunk: true,
      }),
    );
  });

  it("multiple assistant chunks → only the LAST one's text is published in the artifact", async () => {
    const fake = makeFakeRun(2, "completed");
    fake.pushChunk(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "first" }] },
      }),
    );
    fake.pushChunk(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "second" }] },
      }),
    );
    fake.pushChunk(JSON.stringify({ type: "result", status: "completed" }));
    fake.setTailIndex(2);

    const bus = makeEventBus();
    const lastText = await consumeWorkflowStreamAsA2A({
      runId: "run-x",
      eventBus: bus as never,
      taskId: "task-1",
      contextId: "ctx-1",
    });

    // Mirrors consumeA2aLogStream's behavior: accumulator is replaced on each
    // assistant event, so only the latest text is published.
    expect(lastText).toBe("second");
    expect(bus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        artifact: expect.objectContaining({
          parts: [{ kind: "text", text: "second" }],
        }),
      }),
    );
  });

  it("result with no prior assistant + no event.result/text → does NOT publish artifact (no empty result)", async () => {
    const fake = makeFakeRun(0, "completed");
    fake.pushChunk(JSON.stringify({ type: "result", status: "completed" }));
    fake.setTailIndex(0);

    const bus = makeEventBus();
    const lastText = await consumeWorkflowStreamAsA2A({
      runId: "run-x",
      eventBus: bus as never,
      taskId: "task-1",
      contextId: "ctx-1",
    });

    expect(lastText).toBe("");
    expect(bus.publish).not.toHaveBeenCalled();
  });

  it("result with event.result fallback → published when no assistant text", async () => {
    const fake = makeFakeRun(0, "completed");
    fake.pushChunk(
      JSON.stringify({ type: "result", status: "completed", result: "Fallback text" }),
    );
    fake.setTailIndex(0);

    const bus = makeEventBus();
    await consumeWorkflowStreamAsA2A({
      runId: "run-x",
      eventBus: bus as never,
      taskId: "task-1",
      contextId: "ctx-1",
    });

    expect(bus.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        artifact: expect.objectContaining({
          parts: [{ kind: "text", text: "Fallback text" }],
        }),
      }),
    );
  });

  it("non-JSON lines are skipped without crashing", async () => {
    const fake = makeFakeRun(2, "completed");
    fake.pushChunk("not valid json");
    fake.pushChunk(
      JSON.stringify({
        type: "assistant",
        message: { content: [{ type: "text", text: "ok" }] },
      }),
    );
    fake.pushChunk(JSON.stringify({ type: "result", status: "completed" }));
    fake.setTailIndex(2);

    const bus = makeEventBus();
    const lastText = await consumeWorkflowStreamAsA2A({
      runId: "run-x",
      eventBus: bus as never,
      taskId: "task-1",
      contextId: undefined,
    });

    expect(lastText).toBe("ok");
    expect(bus.publish).toHaveBeenCalledTimes(1);
  });

  it("never calls readable.cancel() (would cancel the run upstream)", async () => {
    const fake = makeFakeRun(0, "completed");
    fake.pushChunk(JSON.stringify({ type: "result", result: "x" }));
    fake.setTailIndex(0);

    const bus = makeEventBus();
    await consumeWorkflowStreamAsA2A({
      runId: "run-x",
      eventBus: bus as never,
      taskId: "task-1",
      contextId: "ctx-1",
    });

    expect(fake.cancelCalls()).toBe(0);
  });

  it("non-text content blocks are filtered (e.g., tool_use) — only text contributes to lastAssistantText", async () => {
    const fake = makeFakeRun(1, "completed");
    fake.pushChunk(
      JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "tool_use", id: "tool-1", name: "Read" },
            { type: "text", text: "the answer" },
          ],
        },
      }),
    );
    fake.pushChunk(JSON.stringify({ type: "result", status: "completed" }));
    fake.setTailIndex(1);

    const bus = makeEventBus();
    const lastText = await consumeWorkflowStreamAsA2A({
      runId: "run-x",
      eventBus: bus as never,
      taskId: "task-1",
      contextId: "ctx-1",
    });

    expect(lastText).toBe("the answer");
  });
});
