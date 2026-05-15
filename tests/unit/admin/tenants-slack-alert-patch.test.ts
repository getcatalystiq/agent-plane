/**
 * Tests for PATCH /api/admin/tenants/[tenantId]'s new slack_alert_webhook_url
 * field. Covers the encrypt-on-save, clear-on-empty, and validation paths.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { queryMock, queryOneMock, executeMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  queryOneMock: vi.fn(),
  executeMock: vi.fn().mockResolvedValue({ rowCount: 1 }),
}));

vi.mock("@/db", () => ({
  query: queryMock,
  queryOne: queryOneMock,
  execute: executeMock,
}));

vi.mock("@/lib/crypto", async () => {
  const actual = await vi.importActual<typeof import("@/lib/crypto")>(
    "@/lib/crypto",
  );
  return {
    ...actual,
    encrypt: vi.fn(async (plaintext: string) => ({
      version: 1,
      iv: "00".repeat(12),
      ciphertext: Buffer.from(plaintext).toString("hex"),
    })),
  };
});

vi.mock("@/lib/env", () => ({
  getEnv: () => ({
    ENCRYPTION_KEY: "a".repeat(64),
    ENCRYPTION_KEY_PREVIOUS: undefined,
  }),
}));

vi.mock("@/lib/tenant-auth", () => ({
  invalidateAuthCache: vi.fn(),
}));

vi.mock("@/lib/composio", () => ({
  removeToolkitConnections: vi.fn(),
}));

import { PATCH } from "@/app/api/admin/tenants/[tenantId]/route";
import { NextRequest } from "next/server";

const VALID_URL =
  "https://hooks.slack.com/services/T01TESTONLY/B01TESTONLY/FAKEnotarealtokenZZZZZZ";

const TENANT_ID = "tenant_acme";
const ROUTE_CONTEXT = { params: Promise.resolve({ tenantId: TENANT_ID }) };

function fakePatchRequest(body: Record<string, unknown>): NextRequest {
  return new NextRequest("http://localhost/api/admin/tenants/tenant_acme", {
    method: "PATCH",
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  executeMock.mockClear();
  executeMock.mockResolvedValue({ rowCount: 1 });
  queryOneMock.mockReset();
  queryOneMock.mockResolvedValue({
    id: TENANT_ID,
    name: "Acme",
    slug: "acme",
    settings: {},
    monthly_budget_usd: "100",
    status: "active",
    current_month_spend: "0",
    timezone: "UTC",
    logo_url: null,
    subscription_base_url: null,
    subscription_token_expires_at: null,
    spend_period_start: new Date().toISOString(),
    created_at: new Date().toISOString(),
    has_subscription_token: false,
    has_slack_alert_webhook: true,
  });
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("PATCH /api/admin/tenants/[tenantId] — slack_alert_webhook_url", () => {
  it("happy path: a valid webhook URL is encrypted and saved", async () => {
    const res = await PATCH(
      fakePatchRequest({ slack_alert_webhook_url: VALID_URL }),
      ROUTE_CONTEXT,
    );
    expect(res.status).toBe(200);

    const updateCalls = executeMock.mock.calls.filter((call) =>
      String(call[0]).startsWith("UPDATE tenants"),
    );
    expect(updateCalls.length).toBe(1);
    const [sql, params] = updateCalls[0] as [string, unknown[]];
    expect(sql).toMatch(/slack_alert_webhook_url_enc = \$1/);

    // Param 0 is the encrypted JSON string; tenant_id is the last param
    const encrypted = params[0] as string;
    expect(typeof encrypted).toBe("string");
    const parsed = JSON.parse(encrypted);
    expect(parsed.ciphertext).toBe(Buffer.from(VALID_URL).toString("hex"));
  });

  it("clear path: empty string sets the column to NULL", async () => {
    const res = await PATCH(
      fakePatchRequest({ slack_alert_webhook_url: "" }),
      ROUTE_CONTEXT,
    );
    expect(res.status).toBe(200);

    const updateCalls = executeMock.mock.calls.filter((call) =>
      String(call[0]).startsWith("UPDATE tenants"),
    );
    expect(updateCalls.length).toBe(1);
    const [sql, params] = updateCalls[0] as [string, unknown[]];
    expect(sql).toMatch(/slack_alert_webhook_url_enc = \$1/);
    expect(params[0]).toBeNull();
  });

  it("rejects a non-Slack https URL with 400", async () => {
    const res = await PATCH(
      fakePatchRequest({ slack_alert_webhook_url: "https://example.com/foo" }),
      ROUTE_CONTEXT,
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { message: string } };
    expect(body.error.message).toMatch(/hooks\.slack\.com/);

    const updateCalls = executeMock.mock.calls.filter((call) =>
      String(call[0]).startsWith("UPDATE tenants"),
    );
    expect(updateCalls.length).toBe(0);
  });

  it("rejects http:// with 400", async () => {
    const res = await PATCH(
      fakePatchRequest({
        slack_alert_webhook_url: VALID_URL.replace("https://", "http://"),
      }),
      ROUTE_CONTEXT,
    );
    expect(res.status).toBe(400);
  });

  it("a PATCH that omits the field leaves the column untouched", async () => {
    const res = await PATCH(
      fakePatchRequest({ name: "New Name" }),
      ROUTE_CONTEXT,
    );
    expect(res.status).toBe(200);
    const updateCalls = executeMock.mock.calls.filter((call) =>
      String(call[0]).startsWith("UPDATE tenants"),
    );
    expect(updateCalls.length).toBe(1);
    const sql = updateCalls[0][0] as string;
    expect(sql).not.toMatch(/slack_alert_webhook_url_enc/);
  });
});
