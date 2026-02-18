# AgentPlane

A multi-tenant platform for running Claude Code agents in isolated Vercel Sandboxes, exposed via a REST API.

## Architecture

**Stack:** Next.js 16 (App Router) · TypeScript · Neon Postgres · Vercel Sandbox · Vercel Blob · Tailwind CSS v4

**Core concepts:**
- **Tenant** — isolated workspace with its own API keys, agents, and budget
- **Agent** — configuration (model, tools, permissions, git repo) that runs Claude Code
- **Run** — a single agent execution triggered by a prompt; streams SSE events

**Execution flow:**
1. Client POSTs to `/api/agents/:id/runs` with a prompt
2. MCP config is built (Composio toolkits resolved, cached per agent)
3. A Vercel Sandbox is created, Claude Code runs inside it
4. Events stream back over SSE (`run_started`, `assistant`, `tool_use`, `tool_result`, `result`)
5. Ephemeral asset URLs (e.g. Composio/Firecrawl) are replaced with permanent Vercel Blob URLs
6. Transcript stored in Vercel Blob; token usage + cost recorded in DB
7. Long-running streams (>4.5 min) detach with a `stream_detached` event; clients poll `/api/runs/:id`

## Key Commands

```bash
npm run dev            # start dev server
npm run build          # type-check + build (Next.js)
npm run test           # vitest run
npm run migrate        # run DB migrations (requires DATABASE_URL)
npm run create-tenant  # create a tenant + API key
npx tsx scripts/create-api-key.ts <tenant-id>  # generate additional API keys
```

## Project Structure

```
src/
  app/
    api/            # REST API routes
      agents/       # CRUD + run creation + toolkit connect (OAuth)
      runs/         # run status, cancel, transcript
      admin/        # admin-only endpoints
        agents/     # agent CRUD + connectors (per-toolkit auth)
        composio/   # available toolkits listing
        runs/       # admin run management
        tenants/    # tenant management
      cron/         # scheduled jobs (budget reset, cleanup)
      github/       # GitHub webhook handler
      health/       # health check
      keys/         # API key management
      tenants/      # tenant management
    admin/          # Admin UI (Next.js pages)
  db/
    index.ts        # DB client (Pool, query helpers, transactions)
    migrate.ts      # migration runner
    migrations/     # sequential SQL migration files (001–005)
  lib/
    types.ts        # branded types, domain interfaces, StreamEvent union
    env.ts          # Zod-validated env (getEnv())
    auth.ts         # API key authentication
    admin-auth.ts   # admin API key auth
    sandbox.ts      # Vercel Sandbox creation + Claude Code runner
    composio.ts     # Composio MCP integration (toolkit auth, server lifecycle)
    mcp.ts          # MCP server config builder (caching, encryption)
    assets.ts       # ephemeral asset persistence (Composio URLs → Vercel Blob)
    runs.ts         # run lifecycle helpers
    streaming.ts    # SSE streaming (heartbeats, stream detach)
    transcripts.ts  # Vercel Blob transcript storage
    api.ts          # withErrorHandler, jsonResponse helpers
    validation.ts   # Zod request/response schemas
    crypto.ts       # ID generation, key hashing, AES-256-GCM encryption
    idempotency.ts  # idempotent request handling
    rate-limit.ts   # Vercel KV-based rate limiting
    errors.ts       # typed error classes
    logger.ts       # structured logger
    utils.ts        # misc helpers
  components/       # React UI components
    toolkit-multiselect.tsx  # Composio toolkit picker (search, logos)
    ui/             # shared UI primitives
  middleware.ts     # auth middleware
scripts/
  create-tenant.ts   # CLI to provision tenant + API key
  create-api-key.ts  # CLI to generate additional API keys for a tenant
tests/
  unit/             # Vitest unit tests
```

## Database

Neon Postgres with Row-Level Security (RLS). Tables: `tenants`, `api_keys`, `agents`, `runs`.

- Agent names are unique per tenant
- RLS enforced via `app.current_tenant_id` session config
- Tenant-scoped transactions via `withTenantTransaction()`
- Migrations: numbered SQL files in `src/db/migrations/` (currently 001–005), run via `npm run migrate`
- `agents` table includes Composio MCP cache columns (`composio_mcp_server_id`, `composio_mcp_server_name`, `composio_mcp_url`, `composio_mcp_api_key_enc`)

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | Neon connection string (pooled) |
| `DATABASE_URL_DIRECT` | No | Direct connection for migrations (preferred over unpooled) |
| `DATABASE_URL_UNPOOLED` | No | Neon non-pooled URL; auto-set by Vercel integration; used for migrations |
| `ADMIN_API_KEY` | Yes | Admin API authentication |
| `AI_GATEWAY_API_KEY` | Yes | Vercel AI Gateway key |
| `ENCRYPTION_KEY` | Yes | 64 hex chars (32 bytes) for key + Composio API key encryption (AES-256-GCM) |
| `ENCRYPTION_KEY_PREVIOUS` | No | 64 hex chars; supports seamless key rotation |
| `BLOB_READ_WRITE_TOKEN` | No | Vercel Blob (transcript + asset storage) |
| `CRON_SECRET` | No | Vercel Cron authentication |
| `COMPOSIO_API_KEY` | Yes | Composio MCP tool integration |

## API Authentication

All routes (except `/api/health`) require `Authorization: Bearer <api_key>`. Admin routes use `ADMIN_API_KEY`. API keys are hashed with SHA-256; optionally encrypted at rest with `ENCRYPTION_KEY`.

## Deployment

- **Hosting:** Vercel
- **Production:** `agentplane.vercel.app`
- Push to `main` triggers automatic production deploy
- **Migrations run automatically on every deploy** via `buildCommand` in `vercel.json` (`npm run migrate && next build`); failed migrations abort the deploy
- Migration connection priority: `DATABASE_URL_DIRECT` → `DATABASE_URL_UNPOOLED` → `DATABASE_URL`
- `DATABASE_URL_UNPOOLED` is auto-set when Neon is linked via the Vercel integration

## Patterns & Conventions

- Branded types (`TenantId`, `AgentId`, `RunId`) prevent parameter swaps at compile time
- All DB queries go through typed helpers in `src/db/index.ts` with Zod validation
- Use `withErrorHandler()` wrapper on every API route handler
- Composio MCP server URL + API key are cached per agent in the `agents` table (encrypted at rest)
- Agent skills are injected as files into the sandbox before Claude runs
- SSE streams send heartbeats every 15s and auto-detach after 4.5 min for long-running runs
- Ephemeral Composio asset URLs are persisted to Vercel Blob during transcript capture
- Admin UI is always dark mode via `.dark` class on the layout root; Tailwind v4 dark variant is configured with `@variant dark (&:where(.dark, .dark *))` in `globals.css`
