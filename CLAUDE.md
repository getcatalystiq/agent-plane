# AgentPlane

A multi-tenant platform for running AI agents in isolated Vercel Sandboxes, exposed via a REST API. Supports any model via Vercel AI Gateway with dual runner architecture (Claude Agent SDK + Vercel AI SDK).

## Architecture

**Stack:** Next.js 16 (App Router) · TypeScript · Neon Postgres · Vercel Sandbox · Vercel Blob · Tailwind CSS v4 · Recharts

**Core concepts:**
- **Tenant** — isolated workspace with its own API keys, agents, budget, and timezone
- **Agent** — configuration (model, runner, tools, permissions, skills, plugins, git repo, schedule, max runtime). Supports any Vercel AI Gateway model. Runner auto-selected: Claude Agent SDK for Anthropic models, Vercel AI SDK (ToolLoopAgent) for all others
- **Session** — the only execution unit. Wraps one or more `session_messages`. Lifecycle states: `creating` → `active` ↔ `idle` → `stopped`. Persistent by default; one-shot calls flag `ephemeral: true` and the dispatcher stops the sandbox synchronously after the terminal event
- **Session Message** — one execution row inside a session. Owns billing-grade fields (cost, tokens, transcript_blob_url, runner, error_type, started_at, completed_at) and the audit triple (`triggered_by`, `webhook_source_id`, `created_by_key_id`)
- **Schedule** — per-agent cron configuration (manual/hourly/daily/weekdays/weekly) with timezone-aware execution
- **MCP Server** — tenant-scoped custom OAuth-authenticated tool server; agents connect via OAuth 2.1 PKCE
- **Plugin Marketplace** — tenant-scoped GitHub repo containing reusable agents/skills/connectors that agents can install
- **A2A Protocol** — Agent-to-Agent protocol (Linux Foundation) server; exposes agents to external A2A-compliant clients via Agent Cards and JSON-RPC

### Migration cutover note

The legacy `runs` table and `/api/runs*` surface were dropped at cutover (migration `033_runs_sessions_unify.sql`). Historical run rows were not migrated — every prior run is gone, and any external `/api/runs/:id` URLs return 404. Sessions own all execution from this point forward.

### Execution flow (unified)

Every execution — public REST, schedule cron, webhook delivery, A2A — funnels through the single dispatch chokepoint `dispatchSessionMessage()` in `src/lib/dispatcher.ts`:

1. Caller resolves or creates a session row (or reuses one via `contextId` for A2A multi-turn)
2. Atomic CAS `idle→active` (or `creating→active` on first message). 0 rows updated → `InSessionConflict` → 409
3. Transactional budget reserve + tenant concurrency cap check (50 active sessions)
4. Append `session_messages` row in `running` with the audit fields
5. `ensureSandbox()` — provision from SDK snapshot or reconnect; inject skill / plugin / SoulSpec files
6. `buildMcpConfig()` — Composio + custom MCP, parallel token refresh via `Promise.allSettled`
7. Spawn per-message `runner-<messageId>.mjs`; runner type chosen by model (Claude SDK vs Vercel AI SDK ToolLoopAgent)
8. Stream NDJSON: heartbeat every 15s; auto-detach with `stream_detached` after 4.5min
9. Persist Composio/Firecrawl ephemeral assets to Vercel Blob; capture transcript with truncation rules (preserve `result` + `error` events past `MAX_TRANSCRIPT_EVENTS`; never store `text_delta` chunks)
10. Runner uploads transcript to `/api/internal/messages/:messageId/transcript` with a message-scoped bearer token
11. `finalizeMessage()` — write transcript blob, billing, mark message status, increment monthly spend
12. Session transitions: `idle` if persistent, `stopped` if ephemeral (sandbox killed before stream closes)

### Trigger → ephemeral / idle-TTL mapping

| Trigger | `ephemeral` | `idle_ttl_seconds` |
|---|---|---|
| `api` (public REST) | true | n/a |
| `webhook` (delivery) | true | n/a |
| `a2a` (`message/send`, no contextId) | true | n/a |
| `a2a` (`message/send`, contextId hits existing session) | false | inherits existing session |
| `playground` (admin UI) | false | 600 (10 min) |
| `chat` (admin follow-ups) | false | 600 (10 min) |
| `schedule` (cron tick) | false | 300 (5 min — short follow-up window, bounds idle-sandbox accumulation under cron drift) |

All sessions also carry an `expires_at` hard wall-clock cap (4h from creation) enforced by the cleanup cron, regardless of idle/active state.

### Lifecycle states

```
creating  -- (sandbox boot ok) -------------> active
active    -- (msg done, ephemeral=true) ----> stopped
active    -- (msg done, ephemeral=false) ---> idle
idle      -- (new message arrives) ---------> active
idle      -- (cleanup cron, > idle TTL) ----> stopped
any       -- (cancel) ----------------------> stopped
```

## Key Commands

