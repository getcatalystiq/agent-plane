import { getOrCreateComposioMcpServer } from "./composio";
import { encrypt } from "./crypto";
import { getEnv } from "./env";
import { execute } from "@/db";
import { logger } from "./logger";
import type { AgentInternal } from "./validation";

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

  if (agent.composio_toolkits.length === 0) {
    return { servers, errors };
  }

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
    if (!mcpConfig) return { servers, errors };

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
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(msg);
    logger.warn(
      "Failed to build Composio MCP config, agent will run without Composio tools",
      { agent_id: agent.id, user_id: tenantId, error: msg },
    );
  }

  return { servers, errors };
}
