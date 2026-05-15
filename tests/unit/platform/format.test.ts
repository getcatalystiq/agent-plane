import { describe, expect, it } from "vitest";
import { formatForPlatform } from "@/lib/platform/format";

describe("formatForPlatform — Discord", () => {
  it("passes CommonMark through unchanged with rawConsumed = full input", () => {
    const out = formatForPlatform("discord", "Hello **world**", { partial: false });
    expect(out.flushable).toBe("Hello **world**");
    expect(out.remainder).toBe("");
    expect(out.rawConsumed).toBe("Hello **world**".length);
  });

  it("does not hold partial tokens for Discord", () => {
    const out = formatForPlatform("discord", "Hello **part", { partial: true });
    expect(out.flushable).toBe("Hello **part");
    expect(out.remainder).toBe("");
  });
});

describe("formatForPlatform — Slack mrkdwn", () => {
  it("converts **bold** to *bold* and reports rawConsumed = raw input length", () => {
    // Regression for C-R2-2 (review run 20260506-232400-round2): the chat
    // workflow's committedLength tracks raw input. translated.length
    // (15) is shorter than raw input length (17), so the chat workflow
    // must advance by 17, not 15, to align the next slice correctly.
    const raw = "Say **hello** now";
    const out = formatForPlatform("slack", raw, { partial: false });
    expect(out.flushable).toBe("Say *hello* now");
    expect(out.rawConsumed).toBe(raw.length);
  });

  it("converts __italic__ to _italic_", () => {
    const out = formatForPlatform("slack", "I __think__ so", { partial: false });
    expect(out.flushable).toBe("I _think_ so");
  });

  it("converts [text](url) to <url|text>", () => {
    const out = formatForPlatform("slack", "See [docs](https://ex.com/d) please", { partial: false });
    expect(out.flushable).toBe("See <https://ex.com/d|docs> please");
  });

  it("preserves <@U123> mention syntax (does not escape)", () => {
    const out = formatForPlatform("slack", "Hi <@U123>, how are you?", { partial: false });
    expect(out.flushable).toContain("<@U123>");
  });

  it("escapes bare ampersand outside code", () => {
    const out = formatForPlatform("slack", "A & B", { partial: false });
    expect(out.flushable).toBe("A &amp; B");
  });

  it("preserves fenced code blocks unchanged", () => {
    const input = "Try ```js\nconst x = 1;\n```";
    const out = formatForPlatform("slack", input, { partial: false });
    expect(out.flushable).toContain("```js\nconst x = 1;\n```");
  });

  it("holds partial bold span at the safe newline boundary", () => {
    const out = formatForPlatform("slack", "Done line.\nI am **par", { partial: true });
    expect(out.flushable).toBe("Done line.\n");
    expect(out.remainder).toBe("I am **par");
  });

  it("holds entire buffer when no safe boundary exists and span is unterminated", () => {
    const out = formatForPlatform("slack", "I am **partial", { partial: true });
    expect(out.flushable).toBe("");
    expect(out.remainder).toBe("I am **partial");
  });

  it("flushes complete sentence boundary even when partial=true if no unterminated span", () => {
    const out = formatForPlatform("slack", "All done.", { partial: true });
    expect(out.flushable).toBe("All done.");
    expect(out.remainder).toBe("");
  });
});
