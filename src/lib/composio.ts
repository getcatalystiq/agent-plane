import ComposioClient from "@composio/client";
import { logger } from "./logger";

let _client: InstanceType<typeof ComposioClient> | null = null;

function getClient(): InstanceType<typeof ComposioClient> | null {
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) {
    logger.warn("COMPOSIO_API_KEY not set");
    return null;
  }
  if (!_client) {
    _client = new ComposioClient({ apiKey });
  }
  return _client;
}

export interface ComposioMcpConfig {
  url: string;
}

/**
 * Create an MCP server in Composio for the given toolkits and generate
 * a user-specific URL the sandbox can connect to.
 */
export async function createComposioMcpUrl(
  userId: string,
  toolkits: string[],
): Promise<ComposioMcpConfig | null> {
  const client = getClient();
  if (!client) return null;

  try {
    // Create an MCP server with managed auth and the requested toolkits
    const server = await client.mcp.create({
      name: `ap-${userId.slice(0, 20)}`,
      auth_config_ids: [],
      managed_auth_via_composio: true,
      no_auth_apps: toolkits.map((t) => t.toLowerCase()),
    });

    // Generate a user-specific URL
    const urlResponse = await client.mcp.generate.url({
      mcp_server_id: server.id,
      user_ids: [userId],
    });

    const mcpUrl = urlResponse.user_ids_url?.[0] || urlResponse.mcp_url;

    logger.info("Composio MCP URL generated", {
      user_id: userId,
      toolkits,
      server_id: server.id,
      url: mcpUrl?.slice(0, 60) + "...",
    });

    return { url: mcpUrl };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const errorStack = err instanceof Error ? err.stack?.slice(0, 500) : undefined;
    logger.error("Composio MCP URL generation failed", {
      user_id: userId,
      toolkits,
      error: errorMsg,
      stack: errorStack,
    });
    // Re-throw so callers can surface the error
    throw new Error(`Composio MCP setup failed: ${errorMsg}`);
  }
}

/**
 * Initiate an OAuth connection for a toolkit via Composio REST API.
 */
export async function initiateOAuthConnection(
  userId: string,
  toolkit: string,
  callbackUrl: string,
): Promise<{ redirectUrl: string; connectionId: string } | null> {
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) return null;

  try {
    const response = await fetch(
      "https://backend.composio.dev/api/v1/connectedAccounts",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": apiKey,
        },
        body: JSON.stringify({
          entityId: userId,
          appName: toolkit.toLowerCase(),
          redirectUri: callbackUrl,
        }),
      },
    );

    if (!response.ok) {
      const text = await response.text();
      logger.error("Composio OAuth initiation failed", {
        status: response.status,
        body: text.slice(0, 500),
        toolkit,
      });
      return null;
    }

    const data = await response.json();
    return {
      redirectUrl: data.redirectUrl,
      connectionId: data.connectedAccountId,
    };
  } catch (err) {
    logger.error("Composio OAuth initiation error", {
      toolkit,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Check the status of a connected account.
 */
export async function getConnectionStatus(
  connectionId: string,
): Promise<{ status: string; toolkit: string } | null> {
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) return null;

  try {
    const response = await fetch(
      `https://backend.composio.dev/api/v1/connectedAccounts/${connectionId}`,
      {
        headers: { "x-api-key": apiKey },
      },
    );

    if (!response.ok) return null;

    const data = await response.json();
    return {
      status: data.status,
      toolkit: data.appUniqueId,
    };
  } catch {
    return null;
  }
}
