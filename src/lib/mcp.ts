import { createComposioMcpUrl } from "./composio";
import { logger } from "./logger";

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
  agent: { id: string; composio_toolkits: string[] },
  tenantId: string,
): Promise<McpBuildResult> {
  const servers: Record<string, McpServerConfig> = {};
  const errors: string[] = [];

  // Add Composio MCP server if agent has toolkits configured
  if (agent.composio_toolkits.length > 0) {
    try {
      const mcpConfig = await createComposioMcpUrl(tenantId, agent.composio_toolkits);
      if (mcpConfig) {
        servers.composio = {
          type: "http",
          url: mcpConfig.url,
        };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(msg);
      logger.warn("Failed to create Composio MCP URL, agent will run without Composio tools", {
        agent_id: agent.id,
        user_id: tenantId,
        error: msg,
      });
    }
  }

  return { servers, errors };
}
