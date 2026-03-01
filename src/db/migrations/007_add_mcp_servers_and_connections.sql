-- Custom MCP Server Registry
-- Enables admins to register external MCP servers and tenants to connect them
-- to agents via OAuth 2.1 PKCE.

-- ============================================================
-- Helper: shared updated_at trigger function
-- ============================================================

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

-- ============================================================
-- mcp_servers: admin-managed registry (global, no RLS)
-- ============================================================

CREATE TABLE IF NOT EXISTS mcp_servers (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT NOT NULL,
  slug              TEXT NOT NULL UNIQUE,
  description       TEXT NOT NULL DEFAULT '',
  logo_url          TEXT,
  base_url          TEXT NOT NULL,
  mcp_endpoint_path TEXT NOT NULL DEFAULT '/mcp',
  client_id         TEXT,
  client_secret_enc TEXT,
  oauth_metadata    JSONB,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_mcp_servers_slug ON mcp_servers (slug);

CREATE TRIGGER mcp_servers_updated_at
  BEFORE UPDATE ON mcp_servers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Note: app_user gets full DML via ALTER DEFAULT PRIVILEGES in migration 001.
-- Admin-only writes are enforced at the application layer (ADMIN_API_KEY / cookie auth).

-- ============================================================
-- mcp_connections: per-agent OAuth connections (tenant-scoped)
-- ============================================================

CREATE TABLE IF NOT EXISTS mcp_connections (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id         UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id          UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  mcp_server_id     UUID NOT NULL REFERENCES mcp_servers(id) ON DELETE CASCADE,
  status            TEXT NOT NULL DEFAULT 'initiated'
                    CHECK (status IN ('initiated', 'active', 'expired', 'failed')),
  access_token_enc  TEXT,
  refresh_token_enc TEXT,
  granted_scopes    TEXT[] NOT NULL DEFAULT '{}',
  token_expires_at  TIMESTAMPTZ,
  oauth_state       TEXT,
  allowed_tools     TEXT[] NOT NULL DEFAULT '{}',
  code_verifier_enc TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One connection per agent-server pair
  UNIQUE (agent_id, mcp_server_id),

  -- Status-dependent field constraints
  CONSTRAINT active_requires_tokens CHECK (
    status != 'active' OR (access_token_enc IS NOT NULL AND token_expires_at IS NOT NULL)
  ),
  CONSTRAINT initiated_requires_verifier CHECK (
    status != 'initiated' OR (code_verifier_enc IS NOT NULL AND oauth_state IS NOT NULL)
  )
);

-- RLS: tenant isolation (fail-closed via NULLIF)
ALTER TABLE mcp_connections ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_connections FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON mcp_connections
  FOR ALL TO app_user
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- Partial index for the hot buildMcpConfig() read path
CREATE INDEX IF NOT EXISTS idx_mcp_connections_agent_active
  ON mcp_connections (agent_id) WHERE status = 'active';

-- Tenant-scoped queries
CREATE INDEX IF NOT EXISTS idx_mcp_connections_tenant
  ON mcp_connections (tenant_id);

-- Cascade lookups when deleting an MCP server
CREATE INDEX IF NOT EXISTS idx_mcp_connections_server
  ON mcp_connections (mcp_server_id);

CREATE TRIGGER mcp_connections_updated_at
  BEFORE UPDATE ON mcp_connections
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
