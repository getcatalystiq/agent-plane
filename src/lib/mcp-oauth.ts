/**
 * Pure HTTP layer for MCP server OAuth 2.1 PKCE operations.
 *
 * This module handles external HTTP calls only — no DB access.
 * DB orchestration lives in mcp-connections.ts.
 *
 * Functions:
 * - discoverOAuthMetadata() — RFC 8414 well-known discovery
 * - registerClient() — RFC 7591 Dynamic Client Registration
 * - exchangeCodeForTokens() — Authorization code → tokens
 * - callTokenRefreshEndpoint() — Refresh token → new tokens
 * - safeFetch() — SSRF-safe fetch wrapper with IP validation
 * - generatePkceChallenge() — PKCE code_verifier + code_challenge
 */

import { logger } from "./logger";
import { ValidationError } from "./errors";
import { OAuthMetadataSchema } from "./validation";
import type { OAuthMetadata, ClientRegistrationMetadata, TokenExchangeResult } from "./types";

// --- SSRF Protection ---

// Private/reserved IP ranges that must be blocked
const PRIVATE_IP_RANGES = [
  /^127\./,                    // Loopback
  /^10\./,                     // Class A private
  /^172\.(1[6-9]|2\d|3[01])\./, // Class B private
  /^192\.168\./,               // Class C private
  /^169\.254\./,               // Link-local
  /^0\./,                      // Current network
  /^::1$/,                     // IPv6 loopback
  /^fd/i,                      // IPv6 ULA
  /^fe80/i,                    // IPv6 link-local
  /^fc/i,                      // IPv6 ULA
];

function isPrivateIp(ip: string): boolean {
  return PRIVATE_IP_RANGES.some((pattern) => pattern.test(ip));
}

/**
 * Resolve hostname and validate it doesn't point to a private IP.
 * Throws ValidationError if the URL resolves to a private address.
 */
export async function validatePublicUrl(url: string): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:") {
    throw new ValidationError("URL must use HTTPS");
  }

  // Use DNS resolution to check the IP
  // In Node.js, we use the dns module
  const { resolve4, resolve6 } = await import("dns/promises");

  try {
    const ipv4Addresses = await resolve4(parsed.hostname).catch(() => [] as string[]);
    const ipv6Addresses = await resolve6(parsed.hostname).catch(() => [] as string[]);
    const allIps = [...ipv4Addresses, ...ipv6Addresses];

    if (allIps.length === 0) {
      throw new ValidationError(`Cannot resolve hostname: ${parsed.hostname}`);
    }

    for (const ip of allIps) {
      if (isPrivateIp(ip)) {
        throw new ValidationError(
          `URL resolves to private IP address (${parsed.hostname})`,
        );
      }
    }
  } catch (err) {
    if (err instanceof ValidationError) throw err;
    throw new ValidationError(`DNS resolution failed for ${parsed.hostname}`);
  }
}

/**
 * SSRF-safe fetch wrapper. Validates the URL doesn't resolve to a private IP
 * before making the request. Used for all outbound calls to MCP servers.
 */
export async function safeFetch(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  await validatePublicUrl(url);
  return fetch(url, init);
}

/**
 * Validate that all URL fields in OAuth metadata share the same origin as base_url.
 */
export function validateMetadataOrigin(metadata: OAuthMetadata, baseUrl: string): void {
  const baseOrigin = new URL(baseUrl).origin;
  const urlFields = [
    metadata.authorization_endpoint,
    metadata.token_endpoint,
    metadata.registration_endpoint,
  ].filter(Boolean) as string[];

  for (const url of urlFields) {
    const origin = new URL(url).origin;
    if (origin !== baseOrigin) {
      throw new ValidationError(
        `OAuth metadata URL ${url} has different origin than base_url ${baseUrl}`,
      );
    }
  }
}

// --- OAuth Discovery ---

/**
 * Discover OAuth metadata from /.well-known/oauth-authorization-server (RFC 8414).
 */
