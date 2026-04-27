---
title: "feat: Webhook content-based dedupe"
type: feat
status: completed
date: 2026-04-27
origin: docs/brainstorms/2026-04-27-webhook-dedupe-requirements.md
---

# feat: Webhook content-based dedupe

## Overview

Add a second dedupe layer to the webhook ingress pipeline that recognizes logical-duplicate events whose `delivery_id` differs but whose payload key + provider match within a configurable window. Linear is the v1 driver: it retries with a fresh `webhookTimestamp`, bypassing the existing `(source_id, delivery_id)` uniqueness check, causing the agent to run multiple times per real event.

Dedupe rules are stored per-tenant in the database, with code-side defaults shipped at v1 (Linear → `data.url`, 60s). Admins manage their tenant's rules under **Settings → Webhook Dedupe Rules**: enable/disable per provider, edit the key path, edit the window. The ingress pipeline reads the merged set (tenant overrides on top of platform defaults) at request time.

---

## Problem Frame

Linear sends 2+ webhook deliveries per logical event (e.g., issue create). Each retry carries:

- A different `webhookTimestamp` → synthesized `delivery_id` differs → existing `(source_id, delivery_id)` UNIQUE index does not catch it.
- A different top-level `createdAt` and a fresh outer envelope → `payload_hash` (sha256 of raw body) also differs → cannot reuse `payload_hash` for content match.

Result: the agent runs once per duplicate. Wasted budget, duplicate side-effects (e.g., agent posts the same Slack message twice).

We need a content-based projection — a small piece of the payload that's stable across retries and unique per logical event — to detect and suppress logical duplicates before `createRun`.

See origin: `docs/brainstorms/2026-04-27-webhook-dedupe-requirements.md`.

---

## Requirements Trace

- R1. Suppress logical-duplicate Linear webhooks within 60 seconds before `createRun` is invoked.
- R2. Make adding new platform-default provider rules a code edit; allow tenants to override per-provider through the Settings UI.
- R3. Mirror the existing `delivery_id`-duplicate response shape: `200 { run_id, duplicate: true, status_url }`.
- R4. **Failure-open**: if the dedupe key cannot be extracted, fall through to normal run creation. Never drop a legit event because of a registry mismatch.
- R5. Surface a read-only dedupe status in the per-source webhook UI showing the effective rule (tenant override or platform default), with a deep-link to the Settings page.
- R6. Preserve all existing behavior for sources whose provider has no rule (default or override).
- R7. Audit-trail every suppressed delivery (so an admin can answer "why didn't my agent run twice?").
- R8. Admins can list, create, edit, enable/disable, and delete tenant-scoped dedupe rules under **Settings → Webhook Dedupe Rules**. Each rule binds a provider key (e.g., `linear`) to `{ keyPath, windowSeconds, enabled }`. A "Reset to default" action restores the platform default for that provider.

---

## Scope Boundaries

- No per-webhook-source override (overrides are tenant-wide per provider, not per individual source).
- No content-dedupe platform defaults beyond Linear at v1 — but admins can add tenant-scoped rules for any provider key the system knows.
- No "force-replay" header for suppressed deliveries.
- No deliveries audit list page (see origin — conditional on such a page existing later).
- No cross-tenant rule sharing.

### Deferred to Follow-Up Work

- Surfacing suppressed deliveries with a "deduped" badge in a deliveries audit list — depends on whether such a list ships.
- Bulk import/export of rule sets across tenants.

---

## Context & Research

### Relevant Code and Patterns

