---
title: "feat: Expand SDK with skills, plugins, connectors, and custom connectors"
type: feat
status: active
date: 2026-03-01
origin: docs/brainstorms/2026-03-01-sdk-full-resource-management-brainstorm.md
---

# Expand SDK with Full Resource Management

## Enhancement Summary

**Deepened on:** 2026-03-01
**Sections enhanced:** All
**Review agents used:** TypeScript reviewer, architecture strategist, security sentinel, performance oracle, pattern recognition specialist, code simplicity reviewer, data integrity guardian, agent-native reviewer, best-practices researcher

### Critical Corrections from Review

1. **Wire format mismatches found** — MCP `initiateOauth` returns `{ redirectUrl }` (camelCase), not `{ redirect_url }`. `PluginListItem` uses camelCase on wire (`displayName`, `hasSkills`). SDK types must match actual API responses, not a blanket convention.
2. **Merge split resource classes** — No need for separate `AgentConnectorsResource` + `ConnectorsResource`. One class per domain with both agent-scoped and discovery methods is simpler.
3. **Use atomic JSONB SQL** for skill/plugin mutations instead of read-modify-write to avoid row lock contention.
4. **Add rate limiting** on new Composio proxy routes to prevent tenant quota exhaustion.
5. **Fix existing bug** — Missing skill folder uniqueness validation in `SkillsSchema`.
6. **Define `PluginMarketplacePublicRow`** schema excluding `github_token_enc` for tenant routes.

### Key Improvements

1. Atomic PostgreSQL JSONB operators eliminate concurrency issues
2. Per-tenant rate limiting on external API proxy routes
3. Types audited against actual wire format (mixed casing handled correctly)
4. Consolidated resource classes (2 instead of 4 for connectors)
5. Security hardening (no `github_token_enc` leak, rate limits, input validation)

---

## Overview

Expand the `@getcatalystiq/agent-plane` TypeScript SDK to expose granular management of skills, plugins, connectors (Composio), custom connectors (MCP), plugin marketplace discovery, and Composio toolkit discovery. This requires both new server-side API routes and new SDK resource classes.

(see brainstorm: docs/brainstorms/2026-03-01-sdk-full-resource-management-brainstorm.md)

## Problem Statement

The SDK currently only exposes agent CRUD and run management. Tenants who want to programmatically manage skills, plugins, or connectors must either:
- Send full agent update payloads (risking race conditions, no granular operations)
- Have no access at all (connectors, MCP connections, toolkit discovery, plugin marketplace browsing)

This blocks SDK users from building automation around agent configuration.

## Proposed Solution

Add **nested sub-resource classes** on the SDK client, backed by new and existing API routes:

```typescript
// Agent sub-resources
client.agents.skills.*           // Granular skill CRUD (NEW routes)
client.agents.plugins.*          // Granular plugin CRUD (NEW routes)
client.agents.connectors.*      // Composio connectors (existing routes)
client.agents.customConnectors.* // MCP connections (existing routes)

// Top-level resources
client.customConnectors.*        // MCP server registry (existing route)
client.pluginMarketplaces.*      // Plugin discovery (NEW routes)
client.connectors.*              // Composio toolkit discovery (NEW routes)
```

### Research Insights: SDK API Design

**Industry patterns (Stripe, OpenAI, Anthropic):**
- All use sub-resource nesting at depth-1 (e.g., `client.fineTuning.jobs.list()`). This matches our `client.agents.skills.list(agentId)` pattern.
- Stripe moved AWAY from deep nesting (depth > 2) but depth-1 remains clean and ergonomic.
- Sub-resource classes all take the parent client in their constructor — exactly matching our existing `AgentsResource` pattern.

**Breaking change safety:** Adding new resource classes and properties is a non-breaking minor version bump under semver-ts. Existing `client.agents.create/get/list/update/delete` and `client.runs.*` continue to work identically. Target version: `0.2.0`.

---

## Implementation Phases

### Phase 1: New Server-Side API Routes

New tenant-scoped routes for granular skills/plugins CRUD and discovery endpoints.

#### 1A. Skills Routes

**Files to create:**
- `src/app/api/agents/[agentId]/skills/route.ts` — `GET` (list) + `POST` (create)
- `src/app/api/agents/[agentId]/skills/[folder]/route.ts` — `GET` + `PUT` + `DELETE`

Every route file must export `export const dynamic = "force-dynamic";` and wrap handlers with `withErrorHandler()`.

**GET /api/agents/:agentId/skills**
- Auth: `authenticateApiKey` → verify agent ownership via `getAgentForTenant`
- Read `agents.skills` JSONB column
- Response: `{ data: AgentSkill[] }`

