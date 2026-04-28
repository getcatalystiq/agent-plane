# Best Practices: A2A Protocol, Slug Design, Next.js Routing, JSON-RPC

Research date: 2026-03-17. Sources: official A2A spec (google/A2A), @a2a-js/sdk@0.3.12, Next.js App Router docs, JSON-RPC 2.0 spec, codebase analysis.

---

## 1. A2A Protocol — Per-Agent vs. Multi-Agent Endpoints

**Recommendation: keep per-tenant slug endpoints, add per-agent Agent Cards.**

The A2A spec (Section 11, HTTP+REST binding) mandates one Agent Card per logical agent identity. The spec does NOT require a single multi-agent gateway; it defines the Agent Card URL as `{agentBaseUrl}/.well-known/agent-card.json`.

Your current design (`/api/a2a/{tenantSlug}/...`) maps the tenant as the "agent identity". This works today because each tenant runs one primary agent, but will break when a tenant has multiple distinct agents that external clients need to address independently.

**Recommended URL structure:**

```
# Agent Card discovery (public, rate-limited)
GET /api/a2a/{tenantSlug}/{agentSlug}/.well-known/agent-card.json

# JSON-RPC endpoint (authenticated)
POST /api/a2a/{tenantSlug}/{agentSlug}/jsonrpc

# Optional: tenant-level listing (authenticated, returns array of agent cards)
GET /api/a2a/{tenantSlug}/.well-known/agents.json
```

**Why per-agent:**
- The spec's Agent Card `url` field MUST point to the specific agent's JSON-RPC endpoint. A single tenant endpoint forces a single Agent Card describing all agents, violating the "opaque execution / declared capabilities" principle.
- External A2A clients cache Agent Cards by URL. Mixing agents under one endpoint means clients can't differentiate capabilities or skills.
- `@a2a-js/sdk`'s `DefaultRequestHandler` is already constructed per-request; routing to agent-specific handlers by slug adds no overhead.

**What to do now vs. later:**
- Now: add `agentSlug` to `buildAgentCard()` so the `url` field in the card is agent-scoped, even if the JSON-RPC route stays at tenant scope.
- Migration path: add `[agentSlug]` segment when a tenant has >1 A2A-enabled agent (use a redirect from old URL for backwards compat).

---

## 2. Agent Card Design

The spec defines these required fields. Audit your `buildAgentCard()` against them:

```typescript
{
  name: string;              // required
  description: string;       // required
  url: string;               // required — JSON-RPC endpoint URL (agent-specific)
  version: string;           // required — semver of your agent, not A2A protocol
  protocolVersion: string;   // required — "1.0" (current spec version)
  capabilities: {
    streaming: boolean;      // true — you support message/stream
    pushNotifications: boolean;  // false unless you implement webhook callbacks
    stateTransitionHistory: boolean; // false unless you persist history
  };
  skills: AgentSkill[];      // array, even if empty
  authentication: { schemes: string[] };  // ["Bearer"]
  defaultInputModes: string[];   // ["text/plain"]
  defaultOutputModes: string[];  // ["text/plain"]
}
```

**Gaps to address:**
- `protocolVersion` field: verify you're sending this (added in A2A spec 1.0).
- `skills` array: populate from the agent's skills JSONB column — each skill should have `id`, `name`, `description`, `inputModes`, `outputModes`. This is the primary discovery signal for external clients.
- `extensions`: optional but valuable — you can advertise custom capabilities (e.g., `agent-plane/session-resume`).
- Cache TTL of 60s is appropriate. The spec recommends clients re-fetch after 5 min; your 300s `Cache-Control` on the response is correct.

