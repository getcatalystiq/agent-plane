---
title: "feat: Chat-platform bots (Discord + Slack) via Vercel Chat SDK + WDK"
type: feat
status: active
date: 2026-05-06
revised: 2026-05-06
---

# feat: Chat-platform bots (Discord + Slack) via Vercel Chat SDK + WDK

## Summary

Add per-agent Discord and Slack bots so AgentPlane agents can be `@mentioned` from chat platforms and reply via the existing dispatcher. **`chatDispatchWorkflow` (WDK) starts the existing `dispatchWorkflow` as an inner workflow and reads its output via `getRun(innerRunId).getReadable()`** — durable across function timeouts, per-step retries, idempotency keys deduplicate at-least-once delivery. Sticky **per-thread** sessions reuse `sessions.context_id` (no new mapping table). Attachments mirrored to **private** Vercel Blob and staged into the sandbox FS via signed-URL handoff inside the dispatcher's `ensureSandboxStep` (no `Buffer` crosses a WDK step boundary). **v1 threat-model boundary: private/trusted workspaces only**, gated by an explicit per-bot attestation + workspace-size probe at first connection (no public-channel deployment until an injection scanner lands).

---

## Problem Frame

AgentPlane agents reach the world via REST, scheduled crons, A2A JSON-RPC, and HMAC webhooks — none of which give a human a chat-shaped surface. agent-co (`~/code/agent-co`) ships a Vercel Chat SDK pattern for Discord; this plan adapts that pattern to AgentPlane and extends it to Slack. AgentPlane already runs `dispatchWorkflow` (WDK, `src/lib/workflows/dispatch-workflow.ts`), so chat dispatch composes with the existing workflow runtime rather than introducing a parallel dispatch path. The `chat` trigger source already exists in `RunTriggeredBy`.

### Operating-point comparison (agent-co → AgentPlane)

| Dimension | agent-co | AgentPlane v1 |
|---|---|---|
| Tenant count | Single-digit, one-platform-per-bot | Multi-tenant, two platforms per agent |
| Traffic shape | Steady (Slack bots, business hours) | Bursty (Discord communities + Slack workspaces) |
| Region | Single-region (us-east-1) | Vercel functions; not pinned today |
| Model mix | Anthropic-only via Claude Agent SDK | Anthropic + Vercel AI SDK runners (any provider via Gateway) |
| Sandbox runtime | One process, no per-message runner | Per-message `runner-<messageId>.mjs` |
| Workflow runtime | None (ad-hoc fire-and-forget) | WDK (`dispatchWorkflow` in production) |

Inherited constants from agent-co — 30 msg/min/agent, 200-entry LRU, 1.5s edit gate, 25-min staleness — are *starting points* and called out per-unit for tuning during implementation. Where the operating profiles differ materially, this plan diverges (private blob, signed forwarder, workflow durability, per-user rate limit, attestation gate).

---

## Requirements

- R1. Tenants can register a Discord bot per agent: bot token, application ID, public key. Credentials encrypted at rest using AES-256-GCM (`src/lib/crypto.ts`).
- R2. Tenants can register a Slack bot per agent: bot token, signing secret, optional app id / team id metadata. Credentials encrypted at rest.
- R3. Discord `MESSAGE_CREATE` events that **mention the bot user id** route to the configured agent. Bridge filters on `message.mentions.has(botUserId)` before triggering the workflow — MESSAGE_CONTENT delivers all visible-channel messages, but only @mentions get dispatched. Replies live inside a Discord thread (auto-created on first @mention if the message is in a bare channel).
- R4. Slack `app_mention` and `message.channels` events (in-thread continuations) route to the configured agent. Replies go in the same Slack thread (`thread_ts`).
- R5. Sessions are sticky **per thread**, not per channel. Two parallel threads in the same channel run in two parallel sessions. Implemented via `sessions.context_id` (existing partial unique index on `(tenant_id, agent_id, context_id)` for non-stopped sessions).
- R6. Reuse a session across messages while it is non-stopped. If the prior session is `stopped`, missing, or aged past `expires_at`, the dispatcher transparently creates a new session and binds the same `context_id`. Cleanup-coincident race (cleanup commits `stopped` while two events arrive for the same thread) resolved via `INSERT ... ON CONFLICT DO NOTHING` + re-fetch in the dispatcher's session-create path.
- R7. Inbound attachments (images, PDFs, text/CSV/JSON) are downloaded to **private** Vercel Blob (`BLOB_PRIVATE_READ_WRITE_TOKEN`; required, no public-blob fallback) and the signed read URL is passed to the dispatcher; `ensureSandboxStep` fetches and stages bytes inside its own step to `/vercel/sandbox/attachments/<id>.<safe-ext>`. Filenames sanitized: extension allowlisted to `{png,jpg,jpeg,gif,webp,pdf,txt,csv,json,md}`; everything else gets `.bin`. Content-Type returned by the source CDN is verified consistent with the allowlisted extension; mismatches stage as `.bin`. Failures are per-attachment fail-open: text still dispatches.
- R8. Agent reply text streams back via `text_delta` events; the bot edits its message in-place with a 1.5s rate-limit gate, rolling over to a new message on each platform's per-message size cap. Rollover seals the prior message with a `…` suffix and prefixes the next with a continuation indicator. Slack output goes through a CommonMark→`mrkdwn` translator that splits on sentence/newline boundaries to avoid mid-token formatting jitter. Discord 429 (`Retry-After`) responses dynamically lengthen the edit gate per-channel for the duration of the chat session.
- R9. Trigger source for these executions is `chat` (already in `RunTriggeredBy`); `ephemeral=false`, `idle_ttl_seconds=600` per the trigger-table mapping for `chat`.
- R10. Admin UI exposes a **Bots** tab on agent detail with create / rotate / disable controls per platform; secrets entered there are encrypted before persistence and never returned in API responses. Token rotation pre-validates the new token (Discord: `GET /users/@me`; Slack: `auth.test`) **with `redirect: 'error'` on the fetch and a 5-second timeout**, before bumping `credentials_version`. Validation failure preserves the prior config and surfaces the platform's error verbatim.
- R11. Discord Gateway listeners survive function lifetimes via the cron + `after()` pattern (cron every 9 min, `maxDuration: 800`, listener runs ~750s).
- R12. Slack signature verification (HMAC-SHA-256 over raw body using signing secret + `X-Slack-Request-Timestamp`, 5-minute clock skew, constant-time compare). **Verification ordering**: (a) check timestamp skew from headers (no body parse); (b) parse `team_id` from body; (c) `findBotByTeamId(teamId)` — return 200 `unhandled` if null **without decrypting anything**; (d) only then decrypt the signing secret and verify. URL-verification challenge requires a valid signature (Slack signs `url_verification` POSTs with the signing secret already configured at portal setup).
- R13. No per-channel or per-bot cost cap is added; tenant budget enforcement (already in dispatcher) is the only spend bound. Per-agent (30/min) AND per-platform-user (10/min) rate limits added inline at the bridge (no WDK step overhead — pure in-memory check).
- R14. Bot config rotation bumps `credentials_version`, evicting the cached `Chat` instance. The admin route imports `refreshBots()` directly (no internal HTTP round-trip; `CRON_SECRET` is not a transport between admin and registry). Eviction lag is bounded by the import call latency: <100ms typical.
- R15. Chat dispatch is durable: `chatDispatchWorkflow` (WDK) survives function timeouts, retries failed steps, and resumes streaming via `getRun(innerRunId).getReadable({ startIndex })` against the inner `dispatchWorkflow` when the function host recycles mid-reply. The chat workflow persists `lastSeenIndex` in workflow state on each successful edit so resume reattaches at the right offset.
- R16. At-least-once delivery is deduplicated: workflow trigger key = `${tenantId}:${platform}:${event_id}` (Discord message id; Slack `event_id`). Tenant-scoped to prevent cross-tenant collision when two tenants have bots in the same Slack workspace (Slack `event_id` is per-team, not globally unique).
- R17. Discord forwarded events carry an HMAC signature (`X-Gateway-Signature` over the body using `GATEWAY_FORWARDER_SECRET`) distinct from the bot token. Webhook route rejects events without a valid signature *before* `findBotByToken`. Rotation supports a `GATEWAY_FORWARDER_SECRET_PREVIOUS` env var: webhook accepts EITHER signature during a rolling deploy window (mirrors `ENCRYPTION_KEY_PREVIOUS`).
- R18. Discord ingress requires the **MESSAGE_CONTENT privileged intent** to be enabled in Discord Developer Portal. Admin UI surfaces this prerequisite when a Discord bot is in the "connected but receiving zero events" state. Slack equivalent hint surfaces missing Events API subscription / bot not invited to channel.
- R19. **Threat-model gate (private/trusted workspace)**: bot connection requires the operator to (a) check an `attestations.private_workspace = true` checkbox stored in `platform_bot_configs.attestations` JSONB, AND (b) pass a workspace-size probe (Discord guild `member_count` ≤ `MAX_TRUSTED_MEMBERS = 100`; Slack workspace size via `users.list` page-1 size, same threshold). Above the threshold, connection is blocked with an explicit message; the threshold is configurable per-tenant via `tenants.max_trusted_members`. Probe results are recorded in `platform_bot_configs.platform_identity.member_count_at_connect` for audit.

---

## Scope Boundaries

**Threat-model boundary:** v1 chat support targets **private / trusted workspaces only**, enforced at connect time by R19's attestation + size probe. Above the size threshold or without the attestation, the connect flow refuses to persist credentials. Public-channel deployment (open Discord communities, public Slack workspaces) is out of scope until an injection scanner lands AND the attestation+probe gate is replaced with a runtime classifier.

- Microsoft Teams, Telegram, WhatsApp, Google Chat, GitHub, Linear adapters are not in v1.
- No reverse direction: agents do not proactively start threads.
- No DM support (channel + thread only). Discord DMs and Slack `im.*` events are out of scope.
- No per-channel or per-thread cost cap. Tenant budget remains the spend bound.
- No multi-workspace Slack OAuth install flow. v1 ingests bot tokens manually pasted into the admin UI for the workspace the operator has already installed the app into. **Onboarding requires Slack-app-developer experience** (create app at api.slack.com, configure scopes, install to workspace, copy bot token). The admin UI documents this prerequisite.
- No reactions, slash commands, button/modal interactivity. Inbound is text + attachments only.
- No injection scanner in v1 (deferred); compensated for by R19's attestation + size probe + UI banner.

