---
title: "feat: Agent Webhook Triggers (port from agent-co)"
type: feat
status: active
date: 2026-04-26
---

# feat: Agent Webhook Triggers (port from agent-co)

## Overview

Add a sixth agent trigger source — **webhook** — modeled on the inbound-webhook implementation already shipping in `~/code/agent-co`. External systems POST to a stable, public URL; the platform HMAC-verifies the signature, dedupes by delivery id, and dispatches an agent run asynchronously (202 Accepted + `run_id`). Webhook configuration is tenant-scoped, agent-bound, and managed from a new tab on the admin agent detail page plus a tenant REST API.

This unlocks event-driven agent invocation from third-party services (GitHub, Stripe, Linear, custom internal systems) without standing up A2A clients or polling schedules.

---

## Problem Frame

The platform today exposes five trigger sources — `api`, `schedule`, `playground`, `chat`, `a2a` — but no way for external services to POST a signed event and have it deterministically wake an agent. Tenants who want event-driven agents must:

1. Stand up their own server that authenticates the third-party webhook, then POSTs to `/api/agents/:id/runs` with a tenant API key. (Operational burden, leaks API key surface, doubles the request hop.)
2. Or use schedules and poll the source. (Wastes runs, high latency.)

Neither is acceptable for the integrations partners are asking for. agent-co already solved this with a small, well-scoped surface; the goal here is to port the same shape, adapted to AgentPlane's run model and existing patterns.

---

## Requirements Trace

- R1. External systems can trigger an agent run via `POST /api/webhooks/{sourceId}` using HMAC-SHA256 request signing.
- R2. Webhook secrets are stored encrypted at rest and revealed exactly once at creation; rotation is supported with a current+previous overlap window.
- R3. Each webhook source binds to exactly one agent and one tenant, with RLS enforcement.
- R4. The endpoint returns `202 Accepted` with `{ run_id }` for valid signed requests; the run executes asynchronously through the existing `prepareRunExecution` / `finalizeRun` pipeline.
- R5. Duplicate deliveries (same `delivery_id` header) are deduplicated and return `200` without creating a new run.
- R6. The endpoint is rate-limited per source and rejects requests larger than 512KB.
- R7. All authentication failures (unknown source, disabled, bad signature) return `401` to prevent source enumeration.
- R8. Each webhook delivery is recorded for audit (success, failure reason, payload hash, run id).
- R9. The prompt sent to the agent is built from a per-source stored `prompt_template` plus the embedded JSON payload (e.g., `"A new {{source.name}} event arrived:\n{{payload}}"`).
- R10. `runs.triggered_by` accepts the new value `'webhook'`; the admin UI shows a webhook badge and supports filtering runs by source.
- R11. Webhook sources are CRUD-managed via tenant REST API (`/api/webhooks/*`) and admin endpoints (`/api/admin/webhooks/*`); the admin UI exposes a Webhooks tab on agent detail.

---

## Scope Boundaries

- Inbound only — outbound webhook notifications (run.completed callbacks to user URLs) are **not** in scope.
- One-shot runs only — webhook ingress does not create or resume sessions.
- No payload schema mapping / JSONPath extraction beyond the stored prompt template.
- No per-event filtering (e.g., "only fire on `pull_request.opened`") — the agent's prompt template is responsible for any conditional handling once the run is alive.
- No retry queue for failed dispatches — third-party webhook senders already retry on non-2xx responses; we don't re-invent that.

### Deferred to Follow-Up Work

- Outbound run.completed webhooks: separate plan, separate table (`webhook_subscriptions`), separate dispatcher cron.
- Per-source IP allowlists: nice-to-have, deferred.
- Webhook delivery replay UI (resend a stored payload): deferred.

---

## Context & Research

### Relevant Code and Patterns

