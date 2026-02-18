import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("@/db", () => ({
  queryOne: vi.fn(),
  execute: vi.fn().mockResolvedValue({ rowCount: 1 }),
}));

vi.mock("@/lib/crypto", () => ({
  hashApiKey: vi.fn().mockResolvedValue("hashed-key-abc123"),
  timingSafeEqual: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    error: vi.fn(),
    warn: vi.fn(),
    info: vi.fn(),
    debug: vi.fn(),
  },
}));

import { authenticateApiKey, authenticateAdmin } from "@/lib/auth";
import { queryOne } from "@/db";
import { timingSafeEqual } from "@/lib/crypto";

describe("authenticateApiKey", () => {
  beforeEach(() => vi.clearAllMocks());

  it("throws on null header", async () => {
    await expect(authenticateApiKey(null)).rejects.toThrow(
      "Missing or invalid Authorization header",
    );
  });

  it("throws on non-Bearer header", async () => {
    await expect(authenticateApiKey("Basic abc123")).rejects.toThrow(
      "Missing or invalid Authorization header",
    );
  });

  it("throws on invalid key format (no ap_live_/ap_test_ prefix)", async () => {
    await expect(
      authenticateApiKey("Bearer some_random_key"),
    ).rejects.toThrow("Invalid API key format");
  });

  it("returns AuthContext for valid ap_live_ key", async () => {
    vi.mocked(queryOne).mockResolvedValue({
      id: "key-id-1",
      tenant_id: "tenant-1",
      name: "my-key",
    });
    const ctx = await authenticateApiKey(
      "Bearer ap_live_abc123def456ghi789jkl012mno345pq",
    );
    expect(ctx.tenantId).toBe("tenant-1");
    expect(ctx.apiKeyId).toBe("key-id-1");
    expect(ctx.apiKeyName).toBe("my-key");
  });

  it("returns AuthContext for valid ap_test_ key", async () => {
    vi.mocked(queryOne).mockResolvedValue({
      id: "key-id-2",
      tenant_id: "tenant-2",
      name: "test-key",
    });
    const ctx = await authenticateApiKey(
      "Bearer ap_test_abc123def456ghi789jkl012mno345pq",
    );
    expect(ctx.tenantId).toBe("tenant-2");
    expect(ctx.apiKeyId).toBe("key-id-2");
    expect(ctx.apiKeyName).toBe("test-key");
  });

  it("throws when queryOne returns null", async () => {
    vi.mocked(queryOne).mockResolvedValue(null);
    await expect(
      authenticateApiKey("Bearer ap_live_abc123def456ghi789jkl012mno345pq"),
    ).rejects.toThrow("Invalid or revoked API key");
  });

  it("returned AuthContext has tenantId, apiKeyId, apiKeyName", async () => {
    vi.mocked(queryOne).mockResolvedValue({
      id: "key-99",
      tenant_id: "tenant-99",
      name: "prod-key",
    });
    const ctx = await authenticateApiKey(
      "Bearer ap_live_abc123def456ghi789jkl012mno345pq",
    );
    expect(ctx).toHaveProperty("tenantId");
    expect(ctx).toHaveProperty("apiKeyId");
    expect(ctx).toHaveProperty("apiKeyName");
    expect(ctx.tenantId).toBe("tenant-99");
    expect(ctx.apiKeyId).toBe("key-99");
    expect(ctx.apiKeyName).toBe("prod-key");
  });
});

describe("authenticateAdmin", () => {
  beforeEach(() => {
    process.env.ADMIN_API_KEY = "secret-admin-key";
    vi.clearAllMocks();
  });
  afterEach(() => {
    delete process.env.ADMIN_API_KEY;
  });

  it("returns true for matching key", () => {
    vi.mocked(timingSafeEqual).mockReturnValue(true);
    const result = authenticateAdmin("Bearer secret-admin-key");
    expect(result).toBe(true);
    expect(timingSafeEqual).toHaveBeenCalledWith(
      "secret-admin-key",
      "secret-admin-key",
    );
  });

  it("returns false for wrong key", () => {
    vi.mocked(timingSafeEqual).mockReturnValue(false);
    const result = authenticateAdmin("Bearer wrong-key");
    expect(result).toBe(false);
  });

  it("returns false when ADMIN_API_KEY not set", () => {
    delete process.env.ADMIN_API_KEY;
    const result = authenticateAdmin("Bearer some-key");
    expect(result).toBe(false);
  });

  it("returns false for null header", () => {
    const result = authenticateAdmin(null);
    expect(result).toBe(false);
  });

  it("returns false for non-Bearer header", () => {
    const result = authenticateAdmin("Basic secret-admin-key");
    expect(result).toBe(false);
  });
});
