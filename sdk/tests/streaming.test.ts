import { describe, it, expect } from "vitest";
import { parseNdjsonStream, RunStream } from "../src/streaming";
import type { StreamEvent, Run } from "../src/types";

// Helper to create a ReadableStream from string chunks
function createStream(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let index = 0;
  return new ReadableStream({
    pull(controller) {
      if (index < chunks.length) {
        controller.enqueue(encoder.encode(chunks[index]!));
        index++;
      } else {
        controller.close();
      }
    },
  });
}

// Helper to create a mock Response
function mockResponse(chunks: string[]): Response {
  return {
    ok: true,
    status: 200,
    body: createStream(chunks),
    headers: new Headers(),
  } as unknown as Response;
}

const mockPollRun = async (): Promise<Run> => ({
  id: "run_1",
  agent_id: "agent_1",
  tenant_id: "tenant_1",
  status: "completed",
  prompt: "test",
  result_summary: null,
  total_input_tokens: 0,
  total_output_tokens: 0,
  cache_read_tokens: 0,
  cache_creation_tokens: 0,
  cost_usd: 0,
  num_turns: 0,
  duration_ms: 0,
  duration_api_ms: 0,
  model_usage: null,
  transcript_blob_url: null,
  error_type: null,
  error_messages: [],
  sandbox_id: null,
  started_at: null,
  completed_at: null,
  created_at: "2026-01-01T00:00:00Z",
});

const mockFetchTranscript = async (): Promise<Response> => mockResponse([]);

describe("parseNdjsonStream", () => {
  it("parses complete NDJSON lines", async () => {
    const stream = createStream([
      '{"type":"run_started","run_id":"r1"}\n',
      '{"type":"result","subtype":"success"}\n',
    ]);

    const events: unknown[] = [];
    for await (const event of parseNdjsonStream(stream)) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
    expect((events[0] as Record<string, unknown>).type).toBe("run_started");
    expect((events[1] as Record<string, unknown>).type).toBe("result");
  });

  it("handles chunks split mid-line", async () => {
    const stream = createStream([
      '{"type":"run_st',
      'arted","run_id":"r1"}\n{"type":',
      '"result","subtype":"success"}\n',
    ]);

    const events: unknown[] = [];
    for await (const event of parseNdjsonStream(stream)) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
  });

  it("handles multiple events in one chunk", async () => {
    const stream = createStream([
      '{"type":"assistant"}\n{"type":"tool_use"}\n{"type":"tool_result"}\n',
    ]);

    const events: unknown[] = [];
    for await (const event of parseNdjsonStream(stream)) {
      events.push(event);
    }

    expect(events).toHaveLength(3);
  });

  it("skips empty lines", async () => {
    const stream = createStream(['{"type":"assistant"}\n\n\n{"type":"result"}\n']);

    const events: unknown[] = [];
    for await (const event of parseNdjsonStream(stream)) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
  });

  it("skips malformed JSON lines", async () => {
    const stream = createStream([
      '{"type":"assistant"}\n',
      "not valid json\n",
      '{"type":"result"}\n',
    ]);

    const events: unknown[] = [];
    for await (const event of parseNdjsonStream(stream)) {
      events.push(event);
    }

    expect(events).toHaveLength(2);
  });

  it("throws on line exceeding 1MB", async () => {
    const bigLine = "x".repeat(1_048_577); // > 1MB
    const stream = createStream([bigLine]);

    const events: unknown[] = [];
    await expect(async () => {
      for await (const event of parseNdjsonStream(stream)) {
        events.push(event);
      }
    }).rejects.toThrow("1048576 byte limit");
  });

  it("flushes remaining buffer at end", async () => {
    // No trailing newline
    const stream = createStream(['{"type":"result","subtype":"success"}']);

    const events: unknown[] = [];
    for await (const event of parseNdjsonStream(stream)) {
      events.push(event);
    }

    expect(events).toHaveLength(1);
  });
});

