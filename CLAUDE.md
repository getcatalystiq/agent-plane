# AgentPlane

A multi-tenant platform for running Claude Agent SDK agents in isolated Vercel Sandboxes, exposed via a REST API.

## Architecture

**Stack:** Next.js 16 (App Router) · TypeScript · Neon Postgres · Vercel Sandbox · Vercel Blob · Tailwind CSS v4 · Recharts

**Core concepts:**
- **Tenant** — isolated workspace with its own API keys, agents, budget, and timezone
- **Agent** — configuration (model, tools, permissions, skills, plugins, git repo, schedule, max runtime) that runs Claude Agent SDK
- **Run** — a single agent execution triggered by API, schedule, playground, or chat; streams NDJSON events; tracks `triggered_by` source
- **Session** — persistent multi-turn conversation with sandbox kept alive; uses Claude Agent SDK `resume: sessionId` for context preservation; each message creates a run with `triggered_by: 'chat'`
- **Schedule** — per-agent cron configuration (manual/hourly/daily/weekdays/weekly) with timezone-aware execution
- **MCP Server** — custom OAuth-authenticated tool server registered by admins; agents connect via OAuth 2.1 PKCE
- **Plugin Marketplace** — GitHub repo containing reusable skills/commands that agents can install

**Execution flow (one-shot runs):**
1. Client POSTs to `/api/agents/:id/runs` (or `/api/runs`) with a prompt
2. MCP config is built (Composio toolkits + custom MCP servers resolved, tokens refreshed in parallel)
3. A Vercel Sandbox is created; `@anthropic-ai/claude-agent-sdk` installed; skill + plugin files injected
4. Claude Agent SDK `query()` runs inside the sandbox
5. Events stream back over NDJSON (`run_started`, `assistant`, `tool_use`, `tool_result`, `result`, `text_delta`)
6. Ephemeral asset URLs (e.g. Composio/Firecrawl) are replaced with permanent Vercel Blob URLs
7. Transcript stored in Vercel Blob; token usage + cost recorded in DB
8. Long-running streams (>4.5 min) detach with a `stream_detached` event; clients poll `/api/runs/:id`

**Execution flow (sessions):**
1. Client POSTs to `/api/sessions` with `agent_id` (optional `prompt` for first message)
2. Sandbox created and kept warm (no runner script yet); session enters `idle` state
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

# SDK (sdk/ directory)
npm run sdk:build      # build SDK (ESM + CJS + DTS)
npm run sdk:test       # run SDK tests
npm run sdk:typecheck  # typecheck SDK
```

## Project Structure

```
src/
  app/
    page.tsx              # Landing page ("Claude Agents as an API")
    api/
      agents/             # CRUD + run creation + skills + plugins + Composio OAuth + MCP connections
      composio/           # tenant-scoped Composio toolkit + tool discovery
      internal/           # internal endpoints (run transcript upload from sandbox)
      runs/               # run list, status (NDJSON stream), cancel, transcript
      sessions/           # tenant-scoped session CRUD + message sending (NDJSON stream)
      admin/
        agents/           # admin agent CRUD + connectors + MCP connections + plugin suggestions
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
        agents/           # agent list + detail (edit, connectors, skills, plugins, playground, schedule)
        mcp-servers/      # custom MCP server management
        plugin-marketplaces/  # marketplace list + detail + plugin editor (tabbed: Skills, Commands, Connectors)
        runs/             # run list + detail (transcript viewer, cancel button, run source badge)
        tenants/          # tenant list + detail + creation (API keys, budget, timezone)
  db/
    index.ts              # DB client (Pool, query helpers, RLS context, transactions)
    migrate.ts            # migration runner
    migrations/           # sequential SQL migration files (001–015)
  lib/
    types.ts              # branded types, domain interfaces, StreamEvent union
    env.ts                # Zod-validated env (getEnv())
    validation.ts         # Zod request/response schemas
    auth.ts               # API key authentication + tenant RLS context
    admin-auth.ts         # admin JWT + cookie auth
    sandbox.ts            # Vercel Sandbox creation + Claude Agent SDK runner + session sandbox + skill/plugin injection
    run-executor.ts       # run preparation + execution abstraction (sandbox setup, transcript, billing)
    sessions.ts           # session lifecycle (create, transition, stop, idle/stuck queries)
    session-executor.ts   # session message execution (sandbox prepare/reconnect, message run, finalize)
    session-files.ts      # session file backup/restore to Vercel Blob (multipart upload)
    schedule.ts           # schedule config management, cron expression building, timezone-aware scheduling
    timezone.ts           # browser-safe timezone validation using Intl.DateTimeFormat
    cron-auth.ts          # cron secret verification for scheduled run endpoints
    mcp.ts                # MCP config builder (Composio + custom servers)
    mcp-connections.ts    # MCP connection orchestration (OAuth, token refresh, caching)
    mcp-oauth.ts          # OAuth 2.1 PKCE HTTP calls (discovery, registration, token exchange)
    mcp-oauth-state.ts    # signed MCP OAuth state token generation
    oauth-state.ts        # signed Composio OAuth state token generation
    composio.ts           # Composio MCP integration (toolkit auth, server lifecycle, shared discovery helpers)
    plugins.ts            # plugin discovery + file fetching (GitHub, caching)
    github.ts             # GitHub API client (tree, content, write access, atomic push)
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
    toolkit-multiselect.tsx  # Composio toolkit picker (search, logos)
    local-date.tsx        # client-side date formatting
    ui/                   # shared UI primitives (badge, button, card, dialog, confirm-dialog, form-field, etc.)
      run-source-badge.tsx   # color-coded badge for run trigger source (API, Schedule, Playground)
      detail-page-header.tsx # standardized detail page header
      section-header.tsx     # consistent section headers
      confirm-dialog.tsx     # managed confirmation dialog (replaces browser confirm())
      form-field.tsx         # form field wrapper with label + error display
  middleware.ts           # auth middleware (API key, JWT cookie, OAuth callback bypass)
