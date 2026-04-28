-- Webhook Triggers: external systems POST signed events to trigger agent runs.
-- Adds webhook_sources (config) + webhook_deliveries (audit/idempotency),
-- extends runs.triggered_by to include 'webhook', and adds runs.webhook_source_id.

-- ============================================================
-- 1. webhook_sources: per-agent inbound webhook configuration (tenant-scoped)
-- ============================================================

CREATE TABLE IF NOT EXISTS webhook_sources (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                   UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id                    UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name                        TEXT NOT NULL,
  enabled                     BOOLEAN NOT NULL DEFAULT TRUE,
  signature_header            TEXT NOT NULL DEFAULT 'X-AgentPlane-Signature',
  signature_format            TEXT NOT NULL DEFAULT 'sha256_hex',
  secret_enc                  TEXT NOT NULL,
  previous_secret_enc         TEXT,
  previous_secret_expires_at  TIMESTAMPTZ,
  prompt_template             TEXT NOT NULL,
  last_triggered_at           TIMESTAMPTZ,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT now(),

  CONSTRAINT webhook_sources_signature_format_check
    CHECK (signature_format IN ('sha256_hex')),

  CONSTRAINT webhook_sources_previous_secret_consistency CHECK (
    (previous_secret_enc IS NULL AND previous_secret_expires_at IS NULL) OR
    (previous_secret_enc IS NOT NULL AND previous_secret_expires_at IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_webhook_sources_tenant
  ON webhook_sources (tenant_id);

CREATE INDEX IF NOT EXISTS idx_webhook_sources_agent
  ON webhook_sources (agent_id);

CREATE UNIQUE INDEX IF NOT EXISTS webhook_sources_tenant_name
  ON webhook_sources (tenant_id, name);

ALTER TABLE webhook_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_sources FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON webhook_sources
  FOR ALL TO app_user
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE TRIGGER webhook_sources_updated_at
  BEFORE UPDATE ON webhook_sources
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- 2. webhook_deliveries: per-request audit + idempotency log (tenant-scoped)
-- ============================================================

CREATE TABLE IF NOT EXISTS webhook_deliveries (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source_id     UUID NOT NULL REFERENCES webhook_sources(id) ON DELETE CASCADE,
  delivery_id   TEXT NOT NULL,
  payload_hash  TEXT NOT NULL,
  valid         BOOLEAN NOT NULL,
  error         TEXT,
  run_id        UUID REFERENCES runs(id) ON DELETE SET NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Unique-per-source delivery_id supports the 200-duplicate idempotency path.
CREATE UNIQUE INDEX IF NOT EXISTS webhook_deliveries_source_delivery
  ON webhook_deliveries (source_id, delivery_id);

-- Recent-deliveries listing for the admin UI.
CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_source_created
  ON webhook_deliveries (source_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_tenant
  ON webhook_deliveries (tenant_id);

ALTER TABLE webhook_deliveries ENABLE ROW LEVEL SECURITY;
ALTER TABLE webhook_deliveries FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON webhook_deliveries
  FOR ALL TO app_user
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- ============================================================
-- 3. runs.webhook_source_id: link finalized runs back to the source
-- ============================================================
-- Nullable; ON DELETE SET NULL preserves run history when a source is removed.

ALTER TABLE runs
  ADD COLUMN IF NOT EXISTS webhook_source_id UUID REFERENCES webhook_sources(id) ON DELETE SET NULL;

-- ============================================================
-- 4. Extend runs.triggered_by CHECK to include 'webhook'
-- ============================================================
-- Mirrors migration 016: drop ALL triggered_by CHECK constraints, then add the new one.

DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY(con.conkey)
    WHERE con.conrelid = 'runs'::regclass
      AND con.contype = 'c'
      AND att.attname = 'triggered_by'
  LOOP
    EXECUTE format('ALTER TABLE runs DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE runs ADD CONSTRAINT runs_triggered_by_check
  CHECK (triggered_by IN ('api', 'schedule', 'playground', 'chat', 'a2a', 'webhook'))
  NOT VALID;
ALTER TABLE runs VALIDATE CONSTRAINT runs_triggered_by_check;
