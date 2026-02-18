# AgentPlane

A multi-tenant platform for running Claude Code agents in isolated Vercel Sandboxes, exposed via a REST API.

## Prerequisites

- **Node.js** >= 20
- **npm**
- A [Neon](https://neon.tech) Postgres database
- A [Vercel](https://vercel.com) account (for Sandbox, Blob storage, and AI Gateway)
- A [Composio](https://composio.dev) account (for MCP tool integrations)

## Setup

### 1. Clone and install

```bash
git clone <repo-url>
cd agentplane
npm install
```

### 2. Create a Neon database

1. Sign up at [neon.tech](https://neon.tech) and create a new project.
2. Copy the **pooled** connection string — this is your `DATABASE_URL`.
3. Copy the **direct** (non-pooled) connection string — this is `DATABASE_URL_DIRECT` (used for migrations).

Both are found on your Neon project's **Connection Details** page. The pooled string goes through Neon's connection pooler and is used at runtime. The direct string bypasses the pooler and is needed for DDL operations in migrations.

### 3. Set up Vercel services

You need three Vercel services configured:

#### Vercel Sandbox

The platform runs Claude Code inside [Vercel Sandboxes](https://vercel.com/docs/sandbox). No extra setup is required beyond deploying to Vercel — the `@vercel/sandbox` SDK is included as a dependency and sandboxes are created on-demand per run.

#### Vercel Blob (storage)

Used for persisting run transcripts and ephemeral assets (e.g. Composio/Firecrawl downloads that expire after ~24h).

1. In your Vercel project, go to **Storage** and create a new **Blob** store.
2. Link it to your project — this auto-sets `BLOB_READ_WRITE_TOKEN` in production.
3. For local dev, copy the token from the store's settings into your `.env.local`.

#### Vercel AI Gateway

Used to proxy model requests from Claude Code running inside the sandbox.

1. In your Vercel dashboard, go to **AI** > **AI Gateway** and create a gateway.
2. Copy the API key — this is your `AI_GATEWAY_API_KEY`.

### 4. Set up Composio

[Composio](https://composio.dev) provides MCP tool integrations (GitHub, Slack, Firecrawl, etc.) for agents.

1. Sign up at [composio.dev](https://composio.dev).
2. Go to **Settings** > **API Keys** and generate an API key.
3. This is your `COMPOSIO_API_KEY`.

Composio MCP servers are created and cached per-agent automatically. Toolkit OAuth connections (e.g. connecting an agent to GitHub or Slack) are managed through the admin UI at `/admin`.

### 5. Generate an encryption key

`ENCRYPTION_KEY` is used for AES-256-GCM encryption of API keys and Composio credentials at rest. Generate one:

```bash
openssl rand -hex 32
```

This produces a 64-character hex string (32 bytes). To rotate keys later, move the current key to `ENCRYPTION_KEY_PREVIOUS` and set a new `ENCRYPTION_KEY` — the system will try both when decrypting.

### 6. Configure environment variables

Create a `.env.local` file in the project root:

```bash
# Neon Postgres
DATABASE_URL="postgresql://...@...neon.tech/...?sslmode=require"       # pooled
DATABASE_URL_DIRECT="postgresql://...@...neon.tech/...?sslmode=require" # direct (for migrations)

# Vercel AI Gateway
AI_GATEWAY_API_KEY="your-ai-gateway-key"

# Vercel Blob
BLOB_READ_WRITE_TOKEN="vercel_blob_rw_..."

# Security
ADMIN_API_KEY="a-strong-secret-for-admin-routes"
ENCRYPTION_KEY="64-hex-chars-from-openssl-rand"

# Composio
COMPOSIO_API_KEY="your-composio-api-key"

# Optional
# ENCRYPTION_KEY_PREVIOUS="old-64-hex-chars"  # for seamless key rotation
# CRON_SECRET="vercel-cron-secret"            # auto-set by Vercel in production
```

### 7. Run database migrations

```bash
npm run migrate
```

This applies all SQL migrations in `src/db/migrations/` sequentially. The connection string priority is:
1. `DATABASE_URL_DIRECT` — preferred (direct, non-pooled; best for DDL)
2. `DATABASE_URL_UNPOOLED` — Neon's non-pooled URL (auto-set when linked via Vercel integration)
3. `DATABASE_URL` — pooled fallback

### 8. Create your first tenant

```bash
npm run create-tenant -- --name "My Org" --slug my-org --budget 100
```

- `--name` — display name for the tenant
- `--slug` — URL-safe identifier (lowercase alphanumeric + hyphens)
- `--budget` — monthly budget in USD (default: 100)

This creates a tenant and prints an API key. **Save the key — it cannot be shown again.**

To generate additional API keys for an existing tenant:

```bash
npx tsx scripts/create-api-key.ts <tenant-id>
```

### 9. Start the dev server

```bash
npm run dev
```

The app runs at [http://localhost:3000](http://localhost:3000). The admin UI is at `/admin`.

## Environment Variables

| Variable | Required | Description |
|---|---|---|
| `DATABASE_URL` | Yes | Neon pooled connection string |
| `DATABASE_URL_DIRECT` | No | Neon direct connection string (for migrations) |
| `AI_GATEWAY_API_KEY` | Yes | Vercel AI Gateway API key |
| `ADMIN_API_KEY` | Yes | Secret for admin API route authentication |
| `ENCRYPTION_KEY` | Yes | 64 hex chars (32 bytes) for AES-256-GCM encryption |
| `ENCRYPTION_KEY_PREVIOUS` | No | Previous encryption key for seamless rotation |
| `BLOB_READ_WRITE_TOKEN` | No | Vercel Blob token for transcript + asset storage |
| `COMPOSIO_API_KEY` | Yes | Composio API key for MCP tool integrations |
| `CRON_SECRET` | No | Vercel Cron authentication (auto-set in production) |

## API Authentication

All API routes (except `/api/health`) require `Authorization: Bearer <api_key>`.

- **Tenant routes** — use API keys created via `create-tenant` or `create-api-key` scripts.
- **Admin routes** (`/api/admin/*`) — use the `ADMIN_API_KEY`.

API keys are hashed with SHA-256 and optionally encrypted at rest with AES-256-GCM.

## Deployment

The app is deployed on Vercel.

1. Set all required environment variables in the Vercel project settings.
2. Push to `main` to trigger a production deploy.

**Migrations run automatically on every deploy.** The `buildCommand` in `vercel.json` runs `npm run migrate && next build`, so any pending migrations are applied before the new code goes live. If a migration fails, the deploy is aborted and the previous version stays running.

For this to work, `DATABASE_URL_UNPOOLED` (or `DATABASE_URL_DIRECT`) must be set in Vercel's environment variables for the **build** environment. If you linked Neon via the Vercel integration, `DATABASE_URL_UNPOOLED` is set automatically.

Vercel Cron jobs are configured in `vercel.json`:
- **Sandbox cleanup** — every 15 minutes
- **Transcript cleanup** — daily at 3:00 AM UTC
- **Budget reset** — daily at midnight UTC

## Key Commands

```bash
npm run dev            # start dev server
npm run build          # type-check + build
npm run test           # run tests (vitest)
npm run migrate        # apply database migrations
npm run create-tenant  # create a tenant + API key
```