### Deferred to Follow-Up Work

- Slack OAuth install flow + multi-workspace expansion: separate PR once Marketplace listing is on the roadmap.
- Teams / Telegram / WhatsApp / Google Chat / GitHub / Linear adapters: each its own PR; the bot registry abstracts platform differences.
- Outbound proactive messaging (e.g., scheduled agent posts a daily summary to Slack): separate PR; would build on `slackAdapter.withBotToken()` + `bot.thread('slack:T:C:ts').post(...)`.
- Slack interactive surfaces (block kit modals, slash commands).
- Injection scanner: required to lift R19's attestation+probe gate.
- Cross-instance rate limiting via Upstash KV: separate plan; today's per-agent in-memory limiter is per-instance and Vercel may run multiple instances. Per-platform-user (10/min) is the v1 compensation.
- Per-trigger session-cap buckets (chat sessions counted separately from REST/A2A): if the 50-active-session cap collides with chat traffic in production, raise via `tenants.max_concurrent_sessions` override or split into buckets.
- Workspace-size monitoring post-connection: v1 probes only at connect time. A "workspace exceeded threshold post-connect" sweep is out of scope; document as known follow-up.
- Sentence-level mrkdwn boundary heuristics beyond the v1 set (nested code blocks, escape `<@U…>` mention syntax preserved when agent-emitted): start with the common cases.

---

## Context & Research

### Relevant Code and Patterns

- `src/lib/dispatcher.ts` — `dispatchSessionMessage()` shim fronting `dispatchWorkflow`. Chat workflow does NOT call this shim; it calls `start(dispatchWorkflow, [input, prepared])` directly so it can read the inner runId and `getReadable()` against it.
- `src/lib/workflows/dispatch-workflow.ts` — existing `dispatchWorkflow` with steps `reserveStep`, `ensureSandboxStep` (extends to accept `preInjectFiles` URL list — see U7), `launchRunnerStep`, `writeChunkStep`, `finalizeStep`, `tailStep`. The "use workflow" body iterates a stream and calls `writeChunkStep` per chunk; chat workflow uses the same primitive (`getRun(runId).getReadable()`) at line 662.
- `src/lib/workflows/index.ts` — workflow public surface; chat workflow registers here.
- `src/lib/sessions.ts` — `findSessionByContextId` already implements R5/R6. Existing partial unique index `ON (tenant_id, agent_id, context_id) WHERE status NOT IN ('stopped')` is exactly what per-thread sticky sessions need. Cleanup-vs-create race resolved by `INSERT ... ON CONFLICT DO NOTHING` + re-fetch in the dispatcher's session-create path (small change to existing `createSession` helper).
- `src/lib/crypto.ts` — async `encrypt()` / `decrypt()` (AES-256-GCM); supports `ENCRYPTION_KEY_PREVIOUS` rotation. The forwarder-secret rotation pattern mirrors this exactly.
- `src/lib/cron-auth.ts` — `verifyCronSecret(request)` for the gateway cron route only. Internal admin→registry calls use direct module imports, NOT HTTP+CRON_SECRET.
- `src/lib/rate-limit.ts` — in-memory; chat ingress reuses with two keys (per-agent + per-platform-user). Pure read-modify-write; no WDK step needed.
- `src/lib/sandbox.ts` — `sandbox.writeFiles([{ path, content }])` is the file-injection primitive.
- `src/lib/streaming.ts` — heartbeats and stream surface; chat workflow does NOT use the HTTP stream surface (no API key context inside a workflow).
- `src/lib/assets.ts` — single-file Composio/Firecrawl URL → Blob persistence. Pattern model for attachment mirror.
- `src/components/ui/copy-button.tsx` — established checkmark-feedback copy component; reused for the Slack Webhook URL field in U8.
- `src/components/ui/tabs.tsx` — current implementation has no overflow handling. U8 modifies it to add `overflow-x-auto` + scroll-snap behavior consistent with the project's other narrow-viewport components.
- `src/app/api/webhooks/[sourceId]/route.ts` — HMAC-verified webhook ingress with `webhook_deliveries` idempotency. Slack receive route uses similar shape (signature verify → workflow trigger).
- `src/app/api/cron/cleanup-sessions/route.ts` — handles idle TTL stops and `expires_at` cap. Chat sessions live under the same per-row policy.
- `src/db/migrations/034_workflow_dispatch_columns.sql` — most recent migration; new migration becomes `035_chat_platform_bots.sql`.

### Reference Implementation (agent-co)

- `lib/platform/bot.ts` — module-scope `Map<agentId, CachedBot>`, LRU 200, `findBotByToken()`. AgentPlane mirrors with cache key `${platform}:${agentId}` and adds `findBotByTeamId()` for Slack.
- `app/api/discord/gateway/route.ts` — cron, `maxDuration: 800`, `after()` keeps `startGatewayListener` alive ~750s, forwards events to webhook URL. AgentPlane copies the shape and adds the forwarder HMAC.
- `app/api/webhooks/discord/route.ts` — pre-parses attachments before SDK dispatch, routes via `findBotByToken(header)`. AgentPlane adds signature verification (R17) and @mention filter (R3).
- `app/api/internal/platform-dispatch/route.ts` — agent-co's 300s function. **AgentPlane drops this entirely** in favor of a workflow trigger.

### Institutional Learnings

- `docs/solutions/logic-errors/transcript-capture-and-streaming-fixes.md` — preserve `result` + `error` events through truncation; never store `text_delta`.
- WDK constraints baked into existing dispatch-workflow.ts: (1) `Hook<T>` cannot cross workflow→step boundary; (2) live `SessionSandboxInstance` is non-serializable; (3) per-chunk writes must live IN a step. Chat workflow honors these by passing only JSON-serializable types across boundaries (URLs, primitives, plain objects) and by reading the inner workflow's stream via `getRun().getReadable()` rather than passing `ReadableStream` objects.
- Multi-tenant patterns: every secret encrypted, every cross-tenant lookup includes `tenant_id`, JSONB merges via atomic SQL.

### External References

- Vercel Chat SDK: https://chat-sdk.dev, https://github.com/vercel/chat
- `@chat-adapter/discord`, `@chat-adapter/slack`, `@chat-adapter/state-redis`
- Discord docs: MESSAGE_CONTENT privileged intent; per-channel rate limit (5 edits/5sec).
- Slack Events API: signing-secret HMAC-SHA-256 (`v0:` over `v0:<timestamp>:<body>`); URL-verification is signed.
- Vercel WDK: workflow definition, step semantics, idempotency keys, `getRun(runId).getReadable({ startIndex })`.

---

## Key Technical Decisions

- **Durable orchestration via WDK with workflow-invokes-workflow composition**. `chatDispatchWorkflow` body calls `start(dispatchWorkflow, [chatInput, prepared])`, captures the inner `runId`, and reads the dispatcher's stream via `getRun<RunnerChunk>(innerRunId).getReadable()`. The chat workflow body iterates that readable; per-tick edits go through `postOrEditStep`. Function host recycles → workflow resumes from the last persistent state → re-attaches via `getReadable({ startIndex: lastSeenIndex })`. **This is Shape A.** Honors all WDK constraints (no `Hook<T>` cross-boundary, no `ReadableStream` as step argument, no `Buffer` in step input).
- **Attachment shape: signed URLs, never `Buffer` in `DispatchInput`**. `preInjectFiles?: Array<{ path, blobUrl, signedReadUrl, contentType, sizeBytes }>` carries metadata + a 10-minute TTL signed URL. The dispatcher's `ensureSandboxStep` extends to fetch each signed URL and call `sandbox.writeFiles` inside its own step body — bytes never cross a step boundary. **Resolves the WDK Buffer-serialization blocker.**
- **No new thread-map table**: `sessions.context_id` carries the thread key (`discord:guildId:channelId:threadId` or `slack:teamId:channelId:thread_ts`).
- **Cleanup-vs-create race resolution**: `createSession` becomes `INSERT ... ON CONFLICT DO NOTHING RETURNING *` + a follow-up SELECT on conflict. If `findSessionByContextId` returns a row on the conflict re-fetch, the chat workflow uses it; otherwise the dispatcher's CAS handles in-flight contention.
- **Database pool / Chat SDK state**: `@chat-adapter/state-redis` backed by Upstash Redis (Vercel Marketplace). Locked. Rationale: state-pg conflicts with PgBouncer; Chat SDK state is small/ephemeral; Redis is a textbook fit. Provisioning via Vercel Marketplace dashboard auto-injects `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`.
- **Two ingress shapes, one workflow**: Discord uses the gateway-cron pattern (WebSocket kept alive ~750s); Slack uses an HTTP Events webhook. Both verify signatures and trigger `chatDispatchWorkflow` with `${tenantId}:${platform}:${event_id}` as the idempotency key.
- **`GATEWAY_FORWARDER_SECRET` HMAC distinct from bot token**, with `GATEWAY_FORWARDER_SECRET_PREVIOUS` for zero-downtime rotation. Threat scope clarified: defends against operator-side bot-token leaks (Developer Portal compromise, screen recording) where the attacker has Discord credentials but not AgentPlane deployment env. Does not defend against deployment-secret compromise — both forwarder secret and `ENCRYPTION_KEY` are in process.env. The defense is meaningful for the realistic operator-side leak scenario.
- **Slack signature verification implemented locally** with strict ordering: (1) timestamp skew check from headers — no body parse yet; (2) JSON-parse `team_id`; (3) `findBotByTeamId(teamId)` — return 200 `unhandled` if null, no decrypt; (4) decrypt signing secret + HMAC-SHA-256 verify against raw body; (5) constant-time compare. URL-verification challenge requires the same signature path (Slack signs all events including `url_verification`).
- **Discord rate limit (5 edits/5sec/channel)**: per-channel token bucket in `chatDispatchWorkflow` workflow state, replenishes 1/sec. On 429 with `Retry-After`, the channel's bucket is drained and the edit gate dynamically lengthens to `max(1500ms, retryAfterMs)` for the rest of that session. Avoids the retry-storm path where WDK retries amplify the 429 rate.
- **`@mention` filter at the bridge**, not relying on SDK behavior. `bot.onNewMention` / `bot.onSubscribedMessage` (Discord) and `bot.onAppMention` / `bot.onMessage` (Slack) wrappers explicitly check `message.mentions.has(botUserId)` (Discord) or `event.type === 'app_mention' || event.thread_ts` (Slack: dispatch only on direct mentions or in-thread continuations). Non-matching messages drop without dispatching.
- **Private Vercel Blob for attachments, no fallback**: requires `BLOB_PRIVATE_READ_WRITE_TOKEN` to be set; boot-time env validation in `src/lib/env.ts` makes the chat feature fail closed if the token is absent. The CLAUDE.md fallback to `BLOB_READ_WRITE_TOKEN` does NOT apply to chat attachments — the env-validation rejects unset for this code path.
- **Filename + content-type sanitization**: extension allowlist `{png,jpg,jpeg,gif,webp,pdf,txt,csv,json,md}`; anything else stages as `.bin`. Content-Type from CDN response verified against allowlisted extension; mismatch (e.g., `.png` extension with `application/x-msdownload` content-type) stages as `.bin`. Stage path is `${uuid}.${safe-ext}`.
- **Source-URL allowlist for attachment downloads**: Discord must be on `cdn.discordapp.com` / `media.discordapp.net`; Slack on `files.slack.com` / `*.slack-edge.com`. Reject before attaching the bot token to the request — prevents token leak via redirect or attacker-supplied download URL.
- **One bot instance per agent (not per tenant)**: cache key `${platform}:${agentId}`.
- **`platform_bot_configs.unique`**: `(tenant_id, agent_id, platform)`.
- **CommonMark → mrkdwn translation for Slack** with sentence/newline boundary splitting: the translator only formats *complete* lines or sentences from the accumulated buffer; trailing partial tokens (`I am **part`) are held until the next tick before flushing. Avoids mid-stream jitter (visible dangling `*` characters). Discord passes through.
- **Pre-validate tokens on rotation** via Discord `GET /users/@me` / Slack `auth.test` with `redirect: 'error'` and 5s timeout. Server-side debounce: reject duplicate-token validation within 5s for the same tenant+platform to absorb users who triple-click submit.
- **Force-refresh as direct module import**: admin route imports `refreshBots()` from `src/lib/platform/bot.ts` and calls it server-side after a successful upsert. No HTTP, no CRON_SECRET in transit.
- **Per-platform-user rate limit (10/min)** at the bridge, in addition to per-agent (30/min). Compensates for per-instance bypass on multi-instance Vercel deploys.
- **Admin auth is operator-scope, not tenant-scope**: existing `ADMIN_API_KEY` is global; route enforces tenant isolation by deriving `tenant_id` from the agent row. Agent-not-found and cross-tenant-agent both return uniform 404 (no enumeration oracle).
- **Vercel plan tier preflight**: `maxDuration: 800` for `app/api/discord/**` requires Vercel Pro + extended-duration enabled (or Enterprise). U4 begins with confirmation against the deployment's plan tier; if Hobby, halt and re-plan ingress. Verification artifact: dashboard screenshot OR `GET /api/health/preflight` (added to U4) that probes its own runtime cap by sleeping 60s and reporting whether it timed out.
- **WDK per-step cost target**: ~40 step invocations per minute of agent generation in steady-state (one `postOrEditStep` per 1.5s). At an assumed Vercel WDK price of ~$0.0001/step (verify against current pricing during U6 rollout), this is ~$0.004/min/active-message. Kill-switch threshold: if `chat.workflow_step_invocations` exceeds 50,000/day platform-wide, force chat off via a feature flag and alert. Stretch the gate to 3s if observed cost is >2× projection.

