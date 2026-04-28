---
title: 'refactor: Unify runs and sessions into a session-first execution model'
type: refactor
status: active
date: 2026-04-27
origin: docs/brainstorms/2026-04-27-runs-sessions-unification-requirements.md
---

# refactor: Unify runs and sessions into a session-first execution model

## Overview

Collapse AgentPlane's two parallel execution pipelines (`prepareRunExecution`+`finalizeRun` for one-shot runs, `session-executor.ts` for multi-turn sessions) into a single session-first model that mirrors the sister codebase at `~/code/agent-co`. After this plan ships:

- The `runs` table and `/api/runs*` endpoints are gone.
- Every execution is a session. "One-shot" is just `ephemeral: true`.
- Schedule, webhook, and A2A triggers all dispatch through one chokepoint.
- Admin UI is session-first (`/admin/sessions`, no `/admin/runs`).

Distinctive AgentPlane surface area — webhooks, public A2A, SoulSpec identity, plugin marketplace, dual runner — is preserved unchanged.

---

## Problem Frame

Two parallel execution pipelines duplicate sandbox provisioning, MCP config building, transcript persistence, billing, and cancellation logic. The split leaks into the public API (`/api/runs/*` vs `/api/sessions/*`) and the admin UI (`/admin/runs` vs the playground). The sister codebase agent-co was session-first from day one and has no equivalent split, so patterns and bug fixes do not port cleanly between the two repos. (See origin: `docs/brainstorms/2026-04-27-runs-sessions-unification-requirements.md`.)

---

## Requirements Trace

- R1. Sessions become the only execution unit; runs table + `/api/runs*` removed (hard cut).
- R2. Schema: `sessions` + `session_messages` (per-execution metadata on messages).
- R3. Lifecycle is per-trigger, not a single default. The cleanup cron uses a per-session `idle_ttl_seconds` that the dispatcher sets at creation time.
- R4. Trigger lifecycle: `api` and `webhook` and `a2a` (without contextId reuse) → `ephemeral: true`. `playground` and `chat` → persistent with 10-min idle TTL. `schedule` → persistent with 5-min idle TTL (short operator follow-up window; bounds idle-sandbox accumulation under cron drift). `a2a` with contextId hit → reuses the existing session, ephemeral=false. (See Trigger → ephemeral mapping table in High-Level Technical Design.)
- R5. A2A `taskId` = `session_message_id`.
- R6. Single dispatch chokepoint.
- R7. Cancel = abort current message AND stop sandbox.
- R8. In-session concurrency: 409 via atomic CAS.
- R9. Tenant cap: 50 concurrent active sessions (matches existing `MAX_CONCURRENT_RUNS = 50` in `src/lib/runs.ts` / `MAX_CONCURRENT_SESSIONS = 50` in `src/lib/sessions.ts`).
- R10. Per-message stream URL `/api/sessions/:id/messages/:msgId/stream`; session-level reconnect URL resolves to in-flight message.
- R11. Idempotency keys preserved on session + message POSTs.
- R12. `/admin/runs` removed; `/admin/sessions` is the new admin surface.
- R13. Existing run history dropped at cutover. (Orphan blob cleanup is a follow-up — see Deferred to Follow-Up Work.)

---

## Scope Boundaries

- HITL pause/resume, `thread_checkpoints`, `pending_runs` — agent-co has these; not in this transition.
- `is_orchestrator` / governance escalation / `run_audit_log`.
- Runner internals (Claude SDK / Vercel AI SDK ToolLoopAgent stay as-is).
- Historical run-row migration.
- A2A multi-turn `contextId` extension.

### Deferred to Follow-Up Work

- One-time orphan transcript blob cleanup script — must run pre-cutover or as part of cutover; see security risk in Risks table on public-blob URL persistence.
- Eventual single-runner consolidation once one of Claude SDK / AI SDK matures enough to drop the other.

---

## Context & Research

### Relevant Code and Patterns

- `src/lib/run-executor.ts` — current one-shot execution path (`prepareRunExecution`, `finalizeRun`).
- `src/lib/session-executor.ts` — current session per-message lifecycle.
- `src/lib/sessions.ts` — session state machine helpers (`creating`/`active`/`idle`/`stopped`).
- `src/lib/runs.ts` — run lifecycle helpers (`createRun`, budget + concurrency atomic checks).
- `src/lib/sandbox.ts` — Vercel Sandbox provisioning, dual-runner injection (Claude SDK preamble vs AI SDK preamble), skill/plugin/SoulSpec injection.
- `src/lib/streaming.ts` — NDJSON streaming, 15s heartbeats, 4.5min stream-detach.
- `src/lib/transcript-utils.ts` — `captureTranscript` async generator with truncation rules.
- `src/lib/a2a.ts` — `RunBackedTaskStore`, `SandboxAgentExecutor`, single-query A2A auth.
- `src/lib/mcp.ts`, `src/lib/mcp-connections.ts`, `src/lib/composio.ts` — MCP config builder, parallel token refresh.
- `src/lib/idempotency.ts` — idempotent request handling.
- `src/db/migrations/` — sequential SQL migrations 001-032; next is 033.
- `src/app/api/runs/`, `src/app/api/agents/[agentId]/runs/`, `src/app/api/sessions/` — current endpoints.
- `src/app/admin/(dashboard)/runs/`, `src/app/admin/(dashboard)/agents/[agentId]/playground/` — current admin UI.
- `src/app/api/cron/scheduled-runs/route.ts`, `src/app/api/webhooks/[sourceId]/route.ts` — internal trigger handlers.
- `src/app/api/cron/cleanup-sessions/route.ts`, `src/app/api/cron/cleanup-sandboxes/route.ts` — cron consolidation targets.

### Institutional Learnings

- `docs/solutions/logic-errors/transcript-capture-and-streaming-fixes.md` — the new dispatcher must preserve two truncation rules: (a) `result` and `error` events must survive the `MAX_TRANSCRIPT_EVENTS` cap so billing data is not lost; (b) `text_delta` events must NOT be stored in chunks. The previous run-executor refactor regressed both. Carry characterization tests forward into U2.

### External References

