import { describe, it, expect, beforeEach, vi } from "vitest";

// Mock the DB layer so resolveEffectiveRule doesn't need a real connection.
const tenantRulesByTenant = new Map<string, Record<string, unknown>>();

vi.mock("@/db", () => ({
  withTenantTransaction: vi.fn(async (tenantId: string, fn: (tx: TxStub) => Promise<unknown>) => {
    const rules = tenantRulesByTenant.get(tenantId) ?? {};
    const rows = Object.entries(rules).map(([provider, r]) => {
      const rule = r as { keyPath: string; windowSeconds: number; enabled: boolean };
      return {
        id: `id-${tenantId}-${provider}`,
        tenant_id: tenantId,
        provider,
        key_path: rule.keyPath,
        window_seconds: rule.windowSeconds,
        enabled: rule.enabled,
        created_at: new Date(),
        updated_at: new Date(),
      };
    });
    const tx: TxStub = {
      query: vi.fn(async (schema: { parse: (x: unknown) => unknown }) =>
        rows.map((r) => schema.parse(r)),
      ),
      queryOne: vi.fn(async () => null),
      execute: vi.fn(async () => ({ rowCount: 0 })),
    };
    return fn(tx);
  }),
}));

interface TxStub {
  query: (schema: { parse: (x: unknown) => unknown }, sql?: string, params?: unknown[]) => Promise<unknown[]>;
  queryOne: () => Promise<unknown>;
  execute: () => Promise<{ rowCount: number }>;
}

import {
  DEDUPE_DEFAULTS,
  extractDedupeKey,
  resolveEffectiveRule,
  computeDedupeKey,
  getEffectiveRulesForTenant,
  invalidateTenantRules,
  clearTenantRuleCache,
  type DedupeRule,
} from "@/lib/webhook-dedupe";

const linearRule: DedupeRule = DEDUPE_DEFAULTS.linear;

beforeEach(() => {
  tenantRulesByTenant.clear();
  clearTenantRuleCache();
});

describe("DEDUPE_DEFAULTS", () => {
  it("ships a Linear default keyed on data.url with a 60s window", () => {
    expect(DEDUPE_DEFAULTS.linear).toEqual({
      keyPath: "data.url",
      windowSeconds: 60,
      enabled: true,
    });
  });
});

describe("extractDedupeKey", () => {
  it("returns the value at a simple dot path", () => {
    const payload = { data: { url: "https://linear.app/x/issue/TRU-857" } };
    expect(extractDedupeKey(linearRule, payload)).toBe(
      "https://linear.app/x/issue/TRU-857",
    );
  });

  it("returns null when the leaf is missing", () => {
    expect(extractDedupeKey(linearRule, { data: {} })).toBeNull();
  });

  it("returns null when an intermediate segment is missing", () => {
    expect(extractDedupeKey(linearRule, {})).toBeNull();
  });

  it("returns null on an empty string value", () => {
    expect(extractDedupeKey(linearRule, { data: { url: "" } })).toBeNull();
  });

  it("returns null on a non-string leaf (number)", () => {
    expect(extractDedupeKey(linearRule, { data: { url: 42 } })).toBeNull();
  });

  it("returns null on a non-string leaf (object)", () => {
    expect(extractDedupeKey(linearRule, { data: { url: {} } })).toBeNull();
  });

  it("returns null on a non-string leaf (array)", () => {
    expect(extractDedupeKey(linearRule, { data: { url: [] } })).toBeNull();
  });

  it("returns null when payload is null", () => {
    expect(extractDedupeKey(linearRule, null)).toBeNull();
  });

  it("returns null when payload is a primitive", () => {
    expect(extractDedupeKey(linearRule, "not an object")).toBeNull();
  });

  it("does not throw when traversing through a primitive mid-path", () => {
    // data is a string, can't be walked into
    expect(extractDedupeKey(linearRule, { data: "string" })).toBeNull();
  });
});

