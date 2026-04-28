-- Webhook content-based dedupe.
--
-- Adds two columns to webhook_deliveries (dedupe_key, suppressed_by_run_id)
-- and creates webhook_dedupe_rules for tenant-scoped overrides on top of the
-- code-side platform defaults shipped in src/lib/webhook-dedupe.ts.

-- ============================================================
-- 1. webhook_deliveries: dedupe key + suppression link
-- ============================================================

ALTER TABLE webhook_deliveries
  ADD COLUMN IF NOT EXISTS dedupe_key TEXT NULL;

ALTER TABLE webhook_deliveries
  ADD COLUMN IF NOT EXISTS suppressed_by_run_id UUID NULL
    REFERENCES runs(id) ON DELETE SET NULL;

-- Partial index — only deliveries that carry a dedupe_key participate in the
-- window lookup. The DESC on created_at lets the lookup take a single row
-- with `ORDER BY created_at DESC LIMIT 1`.
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_dedupe
  ON webhook_deliveries (source_id, dedupe_key, created_at DESC)
  WHERE dedupe_key IS NOT NULL;

-- ============================================================
-- 2. webhook_dedupe_rules: per-tenant overrides
-- ============================================================
--
-- One row per (tenant, provider). Presence with enabled=true overrides the
-- platform default; presence with enabled=false explicitly disables dedupe
-- for that provider on this tenant; absence falls back to the platform
-- default in DEDUPE_DEFAULTS.

CREATE TABLE IF NOT EXISTS webhook_dedupe_rules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  provider        TEXT NOT NULL,
  key_path        TEXT NOT NULL,
  window_seconds  INTEGER NOT NULL,
  enabled         BOOLEAN NOT NULL DEFAULT true,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT webhook_dedupe_rules_window_check
    CHECK (window_seconds BETWEEN 1 AND 3600),

  CONSTRAINT webhook_dedupe_rules_provider_check
    CHECK (length(provider) BETWEEN 1 AND 50),

  CONSTRAINT webhook_dedupe_rules_key_path_check
    CHECK (length(key_path) BETWEEN 1 AND 200)
);

CREATE UNIQUE INDEX IF NOT EXISTS webhook_dedupe_rules_tenant_provider
  ON webhook_dedupe_rules (tenant_id, provider);

CREATE INDEX IF NOT EXISTS idx_webhook_dedupe_rules_tenant
  ON webhook_dedupe_rules (tenant_id);

ALTER TABLE webhook_dedupe_rules ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_dedupe_rules FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON webhook_dedupe_rules
  FOR ALL TO app_user
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE TRIGGER webhook_dedupe_rules_updated_at
  BEFORE UPDATE ON webhook_dedupe_rules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
