import { NextRequest, NextResponse } from "next/server";
import { withErrorHandler } from "@/lib/api";
import { queryOne } from "@/db";
import { AgentRow } from "@/lib/validation";
import { NotFoundError } from "@/lib/errors";
import { getAgentConnections, getMcpServer } from "@/lib/mcp-connections";
import { fetchMcpToolList } from "@/lib/mcp-oauth";
import { decrypt } from "@/lib/crypto";
import { getEnv } from "@/lib/env";
import type { AgentId, McpServerId, TenantId } from "@/lib/types";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ agentId: string; mcpServerId: string }> };

// In-memory tool list cache (5-min TTL)
const toolCache = new Map<string, { tools: unknown[]; cachedAt: number }>();
const CACHE_TTL_MS = 5 * 60 * 1000;

// In-flight deduplication
const inFlight = new Map<string, Promise<unknown[]>>();

export const GET = withErrorHandler(async (_request: NextRequest, context) => {
  const { agentId, mcpServerId } = await (context as RouteContext).params;
  const env = getEnv();

  const agent = await queryOne(AgentRow, "SELECT * FROM agents WHERE id = $1", [agentId]);
  if (!agent) throw new NotFoundError("Agent not found");

  // Find the active connection for this agent-server pair
  const connections = await getAgentConnections(
    agentId as AgentId,
    agent.tenant_id as TenantId,
  );
  const connection = connections.find(
    (c) => c.mcp_server_id === mcpServerId && c.status === "active",
  );
  if (!connection) throw new NotFoundError("No active connection found");

  const cacheKey = `${agentId}:${mcpServerId}`;

  // Check cache
  const cached = toolCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return NextResponse.json({ data: cached.tools });
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

  return NextResponse.json({ data: tools });
});