scripts/
  create-tenant.ts        # CLI to provision tenant + API key
  create-api-key.ts       # CLI to generate additional API keys for a tenant
tests/
  unit/                   # Vitest unit tests
sdk/                      # TypeScript SDK (published as `@getcatalystiq/agentplane` npm package)
  src/
    client.ts             # AgentPlane class (HTTPS enforcement, closure-based auth)
    types.ts              # API interfaces (snake_case, matches wire format)
    errors.ts             # AgentPlaneError + StreamDisconnectedError
    streaming.ts          # NDJSON parser + RunStream (AsyncIterable)
    resources/
      runs.ts             # create, createAndWait, get, list, cancel, transcript
      agents.ts           # CRUD + nested skills/plugins/connectors/customConnectors
      skills.ts           # agent skill CRUD (list, get, create, update, delete)
      plugins.ts          # agent plugin management (list, add, remove)
      connectors.ts       # Composio connector management (list, saveApiKey, initiateOauth, availableToolkits/Tools)
      custom-connectors.ts # MCP custom connector management (listServers, list, delete, updateAllowedTools, listTools, initiateOauth)
      sessions.ts          # session CRUD + message sending (create, get, list, sendMessage, sendMessageAndWait, stop)
      plugin-marketplaces.ts # marketplace discovery (list, listPlugins) — admin-only for mutations
    index.ts              # public exports
  tests/
    helpers.ts            # shared test utilities (createClient, jsonOk, jsonError)
    resources/            # per-resource unit tests (vitest)