describe("resolveEffectiveRule", () => {
  it("returns the platform default when there is no override", async () => {
    const rule = await resolveEffectiveRule("tenant-a", "linear");
    expect(rule).toEqual(linearRule);
  });

  it("returns the tenant override when one exists", async () => {
    tenantRulesByTenant.set("tenant-a", {
      linear: { keyPath: "data.id", windowSeconds: 120, enabled: true },
    });
    const rule = await resolveEffectiveRule("tenant-a", "linear");
    expect(rule).toEqual({ keyPath: "data.id", windowSeconds: 120, enabled: true });
  });

  it("returns null when the tenant explicitly disables a default", async () => {
    tenantRulesByTenant.set("tenant-a", {
      linear: { keyPath: "data.url", windowSeconds: 60, enabled: false },
    });
    expect(await resolveEffectiveRule("tenant-a", "linear")).toBeNull();
  });

  it("returns the tenant rule for a provider with no platform default", async () => {
    tenantRulesByTenant.set("tenant-a", {
      github: { keyPath: "pull_request.id", windowSeconds: 30, enabled: true },
    });
    const rule = await resolveEffectiveRule("tenant-a", "github");
    expect(rule).toEqual({
      keyPath: "pull_request.id",
      windowSeconds: 30,
      enabled: true,
    });
  });

  it("returns null for an unknown provider with no rule", async () => {
    expect(await resolveEffectiveRule("tenant-a", "custom")).toBeNull();
  });

  it("isolates tenants — A's override does not affect B", async () => {
    tenantRulesByTenant.set("tenant-a", {
      linear: { keyPath: "data.id", windowSeconds: 120, enabled: true },
    });
    expect(await resolveEffectiveRule("tenant-a", "linear")).toEqual({
      keyPath: "data.id",
      windowSeconds: 120,
      enabled: true,
    });
    expect(await resolveEffectiveRule("tenant-b", "linear")).toEqual(linearRule);
  });

  it("re-fetches after invalidateTenantRules", async () => {
    expect(await resolveEffectiveRule("tenant-a", "linear")).toEqual(linearRule);
    tenantRulesByTenant.set("tenant-a", {
      linear: { keyPath: "data.id", windowSeconds: 30, enabled: true },
    });
    // Without invalidation, cache still serves the default.
    expect(await resolveEffectiveRule("tenant-a", "linear")).toEqual(linearRule);
    invalidateTenantRules("tenant-a");
    expect(await resolveEffectiveRule("tenant-a", "linear")).toEqual({
      keyPath: "data.id",
      windowSeconds: 30,
      enabled: true,
    });
  });
});

describe("computeDedupeKey", () => {
  it("derives provider from signature header and extracts the key", async () => {
    const result = await computeDedupeKey("tenant-a", "Linear-Signature", {
      data: { url: "https://linear.app/x" },
    });
    expect(result.provider).toBe("linear");
    expect(result.rule).toEqual(linearRule);
    expect(result.key).toBe("https://linear.app/x");
  });

  it("returns null key when no rule applies for the provider", async () => {
    const result = await computeDedupeKey("tenant-a", "X-Hub-Signature-256", {
      data: { url: "x" },
    });
    expect(result.provider).toBe("github");
    expect(result.rule).toBeNull();
    expect(result.key).toBeNull();
  });

  it("returns null key when payload is missing the configured path", async () => {
    const result = await computeDedupeKey("tenant-a", "Linear-Signature", {});
    expect(result.rule).toEqual(linearRule);
    expect(result.key).toBeNull();
  });

  it("respects tenant override window/keyPath", async () => {
    tenantRulesByTenant.set("tenant-a", {
      linear: { keyPath: "data.id", windowSeconds: 120, enabled: true },
    });
    const result = await computeDedupeKey("tenant-a", "Linear-Signature", {
      data: { id: "abc-123", url: "https://linear.app/x" },
    });
    expect(result.key).toBe("abc-123");
    expect(result.rule?.windowSeconds).toBe(120);
  });
});

describe("getEffectiveRulesForTenant", () => {
  it("returns defaults marked as 'default' when no overrides exist", async () => {
    const rules = await getEffectiveRulesForTenant("tenant-a");
    expect(rules.linear).toEqual({ ...linearRule, source: "default" });
  });

  it("layers overrides on top of defaults with source labels", async () => {
    tenantRulesByTenant.set("tenant-a", {
      linear: { keyPath: "data.id", windowSeconds: 30, enabled: true },
      github: { keyPath: "pull_request.id", windowSeconds: 45, enabled: true },
    });
    const rules = await getEffectiveRulesForTenant("tenant-a");
    expect(rules.linear).toEqual({
      keyPath: "data.id",
      windowSeconds: 30,
      enabled: true,
      source: "override",
    });
    expect(rules.github).toEqual({
      keyPath: "pull_request.id",
      windowSeconds: 45,
      enabled: true,
      source: "override",
    });
  });
});
