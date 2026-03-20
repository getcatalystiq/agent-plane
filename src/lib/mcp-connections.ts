/**
 * DB-aware orchestration for MCP server connections.
 *
 * Handles: OAuth flow initiation/completion, token management with
 * two-phase refresh, connection lifecycle, and process-level caching.
 *
 * Uses mcp-oauth.ts for HTTP calls and db for persistence.
 */

import { query, queryOne, withTenantTransaction } from "@/db";
import { encrypt, decrypt } from "./crypto";
import { getEnv } from "./env";
import { logger } from "./logger";
import {
  McpConnectionRowInternal,
  McpServerRowInternal,
  McpServerRow,
  OAuthMetadataSchema,
} from "./validation";
import type { McpConnectionInternal, McpServerInternal, McpServer } from "./validation";
import type { McpServerId, McpConnectionId, AgentId, TenantId } from "./types";
import {
  discoverOAuthMetadata,
  registerClient,
  exchangeCodeForTokens,
  callTokenRefreshEndpoint,
  generatePkceChallenge,
} from "./mcp-oauth";
import { signMcpOAuthState } from "./mcp-oauth-state";

// --- Process-Level MCP Server Cache ---

const serverCache = new Map<string, { server: McpServerInternal; cachedAt: number }>();
const SERVER_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function clearServerCache(serverId?: string) {
  if (serverId) {
    serverCache.delete(serverId);
  } else {
    serverCache.clear();
  }
}

export async function getMcpServer(serverId: McpServerId): Promise<McpServerInternal> {
  const cached = serverCache.get(serverId);
  if (cached && Date.now() - cached.cachedAt < SERVER_CACHE_TTL_MS) {
    return cached.server;
  }
  const server = await queryOne(
    McpServerRowInternal,
    "SELECT * FROM mcp_servers WHERE id = $1",
    [serverId],
  );
  if (!server) throw new Error(`MCP server not found: ${serverId}`);
  serverCache.set(serverId, { server, cachedAt: Date.now() });
  return server;
}

export async function getMcpServersByIds(
  serverIds: McpServerId[],
): Promise<McpServerInternal[]> {
  if (serverIds.length === 0) return [];
  const servers = await query(
    McpServerRowInternal,
    "SELECT * FROM mcp_servers WHERE id = ANY($1)",
    [serverIds],
  );
  for (const server of servers) {
    serverCache.set(server.id, { server, cachedAt: Date.now() });
  }
  return servers;
}

export async function listMcpServers(tenantId?: string): Promise<McpServer[]> {
  const cols = "id, tenant_id, name, slug, description, logo_url, base_url, mcp_endpoint_path, client_id, oauth_metadata, created_at, updated_at";
  if (tenantId) {
    return query(
      McpServerRow,
      `SELECT ${cols} FROM mcp_servers WHERE tenant_id = $1 ORDER BY name`,
      [tenantId],
    );
  }
  return query(
    McpServerRow,
    `SELECT ${cols} FROM mcp_servers ORDER BY name`,
  );
}

// --- MCP Server Registration ---

export async function registerMcpServer(
  input: {
    tenantId: string;
    name: string;
    slug: string;
    description: string;
    logoUrl?: string;
    baseUrl: string;
    mcpEndpointPath: string;
  },
  callbackBaseUrl: string,
): Promise<McpServer> {
  const env = getEnv();

  const returnCols = "id, tenant_id, name, slug, description, logo_url, base_url, mcp_endpoint_path, client_id, oauth_metadata, created_at, updated_at";

  // Step 1: Discover OAuth metadata
  const metadata = await discoverOAuthMetadata(input.baseUrl);

  // Step 2: Register as OAuth client via DCR
  let clientId: string | null = null;
  let clientSecretEnc: string | null = null;

  if (metadata.registration_endpoint) {
    const serverId = crypto.randomUUID();
    const redirectUri = `${callbackBaseUrl}/api/mcp-servers/${serverId}/callback`;

    const registration = await registerClient(
      metadata.registration_endpoint,
      redirectUri,
      {
        client_name: "AgentPlane",
        redirect_uris: [redirectUri],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "client_secret_post",
      },
    );

    clientId = registration.clientId;
    if (registration.clientSecret) {
      const encrypted = await encrypt(registration.clientSecret, env.ENCRYPTION_KEY);
      clientSecretEnc = JSON.stringify(encrypted);
    }

    // Insert with pre-generated ID
    const row = await queryOne(
      McpServerRow,
      `INSERT INTO mcp_servers (id, tenant_id, name, slug, description, logo_url, base_url, mcp_endpoint_path, client_id, client_secret_enc, oauth_metadata)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING ${returnCols}`,
      [
        serverId,
        input.tenantId,
        input.name,
        input.slug,
        input.description,
        input.logoUrl ?? null,
        input.baseUrl,
        input.mcpEndpointPath,
        clientId,
        clientSecretEnc,
        JSON.stringify(metadata),
      ],
    );
    if (!row) throw new Error("Failed to insert MCP server");
    return row;
  }

  // No DCR endpoint — insert without client credentials
  const row = await queryOne(
    McpServerRow,
    `INSERT INTO mcp_servers (tenant_id, name, slug, description, logo_url, base_url, mcp_endpoint_path, oauth_metadata)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     RETURNING ${returnCols}`,
    [
      input.tenantId,
      input.name,
      input.slug,
      input.description,
      input.logoUrl ?? null,
      input.baseUrl,
      input.mcpEndpointPath,
      JSON.stringify(metadata),
    ],
  );
  if (!row) throw new Error("Failed to insert MCP server");
  return row;
}

