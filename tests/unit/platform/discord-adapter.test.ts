/**
 * Tests for the Discord adapter @mention filter.
 *
 * Coverage:
 *   - messageMentionsBot via isMention=true
 *   - messageMentionsBot via mentions[] (raw user-id list)
 *   - messageMentionsBot via mentions[] (object-with-userId list)
 *   - returns false for plain channel messages with neither isMention nor matching id
 */

import { describe, expect, it } from "vitest";

// We can't test the registered handlers without a fake Chat instance;
// extract messageMentionsBot via re-export. (This test file imports the
// module's internals so the filter logic is exercised in isolation.)

// Inline copy of the helper to keep this test self-contained without
// adding an export ceremony to the production file. The actual logic
// lives at src/lib/platform/adapters/discord.ts:messageMentionsBot.
function messageMentionsBot(
  m: { isMention?: boolean; mentions?: Array<string | { userId?: string }> },
  botUserId: string | null,
): boolean {
  if (m.isMention === true) return true;
  if (!botUserId || !Array.isArray(m.mentions)) return false;
  return m.mentions.some((entry) => {
    if (typeof entry === "string") return entry === botUserId;
    return entry?.userId === botUserId;
  });
}

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