```bash
npm run dev            # start dev server
npm run build          # type-check + build (Next.js)
npm run test           # vitest run (server tests)
npm run test:watch     # vitest watch mode
npm run migrate        # run DB migrations (requires DATABASE_URL)
npm run create-tenant  # create a tenant + API key
npx tsx scripts/create-api-key.ts <tenant-id>  # generate additional API keys
```

## Project Structure

```
src/
  app/
    page.tsx              # Landing page ("Claude Agents as an API")
    api/
      a2a/[slug]/         # A2A protocol endpoints
        .well-known/agent-card.json/  # public Agent Card discovery (rate-limited, cached)
        jsonrpc/          # authenticated JSON-RPC (message/send, message/stream, tasks/get, tasks/cancel)
      agents/             # CRUD + skills + plugins + Composio OAuth + MCP connections (no run creation — sessions own execution)
      composio/           # tenant-scoped Composio toolkit + tool discovery
      internal/           # internal endpoints (per-message transcript upload from sandbox)
        messages/[messageId]/transcript/  # message-scoped bearer-token upload
      sessions/           # tenant-scoped session CRUD + per-message send/stream/cancel (NDJSON)
        [sessionId]/
          messages/       # POST send next message, GET list
            [messageId]/  # GET, stream/
          stream/         # session-level stream sugar (resolves to in-flight message)
          cancel/         # POST 204 — abort + stop sandbox
      admin/
        agents/           # admin agent CRUD + connectors + MCP connections + plugin suggestions + SoulSpec identity (validate-soul, import-soul, export-soul, publish-soul, generate-soul)
        composio/         # available Composio toolkits + tools listing
        login/            # admin JWT authentication
        mcp-servers/      # custom MCP server CRUD
        plugin-marketplaces/  # marketplace CRUD + plugin listing + file editing
        sessions/         # admin session management + cancellation + playground messaging
        tenants/          # tenant CRUD + API key management
      cron/               # scheduled jobs
        budget-reset/     # daily budget reset
        cleanup-sessions/ # every 5 min: idle TTL stop + stuck watchdog (creating>5min, active>30min) + orphan-sandbox sweep + expires_at cap
        cleanup-transcripts/  # daily transcript cleanup
        refresh-snapshot/  # daily SDK snapshot refresh (Vercel Sandbox snapshot)
        scheduled-runs/   # per-minute scheduled agent dispatcher (calls dispatchSessionMessage with triggeredBy='schedule', ephemeral=false, idle_ttl=300s — see trigger table)
      health/             # health check (no auth)
      keys/               # tenant-scoped API key management
      mcp-servers/        # MCP OAuth callback + server listing
      plugin-marketplaces/  # tenant-scoped marketplace + plugin discovery
      tenants/            # tenant self-service (GET /me)
      webhooks/[sourceId]/  # public HMAC-verified webhook ingress (dispatches via dispatchSessionMessage with ephemeral=true)
    admin/                # Admin UI (Next.js pages, dark mode)
      (auth)/login/       # login page
      (dashboard)/
        page.tsx          # dashboard overview (stat cards + executions/cost charts)
        run-charts.tsx    # Recharts line charts (executions/day, cost/day per agent — sourced from session_messages)
        agents/           # agent list + tabbed detail (General, Identity, Connectors, Skills, Plugins, Schedules, Runs)
        mcp-servers/      # custom MCP server management
        plugin-marketplaces/  # marketplace list + detail + plugin editor (tabbed: Agents, Skills, Connectors)
        sessions/         # session list + detail (per-message accordion, transcript viewer, cancel button, source filter, live streaming)
        settings/         # company settings (name, slug, timezone, budget, logo, API keys, danger zone)
  db/
    index.ts              # DB client (Pool, query helpers, RLS context, transactions)
    migrate.ts            # migration runner
    migrations/           # sequential SQL migration files (001–033), run via `npm run migrate`
  lib/
    a2a.ts                # A2A protocol: status mapping, Agent Card builder/cache, MessageBackedTaskStore, SandboxAgentExecutor, input validation
    types.ts              # branded types (TenantId, AgentId, McpServerId, McpConnectionId, PluginMarketplaceId), domain interfaces, StreamEvent union
    env.ts                # Zod-validated env (getEnv())
    validation.ts         # Zod request/response schemas (SessionRow, SessionMessageRow, ...)
    auth.ts               # API key authentication + tenant RLS context + A2A single-query auth
    admin-auth.ts         # admin JWT + cookie auth
    sandbox.ts            # Vercel Sandbox creation + SDK snapshot management + dual runner (Claude SDK + AI SDK) + session sandbox + skill/plugin injection + AgentCo bridge
    dispatcher.ts         # SINGLE dispatch chokepoint — `dispatchSessionMessage()` and `cancelSession()`. Every execution path imports from here.
    sessions.ts           # session lifecycle (create, atomic CAS, transition, stop, idle/stuck queries, expires_at)
    session-messages.ts   # per-message lifecycle (append, transition, billing/concurrency atomic checks)
    model-catalog.ts      # Model catalog: CatalogModel type, listCatalogModels() with 15-min cache from Vercel AI Gateway
    models.ts             # Model detection, runner routing (RunnerType, supportsClaudeRunner, resolveEffectiveRunner)
    runners/
      vercel-ai-shared.ts       # Shared code snippets for Vercel AI SDK runners (preamble, tools, MCP, agent execution)
      vercel-ai-runner.ts       # One-shot Vercel AI SDK runner (ToolLoopAgent, skills prompt, skill registry)
      vercel-ai-session-runner.ts  # Session Vercel AI SDK runner (conversation history, ToolLoopAgent)
    session-files.ts      # session file backup/restore to Vercel Blob (multipart upload)
    schedule.ts           # schedule config management, cron expression building, timezone-aware scheduling
    timezone.ts           # browser-safe timezone validation using Intl.DateTimeFormat
    cron-auth.ts          # cron secret verification for scheduled run endpoints
    mcp.ts                # MCP config builder (Composio + custom servers)
    mcp-connections.ts    # MCP connection orchestration (OAuth, token refresh, caching)
    mcp-oauth.ts          # OAuth 2.1 PKCE HTTP calls (discovery, registration, token exchange)
    mcp-oauth-state.ts    # signed MCP OAuth state token generation
    oauth-state.ts        # signed Composio OAuth state token generation
    composio.ts           # Composio MCP integration (toolkit auth, server lifecycle, shared discovery helpers, BYOA OAuth + custom-token + whoami capture)
    connection-metadata.ts  # JSONB merge helpers for agents.composio_connection_metadata + audit log
    plugins.ts            # plugin discovery + file fetching (GitHub, caching)
    github.ts             # GitHub API client (tree, content, write access, atomic push)
    identity.ts           # SoulSpec v0.5 identity parsing (SOUL.md, IDENTITY.md, STYLE.md), deriveIdentity, progressive disclosure (Level 1/2/3)
    clawsouls.ts          # ClawSouls registry API client (list, search, get, download, publish, validate souls)
    soul-manifest.ts      # shared soul.json manifest builder + file-to-column mapping
    soul-generation.ts    # LLM-powered "Generate Soul" — AI Gateway prompt builder for all 8 SoulSpec files
    agents.ts             # agent loading helper
    assets.ts             # ephemeral asset persistence (Composio URLs → Vercel Blob)
    streaming.ts          # SSE/NDJSON streaming (heartbeats, stream detach with messageId + sessionId)
    transcript-utils.ts   # captureTranscript generator, parseResultEvent helper
    transcripts.ts        # Vercel Blob transcript storage (allowOverwrite for race safety)
    api.ts                # withErrorHandler, jsonResponse helpers
    crypto.ts             # ID generation, key hashing, AES-256-GCM encryption, generateMessageToken/verify
    idempotency.ts        # idempotent request handling
    rate-limit.ts         # Vercel KV-based rate limiting
    errors.ts             # typed error classes
    logger.ts             # structured logger
    utils.ts              # misc helpers
  components/
    file-tree-editor.tsx  # nested folder editor with CodeMirror (language-aware)
    model-selector.tsx    # searchable model combobox (cmdk + Radix Popover, AI Gateway catalog)
    toolkit-multiselect.tsx  # Composio toolkit picker (search, logos)
    local-date.tsx        # client-side date formatting
    layout/
      company-switcher.tsx   # tenant/company dropdown selector
      top-bar.tsx            # breadcrumb navigation bar
    ui/                   # shared UI primitives (badge, button, card, dialog, confirm-dialog, form-field, tabs, etc.)
      button.tsx             # CVA-styled button (variants: default/destructive/destructive-outline/outline/secondary/ghost/link; sizes: default/sm/lg/icon/icon-xs/icon-sm/icon-lg; supports asChild via Radix Slot)
      copy-button.tsx        # clipboard copy button with checkmark feedback
      message-source-badge.tsx  # color-coded badge for message trigger source (API, Schedule, Playground, Chat, A2A, Webhook)
      detail-page-header.tsx # standardized detail page header (title, description, eyebrow, actions slot)
      section-header.tsx     # consistent section headers (title + optional description + actions slot)
      confirm-dialog.tsx     # managed confirmation dialog (replaces browser confirm())
      form-field.tsx         # form field wrapper with label + error display
      tabs.tsx               # line-style tabs matching AgentCo design
      empty.tsx              # empty-state primitive (Empty/EmptyHeader/EmptyMedia/EmptyTitle/EmptyDescription/EmptyContent)
      icon-container.tsx     # rounded muted square wrapper for icons (sizes: sm/default/lg; tones: muted/accent/primary/destructive/outline)
      spinner.tsx            # CSS spinner (sizes: sm/default/lg)
      tooltip.tsx            # CSS-only group-hover tooltip (sides: top/right/bottom/left)
      theme-toggle.tsx       # dark mode toggle
  middleware.ts           # auth middleware (API key, JWT cookie, OAuth callback bypass)
scripts/
  create-tenant.ts        # CLI to provision tenant + API key
  create-api-key.ts       # CLI to generate additional API keys for a tenant
tests/
  unit/                   # Vitest unit tests
```

