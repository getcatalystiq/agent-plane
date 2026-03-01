import { NextRequest } from "next/server";
import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { getAgentForTenant } from "@/lib/agents";
import { getAgentConnections, getMcpServer } from "@/lib/mcp-connections";
import { fetchMcpToolList } from "@/lib/mcp-oauth";
import { decrypt } from "@/lib/crypto";
import { getEnv } from "@/lib/env";
import { NotFoundError } from "@/lib/errors";
import type { AgentId, McpServerId, TenantId } from "@/lib/types";

export const dynamic = "force-dynamic";

// In-memory tool list cache (5-min TTL)
const toolCache = new Map<string, { tools: unknown[]; cachedAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

// In-flight deduplication
const inFlight = new Map<string, Promise<unknown[]>>();

export const GET = withErrorHandler(async (request: NextRequest, context) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const { agentId, mcpServerId } = await context!.params;
  const env = getEnv();

  await getAgentForTenant(agentId, auth.tenantId);

  // Find the active connection for this agent-server pair
  const connections = await getAgentConnections(agentId as AgentId, auth.tenantId);
  const connection = connections.find(
    (c) => c.mcp_server_id === mcpServerId && c.status === "active",
  );
  if (!connection) throw new NotFoundError("No active connection found");

  const cacheKey = `${agentId}:${mcpServerId}`;

  // Check cache
  const cached = toolCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return jsonResponse({ data: cached.tools });
  }

  // Deduplicate in-flight requests
  let toolsPromise = inFlight.get(cacheKey);
  if (!toolsPromise) {
    toolsPromise = (async () => {
      const server = await getMcpServer(mcpServerId as McpServerId);
      const mcpUrl = new URL(server.mcp_endpoint_path, server.base_url).toString();

      if (!connection.access_token_enc) {
        throw new Error("Connection has no access token");
      }
      const accessToken = await decrypt(
        JSON.parse(connection.access_token_enc),
        env.ENCRYPTION_KEY,
        env.ENCRYPTION_KEY_PREVIOUS,
      );

      return fetchMcpToolList(mcpUrl, accessToken);
    })();
    inFlight.set(cacheKey, toolsPromise);
    toolsPromise.finally(() => inFlight.delete(cacheKey));
  }

  const tools = await toolsPromise;
  toolCache.set(cacheKey, { tools, cachedAt: Date.now() });

  return jsonResponse({ data: tools });
});