**Listing/registry endpoint:**
The spec does not define a standard registry. The conventional pattern (used by Google's own samples) is:
- A `GET /.well-known/agents.json` at the tenant root returning an array of Agent Card URLs (not full cards) — acts as a directory.
- Authenticated so tenants don't expose their agent catalog publicly.
- Not required for spec compliance; add it when external orchestrators need to enumerate a tenant's agents.

---

## 3. API Slug Design for Multi-Tenant SaaS

**Generation:**
```typescript
// Derive from name, append nanoid suffix only on collision
function generateSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 48); // reserve 4 chars for suffix
}
```

**Uniqueness in Postgres:**
```sql
-- Unique index, not unique constraint, so partial indexes work
CREATE UNIQUE INDEX tenants_slug_unique ON tenants (slug);
CREATE UNIQUE INDEX agents_slug_unique ON agents (slug, tenant_id); -- scoped
```

Use `INSERT ... ON CONFLICT DO NOTHING` returning the row; if no row returned, append `-{nanoid(4)}` and retry once. Never loop more than 2 attempts — a 4-char nanoid gives 1.6M combinations.

**Immutability:**
- Slugs MUST be immutable once published as A2A Agent Card URLs. External clients embed these URLs.
- Store a separate `display_name` for UI renames.
- If you must allow slug changes: implement HTTP 301 redirect from old slug to new, keep old slug reserved in a `retired_slugs` table for 90 days.
- Add a DB trigger or application-layer guard that rejects slug updates after first A2A request is recorded.

**Reserved slugs:** block `well-known`, `api`, `admin`, `health`, `static`, `assets`, `internal`.

---

## 4. Next.js App Router — Nested Dynamic Segments

**Your current structure:** `/api/a2a/[slug]/.well-known/agent-card.json/route.ts`

**Known gotchas:**

1. **`params` is now async (Next.js 15+).** You're already doing `const { slug } = await context!.params` — correct. Never destructure synchronously.

2. **`.well-known` in path segments:** The dot prefix is legal in Next.js folder names. No special handling needed, but verify your `next.config.ts` doesn't have a rewrite that swallows `.well-known/*` paths.

3. **Adding `[agentSlug]`:** `/api/a2a/[slug]/[agentSlug]/jsonrpc/route.ts` will conflict with `/api/a2a/[slug]/jsonrpc/route.ts` if `jsonrpc` can match `[agentSlug]`. Solution: use a catch-all `[...path]` only as a last resort. Instead, keep both URL patterns as separate route files — Next.js resolves static segments before dynamic ones, so `/api/a2a/[slug]/jsonrpc` beats `/api/a2a/[slug]/[agentSlug]/jsonrpc` only if `[agentSlug]` is a third segment.

   Correct nested structure:
   ```
   app/api/a2a/[slug]/                          # tenant-level (legacy)
     jsonrpc/route.ts
     .well-known/agent-card.json/route.ts
   app/api/a2a/[slug]/[agentSlug]/              # per-agent (new)
     jsonrpc/route.ts
     .well-known/agent-card.json/route.ts
   ```
   No conflict because segment depth differs.

4. **`maxDuration` per route:** Your `export const maxDuration = 60` on the jsonrpc route is correct. Streaming routes need this; apply it to the agent-level route too.

5. **`export const dynamic = "force-dynamic"`:** Required on all A2A routes. Verify it's present on every `route.ts`, not just the parent layout.

---

## 5. JSON-RPC 2.0 Routing in Multi-Agent Contexts

**Method namespace:** The A2A spec defines a fixed method set — `message/send`, `message/stream`, `tasks/get`, `tasks/list`, `tasks/cancel`, `tasks/pushNotificationConfig/set`, etc. Do not add custom prefixes. Agent identity is resolved by URL (the slug), not by method name.

**Routing pattern (current — correct):**
```
POST /api/a2a/{slug}/jsonrpc
  → authenticate by slug+Bearer
  → construct per-request DefaultRequestHandler with tenant-scoped TaskStore + Executor
  → dispatch via JsonRpcTransportHandler
```

This is the right architecture. The `@a2a-js/sdk` `DefaultRequestHandler` is stateless per construction — safe to instantiate per request. Do not use a singleton handler shared across tenants.

**Batch requests:** JSON-RPC 2.0 allows batch (array of request objects). The `@a2a-js/sdk` `JsonRpcTransportHandler` handles this. Verify your body-size limit (currently 1MB) is sufficient for batch use cases; 1MB is reasonable.

**Error sanitization (already implemented — keep it):** Your `MessageBackedTaskStore.save()` catches all errors and throws `A2AError.internalError("Internal storage error")` to prevent SQL detail leaks. This is correct. Never let Postgres error messages reach the JSON-RPC response.

**Idempotency:** Your idempotency layer keyed on `A2A-Request-Id` is correct per spec. The spec requires servers to deduplicate requests with the same ID within a reasonable window (you should document your window — 24h is standard).

**Missing: `tasks/list`** — The spec defines `tasks/list` (3.1.4) with filtering by context ID and status. The `@a2a-js/sdk` may not implement this yet. Track it; external orchestrators will expect it.

---

---

## 6. taskId mapping change + Agent Card metadata v2 (2026-04-27)

The runs/sessions unification (migration `033_runs_sessions_unify.sql`) changed how A2A `taskId`s map onto AgentPlane internals.

**Before (legacy):**
- `taskId` was the `runs.id` of the platform-level run row.
- `RunBackedTaskStore` translated A2A status updates into `runs.status` writes.
- `tasks/cancel(taskId)` resolved directly to a run row → cancel.

**After (current):**
- `taskId` is the `session_messages.id` — the per-execution row inside a session. The A2A protocol's single-message-per-task semantics align cleanly with the message grain.
- `MessageBackedTaskStore` is the new TaskStore implementation. It preserves the `lastWrittenStatus` dedupe optimization (~3 DB writes per message instead of ~200) and the same sanitized-error pattern.
- `tasks/cancel(taskId)` resolves `taskId` → `messageId` → parent `sessionId` → `cancelSession()`.
- A `contextId` carried by the A2A client is matched against `sessions.context_id`; a hit reuses the existing non-stopped session as a non-ephemeral session (multi-turn A2A). Without a `contextId`, the dispatcher creates a fresh `ephemeral: true` session.

**Agent Card metadata version bump to `v2`.**

Agent Card `metadata` now advertises `agentplane.taskIdMapping = "session_message_id"`. External clients that cached an Agent Card from before the cutover will see the new mapping after the next refresh (60s cache TTL, 5min recommended client-side recheck per spec). Clients that hold older `taskId` strings during the cutover window will receive 404 from `tasks/get(taskId)` because the underlying `runs` rows no longer exist; the migration is documented as a hard cut. SoulSpec metadata also stays at its existing `soulspec:identity:v2` channel — the version bump labelled here is specifically for the runs→messages mapping.

**Cutover-day client behavior:**
- In-flight `taskId`s held by external A2A clients at deploy time → 404 on the next `tasks/get`. Clients should retry by re-sending `message/send`. The single-message-per-task A2A model bounds the in-flight window, so this is a brief disruption.
- Agent Card cache (60s) means up to 1 minute of clients seeing the old metadata. Acceptable per the hard-cut policy.

---

## Action Items (Priority Order)

1. **Add `protocolVersion` and populate `skills` in `buildAgentCard()`** — required for spec compliance.
2. **Rename slug in Agent Card `url` to be agent-scoped** — decouple tenant slug from agent identity.
3. **Add `UNIQUE INDEX` on `tenants.slug`** and implement nanoid-suffix collision retry.
4. **Add reserved slug blocklist** to tenant/agent creation validation.
5. **Verify `.well-known` routes are not swallowed** by any Next.js rewrites in `next.config.ts`.
6. **Document idempotency window** for `A2A-Request-Id` deduplication.
7. **Track `tasks/list` support** in `@a2a-js/sdk` — implement when available.
8. **Plan per-agent URL migration** before any tenant has >1 A2A-enabled agent.
