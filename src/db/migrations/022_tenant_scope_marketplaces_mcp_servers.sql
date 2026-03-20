-- Migration 022: Tenant-scope plugin_marketplaces and mcp_servers
-- Adds tenant_id FK, backfills existing rows to first tenant, enables RLS

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
