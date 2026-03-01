import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { signMcpOAuthState, verifyMcpOAuthState } from "@/lib/mcp-oauth-state";
import { resetEnvCache } from "@/lib/env";
import type { McpServerId, AgentId, TenantId, McpConnectionId } from "@/lib/types";

const VALID_ENV = {
  DATABASE_URL: "postgresql://localhost/test",
  ENCRYPTION_KEY: "a".repeat(64),
  ADMIN_API_KEY: "admin-key-123",
  AI_GATEWAY_API_KEY: "gateway-key-456",
  NODE_ENV: "test",
};

const testPayload = {
  mcpServerId: "server-1" as McpServerId,
  agentId: "agent-1" as AgentId,
  tenantId: "tenant-1" as TenantId,
  connectionId: "conn-1" as McpConnectionId,
};

describe("MCP OAuth State", () => {
  let savedEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    savedEnv = { ...process.env };
    resetEnvCache();
    Object.assign(process.env, VALID_ENV);
  });

  afterEach(() => {
    for (const key of Object.keys(process.env)) {
      if (!(key in savedEnv)) delete process.env[key];
    }
    Object.assign(process.env, savedEnv);
    resetEnvCache();
    vi.restoreAllMocks();
  });

  it("sign and verify round-trip", async () => {
    const state = await signMcpOAuthState(testPayload);
    const result = await verifyMcpOAuthState(state);

    expect(result).not.toBeNull();
    expect(result!.mcpServerId).toBe(testPayload.mcpServerId);
    expect(result!.agentId).toBe(testPayload.agentId);
    expect(result!.tenantId).toBe(testPayload.tenantId);
    expect(result!.connectionId).toBe(testPayload.connectionId);
  });

  it("produces URL-safe tokens (no +, /, =)", async () => {
    const state = await signMcpOAuthState(testPayload);
    expect(state).not.toMatch(/[+/=]/);
    expect(state).toMatch(/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  });

  it("rejects tampered payload", async () => {
    const state = await signMcpOAuthState(testPayload);
    // Tamper by changing the first character of the payload
    const tampered = (state[0] === "A" ? "B" : "A") + state.slice(1);
    const result = await verifyMcpOAuthState(tampered);
    expect(result).toBeNull();
  });

  it("rejects tampered signature", async () => {
    const state = await signMcpOAuthState(testPayload);
    const [payload, sig] = state.split(".");
    const tampered = `${payload}.${sig[0] === "A" ? "B" : "A"}${sig.slice(1)}`;
    const result = await verifyMcpOAuthState(tampered);
    expect(result).toBeNull();
  });

  it("rejects expired state", async () => {
    // Mock Date.now to produce a state that's already expired
    const now = Date.now();
    vi.spyOn(Date, "now")
      .mockReturnValueOnce(now - 20 * 60 * 1000) // sign time: 20 min ago
      .mockReturnValue(now); // verify time: now

    const state = await signMcpOAuthState(testPayload);
    const result = await verifyMcpOAuthState(state);
    expect(result).toBeNull();
  });

  it("rejects empty string", async () => {
    const result = await verifyMcpOAuthState("");
    expect(result).toBeNull();
  });

  it("rejects state without dot separator", async () => {
    const result = await verifyMcpOAuthState("nodothere");
    expect(result).toBeNull();
  });

  it("rejects completely invalid base64", async () => {
    const result = await verifyMcpOAuthState("!!!.!!!");
    expect(result).toBeNull();
  });
});
