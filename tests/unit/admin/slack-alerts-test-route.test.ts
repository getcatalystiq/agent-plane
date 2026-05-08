/**
 * Tests for POST /api/admin/tenants/[tenantId]/slack-alerts/test.
 * Verifies the endpoint surfaces the helper result faithfully and gates
 * on a configured webhook URL.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { queryOneMock } = vi.hoisted(() => ({
  queryOneMock: vi.fn(),
}));

vi.mock("@/db", () => ({
  queryOne: queryOneMock,
}));

vi.mock("@/lib/crypto", async () => {
  const actual = await vi.importActual<typeof import("@/lib/crypto")>(
    "@/lib/crypto",
  );
  return {
    ...actual,
    decrypt: vi.fn(async (data: { ciphertext: string }) =>
      Buffer.from(data.ciphertext, "hex").toString(),
    ),
  };
});

vi.mock("@/lib/env", () => ({
  getEnv: () => ({
    ENCRYPTION_KEY: "a".repeat(64),
    ENCRYPTION_KEY_PREVIOUS: undefined,
  }),
}));

import { POST } from "@/app/api/admin/tenants/[tenantId]/slack-alerts/test/route";
import { NextRequest } from "next/server";

const TENANT_ID = "tenant_acme";
const ROUTE_CONTEXT = { params: Promise.resolve({ tenantId: TENANT_ID }) };
const VALID_URL =
  "https://hooks.slack.com/services/T01TESTONLY/B01TESTONLY/FAKEnotarealtokenZZZZZZ";
const ENCRYPTED_BLOB = JSON.stringify({
  ciphertext: Buffer.from(VALID_URL).toString("hex"),
});

function fakePostRequest(): NextRequest {
  return new NextRequest(
    "http://localhost/api/admin/tenants/tenant_acme/slack-alerts/test",
    { method: "POST" },
  );
}

beforeEach(() => {
  queryOneMock.mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("POST /api/admin/tenants/[tenantId]/slack-alerts/test", () => {
  it("happy path: 200 response when Slack returns 200", async () => {
    queryOneMock.mockResolvedValue({
      name: "Acme",
      slack_alert_webhook_url_enc: ENCRYPTED_BLOB,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 200,
        text: async () => "ok",
      }),
    );

    const res = await POST(fakePostRequest(), ROUTE_CONTEXT);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  it("error path: returns ok:false with status 404 when Slack returns 404", async () => {
    queryOneMock.mockResolvedValue({
      name: "Acme",
      slack_alert_webhook_url_enc: ENCRYPTED_BLOB,
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        status: 404,
        text: async () => "no_service",
      }),
    );

    const res = await POST(fakePostRequest(), ROUTE_CONTEXT);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.status).toBe(404);
  });

  it("returns 400 not_configured when no webhook URL is saved", async () => {
    queryOneMock.mockResolvedValue({
      name: "Acme",
      slack_alert_webhook_url_enc: null,
    });

    const res = await POST(fakePostRequest(), ROUTE_CONTEXT);
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("not_configured");
  });

  it("returns 400 not_configured when tenant row is missing", async () => {
    queryOneMock.mockResolvedValue(null);

    const res = await POST(fakePostRequest(), ROUTE_CONTEXT);
    expect(res.status).toBe(400);
  });

  it("returns ok:false status:'timeout' when AbortSignal.timeout fires", async () => {
    queryOneMock.mockResolvedValue({
      name: "Acme",
      slack_alert_webhook_url_enc: ENCRYPTED_BLOB,
    });
    const timeoutErr = new DOMException(
      "The operation was aborted due to timeout",
      "TimeoutError",
    );
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(timeoutErr));

    const res = await POST(fakePostRequest(), ROUTE_CONTEXT);
    const body = await res.json();
    expect(body.ok).toBe(false);
    expect(body.status).toBe("timeout");
  });
});
