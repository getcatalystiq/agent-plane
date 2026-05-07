import { describe, expect, it } from "vitest";
import { parseRateLimit } from "@/lib/platform/callback";

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

  it("treats Slack Retry-After: 60 as 60 seconds (60_000 ms), not 60 ms", () => {
    // Regression: review run 20260506-221948-2402b0ed P1 #7 — earlier
    // heuristic mis-scaled Slack-style Retry-After ≥ 50 to ms.
    expect(parseRateLimit({ status: 429, retryAfter: 60 })).toBe(60_000);
  });

  it("treats large retry_after values as seconds even when ≥ 50", () => {
    expect(parseRateLimit({ status: 429, retryAfter: 120 })).toBe(120_000);
  });

  it("falls back to 1000ms when 429 with no retry-after header", () => {
    expect(parseRateLimit({ status: 429, message: "rate limited" })).toBe(1000);
  });

  it("matches via message text when status is missing", () => {
    expect(parseRateLimit(new Error("HTTP 429 rate-limit triggered"))).toBe(1000);
  });
});

// ChannelTokenBucket moved to Redis-backed helpers in
// src/lib/platform/redis-bucket.ts (A3, replaces P1 #8). Runtime tests
// for tryConsumeChannelToken / drainChannelToken require a live Redis
// instance and are deferred to the integration suite.
