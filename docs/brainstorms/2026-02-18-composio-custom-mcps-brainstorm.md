# Custom MCP Server Registry for AgentPlane

**Date:** 2026-02-18
**Status:** Brainstorm

## What We're Building

A generic MCP server registry in AgentPlane that lets admins register external MCP servers (like Herald and Pundit), tenants connect via OAuth 2.1 PKCE, and agents use those MCP servers alongside Composio toolkits.

### The Problem

AgentPlane currently only supports Composio's built-in toolkits as MCP tool sources. Herald (S3 file publishing, 5 tools) and Pundit (AI database querying, 7 tools) are custom MCP servers that tenants need access to. There's no way to include them in an agent's tool set today.

### The Solution

1. Admin registers MCP server definitions (name, base URL) in AgentPlane -- OAuth config is discovered automatically via well-known metadata, client credentials obtained via DCR
2. Tenants connect MCP servers to specific agents via OAuth 2.1 PKCE
3. At run time, `buildMcpConfig()` adds custom MCP servers to the `mcpServers` map alongside `composio`
4. The sandbox runner passes all MCP servers to Claude's `query()`

## Why This Approach

- **Full control**: No dependency on Composio for custom MCP servers; AgentPlane owns the registry and auth
- **Native MCP**: Herald and Pundit stay as-is (Streamable HTTP + bearer tokens) -- no REST wrappers needed
- **Already supported**: The sandbox runner's `mcpServers` is a `Record<string, McpServerConfig>` that accepts multiple servers out of the box
- **Generic**: Any future MCP server can be registered without code changes
- **Secure**: Tokens encrypted at rest with existing AES-256-GCM (`ENCRYPTION_KEY`)

### Approaches Considered and Rejected

1. **Composio OpenAPI import** -- Import Herald/Pundit as Composio toolkits via OpenAPI specs. Rejected because: (a) the Composio dashboard import feature appears undocumented/unreliable in the current version, (b) requires adding REST wrapper endpoints to Herald/Pundit, (c) no programmatic API for importing, (d) adds Composio as a proxy layer with latency.

2. **Composio SDK aggregation** -- Register external MCP servers through Composio's API. Rejected because Composio has no mechanism for registering external MCP server URLs. The `client.mcp.custom.create()` endpoint only bundles Composio's own toolkit slugs.

3. **MCP Gateway aggregator** -- Use a separate gateway to merge Composio + custom MCPs into one endpoint. Rejected as over-engineered for two MCP servers; adds another service to maintain.

## Key Decisions

1. **Generic MCP server registry** -- Admin can register any MCP server. Herald and Pundit are the first two entries, but the system supports adding more without code changes.

2. **OAuth 2.1 PKCE only** -- The only supported auth type is OAuth 2.1 with PKCE. No API key or basic auth support. This matches Herald and Pundit's auth model and is the most secure option.

3. **Admin registers, tenants connect** -- Admin defines MCP server types (name, base URL, logo). OAuth config (authorization URL, token URL, scopes) is discovered automatically from the server's well-known metadata endpoint. Tenants see a catalog and connect via OAuth.

4. **Connections are per agent** -- Each agent has its own MCP connections. A tenant connecting Herald to Agent A and Agent B creates two separate OAuth connections. Simple model, no join table.

5. **AgentPlane manages OAuth** -- AgentPlane handles the full OAuth 2.1 PKCE flow: authorization redirect, code exchange, token storage (encrypted), and token refresh.

## What This Looks Like

### Data Model

**`mcp_servers` table (admin-managed, global)**
- `id` -- server ID
- `name` -- display name (e.g., "Herald", "Pundit")
- `slug` -- unique identifier used in `mcpServers` map key
- `description` -- what this server does
- `logo_url` -- for admin/tenant UI
- `base_url` -- MCP server base URL (e.g., `https://xxx.execute-api.us-east-1.amazonaws.com`)
- `client_id` -- OAuth client ID (obtained via DCR on registration)
- `client_secret_enc` -- encrypted OAuth client secret
- `created_at`, `updated_at`

Note: OAuth endpoints (authorization URL, token URL, scopes) are **not stored** -- they are discovered from the server's `/.well-known/oauth-authorization-server` metadata endpoint (RFC 8414).