- Sister repo `~/code/agent-co`: migrations `001-init.sql`, `005-threads-and-runs.sql`. Single chokepoint signature: `dispatchNewRun({ companyId, agentId, agent, triggeredBy, rawPrompt, sessionId })` returning `{ runId, prompt }`.
- agent-co `app/api/sessions/route.ts` and `app/api/sessions/[sessionId]/messages/route.ts` for the session-first endpoint shape.

---

## Key Technical Decisions

- **Drop the `runs` table at cutover; no shim layer.** Tenants and admin UI are updated atomically with the migration. Zero deprecation window. (Per origin R1.)
- **Two-table schema (`sessions` + `session_messages`).** session_messages owns billing-grade fields (cost, tokens, transcript_blob_url, triggered_by, error_type, started_at, completed_at). Avoids JSONB scans for billing aggregates and keeps RLS policies focused.
- **Atomic CAS for in-session concurrency.** `UPDATE sessions SET status='active' WHERE id=$1 AND status='idle' RETURNING ...`. If 0 rows updated → `InSessionConflict` → 409.
- **`ephemeral` is a column on `sessions`.** Default `false`. When `true`, the dispatcher stops the sandbox synchronously after the message terminal event, before the stream closes.
- **A2A `taskId` is `session_message_id`, not `session_id`.** A2A protocol semantics are single-message-per-task; the message is the right grain. Internal A2A sessions are always ephemeral.
- **Cleanup consolidates into `/api/cron/cleanup-sessions`.** The orphan-sandbox sweep that lives in `cleanup-sandboxes` today merges in. `cleanup-sandboxes` is removable once orphans are exclusively tracked through `sessions.sandbox_id`.
- **Stream URLs become per-message.** `GET /api/sessions/:id/messages/:msgId/stream` is the canonical reconnect URL. `GET /api/sessions/:id/stream` is sugar that resolves to the in-flight message.
- **`triggered_by` lives on `session_messages`, not `sessions`.** A session can in principle mix triggers (chat + cancellation by API); recording trigger at the message grain matches billing/audit needs.

---

## Open Questions

### Resolved During Planning