**POST /api/agents/:agentId/skills**
- Body: `AgentSkillSchema` (single skill: `{ folder, files }`)
- Validate folder name uniqueness against existing skills
- Validate total skills count (max 50) and total size (5MB) after addition
- Response: `AgentSkill` (201)

**GET /api/agents/:agentId/skills/:folder**
- Find skill by folder name in JSONB array
- Response: `AgentSkill` or 404

**PUT /api/agents/:agentId/skills/:folder**
- Body: `{ files: AgentSkillFile[] }` (folder name comes from URL, not body)
- Replace the matching skill entry in the JSONB array
- Validate total size after replacement
- Response: `AgentSkill`

**DELETE /api/agents/:agentId/skills/:folder**
- Remove the skill with matching folder from JSONB array
- Response: `{ deleted: true }`

### Research Insights: JSONB Mutation Strategy

**Use atomic PostgreSQL JSONB operators** instead of read-modify-write. This eliminates `SELECT FOR UPDATE` row lock contention entirely:

```sql
-- Add a skill (atomic append)
UPDATE agents
SET skills = skills || $1::jsonb
WHERE id = $2 AND tenant_id = $3
  AND NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements(skills) s WHERE s->>'folder' = $4
  );

-- Delete a skill by folder name (atomic filter)
UPDATE agents
SET skills = (
  SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
  FROM jsonb_array_elements(skills) AS elem
  WHERE elem->>'folder' != $1
)
WHERE id = $2 AND tenant_id = $3;

-- Update a single skill by folder name (atomic replace)
UPDATE agents
SET skills = (
  SELECT jsonb_agg(
    CASE WHEN elem->>'folder' = $1 THEN $2::jsonb ELSE elem END
  )
  FROM jsonb_array_elements(skills) AS elem
)
WHERE id = $3 AND tenant_id = $4;
```

**Why this is better than SELECT FOR UPDATE:**
- No row lock contention — concurrent skill operations don't serialize
- No JS round-trip — modification happens in the DB
- Reduces data transfer from 5MB (full skills array) to single-skill size
- Connection pool (max 5) stays healthy under concurrent requests

**Validation approach:** Read the agent row BEFORE the atomic UPDATE to validate total count and size limits. If the UPDATE returns `rowCount: 0`, the folder already exists (for create) or doesn't exist (for delete) — return 409 or 404.

#### 1B. Plugins Routes

**Files to create:**
- `src/app/api/agents/[agentId]/plugins/route.ts` — `GET` (list) + `POST` (add)
- `src/app/api/agents/[agentId]/plugins/[marketplaceId]/[pluginName]/route.ts` — `DELETE`

**GET /api/agents/:agentId/plugins**
- Response: `{ data: AgentPlugin[] }`

**POST /api/agents/:agentId/plugins**
- Body: `AgentPluginSchema` (`{ marketplace_id, plugin_name }`)
- Validate marketplace_id exists in `plugin_marketplaces` table
- Validate uniqueness (no duplicate marketplace_id:plugin_name)
- Validate max 20 plugins
- Use atomic JSONB append (same pattern as skills):
  ```sql
  UPDATE agents
  SET plugins = plugins || $1::jsonb
  WHERE id = $2 AND tenant_id = $3
    AND jsonb_array_length(plugins) < 20;
  ```
- Response: `AgentPlugin` (201)

**DELETE /api/agents/:agentId/plugins/:marketplaceId/:pluginName**
- Atomic JSONB filter:
  ```sql
  UPDATE agents
  SET plugins = (
    SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
    FROM jsonb_array_elements(plugins) AS elem
    WHERE NOT (elem->>'marketplace_id' = $1 AND elem->>'plugin_name' = $2)
  )
  WHERE id = $3 AND tenant_id = $4;
  ```
- Response: `{ deleted: true }` or 404 if rowCount is 0

#### 1C. Plugin Marketplace Discovery Routes (Tenant-Scoped)

**Files to create:**
- `src/app/api/plugin-marketplaces/route.ts` — `GET`
- `src/app/api/plugin-marketplaces/[marketplaceId]/plugins/route.ts` — `GET`

**GET /api/plugin-marketplaces**
- Auth: `authenticateApiKey`
- Use explicit column list (NEVER `SELECT *`) to exclude `github_token_enc`:
  ```sql
  SELECT id, name, github_repo, created_at, updated_at FROM plugin_marketplaces ORDER BY name
  ```
- Define `PluginMarketplacePublicRow` Zod schema WITHOUT `github_token_enc`
- Response: `{ data: PluginMarketplace[] }`

