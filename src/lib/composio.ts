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
  apiKey: string;
  serverId: string;
  serverName: string;
}

/**
 * For each toolkit, determine whether it is a no-auth app or needs an auth
 * config. Returns `noAuthApps` (to pass to `mcp.create`) and `authConfigIds`
 * (one per auth-required toolkit, created lazily).
 */
async function splitToolkitsForMcp(
  client: InstanceType<typeof ComposioClient>,
  toolkits: string[],
): Promise<{ noAuthApps: string[]; authConfigIds: string[] }> {
  const noAuthApps: string[] = [];
  const authConfigIds: string[] = [];

  await Promise.all(
    toolkits.map(async (slug) => {
      const slugLower = slug.toLowerCase();
      try {
        // Fetch toolkit metadata to check no_auth flag.
        // Use the list endpoint since it exposes `no_auth` on each item.
        const response = await client.toolkits.list({ search: slugLower, limit: 10 });
        const toolkit = response.items.find((t) => t.slug === slugLower);

        if (toolkit?.no_auth === true) {
          noAuthApps.push(slugLower);
          return;
        }

        // Auth-required: get or create an auth config for this toolkit
        const authConfigId = await getOrCreateAuthConfig(client, slugLower);
        if (authConfigId) {
          authConfigIds.push(authConfigId);
        } else {
          // Fallback: treat as no_auth so the toolkit is at least present
          logger.warn("Could not get auth config, falling back to no_auth_apps", { slug: slugLower });
          noAuthApps.push(slugLower);
        }
      } catch (err) {
        logger.error("Failed to resolve toolkit auth", {
          slug: slugLower,
          error: err instanceof Error ? err.message : String(err),
        });
        // Fallback to no_auth so the agent isn't blocked entirely
        noAuthApps.push(slugLower);
      }
    }),
  );

  return { noAuthApps, authConfigIds };
}

/**
 * Get an existing auth config for `slug`, or create one if none exists.
 * Returns the auth config ID, or null on error.
 */
