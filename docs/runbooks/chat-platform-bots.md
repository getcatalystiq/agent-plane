# Chat Platform Bots Runbook

Operator guide for connecting Discord and Slack bots to AgentPlane agents.
Plan reference: `docs/plans/2026-05-06-001-feat-chat-platform-bots-discord-slack-plan.md`.

## Threat-model boundary

**v1 chat support is private/trusted workspaces only.** Public Discord
servers and shared Slack workspaces are out of scope until an injection
scanner lands. The connect flow enforces:

- An explicit per-bot `private_workspace=true` attestation from the operator.
- A workspace-size probe at connect time (Discord guild member-count sum;
  Slack `users.list` page-1 size). Default threshold: 100 members per
  tenant. Override via `tenants.max_trusted_members`.
- **Discord ≥1 guild required at connect time.** A bot with no guilds
  produces `probed: false, reason: discord_not_installed`. Operator must
  invite the bot to a target guild before completing the connect flow.
  This closes the install-then-grow bypass where memberCount=0 was
  accepted and the operator could later install to a public Discord.

If the workspace probe fails or the workspace exceeds the threshold,
connect refuses to persist credentials.

**Post-connect growth is NOT re-checked in v1.** A workspace that grows
past the threshold after a successful connect remains active. Mitigations:
per-platform-user 10/min rate limit at the bridge bounds individual
abuse; tenant budget caps total spend; threat-model is policy-only
beyond connect-time. Periodic re-probe via a daily cron is a known
follow-up.

## Required environment variables

| Var | Purpose | Required |
|---|---|---|
| `UPSTASH_REDIS_URL` | Chat SDK shared state across per-agent bot instances. Native Redis URL (`rediss://...`). Provisioned via Vercel Marketplace (Upstash). | When chat is enabled |
| `GATEWAY_FORWARDER_SECRET` | HMAC-SHA-256 secret signing forwarded Discord gateway events. | When Discord is enabled |
| `GATEWAY_FORWARDER_SECRET_PREVIOUS` | Previous secret accepted during a rotation window. | Optional |
| `BLOB_PRIVATE_READ_WRITE_TOKEN` | Private Vercel Blob token for chat attachments. **No public-blob fallback.** | When chat is enabled |
| `NEXT_PUBLIC_APP_URL` | Public origin used to build the gateway-forwarder webhook URL. | When chat is enabled |
| `DISCORD_PUBLIC_KEY` / `DISCORD_APPLICATION_ID` | Global fallbacks for single-bot deploys. Per-bot values in `platform_bot_configs.credentials_enc` are authoritative. | Optional |
| `SLACK_SIGNING_SECRET` | Global fallback signing secret for single-bot deploys. Per-bot value is authoritative when set. | Optional |

`NODE_ENV=production` deployments must verify `maxDuration: 800` is honored
on `/api/discord/**`. Hit `GET /api/health/preflight` on a deployed URL —
if the response arrives after ~65 seconds, the deployment is on Vercel Pro
extended-duration or Enterprise. Hobby caps at 60 seconds and the gateway
listener pattern won't work on that tier.

## Adding a Discord bot

1. **Discord Developer Portal**: create a new application at
   <https://discord.com/developers/applications>. Open the Bot section,
   copy the bot token. Open General Information, copy Application ID and
   Public Key.
2. **Enable MESSAGE_CONTENT privileged intent** under Bot → Privileged
   Gateway Intents. Without this, the bot receives `MESSAGE_CREATE`
   events with empty content and the bridge filter drops every message.
   Required for v1 (the bridge filter explicitly checks `message.mentions`
   on a non-empty content stream).
3. **Invite the bot** to the target Discord server using the OAuth2 URL
   generator with `bot` scope and at minimum `Send Messages`,
   `Read Message History`, `Create Public Threads` permissions.
4. **AgentPlane admin UI**: open the agent → Bots tab → Discord card →
   Connect. Paste the bot token, application ID, and public key. Tick
   the private-workspace attestation. Submit.
5. The route validates the token (Discord `GET /users/@me`, 5s timeout,
   `redirect: 'error'`), probes guild member counts, and either persists
   or surfaces the platform's verbatim error.
6. The next gateway cron tick (≤9 minutes) refreshes the bot cache and
   the listener picks up the new bot. Watch logs for
   `discord-gateway: cache refreshed`.

Connection state shows `Connected — no events received` for ~5 minutes
after first connect if MESSAGE_CONTENT isn't enabled. The hint in the
admin UI links to the Developer Portal.

## Adding a Slack bot

1. **Slack app config** at <https://api.slack.com/apps>: create a new
   app → From scratch. Pick a name and the target workspace.