### Research Insights: Security

The security review found that the existing admin `GET /api/admin/plugin-marketplaces` returns `github_token_enc` (the encrypted GitHub token) in its response. While the ciphertext alone is not exploitable without `ENCRYPTION_KEY`, defense-in-depth requires never exposing it. The new tenant route **must** use explicit column lists. Also fix the admin list route.

**GET /api/plugin-marketplaces/:marketplaceId/plugins**
- Auth: `authenticateApiKey`
- Reuse `listPlugins()` from `src/lib/plugins.ts` (already cached with 5-min TTL)
- Response: `{ data: PluginListItem[] }`

### Research Insights: Performance

Plugin manifest fetches in `listPlugins()` are currently sequential (20 plugins = 20 sequential GitHub API calls = ~4s). **Parallelize with `Promise.all()`** to reduce to ~400ms. This is a low-effort, high-impact optimization in `src/lib/plugins.ts`.

#### 1D. Composio Toolkit Discovery Routes (Tenant-Scoped)

**Files to create:**
- `src/app/api/composio/toolkits/route.ts` — `GET`
- `src/app/api/composio/tools/route.ts` — `GET`

These mirror the admin routes but with tenant API key auth.

**GET /api/composio/toolkits**
- Auth: `authenticateApiKey`
- **Rate limit:** Apply per-tenant rate limiting (30 req/min) to prevent Composio API quota exhaustion:
  ```typescript
  await checkRateLimit(`composio:${auth.tenantId}`, 30, 60_000);
  ```
- Reuse `listToolkits()` from `src/lib/composio.ts`
- Response: `{ data: ComposioToolkit[] }`

**GET /api/composio/tools?toolkit=X**
- Auth: `authenticateApiKey`
- Rate limit: same per-tenant limit
- Validate `toolkit` parameter: `^[a-z0-9_-]+$`
- Reuse `listTools(toolkit)` from `src/lib/composio.ts`
- Response: `{ data: ComposioTool[] }`

### Research Insights: Rate Limiting

The security review flagged that tenant-scoped proxy routes to Composio could exhaust the platform's API quota. Any tenant API key holder could trigger unlimited external API calls. Per-tenant rate limiting using the existing `checkRateLimit()` function is required.

#### 1E. Validation Schemas

**File to modify:** `src/lib/validation.ts`

Add:
- `CreateSkillSchema` — single `AgentSkillSchema` (reuse existing)
- `UpdateSkillSchema` — `{ files: z.array(AgentSkillFileSchema).min(1) }`
- `AddPluginSchema` — single `AgentPluginSchema` (reuse existing)
- `PluginMarketplacePublicRow` — marketplace row without `github_token_enc`

**Bug fix:** Add folder uniqueness refinement to existing `SkillsSchema`:
```typescript
.refine(
  (skills) => {
    const folders = skills.map(s => s.folder);
    return new Set(folders).size === folders.length;
  },
  { message: "Skill folder names must be unique" },
)
```

This is a pre-existing gap discovered during the data integrity review.

#### 1F. Middleware Update

**File to modify:** `src/middleware.ts`

Add new tenant route patterns to the API key auth matcher:
- `/api/plugin-marketplaces`
- `/api/composio/toolkits`
- `/api/composio/tools`

---

### Phase 2: SDK Resource Classes

New resource classes following the existing pattern (constructor takes `_client: AgentPlane`, methods delegate to `_client._request<T>()`).

#### 2A. SDK Types

**File to modify:** `sdk/src/types.ts`

**Critical: Types must match actual API wire format.** The API uses mixed casing — some endpoints return snake_case, others camelCase. Each type is audited below.

