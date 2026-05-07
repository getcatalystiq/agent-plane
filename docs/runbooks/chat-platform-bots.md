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
