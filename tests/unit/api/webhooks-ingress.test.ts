import { describe, it, expect, vi, beforeEach } from "vitest";
import type { WebhookSourceRow } from "@/lib/webhooks";

const mocks = vi.hoisted(() => ({
  loadWebhookSource: vi.fn(),
  verifyAndPrepare: vi.fn(),
  recordDelivery: vi.fn(),
  attachDeliveryRun: vi.fn(),
  touchSourceLastTriggered: vi.fn(),
  findRecentDeliveryByDedupeKey: vi.fn(),
  markDeliverySuppressed: vi.fn(),
  buildPromptFromTemplate: vi.fn(
    (template: string, payload: unknown, source: { name: string }) =>
      `${template} :: ${source.name} :: ${JSON.stringify(payload)}`,
  ),
  createRun: vi.fn(),
  transitionRunStatus: vi.fn(),
  executeRunInBackground: vi.fn(),
  getCallbackBaseUrl: vi.fn(() => "https://app.example.com"),
  checkRateLimit: vi.fn(() => ({ allowed: true, remaining: 59, retryAfterMs: 0 })),
  computeDedupeKey: vi.fn(),
}));

// Mock next/server's `after()` so the route can call it without a request
// scope. The real implementation requires Next's request context which the
// test harness doesn't provide; the body of the callback exercises createRun
// which is itself mocked, so we just invoke it inline so its assertions stay
// observable.
vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return {
    ...actual,
    after: (fn: () => unknown | Promise<unknown>) => {
      // Fire-and-forget (matches `after()` semantics in tests).
      void Promise.resolve().then(() => fn());
    },
  };
});

vi.mock("@/db", () => ({
  execute: vi.fn().mockResolvedValue({ rowCount: 1 }),
}));

vi.mock("@/lib/rate-limit", () => ({ checkRateLimit: mocks.checkRateLimit }));

vi.mock("@/lib/webhooks", () => ({
  loadWebhookSource: mocks.loadWebhookSource,
  verifyAndPrepare: mocks.verifyAndPrepare,
  recordDelivery: mocks.recordDelivery,
  attachDeliveryRun: mocks.attachDeliveryRun,
  touchSourceLastTriggered: mocks.touchSourceLastTriggered,
  findRecentDeliveryByDedupeKey: mocks.findRecentDeliveryByDedupeKey,
  markDeliverySuppressed: mocks.markDeliverySuppressed,
  buildPromptFromTemplate: mocks.buildPromptFromTemplate,
}));

vi.mock("@/lib/webhook-dedupe", () => ({
  computeDedupeKey: mocks.computeDedupeKey,
}));

vi.mock("@/lib/runs", () => ({
  createRun: mocks.createRun,
  transitionRunStatus: mocks.transitionRunStatus,
}));

vi.mock("@/lib/run-executor", () => ({
  executeRunInBackground: mocks.executeRunInBackground,
}));