```typescript
// === Connectors (Composio) ===
// Wire format from GET /api/agents/:id/connectors — snake_case
export interface ConnectorInfo {
  slug: string;
  name: string;
  logo: string;
  auth_scheme: "OAUTH2" | "OAUTH1" | "API_KEY" | "NO_AUTH" | "OTHER";
  connected: boolean;
}

export interface SaveConnectorApiKeyParams {
  toolkit: string;
  api_key: string;
}

// Wire format from POST /api/agents/:id/connectors/:toolkit/initiate-oauth — snake_case
export interface ConnectorOauthResult {
  redirect_url: string;
}

// Wire format from GET /api/admin/composio/toolkits — verify actual shape
export interface ComposioToolkit {
  slug: string;
  name: string;
  logo: string;
  description: string;
  auth_scheme: string;
}

export interface ComposioTool {
  name: string;
  display_name: string;
  description: string;
}

// === Custom Connectors (MCP) ===
// Wire format from GET /api/mcp-servers — snake_case
export interface CustomConnectorServer {
  id: string;
  name: string;
  slug: string;
  description: string;
  logo_url: string | null;
}

// Wire format from GET /api/agents/:id/mcp-connections — snake_case (JOIN with server)
export interface CustomConnectorConnection {
  id: string;
  agent_id: string;
  mcp_server_id: string;
  status: "initiated" | "active" | "expired" | "failed";
  granted_scopes: string[];
  allowed_tools: string[];
  token_expires_at: string | null;
  server_name: string;
  server_slug: string;
  server_logo_url: string | null;
  server_base_url: string;
  created_at: string;
  updated_at: string;
}

// Wire format from GET /api/agents/:id/mcp-connections/:id/tools — MCP protocol tools/list
export interface CustomConnectorTool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;  // MCP protocol uses camelCase
}

// Wire format from POST /api/agents/:id/mcp-connections/:id/initiate-oauth — CAMELCASE!
export interface CustomConnectorOauthResult {
  redirectUrl: string;  // NOT redirect_url — the MCP route returns camelCase
}

// === Plugin Marketplaces ===
// Wire format from new GET /api/plugin-marketplaces — snake_case
export interface PluginMarketplace {
  id: string;
  name: string;
  github_repo: string;
  created_at: string;
  updated_at: string;
}

// Wire format from GET /api/plugin-marketplaces/:id/plugins — CAMELCASE!
export interface PluginListItem {
  name: string;
  displayName: string;       // NOT display_name — server returns camelCase
  description: string | null;
  version: string | null;
  author: string | null;
  hasSkills: boolean;        // NOT has_skills
  hasCommands: boolean;      // NOT has_commands
  hasMcpJson: boolean;       // NOT has_mcp_json
}
```

### Research Insights: Wire Format

The TypeScript reviewer discovered two critical wire format mismatches in the original plan:

1. **MCP `initiateOauth`** returns `{ redirectUrl }` (camelCase), while the Composio `initiate-oauth` returns `{ redirect_url }` (snake_case). These are different OAuth implementations with different response shapes. The SDK needs separate result types: `ConnectorOauthResult` vs `CustomConnectorOauthResult`.

2. **`PluginListItem`** uses camelCase on the wire (`displayName`, `hasSkills`, etc.) because the server-side `PluginListItem` in `src/lib/plugins.ts` uses camelCase. The plan originally assumed snake_case, which would break at runtime.

**Lesson:** Never assume a blanket casing convention. Always verify against the actual route handler's response shape.

#### 2B. Skills Resource

**File to create:** `sdk/src/resources/skills.ts`

```typescript
export class SkillsResource {
  constructor(private readonly _client: AgentPlane) {}

  async list(agentId: string): Promise<AgentSkill[]> {
    const resp = await this._client._request<{ data: AgentSkill[] }>(
      "GET", `/api/agents/${agentId}/skills`
    );
    return resp.data;
  }

  async get(agentId: string, folder: string): Promise<AgentSkill> {
    return this._client._request<AgentSkill>(
      "GET", `/api/agents/${agentId}/skills/${encodeURIComponent(folder)}`
    );
  }

  async create(agentId: string, skill: AgentSkill): Promise<AgentSkill> {
    return this._client._request<AgentSkill>(
      "POST", `/api/agents/${agentId}/skills`, { body: skill }
    );
  }

  async update(
    agentId: string,
    folder: string,
    params: { files: AgentSkillFile[] }
  ): Promise<AgentSkill> {
    return this._client._request<AgentSkill>(
      "PUT", `/api/agents/${agentId}/skills/${encodeURIComponent(folder)}`,
      { body: params }
    );
  }

  async delete(agentId: string, folder: string): Promise<void> {
    await this._client._request<unknown>(
      "DELETE", `/api/agents/${agentId}/skills/${encodeURIComponent(folder)}`
    );
  }
}
```

### Research Insights: URL Encoding

Folder names and plugin names appear in URL path segments. Use `encodeURIComponent()` for any user-provided value in a path segment to prevent path traversal via URL encoding tricks.

#### 2C. Plugins Resource

**File to create:** `sdk/src/resources/plugins.ts`

