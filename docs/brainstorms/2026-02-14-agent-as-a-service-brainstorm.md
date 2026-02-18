# AgentPlane - Claude Agent-as-a-Service

**Date:** 2026-02-14
**Status:** Brainstorm complete
**Project:** AgentPlane (new project, separate from maven-core)
**Author:** Team

## What We're Building

A developer-first platform for running Claude Agent SDK agents in the cloud. Developers configure agents with specific tools (via Composio), skills/commands (via Git repos), and runtime settings, then execute them on-demand or via triggers. Full observability into every agent run.

**Target users:** Developers and engineering teams who want to deploy Claude-powered agents without managing infrastructure.

**Core capabilities (MVP):**
1. **Agent Runtime** - Execute Claude Agent SDK agents in Vercel Sandboxes with configurable model (Anthropic/Bedrock), max turns, and budget per execution
2. **Plugin Repo** - Point each agent to a Git repo containing skills (SKILL.md), slash commands, and `.mcp.json` connector configs. Cloned at sandbox startup, loaded natively by the SDK
3. **Composio Integration** - Each agent gets a Composio entity for managed tool authentication. Composio generates per-agent MCP URLs exposing authenticated tools (GitHub, Slack, Trello, etc.)
4. **Full Observability** - Real-time HTTP streaming of agent execution + complete transcript storage (every message, tool call, tool result, token usage)

**Future (post-MVP):**
- Triggers: webhooks, cron jobs, event subscriptions from connected tools
- Full event system (Composio triggers for "new GitHub issue", "Slack message", etc.)

## Why This Approach

### Vercel-Native Monolith

A single Next.js application deployed on Vercel handles everything:
- **API Routes** - Control plane (auth, tenant management, agent config CRUD, run history)
- **Vercel Sandbox** - Agent execution in ephemeral, isolated containers
- **Vercel Postgres** - Persistent data (tenants, agent configs, run metadata)
- **Vercel Blob/KV** - Run transcripts, caching

**Why this over alternatives:**
- **Simplest deployment** - One codebase, one platform, Vercel handles scaling
- **Native streaming** - Vercel supports HTTP streaming natively, perfect for real-time agent output
- **Vercel Sandbox is purpose-built** - Ephemeral containers with configurable vCPUs, timeouts, filesystem isolation
- **Can split later** - If execution needs to scale independently, extract it. But start simple.

**Rejected alternatives:**
- *Cloudflare Containers (maven-core approach)* - Moving away from CF for this project. Vercel Sandbox has better isolation story and native SDK support.
- *API + Execution Split* - More infrastructure overhead for MVP. Split if needed later.
- *Thin Orchestrator* - Too little control over execution, hard to add rate limiting and run queuing.

## Key Decisions

### 1. Execution: Vercel Sandbox
Each agent run spins up an ephemeral Vercel Sandbox. The sandbox:
- Clones the agent's Git plugin repo
- Receives Composio MCP URL and auth headers
- Runs the Claude Agent SDK with configured model, permissions, and tools
- Streams all messages back to the API via HTTP streaming
- Auto-terminates after completion or timeout

Configuration per sandbox:
```typescript
const sandbox = await Sandbox.create({
  resources: { vcpus: 2 },  // Configurable per agent
  timeout: ms('10m'),        // From agent config max_budget/max_turns
  runtime: 'node22'
});
```

### 2. Security: SDK Permissions
Use the Claude Agent SDK's built-in permission system:
- `allowedTools` - Whitelist specific tools per agent config
- `permissionMode` - Control level of autonomy
- `hooks` - Pre/PostToolUse hooks for audit logging and custom restrictions
- Vercel Sandbox provides OS-level isolation (filesystem, network, process)

No additional sandbox-runtime or proxy needed - the Vercel Sandbox boundary is the security boundary.

### 3. Plugin Loading: Git Repo per Agent
Each agent config includes a Git repo URL. At sandbox startup:
1. Clone repo into sandbox working directory
2. SDK's `settingSources: ['project']` auto-discovers:
   - `.claude/skills/*.md` - Skills
   - `.claude/commands/*.md` - Slash commands
   - `.mcp.json` - MCP server configs
   - `CLAUDE.md` - Project context/instructions
3. Composio MCP URL is injected alongside repo-defined MCP servers

This means developers manage their agent's capabilities entirely through Git - version controlled, reviewable, familiar.

### 4. Tool Auth: Composio
Composio handles all third-party tool authentication:
- Each agent gets a Composio "entity" (user identity)
- Composio manages OAuth flows, token refresh, API key storage
- At runtime, generate an MCP URL scoped to the agent's entity and requested toolkits
- Pass the MCP URL to Claude Agent SDK as an HTTP MCP server

```typescript
const composio = new Composio({ apiKey: COMPOSIO_API_KEY });
const mcpServer = composio.create({
  userId: agentEntityId,
  toolkits: agent.config.composioToolkits  // e.g., ["github", "slack", "linear"]
});

// Pass to Claude Agent SDK
const options = {
  mcpServers: {
    composio: {
      type: "http",
      url: mcpServer.mcp.url,
      headers: { "x-api-key": COMPOSIO_API_KEY }
    },
    // Plus any MCP servers from the Git repo's .mcp.json
  },
  allowedTools: ["mcp__composio__*", ...agent.config.allowedTools]
};
```