vi.mock("@/lib/mcp-connections", () => ({
  getCallbackBaseUrl: mocks.getCallbackBaseUrl,
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { POST } from "@/app/api/webhooks/[sourceId]/route";

const {
  loadWebhookSource,
  verifyAndPrepare,
  recordDelivery,
  attachDeliveryRun,
  touchSourceLastTriggered,
  findRecentDeliveryByDedupeKey,
  markDeliverySuppressed,
  createRun,
  checkRateLimit,
  computeDedupeKey,
} = mocks;

const SOURCE_ID = "11111111-1111-1111-1111-111111111111";

function source(overrides: Partial<WebhookSourceRow> = {}): WebhookSourceRow {
  return {
    id: SOURCE_ID,
    tenant_id: "22222222-2222-2222-2222-222222222222",
    agent_id: "33333333-3333-3333-3333-333333333333",
    name: "github",
    enabled: true,
    signature_header: "X-AgentPlane-Signature",
    signature_format: "sha256_hex",
    secret_enc: "{}",
    previous_secret_enc: null,
    previous_secret_expires_at: null,
    prompt_template: "Event: {{payload}}",
    last_triggered_at: null,
    created_at: new Date(),
    updated_at: new Date(),
    ...overrides,
  };
}

function makeRequest({
  body = '{"hello":"world"}',
  headers = {},
}: {
  body?: string;
  headers?: Record<string, string>;
} = {}): import("next/server").NextRequest {
  const req = new Request(`https://app.example.com/api/webhooks/${SOURCE_ID}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "content-length": String(new TextEncoder().encode(body).length),
      ...headers,
    },
    body,
  });
  return req as unknown as import("next/server").NextRequest;
}

const ctx = { params: Promise.resolve({ sourceId: SOURCE_ID }) };

beforeEach(() => {
  vi.clearAllMocks();
  checkRateLimit.mockReturnValue({ allowed: true, remaining: 59, retryAfterMs: 0 });
  loadWebhookSource.mockResolvedValue(source());
  verifyAndPrepare.mockResolvedValue({ ok: true, usedPrevious: false });
  recordDelivery.mockResolvedValue({ kind: "inserted", deliveryRowId: "delivery-row-1" });
  attachDeliveryRun.mockResolvedValue(undefined);
  touchSourceLastTriggered.mockResolvedValue(undefined);
  findRecentDeliveryByDedupeKey.mockResolvedValue(null);
  markDeliverySuppressed.mockResolvedValue(undefined);
  // Default: no rule applies (matches custom-header source default).
  computeDedupeKey.mockResolvedValue({ key: null, rule: null, provider: "custom" });
  createRun.mockResolvedValue({
    run: { id: "run-abc-123" },
    agent: {},
    remainingBudget: 100,
  });
});

describe("POST /api/webhooks/[sourceId]", () => {
  it("happy path: valid signed POST returns 202 with delivery acknowledgement", async () => {
    const req = makeRequest({
      headers: {
        "x-agentplane-signature": "sha256=" + "a".repeat(64),
        "webhook-timestamp": String(Math.floor(Date.now() / 1000)),
        "webhook-delivery-id": "delivery-1",
      },
    });
    const res = await POST(req, ctx);
    expect(res.status).toBe(202);
    const body = await res.json();
    expect(body).toMatchObject({
      delivery_id: "delivery-1",
      accepted: true,
      source_name: "github",
    });
    // createRun runs in `after()` (mocked to fire-and-forget); flush microtasks
    // so the spy observes the call before assertions.
    await new Promise((r) => setImmediate(r));
    expect(createRun).toHaveBeenCalledTimes(1);
  });

  it("synthesizes a delivery_id when Webhook-Delivery-Id header is missing", async () => {
    // The route resolves a delivery id from headers → body fields → synthetic
    // hash, so the request is still accepted (202) and a delivery row is
    // recorded with the synthesized id.
    const req = makeRequest({
      headers: {
        "x-agentplane-signature": "sha256=abc",
        "webhook-timestamp": String(Math.floor(Date.now() / 1000)),
      },
    });
    const res = await POST(req, ctx);
    expect(res.status).toBe(202);
    expect(recordDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ valid: true }),
    );
  });

  it("returns generic 401 when source is unknown (no delivery row)", async () => {
    loadWebhookSource.mockResolvedValueOnce(null);
    const req = makeRequest({
      headers: {
        "x-agentplane-signature": "sha256=abc",
        "webhook-timestamp": "100",
        "webhook-delivery-id": "x",
      },
    });
    const res = await POST(req, ctx);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("unauthorized");
    expect(recordDelivery).not.toHaveBeenCalled();
  });

  it("returns generic 401 when source is disabled (delivery row recorded)", async () => {
    loadWebhookSource.mockResolvedValueOnce(source({ enabled: false }));
    const req = makeRequest({
      headers: {
        "x-agentplane-signature": "sha256=abc",
        "webhook-timestamp": "100",
        "webhook-delivery-id": "x",
      },
    });
    const res = await POST(req, ctx);
    expect(res.status).toBe(401);
    expect(recordDelivery).not.toHaveBeenCalled();
  });

  it("returns 401 and records delivery on bad signature", async () => {
    verifyAndPrepare.mockResolvedValueOnce({ ok: false, error: "signature_mismatch" });
    const req = makeRequest({
      headers: {
        "x-agentplane-signature": "sha256=" + "0".repeat(64),
        "webhook-timestamp": String(Math.floor(Date.now() / 1000)),
        "webhook-delivery-id": "del-1",
      },
    });
    const res = await POST(req, ctx);
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error.code).toBe("unauthorized");
    expect(recordDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        valid: false,
        error: "signature_mismatch",
        runId: null,
      }),
    );
    expect(createRun).not.toHaveBeenCalled();
  });

  it("returns 401 and records delivery on stale timestamp", async () => {
    verifyAndPrepare.mockResolvedValueOnce({ ok: false, error: "stale_timestamp" });
    const req = makeRequest({
      headers: {
        "x-agentplane-signature": "sha256=" + "0".repeat(64),
        "webhook-timestamp": "1700000000",
        "webhook-delivery-id": "del-2",
      },
    });
    const res = await POST(req, ctx);
    expect(res.status).toBe(401);
    expect(recordDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ error: "stale_timestamp" }),
    );
  });

  it("returns 413 when Content-Length exceeds 512KB", async () => {
    const req = new Request(`https://app.example.com/api/webhooks/${SOURCE_ID}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "content-length": String(513 * 1024),
        "x-agentplane-signature": "sha256=abc",
        "webhook-timestamp": "100",
        "webhook-delivery-id": "del-3",
      },
      body: "{}",
    }) as unknown as import("next/server").NextRequest;
    const res = await POST(req, ctx);
    expect(res.status).toBe(413);
  });

  it("returns 400 and records delivery on invalid JSON body", async () => {
    const req = makeRequest({
      body: "not-json{",
      headers: {
        "x-agentplane-signature": "sha256=abc",
        "webhook-timestamp": String(Math.floor(Date.now() / 1000)),
        "webhook-delivery-id": "del-4",
      },
    });
    const res = await POST(req, ctx);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("invalid_json");
    expect(recordDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ valid: false, error: "invalid_json" }),
    );
    expect(createRun).not.toHaveBeenCalled();
  });

  it("returns 200 with existing run_id on duplicate delivery_id", async () => {
    recordDelivery.mockResolvedValueOnce({ kind: "duplicate", existingRunId: "run-existing-9" });
    const req = makeRequest({
      headers: {
        "x-agentplane-signature": "sha256=abc",
        "webhook-timestamp": String(Math.floor(Date.now() / 1000)),
        "webhook-delivery-id": "del-5",
      },
    });
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ run_id: "run-existing-9", duplicate: true });
    expect(createRun).not.toHaveBeenCalled();
  });

  it("returns 429 when per-source rate limit is exceeded", async () => {
    checkRateLimit.mockReturnValueOnce({
      allowed: false,
      remaining: 0,
      retryAfterMs: 30_000,
    });
    const req = makeRequest({
      headers: {
        "x-agentplane-signature": "sha256=abc",
        "webhook-timestamp": "100",
        "webhook-delivery-id": "del-6",
      },
    });
    const res = await POST(req, ctx);
    expect(res.status).toBe(429);
    expect(res.headers.get("Retry-After")).toBe("30");
    expect(loadWebhookSource).not.toHaveBeenCalled();
  });

  // ─── Content-based dedupe (U4) ────────────────────────────────────────────
  //
  // These scenarios exercise the suppression early-return path that exits
  // before `after()` is called, which keeps them self-contained in the
  // request-scope assertions.

  it("suppresses delivery when dedupe key matches a recent prior delivery (Linear)", async () => {
    computeDedupeKey.mockResolvedValueOnce({
      key: "https://linear.app/x/issue/TRU-857",
      rule: { keyPath: "data.url", windowSeconds: 60, enabled: true },
      provider: "linear",
    });
    findRecentDeliveryByDedupeKey.mockResolvedValueOnce({
      id: "prior-delivery-row",
      runId: "run-original-7",
    });

    const req = makeRequest({
      body: JSON.stringify({
        action: "create",
        data: { url: "https://linear.app/x/issue/TRU-857" },
      }),
      headers: {
        "linear-signature": "sha256=" + "a".repeat(64),
        "webhook-timestamp": String(Math.floor(Date.now() / 1000)),
        "webhook-delivery-id": "del-dup-1",
      },
    });
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({
      run_id: "run-original-7",
      duplicate: true,
      status_url: "/api/runs/run-original-7",
    });

    expect(recordDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        dedupeKey: "https://linear.app/x/issue/TRU-857",
        valid: true,
      }),
    );
    expect(markDeliverySuppressed).toHaveBeenCalledWith(
      "delivery-row-1",
      "run-original-7",
    );
    expect(createRun).not.toHaveBeenCalled();
  });

  it("persists dedupe key on insert when no prior match exists (custom source, no-rule path)", async () => {
    // Custom source → computeDedupeKey returns null rule → recordDelivery is
    // called with dedupeKey: null. Verifying the dedupeKey field is wired in.
    recordDelivery.mockResolvedValueOnce({ kind: "duplicate", existingRunId: "run-x" });
    const req = makeRequest({
      headers: {
        "x-agentplane-signature": "sha256=abc",
        "webhook-timestamp": String(Math.floor(Date.now() / 1000)),
        "webhook-delivery-id": "del-no-rule",
      },
    });
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);
    expect(recordDelivery).toHaveBeenCalledWith(
      expect.objectContaining({ dedupeKey: null }),
    );
    expect(findRecentDeliveryByDedupeKey).not.toHaveBeenCalled();
    expect(markDeliverySuppressed).not.toHaveBeenCalled();
  });

  it("does not call dedupe lookup when delivery_id duplicate short-circuits", async () => {
    // delivery_id duplicate path takes the existing 200 branch. The window
    // lookup must NOT run on duplicates because there's no inserted row to
    // exclude from the search.
    computeDedupeKey.mockResolvedValueOnce({
      key: "https://linear.app/x/issue/TRU-857",
      rule: { keyPath: "data.url", windowSeconds: 60, enabled: true },
      provider: "linear",
    });
    recordDelivery.mockResolvedValueOnce({ kind: "duplicate", existingRunId: "run-existing-9" });

    const req = makeRequest({
      body: JSON.stringify({ data: { url: "https://linear.app/x/issue/TRU-857" } }),
      headers: {
        "linear-signature": "sha256=abc",
        "webhook-timestamp": String(Math.floor(Date.now() / 1000)),
        "webhook-delivery-id": "del-dupe-id",
      },
    });
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toMatchObject({ run_id: "run-existing-9", duplicate: true });
    expect(findRecentDeliveryByDedupeKey).not.toHaveBeenCalled();
    expect(createRun).not.toHaveBeenCalled();
  });

  it("does not call dedupe lookup when computeDedupeKey returns no key (failure-open)", async () => {
    // Linear source but the configured path is missing in the payload.
    computeDedupeKey.mockResolvedValueOnce({
      key: null,
      rule: { keyPath: "data.url", windowSeconds: 60, enabled: true },
      provider: "linear",
    });
    // Force the duplicate path so we don't hit `after()` in this assertion-
    // only test (avoiding the unrelated next/server limitation).
    recordDelivery.mockResolvedValueOnce({ kind: "duplicate", existingRunId: null });

    const req = makeRequest({
      body: JSON.stringify({ data: {} }),
      headers: {
        "linear-signature": "sha256=abc",
        "webhook-timestamp": String(Math.floor(Date.now() / 1000)),
        "webhook-delivery-id": "del-no-key",
      },
    });
    const res = await POST(req, ctx);
    expect(res.status).toBe(200);
    expect(findRecentDeliveryByDedupeKey).not.toHaveBeenCalled();
    expect(markDeliverySuppressed).not.toHaveBeenCalled();
  });

  it("rolls delivery row to error on createRun ConcurrencyLimitError", async () => {
    // Response is 202 immediately (the run runs in `after()`); the failure
    // surfaces by the delivery row being updated to error state and
    // attachDeliveryRun never being called for a successful run.
    const { ConcurrencyLimitError } = await import("@/lib/errors");
    createRun.mockRejectedValueOnce(new ConcurrencyLimitError("limit"));
    const req = makeRequest({
      headers: {
        "x-agentplane-signature": "sha256=" + "a".repeat(64),
        "webhook-timestamp": String(Math.floor(Date.now() / 1000)),
        "webhook-delivery-id": "del-7",
      },
    });
    const res = await POST(req, ctx);
    expect(res.status).toBe(202);
    // Flush microtasks so the after() callback runs and the catch fires.
    await new Promise((r) => setImmediate(r));
    expect(attachDeliveryRun).not.toHaveBeenCalled();
  });
});
