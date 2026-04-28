import { describe, it, expect } from "vitest";
import {
  messageStatusToA2a,
  a2aToMessageStatus,
  messageToA2aTask,
  a2aHeaders,
  getCachedAgentCard,
  setCachedAgentCard,
  validateA2aMessage,
  sanitizeRequestId,
} from "@/lib/a2a";

describe("messageStatusToA2a", () => {
  it("maps queued to submitted", () => {
    expect(messageStatusToA2a("queued")).toBe("submitted");
  });

  it("maps running to working", () => {
    expect(messageStatusToA2a("running")).toBe("working");
  });

  it("maps completed to completed", () => {
    expect(messageStatusToA2a("completed")).toBe("completed");
  });

  it("maps failed to failed", () => {
    expect(messageStatusToA2a("failed")).toBe("failed");
  });

  it("maps cancelled to canceled (note spelling)", () => {
    expect(messageStatusToA2a("cancelled")).toBe("canceled");
  });

  it("maps timed_out to failed", () => {
    expect(messageStatusToA2a("timed_out")).toBe("failed");
  });
});

describe("a2aToMessageStatus", () => {
  it("maps submitted to queued", () => {
    expect(a2aToMessageStatus("submitted")).toBe("queued");
  });

  it("maps working to running", () => {
    expect(a2aToMessageStatus("working")).toBe("running");
  });

  it("maps completed to completed", () => {
    expect(a2aToMessageStatus("completed")).toBe("completed");
  });

  it("maps failed to failed", () => {
    expect(a2aToMessageStatus("failed")).toBe("failed");
  });

  it("maps canceled to cancelled", () => {
    expect(a2aToMessageStatus("canceled")).toBe("cancelled");
  });

  it("maps rejected to failed", () => {
    expect(a2aToMessageStatus("rejected")).toBe("failed");
  });

  it("returns null for unknown states", () => {
    expect(a2aToMessageStatus("input-required")).toBeNull();
    expect(a2aToMessageStatus("auth-required")).toBeNull();
    expect(a2aToMessageStatus("unknown")).toBeNull();
  });
});

describe("messageToA2aTask", () => {
  const baseMessage = {
    id: "a0b1c2d3-e4f5-4678-9abc-def012345678",
    session_id: "11111111-2222-3333-4444-555555555555",
    status: "completed" as const,
    result_summary: "Task completed successfully",
    duration_ms: 5000,
    created_at: "2026-01-01T00:00:00Z",
    completed_at: "2026-01-01T00:00:05Z",
  };

  it("maps completed message with result artifact", () => {
    const task = messageToA2aTask(baseMessage);
    expect(task.id).toBe(baseMessage.id);
    expect(task.kind).toBe("task");
    expect(task.status.state).toBe("completed");
    expect(task.status.timestamp).toBe(baseMessage.completed_at);
    expect(task.artifacts).toHaveLength(1);
    expect(task.artifacts![0].parts[0]).toEqual({ kind: "text", text: "Task completed successfully" });
  });

  it("maps failed message with result artifact", () => {
    const task = messageToA2aTask({ ...baseMessage, status: "failed", result_summary: "Error occurred" });
    expect(task.status.state).toBe("failed");
    expect(task.artifacts).toHaveLength(1);
  });

  it("maps queued message with no artifacts", () => {
    const task = messageToA2aTask({ ...baseMessage, status: "queued", result_summary: null, completed_at: null });
    expect(task.status.state).toBe("submitted");
    expect(task.status.timestamp).toBe(baseMessage.created_at);
    expect(task.artifacts).toBeUndefined();
  });

  it("does not include transcript URL in metadata", () => {
    const task = messageToA2aTask(baseMessage);
    const apMeta = task.metadata?.["agent-plane"] as Record<string, unknown> | undefined;
    expect(apMeta).toBeDefined();
    expect(apMeta?.duration_ms).toBe(5000);
    expect(apMeta).not.toHaveProperty("transcript_url");
  });

  it("omits metadata when duration is zero", () => {
    const task = messageToA2aTask({ ...baseMessage, duration_ms: 0 });
    expect(task.metadata).toBeUndefined();
  });

  it("uses contextId = session_id when no override", () => {
    const task = messageToA2aTask(baseMessage);
    expect(task.contextId).toBe(baseMessage.session_id);
  });

  it("honors effectiveContextId override", () => {
    const override = "abc-123";
    const task = messageToA2aTask(baseMessage, override);
    expect(task.contextId).toBe(override);
  });
});