// --- OAuth Flow Initiation ---

export async function initiateOAuth(params: {
  mcpServerId: McpServerId;
  agentId: AgentId;
  tenantId: TenantId;
  callbackBaseUrl: string;
}): Promise<{ redirectUrl: string }> {
  const env = getEnv();
  const server = await getMcpServer(params.mcpServerId);

  if (!server.oauth_metadata || !server.client_id) {
    throw new Error("MCP server is not configured for OAuth");
  }

  const metadata = OAuthMetadataSchema.parse(server.oauth_metadata);

  // Generate PKCE
  const { codeVerifier, codeChallenge } = await generatePkceChallenge();
  const codeVerifierEncData = await encrypt(codeVerifier, env.ENCRYPTION_KEY);

  // UPSERT: create or replace initiated/expired/failed connection
  const connectionRow = await withTenantTransaction(params.tenantId, async (tx) => {
    const rows = await tx.query(
      McpConnectionRowInternal,
      `INSERT INTO mcp_connections (tenant_id, agent_id, mcp_server_id, status, code_verifier_enc, oauth_state)
       VALUES ($1, $2, $3, 'initiated', $4, 'pending')
       ON CONFLICT (agent_id, mcp_server_id)
       DO UPDATE SET
         status = 'initiated',
         code_verifier_enc = EXCLUDED.code_verifier_enc,
         oauth_state = 'pending',
         access_token_enc = NULL,
         refresh_token_enc = NULL,
         token_expires_at = NULL
       WHERE mcp_connections.status IN ('initiated', 'expired', 'failed')
       RETURNING *`,
      [params.tenantId, params.agentId, params.mcpServerId, JSON.stringify(codeVerifierEncData)],
    );
    return rows[0] ?? null;
  });

  if (!connectionRow) {
    throw new Error("Cannot initiate OAuth: an active connection already exists");
  }

  // Sign state with connection ID
  const state = await signMcpOAuthState({
    mcpServerId: params.mcpServerId,
    agentId: params.agentId,
    tenantId: params.tenantId,
    connectionId: connectionRow.id as McpConnectionId,
  });

  // Update the oauth_state in the row
  await withTenantTransaction(params.tenantId, async (tx) => {
    await tx.execute(
      "UPDATE mcp_connections SET oauth_state = $1 WHERE id = $2",
      [state, connectionRow.id],
    );
  });

  // Build authorization URL
  const redirectUri = `${params.callbackBaseUrl}/api/mcp-servers/${params.mcpServerId}/callback`;
  const authUrl = new URL(metadata.authorization_endpoint);
  authUrl.searchParams.set("response_type", "code");
  authUrl.searchParams.set("client_id", server.client_id);
  authUrl.searchParams.set("redirect_uri", redirectUri);
  authUrl.searchParams.set("state", state);
  authUrl.searchParams.set("code_challenge", codeChallenge);
  authUrl.searchParams.set("code_challenge_method", "S256");

  if (metadata.scopes_supported?.length) {
    authUrl.searchParams.set("scope", metadata.scopes_supported.join(" "));
  }

  return { redirectUrl: authUrl.toString() };
}

// --- OAuth Callback Completion ---

