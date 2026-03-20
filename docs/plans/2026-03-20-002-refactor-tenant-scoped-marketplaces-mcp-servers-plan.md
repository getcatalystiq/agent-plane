---
title: "refactor: Tenant-scope Plugin Marketplaces & MCP Servers"
type: refactor
status: active
date: 2026-03-20
origin: docs/brainstorms/2026-03-20-tenant-scoped-marketplaces-mcp-servers-requirements.md
---

# refactor: Tenant-scope Plugin Marketplaces & MCP Servers

## Overview

Add `tenant_id` to `plugin_marketplaces` and `mcp_servers` tables, enable RLS, update all API routes and admin UI pages to scope by tenant. Existing records are assigned to the first tenant via migration. (see origin)

## Problem Statement

Both tables are currently global (no tenant_id, no RLS). With the new tenant-scoped admin UI, each tenant should own their own marketplaces and MCP servers, consistent with agents, runs, and sessions.

## Proposed Solution

Follow the exact pattern used by `agents` and `mcp_connections` tables: add `tenant_id` FK, enable RLS with `NULLIF(current_setting('app.current_tenant_id'))` policy, update unique constraints to be per-tenant.

## Technical Approach

### Migration: `src/db/migrations/022_tenant_scope_marketplaces_mcp_servers.sql`

```sql
-- 1. Add tenant_id to plugin_marketplaces
ALTER TABLE plugin_marketplaces ADD COLUMN tenant_id UUID REFERENCES tenants(id);

-- Assign existing rows to the first tenant (earliest created_at)
UPDATE plugin_marketplaces SET tenant_id = (SELECT id FROM tenants ORDER BY created_at ASC LIMIT 1);

-- Make NOT NULL after backfill
ALTER TABLE plugin_marketplaces ALTER COLUMN tenant_id SET NOT NULL;

-- Drop global unique on github_repo, add per-tenant unique
ALTER TABLE plugin_marketplaces DROP CONSTRAINT IF EXISTS plugin_marketplaces_github_repo_key;
CREATE UNIQUE INDEX plugin_marketplaces_tenant_repo ON plugin_marketplaces (tenant_id, github_repo);

-- RLS
ALTER TABLE plugin_marketplaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE plugin_marketplaces FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON plugin_marketplaces
  FOR ALL TO app_user
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- 2. Add tenant_id to mcp_servers
ALTER TABLE mcp_servers ADD COLUMN tenant_id UUID REFERENCES tenants(id);

-- Assign existing rows to the first tenant
UPDATE mcp_servers SET tenant_id = (SELECT id FROM tenants ORDER BY created_at ASC LIMIT 1);

-- Make NOT NULL after backfill
ALTER TABLE mcp_servers ALTER COLUMN tenant_id SET NOT NULL;

-- Drop global unique on slug, add per-tenant unique
DROP INDEX IF EXISTS idx_mcp_servers_slug;
CREATE UNIQUE INDEX mcp_servers_tenant_slug ON mcp_servers (tenant_id, slug);

-- RLS
ALTER TABLE mcp_servers ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_servers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mcp_servers
  FOR ALL TO app_user
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);
```

### Changes by File

#### DB & Types

- **`src/db/migrations/022_tenant_scope_marketplaces_mcp_servers.sql`** (new) — Migration above
- **`src/lib/validation.ts`** — Add `tenant_id` to `McpServerRow`, `PluginMarketplaceRow`, `CreateMcpServerSchema`, `CreatePluginMarketplaceSchema`

#### Admin API Routes (use ADMIN_API_KEY, no RLS — must filter manually)

- **`src/app/api/admin/mcp-servers/route.ts`** — GET: filter by active tenant from request (add `tenant_id` param or header). POST: require `tenant_id` in body.
- **`src/app/api/admin/mcp-servers/[mcpServerId]/route.ts`** — Verify server belongs to tenant before GET/PATCH
- **`src/app/api/admin/plugin-marketplaces/route.ts`** — GET: filter by tenant. POST: require `tenant_id`.
- **`src/app/api/admin/plugin-marketplaces/[marketplaceId]/route.ts`** — Verify marketplace belongs to tenant

#### Tenant API Routes (use API key + RLS)

- **`src/app/api/plugin-marketplaces/route.ts`** — Already uses tenant auth; RLS will auto-filter. No code change needed.
- **`src/app/api/plugin-marketplaces/[marketplaceId]/*/route.ts`** — Same; RLS handles it.
- **`src/app/api/mcp-servers/*/route.ts`** — Already uses tenant auth; RLS will auto-filter.

#### Admin UI Pages

- **`src/app/admin/(dashboard)/mcp-servers/page.tsx`** — Read active tenant, filter query by `tenant_id`, pass `tenantId` to `AddMcpServerForm`
- **`src/app/admin/(dashboard)/mcp-servers/add-server-form.tsx`** — Accept `tenantId` prop, include in POST body
- **`src/app/admin/(dashboard)/plugin-marketplaces/page.tsx`** — Read active tenant, filter query by `tenant_id`, pass `tenantId` to `AddMarketplaceForm`
- **`src/app/admin/(dashboard)/plugin-marketplaces/add-marketplace-form.tsx`** — Accept `tenantId` prop, include in POST body

## Acceptance Criteria

- [ ] Migration 022 runs successfully (zero-downtime: ADD COLUMN + UPDATE + SET NOT NULL)
- [ ] Existing records assigned to first tenant
- [ ] RLS enabled on both tables with tenant_isolation policy
- [ ] Unique constraints are per-tenant (tenant_id + github_repo, tenant_id + slug)
- [ ] Admin MCP servers page scoped to active tenant
- [ ] Admin marketplaces page scoped to active tenant
- [ ] Tenant API routes auto-filtered by RLS
- [ ] Admin API routes filter by tenant_id parameter
- [ ] No cross-tenant data leaks
- [ ] All existing tests pass

## Scope Boundaries (see origin)

- Not changing Composio integration (account-level)
- Not changing MCP OAuth credentials (connections already per-tenant)
- Not changing plugin file fetching from GitHub

## Sources & References

### Origin

- **Origin document:** [docs/brainstorms/2026-03-20-tenant-scoped-marketplaces-mcp-servers-requirements.md](docs/brainstorms/2026-03-20-tenant-scoped-marketplaces-mcp-servers-requirements.md) — Key decisions: assign existing records to first tenant, RLS on both tables, per-tenant unique constraints

### Internal References

- RLS pattern: `src/db/migrations/001_initial_schema.sql` (agents table)
- MCP connections RLS: `src/db/migrations/007_add_mcp_servers_and_connections.sql`
- Current highest migration: 021
