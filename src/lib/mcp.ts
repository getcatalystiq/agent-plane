import { getOrCreateComposioMcpServer } from "./composio";
import { execute } from "@/db";
import { logger } from "./logger";
import {
  getActiveConnections,
  getMcpServersByIds,
  getOrRefreshToken,
  markConnectionFailed,
} from "./mcp-connections";
import { validatePublicUrl } from "./mcp-oauth";
import type { AgentInternal } from "./validation";
import type { AgentId, TenantId, McpServerId, McpConnectionId } from "./types";

export type McpServerConfig =
  | { type: "http" | "sse"; url: string; headers?: Record<string, string> }
  | { type: "stdio"; command: string; args: string[]; env?: Record<string, string> };

/** Callback credentials from an A2A dispatch, used to inject the MCP bridge. */
export interface CallbackData {
  url: string;
  token: string;
  tools: Array<{ name: string; description: string; parameters: Record<string, unknown> }>;
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
      // Always call getOrCreateComposioMcpServer so the Composio server is kept
      // in sync with the current toolkit list (e.g. newly added toolkits are
      // picked up on every run rather than only on first-time setup).
      // Composio user identity is the agent.id (per-agent isolation): each
      // agent has its own connected_accounts and MCP server in Composio,
      // independent of other agents on the same tenant.
      const mcpConfig = await getOrCreateComposioMcpServer(
        agent.id,
        agent.composio_toolkits,
        agent.composio_mcp_server_id,
        agent.composio_allowed_tools,
        agent.id,
      );
      if (mcpConfig) {
        const mcpUrl = mcpConfig.url;

        // Persist server info so future runs can update rather than recreate.
        await execute(
          `UPDATE agents
           SET composio_mcp_server_id   = $1,
               composio_mcp_server_name = $2,
               composio_mcp_url         = $3
           WHERE id = $4 AND tenant_id = $5`,
          [
            mcpConfig.serverId,
            mcpConfig.serverName,
            mcpUrl,
            agent.id,
            tenantId,
          ],
        );

        // Composio supports streamable HTTP (POST → /mcp); use type "http"
        // which maps to the MCP streamable-HTTP transport in the SDK.
        // Authenticate with the account-level COMPOSIO_API_KEY header.
        const composioApiKey = process.env.COMPOSIO_API_KEY;
        servers.composio = {
          type: "http",
          url: mcpUrl,
          ...(composioApiKey ? { headers: { "x-api-key": composioApiKey } } : {}),
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

      // Refresh tokens + validate URLs in parallel for faster cold starts
      const tokenResults = await Promise.allSettled(
        connections.map(async (conn) => {
          const server = serverMap.get(conn.mcp_server_id);
          if (!server) return null;
          try {
            const mcpUrl = new URL(server.mcp_endpoint_path, server.base_url).toString();
            // Run token refresh and URL validation in parallel
            const [accessToken] = await Promise.all([
              getOrRefreshToken(conn, tenantId as TenantId),
              validatePublicUrl(mcpUrl),
            ]);
            return { conn, server, accessToken, mcpUrl };
          } catch (err) {
            // Re-throw with connection context so we can mark it failed
            throw { conn, server, error: err };
          }
        }),
      );

      for (const result of tokenResults) {
        if (result.status === "fulfilled" && result.value) {
          const { server, accessToken, mcpUrl } = result.value;
          servers[server.slug] = {
            type: "http",
            url: mcpUrl,
            headers: { Authorization: `Bearer ${accessToken}` },
          };
        } else if (result.status === "rejected") {
          const { conn, server, error } = result.reason as {
            conn: typeof connections[0];
            server: typeof mcpServers[0] | undefined;
            error: unknown;
          };
          const msg = error instanceof Error ? error.message : String(error);
          errors.push(`MCP server "${server?.name ?? "unknown"}": ${msg}`);
          logger.warn("Failed to build custom MCP config", {
            agent_id: agent.id,
            mcp_server_id: server?.id,
            error: msg,
          });
          await markConnectionFailed(
            conn.id as McpConnectionId,
            tenantId as TenantId,
          ).catch((markErr) => {
            logger.warn("Failed to mark MCP connection as failed", {
              connection_id: conn.id,
              error: markErr instanceof Error ? markErr.message : String(markErr),
            });
          });
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