```typescript
export class PluginsResource {
  constructor(private readonly _client: AgentPlane) {}

  async list(agentId: string): Promise<AgentPlugin[]> {
    const resp = await this._client._request<{ data: AgentPlugin[] }>(
      "GET", `/api/agents/${agentId}/plugins`
    );
    return resp.data;
  }

  async add(agentId: string, plugin: AgentPlugin): Promise<AgentPlugin> {
    return this._client._request<AgentPlugin>(
      "POST", `/api/agents/${agentId}/plugins`, { body: plugin }
    );
  }

  async remove(
    agentId: string,
    marketplaceId: string,
    pluginName: string
  ): Promise<void> {
    await this._client._request<unknown>(
      "DELETE",
      `/api/agents/${agentId}/plugins/${encodeURIComponent(marketplaceId)}/${encodeURIComponent(pluginName)}`
    );
  }
}
```

#### 2D. Connectors Resource (Composio)

**File to create:** `sdk/src/resources/connectors.ts`

Merged into a single class (agent-scoped + top-level discovery):

```typescript
export class ConnectorsResource {
  constructor(private readonly _client: AgentPlane) {}

  // --- Agent-scoped methods ---

  async list(agentId: string): Promise<ConnectorInfo[]> {
    const resp = await this._client._request<{ data: ConnectorInfo[] }>(
      "GET", `/api/agents/${agentId}/connectors`
    );
    return resp.data;
  }

  async saveApiKey(
    agentId: string,
    params: SaveConnectorApiKeyParams
  ): Promise<{ slug: string; connected: boolean }> {
    return this._client._request(
      "POST", `/api/agents/${agentId}/connectors`, { body: params }
    );
  }

  async initiateOauth(
    agentId: string,
    toolkit: string
  ): Promise<ConnectorOauthResult> {
    return this._client._request<ConnectorOauthResult>(
      "POST", `/api/agents/${agentId}/connectors/${encodeURIComponent(toolkit)}/initiate-oauth`
    );
  }

  // --- Top-level discovery methods ---

  async availableToolkits(): Promise<ComposioToolkit[]> {
    const resp = await this._client._request<{ data: ComposioToolkit[] }>(
      "GET", "/api/composio/toolkits"
    );
    return resp.data;
  }

  async availableTools(toolkit: string): Promise<ComposioTool[]> {
    const resp = await this._client._request<{ data: ComposioTool[] }>(
      "GET", "/api/composio/tools", { query: { toolkit } }
    );
    return resp.data;
  }
}
```

### Research Insights: Merged Classes

The simplicity reviewer recommended merging `AgentConnectorsResource` + `ConnectorsResource` into one class. The distinction between agent-scoped methods (taking `agentId`) and discovery methods (no ID) is clear from the method signatures alone. One class, two concerns is fine when both are thin HTTP wrappers.

However, the client needs to mount this class in TWO places:
- `client.connectors.availableToolkits()` — top-level
- `client.agents.connectors.list(agentId)` — nested under agents

Solution: `AgentsResource` holds a reference to the same `ConnectorsResource` instance. Both `client.connectors` and `client.agents.connectors` point to the same object.

#### 2E. Custom Connectors Resource (MCP)

**File to create:** `sdk/src/resources/custom-connectors.ts`

Merged into a single class:

```typescript
export class CustomConnectorsResource {
  constructor(private readonly _client: AgentPlane) {}

  // --- Top-level method ---

  async listServers(): Promise<CustomConnectorServer[]> {
    const resp = await this._client._request<{ data: CustomConnectorServer[] }>(
      "GET", "/api/mcp-servers"
    );
    return resp.data;
  }

  // --- Agent-scoped methods ---

  async list(agentId: string): Promise<CustomConnectorConnection[]> {
    const resp = await this._client._request<{ data: CustomConnectorConnection[] }>(
      "GET", `/api/agents/${agentId}/mcp-connections`
    );
    return resp.data;
  }

  async delete(agentId: string, serverId: string): Promise<void> {
    await this._client._request<unknown>(
      "DELETE", `/api/agents/${agentId}/mcp-connections/${serverId}`
    );
  }

  async updateAllowedTools(
    agentId: string,
    serverId: string,
    allowedTools: string[]
  ): Promise<void> {
    await this._client._request<unknown>(
      "PATCH", `/api/agents/${agentId}/mcp-connections/${serverId}`,
      { body: { allowed_tools: allowedTools } }
    );
  }

  async listTools(
    agentId: string,
    serverId: string
  ): Promise<CustomConnectorTool[]> {
    const resp = await this._client._request<{ data: CustomConnectorTool[] }>(
      "GET", `/api/agents/${agentId}/mcp-connections/${serverId}/tools`
    );
    return resp.data;
  }

  async initiateOauth(
    agentId: string,
    serverId: string
  ): Promise<CustomConnectorOauthResult> {
    return this._client._request<CustomConnectorOauthResult>(
      "POST", `/api/agents/${agentId}/mcp-connections/${serverId}/initiate-oauth`
    );
  }
}
```