export async function completeOAuth(params: {
  connectionId: McpConnectionId;
  tenantId: TenantId;
  mcpServerId: McpServerId;
  code: string;
}): Promise<void> {
  const env = getEnv();
  const server = await getMcpServer(params.mcpServerId);

  if (!server.oauth_metadata || !server.client_id) {
    throw new Error("MCP server is not configured for OAuth");
  }

  const metadata = OAuthMetadataSchema.parse(server.oauth_metadata);

  // Load connection and verify status
  const connection = await withTenantTransaction(params.tenantId, async (tx) => {
    const row = await tx.queryOne(
      McpConnectionRowInternal,
      "SELECT * FROM mcp_connections WHERE id = $1 AND status = 'initiated'",
      [params.connectionId],
    );
    return row;
  });

  if (!connection) {
    throw new Error("Connection not found or not in initiated state");
  }

  // Decrypt code_verifier
  if (!connection.code_verifier_enc) {
    throw new Error("Connection missing code_verifier");
  }
  const codeVerifier = await decrypt(
    JSON.parse(connection.code_verifier_enc),
    env.ENCRYPTION_KEY,
    env.ENCRYPTION_KEY_PREVIOUS,
  );

  // Decrypt client_secret
  let clientSecret = "";
  if (server.client_secret_enc) {
    clientSecret = await decrypt(
      JSON.parse(server.client_secret_enc),
      env.ENCRYPTION_KEY,
      env.ENCRYPTION_KEY_PREVIOUS,
    );
  }

  // Exchange code for tokens
  const redirectUri = `${getCallbackBaseUrl()}/api/mcp-servers/${params.mcpServerId}/callback`;
  const tokens = await exchangeCodeForTokens({
    tokenEndpoint: metadata.token_endpoint,
    code: params.code,
    codeVerifier,
    redirectUri,
    clientId: server.client_id,
    clientSecret,
  });

  // Encrypt and store tokens
  const accessTokenEnc = JSON.stringify(await encrypt(tokens.accessToken, env.ENCRYPTION_KEY));
  const refreshTokenEnc = tokens.refreshToken
    ? JSON.stringify(await encrypt(tokens.refreshToken, env.ENCRYPTION_KEY))
    : null;

  await withTenantTransaction(params.tenantId, async (tx) => {
    await tx.execute(
      `UPDATE mcp_connections
       SET status = 'active',
           access_token_enc = $1,
           refresh_token_enc = $2,
           token_expires_at = $3,
           granted_scopes = $4,
           code_verifier_enc = NULL,
           oauth_state = NULL
       WHERE id = $5 AND status = 'initiated'`,
      [
        accessTokenEnc,
        refreshTokenEnc,
        tokens.expiresAt.toISOString(),
        tokens.scopes,
        params.connectionId,
      ],
    );
  });

  logger.info("MCP OAuth completed", {
    connectionId: params.connectionId,
    mcpServerId: params.mcpServerId,
  });
}

// --- Token Refresh (Two-Phase Pattern) ---

/**
 * Get a valid access token for a connection, refreshing if needed.
 *
 * Uses a two-phase pattern to avoid holding a DB connection during HTTP calls:
 * 1. Phase A: Lock row with FOR UPDATE NOWAIT, check token validity
 * 2. HTTP call: Refresh token (outside transaction)
 * 3. Phase B: Write new tokens
 */
export async function getOrRefreshToken(
  conn: McpConnectionInternal,
  tenantId: TenantId,
): Promise<string> {
  const env = getEnv();
  const BUFFER_MS = 11 * 60 * 1000; // 11 minutes (sandbox timeout + 1 min margin)

  const expiresAt = conn.token_expires_at ? new Date(conn.token_expires_at).getTime() : 0;

  if (expiresAt - Date.now() > BUFFER_MS && conn.access_token_enc) {
    // Token has enough runway — use as-is
    return decrypt(JSON.parse(conn.access_token_enc), env.ENCRYPTION_KEY, env.ENCRYPTION_KEY_PREVIOUS);
  }

  // Need to refresh — two-phase pattern
  return refreshAccessToken(conn.id as McpConnectionId, tenantId);
}