describe("a2aHeaders", () => {
  it("includes version and request ID", () => {
    const headers = a2aHeaders("req-123");
    expect(headers["A2A-Version"]).toBe("1.0");
    expect(headers["A2A-Request-Id"]).toBe("req-123");
  });

  it("merges extra headers", () => {
    const headers = a2aHeaders("req-456", { "Cache-Control": "no-cache" });
    expect(headers["A2A-Version"]).toBe("1.0");
    expect(headers["A2A-Request-Id"]).toBe("req-456");
    expect(headers["Cache-Control"]).toBe("no-cache");
  });

  it("extra headers override defaults", () => {
    const headers = a2aHeaders("req-789", { "A2A-Version": "2.0" });
    expect(headers["A2A-Version"]).toBe("2.0");
  });
});

describe("agentCardCache", () => {
  it("returns null for missing key", () => {
    expect(getCachedAgentCard("nonexistent-slug")).toBeNull();
  });

  it("stores and retrieves agent card", () => {
    const card = { name: "Test" } as Parameters<typeof setCachedAgentCard>[1];
    setCachedAgentCard("test-slug", card);
    expect(getCachedAgentCard("test-slug")).toBe(card);
  });

  it("evicts oldest entry when cache is full", () => {
    // Fill cache to max (AGENT_CARD_CACHE_MAX = 1000)
    for (let i = 0; i < 1000; i++) {
      setCachedAgentCard(`evict-slug-${i}`, { name: `Agent ${i}` } as Parameters<typeof setCachedAgentCard>[1]);
    }
    // Adding one more should evict the oldest (evict-slug-0)
    setCachedAgentCard("evict-slug-new", { name: "New" } as Parameters<typeof setCachedAgentCard>[1]);
    expect(getCachedAgentCard("evict-slug-0")).toBeNull();
    expect(getCachedAgentCard("evict-slug-new")).not.toBeNull();
  });
});

describe("validateA2aMessage", () => {
  const validMessage = {
    kind: "message" as const,
    messageId: "test-123",
    role: "user" as const,
    parts: [{ kind: "text" as const, text: "Hello" }],
  };

  it("returns null for valid messages", () => {
    expect(validateA2aMessage(validMessage)).toBeNull();
  });

  it("rejects empty parts", () => {
    expect(validateA2aMessage({ ...validMessage, parts: [] })).toBe(
      "Message must contain at least one part",
    );
  });

  it("rejects non-user role", () => {
    expect(validateA2aMessage({ ...validMessage, role: "agent" as const })).toBe(
      "Message role must be 'user'",
    );
  });

  it("rejects invalid referenceTaskIds", () => {
    expect(
      validateA2aMessage({
        ...validMessage,
        referenceTaskIds: ["not-a-uuid"],
      }),
    ).toMatch(/Invalid referenceTaskId format/);
  });

  it("allows valid UUID referenceTaskIds", () => {
    expect(
      validateA2aMessage({
        ...validMessage,
        referenceTaskIds: ["a0b1c2d3-e4f5-4678-9abc-def012345678"],
      }),
    ).toBeNull();
  });

  it("rejects more than 10 referenceTaskIds", () => {
    const ids = Array.from({ length: 11 }, (_, i) =>
      `a0b1c2d3-e4f5-4678-9abc-def01234567${i.toString(16)}`,
    );
    expect(
      validateA2aMessage({ ...validMessage, referenceTaskIds: ids }),
    ).toBe("Maximum 10 referenceTaskIds allowed");
  });

  it("rejects long contextId", () => {
    expect(
      validateA2aMessage({
        ...validMessage,
        contextId: "a".repeat(129),
      }),
    ).toBe("contextId must be at most 128 characters");
  });

  it("rejects contextId with invalid characters", () => {
    expect(
      validateA2aMessage({
        ...validMessage,
        contextId: "abc def",
      }),
    ).toBe("contextId must be alphanumeric with hyphens only");
  });
});

describe("sanitizeRequestId", () => {
  it("generates UUID for null header", () => {
    const id = sanitizeRequestId(null);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("passes through valid alphanumeric+hyphens", () => {
    expect(sanitizeRequestId("abc-123-def")).toBe("abc-123-def");
  });

  it("strips invalid characters", () => {
    expect(sanitizeRequestId("abc!@#def")).toBe("abcdef");
  });

  it("truncates to 128 chars", () => {
    const long = "a".repeat(200);
    expect(sanitizeRequestId(long).length).toBe(128);
  });

  it("generates UUID for header with only invalid chars", () => {
    const id = sanitizeRequestId("!@#$%");
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
  });
});