## Database

Neon Postgres with Row-Level Security (RLS). Tables: `tenants`, `api_keys`, `agents`, `sessions`, `session_messages`, `mcp_servers`, `mcp_connections`, `plugin_marketplaces`, `webhook_sources`, `webhook_deliveries`.

- Agent names are unique per tenant
- RLS enforced via `app.current_tenant_id` session config (fail-closed via `NULLIF`)
- Tenant-scoped transactions via `withTenantTransaction()`
- Migrations: numbered SQL files in `src/db/migrations/` (currently 001–033), run via `npm run migrate`. Migration `033_runs_sessions_unify.sql` drops the legacy `runs` table and the prior two-purpose `sessions` table; rebuilds `sessions` and creates `session_messages`.
- `tenants` table includes: `timezone` column for schedule evaluation, `logo_url` (base64 data URL or external URL), `clawsouls_api_token` (encrypted, for ClawSouls registry publish)
- `agents` table includes: Composio MCP cache columns, `composio_allowed_tools` (per-toolkit tool filtering), `composio_connection_metadata` JSONB (per-toolkit `auth_method` + `bot_user_id` + `display_name` for the auth-method picker), `skills` JSONB, `plugins` JSONB, schedule columns (`schedule_frequency`, `schedule_time`, `schedule_day_of_week`, `schedule_prompt`, `schedule_enabled`, `last_run_at`, `next_run_at`), `max_runtime_seconds` (60–3600, default 600), `a2a_enabled` (boolean, default false; partial index on `tenant_id WHERE a2a_enabled = true`), SoulSpec v0.5 identity columns (`soul_md`, `identity_md`, `style_md`, `agents_md`, `heartbeat_md`, `user_template_md`, `examples_good_md`, `examples_bad_md`, `soul_spec_version` TEXT default '0.5', `identity` JSONB auto-derived)
- `sessions` table — primary execution lifecycle row. Columns: `sandbox_id` (NULL when stopped), `sdk_session_id` (Claude Agent SDK session), `session_blob_url` (Vercel Blob backup), `status` (`creating`/`active`/`idle`/`stopped`), `ephemeral` (bool, default false), `idle_ttl_seconds` (set by dispatcher per the trigger table; CHECK ≤ 3600; not user-supplied), `expires_at` (`created_at + interval '4 hours'`), `context_id` (A2A multi-turn key), `message_count`, `idle_since`, `last_backup_at`. Partial unique index on `(tenant_id, agent_id, context_id) WHERE status NOT IN ('stopped') AND context_id IS NOT NULL` for A2A reuse lookup.
- `session_messages` table — one row per execution. Owns billing-grade fields and the audit triple. Columns: `session_id` FK ON DELETE CASCADE, `tenant_id`, `prompt`, `transcript_blob_url`, `status` (`queued`/`running`/`completed`/`failed`/`cancelled`/`timed_out`), `triggered_by` (`api`/`schedule`/`playground`/`chat`/`a2a`/`webhook`), `error_type`, `error_messages text[]`, `cost_usd`, `total_input_tokens`, `total_output_tokens`, `cache_read_tokens`, `cache_creation_tokens`, `num_turns`, `duration_ms`, `duration_api_ms`, `model_usage` JSONB, `result_summary`, `runner` (`claude-agent-sdk`/`vercel-ai-sdk`), `webhook_source_id` FK (NULL except for webhook-triggered messages), `created_by_key_id` FK to api_keys (audit trail), `started_at`, `completed_at`, `created_at`.
- Tenant concurrency cap: 50 active sessions per tenant (counts only `creating` + `active`; `idle` is free until cleanup). Enforced atomically inside `withTenantTransaction()` using a single SQL guard to avoid TOCTOU races. Sessions are the cap unit, not messages.
- `triggered_by` lives on `session_messages`, NOT on `sessions` — a session can mix triggers across messages over its lifetime.
- `mcp_servers` — tenant-scoped registry (OAuth 2.1 client credentials, RLS enforced); unique slug per tenant
- `mcp_connections` — per-agent OAuth connections (tenant-scoped RLS, unique per agent-server pair)
- `plugin_marketplaces` — tenant-scoped registry of GitHub repos (RLS enforced); unique github_repo per tenant; optional encrypted GitHub token for push-to-repo editing
- `webhook_sources` — tenant-scoped inbound webhook registry (RLS enforced); per-source HMAC secret encrypted at rest with 7-day rotation overlap, configurable signature header, prompt template, optional filter rules; unique name per tenant
- `webhook_deliveries` — per-request audit log + idempotency key store. Columns include `message_id` (FK to `session_messages`, replacing the legacy `run_id` at cutover) and `dedupe_key`. `UNIQUE (source_id, delivery_id)` powers the 200-duplicate dedupe path; cascades on source delete.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | Neon connection string (pooled) |
| `DATABASE_URL_DIRECT` | No | Direct connection for migrations (preferred over unpooled) |
| `DATABASE_URL_UNPOOLED` | No | Neon non-pooled URL; auto-set by Vercel integration; used for migrations |
| `ADMIN_API_KEY` | Yes | Admin API authentication |
| `AI_GATEWAY_API_KEY` | Yes | Vercel AI Gateway key |
| `ENCRYPTION_KEY` | Yes | 64 hex chars (32 bytes) for AES-256-GCM encryption (keys, tokens, credentials) |
| `ENCRYPTION_KEY_PREVIOUS` | No | 64 hex chars; supports seamless key rotation |
| `BLOB_READ_WRITE_TOKEN` | No | Vercel Blob public store (transcript + asset storage) |
| `BLOB_PRIVATE_READ_WRITE_TOKEN` | No | Vercel Blob **private** store for session files (conversation history). Falls back to `BLOB_READ_WRITE_TOKEN` if unset, but `access: "private"` only works against a store provisioned for it. |
| `COMPOSIO_API_KEY` | No | Composio MCP tool integration (optional if not using Composio toolkits) |
| `CRON_SECRET` | No | Vercel Cron authentication (must be manually set; random string ≥16 chars) |
| `BRAINTRUST_API_KEY` | No | Braintrust observability; when set, sandbox runners auto-trace LLM calls to Braintrust |

