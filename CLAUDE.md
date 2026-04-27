# AgentPlane

A multi-tenant platform for running AI agents in isolated Vercel Sandboxes, exposed via a REST API. Supports any model via Vercel AI Gateway with dual runner architecture (Claude Agent SDK + Vercel AI SDK).

## Architecture

**Stack:** Next.js 16 (App Router) · TypeScript · Neon Postgres · Vercel Sandbox · Vercel Blob · Tailwind CSS v4 · Recharts

**Core concepts:**
- **Tenant** — isolated workspace with its own API keys, agents, budget, and timezone
- **Agent** — configuration (model, runner, tools, permissions, skills, plugins, git repo, schedule, max runtime). Supports any Vercel AI Gateway model. Runner auto-selected: Claude Agent SDK for Anthropic models, Vercel AI SDK (ToolLoopAgent) for all others
- **Run** — a single agent execution triggered by API, schedule, playground, chat, A2A, or webhook; streams NDJSON events; tracks `triggered_by` source
- **Session** — persistent multi-turn conversation with sandbox kept alive; uses Claude Agent SDK `resume: sessionId` for context preservation; each message creates a run with `triggered_by: 'chat'`
- **Schedule** — per-agent cron configuration (manual/hourly/daily/weekdays/weekly) with timezone-aware execution
- **MCP Server** — tenant-scoped custom OAuth-authenticated tool server; agents connect via OAuth 2.1 PKCE
- **Plugin Marketplace** — tenant-scoped GitHub repo containing reusable agents/skills/connectors that agents can install
- **A2A Protocol** — Agent-to-Agent protocol (Linux Foundation) server; exposes agents to external A2A-compliant clients via Agent Cards and JSON-RPC

**Execution flow (A2A):**
1. External client discovers agents via `GET /api/a2a/{slug}/.well-known/agent-card.json` (public, rate-limited)
2. Client sends `message/send` or `message/stream` JSON-RPC to `POST /api/a2a/{slug}/jsonrpc` (Bearer auth)
3. `@a2a-js/sdk` routes request through `DefaultRequestHandler` → `SandboxAgentExecutor`
4. Executor creates a run (`triggered_by: 'a2a'`), launches sandbox, streams log events
5. `RunBackedTaskStore` bridges A2A Task state to run status (status-only UPDATEs, deduplicated)
6. `finalizeRun()` persists transcript, records billing, stops sandbox
7. Final A2A status event published; SSE stream closes with `[DONE]` sentinel

**Execution flow (webhook):**
1. External system POSTs to `/api/webhooks/{source_id}` (public, no auth header) with `Webhook-Timestamp`, `Webhook-Delivery-Id`, and a configurable signature header carrying `sha256=<hex>` HMAC over `{timestamp}.{raw_body}`
2. Per-source (60/min) and per-tenant (600/min) rate limits via in-memory limiter; oversized bodies (>512KB) rejected with 413
3. Source loaded by id (unauthenticated lookup); generic 401 returned for unknown / disabled / bad-sig / stale-timestamp (anti-enumeration)
4. Signature verified with current secret, falling back to previous secret during a 7-day rotation overlap
5. Delivery row inserted with `ON CONFLICT (source_id, delivery_id) DO NOTHING`; duplicate replays return 200 with the original `run_id`
6. Prompt rendered from per-source `prompt_template` (`{{payload}}`, `{{source.name}}` placeholders; payload truncated at 256KB) and `createRun()` invoked with `triggered_by: 'webhook'` and `webhook_source_id` set
7. Response is 202 Accepted with `{ run_id, status_url }`; the run executes asynchronously through the same `prepareRunExecution` / `finalizeRun` pipeline as one-shot runs