```

## Database

Neon Postgres with Row-Level Security (RLS). Tables: `tenants`, `api_keys`, `agents`, `runs`, `sessions`, `mcp_servers`, `mcp_connections`, `plugin_marketplaces`.

- Agent names are unique per tenant
- RLS enforced via `app.current_tenant_id` session config (fail-closed via `NULLIF`)
- Tenant-scoped transactions via `withTenantTransaction()`
- Migrations: numbered SQL files in `src/db/migrations/` (currently 001–015), run via `npm run migrate`
- `tenants` table includes: `timezone` column for schedule evaluation
- `agents` table includes: Composio MCP cache columns, `composio_allowed_tools` (per-toolkit tool filtering), `skills` JSONB, `plugins` JSONB, schedule columns (`schedule_frequency`, `schedule_time`, `schedule_day_of_week`, `schedule_prompt`, `schedule_enabled`, `last_run_at`, `next_run_at`), `max_runtime_seconds` (60–3600, default 600)
- `runs` table includes: `triggered_by` column (`api`, `schedule`, `playground`, `chat`) to track run source; `session_id` FK to sessions table for chat messages
- `sessions` table includes: `sandbox_id` (NULL when stopped), `sdk_session_id` (Claude Agent SDK session), `session_blob_url` (Vercel Blob backup), `status` (creating/active/idle/stopped), `message_count`, `idle_since`, `last_backup_at`; state machine: creating→active/idle/stopped, active→idle/stopped, idle→active/stopped; max 5 concurrent sessions per tenant
- `mcp_servers` — admin-managed global registry (OAuth 2.1 client credentials, no RLS)
- `mcp_connections` — per-agent OAuth connections (tenant-scoped RLS, unique per agent-server pair)
- `plugin_marketplaces` — global registry of GitHub repos; optional encrypted GitHub token for push-to-repo editing

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

## API Authentication

All routes (except `/api/health`) require `Authorization: Bearer <api_key>`. Admin routes use `ADMIN_API_KEY` (or JWT cookie via `/api/admin/login`). OAuth callbacks (`/api/agents/*/connectors/*/callback`, `/api/mcp-servers/*/callback`) are unauthenticated (external provider redirects). API keys are hashed with SHA-256; optionally encrypted at rest with `ENCRYPTION_KEY`.

## Deployment

- **Hosting:** Vercel
- **Production:** deployed on Vercel
- Push to `main` triggers automatic production deploy
- **Migrations run automatically on every deploy** via `buildCommand` in `vercel.json` (`npm run migrate && next build`); failed migrations abort the deploy
- Migration connection priority: `DATABASE_URL_DIRECT` → `DATABASE_URL_UNPOOLED` → `DATABASE_URL`
- `DATABASE_URL_UNPOOLED` is auto-set when Neon is linked via the Vercel integration
- Security headers set via `next.config.ts`: HSTS, X-Content-Type-Options, X-Frame-Options DENY, Referrer-Policy
- Vercel functions config: `app/api/runs/**` has `supportsCancellation: true` for streaming cancellation

## Sandbox & Runner

- Sandboxes run `@anthropic-ai/claude-agent-sdk` (installed at runtime via npm)
- `ENABLE_TOOL_SEARCH=true` is set in the sandbox env to enable dynamic tool discovery for agents with many MCP tools
- When MCP servers are present, `allowedTools` is suppressed so `mcp__*` tool names aren't blocked
- Plugin skill files → `.claude/skills/<plugin-name>-<subfolder>/<filename>`; plugin command files → `.claude/commands/<plugin-name>-<filename>`
- Network allowlist: `ai-gateway.vercel.sh`, `*.composio.dev`, `*.firecrawl.dev`, `*.githubusercontent.com`, `registry.npmjs.org`, platform API host, custom MCP server hosts
- Runner ALWAYS uploads transcript to platform via `/api/internal/runs/:id/transcript` with a run-scoped bearer token (not just detached runs)

## Patterns & Conventions

- Branded types (`TenantId`, `AgentId`, `RunId`, `McpServerId`, `McpConnectionId`, `PluginMarketplaceId`) prevent parameter swaps at compile time
- All DB queries go through typed helpers in `src/db/index.ts` with Zod validation
- Use `withErrorHandler()` wrapper on every API route handler
- Composio MCP server URL + API key are cached per agent in the `agents` table (encrypted at rest)
- Custom MCP servers use OAuth 2.1 PKCE; tokens refreshed automatically with 2-phase retry on transient 5xx
- Agent skills are injected as files into the sandbox at `.claude/skills/<folder>/<path>`
- Plugin files are injected into the sandbox at `.claude/skills/` and `.claude/commands/`
- Process-level caching with TTLs: MCP servers (5 min), plugin trees (5 min), recent pushes (2 min)
- SSE/NDJSON streams send heartbeats every 15s and auto-detach after 4.5 min for long-running runs
- Ephemeral Composio asset URLs are persisted to Vercel Blob during transcript capture
- Admin UI is always dark mode via `.dark` class on the layout root; Tailwind v4 dark variant is configured with `@variant dark (&:where(.dark, .dark *))` in `globals.css`
- Landing page (`/`) is a dark-mode marketing page with hero, features, how-it-works, architecture, and CTA sections
- Sandbox network policy allowlists: AI Gateway, Composio, Firecrawl, GitHub, npm registry, platform API, custom MCP servers
- Max 10 concurrent runs per tenant; atomic concurrent run check prevents TOCTOU races
- Transcript viewer renders markdown via `react-markdown` + `remark-gfm`; HTML sanitized with `dompurify`
- SDK resource namespaces: `client.runs`, `client.agents`, `client.sessions`, `client.connectors`, `client.customConnectors`, `client.pluginMarketplaces`; agents nests `skills`, `plugins`, `connectors`, `customConnectors`
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
