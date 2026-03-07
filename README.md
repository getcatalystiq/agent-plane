# AgentPlane

A multi-tenant platform for running [Claude Agent SDK](https://docs.anthropic.com/en/docs/claude-code/sdk) agents in isolated [Vercel Sandboxes](https://vercel.com/docs/sandbox), exposed via a REST API.

**Claude Agents as an API** — one POST request to launch an agent with skills, MCP connectors, streaming, and full observability. Built for platforms.

### Features

- **Claude Agent SDK inside** — full agent with tool use, file editing, and bash running in an isolated sandbox
- **Isolated sandboxes** — every run spins up a fresh Vercel Sandbox with its own filesystem, network policy, and resource limits
- **Skills & plugins** — inject custom skills and marketplace plugins into agents before execution
- **Multi-tenant** — row-level security, per-tenant API keys, budget controls, and rate limiting
- **MCP connectors** — connect agents to external tools via Composio (GitHub, Slack, Firecrawl) or custom OAuth 2.1 MCP servers
- **Full observability** — every run stores a transcript, token usage, cost, and duration
- **TypeScript SDK** — `@getcatalystiq/agentplane` npm package with streaming, auto-polling, and typed events
- **Admin dashboard** — manage tenants, agents, runs, connectors, and plugins with analytics charts

## How It Works

```
1. POST /api/agents/:id/runs  →  2. Sandbox created with Claude Agent SDK + MCP servers
                                           ↓
4. Transcript stored, usage recorded  ←  3. Events stream back over NDJSON
```

```bash
curl -X POST $BASE_URL/api/runs \
  -H "Authorization: Bearer $API_KEY" \
  -d '{"agent_id": "ag_01", "prompt": "Deploy the app"}'
```

## Prerequisites

- **Node.js** >= 20
- **npm**
- A [Neon](https://neon.tech) Postgres database
- A [Vercel](https://vercel.com) account (for Sandbox, Blob storage, and AI Gateway)
- (Optional) A [Composio](https://composio.dev) account for MCP tool integrations
- (Optional) A [GitHub](https://github.com) personal access token for plugin marketplace access

## Setup

### 1. Clone and install

```bash
git clone https://github.com/getcatalystiq/agentplane.git
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

The platform runs Claude Agent SDK inside [Vercel Sandboxes](https://vercel.com/docs/sandbox). No extra setup is required beyond deploying to Vercel — the `@vercel/sandbox` SDK is included as a dependency and sandboxes are created on-demand per run.

#### Vercel Blob (storage)

Used for persisting run transcripts and ephemeral assets (e.g. Composio/Firecrawl downloads that expire after ~24h).

1. In your Vercel project, go to **Storage** and create a new **Blob** store.
2. Link it to your project — this auto-sets `BLOB_READ_WRITE_TOKEN` in production.
3. For local dev, copy the token from the store's settings into your `.env.local`.

#### Vercel AI Gateway

Used to proxy model requests from Claude Agent SDK running inside the sandbox.

1. In your Vercel dashboard, go to **AI** > **AI Gateway** and create a gateway.
2. Copy the API key — this is your `AI_GATEWAY_API_KEY`.

### 4. Set up Composio (optional)

[Composio](https://composio.dev) provides MCP tool integrations (GitHub, Slack, Firecrawl, etc.) for agents.

1. Sign up at [composio.dev](https://composio.dev).
2. Go to **Settings** > **API Keys** and generate an API key.
3. This is your `COMPOSIO_API_KEY`.

Composio MCP servers are created and cached per-agent automatically. Toolkit OAuth connections (e.g. connecting an agent to GitHub or Slack) are managed through the admin UI at `/admin`.

### 5. Generate an encryption key

`ENCRYPTION_KEY` is used for AES-256-GCM encryption of API keys, OAuth tokens, and credentials at rest. Generate one:

```bash
openssl rand -hex 32
```

This produces a 64-character hex string (32 bytes). To rotate keys later, move the current key to `ENCRYPTION_KEY_PREVIOUS` and set a new `ENCRYPTION_KEY` — the system will try both when decrypting.

### 6. Configure environment variables

Copy the example file and fill in your values:

```bash
cp .env.example .env.local
```

Or create `.env.local` manually:

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

# Optional
# COMPOSIO_API_KEY="your-composio-api-key"          # for Composio toolkit integrations
# GITHUB_TOKEN="ghp_..."                            # for plugin marketplace access (5000 req/hr vs 60)
# ENCRYPTION_KEY_PREVIOUS="old-64-hex-chars"        # for seamless key rotation
# CRON_SECRET="vercel-cron-secret"                  # auto-set by Vercel in production
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

Tenants can also be created from the admin UI at `/admin` > **Tenants** > **Add Tenant**.

To generate additional API keys for an existing tenant:

```bash
npx tsx scripts/create-api-key.ts <tenant-id>
```

### 9. Start the dev server

```bash
npm run dev
```

The app runs at [http://localhost:3000](http://localhost:3000):
- **Landing page** at `/` — public marketing page ("Claude Agents as an API")
- **Admin dashboard** at `/admin` — manage tenants, agents, runs, connectors, and plugins

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
| `COMPOSIO_API_KEY` | No | Composio API key for MCP tool integrations |
| `GITHUB_TOKEN` | No | GitHub API token for plugin marketplace access (5000 req/hr vs 60) |
| `CRON_SECRET` | Yes | Vercel Cron authentication |

## API Authentication

All API routes (except `/api/health`) require `Authorization: Bearer <api_key>`.

- **Tenant routes** — use API keys created via `create-tenant` or `create-api-key` scripts.
- **Admin routes** (`/api/admin/*`) — use the `ADMIN_API_KEY` or log in via `/admin` for JWT cookie auth.

API keys are hashed with SHA-256 and optionally encrypted at rest with AES-256-GCM.

## API Overview

### Tenant Routes

| Method | Route | Description |
|---|---|---|
| `GET` | `/api/agents` | List agents |
| `POST` | `/api/agents` | Create agent |
| `GET` | `/api/agents/:id` | Get agent |
| `PATCH` | `/api/agents/:id` | Update agent |
| `DELETE` | `/api/agents/:id` | Delete agent |
| `POST` | `/api/agents/:id/runs` | Create & stream run (NDJSON) |
| `GET` | `/api/agents/:id/runs` | List runs for agent |
| `GET` | `/api/agents/:id/connectors` | List Composio connector status |
| `POST` | `/api/agents/:id/connectors/:toolkit/initiate-oauth` | Start Composio OAuth |
| `GET` | `/api/agents/:id/mcp-connections` | List custom MCP connections |
| `POST` | `/api/agents/:id/mcp-connections/:mcpServerId/initiate-oauth` | Start MCP OAuth |
| `PATCH` | `/api/agents/:id/mcp-connections/:mcpServerId` | Update MCP tool allowlist |
| `GET` | `/api/agents/:id/mcp-connections/:mcpServerId/tools` | List available MCP tools |
| `GET` | `/api/runs` | List runs (filterable by `agent_id`, `status`) |
| `POST` | `/api/runs` | Create run (shorthand, requires `agent_id` in body) |
| `GET` | `/api/runs/:id` | Get run status (NDJSON stream) |
| `POST` | `/api/runs/:id/cancel` | Cancel a run |
| `GET` | `/api/runs/:id/transcript` | Get run transcript |
| `GET` | `/api/tenants/me` | Get current tenant |
| `GET` | `/api/keys` | List API keys |
| `POST` | `/api/keys` | Create API key |
| `DELETE` | `/api/keys/:id` | Revoke API key |
| `GET` | `/api/mcp-servers` | List registered MCP servers |

### Admin Routes

| Method | Route | Description |
|---|---|---|
| `POST` | `/api/admin/login` | Admin login (returns JWT) |
| | `/api/admin/agents/*` | Agent CRUD + connectors + MCP connections + plugin suggestions |
| | `/api/admin/composio/toolkits` | List available Composio toolkits |
| | `/api/admin/composio/tools` | List tools for a toolkit |
| | `/api/admin/mcp-servers/*` | Custom MCP server CRUD |
| | `/api/admin/plugin-marketplaces/*` | Marketplace CRUD + plugin listing + file editing |
| | `/api/admin/tenants/*` | Tenant CRUD + API key management |
| | `/api/admin/runs/*` | Admin run viewing |

## Deployment

The app is deployed on Vercel.

### Vercel Project Setup

1. **Create a Vercel project** and link it to this repository.

2. **Add Neon Postgres** — go to **Storage** in your Vercel project, create a new **Neon Postgres** database, and connect it to the project. This automatically sets `DATABASE_URL` and `DATABASE_URL_UNPOOLED` in your environment variables.

3. **Add Vercel Blob** — go to **Storage**, create a new **Blob** store, and connect it to the project. This automatically sets `BLOB_READ_WRITE_TOKEN`.

4. **Create an AI Gateway API key** — go to **AI** > **AI Gateway** in the Vercel dashboard, create a gateway, and copy the API key. Manually add it as `AI_GATEWAY_API_KEY` in the project's environment variables.

5. **Generate and set the following environment variables** manually in the Vercel project settings:

   | Variable | How to generate |
   |---|---|
   | `ADMIN_API_KEY` | Any strong secret string for admin route authentication |
   | `ENCRYPTION_KEY` | `openssl rand -hex 32` (64 hex chars, used for AES-256-GCM encryption) |
   | `CRON_SECRET` | Any strong secret string for Vercel Cron job authentication |

6. Push to `main` to trigger a production deploy.

**Migrations run automatically on every deploy.** The `buildCommand` in `vercel.json` runs `npm run migrate && next build`, so any pending migrations are applied before the new code goes live. If a migration fails, the deploy is aborted and the previous version stays running.

For this to work, `DATABASE_URL_UNPOOLED` (or `DATABASE_URL_DIRECT`) must be set in Vercel's environment variables for the **build** environment. If you linked Neon via the Vercel integration, `DATABASE_URL_UNPOOLED` is set automatically.

Vercel Cron jobs are configured in `vercel.json`:
- **Sandbox cleanup** — every 15 minutes
- **Transcript cleanup** — daily at 3:00 AM UTC
- **Budget reset** — daily at midnight UTC

## TypeScript SDK

The `@getcatalystiq/agentplane` package provides a typed client for the AgentPlane API.

```bash
npm install @getcatalystiq/agentplane
```

```ts
import { AgentPlane } from "@getcatalystiq/agentplane";

const client = new AgentPlane({ apiKey: "ap_live_..." });

// Stream events from a run
const stream = await client.runs.create({
  agent_id: "agent_abc123",
  prompt: "Create a landing page",
});

for await (const event of stream) {
  if (event.type === "assistant") {
    console.log(event.message);
  }
}

// Or wait for completion (handles stream detach automatically)
const run = await client.runs.createAndWait({
  agent_id: "agent_abc123",
  prompt: "Fix the login bug",
});
```

See [`sdk/README.md`](sdk/README.md) for full documentation including agent management, error handling, and stream cancellation.

## Key Commands

```bash
npm run dev            # start dev server
npm run build          # type-check + build
npm run test           # run tests (vitest)
npm run test:watch     # vitest watch mode
npm run migrate        # apply database migrations
npm run create-tenant  # create a tenant + API key

# SDK (sdk/ directory)
npm run sdk:build      # build SDK (ESM + CJS + DTS)
npm run sdk:test       # run SDK tests
npm run sdk:typecheck  # typecheck SDK
```

## License

MIT