- `src/lib/runs.ts` — `createRun()` is the central transactional entry point; accepts `{ triggeredBy, scheduleId, sessionId, createdByKeyId }` options. Webhook will pass `triggeredBy: 'webhook'` and a new `webhookSourceId` option.
- `src/lib/run-executor.ts` — `prepareRunExecution()` + `finalizeRun()` are shared by API and A2A; webhook will reuse them.
- `src/db/migrations/016_a2a_support.sql` — pattern for extending the `runs.triggered_by` CHECK constraint via dynamic PL/pgSQL (drop + recreate). Mirror for `webhook`.
- `src/lib/auth.ts` and `src/lib/a2a.ts` (`authenticateA2aRequest`) — constant-time auth pattern; webhook signature verification must follow the same shape.
- `src/lib/oauth-state.ts`, `src/lib/mcp-oauth-state.ts` — existing HMAC primitives; reuse Node `crypto.createHmac`/`timingSafeEqual` rather than introducing a new library.
- `src/lib/crypto.ts` — `encrypt()` / `decrypt()` (AES-256-GCM with `ENCRYPTION_KEY` and `ENCRYPTION_KEY_PREVIOUS` rotation support). Webhook secrets stored via the same path used for `mcp_servers.client_secret_encrypted` and `plugin_marketplaces.github_token_encrypted`.
- `src/lib/rate-limit.ts` — Vercel KV-backed limiter; use this instead of agent-co's in-memory LRU so we get cross-instance correctness on Vercel Functions.
- `src/lib/idempotency.ts` — process-level idempotency helper; webhook dedup is more durable, so we use a unique constraint on `webhook_deliveries.delivery_id` instead.
- `src/lib/api.ts` — `withErrorHandler()` and `jsonResponse()` for route shells.
- `src/lib/streaming.ts` — not used for webhook (async response), but worth noting we deliberately diverge from the streaming pattern here.
- `src/lib/types.ts` — branded types pattern; add `WebhookSourceId` and `WebhookDeliveryId`.
- `src/app/api/admin/mcp-servers/` and `src/app/api/admin/plugin-marketplaces/` — closest existing CRUD shape for a tenant resource that owns encrypted secrets; webhook admin routes mirror this.
- `src/app/admin/(dashboard)/agents/[id]/` — tabbed detail page; add a "Webhooks" tab alongside Schedules and Runs.
- `src/components/ui/run-source-badge.tsx` — extend with a `webhook` variant.

### Institutional Learnings

- A2A integration learned that any endpoint that accepts external traffic must return generic 401s for all auth failure modes to avoid leaking which slugs/keys exist (see `src/lib/a2a.ts`). Apply the same rule to webhook: never differentiate "unknown source" vs "bad signature" vs "disabled".
- Composio MCP integration learned that secrets must be encrypted at rest and never round-tripped through API responses — only revealed at creation. Webhook secrets follow the same rule.
- Run streams above 4.5 minutes detach automatically; webhook explicitly avoids streaming so this isn't a concern, but it's why we picked async-only.

### External References

- agent-co inbound webhook implementation at `~/code/agent-co/app/api/webhooks/[sourceId]/route.ts` and `~/code/agent-co/lib/webhooks/hmac.ts` (verified via research; primary reference).
- GitHub webhooks signature verification (X-Hub-Signature-256) and Stripe webhooks (Stripe-Signature with timestamp + tolerance) — confirm header conventions and replay-window pattern.

---

## Key Technical Decisions

- **HMAC-SHA256 signature in a configurable header.** Default `X-AgentPlane-Signature: sha256=<hex>`. Store `signature_header` on the source so a tenant integrating with GitHub can switch to `X-Hub-Signature-256` without us touching code. Mirror agent-co.
- **Replay protection via `Webhook-Timestamp` + 5-minute tolerance window.** Signature is computed over `{timestamp}.{raw_body}`. Reject requests outside the window with `401`. Stripe-pattern; agent-co does not enforce this and we want to.
- **Idempotency via required `Webhook-Delivery-Id` header**, recorded in `webhook_deliveries` with a unique constraint. Replays return `200` with the original `run_id`. Header is required (not optional) — senders that can't provide one can hash the body themselves.
- **Async response: 202 + `{ run_id, status_url }`.** No streaming. Documented status URL points to `/api/runs/:id` for polling.
- **Public sourceId in URL is intentional.** It's not a secret; the secret is the HMAC key. Generic 401 responses prevent enumeration.
- **Secret rotation: current + previous, with a 7-day default overlap.** `rotate` endpoint moves current → previous, generates a new current, returns the new secret once.
- **Rate limit: 60 req/min per `webhook_source_id`, plus a 600 req/min ceiling per tenant.** Vercel KV-backed via `src/lib/rate-limit.ts`.
- **Body size limit: 512KB.** Enforced at Content-Length check first, then on the actual stream read. `413` on overflow.
- **Prompt assembly happens in `createRun()` caller, not in the runner.** The webhook route resolves the source's `prompt_template`, embeds the parsed JSON payload (pretty-printed, code-fenced), and passes the final string as the `prompt` argument. No new runner-side templating.
- **`runs.webhook_source_id` (nullable FK) added** so transcripts and the admin UI can link back to the originating source. Mirrors the existing `runs.session_id`, `runs.created_by_key_id`, and `runs.schedule_id` columns.
- **Use `Promise<NextResponse>` async route handler — no `after()` deferred dispatch.** agent-co relies on Next.js `after()` to defer task creation; AgentPlane's `createRun()` is a fast transactional insert so we just `await` it before responding 202. The actual sandbox execution still happens out-of-band via the existing executor pipeline.

