import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TenantRuleRow } from "@/lib/webhook-dedupe";

const mocks = vi.hoisted(() => ({
  listTenantRules: vi.fn(),
  getEffectiveRulesForTenant: vi.fn(),
  createTenantRule: vi.fn(),
  updateTenantRule: vi.fn(),
  deleteTenantRule: vi.fn(),
}));

vi.mock("@/lib/webhook-dedupe", async () => {
  const actual = await vi.importActual<typeof import("@/lib/webhook-dedupe")>(
    "@/lib/webhook-dedupe",
  );
  return {
    ...actual,
    listTenantRules: mocks.listTenantRules,
    getEffectiveRulesForTenant: mocks.getEffectiveRulesForTenant,
    createTenantRule: mocks.createTenantRule,
    updateTenantRule: mocks.updateTenantRule,
    deleteTenantRule: mocks.deleteTenantRule,
  };
});

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  GET as collectionGet,
  POST as collectionPost,
} from "@/app/api/admin/dedupe-rules/route";
import {
  PATCH as itemPatch,
  DELETE as itemDelete,
} from "@/app/api/admin/dedupe-rules/[id]/route";

const TENANT_ID = "22222222-2222-4222-8222-222222222222";
const RULE_ID = "11111111-1111-4111-8111-111111111111";

function fakeRule(overrides: Partial<TenantRuleRow> = {}): TenantRuleRow {
  return {
    id: RULE_ID,
    tenant_id: TENANT_ID,
    provider: "linear",
    key_path: "data.url",
    window_seconds: 60,
    enabled: true,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function jsonRequest(
  url: string,
  body: unknown,
  method = "POST",
): import("next/server").NextRequest {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  }) as unknown as import("next/server").NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/admin/dedupe-rules", () => {
  it("returns merged defaults + overrides + effective view", async () => {
    mocks.listTenantRules.mockResolvedValueOnce([]);
    mocks.getEffectiveRulesForTenant.mockResolvedValueOnce({
      linear: {
        keyPath: "data.url",
        windowSeconds: 60,
        enabled: true,
        source: "default",
      },
    });
    const req = new Request(
      `https://app.example.com/api/admin/dedupe-rules?tenant_id=${TENANT_ID}`,
    ) as unknown as import("next/server").NextRequest;
    const res = await collectionGet(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.defaults.linear).toEqual({
      keyPath: "data.url",
      windowSeconds: 60,
      enabled: true,
    });
    expect(body.overrides).toEqual([]);
    expect(body.effective.linear.source).toBe("default");
  });

  it("returns 400 when tenant_id is missing", async () => {
    const req = new Request(
      "https://app.example.com/api/admin/dedupe-rules",
    ) as unknown as import("next/server").NextRequest;
    const res = await collectionGet(req);
    expect(res.status).toBe(400);
  });

  it("includes overrides when the tenant has them", async () => {
    const override = fakeRule({ window_seconds: 120 });
    mocks.listTenantRules.mockResolvedValueOnce([override]);
    mocks.getEffectiveRulesForTenant.mockResolvedValueOnce({
      linear: {
        keyPath: "data.url",
        windowSeconds: 120,
        enabled: true,
        source: "override",
      },
    });
    const req = new Request(
      `https://app.example.com/api/admin/dedupe-rules?tenant_id=${TENANT_ID}`,
    ) as unknown as import("next/server").NextRequest;
    const res = await collectionGet(req);
    const body = await res.json();
    expect(body.overrides).toHaveLength(1);
    expect(body.overrides[0].window_seconds).toBe(120);
    expect(body.effective.linear.source).toBe("override");
  });
});