2. Under OAuth & Permissions → Scopes, add bot scopes: `app_mentions:read`,
   `chat:write`, `users:read`, `channels:read`, `groups:read`,
   `im:read`. Install to workspace and copy the Bot User OAuth Token.
3. Under Basic Information → App Credentials, copy the Signing Secret.
4. **AgentPlane admin UI**: open the agent → Bots tab → Slack card →
   Connect. The card shows the Events API webhook URL — copy it.
5. Back in the Slack app config: Event Subscriptions → enable → paste
   the webhook URL. Slack POSTs an `url_verification` challenge to that
   URL, signed with the signing secret. AgentPlane verifies the signature
   first (R12 ordering) and responds with the challenge. Subscribe to bot
   events: `app_mention`, `message.channels`.
6. **Invite the bot** to a channel: `/invite @YourBot`.
7. Verify in the Bots tab that the card transitions to `Connected` after
   the first message lands.

## Token rotation

The admin POST endpoint pre-validates the new token before persisting.
Validation failure preserves the prior config — no risk of breaking a
working bot while typing a token wrong.

After a successful rotation:
- `credentials_version` bumps.
- `forceRefresh()` runs server-side (no HTTP, no `CRON_SECRET` in transit).
- The cached `Chat` instance evicts within ~100ms of save.

If you suspect a token has been leaked, rotate immediately. The eviction
window closes in <100ms; the leaked token cannot be used after that
unless the attacker also has Vercel deployment access.

## Forwarder-secret rotation (Discord)

`GATEWAY_FORWARDER_SECRET` signs every event the gateway cron forwards to
the webhook receive route. To rotate without dropping events:

```
vercel env add GATEWAY_FORWARDER_SECRET_PREVIOUS=$OLD
vercel env add GATEWAY_FORWARDER_SECRET=$NEW
vercel --prod  # deploy

# wait for all production instances to migrate to new code (~5 minutes)

vercel env rm GATEWAY_FORWARDER_SECRET_PREVIOUS
```

The webhook accepts EITHER signature during the dual-accept window so
in-flight forwarded events from old-instance crons still verify.

## Debugging missed events

When a Discord bot is `Connected — no events received` after 5 minutes:

1. Check `/api/discord/gateway` cron logs for `cache refreshed`.
2. Confirm MESSAGE_CONTENT intent is enabled in Developer Portal.
3. Confirm the bot is in at least one guild and the channel grants the
   bot the `View Channel` and `Read Message History` permissions.
4. Check `/api/webhooks/discord` logs for `invalid_signature` or
   `unhandled` responses.

When Slack events don't arrive:

1. In Slack app config, hit "Retry" on the Event Subscriptions URL field
   to confirm the challenge round-trip still works.
2. Check `/api/webhooks/slack` logs for `invalid_signature`,
   `stale_timestamp`, or `unhandled` returns.
3. Confirm the bot is invited to the channel where the @mention happens.

## Migration 037 deploy gate

Migration `037_chat_event_dedupe_claim_pattern.sql` lands the placeholder
pattern via `ALTER TABLE`. Round-2 originally landed the same shape by
modifying 036 in place; round-3 reverted 036 and added 037. On any
environment that ran the round-2 in-place 036, the stored sha256 for
036 no longer matches the on-disk file, so the migration runner aborts
the deploy.

For the cutover deploy ONLY, set `MIGRATIONS_RECONCILE_CHECKSUMS=true`
on the Vercel project env. The runner reconciles 036's stored checksum
(without re-executing the SQL) and applies 037 cleanly. **Unset the
env var immediately after the deploy completes.** Leaving it set is
unsafe — future in-place edits to applied migrations would silently
pass without re-running SQL.

Production is unaffected (main never had 036 of any shape); the
reconcile requirement applies only to dev/preview environments where
round-2 already deployed.

## Stale-claim recovery observability

`startInnerDispatchStep` emits these log lines for the claim-then-reserve
flow:

- `lost claim race; attaching to winner` — common, expected on retry-after-success.
- `claim filled during steal window; attaching` — uncommon benign race.
- `stole stale claim; promoting to new winner` — RARE; indicates a
  winner crashed mid-dispatch and a retry took over. Should be
  < 1/hour at steady state. >> normal frequency → escalate (likely
  cold-sandbox tail latency exceeding `STALE_CLAIM_THRESHOLD_SECONDS`,
  currently `POLL_MAX_DURATION_MS / 1000 + 60s`).
- `claim race lost and steal failed for event …` thrown error → WDK
  retries; spike indicates concurrent-stealer contention.

Spot-check stalled placeholders (orphans the 15-min cleanup sweep
will reap):

