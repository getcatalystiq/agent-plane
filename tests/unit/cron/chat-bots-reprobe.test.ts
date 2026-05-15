/**
 * Tests for src/app/api/cron/chat-bots-reprobe/route.ts.
 *
 * Coverage:
 *   - Disable-on-grow: probe.memberCount > threshold → UPDATE enabled=false
 *     + markBotError stamped
 *   - Below threshold: bot stays enabled, no markBotError
 *   - probe.probed=false: log warn, increment probe_failures, bot stays enabled
 *   - SECURITY: SQL must NOT include credentials_enc (mirrors refreshBots invariant)
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { queryMock, withTenantTransactionMock, decryptMock, probeMock, markErrorMock, verifyCronMock } = vi.hoisted(() => ({
  queryMock: vi.fn(),
  withTenantTransactionMock: vi.fn(),
  decryptMock: vi.fn(),
  probeMock: vi.fn(),
  markErrorMock: vi.fn(),
  verifyCronMock: vi.fn(),
}));

vi.mock("@/db", () => ({
  query: queryMock,
  withTenantTransaction: withTenantTransactionMock,
}));
vi.mock("@/lib/cron-auth", () => ({
  verifyCronSecret: verifyCronMock,
}));
vi.mock("@/lib/platform/operations", async () => {
  const actual = await vi.importActual<typeof import("@/lib/platform/operations")>(
    "@/lib/platform/operations",
  );
  return {
    ...actual,
    getDecryptedCredentials: decryptMock,
    markBotError: markErrorMock,
  };
});
vi.mock("@/lib/platform/workspace-probe", () => ({
  probeWorkspaceSize: probeMock,
}));

import { GET } from "@/app/api/cron/chat-bots-reprobe/route";
import { NextRequest } from "next/server";

function makeRequest(): NextRequest {
  return new NextRequest("https://example.com/api/cron/chat-bots-reprobe", {
    method: "GET",
    headers: { authorization: "Bearer test-cron" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  verifyCronMock.mockReturnValue(undefined);
  markErrorMock.mockResolvedValue(undefined);

  // Default mock: withTenantTransaction passes through the callback with
  // a stub tx whose queryOne returns the threshold and whose execute
  // resolves. Specific tests override this.
  withTenantTransactionMock.mockImplementation(async (_, cb) =>
    cb({
      query: vi.fn().mockResolvedValue([]),
      queryOne: vi.fn().mockResolvedValue({ max_trusted_members: 100 }),
      execute: vi.fn().mockResolvedValue({ rowCount: 1 }),
    }),
  );
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("chat-bots-reprobe security: SQL excludes credentials_enc", () => {
  it("the SELECT statement does not reference credentials_enc", async () => {
    queryMock.mockResolvedValueOnce([]);
    await GET(makeRequest());
    const sql = queryMock.mock.calls[0]?.[1] as string;
    expect(sql).not.toMatch(/credentials_enc/i);
    expect(sql).toMatch(/SELECT tenant_id, agent_id, platform, platform_identity/);
  });
});

describe("chat-bots-reprobe disable-on-grow", () => {
  const bot = {
    tenant_id: "00000000-0000-0000-0000-000000000001",
    agent_id: "00000000-0000-0000-0000-000000000002",
    platform: "discord" as const,
    platform_identity: {},
  };

  it("disables the bot and stamps last_error when memberCount > threshold", async () => {
    queryMock.mockResolvedValueOnce([bot]);
    decryptMock.mockResolvedValueOnce({ platform: "discord", botToken: "x", publicKey: "0".repeat(64), applicationId: "1" });
    probeMock.mockResolvedValueOnce({ probed: true, memberCount: 250, label: "Large" });

    const executeSpy = vi.fn().mockResolvedValue({ rowCount: 1 });
    withTenantTransactionMock.mockImplementation(async (_, cb) =>
      cb({
        query: vi.fn(),
        queryOne: vi.fn().mockResolvedValue({ max_trusted_members: 100 }),
        execute: executeSpy,
      }),
    );

    const res = await GET(makeRequest());
    const body = (await res.json()) as { disabled: number; probed: number };
    expect(body.disabled).toBe(1);
    expect(body.probed).toBe(1);

    // UPDATE platform_bot_configs SET enabled=false executed
    expect(executeSpy).toHaveBeenCalled();
    const updateSql = executeSpy.mock.calls[0]?.[0] as string;
    expect(updateSql).toMatch(/UPDATE platform_bot_configs/);
    expect(updateSql).toMatch(/enabled = false/);

    // markBotError called with the workspace-grew message
    expect(markErrorMock).toHaveBeenCalledOnce();
    expect(markErrorMock.mock.calls[0]?.[3] as string).toMatch(/grew to 250/);
  });

  it("keeps the bot enabled when memberCount <= threshold", async () => {
    queryMock.mockResolvedValueOnce([bot]);
    decryptMock.mockResolvedValueOnce({ platform: "discord", botToken: "x", publicKey: "0".repeat(64), applicationId: "1" });
    probeMock.mockResolvedValueOnce({ probed: true, memberCount: 50, label: "Small" });

    const executeSpy = vi.fn().mockResolvedValue({ rowCount: 1 });
    withTenantTransactionMock.mockImplementation(async (_, cb) =>
      cb({
        query: vi.fn(),
        queryOne: vi.fn().mockResolvedValue({ max_trusted_members: 100 }),
        execute: executeSpy,
      }),
    );

    const res = await GET(makeRequest());
    const body = (await res.json()) as { disabled: number };
    expect(body.disabled).toBe(0);

    // No UPDATE, no markBotError
    const updateCalls = executeSpy.mock.calls.filter((c) => /UPDATE/.test(String(c[0])));
    expect(updateCalls.length).toBe(0);
    expect(markErrorMock).not.toHaveBeenCalled();
  });

  it("does NOT disable on transient probe failure (probed:false)", async () => {
    queryMock.mockResolvedValueOnce([bot]);
    decryptMock.mockResolvedValueOnce({ platform: "discord", botToken: "x", publicKey: "0".repeat(64), applicationId: "1" });
    probeMock.mockResolvedValueOnce({ probed: false, reason: "discord_http_500" });

    const res = await GET(makeRequest());
    const body = (await res.json()) as { disabled: number; probe_failures: number };
    expect(body.disabled).toBe(0);
    expect(body.probe_failures).toBe(1);
    expect(markErrorMock).not.toHaveBeenCalled();
  });

  it("rejects without CRON_SECRET (verifyCronSecret throws)", async () => {
    verifyCronMock.mockImplementationOnce(() => {
      const err = new Error("Invalid cron secret") as Error & { name: string };
      err.name = "AuthError";
      throw err;
    });
    const res = await GET(makeRequest());
    // withErrorHandler maps AuthError to 401
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(queryMock).not.toHaveBeenCalled();
  });
});
