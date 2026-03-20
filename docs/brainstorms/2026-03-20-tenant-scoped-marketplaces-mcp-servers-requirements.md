---
date: 2026-03-20
topic: tenant-scoped-marketplaces-mcp-servers
---

# Tenant-Scoped Plugin Marketplaces & MCP Servers

## Problem Frame

Plugin Marketplaces and MCP Servers are currently global — shared across all tenants. With the new tenant-scoped admin UI, each tenant should own their own set of marketplaces and MCP servers, consistent with how agents, runs, and sessions are already tenant-scoped.

## Requirements

- R1. `plugin_marketplaces` table gets a `tenant_id` column with FK to `tenants(id)` and RLS
- R2. `mcp_servers` table gets a `tenant_id` column with FK to `tenants(id)` and RLS
- R3. Admin UI marketplace and MCP server pages filter by active tenant (same pattern as agents/runs)
- R4. Tenant-facing API endpoints for marketplaces and MCP servers scope by authenticated tenant
- R5. Existing global records are assigned to the first tenant (by created_at) via migration
- R6. `mcp_connections` already has tenant_id — no change needed, but verify FK integrity after mcp_servers gets tenant_id
- R7. Unique constraints updated: marketplace name + slug unique per tenant (not globally)

## Success Criteria

- No cross-tenant data visible in admin UI for marketplaces or MCP servers
- Existing data preserved (assigned to first tenant)
- All API endpoints enforce tenant scoping
- Migration is zero-downtime safe

## Scope Boundaries

- Not changing the Composio integration (it's account-level, not tenant-scoped)
- Not adding tenant-scoped OAuth credentials for MCP servers (connections already handle this)
- Not changing the plugin file fetching from GitHub (marketplace github_token stays per-marketplace)

## Key Decisions

- **Assign existing records to first tenant**: Avoids data loss. The migration picks the tenant with the earliest `created_at` and sets `tenant_id` for all existing rows.
- **RLS on both tables**: Consistent with agents/runs pattern. Fail-closed via `NULLIF`.

## Deferred to Planning

- [Affects R2][Technical] Should mcp_servers slug uniqueness be per-tenant or remain global?
- [Affects R6][Technical] Do any API routes reference mcp_servers without tenant context that would break?

## Next Steps

→ `/ce:plan` for structured implementation planning
