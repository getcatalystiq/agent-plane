import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WebhookSourceRow, PublicWebhookSourceRow } from "@/lib/webhooks";

const mocks = vi.hoisted(() => ({
  authenticateApiKey: vi.fn(),
  createWebhookSource: vi.fn(),
  listWebhookSources: vi.fn(),
  getWebhookSource: vi.fn(),
  updateWebhookSource: vi.fn(),
  deleteWebhookSource: vi.fn(),
  rotateSecret: vi.fn(),
}));

vi.mock("@/lib/auth", () => ({ authenticateApiKey: mocks.authenticateApiKey }));

vi.mock("@/lib/webhooks", async () => {
  const actual = await vi.importActual<typeof import("@/lib/webhooks")>("@/lib/webhooks");
  return {
    ...actual,
    createWebhookSource: mocks.createWebhookSource,
    listWebhookSources: mocks.listWebhookSources,
    getWebhookSource: mocks.getWebhookSource,
    updateWebhookSource: mocks.updateWebhookSource,
    deleteWebhookSource: mocks.deleteWebhookSource,
    rotateSecret: mocks.rotateSecret,
  };
});

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { POST as collectionPost, GET as collectionGet } from "@/app/api/webhooks/route";
import {
  GET as itemGet,
  PATCH as itemPatch,
  DELETE as itemDelete,
} from "@/app/api/webhooks/[sourceId]/route";
import { POST as rotatePost } from "@/app/api/webhooks/[sourceId]/rotate/route";

const TENANT_ID = "22222222-2222-4222-8222-222222222222";
const AGENT_ID = "33333333-3333-4333-8333-333333333333";
const SOURCE_ID = "11111111-1111-4111-8111-111111111111";

