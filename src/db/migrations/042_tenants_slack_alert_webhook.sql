-- Per-tenant Slack incoming-webhook URL for MCP connection-failure alerts.
--
-- Operators have asked for a low-friction signal when a custom MCP
-- connection breaks. Today the only signal is an `errors` entry on a
-- session message, which most operators don't notice until the next
-- run also fails.
--
-- This column stores an encrypted Slack incoming-webhook URL.
-- Encryption mirrors the existing tenant credential pattern
-- (subscription_token_enc, clawsouls_api_token_enc) using
-- AES-256-GCM via src/lib/crypto.ts and ENCRYPTION_KEY.
--
-- NULL = unconfigured = no notifications. No backfill needed.
-- The dispatcher only reads this column on the rare path where a
-- custom MCP connection just transitioned active -> failed, so no
-- index is required.

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS slack_alert_webhook_url_enc TEXT;

COMMENT ON COLUMN tenants.slack_alert_webhook_url_enc IS
  'Encrypted Slack incoming-webhook URL (https://hooks.slack.com/services/...). NULL = no alerts. Used only by buildMcpConfig() on active->failed transitions.';