## API Authentication

All routes (except `/api/health`) require `Authorization: Bearer <api_key>`. Admin routes use `ADMIN_API_KEY` (or JWT cookie via `/api/admin/login`). OAuth callbacks (`/api/agents/*/connectors/*/callback`, `/api/mcp-servers/*/callback`) are unauthenticated (external provider redirects). A2A Agent Card (`/.well-known/agent-card.json`) is public (rate-limited by IP). A2A JSON-RPC uses `authenticateA2aRequest()` (single-query slug+key auth, constant-time). API keys are hashed with SHA-256; optionally encrypted at rest with `ENCRYPTION_KEY`. Internal transcript upload uses message-scoped bearer tokens (`generateMessageToken(messageId)` / verifier); a token minted for message A is rejected on the URL for message B even if both belong to the same tenant.

## Deployment

- **Hosting:** Vercel
- **Production:** deployed on Vercel
- Push to `main` triggers automatic production deploy
- **Migrations run automatically on every deploy** via `buildCommand` in `vercel.json` (`npm run migrate && next build`); failed migrations abort the deploy
- Migration connection priority: `DATABASE_URL_DIRECT` → `DATABASE_URL_UNPOOLED` → `DATABASE_URL`
- `DATABASE_URL_UNPOOLED` is auto-set when Neon is linked via the Vercel integration
- Security headers set via `next.config.ts`: HSTS, X-Content-Type-Options, X-Frame-Options DENY, Referrer-Policy
- Vercel functions config: `app/api/sessions/**`, `app/api/admin/sessions/**`, and `app/api/a2a/**` have `supportsCancellation: true` for streaming cancellation. `app/api/runs/**` no longer exists.