```sql
SELECT COUNT(*) AS stuck
FROM chat_event_dedupe
WHERE inner_run_id IS NULL
  AND claimed_at < now() - INTERVAL '15 minutes';
```

The cleanup-sessions cron runs every 5 min; sweeps surface in the
structured log line `chat_event_dedupe sweep` (with
`stale_placeholders_deleted` + `expired_filled_deleted` counters).

## Cutover deployment (rounds 5–6)

Migrations 038 + 039 land alongside the round-5/6 workflow refactors.
This section is the Go/No-Go checklist; pair it with "Migration 037
deploy gate" above when 037 has not yet shipped on the target
environment.

### Pre-deploy gates (read-only)

```sql
-- (a) Confirm 038/039 not yet applied (exit if these return rows).
SELECT 1 FROM information_schema.columns
 WHERE table_name='tenants' AND column_name='bot_platform_caps';
SELECT 1 FROM information_schema.columns
 WHERE table_name='chat_event_dedupe' AND column_name='steal_attempts';
SELECT conname FROM pg_constraint
 WHERE conrelid='tenants'::regclass AND conname='bot_platform_caps_shape_valid';

-- (b) Snapshot tenant + bot baselines for post-deploy comparison.
SELECT COUNT(*) AS tenants_total FROM tenants;
SELECT platform, COUNT(*) FILTER (WHERE enabled) AS enabled_count
  FROM platform_bot_configs GROUP BY platform;

-- (c) CRITICAL — confirm no in-flight chat workflow is mid-step.
-- Round-6 changes the partial-state shape. If non-zero AND not all
-- sweep-eligible, wait one cleanup cycle (5–15 min) before deploying.
SELECT COUNT(*) AS pre_deploy_partials,
       COUNT(*) FILTER (WHERE claimed_at < now() - INTERVAL '15 minutes')
         AS sweep_eligible
  FROM chat_event_dedupe
 WHERE inner_run_id IS NULL
   AND (session_id IS NOT NULL OR message_id IS NOT NULL);

-- (d) Confirm no tenant currently exceeds the 10-bot platform cap
-- (round-5 #1 cap is hardcoded default; tenants beyond it will be
-- blocked from new connects post-deploy). If any: notify the tenant
-- before deploy or set tenants.bot_platform_caps after migration 038
-- applies.
SELECT tenant_id, platform, COUNT(*) AS enabled_count
  FROM platform_bot_configs
 WHERE enabled = true
 GROUP BY tenant_id, platform
HAVING COUNT(*) > 10
 ORDER BY enabled_count DESC;
```

### Deploy

1. Push commit; Vercel build runs `npm run migrate` automatically.
2. Watch build logs for `apply 038_tenant_bot_caps.sql` and
   `apply 039_bot_platform_caps_check.sql`. Migration 039's CHECK
   constraint validates every existing row — if any tenant has
   pre-existing corrupt JSONB in `bot_platform_caps` (no API path
   writes today, so this is a defensive fail) the migration aborts
   the deploy.
3. If a checksum mismatch fires on 037 (round-5 follow-up), set
   `MIGRATIONS_RECONCILE_CHECKSUMS=true` in the Vercel project env
   for THIS deploy only, redeploy, then **unset** immediately after.

### Post-deploy verification (within 5 minutes)

```sql
-- (a) Schema converged.
SELECT column_name, is_nullable, data_type
  FROM information_schema.columns
 WHERE (table_name='tenants' AND column_name='bot_platform_caps')
    OR (table_name='chat_event_dedupe' AND column_name='steal_attempts');
-- Expected: bot_platform_caps | YES | jsonb
--           steal_attempts    | NO  | integer

-- (b) bot_platform_caps NULL on all existing tenants (no override yet).
SELECT COUNT(*) FILTER (WHERE bot_platform_caps IS NOT NULL)
         AS overrides_set
  FROM tenants;
-- Expected: 0 (operator may set per-tenant overrides later via SQL).

-- (c) steal_attempts populated with default 0.
SELECT COUNT(*) FILTER (WHERE steal_attempts IS NULL) AS null_count,
       MAX(steal_attempts) AS max_attempts
  FROM chat_event_dedupe;
-- Expected: null_count=0, max_attempts=0 immediately post-deploy.

-- (d) Bot count per platform unchanged from baseline.
SELECT platform, COUNT(*) FILTER (WHERE enabled) AS enabled_count
  FROM platform_bot_configs GROUP BY platform;
```

### Smoke tests (post-deploy, manual)

- Send a real chat-bot mention end-to-end. Confirm reply lands and
  `chat_event_dedupe` row reaches `inner_run_id IS NOT NULL` within
  a few seconds. Confirm `steal_attempts = 0`.
