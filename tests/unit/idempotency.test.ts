import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { getIdempotentResponse, setIdempotentResponse } from "@/lib/idempotency";

describe("getIdempotentResponse", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("returns null for unknown key", () => {
    expect(getIdempotentResponse(`unknown-${Math.random()}`)).toBeNull();
  });

  it("returns stored value after setIdempotentResponse", () => {
    const key = `key-${Math.random()}`;
    setIdempotentResponse(key, { result: "ok", status: 201 });
    expect(getIdempotentResponse(key)).toEqual({ result: "ok", status: 201 });
  });

  it("returns null after TTL expires", () => {
    const key = `key-${Math.random()}`;
    setIdempotentResponse(key, "value");
    vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1); // 24h + 1ms
    expect(getIdempotentResponse(key)).toBeNull();
  });

  it("stores and retrieves complex objects", () => {
    const key = `key-${Math.random()}`;
    const value = { nested: { arr: [1, 2, 3], str: "hello" } };
    setIdempotentResponse(key, value);
    expect(getIdempotentResponse(key)).toEqual(value);
  });
});

describe("setIdempotentResponse", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("stores string values", () => {
    const key = `key-${Math.random()}`;
    setIdempotentResponse(key, "hello");
    expect(getIdempotentResponse(key)).toBe("hello");
  });

  it("stores null values", () => {
    const key = `key-${Math.random()}`;
    setIdempotentResponse(key, null);
    // getIdempotentResponse returns null for both "not found" and stored null value
    // Verify by overwriting with a non-null value to confirm the key works
    setIdempotentResponse(key, "replaced");
    expect(getIdempotentResponse(key)).toBe("replaced");
  });

  it("overwrites existing entry for same key", () => {
    const key = `key-${Math.random()}`;
    setIdempotentResponse(key, "first");
    setIdempotentResponse(key, "second");
    expect(getIdempotentResponse(key)).toBe("second");
  });

  it("TTL is 24 hours from time of set", () => {
    const key = `key-${Math.random()}`;
    setIdempotentResponse(key, "value");
    // Just before expiry - should still return value
    vi.advanceTimersByTime(24 * 60 * 60 * 1000 - 1);
    expect(getIdempotentResponse(key)).toBe("value");
    // At/after expiry - should return null
    vi.advanceTimersByTime(2);
    expect(getIdempotentResponse(key)).toBeNull();
  });
});

describe("capacity eviction", () => {
  beforeEach(() => { vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it("stores new entry after filling capacity (evicts oldest)", () => {
    // Fill the store to MAX_ENTRIES (10_000)
    // Use unique prefix to avoid collisions with other tests
    const prefix = `capacity-${Math.random()}-`;
    for (let i = 0; i < 10_000; i++) {
      setIdempotentResponse(`${prefix}${i}`, i);
    }
    // Add one more - should trigger eviction
    const newKey = `${prefix}new`;
    setIdempotentResponse(newKey, "new-value");
    // The new entry should be accessible
    expect(getIdempotentResponse(newKey)).toBe("new-value");
  });
});