- Tenant concurrency: 50 active sessions per tenant (matches existing `MAX_CONCURRENT_RUNS` and `MAX_CONCURRENT_SESSIONS`; CLAUDE.md's "10 concurrent runs" line was stale).
- Naming: `session_messages` (not `messages`, not `session_runs`) — disambiguates from chat-message terminology and signals "execution-level rows".
- `webhook_source_id` and `created_by_key_id` move from `runs` to `session_messages` (audit fields stay at message grain).

### Deferred to Implementation

- Exact RLS policy expressions for `session_messages` — write during U1, mirror existing `runs` RLS.
- Whether to rename the NDJSON `run_started` event to `message_started` or keep the wire-format string for SDK type-union backwards compat. Decide while wiring U2; default is to keep `run_started` as the wire string and document it as legacy naming.

---

## High-Level Technical Design

> *This illustrates the intended shape of the unified dispatcher and lifecycle. It is directional guidance for review, not implementation specification.*

### Single dispatch chokepoint

```text
dispatchSessionMessage({
  tenantId, agentId,
  sessionId?,        // undefined => create new session
  prompt,
  triggeredBy,       // 'api' | 'schedule' | 'webhook' | 'a2a' | 'playground' | 'chat'
  ephemeral?,        // default: false (persistent)
  idempotencyKey?,
  callerKeyId?,
})
  -> { sessionId, messageId, stream: AsyncIterable<TranscriptEvent> }

// Caller-side flow inside dispatchSessionMessage:
//   resolveOrCreateSession()       -- session row, idempotency check
//   atomicIdleToActive()           -- CAS, 409 on conflict
//   reserveBudgetAndConcurrency()  -- transactional cap check
//   appendSessionMessage()         -- 'running' state, triggered_by, callerKeyId
//   ensureSandbox()                -- snapshot or reconnect, skill+plugin+identity injection
//   buildMcpConfig()               -- Composio + custom MCP, parallel token refresh
//   spawnRunnerForMessage()        -- per-message runner-<msgId>.mjs, runner select
//   streamAndCapture()             -- NDJSON tap, asset persist, transcript capture
//   finalizeMessage()              -- billing, status, blob URL, idle/stop sandbox
```

### Lifecycle states (single state machine)

```text
sessions.status
  creating  -- (sandbox boot ok) -------------> active
  active    -- (msg done, ephemeral=true) ----> stopped
  active    -- (msg done, ephemeral=false) ---> idle
  idle      -- (new message arrives) ---------> active
  idle      -- (cleanup cron, > idle TTL) ----> stopped
  any       -- (cancel) ----------------------> stopped
```

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

---

## Implementation Units

- U1. **Schema migration: drop runs and old sessions, create unified schema**

**Goal:** Replace the `runs` table and the existing two-purpose `sessions` table with a clean `sessions` + `session_messages` pair.

**Requirements:** R1, R2, R13

**Dependencies:** None.

**Files:**
- Create: `src/db/migrations/033_runs_sessions_unify.sql`
- Modify: `src/lib/validation.ts` (drop `RunRow`, add `SessionRow` + `SessionMessageRow` Zod schemas)
- Modify: `src/lib/types.ts` (drop `RunId` branded type; keep `SessionId`; add `SessionMessageId`)
- Test: `tests/unit/db/sessions-schema.test.ts`

**Approach:**
- **Pre-flight (before writing the migration SQL):** enumerate every FK that points INTO `runs.id` and every FK that points INTO the existing `sessions.id`. Known references include `webhook_deliveries.run_id` (per CLAUDE.md "duplicate replays return 200 with the original `run_id`"). Each FK must be explicitly addressed in the migration — either retargeted to `session_messages.id` (e.g., `webhook_deliveries.run_id → message_id`) or dropped intentionally. `DROP TABLE ... CASCADE` is forbidden — replace with explicit per-FK drops + retargets.
- Migration in a single transaction:
  1. `ALTER TABLE webhook_deliveries DROP CONSTRAINT <runs_fk>; ALTER TABLE webhook_deliveries RENAME COLUMN run_id TO message_id; -- FK re-added in step 5 against session_messages`
  2. (Repeat for every other table whose FK points at `runs.id` — enumerate via `\d+ runs` first.)
  3. `DROP TABLE runs;` (no CASCADE)
  4. `DROP TABLE sessions;` (no CASCADE)
  5. `CREATE TABLE sessions (id, tenant_id, agent_id, status enum (creating|active|idle|stopped), sandbox_id, sdk_session_id, session_blob_url, ephemeral bool default false, idle_ttl_seconds int default 600, expires_at timestamptz NOT NULL, context_id text, message_count int default 0, idle_since timestamptz, last_backup_at timestamptz, created_at, updated_at)` with RLS policy keyed on `app.current_tenant_id`, indexes on `(tenant_id, status)`, `(tenant_id, agent_id, created_at DESC)`, `(tenant_id, status, expires_at)` for cleanup-cron, and a partial unique index on `(tenant_id, agent_id, context_id) WHERE status NOT IN ('stopped') AND context_id IS NOT NULL` for A2A reuse lookup (mirroring migration 027's existing predicate; do NOT drop the `status NOT IN ('stopped')` filter). `context_id` preserves the existing A2A multi-turn-via-contextId behavior. `idle_ttl_seconds` is set by the dispatcher per the trigger table; the column is server-set only — admin UI and tenant API never accept it as input, CHECK constraint caps at 3600. `expires_at` is `created_at + INTERVAL '4 hours'` set on insert; cleanup cron stops any session past `expires_at` regardless of `idle_ttl_seconds`. Caps the contextId-reuse warm-sandbox attack window to 4h wall-clock (DoS bound).
  6. `CREATE TABLE session_messages (id, session_id FK ON DELETE CASCADE, tenant_id, prompt text, transcript_blob_url, status enum (queued|running|completed|failed|cancelled|timed_out), triggered_by enum (api|schedule|playground|chat|a2a|webhook), error_type, error_messages text[], cost_usd numeric, total_input_tokens int, total_output_tokens int, num_turns int, duration_ms int, runner enum (claude-agent-sdk|vercel-ai-sdk), webhook_source_id FK, created_by_key_id FK api_keys, started_at, completed_at, created_at)` with RLS, indexes on `(tenant_id, created_at DESC)`, `(session_id, created_at)`, `(tenant_id, status)`.
  7. `ALTER TABLE webhook_deliveries ADD CONSTRAINT <message_fk> FOREIGN KEY (message_id) REFERENCES session_messages(id) ON DELETE CASCADE;` (and likewise for any other retargeted FKs).
- Tenant concurrency cap (50 active sessions) is enforced in code (no schema column needed).
- Sandboxes are tracked exclusively via `sessions.sandbox_id`; this enables U6's cleanup consolidation.

**Patterns to follow:**
- RLS pattern from existing migrations under `src/db/migrations/` (e.g. session/run RLS with `NULLIF(current_setting('app.current_tenant_id', true), '')`).
- Branded ID pattern from `src/lib/types.ts`.
- Migration runner: `npm run migrate` invokes `src/db/migrate.ts`.

**Test scenarios:**
- Happy path: migration applies cleanly to a fresh DB; both tables exist with expected columns and indexes.
- Edge case: migration applies cleanly when `runs` and old `sessions` tables already exist with data (data is intentionally dropped).
- Integration: RLS prevents cross-tenant SELECT on `sessions` when `app.current_tenant_id` is set to a different tenant.
- Integration: RLS prevents cross-tenant SELECT on `session_messages` when `app.current_tenant_id` is set to a different tenant — separate explicit test, not implied by the sessions test (this table holds billing-grade fields and prompt text).
- Integration: deleting a `sessions` row cascades to its `session_messages` rows.
- Integration: `session_messages.session_id` FK enforces existence.
- Integration: `webhook_deliveries.message_id` FK retarget works — pre-migration `run_id` rows are renamed cleanly; new FK references `session_messages(id)`.
- Edge case: state transitions allowed by application code map cleanly (`creating→active`, `active→idle`, `active→stopped`, `idle→active`, `idle→stopped`).
- Pre-flight: FK enumeration query (`SELECT conrelid::regclass, conname FROM pg_constraint WHERE confrelid = 'runs'::regclass`) returns expected set; no surprises.

**Verification:**
- `npm run migrate` succeeds on a clean schema and on a schema with the old `runs`/`sessions` tables present.
- Old `runs` and old `sessions` tables no longer exist.
- New `sessions` and `session_messages` have RLS enabled and the expected columns/indexes.

---

- U2. **Single dispatch chokepoint replacing run-executor and session-executor**

**Goal:** One function — `dispatchSessionMessage()` — handles every execution: ephemeral or persistent, new session or follow-up, any trigger.

**Requirements:** R3, R4, R6, R7, R8, R9

**Dependencies:** U1.

**Files:**
- Create: `src/lib/dispatcher.ts`
- Modify: `src/lib/sessions.ts` (state transitions, atomic CAS, `ephemeral` column wiring)
- Modify: `src/lib/sandbox.ts` (single per-message runner spawn path; remove run-vs-session branching)
- Modify: `src/lib/streaming.ts` (per-message stream identifiers; `stream_detached` carries `messageId`)
- Modify: `src/lib/transcript-utils.ts` (preserve truncation + text_delta filter rules)
- Rename: `src/lib/runs.ts` → `src/lib/session-messages.ts`; retarget budget + concurrency helpers to sessions
- Delete: `src/lib/run-executor.ts`
- Delete: `src/lib/session-executor.ts`
- Test: `tests/unit/dispatcher.test.ts`
- Test: `tests/unit/sessions/cas.test.ts`
- Test: `tests/unit/transcript-truncation.test.ts` (keep, retarget at dispatcher)

**Approach:**
- `dispatchSessionMessage` is the only public entry point for executing an agent. Every caller (route, cron, webhook, A2A executor) goes through it.
- Inside the function:
  1. `withTenantTransaction`: resolve session (create or load), idempotency check, atomic CAS `idle→active`, budget reserve, concurrency check, append `session_messages` row in `running`.
  2. Outside the transaction: `ensureSandbox` (snapshot or reconnect), `buildMcpConfig` (parallel token refresh via `Promise.allSettled`), inject skill+plugin+identity files, spawn per-message runner script.
  3. Stream NDJSON: tap the runner output, persist Composio/Firecrawl asset URLs to Vercel Blob, pipe events out, capture transcript with the truncation rules from the institutional learning.
  4. On terminal event: `finalizeMessage` (write transcript blob, write billing, mark message status). Then transition the session: `idle` if persistent, `stopped` if ephemeral. Ephemeral stop happens synchronously before the stream closes for short executions. **Detach case (>4.5min):** the route handler will have detached and returned before the runner finishes. To preserve the ephemeral guarantee, the runner-side flow on terminal event is: (a) POST final transcript to `/api/internal/messages/:messageId/transcript`, (b) the internal-upload endpoint authoritatively stops the sandbox per the rules below.

  **Internal-upload sandbox-stop authorization (must be implemented exactly):**
  1. Verify the bearer token's `messageId` claim matches the URL parameter (already specified).
  2. Load the parent session via `SELECT id, tenant_id, sandbox_id, ephemeral, status FROM sessions WHERE id = (SELECT session_id FROM session_messages WHERE id = $messageId)` inside the transaction.
  3. Refuse to stop unless `session.ephemeral = true`. (A persistent session must NOT be stoppable through this path — even a compromised runner inside an ephemeral sandbox cannot stop a different persistent sandbox via a stolen messageId.)
  4. Stop is gated by an atomic CAS: `UPDATE sessions SET status='stopped' WHERE id=$1 AND status NOT IN ('stopped') AND ephemeral=true RETURNING sandbox_id`. If 0 rows updated → already stopped → idempotent no-op (do not re-call sandbox API). If sandbox_id returned, call sandbox-stop once.
  5. Runner retries (re-upload of the same transcript) hit the CAS-already-stopped path and skip; sandbox API is called at most once per session.

  This puts the ephemeral-stop responsibility on the internal-upload endpoint when the request context has detached, while ensuring a stolen or stale messageId token cannot stop a sandbox other than the one bound to that ephemeral session.
- **Preserve existing billing rollup:** the current terminal write in `src/lib/runs.ts::transitionRunStatus` (lines ~192-211) increments `tenants.current_month_spend += cost_usd` and emits cost-anomaly logs against `expectedMaxBudgetUsd`. `finalizeMessage` MUST carry this write forward in the same transaction as the message-status update, otherwise monthly budget enforcement breaks silently.
- **Preserve subscription-token bypass:** `src/lib/runs.ts::checkTenantBudget` (lines ~33-56) bypasses budget when `subscription_token_enc IS NOT NULL` AND `supportsClaudeRunner(agent.model)`. The dispatcher's `assertBudgetWithinCap` MUST keep the same `isSubscriptionRun` gate, otherwise Claude Pro tenants start hitting caps they are exempt from today.
- **Skip session-file backup for ephemeral sessions:** today every successful message backs up the SDK session JSON to Vercel Blob via `backupSessionFile`. Ephemeral sessions stop immediately after one message — backup is wasted I/O and storage churn (especially under high-frequency webhook / schedule firing). When `session.ephemeral=true`, skip the backup entirely. Persistent sessions back up as today.
- Cancellation: `cancelSession(sessionId)` aborts the in-flight runner (existing pattern), writes `cancelled` to the active message, transitions session to `stopped`, kills the sandbox. Cancel is also accepted while the session is `creating` — sandbox-boot is aborted, half-booted sandbox (if any) is cleaned up by the next cron tick, message marked `cancelled`. Cancel on a session already `stopped` is an idempotent no-op.
- Concurrency: `assertActiveSessionsBelowCap(tenantId, 50)` inside the transaction, fail-fast with typed `ConcurrencyExceededError`. The cap counts only `status IN ('creating', 'active')` — `idle` does NOT count toward the cap; idle sessions are free until cleanup. The check must use a single SQL statement that both reads count and inserts atomically (e.g., `INSERT ... WHERE (SELECT count(*) FROM sessions WHERE tenant_id=$1 AND status IN ('creating','active')) < 50`) to avoid the TOCTOU race that was explicitly fixed for the runs cap. Mirror the existing pattern in `src/lib/runs.ts`.

**Execution note:** Test-first for state-machine + CAS semantics; keep the existing `transcript-truncation.test.ts` passing against the dispatcher before deleting `run-executor.ts`.

**Technical design:** *(directional — see High-Level Technical Design above for the full sketch.)*

**Patterns to follow:**
- `withTenantTransaction` from `src/db/index.ts`.
- Atomic SQL guards from current `src/lib/runs.ts` (concurrent run check pattern, JSONB array mutations).
- Streaming + heartbeat pattern from `src/lib/streaming.ts`.
- Asset URL persistence from `src/lib/assets.ts`.
- Transcript truncation rules from `docs/solutions/logic-errors/transcript-capture-and-streaming-fixes.md`.
- Per-message runner script approach from current `src/lib/session-executor.ts`.

**Test scenarios:**
- Covers AE1. Happy path (persistent): new session, single message → `result` event, session ends `idle`, sandbox warm.
- Covers AE3 / AE4 / AE5. Happy path (ephemeral): same flow with `ephemeral: true` → session ends `stopped`, sandbox killed before stream closes.
- Edge case: follow-up message on `idle` session → CAS succeeds, runner reuses sandbox, session returns to `idle` after.
- Covers AE2. Edge case: concurrent message on `active` session → 409 `InSessionConflict`, no message row inserted, session stays `active` for the original message.
- Covers AE6. Edge case: cancel during in-flight → message status `cancelled`, session `stopped`, sandbox killed, transcript persisted.
- Edge case: cancel after message already finalized → idempotent no-op.
- Error path: budget exceeded → typed error, no session row created, no concurrency reservation.
- Error path: 11th active session for tenant → typed error 429.
- Error path: idempotency key replay → returns same `messageId` / `sessionId`, no duplicate runner spawn.
- Error path: transcript truncation at `MAX_TRANSCRIPT_EVENTS` still preserves `result` and `error` events. (Per institutional learning.)
- Error path: `text_delta` events excluded from chunks array. (Per institutional learning.)
- Integration: `triggered_by` on the message row matches caller-supplied value.
- Integration: A2A callback bridge env vars still flow into the runner subprocess.

**Verification:**
- `src/lib/run-executor.ts` and `src/lib/session-executor.ts` are gone.
- All execution paths trace through `dispatchSessionMessage`.
- Existing transcript-truncation tests still pass against the dispatcher.

---

- U3. **API surface: new sessions endpoints, drop /api/runs**

**Goal:** Public + admin REST surface aligned to sessions only.

**Requirements:** R1, R6, R7, R10, R11, R12

**Dependencies:** U2.

**Files:**
- Create / modify: `src/app/api/sessions/route.ts` (POST: create + optional first message)
- Modify: `src/app/api/sessions/[sessionId]/route.ts` (GET, DELETE)
- Modify: `src/app/api/sessions/[sessionId]/messages/route.ts` (POST: send next message, GET: list)
- Create: `src/app/api/sessions/[sessionId]/messages/[messageId]/route.ts` (GET)
- Create: `src/app/api/sessions/[sessionId]/messages/[messageId]/stream/route.ts`
- Create: `src/app/api/sessions/[sessionId]/stream/route.ts` (resolves to in-flight message)
- Create: `src/app/api/sessions/[sessionId]/cancel/route.ts`
- Delete: `src/app/api/runs/`, `src/app/api/agents/[agentId]/runs/`, all sub-routes (`cancel`, `stream`, `transcript`)
- Move: `src/app/api/internal/runs/[runId]/transcript/route.ts` → `src/app/api/internal/messages/[messageId]/transcript/route.ts`
- Modify: `src/lib/sandbox.ts` — runner-script template emits the internal-upload URL + bearer; both the URL path (now `/messages/:messageId`) and the token-minting helper (`generateRunToken` → `generateMessageToken`) must change. The runner script and the new endpoint must agree.
- Modify: `src/lib/runners/vercel-ai-shared.ts` — the AI SDK runner embeds the same internal-upload URL; same change applies.
- Modify: `src/lib/a2a.ts` — `SandboxAgentExecutor` mints `generateRunToken` directly (current code, two call sites for first-message and reuse paths); these must switch to `generateMessageToken(messageId)`. (Listed here in addition to U4 because the change is part of the token-surface unification.)
- Modify: `src/lib/crypto.ts` (or wherever `generateRunToken` lives) — add `generateMessageToken(messageId)` and corresponding verifier.
- Modify: `src/middleware.ts` (route matchers)
- Modify: `vercel.json` (`supportsCancellation` paths under `app/api/sessions/**`; remove `app/api/runs/**`)
- Modify: matching admin variants under `src/app/api/admin/sessions/`, `src/app/api/admin/runs/` (delete) — admin variants are thin wrappers
- Test: `tests/integration/api-sessions.test.ts`
- Test: `tests/integration/api-runs-removed.test.ts`
- Test: `tests/unit/internal-token.test.ts` (token bound to messageId; rejected for mismatched URL param)

**Approach:**
- Public POST `/api/sessions` accepts `{ agent_id, prompt?, ephemeral?, idempotency_key? }` and returns either `{ session_id }` (no prompt) or `{ session_id, message_id }` plus the NDJSON stream when prompt is provided.
- POST `/api/sessions/:id/messages` accepts `{ prompt, idempotency_key? }`, returns `{ message_id }` + NDJSON stream.
- POST `/api/sessions/:id/cancel` returns 204; aborts in-flight + stops sandbox.
- GET `/api/sessions/:id/messages/:msgId/stream?offset=N` reconnects to the in-flight runner using the existing offset pattern.
- GET `/api/sessions/:id/stream` resolves to the in-flight message; if none, returns 409 with hint to query messages list.
- Internal upload-transcript endpoint moves from run-scoped to message-scoped bearer token. The token MUST carry a bound `messageId` claim verified server-side against the URL parameter on every request — a token minted for message A must not be accepted on the URL for message B, even from a sandbox owned by the same tenant. Mirror the existing run-scoped binding pattern.
- **`triggered_by` derivation from auth context:** the route handler sets `triggered_by` based on which auth path resolved the request: admin JWT cookie + first message on a session → `'playground'`; admin JWT cookie + subsequent messages on the same session → `'chat'`; tenant API key → `'api'`. Schedule, webhook, and A2A paths set their own `triggered_by` explicitly in U4.

**Patterns to follow:**
- `withErrorHandler` + `jsonResponse` from `src/lib/api.ts`.
- Route auth from `src/lib/auth.ts`; admin auth from `src/lib/admin-auth.ts`.
- Streaming + cancel pattern from existing sessions routes.
- Idempotency from `src/lib/idempotency.ts`.

**Test scenarios:**
- Covers AE1. Happy path: POST `/api/sessions` with prompt → 200 + NDJSON ending in `result`.
- Happy path: POST `/api/sessions/:id/messages` after first finishes → 200 + NDJSON.
- Covers AE2. Error path: POST `/api/sessions/:id/messages` while previous active → 409.
- Covers AE7. Error path: POST `/api/runs` → 404 (route gone).
- Error path: GET `/api/sessions/:id` for another tenant → 404 (RLS).
- Edge case: idempotency replay on POST `/api/sessions` returns same ids without spawning a second sandbox.
- Covers AE6. Integration: cancel endpoint stops the sandbox + closes stream within ~1s.
- Integration: stream reconnect with `?offset=N` resumes from the right event.
- Integration: internal transcript upload from sandbox uses the new message-scoped URL and bearer token.

**Verification:**
- `/api/runs*` returns 404 in routing.
- New sessions endpoints stream NDJSON identically to existing playground.
- Internal transcript upload from sandbox uses the new URL.

---

- U4. **Internal triggers (schedule, webhook, A2A) dispatch through sessions**

**Goal:** Schedule cron, webhook delivery, and A2A executor all go through `dispatchSessionMessage` with `ephemeral: true`.

**Requirements:** R4, R5

**Dependencies:** U2.

**Files:**
- Modify: `src/app/api/cron/scheduled-runs/route.ts` (claim + dispatch via dispatcher)
- Modify: `src/app/api/webhooks/[sourceId]/route.ts` (dispatch instead of `createRun`)
- Modify: `src/lib/a2a.ts` (`SandboxAgentExecutor` calls dispatcher; rename `RunBackedTaskStore` → `MessageBackedTaskStore`, taskId = `session_message_id`)
- Modify: `src/app/api/a2a/[slug]/jsonrpc/route.ts` (taskId / contextId mapping updates)
- Modify: any remaining callers of `createRun` from `src/lib/runs.ts` → `dispatchSessionMessage`
- Test: `tests/integration/triggers-dispatch.test.ts`
- Test: `tests/integration/a2a-task-mapping.test.ts`

**Approach:**
- Schedule cron: minute-tick claims due agents (existing `FOR UPDATE SKIP LOCKED` query), then for each, calls `dispatchSessionMessage({ triggeredBy: 'schedule', ephemeral: true, prompt: agent.schedule_prompt, callerKeyId: null })`. Existing `last_run_at` / `next_run_at` writes stay unchanged.
- Webhook delivery: after HMAC verify + `webhook_deliveries` idempotent insert, render the prompt template (existing path), then call dispatcher with `triggeredBy: 'webhook', ephemeral: true, callerKeyId: null`. Pass `webhook_source_id` through to the message row.
- A2A: `SandboxAgentExecutor.execute` first looks up `findSessionByContextId(tenantId, contextId)` if the request carries a `contextId`. If a non-stopped session is found, reuse it (`ephemeral: false`, append a new message to the active session). Otherwise create a fresh session with `triggeredBy: 'a2a', ephemeral: true, callerKeyId: a2aKeyId`. The returned `messageId` becomes the A2A `taskId`. `MessageBackedTaskStore` saves status updates by `messageId` (preserving the existing dedupe-by-`lastWrittenStatus` optimization). This preserves A2A multi-turn-via-contextId behavior — only fresh A2A messages without contextId default ephemeral.
- A2A `tasks/cancel` maps `taskId` → `messageId` → resolves the parent `sessionId` → `cancelSession`.

**Patterns to follow:**
- `Promise.allSettled` for parallel cold-start work.
- Status-change deduplication from current `RunBackedTaskStore.save` (preserve the `lastWrittenStatus` tracking).
- Webhook idempotent insert pattern from `webhook_deliveries` (`ON CONFLICT (source_id, delivery_id) DO NOTHING`).
- A2A error sanitization from current `RunBackedTaskStore` (catch all, throw `A2AError.internalError()`).

**Test scenarios:**
- Covers AE3. Happy path: schedule tick claims an agent, creates an ephemeral session, runs to terminal, sandbox stops.
- Covers AE4. Happy path: webhook delivery POSTs valid HMAC → ephemeral session created, runs to terminal.
- Covers AE5. Happy path: A2A `message/send` returns `taskId` matching new `session_message_id`; `tasks/get(taskId)` returns terminal status.
- Edge case: A2A cancel during in-flight aborts message + stops session sandbox.
- Edge case: webhook duplicate delivery (same `delivery_id`) returns the original `message_id`, does not double-dispatch.
- Edge case: schedule cron tick where tenant is at concurrency cap → message is skipped or marked `failed` with typed error; no orphan session created.
- Error path: A2A budget enforcement still rejects when tenant cap exceeded inside the dispatcher transaction (no session row created, A2A error returned with sanitized message).
- Integration: `session_messages.triggered_by` matches the trigger source for each path (`schedule` / `webhook` / `a2a`).
- Integration: `session_messages.webhook_source_id` is set for webhook-triggered messages, NULL otherwise.
- Integration: A2A `MessageBackedTaskStore.save` writes only on status changes (deduplication preserved).

**Verification:**
- All four trigger sources visibly land as ephemeral sessions in the new schema.
- `RunBackedTaskStore` is removed; `MessageBackedTaskStore` is the only A2A bridge.
- A2A Agent Card metadata mentions the new task-id mapping.

---

- U5. **Admin UI: /admin/sessions replaces /admin/runs**

**Goal:** Admin operators see a session-first list and detail view; the playground sends to the new endpoints.

**Requirements:** R12

**Dependencies:** U3.

**Files:**
- Create: `src/app/admin/(dashboard)/sessions/page.tsx`
- Create: `src/app/admin/(dashboard)/sessions/[sessionId]/page.tsx`
- Create: `src/app/admin/(dashboard)/sessions/[sessionId]/live-session-detail.tsx`
- Create: `src/app/admin/(dashboard)/sessions/[sessionId]/cancel-session-button.tsx`
- Modify: `src/components/transcript-viewer.tsx` (no changes expected; already shared, just verify imports)
- Modify: `src/app/admin/(dashboard)/agents/[agentId]/playground/page.tsx` (point at new endpoints, mostly already does)
- Modify: `src/app/admin/(dashboard)/page.tsx` (overview charts: `runs/day` → `executions/day`; cost chart sources from `session_messages.cost_usd`. "Executions" disambiguates from chat/A2A messages — one execution = one `session_messages` row.)
- Modify: `src/components/layout/top-bar.tsx` and any nav config (Runs → Sessions)
- Modify: `src/components/ui/run-source-badge.tsx` → rename to `message-source-badge.tsx` (single file rename + import updates)
- Delete: `src/app/admin/(dashboard)/runs/` (entire directory)
- Modify: `src/app/api/admin/runs/` → delete; new admin variants under `src/app/api/admin/sessions/` are thin wrappers
- Test: `tests/integration/admin-sessions.test.ts`

**Approach:**
- List view shows: agent, status (with ephemeral folded into the status badge as `stopped (ephemeral)` when applicable), message_count, total cost (sum across messages via subquery or materialized aggregate), latest activity (= max `session_messages.completed_at`, fallback `sessions.updated_at`), latest trigger. Sortable on created_at (default DESC), latest activity, total cost. Filterable by agent, status, trigger. Same line-style tabs and `MetricCard` styling as today.
- Empty state: when the tenant has zero sessions, render an `Empty` panel with copy "No sessions yet — try the agent playground or wait for a scheduled run."
- Loading: server component with React Suspense; show a 4-row skeleton matching the row layout. Mirrors existing admin pages.
- Detail view: session metadata header (sandbox_id, sdk_session_id, ephemeral, status), then a scrollable list of `session_messages`, each rendered as a collapsed accordion with the message-source badge + start time + status. The most recent message is auto-expanded by default; older messages stay collapsed. Inside the expanded accordion, the existing `TranscriptViewer` renders. Pagination kicks in at 50+ messages with "Load older" affordance.
- `creating` state: detail page shows "Sandbox starting..." placeholder where the message list would be. No accordion until the first message exists.
- Cancel button: visible only when `status IN ('creating', 'active', 'idle')`. While cancel is in-flight, button shows a spinner + "Stopping..." label, disabled. After cancel resolves, button hides; status badge transitions to `stopped`. Hidden entirely on terminal sessions.
- Live streaming: the detail page subscribes to `GET /api/sessions/:id/stream` (resolves to in-flight message). When a session has no in-flight message (e.g., currently `idle`), the page does NOT subscribe; reload after a new message starts.
- "Latest trigger" badge: shows the trigger of the most recent `session_messages` row (typical case: a session is single-trigger). For mixed-trigger sessions, the list view shows the latest only; the detail view shows each message's own badge.
- Playground exit linkage: after a playground run completes, the playground UI shows a "View session" link that navigates to `/admin/sessions/:sessionId`. Clicking opens the detail page in the same tab.
- Charts on dashboard: cost/day per agent (read from `session_messages.cost_usd` aggregated by `date_trunc('day', completed_at)`), executions/day per agent ("execution" = one `session_messages` row, disambiguated from chat/A2A messages). Empty days render as "No activity in this period" rather than a flat zero line.

**Patterns to follow:**
- Existing `live-run-detail.tsx` + `cancel-run-button.tsx` patterns, retargeted to sessions.
- Admin auth + JWT cookie from `src/lib/admin-auth.ts`.
- `MetricCard`, `DetailPageHeader`, line-style tabs.

**Test scenarios:**
- Happy path: list renders sessions with correct status badges, sortable by `created_at`.
- Covers AE8. Happy path: detail page renders messages in chronological order with transcripts.
- Edge case: session with zero messages still renders gracefully.
- Edge case: cancel button is disabled on terminal sessions (`stopped`).
- Integration: clicking cancel on an `active` session drives session to `stopped`, stream closes in UI.
- Integration: dashboard charts render messages/day correctly across multi-day spans.
- Integration: playground submits to new sessions endpoints and renders streamed events.

**Verification:**
- `/admin/runs` is gone from nav and 404s.
- All existing run-related admin functionality (filters, transcript viewer, cancel) is reachable via session views.
- Playground continues to work end-to-end on the new endpoints.

---

- U6. **Cron consolidation: cleanup-sessions absorbs cleanup-sandboxes**

**Goal:** A single cleanup cron handles all idle-stop, watchdog, and orphan-sandbox cases.

**Requirements:** R3, R4

**Dependencies:** U2.

**Files:**
- Modify: `src/app/api/cron/cleanup-sessions/route.ts` (expand scope)
- Modify: `src/lib/sessions.ts` — `getIdleSessions` signature changes from `(maxIdleMinutes: number)` (single global TTL) to `()` reading the new per-session `sessions.idle_ttl_seconds` column (`WHERE status='idle' AND idle_since < NOW() - INTERVAL '1 second' * idle_ttl_seconds`). `getStuckSessions` watchdog thresholds (5min creating, 30min active) likewise live here; verify or update.
- Delete: `src/app/api/cron/cleanup-sandboxes/route.ts`
- Modify: `vercel.json` (cron schedule entries)
- Test: `tests/integration/cleanup-cron.test.ts`

**Approach:**
- One job, every 5 minutes:
  - Sessions past `expires_at` (4h wall-clock cap, regardless of idle/active state) → stop sandbox, transition to `stopped`. Bounds the contextId-reuse warm-sandbox attack surface.
  - Sessions in `idle` past their per-session `idle_ttl_seconds` (default 600s; 300s for schedule-triggered sessions) → stop sandbox, transition to `stopped`. Use atomic CAS to avoid racing the dispatcher's `idle→active`.
  - Sessions in `creating` for >5 min → watchdog, transition to `stopped`, mark in-flight message `failed`.
  - Sessions in `active` for >30 min → watchdog (runner died silently), transition to `stopped`, mark message `timed_out`.
  - Orphan sandboxes (any sandbox not associated with a `sessions` row) → stop.

**Patterns to follow:**
- Existing cleanup-sessions logic.
- Cron auth from `src/lib/cron-auth.ts`.
- Batch UPDATE pattern from existing scheduled-runs cron (avoid N+1 UPDATEs — see institutional learning).

**Test scenarios:**
- Happy path: an `idle` session past TTL is transitioned to `stopped`, sandbox API called once.
- Edge case: `creating` session past 5-min watchdog → `stopped`, message marked `failed`.
- Edge case: `active` session past 30-min watchdog → `stopped`, message marked `timed_out`.
- Integration: orphan sandbox without a row in `sessions` is stopped.
- Integration: ephemeral sessions already `stopped` immediately at message end are not double-processed.
- Edge case: race between cleanup `idle→stopped` and dispatcher `idle→active` — if cleanup wins, behavior depends on the caller path:
  - **Public route `POST /api/sessions/[sessionId]/messages`**: returns 410 Gone with body `{error: 'session_stopped', hint: 'create a new session via POST /api/sessions'}`. The URL names a specific session, so silently swapping it would corrupt client state.
  - **Internal callers** (schedule cron, webhook handler, A2A executor) that pass `sessionId?` optionally to the dispatcher: dispatcher transparently creates a fresh session for the same agent and proceeds. Caller never sees the race.

**Verification:**
- `src/app/api/cron/cleanup-sandboxes/` is removed from the codebase and absent from `vercel.json`.
- `/api/cron/cleanup-sessions` log shows orphan-sandbox handling on each tick.

---

- U7. **Documentation, env, and Vercel config sync**

**Goal:** `CLAUDE.md`, public docs, type exports, and Vercel function config reflect the new model.

**Requirements:** Operational hygiene across R1–R13.

**Dependencies:** U1–U6.

**Files:**
- Modify: `CLAUDE.md` (replace runs-vs-sessions sections with the unified model; new endpoint list; updated execution flows; add the trigger → ephemeral mapping table)
- Modify: `vercel.json` (`supportsCancellation` paths under `app/api/sessions/**`; remove old `app/api/runs/**`)
- Modify: any public/SDK type exports — search for `Run`, `RunRow`, `RunId` exports, rename or remove
- Modify: `scripts/create-tenant.ts`, `scripts/create-api-key.ts` (no schema reference changes expected; verify)
- Modify: `README.md` if it references runs
- Modify: `docs/best-practices-a2a-routing-slugs.md` (note taskId mapping change, A2A Agent Card metadata version bump)

**Approach:**
- Search-and-resolve for all references to `runs`, `run_id`, `RunId`, `RunRow`, `/api/runs`. Each gets renamed, repointed at sessions, or removed.
- CLAUDE.md execution-flow sections become a single "execution flow" with the trigger → ephemeral mapping table from this plan.

**Test expectation:** none — documentation + config alignment, no behavioral change. The behavioral guarantee is that no test references a removed file/symbol after this unit lands; the implicit verification is `grep` + a clean build.

**Verification:**
- `grep -r "/api/runs" src` returns nothing executable.
- `CLAUDE.md` describes only the new model.
- Vercel build succeeds with updated function config.

---

## System-Wide Impact

- **Interaction graph:** `dispatcher.ts` is the entry point for every NEW execution (create + append message). Every trigger handler — public REST routes, schedule cron, webhook delivery, A2A executor — imports from there. Session-state mutation outside of execution (cancel, idle-cleanup, stuck-watchdog) flows through `cancelSession()` and the cleanup cron; these are unified into single helpers as well, but they are distinct from `dispatcher.ts`. SDK runner injection / MCP config / asset persistence move to per-message scope.
- **Error propagation:** Typed errors from the dispatcher transaction (`BudgetExceeded`, `ConcurrencyExceeded`, `InSessionConflict`) are surfaced as 4xx in routes; runner errors stream as `error` NDJSON events and persist on the message row. Sandbox-down errors during persistent idle are caught by the cleanup cron.
- **State lifecycle risks:** The `idle→active` CAS is the load-bearing concurrency gate. Race between a new message and the cleanup cron transitioning `idle→stopped` resolves at the row-lock level; both queries use `UPDATE ... WHERE status=...` with no shared locks. Add a single retry on serialization-failure as defense-in-depth.
- **API surface parity:** Public REST, internal cron + webhook + A2A executors, admin UI, and SDK switch in lockstep at cutover. There is no dual-stack period.
- **Integration coverage:** Per-message runner injection, transcript blob upload race (`allowOverwrite=true` preserved), Composio asset URL persistence, A2A bridge env propagation, idempotency replay — each requires an integration test, not just a unit test.
- **Unchanged invariants:** Runner internals (Claude SDK / AI SDK), sandbox snapshot strategy, MCP OAuth token refresh, plugin / skill / SoulSpec injection paths, webhook HMAC signing, A2A JSON-RPC envelope, NDJSON wire format, idempotency-key semantics, RLS enforcement model.

---

## Risks & Dependencies

| Risk | Mitigation |
|---|---|
| Hard cut means any external API consumer of `/api/runs` breaks at deploy. | AgentPlane is pre-production at the time of this plan, so external API consumers are not a concern. Hard cut is acceptable. (Vercel rolling deploys produce a brief mixed-shape window for in-flight cron / webhook / A2A — accepted as part of the pre-prod hard cut.) |
| Transcript truncation rules silently regress when the executor is rewritten (per the institutional learning). | U2 carries an explicit characterization-test execution note. Existing transcript-truncation test must pass against the new dispatcher before deletion of `run-executor.ts`. |
| `idle→active` CAS deadlocks with cleanup cron on the same row. | Both queries use `UPDATE ... WHERE status=...` with no shared locks; PG row-level lock orders them naturally. Add a retry on serialization-failure as defense-in-depth. |
| Drops of orphaned transcript blobs leave Vercel Blob storage uncleaned. | One-time blob cleanup is a follow-up item (already in Scope Boundaries). Acceptable transient orphan cost. |
| A2A `taskId` change breaks any external A2A clients holding old taskIds in flight at deploy. | Active A2A tasks are short-lived (single-message-per-task), in-flight window is small. Document the change in A2A Agent Card metadata version bump. |
| Running schedule / webhook / A2A through the dispatcher introduces a new transactional pattern that may interact poorly with budget / concurrency caps in the trigger fast-path. | Test cap behavior end-to-end per trigger source in U4 integration tests. |
| Idempotency-key semantics shift when the request boundary moves from a run to a (session, message) pair. | U2 + U3 preserve key uniqueness scoped by route; replay tests cover both `POST /api/sessions` and `POST /api/sessions/:id/messages`. |

---

## Documentation / Operational Notes

- Update `CLAUDE.md` as part of U7.
- Update `docs/best-practices-a2a-routing-slugs.md` to note the `taskId` mapping change.
- Operationally: zero-downtime is not required — this can ship in a maintenance window.
- Monitoring: existing run-status counters become message-status counters; rename in any dashboard / Sentry filter.
- The migration is non-reversible (drops data). Take a Neon point-in-time-recovery snapshot before deploying.

---

## Sources & References

- Origin: [docs/brainstorms/2026-04-27-runs-sessions-unification-requirements.md](../brainstorms/2026-04-27-runs-sessions-unification-requirements.md)
- Sister repo: `~/code/agent-co` migrations `001-init.sql`, `005-threads-and-runs.sql`, `app/api/sessions/`, `lib/dispatch/dispatchNewRun`
- Institutional learning: [docs/solutions/logic-errors/transcript-capture-and-streaming-fixes.md](../solutions/logic-errors/transcript-capture-and-streaming-fixes.md)
- Prior plans for context: [docs/plans/2026-03-09-feat-chat-sessions-plan.md](2026-03-09-feat-chat-sessions-plan.md), [docs/plans/2026-03-26-001-feat-live-run-streaming-plan.md](2026-03-26-001-feat-live-run-streaming-plan.md), [docs/plans/2026-03-30-001-feat-a2a-multi-turn-sandbox-reuse-plan.md](2026-03-30-001-feat-a2a-multi-turn-sandbox-reuse-plan.md)