- Attempt to connect a Discord bot at exactly the cap (10 by default).
  Admin UI shows: *"You're at 10/10 discord bots — disable one in the
  list above before connecting another."* HTTP body includes
  `error.code = "tenant_bot_cap_exceeded"`, `error.platform`,
  `error.limit`.
- Override one tenant via `UPDATE tenants SET bot_platform_caps =
  '{"discord": 25}'::jsonb WHERE id = '<tenant>'` and confirm next
  connect succeeds past 10.

### 24-hour monitoring

Search Vercel structured logs for these new round-5/6 lines:

| Log line | Severity | Healthy threshold |
|---|---|---|
| `chatDispatchWorkflow: continuing with orphan placeholder` | warn | < 1/h sustained |
| `claim recovery abandoned after circuit-breaker threshold` | error | 0; > 0 → page |
| `markBotErrorStep: failed to write last_error` | error | 0; DB write availability concern |
| `finalizeChatStep: failed to write last_event` | error | 0; same as above |
| `startInnerDispatchStep: failed to fill inner_run_id after retries; placeholder orphaned` | error | < 1/h; > 0 sustained → investigate Neon connectivity |
| `stole stale claim; promoting to new winner` | warn | < 1/h; spike → cold-sandbox tail exceeding 90s threshold |
| `chat_event_dedupe sweep` | info | every 5 min when non-zero |

SQL spot-checks at +1h / +4h / +24h:

```sql
-- Steal-attempt distribution. MAX should never exceed 6
-- (5 = circuit-breaker threshold; 6 = the increment that trips it).
SELECT MAX(steal_attempts) AS max_attempts,
       COUNT(*) FILTER (WHERE steal_attempts > 5) AS abandoned_rows
  FROM chat_event_dedupe;
-- Expected: max_attempts ≤ 6, abandoned_rows = 0 in steady state.

-- Round-6 partial-state — sweep_overdue MUST be 0.
SELECT COUNT(*) FILTER (WHERE claimed_at <  now() - INTERVAL '15 minutes')
         AS sweep_overdue
  FROM chat_event_dedupe
 WHERE session_id IS NOT NULL AND message_id IS NOT NULL
   AND inner_run_id IS NULL;
-- Expected: 0. Non-zero means cleanup cron is broken or backlogged.
```

### Rollback

Both 038 and 039 are forward-only and additive. Code rollback is
always safe (round-5 code reads the new columns through optional
fallbacks; reverting to round-4 ignores them). Schema rollback is
two-stage:

**Stage A** — code revert (preferred):
```bash
git revert c00dcd8..HEAD   # or redeploy the prior round-4 commit
```
Schema unchanged. Behavior reverts. Any tenant that set a
`bot_platform_caps` override before the revert silently loses the
override (the column is still there, just unread); coordinate with
affected tenants first.

**Stage B** — drop columns (only if Stage A doesn't resolve):
```sql
-- After Stage A is live and stable:
ALTER TABLE tenants
  DROP CONSTRAINT IF EXISTS bot_platform_caps_shape_valid,
  DROP COLUMN IF EXISTS bot_platform_caps;
ALTER TABLE chat_event_dedupe DROP COLUMN IF EXISTS steal_attempts;
-- Then update _migrations to mark 038/039 rolled back.
```

**Round-6 partial-state caveat**: the 2-stage placeholder fill
produces dedupe rows shaped (session_id+message_id NOT NULL,
inner_run_id NULL) that are LEGAL under round-6 but look like
corruption under round-4. Before reverting code:

1. Pause chat ingress (disable affected `platform_bot_configs.enabled`).
2. Wait ≥ 15 min for the cleanup-sessions sweep to reap any in-flight
   partial rows.
3. Confirm: `SELECT COUNT(*) FROM chat_event_dedupe WHERE session_id
   IS NOT NULL AND message_id IS NOT NULL AND inner_run_id IS NULL;`
   must be 0.
4. Revert code; re-enable bots.

## Telemetry

Counters emitted as structured logs (Vercel Logs query: `metric_name=...`):

- `chat.rate_limit_hits` — per agent_id and platform_user_id
- `chat.tenant_cap_collisions` — when 50-active-session cap bites
- `chat.workflow_step_invocations` — WDK cost tracking
- `chat.workflow_resume_count` — function-recycle frequency
- `chat.attachment_persist_failures` — with reason
- `chat.discord_429_count` — per channel_id
- `chat.workspace_probe_blocked` — R19 enforcement
- `chat.forwarder_signature_rejections` — forged-event detection / rotation health

Kill switch: feature flag `chat.disabled` checked at the bridge entrypoint.
Set to true if `chat.workflow_step_invocations` exceeds 50,000/day platform-wide.