---

## Open Questions

### Resolved During Planning

- *Inbound only or also outbound?* → Inbound only; outbound deferred (user choice).
- *Stream NDJSON or 202 async?* → 202 async (user choice, also matches third-party webhook sender expectations).
- *Stored template or `body.prompt`?* → Stored template + embedded payload (user choice).
- *In-memory rate limit or KV?* → KV (cross-instance correctness on Vercel).
- *Per-tenant API exposure?* → Yes, both tenant API (`/api/webhooks/*`) and admin API (`/api/admin/webhooks/*`); mirrors how MCP servers and plugin marketplaces are managed.

### Deferred to Implementation

- Exact maximum-prompt-length truncation strategy for very large embedded payloads (close to 512KB body becomes ~700KB prompt after pretty-printing) — decide once we see real-world payloads. Initial impl: truncate payload at 256KB with an explicit `[payload truncated]` marker.
- Whether to surface `webhook_deliveries` history in the admin UI in this PR or follow up separately. Default: surface a 30-day list under the agent's Webhooks tab; cut it if it expands the UI work too much.

---

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
External system                AgentPlane                                Sandbox
───────────────                ──────────                                ───────
POST /api/webhooks/{srcId} ──► verify(headers + body)
   X-AgentPlane-Signature        │
   Webhook-Timestamp             ├─ size check (≤ 512KB)
   Webhook-Delivery-Id           ├─ rate limit (KV: src + tenant)
   {…json payload…}              ├─ load source (incl. encrypted secret)
                                 ├─ HMAC verify (current → previous)
                                 ├─ timestamp window check (±5 min)
                                 ├─ delivery_id dedup (unique insert)
                                 │     │
                                 │     └─ duplicate? ─► 200 { run_id } (existing)
                                 │
                                 ├─ buildPrompt(template, payload)
                                 ├─ createRun(tenant, agent, prompt,
                                 │            { triggeredBy: 'webhook',
                                 │              webhookSourceId })
                                 │
                                 └─◄ 202 { run_id, status_url }
                                       │
                                       └─ (out-of-band) executor pipeline
                                             prepareRunExecution ──► sandbox
                                             finalizeRun        ◄── transcript