**Execution flow (one-shot runs):**
1. Client POSTs to `/api/agents/:id/runs` (or `/api/runs`) with a prompt
2. MCP config is built (Composio toolkits + custom MCP servers resolved, tokens refreshed in parallel)
3. A Vercel Sandbox is created from a pre-built SDK snapshot (falls back to fresh npm install if no snapshot); skill + plugin files injected
4. Runner selected based on agent model: Claude Agent SDK `query()` for Anthropic models, Vercel AI SDK `ToolLoopAgent` for others
5. Events stream back over NDJSON (`run_started`, `assistant`, `tool_use`, `tool_result`, `result`, `text_delta`)
6. Ephemeral asset URLs (e.g. Composio/Firecrawl) are replaced with permanent Vercel Blob URLs
7. Transcript stored in Vercel Blob; token usage + cost recorded in DB (cost computed from model catalog pricing for AI SDK runs)
8. Long-running streams (>4.5 min) detach with a `stream_detached` event; clients poll `/api/runs/:id`

**Execution flow (sessions):**
1. Client POSTs to `/api/sessions` with `agent_id` (optional `prompt` for first message)
2. Sandbox created from SDK snapshot and kept warm (no runner script yet); session enters `idle` state
3. Client POSTs to `/api/sessions/:id/messages` with `prompt`
4. Per-message `runner-<runId>.mjs` written to sandbox, executes `query({ prompt, options: { resume: sessionId } })`
5. Session transitions: `idle` → `active` (message in flight) → `idle` (message done)
6. Session file backed up to Vercel Blob BEFORE response ends (prevents TOCTOU race with cleanup cron)
7. Sandbox stays alive for 10 min idle; cleanup cron stops stale sessions
8. On cold start (sandbox died): new sandbox created, session file restored from Blob, SDK resumes from disk

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
      agents/             # CRUD + run creation + skills + plugins + Composio OAuth + MCP connections
      composio/           # tenant-scoped Composio toolkit + tool discovery
      internal/           # internal endpoints (run transcript upload from sandbox)
      runs/               # run list, status (NDJSON stream), cancel, transcript, stream reconnect
      sessions/           # tenant-scoped session CRUD + message sending (NDJSON stream)
      admin/
        agents/           # admin agent CRUD + connectors + MCP connections + plugin suggestions + SoulSpec identity (validate-soul, import-soul, export-soul, publish-soul, generate-soul)
        composio/         # available Composio toolkits + tools listing
        login/            # admin JWT authentication
        mcp-servers/      # custom MCP server CRUD
        plugin-marketplaces/  # marketplace CRUD + plugin listing + file editing
        runs/             # admin run management + cancellation
        sessions/         # admin session management + playground messaging
        tenants/          # tenant CRUD + API key management
      cron/               # scheduled jobs (budget reset, sandbox + transcript + session cleanup, scheduled runs)
        budget-reset/     # daily budget reset
        cleanup-sandboxes/  # sandbox cleanup every 5 min (excludes session-owned runs)
        cleanup-sessions/ # session cleanup every 5 min (idle timeout + stuck session watchdog)
        cleanup-transcripts/  # daily transcript cleanup
        refresh-snapshot/  # daily SDK snapshot refresh (Vercel Sandbox snapshot)
        scheduled-runs/   # per-minute scheduled agent run dispatcher + executor
      health/             # health check (no auth)
      keys/               # tenant-scoped API key management
      mcp-servers/        # MCP OAuth callback + server listing
      plugin-marketplaces/  # tenant-scoped marketplace + plugin discovery
      runs/               # tenant-scoped run management (list + per-run)
      tenants/            # tenant self-service (GET /me)
    admin/                # Admin UI (Next.js pages, dark mode)
      (auth)/login/       # login page
      (dashboard)/
        page.tsx          # dashboard overview (stat cards + run/cost charts)
        run-charts.tsx    # Recharts line charts (runs/day, cost/day per agent)
        agents/           # agent list + tabbed detail (General, Identity, Connectors, Skills, Plugins, Schedules, Runs)
        mcp-servers/      # custom MCP server management
        plugin-marketplaces/  # marketplace list + detail + plugin editor (tabbed: Agents, Skills, Connectors)
        runs/             # run list + detail (transcript viewer, cancel button, run source badge, source filter, live streaming, polling)
        settings/         # company settings (name, slug, timezone, budget, logo, API keys, danger zone)
  db/
    index.ts              # DB client (Pool, query helpers, RLS context, transactions)
    migrate.ts            # migration runner
    migrations/           # sequential SQL migration files (001–026)
  lib/
    a2a.ts                # A2A protocol: status mapping, Agent Card builder/cache, RunBackedTaskStore, SandboxAgentExecutor, input validation
    types.ts              # branded types, domain interfaces, StreamEvent union
    env.ts                # Zod-validated env (getEnv())
    validation.ts         # Zod request/response schemas
    auth.ts               # API key authentication + tenant RLS context + A2A single-query auth
    admin-auth.ts         # admin JWT + cookie auth
    sandbox.ts            # Vercel Sandbox creation + SDK snapshot management + dual runner (Claude SDK + AI SDK) + session sandbox + skill/plugin injection + AgentCo bridge
    run-executor.ts       # run preparation + execution abstraction (sandbox setup, transcript, billing)
    sessions.ts           # session lifecycle (create, transition, stop, idle/stuck queries)
    session-executor.ts   # session message execution (sandbox prepare/reconnect, message run, finalize)
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
    runs.ts               # run lifecycle (create, transition, budget/concurrency checks)
    streaming.ts          # SSE/NDJSON streaming (heartbeats, stream detach)
    transcript-utils.ts   # captureTranscript generator, parseResultEvent helper
    transcripts.ts        # Vercel Blob transcript storage (allowOverwrite for race safety)
    api.ts                # withErrorHandler, jsonResponse helpers
    crypto.ts             # ID generation, key hashing, AES-256-GCM encryption
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
      copy-button.tsx        # clipboard copy button with checkmark feedback
      run-source-badge.tsx   # color-coded badge for run trigger source (API, Schedule, Playground, Chat, A2A)
      detail-page-header.tsx # standardized detail page header
      section-header.tsx     # consistent section headers
      confirm-dialog.tsx     # managed confirmation dialog (replaces browser confirm())
      form-field.tsx         # form field wrapper with label + error display
      tabs.tsx               # line-style tabs matching AgentCo design
      theme-toggle.tsx       # dark mode toggle
  middleware.ts           # auth middleware (API key, JWT cookie, OAuth callback bypass)
