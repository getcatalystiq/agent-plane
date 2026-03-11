import { describe, it, expect } from "vitest";
import {
  runStatusToA2a,
  a2aToRunStatus,
  validateA2aMessage,
  sanitizeRequestId,
} from "@/lib/a2a";

describe("runStatusToA2a", () => {
  it("maps pending to working", () => {
    expect(runStatusToA2a("pending")).toBe("working");
  });

  it("maps running to working", () => {
    expect(runStatusToA2a("running")).toBe("working");
  });

  it("maps completed to completed", () => {
    expect(runStatusToA2a("completed")).toBe("completed");
  });

  it("maps failed to failed", () => {
    expect(runStatusToA2a("failed")).toBe("failed");
  });

  it("maps cancelled to canceled (note spelling)", () => {
    expect(runStatusToA2a("cancelled")).toBe("canceled");
  });

  it("maps timed_out to failed", () => {
    expect(runStatusToA2a("timed_out")).toBe("failed");
  });
});

describe("a2aToRunStatus", () => {
  it("maps submitted to pending", () => {
    expect(a2aToRunStatus("submitted")).toBe("pending");
  });

  it("maps working to running", () => {
    expect(a2aToRunStatus("working")).toBe("running");
  });

  it("maps completed to completed", () => {
    expect(a2aToRunStatus("completed")).toBe("completed");
  });

  it("maps failed to failed", () => {
    expect(a2aToRunStatus("failed")).toBe("failed");
  });

  it("maps canceled to cancelled", () => {
    expect(a2aToRunStatus("canceled")).toBe("cancelled");
  });

  it("maps rejected to failed", () => {
    expect(a2aToRunStatus("rejected")).toBe("failed");
  });

  it("returns null for unknown states", () => {
    expect(a2aToRunStatus("input-required")).toBeNull();
    expect(a2aToRunStatus("auth-required")).toBeNull();
    expect(a2aToRunStatus("unknown")).toBeNull();
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