- `src/app/api/webhooks/[sourceId]/route.ts` — ingress POST handler. The hot path: rate limit → load source → verify signature → parse JSON → `recordDelivery` (current dedupe layer) → `buildPromptFromTemplate` → `createRun` via `after()`.
- `src/lib/webhooks.ts` — `recordDelivery()` does the existing `INSERT ... ON CONFLICT (source_id, delivery_id) DO NOTHING` and returns `{ kind: "inserted" | "duplicate", existingRunId }`. The duplicate response shape is built in the route.
- `src/db/migrations/029_webhook_triggers.sql` — defines `webhook_deliveries` (with `payload_hash`, `run_id`, RLS, indexes on `(source_id, delivery_id)` UNIQUE and `(source_id, created_at DESC)`).
- `src/app/admin/(dashboard)/agents/[agentId]/webhook-provider-presets.ts` — client-side `PROVIDER_PRESETS` + `detectProvider(headerName)`. Currently lives in the admin UI tree only; we'll need a server-side equivalent.
- `src/app/admin/(dashboard)/agents/[agentId]/webhooks-manager.tsx` — admin UI form for webhook sources. Provider is computed in the client from `signature_header` via `detectProvider`. **Provider is NOT stored on `webhook_sources`** — this is a planning-time discovery that diverges from the brainstorm's implicit assumption.
- `src/app/admin/(dashboard)/settings/page.tsx` — existing Settings page (company name, slug, timezone, budget, logo, API keys, ClawSouls token, danger zone). The new "Webhook Dedupe Rules" section lands here as another card.
- `src/app/api/admin/webhooks/route.ts`, `src/app/api/admin/webhooks/[id]/route.ts`, `src/app/api/admin/webhooks/[id]/rotate/route.ts` — existing admin webhook routes; new dedupe-rule routes follow the same shape.
- `tests/unit/webhooks.test.ts` — lib-level unit tests. New registry / extractor tests land here.
- `tests/unit/api/webhooks-ingress.test.ts` — integration-style tests for the POST handler. New dedupe scenarios land here.
- `tests/unit/api/webhooks-crud.test.ts` — CRUD-style admin route tests. New dedupe-rule CRUD tests land here.
- `vitest.config.ts` — `environment: "node"`, no jsdom. UI changes are not unit-tested by convention.

### Institutional Learnings

- The webhook ingress hot path is response-time-sensitive: Linear retries if we don't `2xx` within ~5s. The existing pattern is to respond `202` and run `createRun` in `after()`. Adding one indexed DB read on the suppression path is acceptable; adding a sequential write before insert is acceptable; adding network calls is not.
- Existing admin pages are dark-mode-only (`AGENTS.md`/`CLAUDE.md`). Status lines use the existing `Badge` / muted-foreground patterns from `src/components/ui/`.
- Migrations are append-only and run via `npm run migrate` on every deploy.

### External References

- None. The pattern (content-projection dedupe within a sliding window) is standard webhook-receiver hygiene. Local patterns suffice.

---

## Key Technical Decisions

- **Provider identification — derive from `signature_header`, do not add a column to `webhook_sources`.** `detectProvider(signature_header)` already maps headers → provider keys; reusing it server-side avoids a schema change. Trade-off: a tenant who sets `signature_header: "Linear-Signature"` for a non-Linear source gets Linear dedupe rules. That misuse is unlikely and self-inflicted. If real per-source-overrides surface, we can add a `provider TEXT` column later.
- **Two-layer rule resolution.** Code-side `DEDUPE_DEFAULTS: Record<string, DedupeRule>` (Linear at v1) + tenant-scoped `webhook_dedupe_rules` table. At ingress, the effective rule for a tenant + provider is: tenant override (if `enabled = true`) → platform default (if any) → null. A tenant override with `enabled = false` explicitly turns off platform-default dedupe for that provider.
- **Storage — two tables.**
  - Extend `webhook_deliveries`: add `dedupe_key TEXT NULL` and `suppressed_by_run_id UUID NULL REFERENCES runs(id) ON DELETE SET NULL`. Partial index `(source_id, dedupe_key, created_at DESC) WHERE dedupe_key IS NOT NULL`.
  - New `webhook_dedupe_rules` (tenant-scoped, RLS): `(id UUID PK, tenant_id UUID FK, provider TEXT, key_path TEXT, window_seconds INTEGER, enabled BOOLEAN, created_at, updated_at)` with `UNIQUE (tenant_id, provider)`.
- **Cannot reuse `payload_hash` for content match** — Linear's duplicates differ in `webhookTimestamp` and outer `createdAt`, so the raw-body hash is different. We must hash a projection (the extracted dedupe key value).
- **Key extraction — simple dot-path walker (10 lines, no dependency).** No JSONPath, no JMESPath. Path is `"data.url"`, walked field by field. Returns `null` on missing/non-string/empty.
- **Window query is sliding from `now()` back N seconds.** No anchor-reset. Most-recent prior match wins.
- **Suppressed deliveries are recorded on a fresh row** (with `suppressed_by_run_id` and `valid: true`), not by mutating the original. Preserves audit clarity.
- **Dedupe runs after signature verify, after JSON parse, before `createRun`.**
- **Rule resolution is cached per tenant.** Process-level Map with 60-second TTL keyed by `tenant_id`, holding the merged rule set. Invalidated on rule create/update/delete via the admin route. Avoids a DB round-trip on the hot path for every webhook.
- **Validation on rule writes.** `key_path` matches `^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*$` (1–10 segments). `window_seconds` is `1–3600`. `provider` matches a known key from `PROVIDER_PRESETS` or is `"custom"`. Enforced via Zod in the admin route and a CHECK constraint on the table.
- **Concurrent-duplicate ordering** — same trade-off as before. Accept the rare double-run when two retries arrive within milliseconds before either insert commits.

