# SDK Full Resource Management

**Date:** 2026-03-01
**Status:** Brainstorm

## What We're Building

Expand the AgentPlane TypeScript SDK to expose full management of skills, plugins, connectors (Composio), and custom connectors (MCP servers) — both new API routes and SDK resource classes.

### Current State

The SDK (`@getcatalystiq/agent-plane`) currently exposes:
- `client.agents` — CRUD (create, get, list, update, delete)
- `client.runs` — create, createAndWait, get, list, cancel, transcript

Skills and plugins can be set inline via `agent.create()` / `agent.update()`, but there are no granular sub-resource operations. Connectors and custom connectors have API routes but no SDK wrappers.

### Target State

```typescript
// Composio connectors
client.agents.connectors.list(agentId)
client.agents.connectors.saveApiKey(agentId, { toolkit, apiKey })
client.agents.connectors.initiateOauth(agentId, toolkit)

// Custom connectors (MCP connections)
client.agents.customConnectors.list(agentId)
client.agents.customConnectors.delete(agentId, serverId)
client.agents.customConnectors.updateAllowedTools(agentId, serverId, tools)
client.agents.customConnectors.listTools(agentId, serverId)
client.agents.customConnectors.initiateOauth(agentId, serverId)

// Skills (NEW API routes + SDK)
client.agents.skills.list(agentId)
client.agents.skills.get(agentId, folder)
client.agents.skills.create(agentId, skill)
client.agents.skills.update(agentId, folder, skill)
client.agents.skills.delete(agentId, folder)

// Plugins (NEW API routes + SDK)
client.agents.plugins.list(agentId)
client.agents.plugins.add(agentId, plugin)
client.agents.plugins.remove(agentId, marketplaceId, pluginName)

// Custom connector servers (MCP server registry, read-only)
client.customConnectors.list()

// Plugin marketplaces & plugin discovery (NEW tenant routes + SDK)
client.pluginMarketplaces.list()
client.pluginMarketplaces.listPlugins(marketplaceId)

// Composio toolkit discovery (NEW tenant routes + SDK)
client.connectors.availableToolkits()
client.connectors.availableTools(toolkit)
```

## Why This Approach

### Nested sub-resource classes

Chosen over scoped agent instances (`client.agents.for(id).skills.list()`) because:
1. Matches the existing SDK pattern — `RunsResource` and `AgentsResource` both take IDs as method params
2. Each resource class is small, focused, and independently testable
3. No new abstraction layer needed
4. Verbosity is minimal — passing `agentId` is explicit and clear

### Naming decisions

| SDK name | Maps to | Rationale |
|----------|---------|-----------|
| `connectors` | Composio connectors | Direct name for managed SaaS integrations |
| `customConnectors` | MCP connections | Clearer than "mcpConnections" — users don't need to know MCP protocol |
| `skills` | Agent skills JSONB | Direct and clear |
| `plugins` | Agent plugins JSONB | Direct and clear |
| `client.customConnectors` | MCP server registry | Read-only list of available custom connector servers |

### Granular skills/plugins CRUD

New server-side routes so the SDK can add/remove individual skills and plugins without sending the full agent update payload. This prevents race conditions and is more ergonomic for programmatic use.

## Key Decisions

1. **API shape:** Nested sub-resources with agent ID parameter (Approach 1)
2. **Naming:** `connectors` (Composio), `customConnectors` (MCP), `skills`, `plugins`
3. **OAuth handling:** SDK returns redirect URL only; caller manages browser flow
4. **Scope:** Build API routes AND SDK together (end-to-end)
5. **New routes needed:** Granular skills CRUD + granular plugins CRUD on the server side

## Scope Breakdown

### Wrapping existing routes (SDK only)

| Resource | Methods | Existing API Route |
|----------|---------|--------------------|
| `agents.connectors` | list, saveApiKey, initiateOauth | `GET/POST /api/agents/:id/connectors`, `POST .../initiate-oauth` |
| `agents.customConnectors` | list, delete, updateAllowedTools, listTools, initiateOauth | `/api/agents/:id/mcp-connections/*` |
| `customConnectors` | list | `GET /api/mcp-servers` |

### New API routes + SDK

| Resource | Methods | New Route |
|----------|---------|-----------|
| `agents.skills` | list, get, create, update, delete | `GET/POST /api/agents/:id/skills`, `GET/PUT/DELETE /api/agents/:id/skills/:folder` |
| `agents.plugins` | list, add, remove | `GET/POST /api/agents/:id/plugins`, `DELETE /api/agents/:id/plugins/:marketplaceId/:pluginName` |
| `pluginMarketplaces` | list, listPlugins | `GET /api/plugin-marketplaces`, `GET /api/plugin-marketplaces/:id/plugins` |
| `connectors` (top-level) | availableToolkits, availableTools | `GET /api/composio/toolkits`, `GET /api/composio/tools?toolkit=X` |

### SDK types to add

- `ConnectorInfo` — maps to `TenantConnectorInfo`
- `CustomConnectorConnection` — maps to MCP connection row + server info
- `CustomConnectorServer` — maps to MCP server (public fields only)
- `CustomConnectorTool` — tool listed from an MCP server
- `SaveApiKeyParams`, `InitiateOauthResult`
- `PluginMarketplace` — marketplace listing (id, name, github_repo)
- `PluginListItem` — plugin summary (name, displayName, description, version, hasSkills, etc.)
- `ComposioToolkit` — available toolkit info
- `ComposioTool` — tool within a toolkit
- Skill and Plugin types already exist in SDK types

## Resolved Questions

1. **Plugin marketplace listing:** Yes — add tenant-scoped `GET /api/plugin-marketplaces` and `GET /api/plugin-marketplaces/:id/plugins` so tenants can discover available plugins via `client.pluginMarketplaces.list()` and `client.pluginMarketplaces.listPlugins(id)`.
2. **Composio toolkit discovery:** Yes — add tenant-scoped `GET /api/composio/toolkits` and `GET /api/composio/tools` so tenants can discover available integrations via `client.connectors.availableToolkits()` and `client.connectors.availableTools(toolkit)`.

## Open Questions

None remaining.