#### 2F. Plugin Marketplaces Resource

**File to create:** `sdk/src/resources/plugin-marketplaces.ts`

```typescript
export class PluginMarketplacesResource {
  constructor(private readonly _client: AgentPlane) {}

  async list(): Promise<PluginMarketplace[]> {
    const resp = await this._client._request<{ data: PluginMarketplace[] }>(
      "GET", "/api/plugin-marketplaces"
    );
    return resp.data;
  }

  async listPlugins(marketplaceId: string): Promise<PluginListItem[]> {
    const resp = await this._client._request<{ data: PluginListItem[] }>(
      "GET", `/api/plugin-marketplaces/${marketplaceId}/plugins`
    );
    return resp.data;
  }
}
```

#### 2G. Client Registration

**File to modify:** `sdk/src/client.ts`

```typescript
export class AgentPlane {
  readonly runs: RunsResource;
  readonly agents: AgentsResource;
  readonly connectors: ConnectorsResource;
  readonly customConnectors: CustomConnectorsResource;
  readonly pluginMarketplaces: PluginMarketplacesResource;

  constructor(options: AgentPlaneOptions = {}) {
    // ... existing init ...
    const connectors = new ConnectorsResource(this);
    const customConnectors = new CustomConnectorsResource(this);
    this.connectors = connectors;
    this.customConnectors = customConnectors;
    this.pluginMarketplaces = new PluginMarketplacesResource(this);
    this.runs = new RunsResource(this);
    this.agents = new AgentsResource(this, connectors, customConnectors);
  }
}
```

#### 2H. Agents Resource Update

**File to modify:** `sdk/src/resources/agents.ts`

Add sub-resource properties:

```typescript
export class AgentsResource {
  readonly skills: SkillsResource;
  readonly plugins: PluginsResource;
  readonly connectors: ConnectorsResource;
  readonly customConnectors: CustomConnectorsResource;

  constructor(
    private readonly _client: AgentPlane,
    connectors: ConnectorsResource,
    customConnectors: CustomConnectorsResource,
  ) {
    this.skills = new SkillsResource(_client);
    this.plugins = new PluginsResource(_client);
    this.connectors = connectors;          // shared instance
    this.customConnectors = customConnectors; // shared instance
  }
  // ... existing CRUD methods unchanged
}
```

### Research Insights: Shared Instances

`ConnectorsResource` and `CustomConnectorsResource` are shared between the top-level client and the `AgentsResource`. This avoids instantiating duplicate objects and ensures both `client.connectors` and `client.agents.connectors` reference the same instance. The `SkillsResource` and `PluginsResource` are only agent-scoped so they are created fresh.

#### 2I. Exports Update

**File to modify:** `sdk/src/index.ts`

Export all new types. Use `export type { ... }` for proper tree-shaking:

```typescript
export type {
  // ... existing exports ...
  ConnectorInfo, SaveConnectorApiKeyParams, ConnectorOauthResult,
  ComposioToolkit, ComposioTool,
  CustomConnectorServer, CustomConnectorConnection,
  CustomConnectorTool, CustomConnectorOauthResult,
  PluginMarketplace, PluginListItem,
} from "./types";
```

---

### Phase 3: SDK Tests

**Files to create:**
- `sdk/tests/resources/skills.test.ts`
- `sdk/tests/resources/plugins.test.ts`
- `sdk/tests/resources/connectors.test.ts`
- `sdk/tests/resources/custom-connectors.test.ts`
- `sdk/tests/resources/plugin-marketplaces.test.ts`

Follow existing test pattern: mock `fetch` injection via constructor, `vi.fn()`, helper factories.

### Research Insights: Testing

**Extract a `createClient` helper** shared across all test files:
```typescript
function createClient(mockFetch: ReturnType<typeof vi.fn>) {
  return new AgentPlane({
    apiKey: "ap_live_test1234567890abcdef12345678",
    baseUrl: "http://localhost:3000",
    fetch: mockFetch as unknown as typeof fetch,
  });
}
```

**What to test per method:**
- Correct HTTP method, URL path, and request body sent via mock fetch
- Response parsing matches expected types
- Error response (non-ok status) throws `AgentPlaneError`
- URL encoding of user-provided path segments (folder names, plugin names)

---

### Phase 4: Server-Side Tests

**Files to create in `tests/unit/`:**
- `skills-routes.test.ts` — test atomic JSONB skill operations
- `plugins-routes.test.ts` — test atomic JSONB plugin operations

Test the JSONB SQL patterns (append, filter, replace) with real SQL against a test database, or unit-test the Zod validation schemas.

---

