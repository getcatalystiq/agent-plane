-- AgentPlane Initial Schema
-- Requires: DATABASE_URL_DIRECT (superuser) for role creation and RLS setup

-- Create application role (RLS policies apply to this role)
DO $$
BEGIN
  IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = 'app_user') THEN
    CREATE ROLE app_user LOGIN;
  END IF;
END
$$;

-- Enable UUID generation
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ============================================================
-- Tables
-- ============================================================

CREATE TABLE IF NOT EXISTS tenants (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name VARCHAR(255) NOT NULL,
  slug VARCHAR(100) NOT NULL UNIQUE,
  settings JSONB NOT NULL DEFAULT '{}',
  monthly_budget_usd NUMERIC(10, 2) NOT NULL DEFAULT 100.00,
  status VARCHAR(20) NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'suspended')),
  current_month_spend NUMERIC(10, 6) NOT NULL DEFAULT 0,
  spend_period_start TIMESTAMPTZ NOT NULL DEFAULT date_trunc('month', NOW()),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS api_keys (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL DEFAULT 'default',
  key_prefix VARCHAR(20) NOT NULL,
  key_hash VARCHAR(64) NOT NULL UNIQUE,
  scopes TEXT[] NOT NULL DEFAULT '{}',
  last_used_at TIMESTAMPTZ,
  expires_at TIMESTAMPTZ,
  revoked_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS agents (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  description TEXT,
  git_repo_url VARCHAR(2048),
  git_branch VARCHAR(255) NOT NULL DEFAULT 'main',
  github_installation_id VARCHAR(255),
  composio_entity_id VARCHAR(255),
  composio_toolkits TEXT[] NOT NULL DEFAULT '{}',
  model VARCHAR(100) NOT NULL DEFAULT 'claude-sonnet-4-5-20250929',
  allowed_tools TEXT[] NOT NULL DEFAULT ARRAY['Read', 'Edit', 'Write', 'Glob', 'Grep', 'Bash', 'WebSearch'],
  permission_mode VARCHAR(50) NOT NULL DEFAULT 'bypassPermissions'
    CHECK (permission_mode IN ('default', 'acceptEdits', 'bypassPermissions', 'plan')),
  max_turns INTEGER NOT NULL DEFAULT 100
    CHECK (max_turns BETWEEN 1 AND 1000),
  max_budget_usd NUMERIC(10, 6) NOT NULL DEFAULT 1.00
    CHECK (max_budget_usd BETWEEN 0.01 AND 100.00),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Composite unique: agent names unique per tenant
  UNIQUE(tenant_id, name)
);

-- Composite unique for referential integrity on runs
ALTER TABLE agents ADD CONSTRAINT agents_id_tenant_id_unique UNIQUE(id, tenant_id);

CREATE TABLE IF NOT EXISTS runs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  agent_id UUID NOT NULL,
  tenant_id UUID NOT NULL,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'running', 'completed', 'failed', 'cancelled', 'timed_out')),
  prompt TEXT NOT NULL,
  result_summary TEXT,
  total_input_tokens BIGINT NOT NULL DEFAULT 0,
  total_output_tokens BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens BIGINT NOT NULL DEFAULT 0,
  cache_creation_tokens BIGINT NOT NULL DEFAULT 0,
  cost_usd NUMERIC(10, 6) NOT NULL DEFAULT 0,
  num_turns INTEGER NOT NULL DEFAULT 0,
  duration_ms INTEGER NOT NULL DEFAULT 0,
  duration_api_ms INTEGER NOT NULL DEFAULT 0,
  model_usage JSONB,
  transcript_blob_url VARCHAR(2048),
  error_type VARCHAR(100),
  error_messages TEXT[] NOT NULL DEFAULT '{}',
  sandbox_id VARCHAR(255),
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Composite FK: prevent runs referencing agent from different tenant
  CONSTRAINT fk_runs_agent_tenant FOREIGN KEY (agent_id, tenant_id)
    REFERENCES agents(id, tenant_id) ON DELETE CASCADE
);

-- ============================================================
-- Indexes
-- ============================================================

-- Auth hot path: active API key lookup
CREATE INDEX idx_api_keys_active ON api_keys (key_hash) WHERE revoked_at IS NULL;

-- Tenant-scoped queries
CREATE INDEX idx_agents_tenant ON agents (tenant_id);
CREATE INDEX idx_runs_tenant_created ON runs (tenant_id, created_at DESC);
CREATE INDEX idx_runs_tenant_status ON runs (tenant_id, status);
CREATE INDEX idx_runs_agent ON runs (agent_id);

-- Partial index for active runs (concurrency checks)
CREATE INDEX idx_runs_active ON runs (tenant_id) WHERE status IN ('pending', 'running');

-- Budget aggregation covering index
CREATE INDEX idx_runs_tenant_monthly_cost ON runs (tenant_id, created_at) INCLUDE (cost_usd);

-- ============================================================
-- Row-Level Security
-- ============================================================

ALTER TABLE tenants ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenants FORCE ROW LEVEL SECURITY;
ALTER TABLE api_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_keys FORCE ROW LEVEL SECURITY;
ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents FORCE ROW LEVEL SECURITY;
ALTER TABLE runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE runs FORCE ROW LEVEL SECURITY;

-- Fail-closed: NULLIF ensures unset tenant context returns no rows
CREATE POLICY tenant_isolation ON tenants
  FOR ALL TO app_user
  USING (id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation ON api_keys
  FOR ALL TO app_user
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation ON agents
  FOR ALL TO app_user
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE POLICY tenant_isolation ON runs
  FOR ALL TO app_user
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- ============================================================
-- Grant permissions to app_user
-- ============================================================

GRANT USAGE ON SCHEMA public TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_user;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_user;

-- ============================================================
-- Migration tracking table (owned by superuser, not RLS)
-- ============================================================

CREATE TABLE IF NOT EXISTS _migrations (
  id SERIAL PRIMARY KEY,
  name VARCHAR(255) NOT NULL UNIQUE,
  checksum VARCHAR(64) NOT NULL,
  applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
