/**
 * Tests for src/lib/platform/blob-canary.ts.
 *
 * Coverage:
 *   - Throws when BLOB_PRIVATE_READ_WRITE_TOKEN is unset
 *   - FAIL-CLOSED when anonymous fetch returns probeContent (the security
 *     invariant: a publicly-readable store is fatal)
 *   - PASS when anonymous fetch errors or returns non-OK (private store)
 *   - Caches success result for the canary TTL
 *   - Cool-off after failure
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const env = { BLOB_PRIVATE_READ_WRITE_TOKEN: "vercel_blob_rw_x" as string | undefined };

vi.mock("@/lib/env", () => ({
  getEnv: () => env,
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const putMock = vi.hoisted(() => vi.fn());
vi.mock("@vercel/blob", () => ({
  put: putMock,
}));

import {
  ensurePrivateBlobStore,
  _resetBlobCanaryForTests,
} from "@/lib/platform/blob-canary";

let fetchSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.clearAllMocks();
  _resetBlobCanaryForTests();
  env.BLOB_PRIVATE_READ_WRITE_TOKEN = "vercel_blob_rw_x";
  fetchSpy = vi.spyOn(globalThis, "fetch") as ReturnType<typeof vi.spyOn>;
});

afterEach(() => {
  fetchSpy.mockRestore();
  _resetBlobCanaryForTests();
});

describe("ensurePrivateBlobStore", () => {
  it("rejects when BLOB_PRIVATE_READ_WRITE_TOKEN is unset", async () => {
    env.BLOB_PRIVATE_READ_WRITE_TOKEN = undefined;
    await expect(ensurePrivateBlobStore()).rejects.toThrow(/BLOB_PRIVATE_READ_WRITE_TOKEN/);
  });

  it("FAIL-CLOSED: rejects when anonymous fetch returns the probe content", async () => {
    putMock.mockResolvedValueOnce({ url: "https://blob.test/probe.txt" });
    fetchSpy.mockResolvedValueOnce(
      new Response("private-store-canary", { status: 200 }),
    );
    await expect(ensurePrivateBlobStore()).rejects.toThrow(/publicly-readable/);
  });

  it("passes when anonymous fetch returns non-OK (private store healthy)", async () => {
    putMock.mockResolvedValueOnce({ url: "https://blob.test/probe.txt" });
    fetchSpy.mockResolvedValueOnce(new Response("forbidden", { status: 403 }));
    await expect(ensurePrivateBlobStore()).resolves.toBeUndefined();
  });

  it("passes when anonymous fetch throws (private endpoint refusing connection)", async () => {
    putMock.mockResolvedValueOnce({ url: "https://blob.test/probe.txt" });
    fetchSpy.mockRejectedValueOnce(new TypeError("network refused"));
    await expect(ensurePrivateBlobStore()).resolves.toBeUndefined();
  });

  it("caches success — second call within TTL does not re-upload", async () => {
    putMock.mockResolvedValueOnce({ url: "https://blob.test/probe.txt" });
    fetchSpy.mockResolvedValueOnce(new Response("forbidden", { status: 403 }));
    await ensurePrivateBlobStore();
    await ensurePrivateBlobStore();
    expect(putMock).toHaveBeenCalledTimes(1);
  });

  it("re-runs after explicit reset (simulates a successful TTL elapse / env rotation)", async () => {
    putMock.mockResolvedValue({ url: "https://blob.test/probe.txt" });
    fetchSpy.mockResolvedValue(new Response("forbidden", { status: 403 }));
    await ensurePrivateBlobStore();
    _resetBlobCanaryForTests();
    await ensurePrivateBlobStore();
    expect(putMock).toHaveBeenCalledTimes(2);
  });

  it("caches failure during cool-off", async () => {
    putMock.mockResolvedValueOnce({ url: "https://blob.test/probe.txt" });
    fetchSpy.mockResolvedValueOnce(new Response("private-store-canary", { status: 200 }));
    await expect(ensurePrivateBlobStore()).rejects.toThrow();
    // Second call within cool-off returns the cached rejection (no new put).
    await expect(ensurePrivateBlobStore()).rejects.toThrow();
    expect(putMock).toHaveBeenCalledTimes(1);
  });
});