## Sandbox & Runner

- Sandboxes are created from a pre-built SDK snapshot (with `@anthropic-ai/claude-agent-sdk`, `ai`, `@ai-sdk/mcp`, `@modelcontextprotocol/sdk`, `zod`, `braintrust` pre-installed); falls back to fresh npm install if no snapshot exists
- **Braintrust tracing:** When `BRAINTRUST_API_KEY` is set, sandbox runners call `initLogger()` before loading AI SDKs so all LLM calls are auto-traced to the "AgentPlane" project; gracefully skipped if braintrust is unavailable
- SDK snapshots are refreshed daily at 4am UTC via `/api/cron/refresh-snapshot`; old snapshots (>24h) are cleaned up automatically
- **Dual runner architecture:** Claude Agent SDK for Anthropic models (session resumption, permission modes, `.claude/` conventions), Vercel AI SDK `ToolLoopAgent` for all other providers
- Vercel AI SDK runner uses `createGateway({ apiKey })` from `ai` package; `AI_GATEWAY_API_KEY` env var set in sandbox
- Vercel AI SDK runner tools (9 total): `load_skill`, `sandbox__read_file`, `sandbox__write_file`, `sandbox__list_files`, `sandbox__bash`, `sandbox__web_fetch`, `sandbox__web_search`, `sandbox__complete_task`, plus MCP tools
- Vercel AI SDK skills follow the skill-as-tool pattern: system prompt lists skills by name/description, `load_skill` tool loads full instructions on-demand
- Vercel AI SDK sessions manage conversation history via `session-history.json` (message array replayed each turn) instead of Claude SDK's `resume` feature
- `ToolLoopAgent` uses combined stop conditions: `stepCountIs(maxTurns)` + `hasToolCall('sandbox__complete_task')`
- Runner shared code in `src/lib/runners/vercel-ai-shared.ts`: preamble, tool definitions, MCP setup, agent execution
- Claude SDK shared code in `sandbox.ts`: `claudeSdkPreamble()`, `claudeSdkStreamLoop()`, `claudeSdkErrorAndCleanup()`
- Snapshot ID is cached at the process level with TTL; `findSdkSnapshot()` looks up existing snapshots, `refreshSdkSnapshot()` creates new ones
- Git repo agents skip snapshots (need fresh clone)
- `ENABLE_TOOL_SEARCH=true` is set in the sandbox env to enable dynamic tool discovery for agents with many MCP tools
- When MCP servers are present, `allowedTools` is suppressed so `mcp__*` tool names aren't blocked
- SoulSpec identity files → `.soul/SOUL.md`, `.soul/IDENTITY.md`, `.soul/STYLE.md`, `.soul/AGENTS.md`, `.soul/HEARTBEAT.md` (injected into sandbox alongside skills/plugins)
- Plugin skill files → `.claude/skills/<plugin-name>-<subfolder>/<filename>`; plugin agent files → `.claude/agents/<plugin-name>-<agent>.md`
- Network allowlist: `ai-gateway.vercel.sh`, `*.composio.dev`, `*.firecrawl.dev`, `*.githubusercontent.com`, `html.duckduckgo.com`, `api.braintrust.dev`, `registry.npmjs.org`, platform API host, custom MCP server hosts, AgentCo callback hosts
- Runner ALWAYS uploads transcript to platform via `/api/internal/messages/:messageId/transcript` with a message-scoped bearer token (not just detached runs). For ephemeral sessions, the upload endpoint is the authoritative sandbox-stop trigger when the request context has detached: it verifies the token, loads the parent session, refuses unless `ephemeral=true`, and gates the stop on an atomic `UPDATE sessions SET status='stopped' WHERE ephemeral=true AND status NOT IN ('stopped')` so retries are idempotent.
- AgentCo callback bridge: stdio MCP server injected into sandbox when A2A request includes callback data; env vars passed explicitly via `StdioClientTransport({ env })` for subprocess inheritance
- Model catalog (`/api/admin/models`, `/api/models`): fetches from `GET https://ai-gateway.vercel.sh/v1/models`, 15-min cache, Zod validation, stale-on-error fallback
- Cost computation for Vercel AI SDK runs: `parseResultEvent` looks up model pricing from catalog, calculates `(input_tokens × price + output_tokens × price) / 1M`
- Message `runner` column set at insert time via `resolveEffectiveRunner()` (no default to claude-agent-sdk)
- Transcript viewer supports both Claude SDK (nested `assistant.message.content` blocks) and Vercel AI SDK (flat `tool_use`, `tool_result`, `run_started`, `mcp_error` events) formats. The `run_started` wire string is preserved for SDK type-union backwards compatibility even though the underlying object is a session message.

