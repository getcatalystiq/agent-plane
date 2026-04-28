-- U1: Unify runs + sessions into a session-first execution model.
--
-- Drops the legacy `runs` table and the existing two-purpose `sessions` table,
-- then creates a clean `sessions` + `session_messages` pair. Session_messages
-- owns billing-grade fields (cost, tokens, transcript_blob_url, triggered_by,
-- created_by_key_id, webhook_source_id, etc.). Sessions owns lifecycle state
-- + sandbox identity + idle-TTL config.
--
-- All historical run data is intentionally dropped at cutover (R13).
--
-- FKs that point INTO `runs.id` (must be explicitly dropped first; no CASCADE):
--   - webhook_deliveries.run_id              -- migration 029
--   - webhook_deliveries.suppressed_by_run_id -- migration 031
-- Both are retargeted at the new `session_messages.id` table after creation.
--
-- FKs that point INTO `sessions.id`:
--   - runs.session_id  -- migration 014, dropped together with the runs table.
--
-- Sandboxes are tracked exclusively via `sessions.sandbox_id` going forward.
-- Tenant concurrency cap (50 active sessions) is enforced in code.

-- ============================================================
-- 1. Drop FKs from webhook_deliveries that point into runs(id).
--    Use a dynamic loop so we tolerate auto-generated constraint names.
-- ============================================================

DO $$
DECLARE
  r RECORD;
  has_runs BOOLEAN;
BEGIN
  -- Idempotent: the table may already be gone if the migration is re-run.
  SELECT EXISTS (
    SELECT 1 FROM pg_class c
    JOIN pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relname = 'runs' AND n.nspname = 'public'
  ) INTO has_runs;

  IF has_runs THEN
    FOR r IN
      SELECT con.conname, con.conrelid::regclass::text AS tbl
      FROM pg_constraint con
      WHERE con.contype = 'f'
        AND con.confrelid = 'runs'::regclass
    LOOP
      EXECUTE format('ALTER TABLE %s DROP CONSTRAINT IF EXISTS %I', r.tbl, r.conname);
    END LOOP;
  END IF;
END $$;

-- ============================================================
-- 2. Rename retained columns on webhook_deliveries.
--    The values stored in run_id / suppressed_by_run_id pointed at
--    rows in the now-defunct `runs` table. We DO NOT keep those values:
--    they are stale references that would be dangling foreign keys.
--    Set both to NULL before renaming so the new FK against
--    session_messages(id) can be added without orphan rows.
-- ============================================================

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM information_schema.columns
    WHERE table_name = 'webhook_deliveries' AND column_name = 'run_id'
  ) THEN
    UPDATE webhook_deliveries SET run_id = NULL, suppressed_by_run_id = NULL;
    ALTER TABLE webhook_deliveries RENAME COLUMN run_id TO message_id;
    ALTER TABLE webhook_deliveries RENAME COLUMN suppressed_by_run_id TO suppressed_by_message_id;
  END IF;
END $$;

-- ============================================================
-- 3. Drop the legacy tables (no CASCADE — every FK was handled above).
-- ============================================================

DROP TABLE IF EXISTS runs;
DROP TABLE IF EXISTS sessions;

-- ============================================================
-- 4. Create the new `sessions` table.
--
-- Column notes:
--   - status: 'creating' | 'active' | 'idle' | 'stopped'.
--   - ephemeral: when true, the dispatcher stops the sandbox synchronously
--     after the message terminal event. Default false (persistent).
--   - idle_ttl_seconds: per-session TTL (server-set only, never client input).
--     CHECK caps at 3600s. Cleanup cron uses this with idle_since.
--   - expires_at: hard 4h wall-clock cap regardless of idle TTL — bounds the
--     contextId-reuse warm-sandbox attack surface (DoS bound).
--   - context_id: A2A multi-turn-via-contextId reuse key. NULL except for
--     A2A sessions that opt into reuse.
-- ============================================================

CREATE TABLE IF NOT EXISTS sessions (
  id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id          UUID NOT NULL,
  agent_id           UUID NOT NULL,
  sandbox_id         TEXT,
  sdk_session_id     TEXT,
  session_blob_url   TEXT,
  status             TEXT NOT NULL DEFAULT 'creating'
                     CHECK (status IN ('creating', 'active', 'idle', 'stopped')),
  ephemeral          BOOLEAN NOT NULL DEFAULT FALSE,
  idle_ttl_seconds   INTEGER NOT NULL DEFAULT 600
                     CHECK (idle_ttl_seconds > 0 AND idle_ttl_seconds <= 3600),
  expires_at         TIMESTAMPTZ NOT NULL,
  context_id         TEXT,
  message_count      INTEGER NOT NULL DEFAULT 0,
  idle_since         TIMESTAMPTZ,
  last_backup_at     TIMESTAMPTZ,
  mcp_refreshed_at   TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Composite FK keeps a session anchored to the same tenant as its agent.
  CONSTRAINT fk_sessions_agent_tenant FOREIGN KEY (agent_id, tenant_id)
    REFERENCES agents(id, tenant_id) ON DELETE CASCADE
);

-- ============================================================
-- 5. Create `session_messages`.
--
-- One row per execution (what the legacy `runs` table represented).
-- All billing-grade and audit fields live here at the message grain.
-- ============================================================

