import ComposioClient from "@composio/client";
import { logger } from "./logger";
import type { AuthScheme, TenantConnectorInfo } from "./types";

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

    try {
      const result = await client.authConfigs.create({
        toolkit: { slug },
        auth_config: { type: "use_composio_managed_auth" },
      });
      logger.info("Created Composio auth config", { slug, id: result.auth_config.id });
      return result.auth_config.id;
    } catch (createErr) {
      const msg = createErr instanceof Error ? createErr.message : String(createErr);
      // Composio doesn't have managed credentials for this toolkit (e.g. API_KEY-only services).
      // The admin must supply credentials via the ConnectorsManager UI before this toolkit works.
      if (msg.includes("DefaultAuthConfigNotFound") || msg.includes("managed credentials")) {
        logger.warn("Composio has no managed auth for toolkit — admin must set credentials via UI", { slug });
        return null;
      }
      throw createErr;
    }
  } catch (err) {
    logger.error("Failed to get/create auth config", {
      slug,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Resolve the full allowed_tools whitelist. When some toolkits have explicit
 * tool filters and others don't, fetch all tools for unfiltered toolkits so
 * they aren't inadvertently blocked by the whitelist.
 */
async function resolveAllowedTools(
  client: InstanceType<typeof ComposioClient>,
  toolkits: string[],
  allowedTools?: string[],
): Promise<string[]> {
  if (!allowedTools || allowedTools.length === 0) return [];

  // Determine which toolkits have no explicit filter
  const unfilteredToolkits = toolkits.filter((slug) => {
    const prefix = slug.toUpperCase() + "_";
    return !allowedTools.some((t) => t.startsWith(prefix));
  });

  // All toolkits have explicit filters — use as-is
  if (unfilteredToolkits.length === 0) return allowedTools;

  // Fetch all tools for unfiltered toolkits so they aren't blocked
  const additionalTools: string[] = [];
  await Promise.all(
    unfilteredToolkits.map(async (slug) => {
      const slugLower = slug.toLowerCase();
      try {
        let cursor: string | undefined;
        do {
          const response = await client.tools.list({
            toolkit_slug: slugLower,
            limit: 200,
            important: "false",
            toolkit_versions: "latest",
            ...(cursor ? { cursor } : {}),
          });
          for (const t of response.items) {
            additionalTools.push(t.slug);
          }
          cursor = response.next_cursor ?? undefined;
        } while (cursor);
      } catch (err) {
        logger.warn("Failed to fetch tools for unfiltered toolkit, skipping filter", {
          slug: slugLower,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );

  if (additionalTools.length === 0 && unfilteredToolkits.length > 0) {
    // Could not fetch tools for any unfiltered toolkit — safer to send no
    // whitelist at all than to accidentally block entire toolkits.
    logger.warn("Skipping allowed_tools whitelist — could not resolve unfiltered toolkits", {
      unfiltered: unfilteredToolkits,
    });
    return [];
  }

  return [...allowedTools, ...additionalTools];
}

/**
 * Get or create a Composio MCP server for the given toolkits.
 * If existingServerId is provided, updates the server with the current toolkit
 * list (so newly-added toolkits are picked up) and generates a fresh URL.
 */
export async function getOrCreateComposioMcpServer(
  userId: string,
  toolkits: string[],
  existingServerId?: string | null,
  allowedTools?: string[],
): Promise<ComposioMcpConfig | null> {
  const client = getClient();
  if (!client) return null;

  try {
    // Resolve the full whitelist — fills in all tools for unfiltered toolkits
    // so that a per-toolkit filter doesn't block other toolkits entirely.
    const resolvedAllowedTools = await resolveAllowedTools(client, toolkits, allowedTools);

    let serverId: string;
    let serverName: string;

    if (existingServerId) {
      // Resolve auth configs for the current toolkit list so we can update
      // the server with any newly-added toolkits.
      const { authConfigIds } = await splitToolkitsForMcp(client, toolkits);

      const server = await client.mcp.retrieve(existingServerId);
      serverId = server.id;
      serverName = server.name;

      // Update the server with the current toolkit set so newly-added toolkits
      // are available on this run.
      await client.mcp.update(serverId, {
        auth_config_ids: authConfigIds,
        toolkits: toolkits.map((t) => t.toLowerCase()),
        ...(resolvedAllowedTools.length > 0 ? { allowed_tools: resolvedAllowedTools } : {}),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      logger.info("Composio MCP server updated with current toolkits", {
        user_id: userId,
        server_id: serverId,
        toolkits,
        auth_config_ids: authConfigIds,
        allowed_tools: resolvedAllowedTools,
      });
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
        // Update the existing server with the current auth configs and the
        // full toolkit list so newly-added (or removed) toolkits take effect.
        await client.mcp.update(existingByName.id, {
          auth_config_ids: authConfigIds,
          toolkits: toolkits.map((t) => t.toLowerCase()),
          ...(resolvedAllowedTools.length > 0 ? { allowed_tools: resolvedAllowedTools } : {}),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
        server = existingByName;
        logger.info("Composio MCP server updated and recovered by name", {
          user_id: userId,
          server_id: server.id,
          name: server.name,
          toolkits,
          auth_config_ids: authConfigIds,
          no_auth_apps: noAuthApps,
        });
      } else {
        server = await client.mcp.create({
          name,
          auth_config_ids: authConfigIds,
          managed_auth_via_composio: true,
          no_auth_apps: noAuthApps,
          ...(resolvedAllowedTools.length > 0 ? { allowed_tools: resolvedAllowedTools } : {}),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
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

// ─── Shared discovery helpers (used by both admin and tenant routes) ──────────

export interface ComposioToolkitInfo {
  slug: string;
  name: string;
  logo: string;
}

export interface ComposioToolInfo {
  slug: string;
  name: string;
  description: string;
}

const MAX_TOOL_PAGES = 10;

/** List available Composio toolkits. Shared between admin and tenant routes. */
export async function listComposioToolkits(): Promise<ComposioToolkitInfo[]> {
  const client = getClient();
  if (!client) return [];

  const response = await client.toolkits.list({
    limit: 1000,
    sort_by: "alphabetically",
    include_deprecated: false,
  });

  return response.items.map((t) => ({
    slug: t.slug,
    name: t.name,
    logo: t.meta.logo,
  }));
}

/** List tools in a Composio toolkit. Capped at MAX_TOOL_PAGES pages. */
export async function listComposioTools(toolkit: string): Promise<ComposioToolInfo[]> {
  const client = getClient();
  if (!client) return [];

  const slugLower = toolkit.toLowerCase();
  const allItems: ComposioToolInfo[] = [];
  let cursor: string | undefined;
  let pages = 0;

  do {
    const response = await client.tools.list({
      toolkit_slug: slugLower,
      limit: 200,
      important: "false",
      toolkit_versions: "latest",
      ...(cursor ? { cursor } : {}),
    });
    for (const t of response.items) {
      allItems.push({ slug: t.slug, name: t.name, description: t.description ?? "" });
    }
    cursor = response.next_cursor ?? undefined;
    if (++pages >= MAX_TOOL_PAGES) break;
  } while (cursor);

  return allItems;
}

// ─── Connector management (admin) ─────────────────────────────────────────────

export type { AuthScheme };

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
 * Map internal ConnectorStatus to a tenant-safe response that strips
 * Composio implementation details (auth config IDs, connected account IDs).
 */
export function toTenantConnectorInfo(status: ConnectorStatus): TenantConnectorInfo {
  return {
    slug: status.slug,
    name: status.name,
    logo: status.logo,
    auth_scheme: status.authScheme,
    connected: status.connectionStatus === "ACTIVE",
  };
}

/**
 * Map a raw Composio error message to a safe, generic message for tenants.
 * Never expose internal Composio details (API URLs, config IDs, etc.).
 */
export function sanitizeComposioError(msg: string): string {
  if (msg.includes("duplicate")) return "Connection already exists for this toolkit";
  if (msg.includes("invalid")) return "Invalid API key format";
  if (msg.includes("not found")) return "Toolkit not found";
  return "Failed to save connector — please try again";
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
        } else if (tk?.auth_schemes?.includes("OAUTH2")) {
          authScheme = "OAUTH2";
        } else if (tk?.auth_schemes?.includes("OAUTH1")) {
          authScheme = "OAUTH1";
        } else if (tk?.auth_schemes?.includes("API_KEY")) {
          authScheme = "API_KEY";
        }

        // Connected account for this tenant — auth config ID is read from the
        // connected account itself to avoid leaking another tenant's config ID.
        const caRes = await client.connectedAccounts.list({
          toolkit_slugs: [slugLower],
          user_ids: [tenantId],
          limit: 5,
        });
        const ca = caRes.items[0] ?? null;

        return {
          slug: slugLower,
          name: tk?.name ?? slug,
          logo: tk?.meta.logo ?? "",
          authScheme,
          authConfigId: ca?.auth_config?.id ?? null,
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
 * 1. Looking up the tenant's existing connected account (if any) to find their
 *    specific auth config — never reusing another tenant's auth config.
 * 2. Updating that auth config's credentials, or creating a fresh per-tenant
 *    auth config + connected account if none exists yet.
 *
 * Security: auth configs for API_KEY toolkits are per-tenant. Using a shared
 * auth config would cause the last writer's credentials to apply to all tenants
 * sharing that config.
 */
export async function saveApiKeyConnector(
  tenantId: string,
  slug: string,
  apiKey: string,
): Promise<{ authConfigId: string; connectedAccountId: string }> {
  const client = getClient();
  if (!client) throw new Error("Composio not configured");

  const slugLower = slug.toLowerCase();

  // Check if this tenant already has a connected account for the toolkit.
  // If so, update only the auth config linked to THEIR account — never touch
  // a globally-shared config that could be used by other tenants.
  const existingCaRes = await client.connectedAccounts.list({
    toolkit_slugs: [slugLower],
    user_ids: [tenantId],
    limit: 5,
  });
  const existingCa = existingCaRes.items[0] ?? null;

  if (existingCa) {
    const authConfigId = existingCa.auth_config.id;
    await client.authConfigs.update(authConfigId, {
      type: "custom",
      shared_credentials: { api_key: apiKey },
    });
    logger.info("Updated tenant-scoped auth config shared credentials", {
      slug: slugLower,
      id: authConfigId,
      tenant_id: tenantId,
    });
    return { authConfigId, connectedAccountId: existingCa.id };
  }

  // No existing connection — create a fresh per-tenant auth config.
  // Must use `use_custom_auth` — Composio has no managed credentials for API-key toolkits.
  const created = await client.authConfigs.create({
    toolkit: { slug: slugLower },
    auth_config: {
      type: "use_custom_auth",
      authScheme: "API_KEY",
      shared_credentials: { api_key: apiKey },
    },
  });
  const authConfigId = created.auth_config.id;
  logger.info("Created per-tenant API_KEY auth config", {
    slug: slugLower,
    id: authConfigId,
    tenant_id: tenantId,
  });

  const ca = await client.connectedAccounts.create({
    auth_config: { id: authConfigId },
    connection: { user_id: tenantId },
  });
  logger.info("Created connected account", { slug: slugLower, id: ca.id, tenant_id: tenantId });
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
 * When toolkits are removed from an agent, clean up the Composio resources for
 * the given tenant:
 * 1. Delete connected accounts that belong to this tenant for each removed toolkit.
 * 2. Delete any auth config for the toolkit that now has zero connected accounts
 *    (i.e. no other tenant is using it either).
 */
export async function removeToolkitConnections(
  tenantId: string,
  removedSlugs: string[],
): Promise<void> {
  const client = getClient();
  if (!client || removedSlugs.length === 0) return;

  await Promise.all(
    removedSlugs.map(async (slug) => {
      const slugLower = slug.toLowerCase();
      try {
        // 1. Delete this tenant's connected accounts for the toolkit.
        const caRes = await client.connectedAccounts.list({
          toolkit_slugs: [slugLower],
          user_ids: [tenantId],
          limit: 20,
        });
        await Promise.all(caRes.items.map((ca) => client.connectedAccounts.delete(ca.id)));
        if (caRes.items.length > 0) {
          logger.info("Deleted connected accounts for removed toolkit", {
            tenant_id: tenantId,
            slug: slugLower,
            count: caRes.items.length,
          });
        }

        // 2. Delete auth configs for this toolkit that have no remaining connected accounts.
        const acRes = await client.authConfigs.list({ toolkit_slug: slugLower, limit: 20 });
        await Promise.all(
          acRes.items.map(async (ac) => {
            const remaining = await client.connectedAccounts.list({
              auth_config_ids: [ac.id],
              limit: 1,
            });
            if (remaining.items.length === 0) {
              await client.authConfigs.delete(ac.id);
              logger.info("Deleted orphaned auth config for removed toolkit", {
                slug: slugLower,
                auth_config_id: ac.id,
              });
            }
          }),
        );
      } catch (err) {
        logger.error("Failed to clean up Composio resources for removed toolkit", {
          tenant_id: tenantId,
          slug: slugLower,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }),
  );
}