```

Auth failures (unknown source / disabled / bad signature / stale timestamp) all collapse to a generic `401 { error: "unauthorized" }` to prevent enumeration. Body too large → `413`. Rate limit → `429 + Retry-After`. Bad JSON → `400`.

---

## Implementation Units

- U1. **Schema, branded types, and `triggered_by` extension**

**Goal:** Add the `webhook_sources` and `webhook_deliveries` tables, branded ID types, and extend the `runs.triggered_by` CHECK constraint to accept `'webhook'`. Add `runs.webhook_source_id` nullable FK.

**Requirements:** R3, R10

**Dependencies:** None

**Files:**
- Create: `src/db/migrations/027_webhook_triggers.sql`
- Modify: `src/lib/types.ts` (add `WebhookSourceId`, `WebhookDeliveryId` branded types)
- Modify: `src/db/index.ts` (Zod row schemas: `WebhookSourceRow`, `WebhookDeliveryRow`)
- Test: `tests/unit/migrations/027_webhook_triggers.test.ts`

**Approach:**
- `webhook_sources` columns: `id` (UUID PK), `tenant_id` (FK, RLS), `agent_id` (FK), `name` (text, unique per tenant), `enabled` (bool, default true), `signature_header` (text, default `X-AgentPlane-Signature`), `signature_format` (text, default `sha256=<hex>`), `secret_encrypted` (text, AES-256-GCM ciphertext), `previous_secret_encrypted` (text, nullable), `previous_secret_expires_at` (timestamptz, nullable), `prompt_template` (text), `created_at`, `updated_at`, `last_triggered_at` (nullable).
- `webhook_deliveries` columns: `id` (UUID PK), `tenant_id` (FK, RLS), `source_id` (FK), `delivery_id` (text, **unique per source**), `payload_hash` (text, sha256 hex), `valid` (bool), `error` (text, nullable), `run_id` (FK, nullable), `created_at`. Index on `(source_id, created_at desc)` for the admin history view.
- Extend `triggered_by` CHECK using the same dynamic PL/pgSQL pattern as migration 016.
- Add `runs.webhook_source_id uuid null` with `ON DELETE SET NULL`.
- RLS: identical pattern to `mcp_servers` (`tenant_id = current_setting('app.current_tenant_id')::uuid` with `NULLIF` fail-closed).

**Patterns to follow:**
- `src/db/migrations/016_a2a_support.sql` — dynamic CHECK rebuild
- `src/db/migrations/020_*.sql` (or whichever added `mcp_servers`) — RLS shape
- `src/lib/types.ts` existing branded types — `Brand<'WebhookSourceId'>`

**Test scenarios:**
- Happy path: migration applies cleanly on a DB at HEAD; rolling back is **not** required (we don't roll back forward migrations).
- Edge case: existing `runs` rows are unaffected by the CHECK change (regression guard).
- Edge case: inserting a duplicate `(source_id, delivery_id)` raises a unique-violation; the application code translates that into the 200-duplicate path.
- Edge case: deleting a `webhook_source` cascades correctly (sets `runs.webhook_source_id` to NULL, deletes `webhook_deliveries`).

**Verification:**
- `npm run migrate` runs to completion with no errors.
- `runs.triggered_by` accepts `'webhook'` and rejects unknown values.
- `webhook_sources` and `webhook_deliveries` exist with the expected RLS policies (verify via `pg_policies`).

---

- U2. **Webhook crypto + DB query helpers**

**Goal:** Provide the library surface that ingress and CRUD routes will share: HMAC verify, secret rotation, source/delivery query helpers.

**Requirements:** R1, R2, R5, R7, R8

**Dependencies:** U1

**Files:**
- Create: `src/lib/webhooks.ts`
- Create: `src/lib/webhook-signing.ts`
- Test: `tests/unit/webhook-signing.test.ts`
- Test: `tests/unit/webhooks.test.ts`

**Approach:**
- `webhook-signing.ts` — pure functions, no DB:
  - `signPayload(secret: string, timestamp: string, rawBody: string): string` — returns `sha256=<hex>`.
  - `verifySignature(secret: string, signature: string, timestamp: string, rawBody: string, toleranceSeconds = 300): VerifyResult` — uses `crypto.timingSafeEqual`; returns `{ valid: boolean; reason?: 'malformed' | 'mismatch' | 'stale' }`.
  - `generateWebhookSecret(): string` — 32 random bytes hex-encoded, prefixed `whsec_`.
- `webhooks.ts` — DB-aware orchestration:
  - `loadWebhookSource(sourceId: WebhookSourceId): Promise<WebhookSourceInternal | null>` — bypasses RLS via service role; the route is unauthenticated, so we look up by id and *then* impersonate the tenant for the run insert. Mirrors how `/api/cron/scheduled-runs` impersonates.
  - `verifyAndPrepare(source, headers, rawBody): Promise<VerifyOutcome>` — wraps signature verify + timestamp window + secret-rotation fallback (try `secret_encrypted`, then `previous_secret_encrypted` if non-null and not expired).
  - `recordDelivery(tenantId, sourceId, deliveryId, payloadHash, runId | null, error | null): Promise<DeliveryOutcome>` — inserts into `webhook_deliveries`; returns `{ kind: 'inserted' | 'duplicate', existingRunId?: RunId }` based on unique-violation.
  - `buildPromptFromTemplate(template: string, payload: unknown, source: { name: string }): string` — substitutes `{{payload}}` and `{{source.name}}`, pretty-prints JSON, fenced. Truncates payload at 256KB with marker.
  - `rotateSecret(sourceId): Promise<{ newSecret: string }>` — moves current → previous, sets `previous_secret_expires_at = now() + 7 days`, generates new current, persists.
- All queries go through `query()` / `withTenantTransaction()`; secrets decrypted via `src/lib/crypto.ts` `decrypt()`.

**Patterns to follow:**
- `src/lib/oauth-state.ts` — HMAC + timing-safe comparison shape
- `src/lib/a2a.ts` `authenticateA2aRequest` — constant-time auth pattern
- `src/lib/composio.ts` — encrypted-secret fetch + decrypt pattern

**Test scenarios:**
- Happy path: signing then verifying with the same secret returns `{ valid: true }`.
- Edge case: timestamp 6 minutes in the past returns `{ valid: false, reason: 'stale' }`.
- Edge case: signature with wrong secret returns `{ valid: false, reason: 'mismatch' }` and uses constant-time comparison (verify by mutation testing or by reading the implementation).
- Edge case: signature header missing or in unexpected format → `{ valid: false, reason: 'malformed' }`.
- Edge case: rotation window — verify against current fails but previous succeeds; verify against an expired previous fails.
- Edge case: `recordDelivery` for an existing `(source_id, delivery_id)` returns `{ kind: 'duplicate', existingRunId }`.
- Error path: `loadWebhookSource` returns `null` for unknown id.
- Edge case: `buildPromptFromTemplate` with a 300KB payload truncates and appends the marker.
- Integration: encrypt → store → load → decrypt round-trips a generated secret.

**Verification:**
- `npm run test -- webhook-signing webhooks` passes.
- HMAC verify uses `crypto.timingSafeEqual`, not `===` or `Buffer.compare`.

---

- U3. **Public webhook ingress endpoint**

**Goal:** Implement `POST /api/webhooks/{sourceId}` end-to-end: load source, verify, dedupe, build prompt, create run, return 202.

**Requirements:** R1, R4, R5, R6, R7, R8, R9, R10

**Dependencies:** U1, U2

**Files:**
- Create: `src/app/api/webhooks/[sourceId]/route.ts`
- Modify: `src/middleware.ts` (allowlist `/api/webhooks/[sourceId]` for unauthenticated access; mirror existing OAuth callback bypass)
- Modify: `src/lib/runs.ts` (extend `createRun()` options to accept `webhookSourceId?: WebhookSourceId`)
- Modify: `vercel.json` (if functions config needs `supportsCancellation` adjustments — verify; webhook endpoint should NOT be cancellable from the client side since the response returns immediately)
- Test: `tests/unit/api/webhooks-ingress.test.ts`

**Approach:**
- Route handler shape:
  1. Read raw body as text **once**, capped at 512KB. Reject `413` if Content-Length > 512KB up front; also enforce while reading.
  2. Apply rate limit on `webhook:source:{sourceId}` (60/min) and `webhook:tenant:{tenantId}` (600/min) — second one applied after source load so we know the tenant.
  3. `loadWebhookSource(sourceId)`. If null or `enabled === false`, return generic `401`.
  4. Read headers: `X-AgentPlane-Signature` (or whatever `signature_header` is configured), `Webhook-Timestamp`, `Webhook-Delivery-Id`. Missing any → `401` (delivery-id missing → `400` with explicit message; this one we *do* leak because senders need to fix it).
  5. `verifyAndPrepare(source, headers, rawBody)`. On any failure → `401`.
  6. Parse JSON. On parse error → `400`.
  7. Compute `payload_hash = sha256(rawBody)`.
  8. Attempt `recordDelivery` insert. If `kind === 'duplicate'`, return `200 { run_id: existingRunId, duplicate: true }`.
  9. `buildPromptFromTemplate(source.prompt_template, parsedPayload, source)`.
  10. `createRun(source.tenant_id, source.agent_id, prompt, { triggeredBy: 'webhook', webhookSourceId: source.id })`. Update `webhook_deliveries` row with the new `run_id` (same transaction or UPDATE after).
  11. Update `webhook_sources.last_triggered_at`.
  12. Return `202 { run_id, status_url: \`/api/runs/${runId}\`, source_name }`.
- Wrap with `withErrorHandler()`. On unexpected exception, record a delivery row with `valid=false, error=…` for audit, then return generic `500`.

**Execution note:** Test-first. The signature verification + 401-collapse + 202 contract is the load-bearing security surface; integration tests should drive its shape from the start.

**Patterns to follow:**
- `src/app/api/a2a/[slug]/jsonrpc/route.ts` — rate-limited public-ish endpoint with single-query auth
- `src/app/api/cron/scheduled-runs/route.ts` — service-role tenant impersonation when calling `createRun()` from an unauthenticated context
- `src/app/api/internal/runs/[id]/transcript/route.ts` — bearer-token-based unauthenticated POST

**Test scenarios:**
- Covers AE1. Happy path: signed POST with valid timestamp + delivery-id returns `202` with a new `run_id`; the run row exists with `triggered_by = 'webhook'` and `webhook_source_id` set; `webhook_deliveries` has `valid=true`.
- Edge case: identical re-POST with the same `delivery_id` returns `200 { duplicate: true, run_id }` matching the original; no second run is created; no second delivery row is created.
- Edge case: timestamp 6 minutes old → `401`; delivery row recorded with `valid=false, error='stale_timestamp'`.
- Edge case: signature with wrong secret → `401`; delivery row recorded with `valid=false, error='signature_mismatch'`.
- Edge case: unknown `sourceId` → `401`; **no** delivery row recorded (we don't have a tenant scope to attribute it to).
- Edge case: source `enabled=false` → `401`; delivery row recorded with `valid=false, error='source_disabled'`.
- Edge case: body > 512KB (Content-Length) → `413` before any DB hit.
- Edge case: body > 512KB while reading (chunked, no Content-Length) → `413`.
- Error path: invalid JSON → `400` with `{ error: "invalid_json" }`; delivery row recorded with `valid=false`.
- Error path: rate limit exceeded for source → `429` with `Retry-After`.
- Error path: rate limit exceeded for tenant (high-volume tenant with many sources) → `429`.
- Error path: missing `Webhook-Delivery-Id` header → `400 { error: "missing_delivery_id" }` (intentional non-401 — sender bug, not auth failure).
- Integration: a successful webhook ingress causes the executor pipeline to actually start a sandbox (use a stubbed sandbox in tests).
- Integration: rotation window — webhook signed with `previous_secret` succeeds while `previous_secret_expires_at` is in the future; fails after.

**Verification:**
- `curl` POST with a manually computed signature returns `202`.
- The created run is visible in the admin runs list with the new webhook badge.
- Rejecting an enumeration probe (random `sourceId`s) takes constant time within ±10ms (informal check).

---

- U4. **Webhook source CRUD APIs (tenant + admin)**

**Goal:** Tenant REST API and admin API for managing webhook sources, including secret rotation.

**Requirements:** R2, R11

**Dependencies:** U2

**Files:**
- Create: `src/app/api/webhooks/route.ts` — list (GET), create (POST)
- Create: `src/app/api/webhooks/[id]/route.ts` — get (GET), update (PATCH), delete (DELETE)
- Create: `src/app/api/webhooks/[id]/rotate/route.ts` — POST
- Create: `src/app/api/admin/webhooks/route.ts` — admin list/create
- Create: `src/app/api/admin/webhooks/[id]/route.ts` — admin get/update/delete
- Create: `src/app/api/admin/webhooks/[id]/rotate/route.ts` — admin rotate
- Modify: `src/lib/validation.ts` — add Zod schemas: `CreateWebhookRequest`, `UpdateWebhookRequest`, `WebhookSourceResponse`
- Test: `tests/unit/api/webhooks-crud.test.ts`

**Approach:**
- Tenant routes use `authenticateApiKey()` and `withTenantTransaction()`.
- Admin routes use `requireAdmin()` (JWT cookie or `ADMIN_API_KEY` bearer) plus tenant scoping via query param or body field.
- **`secret` is returned in the create response and rotate response only.** Never on GET/list/update. Mirror `api_keys` route conventions.
- `prompt_template` is a required field on create with sensible default suggestion (`"A new event arrived from {{source.name}}:\n\n{{payload}}"`) but no automatic insertion — the user explicitly sets it.
- Validate `signature_header` is a valid HTTP header name; reject empty.
- Soft-delete or hard-delete? Hard-delete; rely on FK `ON DELETE SET NULL` for `runs.webhook_source_id`. `webhook_deliveries` cascades.

**Patterns to follow:**
- `src/app/api/admin/mcp-servers/route.ts` and `src/app/api/admin/mcp-servers/[id]/route.ts`
- `src/app/api/keys/route.ts` — secret-revealed-once pattern

**Test scenarios:**
- Happy path: create returns `201` with `secret` field present.
- Happy path: subsequent GET returns the source without `secret`.
- Happy path: rotate returns the new `secret` and old secret continues to verify ingress for the rotation window (cross-checked in U3's rotation test).
- Edge case: name uniqueness per tenant enforced (409 on collision).
- Edge case: cross-tenant access rejected — tenant A cannot GET tenant B's source.
- Edge case: invalid `signature_header` (containing colons, spaces) rejected with `400`.
- Error path: delete a source that has runs — runs survive with `webhook_source_id` set to NULL.
- Integration: admin route updates propagate (e.g., disabling a source via admin causes ingress to return 401).

**Verification:**
- `curl` flow: create → list → rotate → ingress with new secret → ingress with old secret (still works during window) → delete.

---

- U5. **Admin UI: Webhooks tab on agent detail**

**Goal:** Surface webhook management in the admin UI: list webhooks for an agent, create/edit/rotate/delete, and show recent deliveries.

**Requirements:** R11, R8

**Dependencies:** U4

**Files:**
- Create: `src/app/admin/(dashboard)/agents/[id]/webhooks/page.tsx` — Webhooks tab content
- Create: `src/app/admin/(dashboard)/agents/[id]/webhooks/webhook-form.tsx` — create/edit form
- Create: `src/app/admin/(dashboard)/agents/[id]/webhooks/webhook-secret-dialog.tsx` — one-time secret reveal modal with copy button
- Modify: `src/app/admin/(dashboard)/agents/[id]/layout.tsx` (or wherever tabs are registered) — add "Webhooks" tab
- Modify: `src/components/ui/run-source-badge.tsx` — add `webhook` variant (color: orange or violet, distinct from existing 5)
- Modify: `src/app/admin/(dashboard)/runs/page.tsx` — add `webhook` to source filter dropdown
- Test: `tests/unit/admin/webhook-form.test.tsx` (component-level, if existing test infra supports it; otherwise omit and rely on manual UI verification)

**Approach:**
- Tab content: table of webhooks with columns Name, URL (copyable, includes full `https://.../api/webhooks/{id}`), Enabled toggle, Last Triggered, Actions (Edit, Rotate, Delete).
- Form fields: Name, Prompt Template (textarea, monospace, with `{{payload}}` and `{{source.name}}` hints), Signature Header (default pre-filled), Enabled toggle.
- On create success, push secret + curl example into the secret-dialog. Curl example template:
  ```
  TS=$(date +%s)
  BODY='{"hello":"world"}'
  SIG="sha256=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "<secret>" -hex | cut -d' ' -f2)"
  curl -X POST https://.../api/webhooks/<id> \
    -H "X-AgentPlane-Signature: $SIG" \
    -H "Webhook-Timestamp: $TS" \
    -H "Webhook-Delivery-Id: $(uuidgen)" \
    -H "Content-Type: application/json" \
    -d "$BODY"
  ```
- Recent deliveries section (last 30): timestamp, delivery_id, valid (✓ / ✗), error if any, link to run if linked. Pulled from `/api/admin/webhooks/[id]/deliveries` (small follow-up endpoint; cut if it expands work — see Open Questions).

**Patterns to follow:**
- `src/app/admin/(dashboard)/agents/[id]/connectors/` — same tabbed-section pattern
- `src/app/admin/(dashboard)/mcp-servers/` — secret-revealed-once dialog
- `src/components/ui/copy-button.tsx`

**Test scenarios:**
- (Manual UI) Happy path: create webhook → secret dialog shows once → close → re-open shows secret hidden.
- (Manual UI) Rotate webhook → new secret dialog → old secret still works for window.
- (Manual UI) Disable toggle → ingress returns 401.
- (Manual UI) Run source filter on `/admin/runs` shows webhook-triggered runs only.

**Verification:**
- Tab is visible on every agent detail page; UI renders empty state for agents with no webhooks.
- Run badge color is distinguishable from the existing 5 sources (visual check in dark mode).

---

- U6. **Run source plumbing + documentation**

**Goal:** Final loose ends: ensure run source telemetry is consistent, add a README/docs entry, and update CLAUDE.md so future agents know webhook is a trigger source.

**Requirements:** R10

**Dependencies:** U1, U3, U5

**Files:**
- Modify: `CLAUDE.md` — add `webhook` to the `runs.triggered_by` enum list and to the Execution Flow section; add a new "Execution flow (webhook)" subsection
- Modify: `docs/api/` (if there's an API reference; otherwise create `docs/webhook-triggers.md` with a short "How to integrate" guide)
- Modify: `src/lib/types.ts` — `RunTriggeredBy` union literal
- Modify: any analytics/dashboard query that filters by `triggered_by` to include `webhook` (search for callers of the column)

**Test scenarios:**
- Test expectation: none — pure documentation and union-type extension. Type-check via `npm run build` is the verification.

**Verification:**
- `npm run build` passes with the extended union.
- A grep for the existing 5 trigger source values returns zero unhandled cases (e.g., `switch` statements with implicit fall-through).

---

## System-Wide Impact

- **Interaction graph:** New public ingress route hits `createRun()` → existing executor pipeline. No middleware changes other than auth-bypass allowlist for `/api/webhooks/*`. Webhook does not interact with sessions, A2A, or schedules.
- **Error propagation:** Failures on the ingress path are recorded in `webhook_deliveries.error` and surfaced in the admin UI; they do not propagate to the agent run (the run is never created on failure paths). Run-side failures (sandbox timeout, budget exceeded) propagate as run status as usual; webhook senders polling `/api/runs/:id` see the status flip.
- **State lifecycle risks:** Race between `recordDelivery` insert and `createRun` — if `createRun` fails after the delivery row is inserted, the delivery row stays with a NULL `run_id` and a populated `error`. Acceptable; the next retry from the sender (with a different `delivery_id`) gets a fresh attempt. We do **not** roll back the delivery row, because retaining the audit signal matters more than purity.
- **API surface parity:** `runs.triggered_by` enum is the only shared surface; admin UI run filter, run badge, and analytics need updating. Listed in U5 + U6.
- **Integration coverage:** Per U3 — exercises the full HMAC verify → dedupe → createRun → executor pipeline. Mock the sandbox layer; do not mock the DB or the HMAC.
- **Unchanged invariants:** Existing 5 trigger sources are unchanged. `createRun()` signature is **extended** (new optional `webhookSourceId`), not changed; existing call sites compile without modification. RLS policies on existing tables are not modified — webhook tables get their own.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Signature verification has a timing-attack vector if implemented with `===` or `Buffer.compare` | U2 mandates `crypto.timingSafeEqual`; tests assert constant-time comparison shape |
| Source enumeration via differential 401 vs 404 responses | Generic 401 for all auth failure modes (unknown / disabled / bad sig / stale ts); only `Webhook-Delivery-Id` missing returns a non-401 (intentional, sender-bug signal) |
| Replay attack with captured request | `Webhook-Timestamp` + 5-min tolerance window + `Webhook-Delivery-Id` unique constraint |
| Large-payload DOS | 512KB Content-Length check before reading body; second check while streaming for chunked requests; rate limit per source + per tenant |
| Secret leakage via response or logs | Secret returned only on create + rotate; never logged; `webhooks.ts` decrypt happens in-memory only and is not echoed |
| Forgotten secret means forced rotation | Documented; rotate returns new secret immediately, old continues to work for 7 days |
| Webhook ingress runs unauthenticated, so tenant impersonation in `createRun` must be bulletproof | Reuse the `/api/cron/scheduled-runs` impersonation pattern; transactional context sets `app.current_tenant_id` from the loaded source's `tenant_id`, never from the request |
| Cross-tenant source-id collision impossible because IDs are UUIDs, but enforce via unique constraint anyway | UUID PK provides the guarantee; explicit unique on `(tenant_id, name)` for the human-friendly constraint |
| `runs.webhook_source_id` adds a column to a hot table | Nullable, no index needed unless analytics demands one; defer index until measurable |

---

## Documentation / Operational Notes

- New env vars: none. (Reuses `ENCRYPTION_KEY`, `KV_*`, etc.)
- New cron jobs: none.
- New external network allowlist: none (webhook is inbound only).
- Sandbox network policy: unchanged (the agent run that webhook triggers uses the same allowlist as any other run; no webhook-specific egress).
- Migration runs automatically on deploy via `vercel.json` `buildCommand`.
- Update `docs/webhook-triggers.md` (new file in U6) with a short integration guide showing the GitHub-style and Stripe-style header configurations.
- Add a `RUNS_WEBHOOK_*` analytics event series if analytics exist (search for existing `RUNS_API_*` or similar in `src/lib/`).

---

## Sources & References

- agent-co inbound webhook implementation: `~/code/agent-co/app/api/webhooks/[sourceId]/route.ts`, `~/code/agent-co/lib/webhooks/hmac.ts`, `~/code/agent-co/migrations/*webhook*.sql`
- Existing repo references:
  - `src/lib/runs.ts` (`createRun()`)
  - `src/lib/run-executor.ts` (`prepareRunExecution`, `finalizeRun`)
  - `src/lib/a2a.ts` (`authenticateA2aRequest`)
  - `src/lib/oauth-state.ts` (HMAC pattern)
  - `src/lib/crypto.ts` (`encrypt`/`decrypt`, `timingSafeEqual`)
  - `src/lib/rate-limit.ts` (Vercel KV limiter)
  - `src/db/migrations/016_a2a_support.sql` (CHECK constraint extension pattern)
- External:
  - GitHub webhook signature spec: https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries
  - Stripe webhook signature spec: https://stripe.com/docs/webhooks/signatures
