-- Per-tenant per-platform enabled-bot caps.
--
-- Round-5 review #3: the prior round-4 residual hardcoded
-- MAX_ENABLED_BOTS_PER_TENANT_PER_PLATFORM = 10. This is inconsistent
-- with the neighboring `tenants.max_trusted_members` pattern (also a
-- per-tenant resource cap, also adjustable per tenant). A tenant
-- requesting >10 bots should not require a code change.
--
-- Schema: a single JSONB column on tenants storing a {platform: cap}
-- map. Defaults to 10 per platform when the column is NULL or the
-- platform key is missing — preserves the prior behavior on existing
-- tenants.
--
-- Example shape:
--   {"discord": 10, "slack": 25}

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS bot_platform_caps JSONB;

COMMENT ON COLUMN tenants.bot_platform_caps IS
  'Per-platform enabled-bot caps, e.g. {"discord": 10, "slack": 25}. NULL or missing key falls back to platform default.';

-- Round-5 review #12: StaleClaimError circuit breaker.
--
-- recoverLostClaim throws StaleClaimError when both the poll and the
-- atomic-steal fail. WDK retries the step. Without a counter, the
-- retry can loop until the cleanup sweep frees the placeholder
-- (~20min) — many error logs, no observable bound. Add a counter so
-- the workflow can bail explicitly after N attempts, mark the bot
-- error, and return rather than retrying indefinitely.
ALTER TABLE chat_event_dedupe
  ADD COLUMN IF NOT EXISTS steal_attempts INTEGER NOT NULL DEFAULT 0;

COMMENT ON COLUMN chat_event_dedupe.steal_attempts IS
  'Counter incremented each time recoverLostClaim attempts a stale-claim steal. The workflow bails out and emits markBotError once it crosses the circuit-breaker threshold (default 5).';