## Acceptance Criteria

### Functional Requirements

- [x] `client.agents.skills.list(agentId)` returns all skills for an agent
- [x] `client.agents.skills.get(agentId, folder)` returns a single skill
- [x] `client.agents.skills.create(agentId, skill)` adds a skill; rejects duplicate folders (409)
- [x] `client.agents.skills.update(agentId, folder, params)` replaces skill files
- [x] `client.agents.skills.delete(agentId, folder)` removes a skill
- [x] `client.agents.plugins.list(agentId)` returns all plugins for an agent
- [x] `client.agents.plugins.add(agentId, plugin)` adds a plugin; validates marketplace exists
- [x] `client.agents.plugins.remove(agentId, marketplaceId, pluginName)` removes a plugin
- [x] `client.agents.connectors.list(agentId)` returns Composio connector statuses
- [x] `client.agents.connectors.saveApiKey(agentId, params)` saves an API key connector
- [x] `client.agents.connectors.initiateOauth(agentId, toolkit)` returns a redirect URL
- [x] `client.agents.customConnectors.list(agentId)` returns MCP connections with server metadata
- [x] `client.agents.customConnectors.delete(agentId, serverId)` removes a connection
- [x] `client.agents.customConnectors.updateAllowedTools(agentId, serverId, tools)` updates allowed tools
- [x] `client.agents.customConnectors.listTools(agentId, serverId)` lists available tools
- [x] `client.agents.customConnectors.initiateOauth(agentId, serverId)` returns redirect URL (camelCase)
- [x] `client.customConnectors.listServers()` returns available MCP servers
- [x] `client.pluginMarketplaces.list()` returns available marketplaces (no `github_token_enc`)
- [x] `client.pluginMarketplaces.listPlugins(marketplaceId)` returns plugins (camelCase fields)
- [x] `client.connectors.availableToolkits()` returns available Composio toolkits
- [x] `client.connectors.availableTools(toolkit)` returns tools in a toolkit

### Non-Functional Requirements

- [x] All new routes use `withErrorHandler` wrapper
- [x] All new routes export `export const dynamic = "force-dynamic"`
- [x] All new routes authenticate via `authenticateApiKey`
- [x] Skills/plugins CRUD uses atomic JSONB SQL (no read-modify-write)
- [x] No sensitive data leaked (no `github_token_enc`, no internal MCP credentials)
- [x] Composio proxy routes have per-tenant rate limiting (30 req/min)
- [x] User-provided path segments use `encodeURIComponent()` in SDK
- [x] SDK types match actual wire format (verified per-endpoint, not blanket convention)
- [x] SDK builds clean (`npm run sdk:build`)
- [x] SDK typechecks (`npm run sdk:typecheck`)
- [x] All SDK tests pass (`npm run sdk:test`)
- [x] Server tests pass (`npm run test`)

### Bug Fixes (Pre-existing)

- [x] Add skill folder uniqueness refinement to `SkillsSchema` in `validation.ts`
- [x] Create `PluginMarketplacePublicRow` schema excluding `github_token_enc`

---

## File Summary

### New files (server)

| File | Purpose |
|------|---------|
| `src/app/api/agents/[agentId]/skills/route.ts` | Skills list + create |
| `src/app/api/agents/[agentId]/skills/[folder]/route.ts` | Skill get + update + delete |
| `src/app/api/agents/[agentId]/plugins/route.ts` | Plugins list + add |
| `src/app/api/agents/[agentId]/plugins/[marketplaceId]/[pluginName]/route.ts` | Plugin remove |
| `src/app/api/plugin-marketplaces/route.ts` | Marketplace list (tenant) |
| `src/app/api/plugin-marketplaces/[marketplaceId]/plugins/route.ts` | Plugin listing (tenant) |
| `src/app/api/composio/toolkits/route.ts` | Toolkit listing (tenant, rate-limited) |
| `src/app/api/composio/tools/route.ts` | Tool listing (tenant, rate-limited) |

### New files (SDK)

| File | Purpose |
|------|---------|
| `sdk/src/resources/skills.ts` | SkillsResource class |
| `sdk/src/resources/plugins.ts` | PluginsResource class |
| `sdk/src/resources/connectors.ts` | ConnectorsResource (agent-scoped + discovery) |
| `sdk/src/resources/custom-connectors.ts` | CustomConnectorsResource (agent-scoped + registry) |
| `sdk/src/resources/plugin-marketplaces.ts` | PluginMarketplacesResource class |

### New files (tests)

