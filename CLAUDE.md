# AgentPlane

A multi-tenant platform for running Claude Code agents in isolated Vercel Sandboxes, exposed via a REST API.

## Architecture

**Stack:** Next.js 16 (App Router) · TypeScript · Neon Postgres · Vercel Sandbox · Vercel Blob · Tailwind CSS v4

**Core concepts:**
- **Tenant** — isolated workspace with its own API keys, agents, and budget
- **Agent** — configuration (model, tools, permissions, skills, plugins, git repo) that runs Claude Code
- **Run** — a single agent execution triggered by a prompt; streams SSE events
- **MCP Server** — custom OAuth-authenticated tool server registered by admins; agents connect via OAuth 2.1 PKCE
- **Plugin Marketplace** — GitHub repo containing reusable skills/commands that agents can install

**Execution flow:**
1. Client POSTs to `/api/agents/:id/runs` with a prompt
2. MCP config is built (Composio toolkits + custom MCP servers resolved, tokens refreshed)
3. A Vercel Sandbox is created; skill files + plugin files injected into `.claude/skills/`
4. Claude Code runs inside the sandbox
5. Events stream back over SSE (`run_started`, `assistant`, `tool_use`, `tool_result`, `result`)
6. Ephemeral asset URLs (e.g. Composio/Firecrawl) are replaced with permanent Vercel Blob URLs
7. Transcript stored in Vercel Blob; token usage + cost recorded in DB
8. Long-running streams (>4.5 min) detach with a `stream_detached` event; clients poll `/api/runs/:id`

## Key Commands

```bash
npm run dev            # start dev server
npm run build          # type-check + build (Next.js)
npm run test           # vitest run (server tests)
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
    api/
      agents/             # CRUD + run creation + Composio OAuth + MCP connections
      runs/               # run status (SSE), cancel, transcript
      admin/
        agents/           # admin agent CRUD + connectors + MCP connections + plugin suggestions
        composio/         # available Composio toolkits + tools listing
        login/            # admin JWT authentication
        mcp-servers/      # custom MCP server CRUD
        plugin-marketplaces/  # marketplace CRUD + plugin listing + file editing
        runs/             # admin run management
        tenants/          # tenant + API key management
      cron/               # scheduled jobs (budget reset, sandbox + transcript cleanup)
      health/             # health check (no auth)
      keys/               # tenant-scoped API key management
      mcp-servers/        # MCP OAuth callback + server listing
      runs/               # tenant-scoped run management
      tenants/            # tenant self-service (GET /me)
    admin/                # Admin UI (Next.js pages)
      (auth)/login/       # login page
      (dashboard)/
        agents/           # agent list + detail (edit, connectors, skills, plugins, playground)
        mcp-servers/      # custom MCP server management
        plugin-marketplaces/  # marketplace list + detail + plugin editor
        runs/             # run list + detail (transcript viewer)
        tenants/          # tenant list + detail (API keys, budget)
  db/
    index.ts              # DB client (Pool, query helpers, RLS context, transactions)
    migrate.ts            # migration runner
    migrations/           # sequential SQL migration files (001–009)
  lib/
    types.ts              # branded types, domain interfaces, StreamEvent union
    env.ts                # Zod-validated env (getEnv())
    validation.ts         # Zod request/response schemas
    auth.ts               # API key authentication + tenant RLS context
    admin-auth.ts         # admin JWT + cookie auth
    sandbox.ts            # Vercel Sandbox creation + skill/plugin file injection
    mcp.ts                # MCP config builder (Composio + custom servers)
    mcp-connections.ts    # MCP connection orchestration (OAuth, token refresh, caching)
    mcp-oauth.ts          # OAuth 2.1 PKCE HTTP calls (discovery, registration, token exchange)
    mcp-oauth-state.ts    # signed OAuth state token generation
    composio.ts           # Composio MCP integration (toolkit auth, server lifecycle)
    plugins.ts            # plugin discovery + file fetching (GitHub, caching)
    github.ts             # GitHub API client (tree, content, write access, push)
    agents.ts             # agent loading helper
    assets.ts             # ephemeral asset persistence (Composio URLs → Vercel Blob)
    runs.ts               # run lifecycle (create, transition, budget/concurrency checks)
    streaming.ts          # SSE streaming (heartbeats, stream detach)
    transcripts.ts        # Vercel Blob transcript storage
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
    ui/                   # shared UI primitives (badge, button, card, dialog, etc.)
  middleware.ts           # auth middleware
scripts/
  create-tenant.ts        # CLI to provision tenant + API key
  create-api-key.ts       # CLI to generate additional API keys for a tenant
tests/
  unit/                   # Vitest unit tests
sdk/                      # TypeScript SDK (published as `agentplane` npm package)
  src/
    client.ts             # AgentPlane class (HTTPS enforcement, closure-based auth)
    types.ts              # API interfaces (snake_case, matches wire format)
    errors.ts             # AgentPlaneError + StreamDisconnectedError
    streaming.ts          # NDJSON parser + RunStream (AsyncIterable)
    resources/
      runs.ts             # create, createAndWait, get, list, cancel, transcript
      agents.ts           # CRUD
    index.ts              # public exports
  tests/                  # SDK unit tests (vitest)
```

