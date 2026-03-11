# A2A Protocol Integration into AgentPlane

**Date:** 2026-03-10
**Status:** Draft
**Participants:** User, Claude

---

## What We're Building

Bidirectional A2A (Agent-to-Agent) protocol support for AgentPlane:

1. **A2A Server** — Expose every AgentPlane agent as an A2A-compliant endpoint so external agents (LangGraph, CrewAI, Semantic Kernel, etc.) can discover and invoke them via the standard protocol.

2. **A2A Client** — Let AgentPlane agents call external A2A-compliant agents during execution, enabling multi-agent delegation and composition across framework boundaries.

The A2A protocol (Linux Foundation) standardizes agent-to-agent communication with Agent Cards for discovery, Tasks for work units, streaming for real-time updates, and push notifications for async workflows. It complements MCP (agent-to-tool) with agent-to-agent interoperability.

---

## Why This Approach

**Per-tenant Agent Cards** preserve multi-tenant isolation while enabling discovery. Each tenant controls which agents are visible to external callers, and existing API key auth gates access — no new auth infrastructure needed.

**Per-agent external A2A config** gives fine-grained control over which external agents each AgentPlane agent can call, matching the existing per-agent MCP connection pattern.

**MCP tools for outbound A2A calls** reuse the proven MCP integration pattern. The Claude Agent SDK already knows how to call MCP tools — wrapping A2A client calls as MCP tools means zero changes to the sandbox runner or SDK integration.

**HTTP/REST binding** maps naturally to Next.js API routes and is the easiest to implement, debug, and document.

---

## Key Decisions

### 1. A2A Server: Dedicated `/api/a2a` Route Tree

New routes at `/api/a2a/{tenantSlug}/...`:

```
GET  /api/a2a/{slug}/.well-known/agent.json     → Agent Card (lists tenant's agents as skills)
POST /api/a2a/{slug}/tasks:sendMessage           → Create task (maps to run)
POST /api/a2a/{slug}/tasks:sendStreamingMessage   → Create task with SSE streaming
GET  /api/a2a/{slug}/tasks/{taskId}               → Get task status/artifacts
GET  /api/a2a/{slug}/tasks                        → List tasks (with pagination)
POST /api/a2a/{slug}/tasks/{taskId}:cancel         → Cancel task
GET  /api/a2a/{slug}/tasks/{taskId}/subscribe      → SSE subscription to existing task
POST /api/a2a/{slug}/tasks/{taskId}/pushNotificationConfigs  → CRUD for webhooks
```

Clean separation from existing REST API. Internally, A2A tasks map to AgentPlane runs.

### 2. A2A Task ↔ AgentPlane Run Mapping

| A2A Concept | AgentPlane Concept |
|---|---|
| Task | Run (with `triggered_by: 'a2a'`) |
| Task ID | Run ID |
| Context ID | Session ID (for multi-turn) |
| Message (user role) | Run prompt |
| Message (agent role) | Run result |
| Artifact | Run transcript + result content |
| Task status | Run status mapping (see below) |
| Skill (in Agent Card) | Agent (one skill per agent) |

**Status mapping:**

| A2A Status | AgentPlane Run Status |
|---|---|
| `working` | `running` |
| `completed` | `completed` |
| `failed` | `failed` |
| `canceled` | `cancelled` |
| `input-required` | New status or session-based flow |
| `rejected` | Budget exceeded / concurrency limit |

### 3. Agent Card Structure

Each tenant's Agent Card lists their agents as "skills":

```json
{
  "name": "Acme Corp Agents",
  "provider": { "organization": "Acme Corp" },
  "url": "https://agentplane.vercel.app/api/a2a/acme",
  "capabilities": {
    "streaming": true,
    "pushNotifications": true
  },
  "securitySchemes": {
    "apiKey": {
      "type": "http",
      "scheme": "bearer",
      "description": "AgentPlane API key"
    }
  },
  "security": [{ "apiKey": [] }],
  "skills": [
    {
      "id": "agent-abc123",
      "name": "Code Reviewer",
      "description": "Reviews code for quality and security issues",
      "inputModes": ["text/plain"],
      "outputModes": ["text/plain", "text/markdown"]
    }
  ]
}
```