---

## Open Questions

### Resolved During Planning

- *"WDK composition shape (workflow-invokes-workflow vs hook-based)?"* → workflow-invokes-workflow via `start(dispatchWorkflow)` + `getRun().getReadable()` (Shape A).
- *"How does `Buffer` survive WDK step boundaries?"* → It doesn't. Use signed-URL handoff; `ensureSandboxStep` fetches inside its own step.
- *"Use sessions.context_id or a new thread-map table?"* → `context_id`.
- *"Internal HTTP dispatch route or workflow trigger?"* → workflow trigger.
- *"Public or private Vercel Blob for attachments?"* → private; required (env-validation enforces).
- *"`internalAuthHeader` for force-refresh?"* → not needed; admin route imports `refreshBots()` directly.
- *"Reuse `webhook_sources` for Slack signing secret?"* → No.
- *"Tenant-scoped admin auth?"* → No. `ADMIN_API_KEY` is global; route enforces tenant isolation via the agent row; uniform 404 prevents enumeration.

### Deferred to Implementation

- Exact Chat SDK signature for `bot.webhooks.slack(req, ...)` — local verify is the primary path; SDK call (if invoked) verified on first use.
- Slack `mrkdwn` translator edge cases beyond the v1 set (nested code blocks, escaping `<`/`>`/`&`, preserving agent-emitted `<@U…>` mentions vs escape-all): start with sentence-boundary translation; iterate based on observed agent output.
- Whether the Slack `40000`-char rollover path needs the same `findDiscordSplit` shape or a simpler newline-only split — confirm during U6 streaming tests.

---

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification.*

```mermaid
sequenceDiagram
    participant User as Discord/Slack User
    participant Plat as Discord Gateway / Slack Events
    participant Cron as /api/discord/gateway (every 9m)
    participant Hook as /api/webhooks/{discord,slack}
    participant Reg as Bot Registry (in-memory + Redis state)
    participant CW as chatDispatchWorkflow (WDK)
    participant DW as dispatchWorkflow (existing WDK, started as inner)
    participant SBX as Vercel Sandbox

    Note over Cron: maxDuration=800, after() keeps WS alive ~750s
    Cron->>Reg: refreshBots() from platform_bot_configs
    Cron->>Plat: startGatewayListener (Discord WS)

    User->>Plat: @mention agent (with optional attachments)
    alt Discord
        Plat-->>Hook: forwarded gateway event<br/>(X-Gateway-Signature, x-discord-gateway-token)
        Hook->>Hook: verify forwarder HMAC (rejects unsigned; CURRENT or PREVIOUS)
        Hook->>Hook: pre-parse attachments → stash by msg id (300s TTL)
        Hook->>Reg: findBotByToken(); SDK fires; bridge filters @mention before trigger
    else Slack
        Plat-->>Hook: HTTP POST (Events API)
        Hook->>Hook: 1. timestamp skew (5min) - no body parse yet
        Hook->>Hook: 2. parse team_id only
        Hook->>Reg: 3. findBotByTeamId — if null: 200 unhandled (no decrypt)
        Hook->>Hook: 4. decrypt signing secret; HMAC-SHA-256 verify; constant-time
    end

    Reg->>CW: trigger chatDispatchWorkflow<br/>idempotencyKey = "${tenantId}:${platform}:${event_id}"
    Hook-->>Plat: 200 (sub-3s ack)

    Note over CW: durable; survives function timeouts;<br/>per-step retry; resumable streaming via getReadable

    CW->>CW: inline rate limit (per-agent 30/min + per-user 10/min)
    CW->>CW: persistAttachmentsStep → returns [{ path, blobUrl, signedReadUrl, ... }]
    CW->>DW: start(dispatchWorkflow, [chatInput, prepared])<br/>chatInput.preInjectFiles = signed URLs
    Note over DW: ensureSandboxStep fetches each signedReadUrl<br/>and writes to sandbox INSIDE the step (no Buffer crosses)
    DW-->>CW: returns { runId: innerRunId }

    CW->>DW: getRun(innerRunId).getReadable<RunnerChunk>()
    loop iterate readable; persist lastSeenIndex per edit
        DW-->>CW: text_delta chunk
        CW->>CW: accumulate; mrkdwn-translate sentence-bounded slice (Slack)
        alt 1.5s gate elapsed OR rollover OR Discord 429-backoff over
            CW->>Plat: postOrEditStep(channelId, msgId, text)
            Plat-->>CW: 200 { messageId } | 429 { retryAfterMs }
            Note over CW: 429 → drain channel bucket; lengthen edit gate to retryAfterMs
        end
    end
    Note over CW: on function-host recycle:<br/>workflow resumes; re-attaches via<br/>getReadable({ startIndex: lastSeenIndex })

    CW->>CW: finalize: typing stop + markBotEvent
```

---

## Implementation Units

### U1. Migration `035_chat_platform_bots.sql` — single table with attestations + observability

**Goal:** Add `platform_bot_configs` only. `attestations` JSONB carries the R19 gate. No `platform_thread_map` (use `sessions.context_id`). No `platform_attachments` (workflow idempotency + private blob handle dedupe).

**Requirements:** R1, R2, R10, R14, R18, R19

**Dependencies:** None.

**Files:**
- Create: `src/db/migrations/035_chat_platform_bots.sql`

**Approach:**
- Enum: `CREATE TYPE chat_platform AS ENUM ('discord', 'slack');`
- `platform_bot_configs` columns: `id UUID PRIMARY KEY`, `tenant_id UUID FK CASCADE`, `agent_id UUID FK CASCADE`, `platform chat_platform`, `credentials_enc TEXT`, `credentials_version INT default 1`, `platform_identity JSONB default '{}'` (carries `team_id`, `bot_user_id`, `member_count_at_connect`), `attestations JSONB default '{}'` (e.g., `{ private_workspace: true, attested_at: '2026-05-06T...', attested_by_admin: true }`), `enabled BOOL default true`, `last_event_at TIMESTAMPTZ`, `last_error TEXT`, `last_connected_at TIMESTAMPTZ`, `created_at`, `updated_at`. `UNIQUE (tenant_id, agent_id, platform)`. Indexes on `(tenant_id)`, `(tenant_id, agent_id)`.
- `tenants` table: add `max_trusted_members INT DEFAULT 100` (R19 per-tenant override).
- RLS enabled with the standard `app.current_tenant_id` policy.
- Sessions create-path race fix lives in U2; no schema change required (`createSession` becomes idempotent via `INSERT ... ON CONFLICT DO NOTHING`).

**Patterns to follow:**
- `src/db/migrations/030_composio_connection_metadata.sql` — single-table tenant-scoped feature with RLS + JSONB column.

**Test scenarios:**
- Happy path: migration applies cleanly against `034` baseline; tenant-scoped INSERT succeeds; cross-tenant INSERT fails RLS.
- Edge case: `UNIQUE (tenant_id, agent_id, platform)` rejects duplicates.
- Edge case: agent delete cascades `platform_bot_configs` rows.
- Edge case: `tenants.max_trusted_members` default = 100 on new + existing tenants (backfill via DEFAULT).
- Idempotent re-run.

