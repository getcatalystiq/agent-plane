/**
 * Tests for the Discord adapter @mention filter.
 *
 * Coverage:
 *   - messageMentionsBot via isMention=true
 *   - messageMentionsBot via mentions[] (raw user-id list)
 *   - messageMentionsBot via mentions[] (object-with-userId list)
 *   - returns false for plain channel messages with neither isMention nor matching id
 */

import { describe, expect, it, vi } from "vitest";

// Mock the bridge so importing the discord adapter module doesn't drag
// the workflow dependency tree into the test surface.
vi.mock("@/lib/platform/bridge", () => ({
  triggerChatWorkflow: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { messageMentionsBot } from "@/lib/platform/adapters/discord";

describe("messageMentionsBot", () => {
  it("returns true when isMention is explicitly true", () => {
    expect(messageMentionsBot({ isMention: true }, "BOT123")).toBe(true);
    expect(messageMentionsBot({ isMention: true }, null)).toBe(true);
  });

  it("returns true when mentions[] contains the bot user id as a string", () => {
    expect(messageMentionsBot({ mentions: ["U1", "BOT123", "U2"] }, "BOT123")).toBe(true);
  });

  it("returns true when mentions[] contains an object with matching userId", () => {
    expect(
      messageMentionsBot({ mentions: [{ userId: "U1" }, { userId: "BOT123" }] }, "BOT123"),
    ).toBe(true);
  });

  it("returns false when neither isMention nor mentions[] match", () => {
    expect(messageMentionsBot({ isMention: false, mentions: ["U1"] }, "BOT123")).toBe(false);
    expect(messageMentionsBot({ mentions: [{ userId: "U2" }] }, "BOT123")).toBe(false);
  });

  it("returns false when botUserId is null", () => {
    expect(messageMentionsBot({ mentions: ["BOT123"] }, null)).toBe(false);
  });

  it("returns false when mentions is not an array", () => {
    expect(messageMentionsBot({}, "BOT123")).toBe(false);
    expect(messageMentionsBot({ mentions: "not-an-array" as unknown as string[] }, "BOT123")).toBe(false);
  });

  it("returns false when mentions array is empty", () => {
    expect(messageMentionsBot({ mentions: [] }, "BOT123")).toBe(false);
  });
});