describe("RunStream", () => {
  it("yields events and extracts run_id", async () => {
    const response = mockResponse([
      '{"type":"run_started","run_id":"r1","agent_id":"a1","model":"claude","timestamp":"2026-01-01T00:00:00Z"}\n',
      '{"type":"assistant","message":"hello"}\n',
      '{"type":"result","subtype":"success","total_cost_usd":0.01}\n',
    ]);

    const stream = new RunStream(response, {
      pollRun: mockPollRun,
      fetchTranscript: mockFetchTranscript,
    });

    const events: StreamEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events).toHaveLength(3);
    expect(events[0]!.type).toBe("run_started");
    expect(events[1]!.type).toBe("assistant");
    expect(events[2]!.type).toBe("result");
    expect(stream.run_id).toBe("r1");
  });

  it("filters heartbeat events", async () => {
    const response = mockResponse([
      '{"type":"run_started","run_id":"r1","agent_id":"a1","model":"claude","timestamp":"2026-01-01T00:00:00Z"}\n',
      '{"type":"heartbeat","timestamp":"2026-01-01T00:00:15Z"}\n',
      '{"type":"assistant","message":"hello"}\n',
      '{"type":"heartbeat","timestamp":"2026-01-01T00:00:30Z"}\n',
      '{"type":"result","subtype":"success"}\n',
    ]);

    const stream = new RunStream(response, {
      pollRun: mockPollRun,
      fetchTranscript: mockFetchTranscript,
    });

    const events: StreamEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events).toHaveLength(3);
    expect(events.every((e) => e.type !== "heartbeat")).toBe(true);
  });

  it("yields stream_detached and stops", async () => {
    const response = mockResponse([
      '{"type":"run_started","run_id":"r1","agent_id":"a1","model":"claude","timestamp":"2026-01-01T00:00:00Z"}\n',
      '{"type":"assistant","message":"partial"}\n',
      '{"type":"stream_detached","poll_url":"/api/runs/r1","timestamp":"2026-01-01T00:04:30Z"}\n',
      '{"type":"result","subtype":"success"}\n', // should NOT be yielded
    ]);

    const stream = new RunStream(response, {
      pollRun: mockPollRun,
      fetchTranscript: mockFetchTranscript,
    });

    const events: StreamEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events).toHaveLength(3);
    expect(events[2]!.type).toBe("stream_detached");
  });

  it("throws on double iteration", async () => {
    const response = mockResponse(['{"type":"result","subtype":"success"}\n']);

    const stream = new RunStream(response, {
      pollRun: mockPollRun,
      fetchTranscript: mockFetchTranscript,
    });

    // First iteration
    for await (const _ of stream) {
      // consume
    }

    // Second iteration should throw
    expect(() => {
      stream[Symbol.asyncIterator]();
    }).toThrow("already been consumed");
  });

  it("aborts fetch on early break", async () => {
    let aborted = false;
    const controller = new AbortController();
    controller.signal.addEventListener("abort", () => {
      aborted = true;
    });

    const response = mockResponse([
      '{"type":"run_started","run_id":"r1","agent_id":"a1","model":"claude","timestamp":"2026-01-01T00:00:00Z"}\n',
      '{"type":"assistant","message":"hello"}\n',
      '{"type":"assistant","message":"world"}\n',
      '{"type":"result","subtype":"success"}\n',
    ]);

    const stream = new RunStream(response, {
      pollRun: mockPollRun,
      fetchTranscript: mockFetchTranscript,
      signal: controller.signal,
    });

    const events: StreamEvent[] = [];
    for await (const event of stream) {
      events.push(event);
      if (events.length === 2) break;
    }

    expect(events).toHaveLength(2);
    // Stream should have been aborted via the iterator return()
  });

  it("handles unknown event types gracefully", async () => {
    const response = mockResponse([
      '{"type":"run_started","run_id":"r1","agent_id":"a1","model":"claude","timestamp":"2026-01-01T00:00:00Z"}\n',
      '{"type":"future_event","data":"something"}\n',
      '{"type":"result","subtype":"success"}\n',
    ]);

    const stream = new RunStream(response, {
      pollRun: mockPollRun,
      fetchTranscript: mockFetchTranscript,
    });

    const events: StreamEvent[] = [];
    for await (const event of stream) {
      events.push(event);
    }

    expect(events).toHaveLength(3);
    expect(events[1]!.type).toBe("future_event");
  });
});