async function refreshAccessToken(
  connectionId: McpConnectionId,
  tenantId: TenantId,
): Promise<string> {
  const env = getEnv();
  const BUFFER_MS = 11 * 60 * 1000;

  // Phase A: Lock and check
  const lockResult = await withTenantTransaction(tenantId, async (tx) => {
    const row = await tx.queryOne(
      McpConnectionRowInternal,
      "SELECT * FROM mcp_connections WHERE id = $1 FOR UPDATE NOWAIT",
      [connectionId],
    );
    if (!row) throw new Error(`Connection not found: ${connectionId}`);

    // Check if another caller already refreshed
    const expiresAt = row.token_expires_at ? new Date(row.token_expires_at).getTime() : 0;
    if (expiresAt - Date.now() > BUFFER_MS && row.access_token_enc) {
      // Already valid — return the current token
      const token = await decrypt(
        JSON.parse(row.access_token_enc),
        env.ENCRYPTION_KEY,
        env.ENCRYPTION_KEY_PREVIOUS,
      );
      return { alreadyValid: true as const, token };
    }

    // Needs refresh — return refresh token data
    if (!row.refresh_token_enc) {
      throw new Error("No refresh token available");
    }
    const refreshToken = await decrypt(
      JSON.parse(row.refresh_token_enc),
      env.ENCRYPTION_KEY,
      env.ENCRYPTION_KEY_PREVIOUS,
    );
    return {
      alreadyValid: false as const,
      refreshToken,
      mcpServerId: row.mcp_server_id as McpServerId,
    };
  });

  if (lockResult.alreadyValid) {
    return lockResult.token;
  }

  // Load server config
  const server = await getMcpServer(lockResult.mcpServerId);
  if (!server.oauth_metadata || !server.client_id) {
    throw new Error("MCP server not configured for OAuth");
  }

  const metadata = OAuthMetadataSchema.parse(server.oauth_metadata);

  let clientSecret = "";
  if (server.client_secret_enc) {
    clientSecret = await decrypt(
      JSON.parse(server.client_secret_enc),
      env.ENCRYPTION_KEY,
      env.ENCRYPTION_KEY_PREVIOUS,
    );
  }

  // HTTP call (outside any transaction)
  const tokens = await callTokenRefreshEndpoint({
    tokenEndpoint: metadata.token_endpoint,
    refreshToken: lockResult.refreshToken,
    clientId: server.client_id,
    clientSecret,
  });

  // Phase B: Write new tokens
  const accessTokenEnc = JSON.stringify(await encrypt(tokens.accessToken, env.ENCRYPTION_KEY));
  const refreshTokenEnc = tokens.refreshToken
    ? JSON.stringify(await encrypt(tokens.refreshToken, env.ENCRYPTION_KEY))
    : null;

  await withTenantTransaction(tenantId, async (tx) => {
    await tx.execute(
      `UPDATE mcp_connections
       SET access_token_enc = $1,
           refresh_token_enc = COALESCE($2, refresh_token_enc),
           token_expires_at = $3,
           status = 'active'
       WHERE id = $4`,
      [accessTokenEnc, refreshTokenEnc, tokens.expiresAt.toISOString(), connectionId],
    );
  });

  logger.info("MCP token refreshed", { connectionId });
  return tokens.accessToken;
}

// --- Connection Queries ---

export async function getActiveConnections(
  agentId: AgentId,
  tenantId: TenantId,
): Promise<McpConnectionInternal[]> {
  return withTenantTransaction(tenantId, async (tx) => {
    return tx.query(
      McpConnectionRowInternal,
      "SELECT * FROM mcp_connections WHERE agent_id = $1 AND status = 'active'",
      [agentId],
    );
  });
}

export async function getAgentConnections(
  agentId: AgentId,
  tenantId: TenantId,
): Promise<McpConnectionInternal[]> {
  return withTenantTransaction(tenantId, async (tx) => {
    return tx.query(
      McpConnectionRowInternal,
      "SELECT * FROM mcp_connections WHERE agent_id = $1 ORDER BY created_at",
      [agentId],
    );
  });
}

export async function deleteConnection(
  agentId: AgentId,
  mcpServerId: McpServerId,
  tenantId: TenantId,
): Promise<boolean> {
  const result = await withTenantTransaction(tenantId, async (tx) => {
    return tx.execute(
      "DELETE FROM mcp_connections WHERE agent_id = $1 AND mcp_server_id = $2",
      [agentId, mcpServerId],
    );
  });
  return result.rowCount > 0;
}

export async function markConnectionFailed(
  connectionId: McpConnectionId,
  tenantId: TenantId,
): Promise<void> {
  await withTenantTransaction(tenantId, async (tx) => {
    await tx.execute(
      "UPDATE mcp_connections SET status = 'failed' WHERE id = $1",
      [connectionId],
    );
  });
}

export async function updateAllowedTools(
  agentId: AgentId,
  mcpServerId: McpServerId,
  tenantId: TenantId,
  allowedTools: string[],
): Promise<void> {
  await withTenantTransaction(tenantId, async (tx) => {
    await tx.execute(
      "UPDATE mcp_connections SET allowed_tools = $1 WHERE agent_id = $2 AND mcp_server_id = $3",
      [allowedTools, agentId, mcpServerId],
    );
  });
}

// --- Helpers ---

export function getCallbackBaseUrl(): string {
  // Prefer the stable production URL so OAuth redirect URIs survive deploys.
  // Fall back to per-deploy VERCEL_URL, then NEXT_PUBLIC_BASE_URL, then localhost.
  if (process.env.VERCEL_PROJECT_PRODUCTION_URL) {
    return `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`;
  }
  if (process.env.VERCEL_URL) {
    return `https://${process.env.VERCEL_URL}`;
  }
  return process.env.NEXT_PUBLIC_BASE_URL ?? "http://localhost:3000";
}

export { clearServerCache };