async function getOrCreateAuthConfig(
  client: InstanceType<typeof ComposioClient>,
  slug: string,
): Promise<string | null> {
  try {
    // Prefer an already-enabled config for this toolkit
    const existing = await client.authConfigs.list({ toolkit_slug: slug, limit: 10 });
    const enabled = existing.items.find((c) => c.status === "ENABLED") ?? existing.items[0];
    if (enabled) {
      logger.info("Reusing existing auth config", { slug, id: enabled.id });
      return enabled.id;
    }

    const result = await client.authConfigs.create({
      toolkit: { slug },
      auth_config: { type: "use_composio_managed_auth" },
    });

    logger.info("Created Composio auth config", { slug, id: result.auth_config.id });
    return result.auth_config.id;
  } catch (err) {
    logger.error("Failed to get/create auth config", {
      slug,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Get or create a Composio MCP server for the given toolkits.
 * If existingServerId is provided, retrieves the existing server and generates
 * a user-specific URL instead of creating a new one.
 */
export async function getOrCreateComposioMcpServer(
  userId: string,
  toolkits: string[],
  existingServerId?: string | null,
): Promise<ComposioMcpConfig | null> {
  const client = getClient();
  if (!client) return null;

  try {
    let serverId: string;
    let serverName: string;

    if (existingServerId) {
      // Verify the server still exists
      const server = await client.mcp.retrieve(existingServerId);
      serverId = server.id;
      serverName = server.name;
      logger.info("Composio MCP server retrieved", { user_id: userId, server_id: serverId });
    } else {
      // Resolve auth configs before creating the server
      const { noAuthApps, authConfigIds } = await splitToolkitsForMcp(client, toolkits);

      logger.info("Composio toolkit auth split", {
        user_id: userId,
        no_auth_apps: noAuthApps,
        auth_config_ids: authConfigIds,
      });

      // Use a stable name derived from the user ID so we can recover if the DB
      // write fails and we try again (avoid duplicate-name errors).
      const name = `ap-${userId.slice(0, 16)}`;

      // Check if a server with this name already exists (e.g. from a previous
      // run where the DB write failed).
      const existing = await client.mcp.list({ name, limit: 5 });
      const existingByName = existing.items.find((s) => s.name === name);

      let server: { id: string; name: string };
      if (existingByName) {
        server = existingByName;
        logger.info("Composio MCP server recovered by name", {
          user_id: userId,
          server_id: server.id,
          name: server.name,
        });
      } else {
        server = await client.mcp.create({
          name,
          auth_config_ids: authConfigIds,
          managed_auth_via_composio: true,
          no_auth_apps: noAuthApps,
        });
      }
      serverId = server.id;
      serverName = server.name;
      logger.info("Composio MCP server ready", {
        user_id: userId,
        toolkits,
        server_id: serverId,
        name: serverName,
        auth_config_ids: authConfigIds,
        no_auth_apps: noAuthApps,
        recovered: !!existingByName,
      });
    }

    // Generate a user-specific URL for this server
    const urlResponse = await client.mcp.generate.url({
      mcp_server_id: serverId,
      user_ids: [userId],
    });

    const fullUrl = urlResponse.user_ids_url?.[0] || urlResponse.mcp_url;

    // Split the URL into base URL + API key so the key can be stored encrypted.
    const urlObj = new URL(fullUrl);
    const apiKey = urlObj.searchParams.get("apiKey") ?? "";
    urlObj.searchParams.delete("apiKey");
    const cleanUrl = urlObj.toString();

    logger.info("Composio MCP URL generated", {
      user_id: userId,
      server_id: serverId,
      url: cleanUrl.slice(0, 60) + "...",
    });

    return { url: cleanUrl, apiKey, serverId, serverName };
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    const errorStack = err instanceof Error ? err.stack?.slice(0, 500) : undefined;
    logger.error("Composio MCP server setup failed", {
      user_id: userId,
      toolkits,
      existing_server_id: existingServerId,
      error: errorMsg,
      stack: errorStack,
    });
    throw new Error(`Composio MCP setup failed: ${errorMsg}`);
  }
}

// ─── Connector management (admin) ─────────────────────────────────────────────

export type AuthScheme = "OAUTH2" | "OAUTH1" | "API_KEY" | "NO_AUTH" | "OTHER";

export interface ConnectorStatus {
  slug: string;
  name: string;
  logo: string;
  authScheme: AuthScheme;
  authConfigId: string | null;
  connectedAccountId: string | null;
  connectionStatus: string | null; // ACTIVE | INITIATED | FAILED | etc.
}

/**
 * For each toolkit in `slugs`, return its auth scheme and whether the given
 * tenant has an active connected account.
 */
export async function getConnectorStatuses(
  tenantId: string,
  slugs: string[],
): Promise<ConnectorStatus[]> {
  const client = getClient();
  if (!client || slugs.length === 0) return [];

  const results = await Promise.all(
    slugs.map(async (slug): Promise<ConnectorStatus> => {
      const slugLower = slug.toLowerCase();
      try {
        // Toolkit info
        const tkRes = await client.toolkits.list({ search: slugLower, limit: 10 });
        const tk = tkRes.items.find((t) => t.slug === slugLower);

        let authScheme: AuthScheme = "OTHER";
        if (tk?.no_auth) {
          authScheme = "NO_AUTH";
        } else if (tk?.auth_schemes?.includes("API_KEY")) {
          authScheme = "API_KEY";
        } else if (tk?.auth_schemes?.includes("OAUTH2")) {
          authScheme = "OAUTH2";
        } else if (tk?.auth_schemes?.includes("OAUTH1")) {
          authScheme = "OAUTH1";
        }

        // Auth config
        const acRes = await client.authConfigs.list({ toolkit_slug: slugLower, limit: 10 });
        const ac = acRes.items.find((c) => c.status === "ENABLED") ?? acRes.items[0] ?? null;

        // Connected account for this tenant
        const caRes = ac
          ? await client.connectedAccounts.list({
              toolkit_slugs: [slugLower],
              user_ids: [tenantId],
              limit: 5,
            })
          : null;
        const ca = caRes?.items[0] ?? null;

        return {
          slug: slugLower,
          name: tk?.name ?? slug,
          logo: tk?.meta.logo ?? "",
          authScheme,
          authConfigId: ac?.id ?? null,
          connectedAccountId: ca?.id ?? null,
          connectionStatus: ca?.status ?? null,
        };
      } catch (err) {
        logger.error("getConnectorStatuses failed for toolkit", {
          slug: slugLower,
          error: err instanceof Error ? err.message : String(err),
        });
        return {
          slug: slugLower,
          name: slug,
          logo: "",
          authScheme: "OTHER",
          authConfigId: null,
          connectedAccountId: null,
          connectionStatus: null,
        };
      }
    }),
  );

  return results;
}

/**
 * Save an API key for a toolkit by:
 * 1. Getting or creating an auth config with `shared_credentials: { api_key }`
 * 2. Creating a connected account for the tenant linked to that auth config
 */
export async function saveApiKeyConnector(
  tenantId: string,
  slug: string,
  apiKey: string,
): Promise<{ authConfigId: string; connectedAccountId: string }> {
  const client = getClient();
  if (!client) throw new Error("Composio not configured");

  const slugLower = slug.toLowerCase();

  // Get or create auth config with shared credentials
  const acRes = await client.authConfigs.list({ toolkit_slug: slugLower, limit: 10 });
  let authConfigId = (acRes.items.find((c) => c.status === "ENABLED") ?? acRes.items[0])?.id ?? null;

  if (authConfigId) {
    // Update existing config with new shared credentials
    await client.authConfigs.update(authConfigId, {
      type: "custom",
      shared_credentials: { api_key: apiKey },
    });
    logger.info("Updated auth config shared credentials", { slug: slugLower, id: authConfigId });
  } else {
    const created = await client.authConfigs.create({
      toolkit: { slug: slugLower },
      auth_config: {
        type: "use_composio_managed_auth",
        shared_credentials: { api_key: apiKey },
      },
    });
    authConfigId = created.auth_config.id;
    logger.info("Created auth config with shared credentials", { slug: slugLower, id: authConfigId });
  }

  // Create (or reuse) a connected account for this tenant
  const caRes = await client.connectedAccounts.list({
    toolkit_slugs: [slugLower],
    user_ids: [tenantId],
    limit: 5,
  });
  const existingCa = caRes.items[0];
  if (existingCa) {
    logger.info("Reusing existing connected account", { slug: slugLower, id: existingCa.id });
    return { authConfigId, connectedAccountId: existingCa.id };
  }

  const ca = await client.connectedAccounts.create({
    auth_config: { id: authConfigId },
    connection: { user_id: tenantId },
    validate_credentials: true,
  });
  logger.info("Created connected account", { slug: slugLower, id: ca.id });
  return { authConfigId, connectedAccountId: ca.id };
}

/**
 * Initiate an OAuth connection for a toolkit via the Composio SDK.
 * Returns the URL to redirect the user to.
 */
export async function initiateOAuthConnector(
  tenantId: string,
  slug: string,
  callbackUrl: string,
): Promise<{ redirectUrl: string; connectedAccountId: string } | null> {
  const client = getClient();
  if (!client) return null;

  const slugLower = slug.toLowerCase();

  // Ensure auth config exists
  const authConfigId = await getOrCreateAuthConfig(client, slugLower);
  if (!authConfigId) return null;

  const ca = await client.connectedAccounts.create({
    auth_config: { id: authConfigId },
    connection: {
      user_id: tenantId,
      callback_url: callbackUrl,
    },
  });

  const redirectUrl = ca.redirect_url ?? (ca.connectionData as { redirectUrl?: string } | null)?.redirectUrl ?? null;
  if (!redirectUrl) {
    logger.error("No redirect URL from connectedAccounts.create", { slug: slugLower });
    return null;
  }

  return { redirectUrl, connectedAccountId: ca.id };
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