scripts/
  create-tenant.ts        # CLI to provision tenant + API key
  create-api-key.ts       # CLI to generate additional API keys for a tenant
tests/
  unit/                   # Vitest unit tests
```

## Database

Neon Postgres with Row-Level Security (RLS). Tables: `tenants`, `api_keys`, `agents`, `runs`, `sessions`, `mcp_servers`, `mcp_connections`, `plugin_marketplaces`.

- Agent names are unique per tenant
- RLS enforced via `app.current_tenant_id` session config (fail-closed via `NULLIF`)
- Tenant-scoped transactions via `withTenantTransaction()`
- Migrations: numbered SQL files in `src/db/migrations/` (currently 001–029), run via `npm run migrate`
- `tenants` table includes: `timezone` column for schedule evaluation, `logo_url` (base64 data URL or external URL)
- `agents` table includes: Composio MCP cache columns, `composio_allowed_tools` (per-toolkit tool filtering), `composio_connection_metadata` JSONB (per-toolkit `auth_method` + `bot_user_id` + `display_name` for the auth-method picker), `skills` JSONB, `plugins` JSONB, schedule columns (`schedule_frequency`, `schedule_time`, `schedule_day_of_week`, `schedule_prompt`, `schedule_enabled`, `last_run_at`, `next_run_at`), `max_runtime_seconds` (60–3600, default 600), `a2a_enabled` (boolean, default false; partial index on `tenant_id WHERE a2a_enabled = true`), SoulSpec v0.5 identity columns (`soul_md`, `identity_md`, `style_md`, `agents_md`, `heartbeat_md`, `user_template_md`, `examples_good_md`, `examples_bad_md`, `soul_spec_version` TEXT default '0.5', `identity` JSONB auto-derived)
- `tenants` table includes: `clawsouls_api_token` (encrypted, for ClawSouls registry publish)
- `runs` table includes: `triggered_by` column (`api`, `schedule`, `playground`, `chat`, `a2a`, `webhook`) to track run source; `created_by_key_id` FK to api_keys (audit trail for A2A); `session_id` FK to sessions table for chat messages; `webhook_source_id` FK to webhook_sources for webhook-triggered runs (NULL for all other sources)
- `sessions` table includes: `sandbox_id` (NULL when stopped), `sdk_session_id` (Claude Agent SDK session), `session_blob_url` (Vercel Blob backup), `status` (creating/active/idle/stopped), `message_count`, `idle_since`, `last_backup_at`; state machine: creating→active/idle/stopped, active→idle/stopped, idle→active/stopped; max 5 concurrent sessions per tenant
- `mcp_servers` — tenant-scoped registry (OAuth 2.1 client credentials, RLS enforced); unique slug per tenant
- `mcp_connections` — per-agent OAuth connections (tenant-scoped RLS, unique per agent-server pair)
- `plugin_marketplaces` — tenant-scoped registry of GitHub repos (RLS enforced); unique github_repo per tenant; optional encrypted GitHub token for push-to-repo editing
- `webhook_sources` — tenant-scoped inbound webhook registry (RLS enforced); per-source HMAC secret encrypted at rest with 7-day rotation overlap, configurable signature header, prompt template; unique name per tenant
- `webhook_deliveries` — per-request audit log + idempotency key store; `UNIQUE (source_id, delivery_id)` powers the 200-duplicate dedupe path; cascades on source delete

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
| `BLOB_READ_WRITE_TOKEN` | No | Vercel Blob (transcript + asset storage) |
| `COMPOSIO_API_KEY` | No | Composio MCP tool integration (optional if not using Composio toolkits) |
| `CRON_SECRET` | No | Vercel Cron authentication (must be manually set; random string ≥16 chars) |
| `BRAINTRUST_API_KEY` | No | Braintrust observability; when set, sandbox runners auto-trace LLM calls to Braintrust |

## API Authentication

All routes (except `/api/health`) require `Authorization: Bearer <api_key>`. Admin routes use `ADMIN_API_KEY` (or JWT cookie via `/api/admin/login`). OAuth callbacks (`/api/agents/*/connectors/*/callback`, `/api/mcp-servers/*/callback`) are unauthenticated (external provider redirects). A2A Agent Card (`/.well-known/agent-card.json`) is public (rate-limited by IP). A2A JSON-RPC uses `authenticateA2aRequest()` (single-query slug+key auth, constant-time). API keys are hashed with SHA-256; optionally encrypted at rest with `ENCRYPTION_KEY`.

## Deployment

- **Hosting:** Vercel
- **Production:** deployed on Vercel
- Push to `main` triggers automatic production deploy
- **Migrations run automatically on every deploy** via `buildCommand` in `vercel.json` (`npm run migrate && next build`); failed migrations abort the deploy
- Migration connection priority: `DATABASE_URL_DIRECT` → `DATABASE_URL_UNPOOLED` → `DATABASE_URL`
- `DATABASE_URL_UNPOOLED` is auto-set when Neon is linked via the Vercel integration
- Security headers set via `next.config.ts`: HSTS, X-Content-Type-Options, X-Frame-Options DENY, Referrer-Policy
- Vercel functions config: `app/api/runs/**`, `app/api/sessions/**`, and `app/api/a2a/**` have `supportsCancellation: true` for streaming cancellation

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
- Runner ALWAYS uploads transcript to platform via `/api/internal/runs/:id/transcript` with a run-scoped bearer token (not just detached runs)
- AgentCo callback bridge: stdio MCP server injected into sandbox when A2A request includes callback data; env vars passed explicitly via `StdioClientTransport({ env })` for subprocess inheritance
- Model catalog (`/api/admin/models`, `/api/models`): fetches from `GET https://ai-gateway.vercel.sh/v1/models`, 15-min cache, Zod validation, stale-on-error fallback
- Cost computation for Vercel AI SDK runs: `parseResultEvent` looks up model pricing from catalog, calculates `(input_tokens × price + output_tokens × price) / 1M`
- Run `runner` column set at creation time via `resolveEffectiveRunner()` (no longer defaults to claude-agent-sdk)
- Transcript viewer supports both Claude SDK (nested `assistant.message.content` blocks) and Vercel AI SDK (flat `tool_use`, `tool_result`, `run_started`, `mcp_error` events) formats

## Patterns & Conventions

- Branded types (`TenantId`, `AgentId`, `RunId`, `McpServerId`, `McpConnectionId`, `PluginMarketplaceId`) prevent parameter swaps at compile time
- All DB queries go through typed helpers in `src/db/index.ts` with Zod validation
- Use `withErrorHandler()` wrapper on every API route handler
- Composio MCP server URL + API key are cached per agent in the `agents` table (encrypted at rest)
- Composio connectors support three auth methods, picked per-toolkit on the connector card: **Composio-managed OAuth** (default), **bring-your-own-app OAuth** (tenant supplies `client_id` + `client_secret`, e.g. Linear `actor=app`), and **custom token** (Slack `xoxb-`, Notion `secret_…`). Auth configs are per-tenant; MCP server creation looks up the auth config via `connectedAccounts.list({ user_ids: [tenantId] })` to prevent cross-tenant credential leaks. Post-connect identity is captured via a slug-keyed whoami registry (slack/notion/linear) and stored in `agents.composio_connection_metadata` as `bot_user_id` + `display_name`. Capture failures set `capture_deferred: true`; the UI exposes a re-capture link.
- Custom MCP servers use OAuth 2.1 PKCE; tokens refreshed automatically with 2-phase retry on transient 5xx
- Agent skills are injected as files into the sandbox at `.claude/skills/<folder>/<path>`
- Plugin files are injected into the sandbox at `.claude/skills/` and `.claude/agents/`
- Process-level caching with TTLs: MCP servers (5 min), plugin trees (5 min), recent pushes (2 min)
- SSE/NDJSON streams send heartbeats every 15s and auto-detach after 4.5 min for long-running runs
- Ephemeral asset URLs (Composio/Firecrawl) are persisted to Vercel Blob in both platform-finalized and runner-uploaded transcripts
- Non-Anthropic models always force Vercel AI SDK runner via `resolveEffectiveRunner()`, ignoring stored runner preference
- `load_skill` tool accepts parameter name variants (`name`, `skill_name`, `skill_identifier`) for cross-model compatibility
- Admin UI is always dark mode via `.dark` class on the layout root; Tailwind v4 dark variant is configured with `@variant dark (&:where(.dark, .dark *))` in `globals.css`
- Admin UI uses system font stack (no Geist) to match AgentCo design
- Landing page (`/`) is a dark-mode marketing page with hero, features, how-it-works, architecture, and CTA sections
- Sandbox network policy allowlists: AI Gateway, Composio, Firecrawl, GitHub, npm registry, platform API, custom MCP servers
- Max 10 concurrent runs per tenant; atomic concurrent run check prevents TOCTOU races
- Transcript viewer renders markdown via `react-markdown` + `remark-gfm`; HTML sanitized with `dompurify`
- JSONB array mutations use atomic SQL guards (`NOT EXISTS` for uniqueness, `jsonb_array_length` for limits) to prevent TOCTOU races
- Composio discovery helpers (`listComposioToolkits`, `listComposioTools`) are shared between admin and tenant routes via `src/lib/composio.ts`; tool pagination capped at 10 pages
- Scheduled runs: cron dispatcher runs every minute, claims due agents, computes next run time, dispatches to executor endpoint
- Run executor (`src/lib/run-executor.ts`) separates run preparation (MCP config, plugins, sandbox) from execution; used by both API and scheduled runs
- Transcript capture preserves critical events (result/error) even after truncation limit
- Timezone validation extracted to `src/lib/timezone.ts` to avoid pulling `croner` into client bundles
- `croner` library used for cron expression evaluation and next-run-time computation
- Session sandbox uses per-message `runner-<runId>.mjs` scripts with `resume: sessionId`; no persistent process inside sandbox
- Session file backup (to Vercel Blob) is synchronous — completes BEFORE response stream closes to prevent TOCTOU race with cleanup cron
- Session file uploads use `multipart: true` for Blob put() to handle >4.5MB server upload limit
- MCP token refresh in `buildMcpConfig()` is parallelized with `Promise.allSettled()` for faster cold starts
- Cleanup cron for sessions runs every 5 min: stops idle sessions after 10 min, watchdog catches stuck creating (>5 min) and active (>30 min) sessions
- `cleanup-sandboxes` cron excludes session-owned runs (`session_id IS NULL` filter)
- Vercel Blob uploads use `allowOverwrite: true` to handle race between runner transcript upload and `finalizeSessionMessage` (both write to the same blob path)
- Session file backup also uses `allowOverwrite: true` since the same session file path is rewritten after each message
- Session hot path parallelizes `buildMcpConfig` + `fetchPluginContent` + `reconnectSessionSandbox` via `Promise.all()`; on reconnect success, `updateMcpConfig()` injects fresh MCP tokens
- Session message routes parallelize budget check + agent load via `Promise.all()`
- Session sandbox skips `extendTimeout` if session has been idle < 5 minutes
- A2A protocol uses `@a2a-js/sdk@0.3.12` with `DefaultRequestHandler` + `JsonRpcTransportHandler`; per-request handler creation for multi-tenant isolation
- A2A Agent Card cache: process-level Map with 60s TTL and 100-entry max size; keyed by tenant slug
- `RunBackedTaskStore.save()` uses `lastWrittenStatus` tracking to reduce ~200 DB calls/run to ~3; terminal state guard prevents state machine bypass
- `SandboxAgentExecutor` creates runs via `createRun()`, delegates to `prepareRunExecution()` + `finalizeRun()` (shared with regular runs)
- A2A error sanitization: `RunBackedTaskStore.save()` catches all errors and throws `A2AError.internalError()` to prevent SQL/internal detail leaks
- A2A budget enforcement: best-effort check in route (non-transactional), authoritative check inside `createRun()` (transactional)
- A2A `cancelTask` handles both `pending` and `running` states; stops sandbox via `reconnectSandbox()` (mirrors `/api/runs/:id/cancel`)
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
- Admin UI: A2A badge on agent list, A2A info section on agent detail (endpoint URLs + Agent Card preview), source filter on runs page
- Admin UI model selector: cmdk + Radix Popover combobox fetching live models from Vercel AI Gateway; shows context window, pricing, capability tags; supports search, provider filter, custom model entry
- Admin UI edit form: two rows — Name/Desc/Model/Runner on top, Max Turns/Budget/Runtime/Permission Mode on bottom; form disabled during save; API errors displayed inline
- Admin UI components: `DetailPageHeader` used consistently on all detail pages; `tabs.tsx` for line-style tabs; `company-switcher.tsx` for tenant selection; `top-bar.tsx` for breadcrumb navigation
