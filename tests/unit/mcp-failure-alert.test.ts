import { describe, it, expect, vi, beforeEach } from "vitest";
import type { McpConnectionId, TenantId } from "@/lib/types";

// Mock the DB layer + crypto so markConnectionFailed and getTenantSlackAlertConfig
// can be exercised without a live Postgres.
vi.mock("@/db", () => ({
  query: vi.fn(),
  queryOne: vi.fn(),
  execute: vi.fn().mockResolvedValue({ rowCount: 1 }),
  withTenantTransaction: vi.fn(),
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

// Reference these *after* the mocks above so vi resolves the mocked module.
import { withTenantTransaction } from "@/db";
import {
  markConnectionFailed,
  getTenantSlackAlertConfig,
} from "@/lib/mcp-connections";

describe("markConnectionFailed (transition gate)", () => {
  beforeEach(() => {
    vi.mocked(withTenantTransaction).mockReset();
  });

  it("returns was_active=true when CTE projects (old_status='active')", async () => {
    vi.mocked(withTenantTransaction).mockImplementation(
      async (_tenantId, fn) =>
        fn({
          query: vi.fn(),
          queryOne: vi.fn().mockResolvedValue({ was_active: true }),
          execute: vi.fn(),
        }),
    );

    const result = await markConnectionFailed(
      "conn_active" as McpConnectionId,
      "tenant_acme" as TenantId,
    );
    expect(result).toEqual({ was_active: true });
  });

  it("returns was_active=false when prior status was already 'failed' (idempotent)", async () => {
    vi.mocked(withTenantTransaction).mockImplementation(
      async (_tenantId, fn) =>
        fn({
          query: vi.fn(),
          queryOne: vi.fn().mockResolvedValue({ was_active: false }),
          execute: vi.fn(),
        }),
    );

    const result = await markConnectionFailed(
      "conn_already_failed" as McpConnectionId,
      "tenant_acme" as TenantId,
    );
    expect(result).toEqual({ was_active: false });
  });

  it("returns was_active=false when row does not exist (queryOne returns null)", async () => {
    vi.mocked(withTenantTransaction).mockImplementation(
      async (_tenantId, fn) =>
        fn({
          query: vi.fn(),
          queryOne: vi.fn().mockResolvedValue(null),
          execute: vi.fn(),
        }),
    );

    const result = await markConnectionFailed(
      "conn_missing" as McpConnectionId,
      "tenant_acme" as TenantId,
    );
    expect(result).toEqual({ was_active: false });
  });

  it("uses a CTE that locks the prior row with FOR UPDATE", async () => {
    let executedSql = "";
    vi.mocked(withTenantTransaction).mockImplementation(
      async (_tenantId, fn) =>
        fn({
          query: vi.fn(),
          queryOne: vi.fn(async (_schema: unknown, sql: string) => {
            executedSql = sql;
            return { was_active: true };
          }) as never,
          execute: vi.fn(),
        }),
    );

    await markConnectionFailed(
      "conn1" as McpConnectionId,
      "tenant1" as TenantId,
    );
    expect(executedSql).toMatch(/WITH prev AS/);
    expect(executedSql).toMatch(/FOR UPDATE/);
    expect(executedSql).toMatch(/UPDATE mcp_connections SET status = 'failed'/);
  });
});

describe("getTenantSlackAlertConfig", () => {
  beforeEach(() => {
    vi.mocked(withTenantTransaction).mockReset();
  });

  it("returns null when tenant has no webhook URL", async () => {
    vi.mocked(withTenantTransaction).mockImplementation(
      async (_tenantId, fn) =>
        fn({
          query: vi.fn(),
          queryOne: vi.fn().mockResolvedValue({
            name: "Acme",
            slack_alert_webhook_url_enc: null,
          }),
          execute: vi.fn(),
        }),
    );

    const result = await getTenantSlackAlertConfig(
      "tenant_acme" as TenantId,
    );
    expect(result).toBeNull();
  });

  it("returns null when tenant row is missing", async () => {
    vi.mocked(withTenantTransaction).mockImplementation(
      async (_tenantId, fn) =>
        fn({
          query: vi.fn(),
          queryOne: vi.fn().mockResolvedValue(null),
          execute: vi.fn(),
        }),
    );

    const result = await getTenantSlackAlertConfig(
      "tenant_missing" as TenantId,
    );
    expect(result).toBeNull();
  });

  it("decrypts the URL and returns tenant name + webhook URL", async () => {
    const url =
      "https://hooks.slack.com/services/T01TESTONLY/B01TESTONLY/FAKEnotarealtokenZZZZZZ";
    const enc = JSON.stringify({
      ciphertext: Buffer.from(url).toString("hex"),
    });
    vi.mocked(withTenantTransaction).mockImplementation(
      async (_tenantId, fn) =>
        fn({
          query: vi.fn(),
          queryOne: vi.fn().mockResolvedValue({
            name: "Acme",
            slack_alert_webhook_url_enc: enc,
          }),
          execute: vi.fn(),
        }),
    );

    const result = await getTenantSlackAlertConfig(
      "tenant_acme" as TenantId,
    );
    expect(result).toEqual({ tenantName: "Acme", webhookUrl: url });
  });

  it("returns null on decryption failure (invalid JSON or wrong key)", async () => {
    vi.mocked(withTenantTransaction).mockImplementation(
      async (_tenantId, fn) =>
        fn({
          query: vi.fn(),
          queryOne: vi.fn().mockResolvedValue({
            name: "Acme",
            slack_alert_webhook_url_enc: "not-valid-json",
          }),
          execute: vi.fn(),
        }),
    );

    const result = await getTenantSlackAlertConfig(
      "tenant_acme" as TenantId,
    );
    expect(result).toBeNull();
  });
});