**Verification:**
- `npm run migrate` succeeds; `\d platform_bot_configs` shows expected schema, RLS-enabled state, `attestations` and three timestamp columns; `\d tenants` shows `max_trusted_members`.

---

### U2. `src/lib/platform/operations.ts` — encrypted CRUD, pre-validation, attestation gate, race-safe session create

**Goal:** Tenant-scoped CRUD for bot configs + `validateCredentials()` (with `redirect: 'error'`, 5s timeout, debounce) + `probeWorkspaceSize()` (R19 gate) + race-safe `createSession` patch.

**Requirements:** R1, R2, R6, R10, R14, R19

**Dependencies:** U1.

**Files:**
- Create: `src/lib/platform/operations.ts`
- Create: `src/lib/platform/workspace-probe.ts` (Discord guild fetch + Slack users.list page-1 size; pure module, called by `upsertBotConfig`)
- Modify: `src/lib/sessions.ts` — `createSession()` becomes `INSERT ... ON CONFLICT (tenant_id, agent_id, context_id) WHERE status NOT IN ('stopped') DO NOTHING RETURNING *`; on no rows returned, re-run `findSessionByContextId` and return that. (Race-safe; documented in code comment.)
- Test: `tests/unit/platform/operations.test.ts`
- Test: `tests/unit/platform/workspace-probe.test.ts`
- Test: `tests/unit/sessions/create-race.test.ts`

**Approach:**
- Exports from `operations.ts`: `upsertBotConfig`, `getBotConfig`, `getDecryptedCredentials`, `listBotConfigs`, `disableBotConfig`, `rotateBotCredentials`, `markBotEvent`, `markBotError`, `clearBotError`, `validateCredentials`, `enforceAttestationGate`.
- `validateCredentials({ platform, credentials })` — fetch with `redirect: 'error'`, 5000ms `AbortController` timeout. Discord: `GET https://discord.com/api/v10/users/@me`. Slack: `POST https://slack.com/api/auth.test`. Returns `{ ok: true, identity }` or `{ ok: false, error: { code, message, retryAfter? } }`. Server-side debounce: reject duplicate-token validation within 5s for same tenant+platform via in-memory `Map<${tenantId}:${platform}:${tokenHash}, expiresAt>`.
- `enforceAttestationGate(opts)` runs before persist on `upsertBotConfig`: requires `opts.attestations.private_workspace === true` AND `probeWorkspaceSize(platform, credentials) <= tenant.max_trusted_members`. Refuses with structured error otherwise (admin UI surfaces both failure modes distinctly).
- `probeWorkspaceSize` (workspace-probe.ts): Discord — fetch `GET /guilds/{guildId}` for each guild in `applications.@me`, sum `approximate_member_count`; Slack — `POST /users.list?limit=1000` page 1, count members. Rate-limit aware (Discord 429 / Slack `Retry-After`); on probe failure (transient), return `{ probed: false, reason }` and the gate refuses persist with a "could not verify workspace size, retry" message.
- `markBotError` call sites are explicit: U4 webhook on signature failure, U5 webhook on signature failure, U6 chat workflow on dispatch error or 401 from Discord/Slack post. `clearBotError` called by `markBotEvent` on next success.
- `toPublic()` strips `credentials_enc` and surfaces `{ kind, last4, last_event_at, last_error, last_connected_at, attestations.private_workspace, member_count_at_connect, enabled }`.
- `PlatformCredentials` discriminated union: `{ platform: 'discord', botToken, publicKey, applicationId }` | `{ platform: 'slack', botToken, signingSecret, appId?, teamId? }`.
- Session race-fix in `sessions.ts.createSession()` documented inline: race occurs when cleanup-cron commits `stopped` and two ingress events arrive simultaneously; the new INSERT-ON-CONFLICT-DO-NOTHING + re-fetch path handles it without throwing 23505.

**Patterns to follow:**
- `src/lib/connection-metadata.ts` — JSONB merge.
- `src/lib/auth.ts` — `crypto.encrypt` / `decrypt` (note: async).
- `src/lib/sessions.ts` `findSessionByContextId` for the lookup helper.

**Test scenarios:**
- Happy path: upsert with valid token + attestation true + workspace size 10 → public-shape row; subsequent GET returns same row without `credentials_enc`.
- Happy path: rotation with valid new token bumps `credentials_version`; rotation with invalid new token returns 400, prior config intact.
- Edge case: `validateCredentials` with redirect: server returns 302 → fetch errors with `redirect: 'error'`; returns `{ ok: false, error: 'redirect-blocked' }`.
- Edge case: `validateCredentials` with 5s+ latency → AbortController fires; returns `{ ok: false, error: 'timeout' }`.
- Edge case: server-side debounce blocks duplicate validation within 5s for same (tenant, platform, tokenHash).
- Edge case: `enforceAttestationGate` refuses persist when `attestations.private_workspace !== true`.
- Edge case: `enforceAttestationGate` refuses when `probeWorkspaceSize` returns count above `tenant.max_trusted_members` (default 100).
- Edge case: workspace probe transient failure → refuses persist with retry message; user retries, succeeds.
- Edge case: `markBotError` writes platform error verbatim; `markBotEvent` on next success calls `clearBotError`.
- Error path: `getDecryptedCredentials` returns null when `enabled=false`.
- Error path: cross-tenant `getBotConfig` invisible (RLS).
- Race: `createSession` ON CONFLICT — two concurrent inserts for same `(tenant, agent, context_id)` produce one row + one re-fetch hit.

**Verification:**
- All exports covered; rotation guard, attestation gate, redirect: 'error', timeout, debounce all tested; race test exercises the cleanup-vs-create scenario.

---

### U3. `src/lib/platform/bot.ts` + `src/lib/platform/adapters/{discord,slack}.ts` — bot registry

**Goal:** Module-scope `Map<string, CachedBot>` keyed by `${platform}:${agentId}`, LRU 200, version-based eviction, `findBotByToken` (Discord) and `findBotByTeamId` (Slack), explicit `@mention` filter wrappers.

**Requirements:** R1, R2, R3, R4, R11, R14, R18

**Dependencies:** U2.

**Files:**
- Create: `src/lib/platform/bot.ts`
- Create: `src/lib/platform/adapters/discord.ts`
- Create: `src/lib/platform/adapters/slack.ts`
- Test: `tests/unit/platform/bot.test.ts`
- Test: `tests/unit/platform/discord-mention-filter.test.ts`

**Approach:**
- `CachedBot { bot: Chat, platform, adapter, agentId, tenantId, credentialsVersion, botToken, botUserId?, slackTeamId? }`. `botUserId` populated from `validateCredentials` identity response and persisted in `platform_identity`.
- State backend: `createRedisState({ url: process.env.UPSTASH_REDIS_REST_URL, token: process.env.UPSTASH_REDIS_REST_TOKEN })` wired directly.
- Discord adapter wraps `createDiscordAdapter`, patches the 160004 thread-create idempotency quirk (copied from agent-co), and registers `onNewMention` / `onSubscribedMessage` handlers that **explicitly filter** on `message.mentions.has(this.botUserId)` before calling `triggerChatWorkflow`. Logs (and drops) every message that did not pass the filter — if MESSAGE_CONTENT delivers all channel messages, this filter is the only thing standing between the agent and dispatch storm.
- Slack adapter wraps `createSlackAdapter`, registers `onAppMention` (always dispatch) and `onMessage` (dispatch only when `event.thread_ts && event.thread_ts !== event.ts` AND the bot has a session row for that thread). `slackTeamId` from `platform_identity.team_id`.
- Bot handlers (5-line wrappers post-filter) call `triggerChatWorkflow(input)` from U6.
- `refreshBots()` issues a system-scope query (RLS bypass) selecting `id, tenant_id, agent_id, platform, credentials_version, enabled, platform_identity, attestations` — *never* `credentials_enc`. Decryption happens lazily on cache build via `getDecryptedCredentials`. Test asserts the SELECT statement does not include `credentials_enc`.
- `forceRefresh()` exposed as a direct module export (not an HTTP route — admin route imports it).
- `findBotByToken(token)` and `findBotByTeamId(teamId)` are O(N) over the 200-cap.
- No `adapters/index.ts` or `adapters/types.ts` — flat surface.

**Patterns to follow:**
- `src/lib/mcp-connections.ts` — cache-with-version-invalidation.
- agent-co `lib/platform/bot.ts` — `rememberBot()` LRU + 160004 patch.

**Test scenarios:**
- Happy path: `getOrCreateBot` returns cached entry on second call with same version; rebuild on version change.
- Edge case: 201st insertion evicts oldest.
- Happy path: `findBotByToken` and `findBotByTeamId` return matching bot.
- Error path: lookup with no match returns null.
- Edge case: `refreshBots()` evicts disabled bots.
- Integration: SQL inspection asserts `credentials_enc` not in SELECT.
- Integration: Discord MESSAGE_CREATE for a non-mention message in the same channel does NOT call `triggerChatWorkflow`; logged-and-dropped.
- Integration: Slack `message` event with no `thread_ts` and no `app_mention` is dropped.

**Verification:**
- Cache cap, version eviction, lookup helpers, @mention filter all exercised.

---

### U4. Discord ingress: gateway cron + signed forwarder + webhook receive

**Goal:** Cron-driven Gateway listener forwards events with HMAC; webhook receive verifies HMAC (CURRENT or PREVIOUS) and routes via `findBotByToken`. Pre-flight Vercel plan tier verification.

**Requirements:** R3, R7 (attachment pre-parse), R11, R17, R18

**Dependencies:** U3.

**Files:**
- Create: `src/app/api/discord/gateway/route.ts`
- Create: `src/app/api/webhooks/discord/route.ts`
- Create: `src/app/api/health/preflight/route.ts` (sleeps 60s; returns whether function timed out — used to confirm `maxDuration: 800` actually applies)
- Modify: `vercel.json` (add cron `*/9 * * * *` for `/api/discord/gateway`; add `maxDuration: 800` for `app/api/discord/**`)
- Modify: `src/lib/env.ts` (add `GATEWAY_FORWARDER_SECRET` required, `GATEWAY_FORWARDER_SECRET_PREVIOUS` optional, `BLOB_PRIVATE_READ_WRITE_TOKEN` required when chat enabled)
- Modify: `.env.example`
- Modify: `CLAUDE.md` (Database section: add `platform_bot_configs`; Project Structure: add `src/app/api/discord/`, `src/app/api/webhooks/discord/`, `src/lib/platform/`)
- Test: `tests/unit/platform/discord-gateway.test.ts`
- Test: `tests/unit/platform/discord-webhook.test.ts`
- Test: `tests/unit/platform/forwarder-rotation.test.ts`

