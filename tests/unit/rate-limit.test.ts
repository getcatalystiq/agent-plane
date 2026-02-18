import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { checkRateLimit } from "@/lib/rate-limit";

describe("checkRateLimit", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("first request is allowed with remaining=limit-1", () => {
    const key = `test-${Math.random()}`;
    const result = checkRateLimit(key, 5, 60_000);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
    expect(result.retryAfterMs).toBe(0);
  });

  it("subsequent requests under limit are allowed", () => {
    const key = `test-${Math.random()}`;
    checkRateLimit(key, 5, 60_000); // 1st
    const result = checkRateLimit(key, 5, 60_000); // 2nd
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(3);
  });

  it("request at limit is blocked", () => {
    const key = `test-${Math.random()}`;
    for (let i = 0; i < 5; i++) checkRateLimit(key, 5, 60_000);
    const result = checkRateLimit(key, 5, 60_000);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfterMs).toBeGreaterThan(0);
  });

  it("retryAfterMs approximately equals windowMs on first blocked request", () => {
    const key = `test-${Math.random()}`;
    const windowMs = 60_000;
    for (let i = 0; i < 3; i++) checkRateLimit(key, 3, windowMs);
    const result = checkRateLimit(key, 3, windowMs);
    expect(result.allowed).toBe(false);
    // retryAfterMs should be close to windowMs (within 100ms)
    expect(result.retryAfterMs).toBeGreaterThan(windowMs - 100);
    expect(result.retryAfterMs).toBeLessThanOrEqual(windowMs);
  });

  it("window expiry allows new request and resets bucket", () => {
    const key = `test-${Math.random()}`;
    const windowMs = 60_000;
    for (let i = 0; i < 3; i++) checkRateLimit(key, 3, windowMs);
    // Block it
    expect(checkRateLimit(key, 3, windowMs).allowed).toBe(false);
    // Advance time past window
    vi.advanceTimersByTime(windowMs + 1);
    // Now should be fresh
    const result = checkRateLimit(key, 3, windowMs);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(2);
  });

  it("different keys do not interfere with each other", () => {
    const key1 = `test-${Math.random()}`;
    const key2 = `test-${Math.random()}`;
    for (let i = 0; i < 3; i++) checkRateLimit(key1, 3, 60_000);
    // key1 is blocked
    expect(checkRateLimit(key1, 3, 60_000).allowed).toBe(false);
    // key2 is fresh
    expect(checkRateLimit(key2, 3, 60_000).allowed).toBe(true);
  });
});