## Patterns & Conventions

- Branded types (`TenantId`, `AgentId`, `McpServerId`, `McpConnectionId`, `PluginMarketplaceId`) prevent parameter swaps at compile time. Note: `RunId` was retired with the schema cutover; sessions and messages use plain string ids.
- All DB queries go through typed helpers in `src/db/index.ts` with Zod validation
- Use `withErrorHandler()` wrapper on every API route handler
- Composio MCP server URL + API key are cached per agent in the `agents` table (encrypted at rest)
- Composio connectors support three auth methods, picked per-toolkit on the connector card: **Composio-managed OAuth** (default), **bring-your-own-app OAuth** (tenant supplies `client_id` + `client_secret`, e.g. Linear `actor=app`), and **custom token** (Slack `xoxb-`, Notion `secret_…`). Auth configs are per-tenant; MCP server creation looks up the auth config via `connectedAccounts.list({ user_ids: [tenantId] })` to prevent cross-tenant credential leaks. Post-connect identity is captured via a slug-keyed whoami registry (slack/notion/linear) and stored in `agents.composio_connection_metadata` as `bot_user_id` + `display_name`. Capture failures set `capture_deferred: true`; the UI exposes a re-capture link.
- Custom MCP servers use OAuth 2.1 PKCE; tokens refreshed automatically with 2-phase retry on transient 5xx
- Agent skills are injected as files into the sandbox at `.claude/skills/<folder>/<path>`
- Plugin files are injected into the sandbox at `.claude/skills/` and `.claude/agents/`
- Process-level caching with TTLs: MCP servers (5 min), plugin trees (5 min), recent pushes (2 min)
- SSE/NDJSON streams send heartbeats every 15s and auto-detach after 4.5 min for long-running messages; `stream_detached` carries `messageId` + `sessionId` and `poll_url` + `stream_url` pointing at the per-message reconnect surface
- Ephemeral asset URLs (Composio/Firecrawl) are persisted to Vercel Blob in both platform-finalized and runner-uploaded transcripts
- Non-Anthropic models always force Vercel AI SDK runner via `resolveEffectiveRunner()`, ignoring stored runner preference
- `load_skill` tool accepts parameter name variants (`name`, `skill_name`, `skill_identifier`) for cross-model compatibility
- Admin UI is always dark mode via `.dark` class on the layout root; Tailwind v4 dark variant is configured with `@variant dark (&:where(.dark, .dark *))` in `globals.css`
- Admin UI uses system font stack (no Geist) to match AgentCo design
- Landing page (`/`) is a dark-mode marketing page with hero, features, how-it-works, architecture, and CTA sections
- Sandbox network policy allowlists: AI Gateway, Composio, Firecrawl, GitHub, npm registry, platform API, custom MCP servers
- Max 50 concurrent active sessions per tenant. Counts only `creating` + `active` — `idle` sessions do not count and are free until cleanup. Atomic concurrent check inside the dispatcher transaction prevents TOCTOU races.
- Per-session in-flight cap is 1: only one message may be `running` at a time. Concurrent POSTs to the same session race on the `idle→active` CAS; loser receives 409 `InSessionConflict`.
- Transcript viewer renders markdown via `react-markdown` + `remark-gfm`; HTML sanitized with `dompurify`
- JSONB array mutations use atomic SQL guards (`NOT EXISTS` for uniqueness, `jsonb_array_length` for limits) to prevent TOCTOU races
- Composio discovery helpers (`listComposioToolkits`, `listComposioTools`) are shared between admin and tenant routes via `src/lib/composio.ts`; tool pagination capped at 10 pages
- Scheduled runs: cron dispatcher runs every minute, claims due agents (`FOR UPDATE SKIP LOCKED`), computes next run time, and dispatches via `dispatchSessionMessage({ triggeredBy: 'schedule', ephemeral: false, idle_ttl_seconds: 300 })`. The session stays warm across cron ticks within the 300s idle window so a follow-up tick can reuse the same sandbox; the cleanup cron stops it once the per-row TTL elapses. Matches the trigger table at the top of this file.
- Webhook ingress: HMAC verify → `webhook_deliveries` idempotent insert → optional content-dedupe + filter → `dispatchSessionMessage({ triggeredBy: 'webhook', ephemeral: true, webhookSourceId })` in `after()`. Duplicate `delivery_id` returns 200 with the original `message_id`.
- A2A executor: looks up `findSessionByContextId(tenantId, contextId)` first; if a non-stopped session is found, reuses it (`ephemeral: false`, append message). Otherwise creates a fresh ephemeral session. The returned `messageId` becomes the A2A `taskId`. `tasks/cancel` maps `taskId` → `messageId` → `sessionId` → `cancelSession()`.
- Transcript capture preserves critical events (`result` and `error`) even after `MAX_TRANSCRIPT_EVENTS` truncation, and excludes `text_delta` events from the chunks array (per the institutional learning in `docs/solutions/logic-errors/transcript-capture-and-streaming-fixes.md`).
- Timezone validation extracted to `src/lib/timezone.ts` to avoid pulling `croner` into client bundles
- `croner` library used for cron expression evaluation and next-run-time computation
- Session sandbox uses per-message `runner-<messageId>.mjs` scripts with `resume: sdk_session_id`; no persistent process inside sandbox
- Session file backup (to Vercel Blob) is synchronous and skipped for ephemeral sessions — completes BEFORE response stream closes for persistent sessions to prevent TOCTOU race with cleanup cron
- Session file uploads use `multipart: true` for Blob put() to handle >4.5MB server upload limit
- MCP token refresh in `buildMcpConfig()` is parallelized with `Promise.allSettled()` for faster cold starts
- Cleanup cron `/api/cron/cleanup-sessions` (every 5 min) consolidates all sweeps: per-session idle TTL stops; watchdog catches stuck `creating` (>5 min) and `active` (>30 min); orphan-sandbox sweep (any `sessions` row with non-null `sandbox_id` past terminal state); `expires_at` hard cap (4h wall-clock) regardless of state. The legacy `cleanup-sandboxes` cron was removed.
- Cleanup-vs-dispatch race on `idle→stopped`: public `/api/sessions/:id/messages` returns 410 Gone with `{error: 'session_stopped'}` when the named session is gone — clients must `POST /api/sessions` to start a new one. Internal callers (schedule cron, webhook handler, A2A executor) pass `sessionId?` optionally and the dispatcher transparently creates a fresh session for the same agent.
- Vercel Blob uploads use `allowOverwrite: true` to handle race between runner transcript upload and `finalizeMessage` (both write to the same blob path)
- Session file backup also uses `allowOverwrite: true` since the same session file path is rewritten after each message
- Session message routes parallelize budget check + agent load via `Promise.all()`
- A2A protocol uses `@a2a-js/sdk@0.3.12` with `DefaultRequestHandler` + `JsonRpcTransportHandler`; per-request handler creation for multi-tenant isolation
- A2A Agent Card cache: process-level Map with 60s TTL and max 1000 entries (LRU); keyed by tenant slug. Agent Card metadata version bumped to `v2` to signal the `taskId = session_message_id` mapping change.
- `MessageBackedTaskStore.save()` uses `lastWrittenStatus` tracking to reduce ~200 DB calls/message to ~3; terminal state guard prevents state machine bypass; mirrors the legacy run-store optimization
- A2A error sanitization: `MessageBackedTaskStore.save()` catches all errors and throws `A2AError.internalError()` to prevent SQL/internal detail leaks
- A2A budget enforcement: best-effort check in route (non-transactional), authoritative check inside `dispatchSessionMessage()` (transactional)
- A2A `cancelTask` resolves `taskId` → `messageId` → parent `sessionId` and calls `cancelSession()` (mirrors `/api/sessions/:id/cancel`)
- A2A SSE streaming sends heartbeats (15s), `data: [DONE]\n\n` sentinel on completion
- `a2aHeaders()` helper shared between JSON-RPC and Agent Card routes for consistent `A2A-Version` + `A2A-Request-Id` headers
- Admin UI terminology: "tenant" is renamed to "company" throughout the UI (API still uses "tenant")
- Admin UI navigation: top bar with breadcrumb (serves as page title, no redundant h1), company switcher dropdown, all pages scoped to active company
- Admin UI agent detail: tabbed interface (General, Identity, Connectors, Skills, Plugins, Schedules, Runs) with line-style tabs; metrics cards under General tab
- Admin UI Identity tab: FileTreeEditor with all 8 SoulSpec files (SOUL.md, IDENTITY.md, STYLE.md, AGENTS.md, HEARTBEAT.md, USER_TEMPLATE.md, examples/); action buttons: Generate Soul, Import, Export, Publish; validation warnings inline
- Admin UI settings page (`/admin/settings`): company form (name, slug, timezone, budget, logo upload), API keys section, ClawSouls Registry section (API token), danger zone
- SoulSpec v0.5 identity: strict compliance — required SOUL.md sections (Personality, Tone, Principles), IDENTITY.md fields (Name, Role, Creature, Emoji, Vibe, Avatar); progressive disclosure (Level 1 = summary, Level 2 = 4 files, Level 3 = all); `identity` JSONB auto-derived on save; `.soul/` directory injected into sandbox
- ClawSouls registry integration: import/export/publish/validate via REST API (`https://clawsouls.ai/api/v1`); tenant-scoped API token (encrypted); `soul-manifest.ts` shared helper; A2A metadata versioned (`soulspec:identity:v2` + backward-compat `soulspec:identity`)
- "Generate Soul" uses AI Gateway to draft all 8 SoulSpec files from agent config (name, description, tools, skills); falls back to claude-sonnet if agent model fails
- Admin UI: A2A badge on agent list, A2A info section on agent detail (endpoint URLs + Agent Card preview), source filter on the sessions/messages list
- Admin UI runs list (under `/admin/sessions` route — UI label is "Runs"): shows agent, run status (with `stopped (ephemeral)` folded into the badge), `message_count`, total cost (sum across messages), latest activity, latest trigger. Sortable on created_at / latest activity / total cost. Filterable by agent, status, trigger.
- Admin UI run detail: scrollable accordion of `session_messages` rows (auto-expanded most recent), each rendering the message-source badge + start time + status + transcript via `TranscriptViewer`. Cancel button ("Stop Run") visible only on `creating`/`active`/`idle`. Live streaming subscribes to `/api/sessions/:id/stream` (resolves to in-flight message); idle sessions don't subscribe.
- Admin UI terminology: the data model uses "Session" (table `sessions`, route `/admin/sessions`, type `SessionRow`, etc.). The user-facing UI uses "Run" — sidebar label, breadcrumb, table column headers, dashboard metric cards, and the "Stop Run" button. Keep this split: never rename the data model, always rename the copy.
- Admin UI dashboard charts: cost/day per agent and executions/day per agent ("execution" = one `session_messages` row, disambiguated from chat/A2A messages), aggregated from `session_messages` by `date_trunc('day', completed_at)`
- Admin UI model selector: cmdk + Radix Popover combobox fetching live models from Vercel AI Gateway; shows context window, pricing, capability tags; supports search, provider filter, custom model entry
- Admin UI edit form: two rows — Name/Desc/Model/Runner on top, Max Turns/Budget/Runtime/Permission Mode on bottom; form disabled during save; API errors displayed inline
- Admin UI components: `DetailPageHeader` used consistently on all detail pages; `tabs.tsx` for line-style tabs; `company-switcher.tsx` for tenant selection; `top-bar.tsx` for breadcrumb navigation; `message-source-badge.tsx` for trigger source