## Database

Neon Postgres with Row-Level Security (RLS). Tables: `tenants`, `api_keys`, `agents`, `runs`, `mcp_servers`, `mcp_connections`, `plugin_marketplaces`.

- Agent names are unique per tenant
- RLS enforced via `app.current_tenant_id` session config (fail-closed via `NULLIF`)
- Tenant-scoped transactions via `withTenantTransaction()`
- Migrations: numbered SQL files in `src/db/migrations/` (currently 001–009), run via `npm run migrate`
- `agents` table includes: Composio MCP cache columns, `composio_allowed_tools` (per-toolkit tool filtering), `skills` JSONB, `plugins` JSONB
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
| `GITHUB_TOKEN` | No | GitHub API auth (5000 req/hr vs 60 unauthenticated); used for plugin marketplace access |
| `CRON_SECRET` | No | Vercel Cron authentication (auto-set in production) |

## API Authentication

All routes (except `/api/health`) require `Authorization: Bearer <api_key>`. Admin routes use `ADMIN_API_KEY` (or JWT cookie via `/api/admin/login`). API keys are hashed with SHA-256; optionally encrypted at rest with `ENCRYPTION_KEY`.

## Deployment

- **Hosting:** Vercel
- **Production:** `agentplane.vercel.app`
- Push to `main` triggers automatic production deploy
- **Migrations run automatically on every deploy** via `buildCommand` in `vercel.json` (`npm run migrate && next build`); failed migrations abort the deploy
- Migration connection priority: `DATABASE_URL_DIRECT` → `DATABASE_URL_UNPOOLED` → `DATABASE_URL`
- `DATABASE_URL_UNPOOLED` is auto-set when Neon is linked via the Vercel integration

## Patterns & Conventions

- Branded types (`TenantId`, `AgentId`, `RunId`, `McpServerId`, `McpConnectionId`, `PluginMarketplaceId`) prevent parameter swaps at compile time
- All DB queries go through typed helpers in `src/db/index.ts` with Zod validation
- Use `withErrorHandler()` wrapper on every API route handler
- Composio MCP server URL + API key are cached per agent in the `agents` table (encrypted at rest)
- Custom MCP servers use OAuth 2.1 PKCE; tokens refreshed automatically with 2-phase retry on transient 5xx
- Agent skills are injected as files into the sandbox at `.claude/skills/<folder>/<path>`
- Plugin files are injected into the sandbox at `.claude/skills/<plugin-name>-<filename>`
- Process-level caching with TTLs: MCP servers (5 min), plugin trees (5 min), recent pushes (2 min)
- SSE streams send heartbeats every 15s and auto-detach after 4.5 min for long-running runs
- Ephemeral Composio asset URLs are persisted to Vercel Blob during transcript capture
- Admin UI is always dark mode via `.dark` class on the layout root; Tailwind v4 dark variant is configured with `@variant dark (&:where(.dark, .dark *))` in `globals.css`
- Sandbox network policy allowlists: AI Gateway, Composio, Firecrawl, GitHub, platform API, custom MCP servers
- Max 10 concurrent runs per tenant; atomic concurrent run check prevents TOCTOU races