**Approach:**
- **Pre-flight**: U4 begins with a one-time check via `GET /api/health/preflight` deployed to a preview URL. If it returns `{ timedOut: true, maxDuration: 60 }`, the project is on Hobby and the unit halts. If `{ timedOut: false }` after 60s, Pro extended-duration is active.
- Gateway route: `verifyCronSecret`, `refreshBots`, `after()` runs `startGatewayListener` ~750s with `AbortController` cleanup. Each forwarded event signed with `GATEWAY_FORWARDER_SECRET`; signature in `X-Gateway-Signature: v1=<hex>`.
- Webhook route, in order: (1) read raw body once; (2) verify `X-Gateway-Signature` against `GATEWAY_FORWARDER_SECRET` AND `GATEWAY_FORWARDER_SECRET_PREVIOUS` (constant-time; either accept passes; both fail → 401); (3) pre-parse attachments → stash by message id (300s LRU TTL); (4) route via `findBotByToken(x-discord-gateway-token)`; (5) SDK fires `onNewMention` / `onSubscribedMessage` (which apply the @mention filter from U3).
- Forwarder rotation: documented in U8 runbook. `vercel env add GATEWAY_FORWARDER_SECRET_PREVIOUS=<old>; vercel env add GATEWAY_FORWARDER_SECRET=<new>; deploy; wait until all instances on new code; remove PREVIOUS`.
- MESSAGE_CONTENT operator step: surfaced in U8 admin UI as a hint when `last_connected_at` is set but `last_event_at` is null after 5 minutes. Runbook (U8) documents the Discord Developer Portal toggle.

**Patterns to follow:**
- agent-co `app/api/discord/gateway/route.ts`, `app/api/webhooks/discord/route.ts`.
- `src/app/api/cron/cleanup-sessions/route.ts` — `verifyCronSecret`.
- `src/lib/crypto.ts` — `timingSafeEqual` for HMAC verify.

**Test scenarios:**
- Happy path: cron with valid `CRON_SECRET` returns 200 + bot count.
- Error path: cron with invalid `CRON_SECRET` returns 401.
- Happy path: webhook with valid `X-Gateway-Signature` (CURRENT) and matching `x-discord-gateway-token` triggers the bridge.
- Happy path: webhook with valid `X-Gateway-Signature` (PREVIOUS) during rotation window also triggers.
- Error path: webhook with invalid signature returns 401 and never calls `findBotByToken`.
- Error path: webhook with valid signature but unknown bot token returns 200 `unhandled`.
- Integration: payload with attachments stashes normalized records by message id; bridge `take` returns them.
- Integration: `/api/health/preflight` returns `{ timedOut: false }` on Pro; `{ timedOut: true }` on Hobby.

**Verification:**
- Forged-event test (raw body + bot token, no signature) returns 401.
- Rotation test with PREVIOUS=old, CURRENT=new — both signed payloads accepted.
- Local dev with sandbox Discord app + ngrok demonstrates real `@mention` flow (and confirms non-mention messages are filtered).
- Vercel plan tier confirmed before merge.

---

### U5. Slack ingress: HTTP webhook with strict signature ordering

**Goal:** HTTP webhook that verifies signature locally with strict ordering (timestamp → team_id → bot lookup → decrypt → verify), handles `url_verification` *with signature*, and triggers the chat workflow.

**Requirements:** R2, R4, R12, R16

**Dependencies:** U3.