describe("POST /api/admin/dedupe-rules", () => {
  it("creates a rule and returns 201", async () => {
    mocks.createTenantRule.mockResolvedValueOnce(fakeRule());
    const req = jsonRequest("https://app.example.com/api/admin/dedupe-rules", {
      tenant_id: TENANT_ID,
      provider: "linear",
      key_path: "data.url",
      window_seconds: 60,
    });
    const res = await collectionPost(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.provider).toBe("linear");
    expect(mocks.createTenantRule).toHaveBeenCalledWith(TENANT_ID, {
      provider: "linear",
      keyPath: "data.url",
      windowSeconds: 60,
      enabled: undefined,
    });
  });

  it("returns 400 on invalid key_path", async () => {
    const req = jsonRequest("https://app.example.com/api/admin/dedupe-rules", {
      tenant_id: TENANT_ID,
      provider: "linear",
      key_path: "..bad..path",
      window_seconds: 60,
    });
    const res = await collectionPost(req);
    expect(res.status).toBe(400);
    expect(mocks.createTenantRule).not.toHaveBeenCalled();
  });

  it("returns 400 on out-of-range window_seconds", async () => {
    const req = jsonRequest("https://app.example.com/api/admin/dedupe-rules", {
      tenant_id: TENANT_ID,
      provider: "linear",
      key_path: "data.url",
      window_seconds: 0,
    });
    const res = await collectionPost(req);
    expect(res.status).toBe(400);
  });

  it("returns 400 when tenant_id is missing", async () => {
    const req = jsonRequest("https://app.example.com/api/admin/dedupe-rules", {
      provider: "linear",
      key_path: "data.url",
      window_seconds: 60,
    });
    const res = await collectionPost(req);
    expect(res.status).toBe(400);
  });

  it("returns 409 on duplicate (tenant_id, provider) collision", async () => {
    // Postgres unique-violation surfaces as { code: '23505' }; the route
    // catches that and throws ConflictError → 409.
    mocks.createTenantRule.mockRejectedValueOnce(
      Object.assign(new Error("dup"), { code: "23505" }),
    );
    const req = jsonRequest("https://app.example.com/api/admin/dedupe-rules", {
      tenant_id: TENANT_ID,
      provider: "linear",
      key_path: "data.url",
      window_seconds: 60,
    });
    const res = await collectionPost(req);
    expect(res.status).toBe(409);
  });
});

describe("PATCH /api/admin/dedupe-rules/:id", () => {
  it("updates and returns the row", async () => {
    mocks.updateTenantRule.mockResolvedValueOnce(
      fakeRule({ window_seconds: 90 }),
    );
    const req = jsonRequest(
      `https://app.example.com/api/admin/dedupe-rules/${RULE_ID}`,
      { tenant_id: TENANT_ID, window_seconds: 90 },
      "PATCH",
    );
    const res = await itemPatch(req, {
      params: Promise.resolve({ id: RULE_ID }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.window_seconds).toBe(90);
    expect(mocks.updateTenantRule).toHaveBeenCalledWith(TENANT_ID, RULE_ID, {
      keyPath: undefined,
      windowSeconds: 90,
      enabled: undefined,
    });
  });

  it("returns 404 when the rule does not exist", async () => {
    mocks.updateTenantRule.mockResolvedValueOnce(null);
    const req = jsonRequest(
      `https://app.example.com/api/admin/dedupe-rules/${RULE_ID}`,
      { tenant_id: TENANT_ID, enabled: false },
      "PATCH",
    );
    const res = await itemPatch(req, {
      params: Promise.resolve({ id: RULE_ID }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 when patch is empty (refine fails)", async () => {
    const req = jsonRequest(
      `https://app.example.com/api/admin/dedupe-rules/${RULE_ID}`,
      { tenant_id: TENANT_ID },
      "PATCH",
    );
    const res = await itemPatch(req, {
      params: Promise.resolve({ id: RULE_ID }),
    });
    expect(res.status).toBe(400);
    expect(mocks.updateTenantRule).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/admin/dedupe-rules/:id", () => {
  it("deletes and returns 200", async () => {
    mocks.deleteTenantRule.mockResolvedValueOnce(true);
    const req = new Request(
      `https://app.example.com/api/admin/dedupe-rules/${RULE_ID}?tenant_id=${TENANT_ID}`,
      { method: "DELETE" },
    ) as unknown as import("next/server").NextRequest;
    const res = await itemDelete(req, {
      params: Promise.resolve({ id: RULE_ID }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });
  });

  it("returns 404 when the rule does not exist", async () => {
    mocks.deleteTenantRule.mockResolvedValueOnce(false);
    const req = new Request(
      `https://app.example.com/api/admin/dedupe-rules/${RULE_ID}?tenant_id=${TENANT_ID}`,
      { method: "DELETE" },
    ) as unknown as import("next/server").NextRequest;
    const res = await itemDelete(req, {
      params: Promise.resolve({ id: RULE_ID }),
    });
    expect(res.status).toBe(404);
  });

  it("returns 400 when tenant_id is missing", async () => {
    const req = new Request(
      `https://app.example.com/api/admin/dedupe-rules/${RULE_ID}`,
      { method: "DELETE" },
    ) as unknown as import("next/server").NextRequest;
    const res = await itemDelete(req, {
      params: Promise.resolve({ id: RULE_ID }),
    });
    expect(res.status).toBe(400);
  });
});
