/**
 * Tests for src/lib/platform/redis-bucket.ts.
 *
 * Coverage:
 *   - tryConsumeChannelToken: count <= capacity boundary
 *   - tryConsumeChannelToken: first request sets EXPIRE; subsequent calls don't
 *   - tryConsumeChannelToken: fail-open on Redis throw
 *   - drainChannelToken: SET to capacity+1 with TTL
 *   - tryAcquireDebounce: SETNX OK → true; null → false; throw → fail-open true
 *
 * Pattern: vi.mock the `redis` module's createClient before import. The
 * mock client surface mirrors the redis@5 API the implementation uses
 * (incr, expire, set, on, connect, isOpen).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const redisMock = vi.hoisted(() => {
  const incr = vi.fn();
  const expire = vi.fn();
  const set = vi.fn();
  const connect = vi.fn();
  const onSpy = vi.fn();
  return { incr, expire, set, connect, onSpy };
});

vi.mock("redis", () => ({
  createClient: vi.fn(() => ({
    incr: redisMock.incr,
    expire: redisMock.expire,
    set: redisMock.set,
    connect: redisMock.connect,
    on: redisMock.onSpy,
    get isOpen() {
      return true; // pretend connected so getClient() short-circuits
    },
  })),
}));

vi.mock("@/lib/env", () => ({
  getEnv: () => ({ REDIS_URL: "rediss://test" }),
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  tryConsumeChannelToken,
  drainChannelToken,
  tryAcquireDebounce,
  _resetRedisBucketForTests,
} from "@/lib/platform/redis-bucket";

beforeEach(() => {
  vi.clearAllMocks();
  _resetRedisBucketForTests();
  redisMock.connect.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.clearAllMocks();
});

const opts = {
  platform: "discord" as const,
  channelId: "C123",
  capacity: 5,
  windowMs: 5_000,
};

describe("tryConsumeChannelToken", () => {
  it("returns true while count <= capacity", async () => {
    redisMock.incr
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(5);
    expect(await tryConsumeChannelToken(opts)).toBe(true);
    expect(await tryConsumeChannelToken(opts)).toBe(true);
    expect(await tryConsumeChannelToken(opts)).toBe(true);
  });

  it("returns false when count exceeds capacity", async () => {
    redisMock.incr.mockResolvedValueOnce(6);
    expect(await tryConsumeChannelToken(opts)).toBe(false);
  });

  it("calls EXPIRE on first request only (count === 1)", async () => {
    redisMock.incr.mockResolvedValueOnce(1);
    await tryConsumeChannelToken(opts);
    expect(redisMock.expire).toHaveBeenCalledTimes(1);
    expect(redisMock.expire).toHaveBeenCalledWith(expect.any(String), Math.ceil(5_000 / 1000) + 1);
  });

  it("does NOT call EXPIRE on subsequent requests", async () => {
    redisMock.incr.mockResolvedValueOnce(2);
    await tryConsumeChannelToken(opts);
    expect(redisMock.expire).not.toHaveBeenCalled();
  });

  it("fails open (returns true) when Redis throws — chat replies don't take down on Redis outage", async () => {
    redisMock.incr.mockRejectedValueOnce(new Error("network blip"));
    expect(await tryConsumeChannelToken(opts)).toBe(true);
  });
});

describe("drainChannelToken", () => {
  it("SETs the bucket key to capacity+1 with TTL", async () => {
    redisMock.set.mockResolvedValueOnce("OK");
    await drainChannelToken(opts);
    expect(redisMock.set).toHaveBeenCalledTimes(1);
    const [, value, options] = redisMock.set.mock.calls[0];
    expect(value).toBe(String(opts.capacity + 1));
    expect(options).toMatchObject({ EX: Math.ceil(5_000 / 1000) + 1 });
  });

  it("swallows Redis errors (best-effort drain)", async () => {
    redisMock.set.mockRejectedValueOnce(new Error("redis down"));
    await expect(drainChannelToken(opts)).resolves.toBeUndefined();
  });
});

describe("tryAcquireDebounce", () => {
  it("returns true when SETNX returns 'OK' (key was free)", async () => {
    redisMock.set.mockResolvedValueOnce("OK");
    expect(await tryAcquireDebounce("test-key", 5_000)).toBe(true);
  });

  it("returns false when SETNX returns null (key already set)", async () => {
    redisMock.set.mockResolvedValueOnce(null);
    expect(await tryAcquireDebounce("test-key", 5_000)).toBe(false);
  });

  it("calls SET with NX condition and EX option", async () => {
    redisMock.set.mockResolvedValueOnce("OK");
    await tryAcquireDebounce("k", 5_000);
    const [key, value, options] = redisMock.set.mock.calls[0];
    expect(key).toContain("chat:debounce:k");
    expect(value).toBe("1");
    expect(options).toMatchObject({ condition: "NX", EX: 5 });
  });

  it("fails open (returns true) on Redis throw", async () => {
    redisMock.set.mockRejectedValueOnce(new Error("network"));
    expect(await tryAcquireDebounce("k", 5_000)).toBe(true);
  });
});