---

## Open Questions

### Resolved During Planning

- **Where does the platform-default registry live?** A typed const map `DEDUPE_DEFAULTS` in `src/lib/webhook-dedupe.ts`. Tenant overrides live in `webhook_dedupe_rules` and are merged at resolution time.
- **Provider lookup at runtime?** Reuse `detectProvider(signature_header)` from a server-shared module (`src/lib/webhook-providers.ts`); admin UI re-exports the same names.
- **Behavior on missing key?** Failure-open: log at `info`, fall through to normal `createRun`.
- **Linear default key composition?** Just `data.url` — admins can change this per tenant in Settings if they want different semantics.
- **Where does the rule-management UI live?** Under the existing **Settings** page (`/admin/settings`) as a new card, beside API keys / ClawSouls token / danger zone. Keeps tenant-wide settings in one place; not buried under each agent's webhooks.

### Deferred to Implementation

- The exact sequencing for the concurrent-duplicate write/read order (see Key Technical Decisions). May be revisited if U3 test scenarios reveal a tighter need; plan-of-record above is the simpler one-extra-read approach.
- Whether `dedupe_key` and `suppressed_by_run_id` are best-effort writes (off the hot path via `after()`) or in the same insert. Plan-of-record: same insert (one statement, no extra round-trip).
- Whether to log the suppression at `info` or `debug` level. Decided in implementation alongside other logger.* calls.

---

## Implementation Units

- U1. **Shared provider detection module**

**Goal:** Make `detectProvider` callable from server code without dragging the admin UI tree.

**Requirements:** R2.

**Dependencies:** None.

**Files:**
- Create: `src/lib/webhook-providers.ts`
- Modify: `src/app/admin/(dashboard)/agents/[agentId]/webhook-provider-presets.ts` (re-export from lib so the admin UI still imports the same names)
- Test: `tests/unit/webhook-providers.test.ts`

**Approach:**
- Move `PROVIDER_PRESETS`, `PROVIDER_OPTIONS`, and `detectProvider(headerName)` into `src/lib/webhook-providers.ts`. Pure data + one helper, no React, no DB.
- Have the existing client file re-export from the new module so the admin UI continues to import `from "./webhook-provider-presets"` without churn.

**Patterns to follow:**
- Other server-shared lookups in `src/lib/` (e.g., `src/lib/timezone.ts`) — pure functions, no side effects.

