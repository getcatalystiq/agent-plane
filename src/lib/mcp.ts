import { getOrCreateComposioMcpServer } from "./composio";
import { encrypt } from "./crypto";
import { getEnv } from "./env";
import { execute } from "@/db";
import { logger } from "./logger";
import {
  getActiveConnections,
  getMcpServersByIds,
  getOrRefreshToken,
  markConnectionFailed,
} from "./mcp-connections";
import type { AgentInternal } from "./validation";
import type { AgentId, TenantId, McpServerId, McpConnectionId } from "./types";

export interface McpServerConfig {
  type: "http";
  url: string;
  headers?: Record<string, string>;
}

export interface McpBuildResult {
  servers: Record<string, McpServerConfig>;
  errors: string[];
}

export async function buildMcpConfig(
  agent: AgentInternal,
  tenantId: string,
): Promise<McpBuildResult> {
  const servers: Record<string, McpServerConfig> = {};
  const errors: string[] = [];

  // --- Composio MCP servers ---
  if (agent.composio_toolkits.length > 0) {
    try {
      const env = getEnv();

      // Always call getOrCreateComposioMcpServer so the Composio server is kept
      // in sync with the current toolkit list (e.g. newly added toolkits are
      // picked up on every run rather than only on first-time setup).
      const mcpConfig = await getOrCreateComposioMcpServer(
        tenantId,
        agent.composio_toolkits,
        agent.composio_mcp_server_id,
        agent.composio_allowed_tools,
      );
      if (mcpConfig) {
        const mcpUrl = mcpConfig.url;
        const mcpApiKey = mcpConfig.apiKey;

        // Persist server info so future runs can update rather than recreate.
        const encData = await encrypt(mcpApiKey, env.ENCRYPTION_KEY);
        await execute(
          `UPDATE agents
           SET composio_mcp_server_id   = $1,
               composio_mcp_server_name = $2,
               composio_mcp_url         = $3,
               composio_mcp_api_key_enc = $4
           WHERE id = $5 AND tenant_id = $6`,
          [
            mcpConfig.serverId,
            mcpConfig.serverName,
            mcpUrl,
            JSON.stringify(encData),
            agent.id,
            tenantId,
          ],
        );

        // Pass API key via headers instead of URL query param to avoid logging leaks
        servers.composio = {
          type: "http",
          url: mcpUrl,
          ...(mcpApiKey ? { headers: { "x-api-key": mcpApiKey } } : {}),
        };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(msg);
      logger.warn(
        "Failed to build Composio MCP config, agent will run without Composio tools",
        { agent_id: agent.id, user_id: tenantId, error: msg },
      );
    }
  }

  // --- Custom MCP server connections ---
  try {
    const connections = await getActiveConnections(
      agent.id as AgentId,
      tenantId as TenantId,
    );

    if (connections.length > 0) {
      const serverIds = connections.map((c) => c.mcp_server_id as McpServerId);
      const mcpServers = await getMcpServersByIds(serverIds);
      const serverMap = new Map(mcpServers.map((s) => [s.id, s]));

      for (const conn of connections) {
        const server = serverMap.get(conn.mcp_server_id);
        if (!server) continue;

        try {
          const accessToken = await getOrRefreshToken(conn, tenantId as TenantId);
          const mcpUrl = new URL(server.mcp_endpoint_path, server.base_url).toString();

          servers[server.slug] = {
            type: "http",
            url: mcpUrl,
            headers: { Authorization: `Bearer ${accessToken}` },
          };
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`MCP server "${server.name}": ${msg}`);
          logger.warn("Failed to build custom MCP config", {
            agent_id: agent.id,
            mcp_server_id: server.id,
            error: msg,
          });
          // Mark the connection as failed so the dashboard shows a warning
          await markConnectionFailed(
            conn.id as McpConnectionId,
            tenantId as TenantId,
          ).catch(() => {});
        }
      }
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(msg);
    logger.warn("Failed to load custom MCP connections", {
      agent_id: agent.id,
      error: msg,
    });
  }

  return { servers, errors };
}
