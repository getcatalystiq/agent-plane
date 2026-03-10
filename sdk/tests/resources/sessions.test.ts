import { describe, it, expect, vi, beforeEach } from "vitest";
import { createClient, jsonOk, jsonError } from "../helpers";

const mockFetch = vi.fn();
let client: ReturnType<typeof createClient>;

const mockSession = {
  id: "sess-1",
  tenant_id: "tenant-1",
  agent_id: "agent-1",
  status: "idle",
  message_count: 0,
  idle_since: "2026-01-01T00:00:00Z",
  created_at: "2026-01-01T00:00:00Z",
  updated_at: "2026-01-01T00:00:00Z",
  last_message_at: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  client = createClient(mockFetch);
});

describe("sessions.create", () => {
  it("creates session without prompt (returns JSON)", async () => {
    mockFetch.mockResolvedValue(jsonOk(mockSession));

    const result = await client.sessions.create({ agent_id: "agent-1" });
    expect(result).toEqual(mockSession);

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/sessions");
    expect(init.method).toBe("POST");
    const body = JSON.parse(init.body);
    expect(body.agent_id).toBe("agent-1");
    expect(body.prompt).toBeUndefined();
  });

  it("creates session with prompt (returns stream)", async () => {
    const events = [
      JSON.stringify({ type: "session_created", session_id: "sess-1", agent_id: "agent-1", timestamp: "2026-01-01" }),
      JSON.stringify({ type: "run_started", run_id: "run-1", agent_id: "agent-1", model: "claude-sonnet-4-6", timestamp: "2026-01-01" }),
      JSON.stringify({ type: "text_delta", text: "Hello" }),
      JSON.stringify({ type: "result", subtype: "success" }),
    ];
    const body = new ReadableStream({
      start(controller) {
        for (const event of events) {
          controller.enqueue(new TextEncoder().encode(event + "\n"));
        }
        controller.close();
      },
    });
    mockFetch.mockResolvedValue({ ok: true, status: 200, body });

    const stream = await client.sessions.create({ agent_id: "agent-1", prompt: "Hello" });
    // RunStream is an async iterable
    const collectedEvents = [];
    for await (const event of stream as AsyncIterable<unknown>) {
      collectedEvents.push(event);
    }
    expect(collectedEvents.length).toBe(4);
    expect(collectedEvents[0]).toEqual(expect.objectContaining({ type: "session_created" }));
  });
});

describe("sessions.get", () => {
  it("returns session with runs", async () => {
    const sessionWithRuns = { ...mockSession, runs: [] };
    mockFetch.mockResolvedValue(jsonOk(sessionWithRuns));

    const result = await client.sessions.get("sess-1");
    expect(result.id).toBe("sess-1");
    expect(result.runs).toEqual([]);

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/sessions/sess-1");
  });

  it("throws on 404", async () => {
    mockFetch.mockResolvedValue(jsonError(404, { code: "not_found", message: "Session not found" }));
    await expect(client.sessions.get("nonexistent")).rejects.toThrow();
  });
});

describe("sessions.list", () => {
  it("lists sessions with pagination", async () => {
    const data = { data: [mockSession], limit: 20, offset: 0 };
    mockFetch.mockResolvedValue(jsonOk(data));

    const result = await client.sessions.list({ limit: 20, offset: 0 });
    expect(result.data).toHaveLength(1);
    expect(result.has_more).toBe(false);
  });

  it("filters by agent_id and status", async () => {
    const data = { data: [], limit: 20, offset: 0 };
    mockFetch.mockResolvedValue(jsonOk(data));

    await client.sessions.list({ agent_id: "agent-1", status: "idle" });

    const [url] = mockFetch.mock.calls[0];
    expect(url).toContain("agent_id=agent-1");
    expect(url).toContain("status=idle");
  });
});

describe("sessions.sendMessage", () => {
  it("sends a message and returns a stream", async () => {
    const events = [
      JSON.stringify({ type: "run_started", run_id: "run-2", agent_id: "agent-1", model: "claude-sonnet-4-6", timestamp: "2026-01-01" }),
      JSON.stringify({ type: "text_delta", text: "Response" }),
      JSON.stringify({ type: "result", subtype: "success" }),
    ];
    const body = new ReadableStream({
      start(controller) {
        for (const event of events) {
          controller.enqueue(new TextEncoder().encode(event + "\n"));
        }
        controller.close();
      },
    });
    mockFetch.mockResolvedValue({ ok: true, status: 200, body });

    const stream = await client.sessions.sendMessage("sess-1", { prompt: "What's up?" });

    const collected = [];
    for await (const event of stream) {
      collected.push(event);
    }
    expect(collected).toHaveLength(3);

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/sessions/sess-1/messages");
    expect(init.method).toBe("POST");
  });
});

describe("sessions.stop", () => {
  it("stops session via DELETE", async () => {
    const stoppedSession = { ...mockSession, status: "stopped" };
    mockFetch.mockResolvedValue(jsonOk(stoppedSession));

    const result = await client.sessions.stop("sess-1");
    expect(result.status).toBe("stopped");

    const [url, init] = mockFetch.mock.calls[0];
    expect(url).toContain("/api/sessions/sess-1");
    expect(init.method).toBe("DELETE");
  });
});

describe("sessions.sendMessageAndWait", () => {
  it("returns text and events", async () => {
    const events = [
      JSON.stringify({ type: "run_started", run_id: "run-3", agent_id: "agent-1", model: "claude-sonnet-4-6", timestamp: "2026-01-01" }),
      JSON.stringify({ type: "text_delta", text: "Hello " }),
      JSON.stringify({ type: "text_delta", text: "world" }),
      JSON.stringify({ type: "result", subtype: "success" }),
    ];
    const body = new ReadableStream({
      start(controller) {
        for (const event of events) {
          controller.enqueue(new TextEncoder().encode(event + "\n"));
        }
        controller.close();
      },
    });
    mockFetch.mockResolvedValue({ ok: true, status: 200, body });

    const result = await client.sessions.sendMessageAndWait("sess-1", { prompt: "Hi" });
    expect(result.text).toBe("Hello world");
    expect(result.events).toHaveLength(4);
  });
});