**Test scenarios:**
- Happy path: `detectProvider("Linear-Signature")` returns `"linear"`. Cover GitHub, Stripe, Linear, custom-fallback explicitly.
- Edge case: case-sensitivity matches the existing client behavior (it's exact-match today — preserve that).
- Edge case: an unknown header returns `"custom"`.

**Verification:**
- Admin UI builds and renders the provider picker exactly as before.
- New unit test passes.

---

- U2. **Migration 031: dedupe columns + tenant rules table**

**Goal:** Add storage for the content-projection key, the suppressed-by link, and the new tenant-scoped `webhook_dedupe_rules` table.

**Requirements:** R1, R7, R8.

**Dependencies:** None.

**Files:**
- Create: `src/db/migrations/031_webhook_dedupe.sql`
- Test expectation: none — pure schema change. Migration runs in CI on every deploy via `npm run migrate`.

**Approach:**
- Add `dedupe_key TEXT NULL` to `webhook_deliveries`.
- Add `suppressed_by_run_id UUID NULL REFERENCES runs(id) ON DELETE SET NULL`.
- Add partial index: `idx_webhook_deliveries_dedupe ON webhook_deliveries (source_id, dedupe_key, created_at DESC) WHERE dedupe_key IS NOT NULL`.
- Create `webhook_dedupe_rules`:
  - `id UUID PRIMARY KEY DEFAULT gen_random_uuid()`
  - `tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE`
  - `provider TEXT NOT NULL`
  - `key_path TEXT NOT NULL`
  - `window_seconds INTEGER NOT NULL CHECK (window_seconds BETWEEN 1 AND 3600)`
  - `enabled BOOLEAN NOT NULL DEFAULT true`
  - `created_at TIMESTAMPTZ NOT NULL DEFAULT now()`
  - `updated_at TIMESTAMPTZ NOT NULL DEFAULT now()`
  - `UNIQUE (tenant_id, provider)`
  - RLS: `tenant_isolation` policy mirroring `webhook_sources`.
  - `webhook_dedupe_rules_updated_at` trigger via existing `set_updated_at()` function.
- All `IF NOT EXISTS` so re-runs are safe.

**Patterns to follow:**
- `029_webhook_triggers.sql` for table + RLS + updated_at trigger shape.
- Existing CHECK constraints on numeric ranges (e.g., `agents.max_runtime_seconds`).

**Verification:**
- `npm run migrate` runs cleanly against a fresh and an upgraded database.
- `\d webhook_deliveries` shows the two new columns and the partial index.
- `\d webhook_dedupe_rules` shows the new table with RLS enabled.

---

- U3. **Dedupe defaults, key extractor, and resolver**

**Goal:** Encode platform-default rules, implement the dot-path key extractor, and provide a `resolveRuleForTenant(tenantId, provider)` helper that merges tenant overrides on top of defaults with a process-level cache.

**Requirements:** R1, R2, R4, R8.

**Dependencies:** U1, U2.

**Files:**
- Create: `src/lib/webhook-dedupe.ts`
- Test: `tests/unit/webhook-dedupe.test.ts`

**Approach:**
- Define `DedupeRule = { keyPath: string; windowSeconds: number; enabled: boolean }`.
- Define `DEDUPE_DEFAULTS: Record<string, DedupeRule>`. v1 entry: `linear: { keyPath: "data.url", windowSeconds: 60, enabled: true }`.
- Implement `loadTenantRules(tenantId): Promise<Record<string, DedupeRule>>` — selects from `webhook_dedupe_rules` and returns a provider-keyed map.
- Implement a process-level `tenantRuleCache: Map<TenantId, { rules; expiresAt }>` with 60s TTL. Export `invalidateTenantRules(tenantId)` for the admin route to call on writes.
- Implement `resolveEffectiveRule(tenantId, provider): Promise<DedupeRule | null>`:
  - Fetch tenant rules (cached).
  - If a tenant rule exists for `provider`: use it (respecting its `enabled` flag — `enabled: false` returns `null` to explicitly suppress the platform default).
  - Else fall back to `DEDUPE_DEFAULTS[provider] ?? null`.
- Implement `extractDedupeKey(rule, payload): string | null` — dot-path walker, returns the value if it's a non-empty string, else null. Wrapped in try/catch that returns null on any throw.
- Export `computeDedupeKey(tenantId, source, payload): Promise<string | null>` that resolves the rule and calls the extractor.
- Export `getEffectiveRulesForTenant(tenantId): Promise<Record<string, DedupeRule & { source: 'override' | 'default' }>>` for the Settings UI to render the merged view.

**Patterns to follow:**
- `src/lib/webhooks.ts` — module-level helpers + Zod schemas.
- Process-level TTL cache pattern from `src/lib/composio.ts` and `src/lib/plugins.ts`.

**Test scenarios:**
- Happy path: Linear payload with `data.url`, no tenant override → `extractDedupeKey` returns the URL; `resolveEffectiveRule` returns the platform default.
- Happy path: tenant override sets `windowSeconds: 120` for Linear → `resolveEffectiveRule` returns the override (window 120, key from override).
- Happy path: tenant override with `enabled: false` for Linear → `resolveEffectiveRule` returns `null` (explicitly disabled).
- Happy path: tenant adds rule for `github` (no platform default) → `resolveEffectiveRule` returns the override.
- Edge case: `data.url` missing / empty / non-string / nested-parent-missing → `extractDedupeKey` returns `null`.
- Edge case: payload is `null` / non-object → returns `null`, no throw.
- Edge case: malformed `key_path` in the registry shouldn't be reachable due to validation, but `extractDedupeKey` must not throw if it ever is.
- Edge case: tenant cache expiry — second call after TTL re-fetches; `invalidateTenantRules` clears immediately.
- Edge case: provider `"custom"` with no rule → returns `null`.

**Verification:**
- All test cases pass.
- No imports from `src/app/` (lib code stays UI-tree-free).

---

- U4. **Wire content-dedupe into the ingress pipeline**

**Goal:** Persist the dedupe key on every recorded delivery, look up prior matches before kicking off `createRun`, and respond with the original run when a match is found.

**Requirements:** R1, R3, R4, R6, R7.

**Dependencies:** U2, U3.

**Files:**
- Modify: `src/lib/webhooks.ts` — extend `recordDelivery` to accept `dedupeKey?: string | null`, persist it; add `findRecentDeliveryByDedupeKey(sourceId, dedupeKey, windowSeconds)` and `markDeliverySuppressed(deliveryRowId, suppressedByRunId)`.
- Modify: `src/app/api/webhooks/[sourceId]/route.ts` — compute dedupe key after JSON parse, pass to `recordDelivery`, run window lookup on the inserted-row path, and short-circuit with `200 { run_id, duplicate: true, status_url }` on hit.
- Test: `tests/unit/api/webhooks-ingress.test.ts` (extend with new scenarios).

**Approach:**
- After `JSON.parse`, call `computeDedupeKey(source.tenant_id, source, payload)` from U3. Result is `string | null`. Internally this resolves provider via `detectProvider(signature_header)` then merges tenant overrides on top of defaults.
- Pass `dedupeKey` into `recordDelivery`. The existing `INSERT` adds the column.
- If `recordDelivery` returns `kind: "inserted"` and `dedupeKey !== null`, run `findRecentDeliveryByDedupeKey(source.id, dedupeKey, rule.windowSeconds)`. The query selects the most recent prior delivery for the same `source_id` with matching `dedupe_key`, `created_at >= now() - interval`, `id != <just-inserted>`, ordered by `created_at DESC` LIMIT 1.
- If a match is found:
  - Call `markDeliverySuppressed(deliveryRowId, matchedRunId)` to record the link.
  - Return `200 { run_id: matchedRunId, duplicate: true, status_url: matchedRunId ? "/api/runs/..." : null }` and skip the `after(() => createRun(...))` block.
  - Log at `info`: `webhook_dedupe_suppressed { source_id, dedupe_key (first 80 chars), matched_run_id }`.
- If no match: existing flow runs unchanged (`buildPromptFromTemplate` + `after() => createRun()`).
- Failure-open: if `dedupeKey === null` (no rule, missing field, malformed payload), behave exactly as today.
- Update `WebhookDeliveryRow` Zod schema in `src/lib/webhooks.ts` to include `dedupe_key: z.string().nullable()` and `suppressed_by_run_id: z.string().nullable()`.

**Patterns to follow:**
- Existing `recordDelivery` pattern (`INSERT ... RETURNING id` + Zod-validated rowset).
- Existing duplicate-response shape in the route (`{ run_id, duplicate: true, status_url }`).
- Logging convention: `logger.info("webhook_*", { ... })`.

**Test scenarios:**
- Covers AE for R1: Linear payload arrives with `data.url = "https://linear.app/x/issue/TRU-857/..."`; second delivery with the same `data.url` and `webhookTimestamp` 200ms later → second response is `200 { run_id: <first>, duplicate: true }`, only one run is created.
- Happy path: two Linear payloads with different `data.url` → both run normally.
- Edge case: two Linear payloads with same `data.url` 65 seconds apart → both run (outside window).
- Edge case: Linear payload missing `data.url` → run created normally (failure-open). R4.
- Edge case: GitHub-headered source (no v1 rule) → existing `delivery_id` path is the only dedupe; behavior unchanged. R6.
- Edge case: signature failure on the second delivery → 401 returned, dedupe never runs, no suppression recorded.
- Edge case: malformed JSON on the second delivery → 400 returned, dedupe never runs.
- Integration: a suppressed delivery row exists with `valid: true`, `dedupe_key` populated, `suppressed_by_run_id` linking to the original run.
- Integration: the original run continues to completion; `createRun` is called exactly once.
- Edge case: source disabled → existing `genericUnauthorized` path fires before dedupe.

**Verification:**
- New ingress tests pass.
- Existing webhook ingress tests continue to pass unchanged.
- A live Linear test (manual smoke): two retries within 60s → one agent run, second response has `duplicate: true`.

---

- U5. **Admin UI: read-only dedupe status per webhook source**

**Goal:** Show admins, on each webhook source row, the effective rule (from override or default) with a deep-link to the Settings page.

**Requirements:** R5.

**Dependencies:** U1, U3, U7 (so the deep-link target exists).

**Files:**
- Modify: `src/app/admin/(dashboard)/agents/[agentId]/webhooks-manager.tsx` — render a status line per source when an effective rule exists.
- Modify: `src/app/api/agents/[agentId]/route.ts` (or wherever the agent detail data is fetched) to include each source's effective rule snapshot in the response, so the manager doesn't have to make a second round-trip per source.
- Test expectation: none — UI presentational change.

**Approach:**
- The agent-detail API fetches `getEffectiveRulesForTenant(tenantId)` once and resolves each source's rule client-side using `detectProvider(signature_header)`.
- When a rule exists, render under the source row:
  > Deduping enabled · key `data.url` · window 60s · {override or default} · [Manage in Settings →]
- The link points at `/admin/settings#dedupe-rules`.
- When no rule applies (no default, no override), render nothing.

**Patterns to follow:**
- Existing `webhooks-manager.tsx` row layout, muted-foreground secondary text.
- Existing settings deep-link pattern (e.g., the "API Keys" section anchor on the settings page).

**Verification:**
- Linear source shows dedupe status; GitHub source (no rule) shows nothing.
- "Manage in Settings →" lands on the dedupe-rules card.
- Existing form behavior unchanged.

---

- U6. **Tenant-scoped dedupe-rule lib helpers**

**Goal:** CRUD helpers for `webhook_dedupe_rules`, used by the admin routes in U7.

**Requirements:** R8.

**Dependencies:** U2.

**Files:**
- Modify: `src/lib/webhook-dedupe.ts` — add `listTenantRules`, `createTenantRule`, `updateTenantRule`, `deleteTenantRule`.
- Modify: `src/lib/validation.ts` — add `CreateDedupeRuleSchema`, `UpdateDedupeRuleSchema` Zod schemas.
- Test: `tests/unit/webhook-dedupe.test.ts` (extend).

**Approach:**
- All mutation helpers run inside `withTenantTransaction` to enforce RLS.
- `createTenantRule({ tenantId, provider, keyPath, windowSeconds, enabled })` inserts; returns the row. On `UNIQUE (tenant_id, provider)` collision, throws a typed `ConflictError`.
- `updateTenantRule(tenantId, ruleId, patch)` does a partial UPDATE; returns the updated row or null.
- `deleteTenantRule(tenantId, ruleId)` deletes; returns boolean.
- `listTenantRules(tenantId)` selects all rules for the tenant.
- Every mutation calls `invalidateTenantRules(tenantId)` from U3 so the cache picks up the new state immediately.
- Zod schemas:
  - `provider`: enum from `PROVIDER_OPTIONS` plus `"custom"` literal — at minimum `string().min(1).max(50)` with the regex check above.
  - `keyPath`: regex `^[a-zA-Z_][a-zA-Z0-9_]*(\.[a-zA-Z_][a-zA-Z0-9_]*)*$`, max 200 chars.
  - `windowSeconds`: `int().min(1).max(3600)`.
  - `enabled`: boolean, defaults to true.

**Patterns to follow:**
- `src/lib/webhooks.ts` `createWebhookSource` / `updateWebhookSource` / `deleteWebhookSource` for shape.
- `src/lib/errors.ts` for typed errors.

**Test scenarios:**
- Happy path: create + list + update + delete round-trip; all values persist.
- Edge case: duplicate `(tenant_id, provider)` → `ConflictError`.
- Edge case: invalid `keyPath` (special chars, leading dot, double dots) → Zod parse failure.
- Edge case: `windowSeconds` out of range (0, 3601) → Zod parse failure.
- Edge case: tenant A cannot list / update / delete tenant B's rules (RLS — verified via separate transaction with different `app.current_tenant_id`).
- Integration: `invalidateTenantRules` is called on each mutation; subsequent `resolveEffectiveRule` reflects the change without waiting for TTL.

**Verification:**
- All test cases pass.
- RLS verified by attempting cross-tenant access in test.

---

- U7. **Admin API routes for dedupe-rule CRUD**

**Goal:** REST endpoints under `/api/admin/dedupe-rules` for the Settings UI.

**Requirements:** R8.

**Dependencies:** U6.

**Files:**
- Create: `src/app/api/admin/dedupe-rules/route.ts` — `GET` (list, includes merged defaults marked with `source: 'default'` and overrides with `source: 'override'`) and `POST` (create).
- Create: `src/app/api/admin/dedupe-rules/[id]/route.ts` — `PATCH` (update), `DELETE` (delete; restores platform default for that provider since the override is gone).
- Test: `tests/unit/api/webhooks-crud.test.ts` (extend).

**Approach:**
- Auth: same `authenticateAdmin` (JWT cookie or `ADMIN_API_KEY`) used by `src/app/api/admin/webhooks/route.ts`.
- Request and response shapes use Zod schemas from U6.
- `GET` returns `{ defaults: DedupeRule[], overrides: TenantRule[], effective: Record<provider, EffectiveRule> }` so the Settings UI can render all three views without composing them client-side.
- `POST` validates with `CreateDedupeRuleSchema`, calls `createTenantRule`, returns the row.
- `PATCH` validates with `UpdateDedupeRuleSchema`, calls `updateTenantRule`.
- `DELETE` calls `deleteTenantRule`.
- All routes wrapped with `withErrorHandler`.

**Patterns to follow:**
- `src/app/api/admin/webhooks/route.ts` and `src/app/api/admin/webhooks/[id]/route.ts` for handler shape, auth, error mapping.

**Test scenarios:**
- Happy path: `GET` returns merged view with v1 default for Linear and the tenant's overrides.
- Happy path: `POST` creates a rule; `GET` reflects it; `PATCH` updates it; `DELETE` removes it.
- Error path: `POST` with invalid `keyPath` → 400 validation error.
- Error path: `POST` duplicate provider for same tenant → 409 conflict.
- Error path: missing admin auth → 401.
- Edge case: `DELETE` an override for a provider that has a platform default → `GET` shows the default again.
- Edge case: `GET` for a tenant with zero overrides → returns defaults only.

**Verification:**
- All test cases pass.
- Manual: hitting the routes from the Settings UI in a smoke test creates and lists rules end-to-end.

---

- U8. **Settings UI: Webhook Dedupe Rules card**

**Goal:** Surface a manage-rules UI under `/admin/settings`.

**Requirements:** R8.

**Dependencies:** U7.

**Files:**
- Create: `src/app/admin/(dashboard)/settings/dedupe-rules-manager.tsx` — client component that fetches, displays, and mutates rules via the U7 routes.
- Modify: `src/app/admin/(dashboard)/settings/page.tsx` — embed the new component as a section card (anchor `#dedupe-rules`).
- Test expectation: none — UI presentational/orchestration change. Logical coverage is via U7 route tests.

**Approach:**
- Layout matches the existing settings cards (company form, API keys, ClawSouls token, danger zone): a section header, brief description, table of rules.
- The table has columns: Provider · Key path · Window (seconds) · Enabled · Source (Default | Override) · Actions.
- Rows where `source === 'default'` and no override exists show "Override" as the only action.
- Rows where `source === 'override'` show "Edit" + "Disable/Enable toggle" + "Delete" (Delete restores the platform default).
- "Add rule" button opens a dialog with Provider (dropdown from `PROVIDER_OPTIONS`), Key path (text), Window seconds (number), Enabled (toggle).
- Same dialog used for Edit, with the provider field disabled (provider is the unique key — change requires delete + add).
- Inline form validation matches the Zod schemas (regex hint, range hint).
- Use existing primitives: `Card`, `Button`, `FormField`, `Input`, `Dialog`, `ConfirmDialog`, `Badge`.

**Patterns to follow:**
- `src/app/admin/(dashboard)/settings/page.tsx` for section layout.
- Connector cards in agent detail for inline edit/save UX.
- `ConfirmDialog` from `src/components/ui/confirm-dialog.tsx` for delete confirmation.

**Verification:**
- Visual smoke: opens the page, creates a rule for `linear` overriding the window to 120s, confirms the per-source badge in U5 reflects the override on the next page load.
- Editing → saving → reloading shows persistence.
- Deleting an override restores the default (visible in the UI).
- Form validation rejects invalid key paths and out-of-range windows inline.

---

## System-Wide Impact

- **Interaction graph:** Hot path adds one tenant-rules cache lookup (in-process, no DB on cache hit) and the existing one DB read on suppression match. No new cron, queue, or background job. The `runs` table gets a new inbound FK (`webhook_deliveries.suppressed_by_run_id`) but no new write path. The new `webhook_dedupe_rules` table is RLS-isolated and only touched by admin routes + the cache-loader.
- **Error propagation:** Failure-open everywhere. A throw inside `computeDedupeKey` is caught and treated as `null` — never blocks `createRun`. A throw inside `loadTenantRules` is caught, logged, and falls back to platform defaults only.
- **State lifecycle risks:** Cache invalidation is process-local. Multi-instance deploys (Vercel runs N concurrent function instances) mean a rule edit on instance A is visible on instance B only after B's TTL expires (≤60s). Acceptable: dedupe is a best-effort optimization, not a correctness primitive. Documented as a known property, not a bug.
- **Concurrent-duplicate race:** Same as before — accept rare double-runs when two retries arrive within milliseconds before either commits.
- **API surface parity:** Sender-facing response shape is unchanged for the duplicate case. The new admin routes (`/api/admin/dedupe-rules`) sit alongside existing admin routes; no public-API surface change.
- **Integration coverage:** U4 ingress tests cover the cross-layer hot-path scenarios. U6/U7 cover CRUD + RLS.
- **Unchanged invariants:** `webhook_sources` schema is untouched. The `(source_id, delivery_id)` UNIQUE index, RLS policies, and rate-limit envelope are unchanged. Existing webhook ingress paths for sources whose provider has no rule are bit-for-bit identical.

---

## Risks & Dependencies

| Risk | Mitigation |
|---|---|
| Concurrent duplicates within milliseconds both pass the dedupe lookup. | Accept the rare double-run; `delivery_id` UNIQUE catches the common Linear retry shape. |
| A tenant points a non-Linear source at `Linear-Signature` and gets unwanted dedupe. | Self-inflicted misuse; the U5 status line shows the effective rule per source. |
| Multi-instance cache staleness — rule edit visible only after TTL expiry on other instances. | TTL = 60s, dedupe is best-effort. Documented as expected behavior. |
| Tenant configures a `keyPath` that doesn't exist in their provider's payload. | `extractDedupeKey` returns null → failure-open → run proceeds. UI adds a hint that paths are case-sensitive and must use dot notation. |
| Tenant sets `windowSeconds` very high (e.g., 3600), causing legit-but-similar events to be deduped. | CHECK constraint caps at 3600. UI surfaces window value in the per-source badge so admins see what they configured. |
| Adding the partial index lengthens the migration on a large `webhook_deliveries` table. | Table is small (audit log). Index build is negligible. |
| Linear changes its payload shape (e.g., `data.url` moves). | Either edit the platform default (code change) or admins override in Settings. |
| RLS misconfiguration leaks rules across tenants. | U6 tests explicitly attempt cross-tenant access with different `app.current_tenant_id`. |

---

## Documentation / Operational Notes

- Update `CLAUDE.md` "Patterns & Conventions" section to mention webhook content-dedupe and the tenant override mechanism (one short bullet).
- No public-API docs change for senders. New admin endpoints are tenant-private.
- No env var changes.
- No rollout flag — defaults ship with Linear only; non-Linear sources behave identically unless an admin adds a rule. Ship behind no flag.
- Monitoring: `info`-level log `webhook_dedupe_suppressed { source_id, dedupe_key, matched_run_id, rule_source: 'override'|'default' }` fires on every suppression. Admins can grep production logs to confirm the feature is doing real work.

---

## Sources & References

- **Origin document:** [docs/brainstorms/2026-04-27-webhook-dedupe-requirements.md](../brainstorms/2026-04-27-webhook-dedupe-requirements.md)
- Related code: `src/app/api/webhooks/[sourceId]/route.ts`, `src/lib/webhooks.ts`, `src/db/migrations/029_webhook_triggers.sql`, `src/app/admin/(dashboard)/agents/[agentId]/webhook-provider-presets.ts`, `src/app/admin/(dashboard)/agents/[agentId]/webhooks-manager.tsx`
- Related migrations: latest is `030_composio_connection_metadata.sql`; this plan adds `031_webhook_deliveries_dedupe.sql`.
- Related tests: `tests/unit/webhooks.test.ts`, `tests/unit/api/webhooks-ingress.test.ts`