### 5. LLM Providers: Anthropic + Bedrock
Support direct Anthropic API and AWS Bedrock at launch. The Claude Agent SDK handles this via environment variables:
- `ANTHROPIC_API_KEY` for direct Anthropic
- `CLAUDE_CODE_USE_BEDROCK=1` + AWS credentials for Bedrock

Per-agent configuration stored securely, injected into sandbox environment.

### 6. Auth: API Keys Only
No user accounts. Tenants authenticate with API keys (like OpenAI/Stripe). Simple, developer-first.
- API key hashed and stored in Postgres
- Passed via `Authorization: Bearer <key>` header
- No JWT, no login, no sessions

### 7. Observability: Full Transcript + Streaming
**Streaming path:** API route creates sandbox -> subscribes to sandbox output -> relays messages to client over a held-open HTTP response (NDJSON streaming). Single chain, no polling.

```
Client <--NDJSON stream-- API Route <--sandbox.exec()-- Vercel Sandbox
                                                          |
                                                     Claude Agent SDK
                                                     query() stream
```

Two layers:
- **Real-time**: NDJSON streaming over chunked HTTP. API route holds the connection open. Every SDK message (system, assistant, tool_use, tool_result) forwarded as it arrives.
- **Storage**: Complete transcript persisted after run completion. Every message, tool call input/output, token usage, timing data stored in Vercel Blob as NDJSON.

Run metadata (status, duration, token usage, cost) stored in Vercel Postgres for querying.

### 7. Code Execution
No separate sandbox for code interpretation. Bash runs in the same Vercel Sandbox (already isolated, ephemeral, resource-limited). Controlled via `allowedTools`.

## Architecture Diagram

```
Developer                     Platform (Vercel)                    External

[API Key Auth]               [Next.js App]
  Bearer <key>                 |
        |                      +-- API Routes
        v                        |  - POST /agents (CRUD)
[Agent Config]                   |  - POST /runs (trigger + stream)
  - model                       |  - GET  /runs/:id/transcript
  - git repo URL                |
  - composio toolkits         +-- Auth (API key)
  - allowed tools              |
  - max turns/budget          +-- Vercel Postgres
                               |  - tenants, agents, runs, api_keys
[Git Plugin Repo]              |
  .claude/                    +-- Vercel Blob
    skills/                      - run transcripts (NDJSON, 30d TTL)
    commands/
  .mcp.json               [Vercel Sandbox]                 [Composio]
  CLAUDE.md                  |                                |
                             +-- Clone git repo               +-- MCP URL
                             +-- Claude Agent SDK             +-- OAuth mgmt
                             +-- NDJSON stream -> API route   +-- 800+ tools
                             +-- Bash/Read/Write/etc
                             +-- MCP (Composio + repo)
```

**Streaming path:** `POST /runs` creates sandbox, holds connection open, relays NDJSON stream to client.

## Data Model (Draft)

```
tenants
  id, name, slug, api_key_hash, settings, created_at

agents
  id, tenant_id, name, description,
  git_repo_url, git_branch,
  composio_entity_id, composio_toolkits[],
  model, llm_provider, llm_credentials (encrypted),
  allowed_tools[], permission_mode,
  max_turns, max_budget_usd,
  sandbox_config (vcpus, timeout),
  created_at, updated_at

runs
  id, agent_id, tenant_id,
  status (pending/running/completed/failed/cancelled),
  trigger_type (api),  -- MVP: API only. Add webhook/cron/event later.
  prompt,
  result_summary,
  total_input_tokens, total_output_tokens,
  cost_usd,
  duration_ms,
  transcript_blob_key,
  started_at, completed_at, created_at

api_keys
  id, tenant_id, name, key_prefix, key_hash,
  last_used_at, created_at
```

## Resolved Questions

1. **Git repo auth** - Use GitHub App tokens. Users install an AgentPlane GitHub App on their repos. Platform generates short-lived installation tokens for cloning. Most secure, supports org-level access control.
2. **Multi-turn sessions** - Single-turn only for MVP. Each run is prompt -> agent executes -> result. Multi-turn sessions are a future feature.
3. **Vercel Sandbox cold start** - Sub-second initialization. Vercel uses bytecode caching and predictive warming. Not a concern since agent runs take seconds to minutes anyway.
4. **Composio pricing** - Free (Hobby), $29/mo (Starter), $229/mo (Growth), Custom (Enterprise). Entities are per-agent (not per-run), so cost scales with number of configured agents, not executions. Start on Starter/Growth.
5. **Run queuing** - Not needed for MVP. Vercel Sandbox supports 2,000 concurrent sandboxes and 200 vCPUs/minute on Pro. At 2 vCPUs per sandbox = 100 new sandboxes/minute. Add a queue later if needed.
6. **Transcript retention** - 30 days default, configurable per tenant. Auto-delete after TTL. Store in Vercel Blob as NDJSON.

## Vercel Sandbox Cost Reference

| Scenario | Duration | vCPUs | Estimated Cost |
|----------|----------|-------|---------------|
| Quick agent run | 2 min | 2 | ~$0.01 |
| Standard agent run | 5 min | 2 | ~$0.03 |
| Complex agent run | 30 min | 4 | ~$0.34 |
| Long-running task | 2 hr | 8 | ~$2.73 |

Max duration: 5 hours (Pro/Enterprise). Max 8 vCPUs, 16 GB memory per sandbox. Creation cost: $0.60 per million.