CREATE TABLE IF NOT EXISTS session_messages (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  session_id               UUID NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  tenant_id                UUID NOT NULL,
  prompt                   TEXT NOT NULL,
  status                   TEXT NOT NULL DEFAULT 'queued'
                           CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled', 'timed_out')),
  triggered_by             TEXT NOT NULL
                           CHECK (triggered_by IN ('api', 'schedule', 'playground', 'chat', 'a2a', 'webhook')),
  runner                   TEXT
                           CHECK (runner IS NULL OR runner IN ('claude-agent-sdk', 'vercel-ai-sdk')),

  -- Billing & usage
  cost_usd                 NUMERIC(10, 6) NOT NULL DEFAULT 0,
  total_input_tokens       BIGINT NOT NULL DEFAULT 0,
  total_output_tokens      BIGINT NOT NULL DEFAULT 0,
  cache_read_tokens        BIGINT NOT NULL DEFAULT 0,
  cache_creation_tokens    BIGINT NOT NULL DEFAULT 0,
  num_turns                INTEGER NOT NULL DEFAULT 0,
  duration_ms              INTEGER NOT NULL DEFAULT 0,
  duration_api_ms          INTEGER NOT NULL DEFAULT 0,
  model_usage              JSONB,

  -- Output / errors
  transcript_blob_url      VARCHAR(2048),
  result_summary           TEXT,
  error_type               VARCHAR(100),
  error_messages           TEXT[] NOT NULL DEFAULT '{}',

  -- Audit & trigger linkage
  webhook_source_id        UUID REFERENCES webhook_sources(id) ON DELETE SET NULL,
  created_by_key_id        UUID REFERENCES api_keys(id) ON DELETE SET NULL,

  started_at               TIMESTAMPTZ,
  completed_at             TIMESTAMPTZ,
  created_at               TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- ============================================================
-- 6. Indexes
-- ============================================================

-- Sessions: tenant-scoped queries
CREATE INDEX IF NOT EXISTS idx_sessions_tenant_status
  ON sessions (tenant_id, status);

CREATE INDEX IF NOT EXISTS idx_sessions_tenant_agent_created
  ON sessions (tenant_id, agent_id, created_at DESC);

-- Cleanup cron: scan for sessions past their hard expiry across all states.
CREATE INDEX IF NOT EXISTS idx_sessions_tenant_status_expires
  ON sessions (tenant_id, status, expires_at);

-- Cleanup cron: idle-TTL check via idle_since
CREATE INDEX IF NOT EXISTS idx_sessions_idle
  ON sessions (status, idle_since)
  WHERE status = 'idle';

-- A2A multi-turn-via-contextId reuse lookup. Predicate mirrors migration 027
-- exactly: only one non-stopped session may hold a given (tenant, agent, ctx).
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_context_id_active
  ON sessions (tenant_id, agent_id, context_id)
  WHERE status NOT IN ('stopped') AND context_id IS NOT NULL;

-- session_messages: tenant-scoped lists, per-session message lists, status
CREATE INDEX IF NOT EXISTS idx_session_messages_tenant_created
  ON session_messages (tenant_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_session_messages_session_created
  ON session_messages (session_id, created_at);

CREATE INDEX IF NOT EXISTS idx_session_messages_tenant_status
  ON session_messages (tenant_id, status);

-- Active-message check (in-session concurrency 409): partial index keeps it cheap.
CREATE INDEX IF NOT EXISTS idx_session_messages_active
  ON session_messages (session_id)
  WHERE status IN ('queued', 'running');

-- Budget aggregation covering index (mirrors legacy idx_runs_tenant_monthly_cost)
CREATE INDEX IF NOT EXISTS idx_session_messages_tenant_monthly_cost
  ON session_messages (tenant_id, created_at) INCLUDE (cost_usd);

-- ============================================================
-- 7. Row-Level Security
--
-- Both tables MUST enforce tenant isolation. session_messages holds prompt
-- text and billing data, so it gets its own explicit policy (not implied by
-- the parent `sessions` policy).
-- ============================================================

ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
ALTER TABLE sessions FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON sessions;
CREATE POLICY tenant_isolation ON sessions
  FOR ALL TO app_user
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

ALTER TABLE session_messages ENABLE ROW LEVEL SECURITY;
ALTER TABLE session_messages FORCE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON session_messages;
CREATE POLICY tenant_isolation ON session_messages
  FOR ALL TO app_user
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- ============================================================
-- 8. Triggers
-- ============================================================

DROP TRIGGER IF EXISTS sessions_updated_at ON sessions;
CREATE TRIGGER sessions_updated_at
  BEFORE UPDATE ON sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- 9. Grant permissions to app_user
-- ============================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON sessions TO app_user;
GRANT SELECT, INSERT, UPDATE, DELETE ON session_messages TO app_user;

-- ============================================================
-- 10. Re-add the FKs that previously pointed at runs(id).
--     They now point at session_messages(id).
-- ============================================================

ALTER TABLE webhook_deliveries
  DROP CONSTRAINT IF EXISTS webhook_deliveries_message_id_fkey;
ALTER TABLE webhook_deliveries
  ADD CONSTRAINT webhook_deliveries_message_id_fkey
  FOREIGN KEY (message_id)
  REFERENCES session_messages(id)
  ON DELETE SET NULL;

ALTER TABLE webhook_deliveries
  DROP CONSTRAINT IF EXISTS webhook_deliveries_suppressed_by_message_id_fkey;
ALTER TABLE webhook_deliveries
  ADD CONSTRAINT webhook_deliveries_suppressed_by_message_id_fkey
  FOREIGN KEY (suppressed_by_message_id)
  REFERENCES session_messages(id)
  ON DELETE SET NULL;

-- The dedupe lookup index from migration 031 referenced `created_at DESC` on
-- webhook_deliveries — it does not reference run_id directly so it survives
-- the column rename. Likewise for the (source_id, delivery_id) unique index.
