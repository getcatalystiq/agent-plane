import ComposioClient from "@composio/client";
import { logger } from "./logger";
import type {
  AuthMethod,
  AuthScheme,
  ConnectionMetadata,
  TenantConnectorInfo,
  WhoamiResult,
} from "./types";

// ─── SDK shape notes (verified against installed @composio/client) ────────────
//
// authConfigs.create body for non-Composio-managed auth:
//   { toolkit: { slug }, auth_config: { type: "use_custom_auth", authScheme,
//     shared_credentials: { [key: string]: unknown }, ... } }
//
// `shared_credentials` is a free-form record; both API_KEY tokens and BYOA OAuth
// client credentials ride on this same field. The published authScheme enum is
// 13 values (OAUTH2, OAUTH1, API_KEY, BEARER_TOKEN, BASIC, BASIC_WITH_JWT,
// BILLCOM_AUTH, GOOGLE_SERVICE_ACCOUNT, NO_AUTH, CALCOM_AUTH, SERVICE_ACCOUNT,
// SAML, DCR_OAUTH). There is no `oauth_app_credentials` field — earlier drafts
// of this plan assumed one and were corrected during deepening.

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
  serverId: string;
  serverName: string;
}

// ─── Auth-config selection (tenant-scoped) ────────────────────────────────────

/**
 * Pick the auth config Composio should use for `slug` on behalf of `tenantId`.
 *
 * Prior behavior was a global "first ENABLED" lookup with no tenant scoping —
 * safe only when every tenant shared a single Composio-managed auth config. Now
 * that BYOA + custom-token paths create per-tenant auth configs, the lookup
 * MUST resolve to the tenant's own config.
 *
 * Resolution order:
 *   1. The auth_config referenced by this tenant's existing connected account
 *      (definitively their own).
 *   2. Create a fresh per-tenant Composio-managed auth config (matches the
 *      previous default for tenants who haven't customized).
 *
 * Returns null only when the toolkit has no managed credentials and no
 * per-tenant override exists yet (e.g., API-only services awaiting setup).
 */