| File | Purpose |
|------|---------|
| `sdk/tests/resources/skills.test.ts` | Skills resource tests |
| `sdk/tests/resources/plugins.test.ts` | Plugins resource tests |
| `sdk/tests/resources/connectors.test.ts` | Connectors resource tests |
| `sdk/tests/resources/custom-connectors.test.ts` | Custom connectors resource tests |
| `sdk/tests/resources/plugin-marketplaces.test.ts` | Plugin marketplaces resource tests |
| `tests/unit/skills-routes.test.ts` | Server-side skill CRUD tests |
| `tests/unit/plugins-routes.test.ts` | Server-side plugin CRUD tests |

### Modified files

| File | Change |
|------|--------|
| `src/lib/validation.ts` | Add `CreateSkillSchema`, `UpdateSkillSchema`, `AddPluginSchema`, `PluginMarketplacePublicRow`; fix `SkillsSchema` folder uniqueness |
| `src/middleware.ts` | Add new tenant route patterns |
| `sdk/src/client.ts` | Register new top-level resources, pass shared instances to AgentsResource |
| `sdk/src/resources/agents.ts` | Add sub-resource properties (skills, plugins, connectors, customConnectors) |
| `sdk/src/types.ts` | Add all new type interfaces (wire-format audited) |
| `sdk/src/index.ts` | Export new types |

---

## Security Checklist

From the security sentinel review:

| Requirement | Status |
|---|---|
| `authenticateApiKey()` on all new routes | Required |
| `github_token_enc` never in tenant responses | Required — use explicit column list |
| `client_secret_enc`/`access_token_enc`/`refresh_token_enc` never returned | Verified — existing Row vs RowInternal pattern |
| Skills CRUD reuses `SkillsSchema` validation pipeline | Required |
| Plugin `marketplace_id` validated against DB | Required |
| JSONB mutations use atomic SQL | Required — eliminates race conditions |
| Rate limiting on Composio proxy routes | Required — 30 req/min per tenant |
| `toolkit` parameter validated | Required — `^[a-z0-9_-]+$` |
| User-provided URL path segments encoded | Required — `encodeURIComponent()` |

---

## Performance Recommendations

From the performance oracle review (implement during or after this plan):

| Priority | Action | Impact | Effort |
|----------|--------|--------|--------|
| P0 | Atomic JSONB SQL for skill/plugin CRUD | Eliminates row lock contention | Low (included in plan) |
| P1 | Parallelize plugin manifest fetches in `listPlugins()` | 4s → 400ms for 20 plugins | Low |
| P1 | Add Composio toolkit metadata cache (15-min TTL) | Eliminates redundant external API calls | Low |
| P2 | Use HTTP driver for read-only queries | Frees connection pool for writes | Medium |

---

## Future Considerations

From the agent-native reviewer:

- **Agent self-service is correctly out of scope** for this plan. The SDK targets tenant developers.
- **Consider injecting agent context** (name, skills, plugins, connectors) into the sandbox as a read-only file. Zero auth complexity, immediate agent intelligence improvement.
- **Scoped agent tokens** (`ap_agent_*`) for agent self-management can be designed as a follow-up if needed.

---

## Sources & References

### Origin

- **Brainstorm document:** [docs/brainstorms/2026-03-01-sdk-full-resource-management-brainstorm.md](docs/brainstorms/2026-03-01-sdk-full-resource-management-brainstorm.md) — Key decisions carried forward: nested sub-resources with ID params, `connectors`/`customConnectors` naming, granular CRUD over inline updates, build routes + SDK together.

### Internal References

- SDK resource pattern: `sdk/src/resources/agents.ts`
- SDK test pattern: `sdk/tests/resources/runs.test.ts`
- API route pattern: `src/app/api/agents/[agentId]/connectors/route.ts`
- Validation schemas: `src/lib/validation.ts`
- Agent ownership check: `src/lib/agents.ts`
- Composio toolkit listing: `src/app/api/admin/composio/toolkits/route.ts`
- Plugin marketplace listing: `src/app/api/admin/plugin-marketplaces/route.ts`
- MCP connection response shape: `src/app/api/agents/[agentId]/mcp-connections/route.ts`
- MCP initiate OAuth (camelCase): `src/lib/mcp-connections.ts:176`
- Plugin list item (camelCase): `src/lib/plugins.ts:22-31`

### External References

- [Stripe Node.js SDK sub-resource patterns](https://github.com/stripe/stripe-node)
- [OpenAI Node.js SDK nested resources](https://github.com/openai/openai-node)
- [Anthropic TypeScript SDK error handling](https://github.com/anthropics/anthropic-sdk-typescript)
- [Semantic Versioning for TypeScript Types](https://www.semver-ts.org/)
