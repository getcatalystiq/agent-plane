/**
 * Signed OAuth state parameter for MCP server OAuth callbacks.
 *
 * Uses shared HMAC-SHA256 utilities from hmac-state.ts.
 */

import { signState, verifyState } from "./hmac-state";
import type { McpServerId, AgentId, TenantId, McpConnectionId } from "./types";

export interface McpOAuthStatePayload {
  mcpServerId: McpServerId;
  agentId: AgentId;
  tenantId: TenantId;
  connectionId: McpConnectionId;
}

export async function signMcpOAuthState(payload: McpOAuthStatePayload): Promise<string> {
  return signState({
    s: payload.mcpServerId,
    a: payload.agentId,
    t: payload.tenantId,
    c: payload.connectionId,
  });
}

export async function verifyMcpOAuthState(
  state: string,
): Promise<McpOAuthStatePayload | null> {
  const data = await verifyState(state);
  if (!data) return null;
  return {
    mcpServerId: data.s as McpServerId,
    agentId: data.a as AgentId,
    tenantId: data.t as TenantId,
    connectionId: data.c as McpConnectionId,
  };
}