async function getOrCreateAuthConfig(
  client: InstanceType<typeof ComposioClient>,
  tenantId: string,
  slug: string,
): Promise<string | null> {
  try {
    // 1. Pin to the auth config attached to this tenant's connected account.
    //    Authoritative for any auth type (managed OR custom-auth).
    const tenantAccounts = await client.connectedAccounts.list({
      toolkit_slugs: [slug],
      user_ids: [tenantId],
      limit: 1,
    });
    const ownAccount = tenantAccounts.items[0];
    if (ownAccount?.auth_config?.id) {
      return ownAccount.auth_config.id;
    }

    // 2. Tenant has no connection yet. Look for an existing
    //    `use_composio_managed_auth` config to reuse — those carry no
    //    per-tenant secrets (Composio holds the OAuth credentials), so
    //    sharing across tenants is safe and matches pre-rewrite behavior.
    //    `use_custom_auth` configs are explicitly NOT reused — those carry
    //    per-tenant `shared_credentials` and must remain isolated.
    const existing = await client.authConfigs.list({ toolkit_slug: slug, limit: 25 });
    const sharedManaged = existing.items.find((c) => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const type = (c as any).type ?? (c as any).auth_config?.type;
      return c.status === "ENABLED" && type === "use_composio_managed_auth";
    });
    if (sharedManaged?.id) {
      return sharedManaged.id;
    }

    // 3. No reusable managed config — create one. For toolkits Composio
    //    doesn't ship managed credentials for, this fails with a known error
    //    and the caller falls back to no_auth_apps.
    try {
      const result = await client.authConfigs.create({
        toolkit: { slug },
        auth_config: { type: "use_composio_managed_auth" },
      });
      logger.info("Created Composio-managed auth config", {
        tenant_id: tenantId,
        slug,
        id: result.auth_config.id,
      });
      return result.auth_config.id;
    } catch (createErr) {
      const msg = createErr instanceof Error ? createErr.message : String(createErr);
      if (msg.includes("DefaultAuthConfigNotFound") || msg.includes("managed credentials")) {
        // 4a. Existing ENABLED auth_config (any type) — covers cases where
        //     Composio pre-provisions a default we should reuse.
        const fallback = existing.items.find((c) => c.status === "ENABLED");
        if (fallback?.id) {
          logger.info("Using Composio-provided default auth config for toolkit", {
            tenant_id: tenantId,
            slug,
            id: fallback.id,
          });
          return fallback.id;
        }

        // 4b. No managed credentials AND no default config — try a
        //     custom-auth create with the toolkit's reported auth scheme. For
        //     DCR_OAUTH (RFC 7591 dynamic client registration), Composio
        //     handles the dynamic registration server-side without static
        //     credentials; we just need to create an auth_config with the
        //     scheme so connectedAccounts.create has something to reference.
        try {
          const tkRes = await client.toolkits.list({ search: slug, limit: 5 });
          const tk = tkRes.items.find((t) => t.slug === slug);
          const reportedScheme = tk?.auth_schemes?.[0];
          if (reportedScheme) {
            const customResult = await client.authConfigs.create({
              toolkit: { slug },
              auth_config: {
                type: "use_custom_auth",
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                authScheme: reportedScheme as any,
              },
            });
            logger.info("Created custom-auth config for dynamic-registration toolkit", {
              tenant_id: tenantId,
              slug,
              auth_scheme: reportedScheme,
              id: customResult.auth_config.id,
            });
            return customResult.auth_config.id;
          }
        } catch (customErr) {
          logger.warn("Custom-auth fallback also failed", {
            tenant_id: tenantId,
            slug,
            error: customErr instanceof Error ? customErr.message : String(customErr),
          });
        }

        logger.warn("No managed/default/custom auth config available for toolkit", {
          tenant_id: tenantId,
          slug,
        });
        return null;
      }
      throw createErr;
    }
  } catch (err) {
    logger.error("Failed to get/create auth config", {
      tenant_id: tenantId,
      slug,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * For each toolkit, decide whether it's no-auth (passes via `no_auth_apps`) or
 * needs an auth config (resolved tenant-scoped above).
 */
async function splitToolkitsForMcp(
  client: InstanceType<typeof ComposioClient>,
  tenantId: string,
  toolkits: string[],
): Promise<{ noAuthApps: string[]; authConfigIds: string[] }> {
  const noAuthApps: string[] = [];
  const authConfigIds: string[] = [];

  await Promise.all(
    toolkits.map(async (slug) => {
      const slugLower = slug.toLowerCase();
      try {
        const response = await client.toolkits.list({ search: slugLower, limit: 10 });
        const toolkit = response.items.find((t) => t.slug === slugLower);

        if (toolkit?.no_auth === true) {
          noAuthApps.push(slugLower);
          return;
        }

        const authConfigId = await getOrCreateAuthConfig(client, tenantId, slugLower);
        if (authConfigId) {
          authConfigIds.push(authConfigId);
        } else {
          logger.warn("Could not resolve tenant auth config; falling back to no_auth_apps", {
            tenant_id: tenantId,
            slug: slugLower,
          });
          noAuthApps.push(slugLower);
        }
      } catch (err) {
        logger.error("Failed to resolve toolkit auth", {
          tenant_id: tenantId,
          slug: slugLower,
          error: err instanceof Error ? err.message : String(err),
        });
        noAuthApps.push(slugLower);
      }
    }),
  );

  return { noAuthApps, authConfigIds };
}

/**
 * Drop entries whose `<TOOLKIT>_` prefix doesn't match any toolkit in `toolkits`.
 * Used by agent PUT handlers when `composio_toolkits` changes so the persisted
 * `composio_allowed_tools` JSONB doesn't accumulate orphans (e.g. swapping
 * `slack` → `slackbot` would otherwise leave stale `SLACK_*` entries).
 */
export function pruneAllowedToolsForToolkits(
  allowedTools: string[] | null | undefined,
  toolkits: string[],
): string[] {
  if (!allowedTools || allowedTools.length === 0) return [];
  const prefixes = toolkits.map((t) => t.toUpperCase() + "_");
  return allowedTools.filter((tool) => prefixes.some((p) => tool.startsWith(p)));
}

/**
 * Resolve the full allowed_tools whitelist. When some toolkits have explicit
 * tool filters and others don't, fetch all tools for unfiltered toolkits so
 * they aren't inadvertently blocked.
 */
async function resolveAllowedTools(
  client: InstanceType<typeof ComposioClient>,
  toolkits: string[],
  allowedTools?: string[],
): Promise<string[]> {
  if (!allowedTools || allowedTools.length === 0) return [];

  // Drop tools whose prefix doesn't match any current toolkit. Happens when an
  // agent's composio_toolkits changed (e.g. `slack` → `slackbot`) but the
  // saved allowed_tools list still has tools from the removed toolkit. Composio
  // rejects mcp.create with MCP_InvalidToolsProvided in that case.
  const validPrefixes = toolkits.map((t) => t.toUpperCase() + "_");
  const filteredAllowed = allowedTools.filter((tool) =>
    validPrefixes.some((p) => tool.startsWith(p)),
  );
  if (filteredAllowed.length === 0) return [];
  if (filteredAllowed.length !== allowedTools.length) {
    logger.info("Dropped orphaned allowed_tools entries (toolkit no longer configured)", {
      toolkits,
      dropped: allowedTools.filter((t) => !filteredAllowed.includes(t)),
    });
  }
  allowedTools = filteredAllowed;

  const unfilteredToolkits = toolkits.filter((slug) => {
    const prefix = slug.toUpperCase() + "_";
    return !allowedTools.some((t) => t.startsWith(prefix));
  });

  if (unfilteredToolkits.length === 0) return allowedTools;

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
    logger.warn("Skipping allowed_tools whitelist — could not resolve unfiltered toolkits", {
      unfiltered: unfilteredToolkits,
    });
    return [];
  }

  return [...allowedTools, ...additionalTools];
}

/**
 * Get or create a Composio MCP server for the given toolkits. When
 * `existingServerId` is provided, updates the server with the current toolkit
 * list (so newly-added toolkits are picked up) and generates a fresh URL.
 */
export async function getOrCreateComposioMcpServer(
  userId: string,
  toolkits: string[],
  existingServerId?: string | null,
  allowedTools?: string[],
  agentId?: string,
): Promise<ComposioMcpConfig | null> {
  const client = getClient();
  if (!client) return null;

  try {
    const resolvedAllowedTools = await resolveAllowedTools(client, toolkits, allowedTools);

    // Per-agent MCP server name. Composio's MCP server has a single toolkit
    // list at any moment; if multiple agents on the same tenant shared a
    // server, their `mcp.update` calls would race and clobber each other's
    // toolkit configs. We name the server by agent so each agent has its own
    // stable toolkit list. Tenant identity for connected-account routing is
    // still carried by `user_ids` on URL generation below.
    const agentName = agentId ? `ap-${agentId.slice(0, 16)}` : `ap-${userId.slice(0, 16)}`;

    let serverId: string;
    let serverName: string;

    // Treat a stored existingServerId as a hint: only honor it when the
    // server's current name matches the agent-scoped expectation. If a legacy
    // tenant-named server is referenced, fall through to lookup-by-name so we
    // create / pick up the correct agent-scoped server instead of stomping on
    // a server some other agent owns.
    let usableExistingId: string | null = null;
    if (existingServerId) {
      try {
        const peek = await client.mcp.retrieve(existingServerId);
        if (peek.name === agentName) {
          usableExistingId = peek.id;
        } else {
          logger.info("Stored MCP server name doesn't match expected agent-scoped name; recreating", {
            user_id: userId,
            agent_id: agentId,
            stored_server_id: existingServerId,
            stored_name: peek.name,
            expected_name: agentName,
          });
        }
      } catch (err) {
        logger.warn("Failed to retrieve stored Composio MCP server; falling back to lookup-by-name", {
          stored_server_id: existingServerId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    // Retry helper: if Composio rejects allowed_tools (renamed/removed tool
    // slugs we can't predict), drop the filter and run with all toolkit tools.
    // Less restrictive but unblocks the run.
    async function withToolFallback<T>(label: string, fn: (allowed: string[]) => Promise<T>): Promise<T> {
      try {
        return await fn(resolvedAllowedTools);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (resolvedAllowedTools.length > 0 && msg.includes("MCP_InvalidToolsProvided")) {
          logger.warn("Composio rejected allowed_tools; retrying without filter", {
            label,
            user_id: userId,
            agent_id: agentId,
            error: msg.slice(0, 300),
          });
          return await fn([]);
        }
        throw err;
      }
    }

    if (usableExistingId) {
      const { authConfigIds } = await splitToolkitsForMcp(client, userId, toolkits);

      serverId = usableExistingId;
      serverName = agentName;

      await withToolFallback("update-existing", async (allowed) => {
        await client.mcp.update(serverId, {
          auth_config_ids: authConfigIds,
          toolkits: toolkits.map((t) => t.toLowerCase()),
          ...(allowed.length > 0 ? { allowed_tools: allowed } : {}),
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        } as any);
      });
      logger.info("Composio MCP server updated with current toolkits", {
        user_id: userId,
        agent_id: agentId,
        server_id: serverId,
        toolkits,
        auth_config_ids: authConfigIds,
        allowed_tools: resolvedAllowedTools,
      });
    } else {
      const { noAuthApps, authConfigIds } = await splitToolkitsForMcp(client, userId, toolkits);

      logger.info("Composio toolkit auth split", {
        user_id: userId,
        agent_id: agentId,
        no_auth_apps: noAuthApps,
        auth_config_ids: authConfigIds,
      });

      const name = agentName;

      const existing = await client.mcp.list({ name, limit: 5 });
      const existingByName = existing.items.find((s) => s.name === name);

      let server: { id: string; name: string };
      if (existingByName) {
        await withToolFallback("update-by-name", async (allowed) => {
          await client.mcp.update(existingByName.id, {
            auth_config_ids: authConfigIds,
            toolkits: toolkits.map((t) => t.toLowerCase()),
            ...(allowed.length > 0 ? { allowed_tools: allowed } : {}),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any);
        });
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
        server = await withToolFallback("create", async (allowed) =>
          await client.mcp.create({
            name,
            auth_config_ids: authConfigIds,
            managed_auth_via_composio: true,
            no_auth_apps: noAuthApps,
            ...(allowed.length > 0 ? { allowed_tools: allowed } : {}),
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any),
        );
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

    const urlResponse = await client.mcp.generate.url({
      mcp_server_id: serverId,
      user_ids: [userId],
      managed_auth_by_composio: true,
    } as Parameters<typeof client.mcp.generate.url>[0]);

    const fullUrl = urlResponse.user_ids_url?.[0] || urlResponse.mcp_url;

    logger.info("Composio MCP URL generated", {
      user_id: userId,
      server_id: serverId,
      url: fullUrl.slice(0, 80) + "...",
    });

    return { url: fullUrl, serverId, serverName };
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

export type { AuthScheme, AuthMethod, ConnectionMetadata };

export interface ConnectorStatus {
  slug: string;
  name: string;
  logo: string;
  /** All schemes Composio reports for the toolkit. */
  availableSchemes: AuthScheme[];
  /** First reported scheme — used as the today's-priority pick when metadata is empty. */
  primaryScheme: AuthScheme;
  /** @deprecated mirror of `primaryScheme` retained for callers mid-migration. */
  authScheme: AuthScheme;
  authConfigId: string | null;
  connectedAccountId: string | null;
  connectionStatus: string | null; // ACTIVE | INITIATED | FAILED | etc.
  /** Filled in by the route layer from agents.composio_connection_metadata. */
  selectedMethod: AuthMethod | null;
  botUserId: string | null;
  displayName: string | null;
  captureDeferred: boolean;
}

/**
 * Map internal ConnectorStatus to a tenant-safe response. `auth_scheme` is
 * retained as a deprecated mirror of `primaryScheme` for one release so SDK
 * consumers don't break on the field name change.
 */
export function toTenantConnectorInfo(status: ConnectorStatus): TenantConnectorInfo {
  return {
    slug: status.slug,
    name: status.name,
    logo: status.logo,
    auth_scheme: status.primaryScheme,
    available_schemes: status.availableSchemes,
    selected_method: status.selectedMethod,
    bot_user_id: status.botUserId,
    display_name: status.displayName,
    capture_deferred: status.captureDeferred,
    connected: status.connectionStatus === "ACTIVE",
  };
}

/**
 * Map a raw Composio error message to a safe, generic message for tenants.
 * Never expose internal Composio details (API URLs, config IDs, credentials).
 */
export function sanitizeComposioError(msg: string): string {
  if (msg.includes("duplicate")) return "Connection already exists for this toolkit";
  if (msg.includes("invalid")) return "Invalid credentials format";
  if (msg.includes("not found")) return "Toolkit not found";
  return "Failed to save connector — please try again";
}

function normalizeAuthSchemes(schemes: readonly string[] | undefined): AuthScheme[] {
  if (!schemes) return [];
  const known: AuthScheme[] = [
    "OAUTH2", "OAUTH1", "API_KEY", "BEARER_TOKEN", "NO_AUTH", "BASIC",
    "BASIC_WITH_JWT", "BILLCOM_AUTH", "CALCOM_AUTH", "GOOGLE_SERVICE_ACCOUNT",
    "SERVICE_ACCOUNT", "SAML", "DCR_OAUTH",
  ];
  return schemes
    .map((s) => (known.includes(s as AuthScheme) ? (s as AuthScheme) : "OTHER" as AuthScheme))
    .filter((s, i, arr) => arr.indexOf(s) === i);
}

/**
 * For each toolkit in `slugs`, return its available auth schemes plus whether
 * the given tenant has a connected account. The route layer enriches the
 * result with selected_method/bot_user_id from agents.composio_connection_metadata
 * and reconciles drift (metadata entry without an active connection) lazily.
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
        const tkRes = await client.toolkits.list({ search: slugLower, limit: 10 });
        const tk = tkRes.items.find((t) => t.slug === slugLower);

        const availableSchemes: AuthScheme[] = tk?.no_auth
          ? ["NO_AUTH"]
          : normalizeAuthSchemes(tk?.auth_schemes);
        const primaryScheme: AuthScheme = availableSchemes[0] ?? "OTHER";

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
          availableSchemes,
          primaryScheme,
          authScheme: primaryScheme,
          authConfigId: ca?.auth_config?.id ?? null,
          connectedAccountId: ca?.id ?? null,
          connectionStatus: ca?.status ?? null,
          selectedMethod: null,
          botUserId: null,
          displayName: null,
          captureDeferred: false,
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
          availableSchemes: [],
          primaryScheme: "OTHER",
          authScheme: "OTHER",
          authConfigId: null,
          connectedAccountId: null,
          connectionStatus: null,
          selectedMethod: null,
          botUserId: null,
          displayName: null,
          captureDeferred: false,
        };
      }
    }),
  );

  return results;
}

// ─── Custom-auth connector save (API_KEY + BEARER_TOKEN) ──────────────────────

/**
 * Save a long-lived token (API key, bot token, integration token) for a
 * toolkit. Generalizes the earlier saveApiKeyConnector to support any
 * `use_custom_auth` scheme that rides on `shared_credentials`.
 *
 * Per-tenant auth-config scoping is mandatory: each tenant's credentials live
 * in their own auth config. Reusing a shared config would leak credentials.
 */
export async function saveCustomAuthConnector(
  tenantId: string,
  slug: string,
  scheme: "API_KEY" | "BEARER_TOKEN",
  token: string,
): Promise<{ authConfigId: string; connectedAccountId: string }> {
  const client = getClient();
  if (!client) throw new Error("Composio not configured");

  const slugLower = slug.toLowerCase();
  // Composio's standard credential field names for use_custom_auth schemes.
  // `generic_api_key` matches the per-toolkit input form Composio surfaces in
  // its dashboard for API_KEY toolkits.
  const credentialsKey = scheme === "API_KEY" ? "generic_api_key" : "token";

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
      credentials: { [credentialsKey]: token },
    });
    logger.info("Updated tenant-scoped auth config credentials", {
      slug: slugLower,
      id: authConfigId,
      tenant_id: tenantId,
      scheme,
    });
    return { authConfigId, connectedAccountId: existingCa.id };
  }

  const created = await client.authConfigs.create({
    toolkit: { slug: slugLower },
    auth_config: {
      type: "use_custom_auth",
      authScheme: scheme,
      credentials: { [credentialsKey]: token },
    },
  });
  const authConfigId = created.auth_config.id;
  logger.info("Created per-tenant custom-auth config", {
    slug: slugLower,
    id: authConfigId,
    tenant_id: tenantId,
    scheme,
  });

  // Pass the credential on the connection state too: Composio validates
  // required fields at connectedAccounts.create regardless of what's on the
  // parent auth_config. The state shape is a discriminated union by
  // authScheme; `val` accepts arbitrary keys ([k: string]: unknown).
  const ca = await client.connectedAccounts.create({
    auth_config: { id: authConfigId },
    connection: {
      user_id: tenantId,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      state: {
        authScheme: scheme,
        val: { status: "ACTIVE", [credentialsKey]: token },
      } as any,
    },
  });
  logger.info("Created connected account", {
    slug: slugLower,
    id: ca.id,
    tenant_id: tenantId,
  });
  return { authConfigId, connectedAccountId: ca.id };
}

/**
 * @deprecated Use saveCustomAuthConnector with scheme: "API_KEY". Retained as a
 * thin shim for callers that haven't migrated yet.
 */
export async function saveApiKeyConnector(
  tenantId: string,
  slug: string,
  apiKey: string,
): Promise<{ authConfigId: string; connectedAccountId: string }> {
  return saveCustomAuthConnector(tenantId, slug, "API_KEY", apiKey);
}

// ─── OAuth connector flows ────────────────────────────────────────────────────

/**
 * Initiate a Composio-managed OAuth connection. Composio supplies the OAuth
 * client credentials.
 */
export async function initiateOAuthConnector(
  tenantId: string,
  slug: string,
  callbackUrl: string,
): Promise<{ redirectUrl: string; connectedAccountId: string } | null> {
  const client = getClient();
  if (!client) return null;

  const slugLower = slug.toLowerCase();

  const authConfigId = await getOrCreateAuthConfig(client, tenantId, slugLower);
  if (!authConfigId) return null;

  const ca = await client.connectedAccounts.create({
    auth_config: { id: authConfigId },
    connection: {
      user_id: tenantId,
      callback_url: callbackUrl,
    },
  });

  const redirectUrl =
    ca.redirect_url ?? (ca.connectionData as { redirectUrl?: string } | null)?.redirectUrl ?? null;
  if (!redirectUrl) {
    logger.error("No redirect URL from connectedAccounts.create", { slug: slugLower });
    return null;
  }

  return { redirectUrl, connectedAccountId: ca.id };
}

/**
 * Initiate a bring-your-own-app OAuth connection. The tenant supplies their
 * own OAuth `client_id` + `client_secret`, which ride on Composio's
 * `shared_credentials` field. The redirect flow is otherwise identical to the
 * managed path; the callback URL must include the same signed-state token as
 * managed OAuth (CSRF defense).
 */
export async function initiateByoaOAuthConnector(
  tenantId: string,
  slug: string,
  clientId: string,
  clientSecret: string,
  callbackUrl: string,
): Promise<{ redirectUrl: string; connectedAccountId: string } | null> {
  const client = getClient();
  if (!client) return null;

  const slugLower = slug.toLowerCase();

  // Per-toolkit scope overrides for BYOA. Linear's `actor=app` flow rejects
  // the `admin` scope ("App users can't request admin scopes"), and Composio's
  // default Linear auth_config requests it, so we explicitly narrow scopes for
  // Linear here. Other toolkits inherit Composio's defaults (undefined).
  const scopes: string[] | undefined =
    slugLower === "linear"
      ? ["read", "write", "issues:create", "comments:create"]
      : undefined;

  const created = await client.authConfigs.create({
    toolkit: { slug: slugLower },
    auth_config: {
      type: "use_custom_auth",
      authScheme: "OAUTH2",
      // SDK's Credentials type only declares { scopes, user_scopes }, but the
      // runtime API requires credentials.client_id / client_secret for the
      // OAuth2 BYOA flow (Composio API error code 301 / Auth_Config_ValidationError
      // when these are sent under shared_credentials instead). Remove the
      // suppression below once @composio/client SDK types catch up.
      // @ts-expect-error — SDK types lag the runtime API
      credentials: { client_id: clientId, client_secret: clientSecret, ...(scopes ? { scopes } : {}) },
    },
  });
  const authConfigId = created.auth_config.id;
  logger.info("Created per-tenant BYOA OAuth config", {
    slug: slugLower,
    id: authConfigId,
    tenant_id: tenantId,
  });

  const ca = await client.connectedAccounts.create({
    auth_config: { id: authConfigId },
    connection: {
      user_id: tenantId,
      callback_url: callbackUrl,
    },
  });

  const redirectUrl =
    ca.redirect_url ?? (ca.connectionData as { redirectUrl?: string } | null)?.redirectUrl ?? null;
  if (!redirectUrl) {
    logger.error("No redirect URL from BYOA connectedAccounts.create", { slug: slugLower });
    return null;
  }

  return { redirectUrl, connectedAccountId: ca.id };
}

// ─── Connection lifecycle helpers ─────────────────────────────────────────────

/**
 * Poll a connected account until it reaches ACTIVE or the attempt budget is
 * exhausted. Used by OAuth callback handlers to gate whoami capture.
 */
export async function pollConnectedAccountActive(
  connectedAccountId: string,
  opts: { maxAttempts?: number; intervalMs?: number } = {},
): Promise<{ status: string; accessToken: string | null }> {
  const client = getClient();
  if (!client) return { status: "FAILED", accessToken: null };

  const maxAttempts = opts.maxAttempts ?? 10;
  const intervalMs = opts.intervalMs ?? 500;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const ca = await client.connectedAccounts.retrieve(connectedAccountId);
      if (ca.status === "ACTIVE") {
        const accessToken = extractAccessToken(ca);
        return { status: "ACTIVE", accessToken };
      }
      if (ca.status === "FAILED" || ca.status === "EXPIRED") {
        return { status: ca.status, accessToken: null };
      }
    } catch (err) {
      logger.warn("connectedAccounts.retrieve failed during poll", {
        connected_account_id: connectedAccountId,
        attempt,
        error: err instanceof Error ? err.message : String(err),
      });
    }
    if (attempt < maxAttempts - 1) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
    }
  }
  return { status: "INITIATED", accessToken: null };
}

/**
 * Best-effort extract the OAuth access token from a connected account record.
 * Composio stores tokens in different shapes per scheme; we only need the
 * common OAUTH2 path. Returns null when not present.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function extractAccessToken(ca: any): string | null {
  const val = ca?.state?.val;
  if (val && typeof val === "object" && typeof val.access_token === "string") {
    return val.access_token;
  }
  // Some custom-auth schemes nest credentials under `credentials.*` (current
  // Composio API) or the legacy `shared_credentials.*` shape (older response
  // version). Read either — Composio responses can carry either depending on
  // the SDK version that wrote the auth config.
  const shared =
    ca?.auth_config?.credentials ?? ca?.auth_config?.shared_credentials;
  if (shared && typeof shared === "object") {
    const candidate = shared.access_token ?? shared.token ?? shared.api_key;
    if (typeof candidate === "string") return candidate;
  }
  return null;
}

// ─── Whoami dispatch (slack / notion / linear) ────────────────────────────────

type WhoamiHandler = (token: string) => Promise<WhoamiResult | null>;

const WHOAMI_REGISTRY: Record<string, WhoamiHandler> = {
  slack: async (token) => {
    const res = await fetch("https://slack.com/api/auth.test", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    });
    if (!res.ok) {
      logger.warn("slack auth.test non-2xx", { status: res.status });
      return null;
    }
    const body = (await res.json()) as { ok?: boolean; user_id?: string; user?: string };
    if (!body.ok || !body.user_id) return null;
    return { bot_user_id: body.user_id, display_name: body.user ?? body.user_id };
  },
  notion: async (token) => {
    const res = await fetch("https://api.notion.com/v1/users/me", {
      method: "GET",
      headers: {
        Authorization: `Bearer ${token}`,
        "Notion-Version": "2022-06-28",
      },
    });
    if (!res.ok) {
      logger.warn("notion users/me non-2xx", { status: res.status });
      return null;
    }
    const body = (await res.json()) as { id?: string; name?: string };
    if (!body.id) return null;
    return { bot_user_id: body.id, display_name: body.name ?? body.id };
  },
  linear: async (token) => {
    const res = await fetch("https://api.linear.app/graphql", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ query: "query { viewer { id name } }" }),
    });
    if (!res.ok) {
      logger.warn("linear viewer non-2xx", { status: res.status });
      return null;
    }
    const body = (await res.json()) as { data?: { viewer?: { id?: string; name?: string } } };
    const viewer = body.data?.viewer;
    if (!viewer?.id) return null;
    return { bot_user_id: viewer.id, display_name: viewer.name ?? viewer.id };
  },
};

/**
 * Whoami dispatch for token-mode connections (custom_token). The token is
 * passed in directly from saveCustomAuthConnector; nothing is retrieved from
 * Composio. The token is used in a single HTTP call and dropped from scope
 * immediately on return.
 *
 * Best-effort: any failure (unknown slug, HTTP error, missing fields) returns
 * null. The caller writes `bot_user_id: null` to metadata and surfaces a
 * recapture button in the UI.
 */
export async function captureBotUserIdFromToken(
  slug: string,
  token: string,
): Promise<WhoamiResult | null> {
  const handler = WHOAMI_REGISTRY[slug.toLowerCase()];
  if (!handler) return null;
  try {
    return await handler(token);
  } catch (err) {
    logger.warn("captureBotUserIdFromToken failed", {
      slug,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Whoami dispatch for OAuth-mode connections (composio_oauth, byoa_oauth). The
 * caller passes the connected-account ID; we retrieve the access token from
 * Composio, dispatch the per-toolkit whoami, and immediately drop the token.
 */
export async function captureBotUserIdFromConnectedAccount(
  slug: string,
  connectedAccountId: string,
): Promise<WhoamiResult | null> {
  const client = getClient();
  if (!client) return null;
  const handler = WHOAMI_REGISTRY[slug.toLowerCase()];
  if (!handler) return null;

  try {
    const ca = await client.connectedAccounts.retrieve(connectedAccountId);
    const accessToken = extractAccessToken(ca);
    if (!accessToken) {
      logger.warn("captureBotUserIdFromConnectedAccount: no access token on CA", { slug });
      return null;
    }
    return await handler(accessToken);
  } catch (err) {
    logger.warn("captureBotUserIdFromConnectedAccount failed", {
      slug,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

// ─── Cleanup ──────────────────────────────────────────────────────────────────

/**
 * When toolkits are removed from an agent, clean up Composio resources for the
 * given tenant: delete this tenant's connected accounts and any auth config
 * that now has zero connected accounts (no other tenant is using it either).
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

// ─── Helper: today's-priority pick ────────────────────────────────────────────

/**
 * Map an availableSchemes list to the implicit AuthMethod that today's
 * fixed-priority detection would pick. Used to pre-select the picker for fresh
 * adds and to populate the deprecated `auth_scheme` field on
 * TenantConnectorInfo.
 *
 * Priority: NO_AUTH → OAUTH2 → OAUTH1 → API_KEY → BEARER_TOKEN → null.
 */
export function defaultAuthMethodFor(schemes: AuthScheme[]): AuthMethod | null {
  if (schemes.includes("OAUTH2") || schemes.includes("OAUTH1")) return "composio_oauth";
  if (schemes.includes("API_KEY") || schemes.includes("BEARER_TOKEN")) return "custom_token";
  return null;
}
