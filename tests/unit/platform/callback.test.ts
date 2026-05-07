import { describe, expect, it } from "vitest";
import { ChannelTokenBucket, parseRateLimit } from "@/lib/platform/callback";

describe("parseRateLimit", () => {
  it("returns null on a normal Error", () => {
    expect(parseRateLimit(new Error("some other failure"))).toBeNull();
  });

  it("returns retry-after ms when error.status is 429 with seconds payload", () => {
    const err = { status: 429, retryAfter: 3, message: "Too Many Requests" };
    expect(parseRateLimit(err)).toBe(3000);
  });

  it("returns retry-after ms when retry_after is in seconds (snake_case Discord shape)", () => {
    const err = { statusCode: 429, retry_after: 2.5 };
    expect(parseRateLimit(err)).toBe(2500);
  });

  it("treats values >= 50 as already-ms (some SDKs normalize that way)", () => {
    expect(parseRateLimit({ status: 429, retryAfter: 1500 })).toBe(1500);
  });

  it("falls back to 1000ms when 429 with no retry-after header", () => {
    expect(parseRateLimit({ status: 429, message: "rate limited" })).toBe(1000);
  });

  it("matches via message text when status is missing", () => {
    expect(parseRateLimit(new Error("HTTP 429 rate-limit triggered"))).toBe(1000);
  });
});

describe("ChannelTokenBucket", () => {
  it("starts full and decrements per consume", () => {
    const b = new ChannelTokenBucket(5, 5_000);
    expect(b.tryConsume()).toBe(true);
    expect(b.tryConsume()).toBe(true);
  });

  it("blocks when drained", () => {
    const b = new ChannelTokenBucket(2, 5_000);
    expect(b.tryConsume()).toBe(true);
    expect(b.tryConsume()).toBe(true);
    expect(b.tryConsume()).toBe(false);
  });

  it("drain() empties the bucket immediately", () => {
    const b = new ChannelTokenBucket(5, 5_000);
    b.drain();
    expect(b.tryConsume()).toBe(false);
  });

  it("refills proportionally with elapsed time", async () => {
    const b = new ChannelTokenBucket(5, 100);
    for (let i = 0; i < 5; i++) b.tryConsume();
    expect(b.tryConsume()).toBe(false);
    // Wait beyond the window — tokens fully refilled.
    await new Promise((r) => setTimeout(r, 110));
    expect(b.tryConsume()).toBe(true);
  });
});