**Files:**
- Create: `src/app/api/webhooks/slack/route.ts` (signature logic inline; ~30 lines doesn't earn a separate module)
- Modify: `.env.example` (add per-deployment `SLACK_SIGNING_SECRET` global as fallback only; per-bot secret in `platform_bot_configs.credentials_enc` is primary)
- Test: `tests/unit/platform/slack-webhook.test.ts` (covers signature vectors, replay, ordering, url_verification)

**Approach:**
- Read raw body bytes (signature verify needs unmodified bytes).
- **Strict ordering** (R12, no decryption before authentication):
  1. **Timestamp check** — `Math.abs(now - X-Slack-Request-Timestamp) <= 300` seconds. Fail → 401, no body parse.
  2. **Light JSON pointer** to extract `team_id` only — uses a length-bounded extractor (parses up to first `}` or 4KB, whichever first; rejects if `team_id` not found in that prefix).
  3. **`findBotByTeamId(teamId)`** — if null, return 200 `unhandled` immediately. **No credentials decrypted.**
  4. **Decrypt signing secret** (now that team_id is in registry).
  5. **HMAC-SHA-256** over `v0:${timestamp}:${rawBody}` with signing secret; constant-time compare against `v0=` prefix from `X-Slack-Signature`. Fail → 401.
  6. SDK fires `onAppMention` / `onMessage` → bridge `triggerChatWorkflow`.
- **URL-verification with signature**: Slack signs `url_verification` POSTs the same way as events. The route runs the signature path BEFORE returning the challenge value. (The original "short-circuit before signature verify" pattern was a permanent oracle — corrected here.) `url_verification` is just `event.type` after verification; respond with the `challenge` field.
- Bridge constructs `contextId = 'slack:${teamId}:${channelId}:${thread_ts ?? messageTs}'`.
- Idempotency key: `${tenantId}:slack:${event_id}`.

**Patterns to follow:**
- agent-co's webhook route shape.
- `src/lib/crypto.ts` — `timingSafeEqual`.
- `src/app/api/webhooks/[sourceId]/route.ts` — outer "verify → trigger in `after()`" shell.

**Test scenarios:**
- Happy path: valid signature + `app_mention` triggers workflow with correct `contextId`.
- Happy path: `url_verification` with valid signature returns the `challenge` field with 200.
- Error path: replay attack (timestamp >5 min old) returns 401 without parsing body.
- Error path: body parse fails (not JSON, no team_id in first 4KB) → 400.
- Error path: `team_id` not in registry → 200 `unhandled` BEFORE any decryption (assert via decrypt-spy).
- Error path: signature mismatch → 401.
- Error path: `url_verification` without valid signature → 401 (oracle closed).
- Integration: in-thread `message` event reuses existing `context_id`-mapped session.
- Integration: Slack retry (`X-Slack-Retry-Num: 1`) for same `event_id` no-ops via workflow idempotency.

**Verification:**
- Signature vectors pass; replay rejected; URL handshake rejects unsigned probes; decrypt-spy asserts no decryption on `team_id` miss.

---

### U6. `chatDispatchWorkflow` + bridge — Shape A WDK composition

**Goal:** WDK workflow that orchestrates rate-limit → attachment persist → start inner `dispatchWorkflow` → consume inner stream via `getRun().getReadable()` → edit-in-place with rate-aware backoff → finalize. Resumable via persisted `lastSeenIndex`.

**Requirements:** R3, R4, R5, R6, R7, R8, R9, R13, R15, R16

**Dependencies:** U2, U3, U4, U5, U7.

**Files:**
- Create: `src/lib/workflows/chat-dispatch-workflow.ts`
- Create: `src/lib/platform/bridge.ts` (thin: `triggerChatWorkflow(input)` + the @mention filter helpers re-exported for U3)
- Create: `src/lib/platform/callback.ts` (Discord/Slack post / edit / startTyping wrappers; surfaces 429 + `Retry-After`)
- Create: `src/lib/platform/format.ts` (sentence-bounded CommonMark→mrkdwn translator)
- Create: `src/lib/platform/limits.ts` (`PLATFORM_LIMITS = { discord: { maxPerMessage: 2000, editsPer5Sec: 5 }, slack: { maxPerMessage: 40000, editsPer5Sec: 100 } }`)
- Modify: `src/lib/workflows/index.ts` (export `chatDispatchWorkflow`)
- Modify: `vercel.json` (`supportsCancellation: true` for `app/api/discord/**` and `app/api/webhooks/slack/**`)
- Modify: `CLAUDE.md` (Patterns & Conventions: add chat workflow shape)
- Test: `tests/unit/platform/bridge.test.ts`
- Test: `tests/unit/platform/format.test.ts`
- Test: `tests/unit/platform/callback.test.ts`
- Test: `tests/unit/workflows/chat-dispatch-workflow.test.ts`
- Test: `tests/integration/chat-resumption.test.ts` (forced function-recycle + resume)

**Approach (Shape A):**

`bridge.triggerChatWorkflow(input)` (where `input` is JSON-serializable: tenantId, agentId, platform, threadKey, prompt, authorId, channelId, eventId, replyToMessageId, attachmentRefs[]) — calls `start.chatDispatchWorkflow(input, { idempotencyKey: '${tenantId}:${platform}:${eventId}' })`. Bot handlers in U3 call this directly post-@mention-filter.

`chatDispatchWorkflow(input)` body:

```pseudocode
"use workflow"
chatDispatchWorkflow(input):
  // 1. Inline rate-limit check (NO step — pure in-memory, no durability needed)
  const agentRL = checkRateLimit(`agent:${input.agentId}`, 30, 60_000)
  const userRL  = checkRateLimit(`user:${input.platform}:${input.authorId}`, 10, 60_000)
  if (!agentRL.allowed || !userRL.allowed):
    await postBusyReplyStep(input)  // generic copy; doesn't leak which limit fired
    return

  // 2. Persist attachments (private blob; signed URLs)
  const persisted = await persistAttachmentsStep(input.tenantId, input.attachmentRefs)
  // persisted: Array<{ path, blobUrl, signedReadUrl, contentType, sizeBytes }>

  // 3. Compose prompt with attachment block
  const composedPrompt = composePrompt(input.prompt, persisted, input.platform, input.authorDisplayName)

  // 4. Start inner dispatchWorkflow (NOT the shim — direct workflow start)
  const reservation = await reserveDispatchInputStep(input)  // tenantId, agentId, contextId, idleTtl, etc.
  const inner = await start(dispatchWorkflow, [
    { ...reservation,
      prompt: composedPrompt,
      triggeredBy: 'chat',
      contextId: input.threadKey,
      ephemeral: false,
      idleTtlSeconds: 600,
      preInjectFiles: persisted.map(p => ({ path: p.path, signedReadUrl: p.signedReadUrl, contentType: p.contentType, sizeBytes: p.sizeBytes })),
    },
    /* prepared */ null,
  ])
  const innerRunId = inner.runId
  await persistInnerRunIdStep(input, innerRunId)  // for resume

  // 5. Read inner stream via getRun().getReadable()
  const readable = getRun<RunnerChunk>(innerRunId).getReadable<string>()
  let responseText = ''
  let committedLength = 0
  let messageId: string | null = null
  let lastEditAt = 0
  let lastSeenIndex = 0
  let currentEditGateMs = 1500
  const channelBucket = new ChannelTokenBucket(PLATFORM_LIMITS[input.platform].editsPer5Sec, 5_000)

  for await (const chunk of readable):
    lastSeenIndex++
    const evt = parseRunnerChunk(chunk)
    if (evt.type === 'text_delta'):
      responseText += evt.text
    else if (evt.type === 'error'):
      await postFinalReplyStep(input, responseText + ' (agent stopped early)', messageId, committedLength)
      await markBotErrorStep(input, evt.error)
      return
    else if (evt.type === 'result'):
      break  // finalize after loop

    const now = Date.now()
    const overflow = (responseText.length - committedLength) > PLATFORM_LIMITS[input.platform].maxPerMessage
    if (overflow || (now - lastEditAt >= currentEditGateMs && channelBucket.tryConsume())):
      const slice = formatForPlatform(input.platform, responseText.slice(committedLength), { partial: !overflow })
      const result = await postOrEditStep(input, messageId, slice, overflow)
      if (result.rateLimited):
        currentEditGateMs = Math.max(currentEditGateMs, result.retryAfterMs)
        channelBucket.drain()
      else:
        messageId = result.messageId ?? messageId
        if (overflow):
          messageId = null  // seal current; next post starts new message
          committedLength = result.sealedAt
        lastEditAt = now
      await persistLastSeenStep(input, lastSeenIndex)  // for resume

  // 6. Finalize: typing stop + markBotEvent
  await finalizeChatStep(input, messageId, committedLength)
```

`postOrEditStep` body wraps `callback.ts`:
- Discord: `POST /channels/{id}/messages` (initial) or `PATCH /channels/{id}/messages/{msgId}`. On 429, parse `Retry-After` header → return `{ rateLimited: true, retryAfterMs: parseInt(retryAfter)*1000 }`.
- Slack: `chat.postMessage` (initial) or `chat.update`. Slack edits don't have a per-channel cap; rate-limit returns `Retry-After`.
- Sealed-message overflow path: PATCH the current message with the clean-newline slice + `…` suffix; return `{ sealedAt: nextStart }`. The next iteration POSTs a new message starting with `[continued] ` prefix.

`format.ts` translator:
- Discord: pass-through (CommonMark).
- Slack: only formats *complete* sentence/newline boundaries. Trailing partial token (e.g., `I am **part`) is held until the next tick. Substitutions on complete spans: `**bold**` → `*bold*`; `__italic__`/`_italic_` → `_italic_`; `[text](url)` → `<url|text>`; fenced code blocks unchanged; escape `<`, `>`, `&` outside code blocks. `<@U…>` mention syntax NOT escaped (preserves agent-emitted user mentions). Tested with snapshot vectors covering partial-token holdback.
- `partial: true` flag means no flush of trailing partial token.

`limits.ts`: `PLATFORM_LIMITS` map; not magic numbers.

`callback.ts`: thin wrappers around `bot.<platform>.<channelId>.postMessage()` / `editMessage()` / `startTyping()`. Surfaces 429 + `Retry-After` + content-type errors. Server-side only (admin route never client-loads it).

**Resumption semantics:**
- `persistLastSeenStep` writes `{ innerRunId, lastSeenIndex, responseText, committedLength, messageId, currentEditGateMs }` to workflow state on each successful edit.
- On host recycle, WDK re-enters the body at the last completed step boundary. The `for await (const chunk of readable)` re-attaches via `getRun(innerRunId).getReadable({ startIndex: lastSeenIndex })` (the inner workflow's stream supports start-index; existing `dispatchWorkflow` already uses this primitive at line 662).
- Forced-failure integration test: kill the chat workflow function host mid-stream after 5 chunks; assert resume re-attaches at chunk 6 and continues editing the same `messageId`.

**WDK cost projection:**
- Per-step price assumed at $0.0001/step (verify against current Vercel WDK pricing during U6 rollout).
- 1-min reply ≈ 40 `postOrEditStep` invocations + ~5 other steps = ~45 steps ≈ $0.0045.
- 10 concurrent chats × 1-min replies = $0.045/min ≈ $65/month sustained.
- Kill-switch: telemetry `chat.workflow_step_invocations`; if >50,000/day, force chat off via feature flag and alert.

**Execution note:** Implement test-first for resumption invariants — kill the host mid-stream, assert resume reattaches at the right index. This is the load-bearing durability claim.

**Patterns to follow:**
- `src/lib/workflows/dispatch-workflow.ts` lines ~662 — `getRun(runId).getReadable<string>()` precedent.
- agent-co `findDiscordSplit` for clean-newline rollover slicing.

**Test scenarios:**
- Happy path: short response (<2000 chars) on Discord posts once, edits 0–3 times, finalizes. `messageId` stable.
- Happy path: short response on Slack with `**bold**` posts as `*bold*`; partial token (`**part`) held until close.
- Edge case: 5000-char Discord response → first message sealed at clean newline ≤2000 chars with `…`, second prefixed `[continued] `. `committedLength` invariant holds.
- Edge case: 50000-char Slack response triggers rollover at 40000.
- Edge case: stream emits `error` mid-response → bridge posts partial with suffix; workflow exits cleanly; `markBotError` called.
- Edge case: rate-limit hit (per-agent OR per-user) → generic busy reply; no inner workflow start.
- Edge case: Discord 429 with `Retry-After: 3` → channel bucket drains, edit gate lengthens to 3000ms, subsequent edits respect new gate; no retry storm.
- Edge case: parallel threads in same channel — two `chatDispatchWorkflow` instances share the channel bucket via Redis (`@chat-adapter/state-redis`); combined edits stay under 5/5sec.
- Edge case: `text_delta` inter-arrival >5s — edit gate elapses but no content arrives; no spurious edit.
- Integration (durability): kill host after 5 chunks; assert resume at chunk 6 and same `messageId`.
- Integration (idempotency): two triggers with same `${tenantId}:${platform}:${eventId}` — second no-ops; one bot reply.
- Integration (Slack retry): two ingress events with same `event_id` → single dispatch.
- Integration (cleanup race): cleanup commits `stopped` while two events arrive — one inner workflow created, both chat workflows attach to it without ON CONFLICT errors.
- Integration (mrkdwn jitter): stream `**hel`, `lo**` separately — Slack edit shows `**hel` (held; partial-token NOT translated), then `*hello*` (closed; translated) on the second edit. No dangling-asterisk visible state.

**Verification:**
- Rollover invariants exercised on both platforms with continuation cues.
- 429 + `Retry-After` exercised; channel-bucket sharing via Redis tested.
- Resumption test forces function recycle and confirms reconnect.
- Idempotency test confirms duplicate triggers no-op.

---

### U7. Attachment mirror — single-file lib, private blob (required), URL handoff

**Goal:** Persist Discord/Slack attachments to private Vercel Blob; pass signed URLs (NOT bytes) to the dispatcher; `ensureSandboxStep` extension fetches inside its own step.

**Requirements:** R7

**Dependencies:** U2.

**Files:**
- Create: `src/lib/platform/attachments.ts` (single file: types + normalize Discord + normalize Slack + persist + inbound-cache)
- Modify: `src/lib/dispatcher.ts` (`DispatchInput` gains `preInjectFiles?: Array<{ path: string; signedReadUrl: string; contentType: string; sizeBytes: number }>`)
- Modify: `src/lib/workflows/dispatch-workflow.ts` (`ensureSandboxStep` extends to: after `coldStartSandbox`, before `casCreatingToActive`, fetch each `preInjectFiles[i].signedReadUrl` via `fetch(url, { redirect: 'error' })` → `arrayBuffer()` → `Buffer.from(...)` → `sandbox.writeFiles({ path, content })`. `Promise.allSettled` so one failure doesn't sink the batch. Both cold-start and warm-reconnect paths call this — warm path is idempotent because `writeFiles` overwrites.)
- Test: `tests/unit/platform/attachments.test.ts`
- Test: `tests/unit/workflows/preinject-files.test.ts`

**Approach:**
- `NormalizedAttachment { filename, contentType, sizeBytes, sourceUrl, sourcePlatform }`. Discord and Slack-specific normalizers map raw payload shapes → this type.
- **Source URL allowlist (security)**: Discord must be on `cdn.discordapp.com` / `media.discordapp.net`; Slack on `files.slack.com` / `*.slack-edge.com`. Reject before attaching the bot token to the request (prevents SSRF + token leak).
- **Filename + content-type sanitization**:
  1. Extract extension; lowercase; allowlist `{png,jpg,jpeg,gif,webp,pdf,txt,csv,json,md}`. Anything else → `.bin`.
  2. Verify CDN response `Content-Type` is consistent with the allowlisted extension (e.g., `.png` requires `image/png` or `image/*`; mismatch → stage as `.bin`).
  3. Stage path is `${uuid}.${safe-ext}` — no user-controlled component beyond allowlist.
- Per-attachment cap 25 MB (`PLATFORM_ATTACHMENT_MAX_BYTES` env override). Reject larger with structured log.
- `persistAttachments(tenantId, normalized)` — `Promise.allSettled`; each success uploads to **private** Vercel Blob via `BLOB_PRIVATE_READ_WRITE_TOKEN` (boot-time env validation REQUIRED — fail-closed if absent), generates a signed read URL with 10-minute TTL, returns `{ id, path, blobUrl, signedReadUrl, contentType, sizeBytes }`. The caller (`chatDispatchWorkflow`) passes only the JSON-serializable shape to the inner `dispatchWorkflow`.
- `inboundAttachmentsCache` (300s LRU, message-id keyed) lives at the bottom of the same file — the Discord webhook stashes; the bot handler `take`s.
- `composePrompt(prompt, persisted, platform, authorName)` — produces the prompt with an `## Attachments in this message` block listing filenames + staged paths so the agent's system prompt knows what's available.
- **No `Buffer` ever crosses a step boundary**: persistence step returns metadata only; the workflow body holds metadata only; `ensureSandboxStep` (inside the inner dispatch workflow) downloads bytes via fetch *inside* its own step body and immediately writes via `sandbox.writeFiles`.

**Patterns to follow:**
- `src/lib/assets.ts` — single-file Composio/Firecrawl URL → Blob persistence.
- `src/lib/sandbox.ts` `injectSkillsIntoSandbox` — `writeFiles` primitive.

**Test scenarios:**
- Happy path: 1 MB PNG Discord download → private blob → `preInjectFiles` URL → `ensureSandboxStep` fetches → staged at `/vercel/sandbox/attachments/<id>.png` with bytes intact.
- Happy path: 500 KB PDF Slack download with bot-token authorization → private blob → URL handoff → staged.
- Edge case: 26 MB attachment rejected with structured log; other attachments in batch still stage.
- Edge case: filename `report.exe` stages as `${uuid}.bin` (extension allowlist).
- Edge case: filename `safe.png` but content-type `application/x-msdownload` stages as `.bin` (content-type sanitization).
- Edge case: source URL on `evil.example.com` rejected before bot token attaches (URL allowlist).
- Edge case: filename traversal `../etc/passwd.png` → `${uuid}.png` (UUID path eliminates traversal).
- Edge case: signed URL expired between persist and ensureSandboxStep fetch → fetch fails → `Promise.allSettled` logs and skips that file; other files still stage.
- Edge case: `BLOB_PRIVATE_READ_WRITE_TOKEN` unset → boot-time env validation fails before chat ingress accepts traffic (fail closed).
- Integration: workflow `persistAttachmentsStep` with 3 attachments, one URL allowlist failure → 2 staged + 1 logged failure.
- Integration: `dispatchWorkflow` warm-reconnect with `preInjectFiles` re-stages on second message in same session (idempotent overwrite).

**Verification:**
- All persistence + staging paths exercised on both platforms.
- Allowlists (extension, content-type, source URL) enforced.
- No `Buffer` crosses workflow→step boundaries — assertion via shape inspection in tests.
- Boot-fails-closed test for missing private blob token.

---

### U8. Admin UI **Bots** tab + admin API + tabs.tsx overflow + attestation gate

**Goal:** "Bots" tab on agent detail (renamed from "Channels"). Create / rotate / disable per platform with attestation gate, workspace-size probe, bounded loading states, force-refresh as direct import. `tabs.tsx` updated for overflow handling.

**Requirements:** R10, R14, R18, R19

**Dependencies:** U2, U3.

**Files:**
- Create: `src/app/api/admin/agents/[id]/platforms/[platform]/route.ts` (GET, POST, DELETE)
- Modify: `src/app/admin/(dashboard)/agents/[id]/page.tsx` (add "Bots" tab — 9th tab)
- Modify: `src/components/ui/tabs.tsx` (add `overflow-x-auto` + scroll-snap on the tabbar; preserves design at viewports ≥1280px, scrolls horizontally below)
- Create: `src/app/admin/(dashboard)/agents/[id]/bots-tab.tsx`
- Create: `docs/runbooks/chat-platform-bots.md` (operator runbook: Discord + Slack app creation, MESSAGE_CONTENT intent step, token rotation, force-refresh, debugging, threat-model boundary, forwarder-secret rotation procedure)
- Modify: `CLAUDE.md` (add "Bots tab" to agent-detail tab list; document threat-model boundary)
- Test: `tests/unit/admin/platforms-route.test.ts`
- Test: `tests/unit/components/tabs-overflow.test.ts`

**Approach:**

API:
- `GET /api/admin/agents/:id/platforms/:platform` — public-shape config. Loads agent, derives `tenant_id` from agent row. **Returns uniform 404 for both not-found and cross-tenant cases** (no enumeration oracle).
- `POST` — accepts platform-specific credentials + `attestations.private_workspace`. Calls `validateCredentials` → if ok, calls `enforceAttestationGate` (which runs `probeWorkspaceSize`). Both must pass before encrypt + upsert. **After successful upsert, imports `refreshBots` from `src/lib/platform/bot.ts` and calls it directly** (no HTTP, no CRON_SECRET). Returns the public-shape row.
- `DELETE` — flips `enabled=false`; calls `forceRefresh()` directly.

UI:
- Two cards (Discord, Slack) under the **Bots** tab:
  - **Threat-model warning banner** at top: pre-save gating (a confirmation dialog appears on first save, requiring the operator to acknowledge "This is a private workspace. I will not connect agents with sensitive tool access (DB writes, financial integrations, customer PII) to public channels."). Persistent banner thereafter.
  - **Connection state** derived from `(enabled, last_connected_at, last_event_at, last_error, member_count_at_connect)`:
    - `Not configured` (no row) — empty card with "Connect" CTA, dotted border
    - `Disabled` (`enabled=false`) — filled card, muted, "Re-enable" button
    - `Connected` (`last_connected_at` set, recent `last_event_at`, no `last_error`) — filled card, green chip
    - `Connected — no events received` (Discord: hint "Enable MESSAGE_CONTENT privileged intent in Discord Developer Portal" + external link; Slack: hint "Make sure the bot is invited to a channel and Events API endpoint is correctly configured in api.slack.com" + external link) — surfaces 5 min after `last_connected_at` with no `last_event_at`
    - `Token rejected` (`last_error` set) — red chip, error verbatim, "Rotate Token" CTA
    - `Pending validation` (between save and `last_connected_at`) — yellow chip with timer ("validates within 9 min"); auto-refreshes every 30s
    - `Refreshing` (post-rotation 0–2s window while `forceRefresh()` runs) — chip + spinner; covers the cache eviction window
  - **Form fields** with microcopy + external-link affordances (placeholders, helper text, "Find this at" links per R10).
  - **Slack Webhook URL** — pre-rendered (deterministic from agent id + tenant id) at the top of the Slack card, **before save**, with `<CopyButton>` (existing component at `src/components/ui/copy-button.tsx`). Discord card omits this entirely.
  - **Token rotation modal**: opens with form pre-populated; submit calls POST with 5s validation timeout (matches U2). Shows spinner during validation. On `ok: false`, shows the platform's verbatim error (rate-limit, invalid format, redirect-blocked) AND preserves prior config. On success, transitions to `Refreshing` state, then `Connected`.
  - **Buttons**: Connect, Rotate Token, Disable, Re-enable. Disable shows confirm dialog ("This will stop the bot from receiving messages. Re-enable any time.").
- Rate-limit reply differentiation: not in admin UI; in agent-side reply text. Per-user limit reply: "I'm rate-limited for you specifically — wait a minute." Tenant-cap reply: "I'm currently busy across the board — wait a few minutes." Differentiated copy avoids the "global outage" perception when only one user is limited.

**Patterns to follow:**
- `src/app/admin/(dashboard)/agents/[id]/page.tsx` tabbed layout.
- `src/app/api/admin/agents/[id]/connectors/route.ts` for admin-API + RLS scaffolding.
- `src/components/ui/copy-button.tsx`, `src/components/ui/form-field.tsx`, `src/components/ui/confirm-dialog.tsx`.

**Test scenarios:**
- Happy path: POST Discord with valid token + attestation true + workspace size 10 → public-shape returned, `refreshBots` called directly, GET shows `Connected` after first event.
- Happy path: POST Slack with workspace size 50 → succeeds (under default 100 threshold).
- Edge case: POST without `attestations.private_workspace=true` → 400 with attestation error.
- Edge case: POST with workspace probe returning 250 members (> default 100) → 400 with "workspace too large; raise tenants.max_trusted_members or use a smaller workspace".
- Edge case: POST with workspace probe transient failure → 503 retry-message; second attempt succeeds.
- Edge case: POST with new token bumps `credentials_version`; force-refresh call evicts cache.
- Edge case: DELETE flips `enabled=false`; force-refresh evicts.
- Edge case: token rotation HTTP timeout (5s validation hangs) → form shows timeout error; prior config intact; cache untouched.
- Edge case: token rotation triggers Slack rate-limit → form shows "platform rate-limited validation; wait 30s".
- Error path: POST malformed (missing `signingSecret` for Slack) → 400 Zod error.
- Error path: operator using wrong agent id → uniform 404 (not 400, not 403).
- Error path: cross-tenant agent_id → uniform 404.
- Integration: UI walkthrough — tab loads at narrow viewport (1024px) with horizontal-scroll tabbar; both cards render; threat-model dialog fires on first save; force-refresh window shows `Refreshing` chip; Slack hint differs from Discord hint.

**Verification:**
- All admin routes pass standard test harness.
- Tab overflow tested at 1024px and 1280px viewports.
- Manual UI walkthrough.
- Force-refresh assertion: admin POST handler uses direct module import, NOT HTTP fetch (asserted via implementation review).

---

### U9. (No-op — distributed)

The original U9 docs unit was eliminated. Documentation deliverables are folded into the units that own them:
- `vercel.json` cron + maxDuration → U4
- `.env.example` additions → U4 + U5
- `src/lib/env.ts` Zod additions → U4 + U5 + U7 (`BLOB_PRIVATE_READ_WRITE_TOKEN` required for chat)
- `CLAUDE.md` updates → U4 (Database, Project Structure), U6 (Patterns & Conventions), U8 (Bots tab)
- `docs/runbooks/chat-platform-bots.md` runbook → U8

---

## Telemetry & Observability

Counters added in U6 / U2 / U7. Destination: existing structured logging (`src/lib/logger.ts`) with field `metric_name`; aggregated via Vercel Logs queries. No new metrics table for v1; if Datadog or similar is added later, the structured-log shape feeds in.

| Metric | Where | Purpose |
|---|---|---|
| `chat.rate_limit_hits` (per `agent_id` and per `platform_user_id`) | bridge inline rate-limit check | Capacity tuning; per-user vs per-agent split |
| `chat.tenant_cap_collisions` | dispatcher CAS error path | When to bump per-tenant `max_concurrent_sessions` |
| `chat.workflow_step_invocations` (per workflow run) | each WDK step entry | WDK cost tracking; kill-switch threshold |
| `chat.workflow_resume_count` (per `chat_run_id`) | resumption detection in workflow body | Function-recycle frequency in production |
| `chat.attachment_persist_failures` (per `tenant_id`, with reason) | `persistAttachments` allSettled | URL allowlist hits, Slack token rejections, blob errors |
| `chat.discord_429_count` (per `channel_id`) | `postOrEditStep` 429 handling | Discord rate-limit pressure on busy channels |
| `chat.workspace_probe_blocked` (per `tenant_id`, platform, member_count) | attestation gate | R19 enforcement effectiveness |
| `chat.forwarder_signature_rejections` | gateway webhook verify | Forged-event detection / rotation health |

Kill-switch: feature flag `chat.disabled` checked at the bridge `triggerChatWorkflow` entrypoint. Set on alert if `chat.workflow_step_invocations` exceeds 50,000/day platform-wide.

---

## System-Wide Impact

- **Workflow runtime**: chat dispatch composes via Shape A (workflow-invokes-workflow); chat workflow starts the existing `dispatchWorkflow` and reads its stream via `getRun().getReadable()`. No `Hook<T>`, `ReadableStream`, or `Buffer` crosses a step boundary.
- **Interaction graph**: chat ingress → `chatDispatchWorkflow` → inner `dispatchWorkflow` (existing chokepoint). Webhook routes are public HTTP authenticated by signature.
- **Error propagation**: dispatcher errors surface as `error` events in the inner workflow's stream; chat workflow finalizes cleanly with a partial-response post and calls `markBotError`. Workflow itself never throws past the finalize step.
- **State lifecycle**: thread sessions reuse `sessions.context_id`; `createSession` uses `INSERT ... ON CONFLICT DO NOTHING` for race safety. Existing cleanup-sessions cron handles idle TTL + 4h `expires_at` cap. **No new cleanup logic.**
- **API surface**: two new public webhook endpoints (`/api/webhooks/discord`, `/api/webhooks/slack`) authenticated by HMAC; one new public preflight endpoint (`/api/health/preflight`); one new admin route (`/api/admin/agents/:id/platforms/:platform`). Force-refresh is a direct module import — NO new internal HTTP route.
- **Schema impact**: one new table (`platform_bot_configs`), one new `tenants` column (`max_trusted_members`), one modified function (`createSession` becomes ON CONFLICT idempotent).
- **Sandbox impact**: `ensureSandboxStep` extended to fetch + write attachments from signed URLs inside the step body. Idempotent on warm reconnect.
- **Cleanup-vs-create race**: explicitly resolved via the `INSERT ON CONFLICT DO NOTHING` patch; integration test exercises it.
- **Tenant cap interaction**: 50-active-session cap remains. Per-thread sticky chat sessions can exhaust cap on busy public Discord; differentiated busy reply (per-user vs tenant-wide). If chat-driven tenants hit it, lift via `tenants.max_concurrent_sessions` (out of v1 scope).
- **Unchanged invariants**: dispatcher transactional CAS, budget reserve, idempotency cache (existing per-message), A2A `context_id` lookup, webhook HMAC verification.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `maxDuration: 800` requires Vercel Pro extended-duration tier | U4 begins with `/api/health/preflight` test. If Hobby, halt — re-plan ingress. |
| Discord MESSAGE_CONTENT privileged intent not enabled | Admin UI surfaces hint at `Connected — no events received`; runbook documents step. Filter at bridge ensures non-mention messages never dispatch even if intent IS enabled. |
| Workflow step cost (~40 invocations/min) inflates billing | Cost projection in Key Technical Decisions; kill-switch at 50,000 step-invocations/day. Tunable to 3s gate if observed cost is >2× projection. |
| Function recycle mid-stream loses chat reply | `persistLastSeenStep` per edit; resume re-attaches via `getReadable({ startIndex })`. Forced-failure integration test in U6. The whole reason chat is in WDK. |
| At-least-once duplicate delivery | Tenant-scoped workflow trigger key `${tenantId}:${platform}:${event_id}`. Tested. |
| `GATEWAY_FORWARDER_SECRET` rotation drops events during deploy | `_PREVIOUS` env var with dual-accept window mirrors `ENCRYPTION_KEY_PREVIOUS`. Documented in runbook. |
| Slack signing-secret shared between session blobs and attachment blobs (BLOB_PRIVATE_READ_WRITE_TOKEN) | Shared blast radius acknowledged. Future: split into `BLOB_ATTACHMENT_READ_WRITE_TOKEN` (separate plan); v1 documents in runbook. |
| Per-instance rate limit allows ≤30N msg/min/agent on multi-instance Vercel | Per-platform-user (10/min) compensates: a single user can't sustain >10/min × N. Tenant budget caps spend. KV-based limiter is a separate plan. |
| Tenant 50-active-session cap exhausted by chat traffic | Differentiated busy reply (per-user vs tenant-wide); operator-override path documented as follow-up. |
| Credential rotation lag | Reduced to ~100ms (direct module import) from 9 min. |
| Token pre-validation hits platform rate limits | 5s timeout + server-side debounce (5s per tenant+platform+tokenHash) + client-side submit-disable while in-flight. Verbatim platform error passthrough surfaces "rate-limited; wait 30s" rather than "invalid token". |
| Public-channel deployment with sensitive tools | R19 attestation + workspace-size probe at connect time. Threshold default 100 members; per-tenant override `tenants.max_trusted_members`. Below threshold: connect proceeds. Above: connect blocked with explicit message. |
| Workspace size grows above threshold post-connect | v1 only probes at connect time. Documented as known follow-up. |
| Slack `mrkdwn` translator edge cases | Sentence-boundary translation prevents mid-token jitter; snapshot tests. Iterate based on observed agent output. |
| Inbound attachment cache 60s vs 300s | TTL set to 300s (matches platform-dispatch boundary). |
| Discord 429 (5 edits/5sec/channel) collides with 1.5s gate under load | Per-channel token bucket (Redis-shared via Chat SDK state); `Retry-After` lengthens edit gate; tested. |
| Slack `url_verification` permanent oracle | URL-verification requires valid signature (Slack signs it); oracle closed. |
| Slack signing-secret TOCTOU on body parse | Strict ordering: timestamp → team_id → registry → decrypt + verify. No decryption on team_id miss. |
| Buffer in `DispatchInput.preInjectFiles` fails WDK serialization | Shape A: signed URL + metadata only; `ensureSandboxStep` fetches inside step. No `Buffer` crosses boundary. |
| Stream consumption across step boundary | Shape A: `getRun(innerRunId).getReadable()` inside workflow body; `lastSeenIndex` persisted per edit for resume. |
| `claimStreamLeaseStep` invented | Removed. Existing `getReadable({ startIndex })` is the primitive. |
| Cleanup-vs-create race | `INSERT ON CONFLICT DO NOTHING` + re-fetch in `createSession`; integration test. |
| Admin agent-id 404 enumeration oracle | Uniform 404 for not-found and cross-tenant; tested. |
| `validateCredentials` SSRF via redirect | `redirect: 'error'` on the fetch; tested. |
| Force-refresh CRON_SECRET in HTTP transit | Eliminated: admin route imports `refreshBots()` directly. No HTTP. |
| `markBotError` write site missing | Specified in U2 (sites: U4 sig fail, U5 sig fail, U6 dispatch error / 401 from platform). |
| Six connection states implementation complexity | Justified by site-specified `markBotError` calls (Token rejected reachable) and 5-min timer (Connected — no events). State derivation table is testable. |
| Discord MESSAGE_CONTENT delivers all messages | Bridge filters on `message.mentions.has(botUserId)` BEFORE `triggerChatWorkflow`. Tested. |
| Public-blob fallback contradiction | Resolved: chat code path requires `BLOB_PRIVATE_READ_WRITE_TOKEN`; boot-time env validation fails closed. CLAUDE.md fallback applies only to legacy session-files path, not chat. |

---

## Documentation / Operational Notes

- New runbook `docs/runbooks/chat-platform-bots.md` (created in U8): Discord + Slack app creation walkthroughs, MESSAGE_CONTENT intent step, token rotation, force-refresh, threat-model boundary, **forwarder-secret rotation procedure** (`_PREVIOUS` workflow), debugging missed events.
- `CLAUDE.md` updates distributed across U4 (Database, Project Structure), U6 (Patterns & Conventions for chat workflow), U8 (Bots tab).
- Vercel env additions: Upstash via Marketplace dashboard install (auto-injects `UPSTASH_REDIS_REST_URL` + `UPSTASH_REDIS_REST_TOKEN`); manual `vercel env add` for `GATEWAY_FORWARDER_SECRET` (and `_PREVIOUS` during rotations), Discord vars, Slack fallback signing secret. `BLOB_PRIVATE_READ_WRITE_TOKEN` already exists per CLAUDE.md.
- Cron change: `*/9 * * * *` for `/api/discord/gateway`. Watch logs for the first 24h to confirm overlap behavior.
- Vercel function config: `app/api/discord/**` → `maxDuration: 800`, `supportsCancellation: true`. `app/api/webhooks/slack/**` → default `maxDuration: 300`, `supportsCancellation: true`.
- Telemetry counters (above): structured logs only; no new aggregator wiring in v1.

---

## Sources & References

- Reference implementation: `~/code/agent-co/lib/platform/`, `~/code/agent-co/app/api/discord/`, `~/code/agent-co/app/api/webhooks/discord/`, `~/code/agent-co/app/api/internal/platform-dispatch/`.
- Vercel Chat SDK docs: https://chat-sdk.dev, https://github.com/vercel/chat
- Slack adapter: https://chat-sdk.dev/adapters/slack
- Discord adapter: https://chat-sdk.dev/adapters/discord
- Vercel KB — Slack bot serverless guide: https://vercel.com/kb/guide/how-to-build-a-slack-bot-with-next-js-and-redis
- AgentPlane dispatcher: `src/lib/dispatcher.ts`, `src/lib/workflows/dispatch-workflow.ts` (line ~662 for the `getRun(runId).getReadable()` precedent)
- AgentPlane workflow refactor plan (precedent): `docs/plans/2026-05-05-001-refactor-workflow-sdk-dispatch-plan.md`
- AgentPlane crypto + key rotation: `src/lib/crypto.ts` (`ENCRYPTION_KEY_PREVIOUS` model for `GATEWAY_FORWARDER_SECRET_PREVIOUS`)
- AgentPlane sandbox primitive: `src/lib/sandbox.ts` `writeFiles`
- Trigger-table mapping for `chat`: `CLAUDE.md` (idle 600s, persistent)
- Slack signing-secret HMAC spec: `v0:${timestamp}:${body}` HMAC-SHA-256; constant-time compare to `v0=` prefix.
- Discord rate limits: 5 edits/5sec/channel; per-bucket `Retry-After` headers.