### 4. Inbound Auth: Reuse API Keys

External A2A agents authenticate with existing tenant API keys via `Authorization: Bearer <api_key>`. The Agent Card declares an `HTTPAuthSecurityScheme` with `scheme: "bearer"`. No new auth infrastructure. Tenant RLS applies as usual.

### 5. A2A Client: MCP Tool Wrapper

For outbound calls, build a lightweight MCP server (stdio-based, injected into sandbox) that exposes:

- `a2a_discover` — Fetch an external agent's Agent Card
- `a2a_send_message` — Send a message to an external A2A agent (blocking)
- `a2a_send_streaming_message` — Send with streaming (returns incremental updates)
- `a2a_get_task` — Poll task status
- `a2a_cancel_task` — Cancel a running task

External A2A agent URLs and auth tokens are configured per-agent (similar to MCP connections) and injected into the sandbox environment.

### 6. External A2A Agent Registry

New DB table `a2a_connections` (or extend `mcp_connections`):

- `agent_id` — which AgentPlane agent can use this connection
- `tenant_id` — RLS scope
- `a2a_agent_url` — base URL of external A2A agent
- `a2a_agent_name` — display name (from Agent Card)
- `auth_type` — bearer / oauth / none
- `auth_credentials` — encrypted token or OAuth config
- Agent Card cached with TTL (similar to MCP server cache pattern)

### 7. Streaming: SSE from Day One

- **Server-side**: Map existing NDJSON run events to A2A `StreamResponse` format (`TaskStatusUpdateEvent`, `TaskArtifactUpdateEvent`)
- **Client-side**: MCP tool `a2a_send_streaming_message` returns incremental events to the agent
- Reuse existing heartbeat (15s) and auto-detach (4.5 min) patterns
- `SubscribeToTask` endpoint allows reconnecting to an in-progress task's stream

### 8. Push Notifications: Webhook Delivery

New DB table `a2a_push_notification_configs`:

- `task_id` (run_id), `webhook_url`, `webhook_auth` (encrypted)
- On run status change, POST `StreamResponse` JSON to registered webhooks
- Inline delivery with retry (3 attempts, exponential backoff) — no async queue needed for v1
- CRUD endpoints per A2A spec

### 9. Network Policy Updates

- Sandbox allowlist extended with external A2A agent hostnames (per-agent config)
- Webhook delivery from platform (not sandbox) — no sandbox network changes needed for push notifications

---

## Approach: Phased Rollout

### Phase 1: A2A Server + Multi-Turn
- Agent Card endpoint per tenant (with `a2a_enabled` flag on agents)
- `SendMessage` (blocking) + `SendStreamingMessage`
- `GetTask`, `ListTasks`, `CancelTask`, `SubscribeToTask`
- Status mapping (run ↔ task), including `input-required` → session flow
- Multi-turn support: `contextId` maps to AgentPlane sessions
- Push notification configs + inline webhook delivery (3 retries, exponential backoff)
- Bearer token auth (reuse existing API keys)
- DB migration: `triggered_by: 'a2a'`, `a2a_enabled` on agents, `a2a_push_notification_configs` table
- Shared budget + concurrency limits (no separate A2A limits)

### Phase 2: A2A Client
- External A2A agent registry (DB table `a2a_connections` + admin API)
- MCP tool wrapper for outbound A2A calls (stdio server injected into sandbox)
- Per-agent A2A connection config (admin UI)
- Sandbox network policy extension for external A2A agent hosts

### Phase 3: Advanced Features
- Extended Agent Card (authenticated, richer metadata)
- A2A connection OAuth 2.0 support
- Agent Card caching + background refresh
- A2A-specific observability (cross-agent trace IDs)

---

## Resolved Questions

1. **Multi-turn conversations** — Yes, from Phase 1. `contextId` maps to AgentPlane sessions; `input-required` status supported.
2. **Agent visibility** — Explicit `a2a_enabled` boolean flag per agent. Only flagged agents appear in Agent Card.
3. **Budget/rate limits** — Shared with existing tenant budget and concurrency limits. No separate A2A limits.
4. **Webhook delivery** — Inline with 3 retries and exponential backoff. No async queue for v1.

## Open Questions

(None remaining)