export async function discoverOAuthMetadata(baseUrl: string): Promise<OAuthMetadata> {
  const wellKnownUrl = new URL("/.well-known/oauth-authorization-server", baseUrl).toString();

  logger.info("Discovering OAuth metadata", { url: wellKnownUrl });

  const response = await safeFetch(wellKnownUrl, {
    headers: { Accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(
      `OAuth discovery failed: ${response.status} ${response.statusText}`,
    );
  }

  const raw = await response.json();
  const metadata = OAuthMetadataSchema.parse(raw);

  // Validate all URLs in metadata share the same origin as base_url
  validateMetadataOrigin(metadata, baseUrl);

  return metadata;
}

// --- Dynamic Client Registration ---

/**
 * Register AgentPlane as an OAuth client via RFC 7591 Dynamic Client Registration.
 */
export async function registerClient(
  registrationEndpoint: string,
  redirectUri: string,
  metadata: ClientRegistrationMetadata,
): Promise<{ clientId: string; clientSecret: string }> {
  const requestBody = {
    ...metadata,
    redirect_uris: [redirectUri],
  };
  logger.info("Registering OAuth client", { endpoint: registrationEndpoint, body: requestBody });

  const response = await safeFetch(registrationEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestBody),
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(
      `Client registration failed: ${response.status} ${response.statusText} - ${body}`,
    );
  }

  const data = await response.json();

  if (!data.client_id) {
    throw new Error("Client registration response missing client_id");
  }

  return {
    clientId: data.client_id,
    clientSecret: data.client_secret ?? "",
  };
}

// --- PKCE ---

/**
 * Generate a PKCE code_verifier and code_challenge pair.
 */
export async function generatePkceChallenge(): Promise<{
  codeVerifier: string;
  codeChallenge: string;
}> {
  // Generate 32 random bytes → 43-char base64url string
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const codeVerifier = base64UrlEncode(bytes);

  // S256: code_challenge = base64url(sha256(code_verifier))
  const encoded = new TextEncoder().encode(codeVerifier);
  const hash = await crypto.subtle.digest("SHA-256", encoded.buffer as ArrayBuffer);
  const codeChallenge = base64UrlEncode(new Uint8Array(hash));

  return { codeVerifier, codeChallenge };
}

function base64UrlEncode(data: Uint8Array): string {
  let binary = "";
  for (const b of data) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

// --- Token Exchange ---

/**
 * Exchange an authorization code for tokens (OAuth 2.1 PKCE).
 */
export async function exchangeCodeForTokens(params: {
  tokenEndpoint: string;
  code: string;
  codeVerifier: string;
  redirectUri: string;
  clientId: string;
  clientSecret: string;
}): Promise<TokenExchangeResult> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    code_verifier: params.codeVerifier,
    redirect_uri: params.redirectUri,
    client_id: params.clientId,
    ...(params.clientSecret ? { client_secret: params.clientSecret } : {}),
  });

  const response = await safeFetch(params.tokenEndpoint, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });

  if (!response.ok) {
    const errorBody = await response.text().catch(() => "");
    throw new Error(
      `Token exchange failed: ${response.status} ${response.statusText} - ${errorBody}`,
    );
  }

  const data = await response.json();

  if (!data.access_token) {
    throw new Error("Token response missing access_token");
  }

  const expiresIn = data.expires_in ?? 3600; // Default 1 hour if not specified
  const expiresAt = new Date(Date.now() + expiresIn * 1000);

  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token ?? null,
    expiresAt,
    scopes: data.scope ? data.scope.split(" ") : [],
  };
}

// --- Token Refresh ---

/**
 * Call the token endpoint to refresh an access token.
 * Returns new tokens. Does NOT write to the database.
 */
export async function callTokenRefreshEndpoint(params: {
  tokenEndpoint: string;
  refreshToken: string;
  clientId: string;
  clientSecret: string;
}): Promise<TokenExchangeResult> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: params.refreshToken,
    client_id: params.clientId,
    ...(params.clientSecret ? { client_secret: params.clientSecret } : {}),
  });

  const MAX_RETRIES = 3;
  const RETRY_DELAY_MS = 5_000;

  let lastError: Error | null = null;

  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    const response = await safeFetch(params.tokenEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    });

    if (response.ok) {
      const data = await response.json();

      if (!data.access_token) {
        throw new Error("Token refresh response missing access_token");
      }

      const expiresIn = data.expires_in ?? 3600;
      const expiresAt = new Date(Date.now() + expiresIn * 1000);

      return {
        accessToken: data.access_token,
        refreshToken: data.refresh_token ?? params.refreshToken,
        expiresAt,
        scopes: data.scope ? data.scope.split(" ") : [],
      };
    }

    const errorBody = await response.text().catch(() => "");

    // Only retry on transient errors (5xx); client errors (4xx) are permanent
    if (response.status < 500) {
      throw new Error(
        `Token refresh failed: ${response.status} ${response.statusText} - ${errorBody}`,
      );
    }

    lastError = new Error(
      `Token refresh failed: ${response.status} ${response.statusText} - ${errorBody}`,
    );
    logger.warn("Token refresh transient error, retrying", {
      attempt,
      status: response.status,
      endpoint: params.tokenEndpoint,
    });

    if (attempt < MAX_RETRIES) {
      await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
    }
  }

  throw lastError!;
}

// --- Tool Discovery ---

/**
 * Call tools/list on an MCP server via JSON-RPC over Streamable HTTP.
 * Sends initialize first to establish a session, then tools/list.
 */
export async function fetchMcpToolList(
  mcpUrl: string,
  accessToken: string,
): Promise<Array<{ name: string; description?: string; inputSchema?: unknown }>> {
  const authHeaders = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${accessToken}`,
  };

  // Step 1: Initialize the MCP session
  const initResponse = await safeFetch(mcpUrl, {
    method: "POST",
    headers: authHeaders,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "AgentPlane", version: "1.0.0" },
      },
    }),
  });

  if (!initResponse.ok) {
    throw new Error(`initialize failed: ${initResponse.status} ${initResponse.statusText}`);
  }

  // Capture session ID from response header
  const sessionId = initResponse.headers.get("mcp-session-id");
  await initResponse.json(); // consume body

  // Step 2: Send initialized notification
  const notifHeaders: Record<string, string> = { ...authHeaders };
  if (sessionId) notifHeaders["mcp-session-id"] = sessionId;

  await safeFetch(mcpUrl, {
    method: "POST",
    headers: notifHeaders,
    body: JSON.stringify({
      jsonrpc: "2.0",
      method: "notifications/initialized",
    }),
  });

  // Step 3: Call tools/list
  const toolsHeaders: Record<string, string> = { ...authHeaders };
  if (sessionId) toolsHeaders["mcp-session-id"] = sessionId;

  const response = await safeFetch(mcpUrl, {
    method: "POST",
    headers: toolsHeaders,
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {},
    }),
  });

  if (!response.ok) {
    throw new Error(`tools/list failed: ${response.status} ${response.statusText}`);
  }

  const data = await response.json();

  if (data.error) {
    throw new Error(`tools/list RPC error: ${data.error.message ?? JSON.stringify(data.error)}`);
  }

  return data.result?.tools ?? [];
}