function fakeSource(overrides: Partial<WebhookSourceRow> = {}): WebhookSourceRow {
  return {
    id: SOURCE_ID,
    tenant_id: TENANT_ID,
    agent_id: AGENT_ID,
    name: "github",
    enabled: true,
    signature_header: "X-AgentPlane-Signature",
    signature_format: "sha256_hex",
    secret_enc: "{}",
    previous_secret_enc: null,
    previous_secret_expires_at: null,
    prompt_template: "Event: {{payload}}",
    last_triggered_at: null,
    filter_rules: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function publicSource(overrides: Partial<PublicWebhookSourceRow> = {}): PublicWebhookSourceRow {
  return {
    id: SOURCE_ID,
    tenant_id: TENANT_ID,
    agent_id: AGENT_ID,
    name: "github",
    enabled: true,
    signature_header: "X-AgentPlane-Signature",
    signature_format: "sha256_hex",
    prompt_template: "Event: {{payload}}",
    last_triggered_at: null,
    filter_rules: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function postRequest(url: string, body: unknown, method = "POST"): import("next/server").NextRequest {
  return new Request(url, {
    method,
    headers: { "content-type": "application/json", authorization: "Bearer ap_live_test" },
    body: body ? JSON.stringify(body) : undefined,
  }) as unknown as import("next/server").NextRequest;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.authenticateApiKey.mockResolvedValue({
    tenantId: TENANT_ID,
    apiKeyId: "key-1",
    apiKeyName: "test",
  });
});

describe("POST /api/webhooks", () => {
  it("returns 201 with the plaintext secret on create", async () => {
    mocks.createWebhookSource.mockResolvedValueOnce({
      source: fakeSource(),
      secret: "whsec_revealed_once",
    });
    const req = postRequest("https://app.example.com/api/webhooks", {
      agent_id: AGENT_ID,
      name: "github",
      prompt_template: "Event: {{payload}}",
    });
    const res = await collectionPost(req);
    expect(res.status).toBe(201);
    const body = await res.json();
    expect(body.secret).toBe("whsec_revealed_once");
    expect(body).not.toHaveProperty("secret_enc");
    expect(body).not.toHaveProperty("previous_secret_enc");
  });

  it("creates with filter_rules forwarded to lib", async () => {
    const rules = {
      combinator: "AND",
      conditions: [
        { keyPath: "data.action", operator: "equals", value: "create" },
      ],
    };
    mocks.createWebhookSource.mockResolvedValueOnce({
      source: fakeSource({ filter_rules: rules as never }),
      secret: "whsec_x",
    });
    const req = postRequest("https://app.example.com/api/webhooks", {
      agent_id: AGENT_ID,
      name: "linear-create-only",
      prompt_template: "Event: {{payload}}",
      filter_rules: rules,
    });
    const res = await collectionPost(req);
    expect(res.status).toBe(201);
    expect(mocks.createWebhookSource).toHaveBeenCalledWith(
      expect.objectContaining({ filterRules: rules }),
    );
  });

  it("creates with filterRules: null when filter_rules omitted", async () => {
    mocks.createWebhookSource.mockResolvedValueOnce({
      source: fakeSource(),
      secret: "whsec_x",
    });
    const req = postRequest("https://app.example.com/api/webhooks", {
      agent_id: AGENT_ID,
      name: "no-filter",
      prompt_template: "Event: {{payload}}",
    });
    const res = await collectionPost(req);
    expect(res.status).toBe(201);
    expect(mocks.createWebhookSource).toHaveBeenCalledWith(
      expect.objectContaining({ filterRules: null }),
    );
  });

  it("returns 400 on invalid input (Zod)", async () => {
    const req = postRequest("https://app.example.com/api/webhooks", {
      agent_id: "not-a-uuid",
      name: "x",
      prompt_template: "y",
    });
    const res = await collectionPost(req);
    expect(res.status).toBe(400);
    expect(mocks.createWebhookSource).not.toHaveBeenCalled();
  });

  it("returns 409 on unique-violation (postgres 23505)", async () => {
    mocks.createWebhookSource.mockRejectedValueOnce(Object.assign(new Error("dup"), { code: "23505" }));
    const req = postRequest("https://app.example.com/api/webhooks", {
      agent_id: AGENT_ID,
      name: "github",
      prompt_template: "Event: {{payload}}",
    });
    const res = await collectionPost(req);
    expect(res.status).toBe(409);
  });
});

describe("GET /api/webhooks", () => {
  it("lists tenant webhooks; supports ?agent_id filter", async () => {
    mocks.listWebhookSources.mockResolvedValueOnce([publicSource()]);
    const req = new Request(
      `https://app.example.com/api/webhooks?agent_id=${AGENT_ID}`,
      { headers: { authorization: "Bearer ap_live_test" } },
    ) as unknown as import("next/server").NextRequest;
    const res = await collectionGet(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data).toHaveLength(1);
    expect(mocks.listWebhookSources).toHaveBeenCalledWith(TENANT_ID, AGENT_ID);
  });
});

describe("GET /api/webhooks/[id]", () => {
  it("returns the source without secret fields", async () => {
    mocks.getWebhookSource.mockResolvedValueOnce(publicSource());
    const req = new Request(`https://app.example.com/api/webhooks/${SOURCE_ID}`, {
      headers: { authorization: "Bearer ap_live_test" },
    }) as unknown as import("next/server").NextRequest;
    const res = await itemGet(req, { params: Promise.resolve({ sourceId: SOURCE_ID }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).not.toHaveProperty("secret_enc");
    expect(body.id).toBe(SOURCE_ID);
  });

  it("returns 404 when source is missing or cross-tenant", async () => {
    mocks.getWebhookSource.mockResolvedValueOnce(null);
    const req = new Request(`https://app.example.com/api/webhooks/${SOURCE_ID}`, {
      headers: { authorization: "Bearer ap_live_test" },
    }) as unknown as import("next/server").NextRequest;
    const res = await itemGet(req, { params: Promise.resolve({ sourceId: SOURCE_ID }) });
    expect(res.status).toBe(404);
  });
});

describe("PATCH /api/webhooks/[id]", () => {
  it("applies partial updates", async () => {
    mocks.updateWebhookSource.mockResolvedValueOnce(publicSource({ enabled: false }));
    const req = postRequest(
      `https://app.example.com/api/webhooks/${SOURCE_ID}`,
      { enabled: false },
      "PATCH",
    );
    const res = await itemPatch(req, { params: Promise.resolve({ sourceId: SOURCE_ID }) });
    expect(res.status).toBe(200);
    expect(mocks.updateWebhookSource).toHaveBeenCalledWith(
      TENANT_ID,
      SOURCE_ID,
      { enabled: false },
    );
  });

  it("accepts filter_rules and forwards to updateWebhookSource", async () => {
    const rules = {
      combinator: "AND",
      conditions: [
        { keyPath: "data.action", operator: "equals", value: "create" },
      ],
    };
    mocks.updateWebhookSource.mockResolvedValueOnce(
      publicSource({ filter_rules: rules as never }),
    );
    const req = postRequest(
      `https://app.example.com/api/webhooks/${SOURCE_ID}`,
      { filter_rules: rules },
      "PATCH",
    );
    const res = await itemPatch(req, { params: Promise.resolve({ sourceId: SOURCE_ID }) });
    expect(res.status).toBe(200);
    expect(mocks.updateWebhookSource).toHaveBeenCalledWith(
      TENANT_ID,
      SOURCE_ID,
      { filter_rules: rules },
    );
  });

  it("accepts filter_rules: null to clear", async () => {
    mocks.updateWebhookSource.mockResolvedValueOnce(publicSource());
    const req = postRequest(
      `https://app.example.com/api/webhooks/${SOURCE_ID}`,
      { filter_rules: null },
      "PATCH",
    );
    const res = await itemPatch(req, { params: Promise.resolve({ sourceId: SOURCE_ID }) });
    expect(res.status).toBe(200);
    expect(mocks.updateWebhookSource).toHaveBeenCalledWith(
      TENANT_ID,
      SOURCE_ID,
      { filter_rules: null },
    );
  });

  it("rejects invalid filter_rules with 400", async () => {
    const req = postRequest(
      `https://app.example.com/api/webhooks/${SOURCE_ID}`,
      {
        filter_rules: {
          combinator: "AND",
          conditions: [
            { keyPath: "data..bad", operator: "equals", value: "x" },
          ],
        },
      },
      "PATCH",
    );
    const res = await itemPatch(req, { params: Promise.resolve({ sourceId: SOURCE_ID }) });
    expect(res.status).toBe(400);
    expect(mocks.updateWebhookSource).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/webhooks/[id]", () => {
  it("returns deleted=true on success", async () => {
    mocks.deleteWebhookSource.mockResolvedValueOnce(true);
    const req = new Request(`https://app.example.com/api/webhooks/${SOURCE_ID}`, {
      method: "DELETE",
      headers: { authorization: "Bearer ap_live_test" },
    }) as unknown as import("next/server").NextRequest;
    const res = await itemDelete(req, { params: Promise.resolve({ sourceId: SOURCE_ID }) });
    expect(res.status).toBe(200);
    expect((await res.json()).deleted).toBe(true);
  });

  it("returns 404 when nothing was deleted", async () => {
    mocks.deleteWebhookSource.mockResolvedValueOnce(false);
    const req = new Request(`https://app.example.com/api/webhooks/${SOURCE_ID}`, {
      method: "DELETE",
      headers: { authorization: "Bearer ap_live_test" },
    }) as unknown as import("next/server").NextRequest;
    const res = await itemDelete(req, { params: Promise.resolve({ sourceId: SOURCE_ID }) });
    expect(res.status).toBe(404);
  });
});

describe("POST /api/webhooks/[id]/rotate", () => {
  it("returns the new secret + rotation expiry", async () => {
    mocks.getWebhookSource.mockResolvedValueOnce(publicSource());
    const expires = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
    mocks.rotateSecret.mockResolvedValueOnce({
      secret: "whsec_new_one",
      previousExpiresAt: expires,
    });
    const req = postRequest(`https://app.example.com/api/webhooks/${SOURCE_ID}/rotate`, {});
    const res = await rotatePost(req, { params: Promise.resolve({ sourceId: SOURCE_ID }) });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.secret).toBe("whsec_new_one");
    expect(body.previous_secret_expires_at).toBe(expires.toISOString());
  });

  it("returns 404 if the source does not belong to the tenant", async () => {
    mocks.getWebhookSource.mockResolvedValueOnce(null);
    const req = postRequest(`https://app.example.com/api/webhooks/${SOURCE_ID}/rotate`, {});
    const res = await rotatePost(req, { params: Promise.resolve({ sourceId: SOURCE_ID }) });
    expect(res.status).toBe(404);
    expect(mocks.rotateSecret).not.toHaveBeenCalled();
  });
});