**`mcp_connections` table (per agent)**
- `id` -- connection ID
- `tenant_id` -- which tenant (for RLS)
- `agent_id` -- which agent
- `mcp_server_id` -- which server
- `status` -- `initiated`, `active`, `expired`, `revoked`
- `access_token_enc` -- AES-256-GCM encrypted access token
- `refresh_token_enc` -- AES-256-GCM encrypted refresh token
- `token_expires_at` -- when the access token expires
- `oauth_state` -- CSRF state for in-progress OAuth flows
- `oauth_code_verifier_enc` -- encrypted PKCE code verifier
- `created_at`, `updated_at`
- Unique constraint on `(agent_id, mcp_server_id)`

### Tenant Flow

1. Tenant edits an agent → sees available MCP servers (Herald, Pundit, etc.)
2. Clicks "Connect" on Herald for this agent → AgentPlane discovers OAuth metadata from Herald's well-known endpoint → initiates OAuth 2.1 PKCE flow → redirect to Herald's login page → callback with authorization code → AgentPlane exchanges code for tokens → stores encrypted tokens as an `mcp_connection` for this agent
3. When the agent runs, `buildMcpConfig()` loads the agent's MCP connections, refreshes expired tokens on-demand, and adds entries to the `mcpServers` map

### Sandbox Integration

The runner script already supports multiple MCP servers:
```javascript
const mcpServers = {};
// Composio (existing)
if (process.env.COMPOSIO_MCP_URL) {
  mcpServers.composio = { type: 'http', url: ..., headers: ... };
}
// Custom MCP servers (new)
// e.g., mcpServers.herald = { type: 'http', url: ..., headers: { Authorization: 'Bearer ...' } }
// e.g., mcpServers.pundit = { type: 'http', url: ..., headers: { Authorization: 'Bearer ...' } }
```

### What Needs to Change in AgentPlane

**Database:**
- New migration: `mcp_servers` and `mcp_connections` tables
- RLS policies for tenant isolation on `mcp_connections`

**API routes:**
- `GET/POST /api/admin/mcp-servers` -- admin CRUD for MCP server definitions (triggers DCR on create)
- `GET /api/mcp-servers` -- tenant: list available MCP servers
- `POST /api/agents/:agentId/mcp-servers/:serverId/connect` -- initiate OAuth flow for this agent
- `GET /api/agents/:agentId/mcp-servers/:serverId/callback` -- OAuth callback handler
- `GET /api/agents/:agentId/mcp-connections` -- list agent's MCP connections
- `DELETE /api/agents/:agentId/mcp-connections/:id` -- revoke a connection

**Lib:**
- New `src/lib/mcp-registry.ts` -- OAuth 2.1 PKCE flow (with well-known discovery + DCR), token management, on-demand token refresh
- Update `src/lib/mcp.ts` -- `buildMcpConfig()` loads agent's MCP connections alongside Composio
- Update `src/lib/sandbox.ts` -- pass custom MCP server env vars to the runner

**Admin UI:**
- MCP server management page (register/edit/delete server definitions)

**Agent detail page -- Connectors section (admin + tenant):**
- **Same UX as Composio toolkits.** Custom MCP servers appear **at the top** of the existing "Add" dropdown in the Connectors section, above Composio toolkits. They show with their logo, name, and description -- visually indistinguishable from Composio entries.
- Once added, they appear in the Connectors list with the same connect/disconnect flow (OAuth button, status indicator, remove button).
- The `ConnectorsManager` component is extended to handle both Composio toolkits and custom MCP servers through a unified interface.

### What Does NOT Need to Change

- Herald and Pundit -- they stay exactly as they are (Streamable HTTP + OAuth 2.1 PKCE)
- The sandbox runner script structure -- just more entries in the `mcpServers` map
- Composio integration -- untouched, runs alongside custom MCPs

## Resolved Questions

1. **Token refresh timing** -- On-demand at run start. Check token expiry when a run begins; if expired, refresh before launching the sandbox. No background cron needed.

2. **Dynamic Client Registration** -- Use RFC 7591 DCR. When an admin registers an MCP server, AgentPlane automatically registers itself as an OAuth client via the server's DCR endpoint. No manual client_id/client_secret setup. The `mcp_servers` table stores the registered `client_id` and encrypted `client_secret`.

3. **Connection health** -- Fail at run time. No proactive health checks. If a token refresh fails or the server is unreachable, the run reports the error. Keep it simple.
