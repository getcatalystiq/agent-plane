-- Per-toolkit connection metadata for Composio connectors. Keyed by toolkit
-- slug. Stores the user's chosen auth_method, the Composio-reported scheme, and
-- captured identity fields (bot_user_id, display_name) populated post-connect
-- by the whoami dispatch in src/lib/composio.ts.
--
-- Shape:
--   { "<slug>": { "auth_method": "composio_oauth"|"byoa_oauth"|"custom_token",
--                 "auth_scheme": "OAUTH2"|"BEARER_TOKEN"|...,
--                 "bot_user_id": string|null,
--                 "display_name": string|null,
--                 "captured_at": iso8601|null,
--                 "capture_deferred": boolean? } }
--
-- No backfill: empty object means "use today's auto-detected scheme as picker
-- default." Postgres 16+ lazy default keeps this safe on populated tables.
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS composio_connection_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;
