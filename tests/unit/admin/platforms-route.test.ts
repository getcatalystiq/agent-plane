/**
 * Tests for /api/admin/agents/[agentId]/platforms/[platform].
 *
 * Coverage:
 *   - GET unknown agent → uniform 404
 *   - GET cross-tenant agent (existence-leak prevention) → uniform 404
 *   - GET valid → public-shape config
 *   - POST validation error → 400 with platform error verbatim
 *   - POST attestation gate failure → 400 with reason
 *   - DELETE flips enabled and triggers forceRefresh
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { queryOneMock, opsMock, forceRefreshMock } = vi.hoisted(() => ({
  queryOneMock: vi.fn(),
  opsMock: {
    upsertBotConfig: vi.fn(),
    getBotConfig: vi.fn(),
    disableBotConfig: vi.fn(),
  },
  forceRefreshMock: vi.fn(),
}));

vi.mock("@/db", () => ({
  queryOne: queryOneMock,
}));

vi.mock("@/lib/platform/operations", async () => {
  const actual = await vi.importActual<typeof import("@/lib/platform/operations")>(
    "@/lib/platform/operations",
  );
  return {
    ...actual,
    upsertBotConfig: opsMock.upsertBotConfig,
    getBotConfig: opsMock.getBotConfig,
    disableBotConfig: opsMock.disableBotConfig,
  };
});

vi.mock("@/lib/platform/bot", () => ({
  forceRefresh: forceRefreshMock,
}));

import { GET, POST, DELETE } from "@/app/api/admin/agents/[agentId]/platforms/[platform]/route";
import { NextRequest } from "next/server";
import { AttestationGateError, CredentialValidationError } from "@/lib/platform/operations";

function makeContext(agentId: string, platform: string) {
  return { params: Promise.resolve({ agentId, platform }) };
}

function makeRequest(method: string, body?: unknown): NextRequest {
  return new NextRequest("https://example.com/api/admin/agents/a/platforms/discord", {
    method,
    body: body ? JSON.stringify(body) : undefined,
    headers: { "content-type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  queryOneMock.mockReset();
  opsMock.upsertBotConfig.mockReset();
  opsMock.getBotConfig.mockReset();
  opsMock.disableBotConfig.mockReset();
  forceRefreshMock.mockReset();
});

describe("GET /api/admin/agents/:id/platforms/:platform", () => {
  it("returns uniform 404 when agent does not exist", async () => {
    queryOneMock.mockResolvedValueOnce(null);
    const res = await GET(makeRequest("GET"), makeContext("missing", "discord"));
    expect(res.status).toBe(404);
  });

  it("returns uniform 404 when bot config does not exist (no enumeration)", async () => {
    queryOneMock.mockResolvedValueOnce({ id: "agent-1", tenant_id: "tenant-1" });
    opsMock.getBotConfig.mockResolvedValueOnce(null);
    const res = await GET(makeRequest("GET"), makeContext("agent-1", "discord"));
    expect(res.status).toBe(404);
  });

  it("returns the public-shape config when found", async () => {
    queryOneMock.mockResolvedValueOnce({ id: "agent-1", tenant_id: "tenant-1" });
    opsMock.getBotConfig.mockResolvedValueOnce({
      id: "cfg-1",
      tenant_id: "tenant-1",
      agent_id: "agent-1",
      platform: "discord",
      last4: "***x",
      credentials_version: 2,
      platform_identity: {},
      attestations: { private_workspace: true, attested_at: null },
      enabled: true,
      last_event_at: null,
      last_error: null,
      last_connected_at: null,
      created_at: "2026-05-06",
      updated_at: "2026-05-06",
    });
    const res = await GET(makeRequest("GET"), makeContext("agent-1", "discord"));
    expect(res.status).toBe(200);
    const json = (await res.json()) as { config: { credentials_version: number } };
    expect(json.config.credentials_version).toBe(2);
  });

  it("returns 404 on unsupported platform without leaking existence", async () => {
    const res = await GET(makeRequest("GET"), makeContext("agent-1", "zoom"));
    expect(res.status).toBe(404);
  });
});

describe("POST", () => {
  it("returns 400 with platform error verbatim on credential validation failure", async () => {
    queryOneMock.mockResolvedValueOnce({ id: "agent-1", tenant_id: "tenant-1" });
    opsMock.upsertBotConfig.mockRejectedValueOnce(
      new CredentialValidationError({ ok: false, error: { code: "invalid_token", message: "Discord rejected the bot token (HTTP 401)." } }),
    );
    const res = await POST(
      makeRequest("POST", {
        credentials: {
          platform: "discord",
          botToken: "MTI3.fake",
          publicKey: "0".repeat(64),
          applicationId: "12345",
        },
        attestations: { private_workspace: true },
      }),
      makeContext("agent-1", "discord"),
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string; message: string } };
    expect(json.error.code).toBe("invalid_token");
    expect(json.error.message).toContain("HTTP 401");
  });

  it("returns 400 with attestation reason on workspace-too-large", async () => {
    queryOneMock.mockResolvedValueOnce({ id: "agent-1", tenant_id: "tenant-1" });
    opsMock.upsertBotConfig.mockRejectedValueOnce(
      new AttestationGateError("workspace_too_large", "Workspace has 250 members; chat is gated to ≤100."),
    );
    const res = await POST(
      makeRequest("POST", {
        credentials: {
          platform: "discord",
          botToken: "MTI3.fake",
          publicKey: "0".repeat(64),
          applicationId: "12345",
        },
        attestations: { private_workspace: true },
      }),
      makeContext("agent-1", "discord"),
    );
    expect(res.status).toBe(400);
    const json = (await res.json()) as { error: { code: string } };
    expect(json.error.code).toBe("workspace_too_large");
  });

  it("returns 400 when credentials.platform mismatches URL", async () => {
    queryOneMock.mockResolvedValueOnce({ id: "agent-1", tenant_id: "tenant-1" });
    const res = await POST(
      makeRequest("POST", {
        credentials: {
          platform: "slack",
          botToken: "xoxb-x",
          signingSecret: "0".repeat(32),
        },
        attestations: { private_workspace: true },
      }),
      makeContext("agent-1", "discord"),
    );
    expect(res.status).toBe(400);
  });
});

describe("DELETE", () => {
  it("flips enabled and force-refreshes the bot cache", async () => {
    queryOneMock.mockResolvedValueOnce({ id: "agent-1", tenant_id: "tenant-1" });
    opsMock.disableBotConfig.mockResolvedValueOnce({ id: "cfg", enabled: false });
    forceRefreshMock.mockResolvedValueOnce(undefined);
    const res = await DELETE(makeRequest("DELETE"), makeContext("agent-1", "discord"));
    expect(res.status).toBe(200);
    expect(forceRefreshMock).toHaveBeenCalledOnce();
  });

  it("returns 404 when no config exists to disable", async () => {
    queryOneMock.mockResolvedValueOnce({ id: "agent-1", tenant_id: "tenant-1" });
    opsMock.disableBotConfig.mockResolvedValueOnce(null);
    const res = await DELETE(makeRequest("DELETE"), makeContext("agent-1", "discord"));
    expect(res.status).toBe(404);
  });
});
