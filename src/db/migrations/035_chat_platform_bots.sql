-- Chat Platform Bots — per-agent Discord/Slack bot configuration.
--
-- Plan reference: U1 in
-- docs/plans/2026-05-06-001-feat-chat-platform-bots-discord-slack-plan.md
--
-- Adds:
--   * `chat_platform` enum (`discord`, `slack`).
--   * `platform_bot_configs` — one encrypted-credential row per
--     (tenant_id, agent_id, platform), with attestation gate (R19) and
--     observability columns (last_event_at / last_error / last_connected_at).
--   * `tenants.max_trusted_members` — per-tenant override for the workspace
--     size threshold enforced by the attestation gate. Default 100.
--
-- RLS: tenant isolation via the standard `app.current_tenant_id` setting
-- (fail-closed via NULLIF). Mirrors `mcp_connections` from migration 007.

-- ============================================================
-- chat_platform enum
-- ============================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'chat_platform') THEN
    CREATE TYPE chat_platform AS ENUM ('discord', 'slack');
  END IF;
END$$;

-- ============================================================
-- tenants.max_trusted_members — R19 per-tenant override
-- ============================================================

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS max_trusted_members INTEGER NOT NULL DEFAULT 100
  CONSTRAINT max_trusted_members_positive CHECK (max_trusted_members > 0);

-- ============================================================
-- platform_bot_configs (tenant-scoped, RLS)
-- ============================================================

CREATE TABLE IF NOT EXISTS platform_bot_configs (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id            UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  platform            chat_platform NOT NULL,

  -- Encrypted JSON envelope ({ version, iv, ciphertext }) carrying the
  -- platform-specific credential payload. Decrypted via crypto.decrypt with
  -- ENCRYPTION_KEY (with ENCRYPTION_KEY_PREVIOUS fallback during rotation).
  credentials_enc     TEXT NOT NULL,
  credentials_version INTEGER NOT NULL DEFAULT 1,

  -- Per-platform identity captured at connect time. For Discord:
  -- { application_id, public_key, bot_user_id, member_count_at_connect }.
  -- For Slack: { team_id, app_id, bot_user_id, member_count_at_connect }.
  platform_identity   JSONB NOT NULL DEFAULT '{}'::jsonb,

  -- Attestations gating the connect (R19). Required key:
  --   { "private_workspace": true, "attested_at": "<iso8601>", "attested_by_admin": true }
  -- The application layer rejects upserts without `private_workspace = true`.
  attestations        JSONB NOT NULL DEFAULT '{}'::jsonb,

  enabled             BOOLEAN NOT NULL DEFAULT true,

  -- Observability (R18 / U8 connection-state derivation):
  --   `last_connected_at` set on first Gateway connection or first verified
  --     Slack event delivery.
  --   `last_event_at` updated by markBotEvent on each verified inbound event.
  --   `last_error` carries the last platform error verbatim; cleared by
  --     markBotEvent on next success.
  last_connected_at   TIMESTAMPTZ,
  last_event_at       TIMESTAMPTZ,
  last_error          TEXT,

  created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- One bot per agent per platform. An agent may have one Discord bot and
  -- one Slack bot simultaneously; two agents in the same tenant have
  -- independent bots. Mirrors composio's per-toolkit uniqueness.
  UNIQUE (tenant_id, agent_id, platform)
);

ALTER TABLE platform_bot_configs ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_bot_configs FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON platform_bot_configs
  FOR ALL TO app_user
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE INDEX IF NOT EXISTS idx_platform_bot_configs_tenant
  ON platform_bot_configs (tenant_id);

CREATE INDEX IF NOT EXISTS idx_platform_bot_configs_tenant_agent
  ON platform_bot_configs (tenant_id, agent_id);

-- Hot path for the gateway/webhook routing: cache rebuild + findBotByTeamId
-- queries filter on enabled=true.
CREATE INDEX IF NOT EXISTS idx_platform_bot_configs_enabled
  ON platform_bot_configs (platform, enabled) WHERE enabled = true;

CREATE TRIGGER platform_bot_configs_updated_at
  BEFORE UPDATE ON platform_bot_configs
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
