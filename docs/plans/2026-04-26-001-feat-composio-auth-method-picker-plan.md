---
title: "feat: Composio auth-method picker (BYOA OAuth + custom-token + identity capture)"
type: feat
status: active
date: 2026-04-26
deepened: 2026-04-26
origin: docs/brainstorms/2026-04-26-composio-auth-method-picker-requirements.md
---

# feat: Composio auth-method picker (BYOA OAuth + custom-token + identity capture)

## Overview

Today the connector card auto-picks one auth scheme per Composio toolkit using a fixed priority and renders only an OAuth button or an API-key field. This plan adds a generic auth-method picker so the user can choose how to connect — Composio-managed OAuth, bring-your-own-app (BYOA) OAuth, or a custom long-lived token — wires the BYOA path that doesn't exist today, generalizes the token path beyond `API_KEY`, and captures `bot_user_id` plus `display_name` post-connect for the three target toolkits (Slack, Notion, Linear).

The picker is data-driven off Composio's `auth_schemes`. Modes outside the supported set (`composio_oauth | byoa_oauth | custom_token`) are hidden from the picker until wired. Only the per-toolkit "whoami" dispatch is special-cased.

---

## Problem Frame

The system has shipped Composio integrations that work for managed-OAuth and simple-API-key cases, but the team needs three real integrations the current shape cannot express:

- **Slack**: bot app + `xoxb-` token via Composio custom-auth (BEARER_TOKEN); needs `bot_user_id` from `auth.test`.
- **Notion**: internal integration + `secret_…` token via Composio custom-auth (BEARER_TOKEN); needs the integration's user id from `users/me`.
- **Linear**: OAuth app with `actor=app` via Composio bring-your-own-app OAuth; needs the app's user id from the `viewer` query.

All three are required in the first cut — the consumer flow is "one agent acts in Slack + Notion + Linear under a known identity," and the agent can't reason about itself without knowing its own ID in each system.

(see origin: `docs/brainstorms/2026-04-26-composio-auth-method-picker-requirements.md`)

---

## Requirements Trace

- R1. When a Composio toolkit exposes more than one supported auth scheme, the user picks which one to use on the connector card. (origin Goal 1)
- R2. Support Composio-managed OAuth (current), BYOA OAuth, and custom-auth token modes end-to-end. (origin Goal 2)
- R3. Capture and persist `bot_user_id` AND `display_name` after a connection becomes ACTIVE for Slack, Notion, and Linear. (origin Goal 3 — display_name added to keep the identity badge meaningful per design review)
- R4. Picker is data-driven off `auth_schemes` so adding new toolkits with multiple **supported** schemes does not require special-casing. The set of supported schemes (those with a credential form) is named explicitly; toolkits reporting only unsupported schemes (BASIC, JWT variants, vendor-specific) keep today's behavior. (origin Goal 4 — narrowed to be honest about UI scope)
- R5. For toolkits with only one supported scheme, UI is unchanged from today. (origin Success criterion 4)
- R6. Switching schemes requires explicit user confirmation and cleanly removes the prior connected account + auth config. (origin Scope: in-scope; design review escalated to confirm dialog)
- R7. Removing a toolkit cleans up auth configs and connected accounts as today. (origin Success criterion 5)
- R8. All admin routes that mutate per-agent connectors verify `agents.tenant_id` matches the active company context. (security review)
- R9. BYOA OAuth callbacks reuse the same signed-state CSRF defense as managed OAuth. (security review)
- R10. Credentials in transit (BYOA `client_secret`, custom tokens, fetched access tokens) are redacted before any structured log line and never persisted on platform side. (security review)

---

## Scope Boundaries

- Auth schemes Composio exposes that this plan does not wire (`BASIC`, `BASIC_WITH_JWT`, `BILLCOM_AUTH`, `CALCOM_AUTH`, `GOOGLE_SERVICE_ACCOUNT`, `SERVICE_ACCOUNT`, `SAML`, `DCR_OAUTH`) are detected and stored as `OTHER` in `AuthScheme`, but **not surfaced in the picker**. Adding any of them is a future, code-change-required extension — not magic.
- No tenant-level credential vault — credentials remain per-agent.
- No multi-account-per-toolkit per agent (one connection per agent per toolkit).
- No auto-detection of token format — user picks the scheme; the form matches.
- `bot_user_id` and `display_name` are captured and stored. Surfacing them to the model via tool args or system prompt is a follow-up consumer story.
- No background reconciliation job. Drift between Composio and our DB is detected lazily on next read of `getConnectorStatuses`.

---

## Context & Research

### Relevant Code and Patterns

- `src/lib/composio.ts` — current Composio integration. Key functions:
  - `getConnectorStatuses` (~lines 421-484) — single-scheme detection. Replaced by list-of-schemes return + drift reconciliation.
  - `saveApiKeyConnector` (~lines 497-554) — already uses `use_custom_auth`. Generalize to `saveCustomAuthConnector(scheme, credentials)`.
  - `initiateOAuthConnector` (~lines 560-589) — Composio-managed OAuth. Add sibling `initiateByoaOAuthConnector` that creates a per-tenant auth config with user-supplied client credentials in `shared_credentials`.
  - `splitToolkitsForMcp` / `getOrCreateAuthConfig` (~lines 30-115) — **today picks 'first ENABLED' globally with no tenant filter**. Documented as a security-material defect that becomes acute once per-tenant configs proliferate. U5 rewrites this to look up via `connectedAccounts.list({ user_ids: [tenantId] })` first.
  - `removeToolkitConnections` (~lines 598-650) — cleanup; reused for switch.
- `src/lib/types.ts:39` — `AuthScheme` enum widened to mirror the SDK's published list (`OAUTH2 | OAUTH1 | API_KEY | BEARER_TOKEN | NO_AUTH | BASIC | BASIC_WITH_JWT | BILLCOM_AUTH | CALCOM_AUTH | GOOGLE_SERVICE_ACCOUNT | SERVICE_ACCOUNT | SAML | DCR_OAUTH | OTHER`). Add `AuthMethod = "composio_oauth" | "byoa_oauth" | "custom_token"`.
- `src/app/admin/(dashboard)/agents/[agentId]/connectors-manager.tsx` — connector card UI.
- `src/app/api/admin/agents/[agentId]/connectors/[toolkit]/route.ts` — existing connector POST. Note actual segment is `[toolkit]`, not `[slug]`.
- `src/app/api/admin/agents/[agentId]/connectors/[toolkit]/callback/route.ts` — existing OAuth callback. Currently fire-and-forget; uses signed state via `signOAuthState` / `verifyOAuthState`.
- `src/app/api/admin/agents/[agentId]/connectors/[toolkit]/initiate-oauth/route.ts` — existing managed-OAuth init; the BYOA route is a sibling.
- `src/db/migrations/005_add_composio_mcp_cache.sql`, `src/db/migrations/025_agent_identity.sql` — additive-column patterns.
- `node_modules/@composio/client/resources/auth-configs.d.ts` — **verified during deepening: the SDK does NOT expose `oauth_app_credentials` on `authConfigs.create`. The `use_custom_auth` body has only `credentials`, `shared_credentials`, `proxy_config`, `tool_access_config`, `restrict_to_following_tools`, `name`, `is_enabled_for_tool_router`. BYOA must use `shared_credentials: { client_id, client_secret }` with `authScheme: "OAUTH2"`, OR a thin direct HTTP call if SDK rejects unknown shared_credentials keys. U0 confirms which.**
- `node_modules/@composio/client/resources/auth-configs.d.ts` (enum) — **the published `authScheme` set is 13 values, not 5.**

### Institutional Learnings

- Per-tenant auth configs are mandatory for credential isolation. Every BYOA OAuth or custom-token connection MUST create a per-tenant auth config; never reuse a shared one. (`saveApiKeyConnector` comment block.)
- Existing OAuth flow signs `agentId + tenantId + toolkit` into a state token via `signOAuthState`. BYOA reuses this verbatim — no second CSRF defense needed.
- `withErrorHandler` is the error boundary; ensure it does NOT log raw request bodies for connector routes (or that bodies are pre-redacted before any logger call).

### External References

- Composio SDK `authConfigs.create` shape verified directly against installed types — see relevant code section above.

---

## Key Technical Decisions

- **Storage shape:** Add `agents.composio_connection_metadata JSONB NOT NULL DEFAULT '{}'`, keyed by toolkit slug:
  ```
  {
    "slack":  { "auth_method": "custom_token", "auth_scheme": "BEARER_TOKEN", "bot_user_id": "U123", "display_name": "Acme Bot", "captured_at": "..." },
    "linear": { "auth_method": "byoa_oauth",   "auth_scheme": "OAUTH2",       "bot_user_id": "user_abc", "display_name": "Acme Linear App", "captured_at": "..." }
  }
  ```
  Rationale: matches existing `composio_toolkits` / `composio_allowed_tools` shape. Query patterns expected: per-agent reads (covered by primary key), occasional ops queries by `auth_method` (acceptable JSONB scan over the `agents` table at current scale; revisit with a partial GIN index if scale demands). No query needs `bot_user_id` to be cross-agent indexed today. Audit history of credential rotations is **not** preserved by this shape — that's an explicit deferral; if needed later, a `connector_audit` event-log table can be added without changing this column.

- **Two-axis `auth_scheme` (Composio-reported) vs `auth_method` (user-chosen):** kept separate. The split earns its keep because `auth_scheme: OAUTH2` covers BOTH Composio-managed and BYOA — they are runtime-indistinguishable from Composio's report alone, but our flows differ. Storing `auth_method` lets us re-render the picker with the correct radio selected and lets MCP creation pick the right auth-config path.

- **Connector status shape change:** `ConnectorStatus.authScheme` (single) becomes `availableSchemes: AuthScheme[]` plus `selectedMethod: AuthMethod | null` plus `displayName: string | null`. **`TenantConnectorInfo` keeps a deprecated `auth_scheme` field set to `availableSchemes[0]`** (or to the scheme matching `selectedMethod` when set) for one release; new consumers should read `available_schemes` + `selected_method` + `display_name`. Document the deprecation in the response and remove the field in a follow-up after sdk/ui consumers update.

- **Whoami dispatch:** Small registry in `src/lib/composio.ts` keyed by slug, returning `{ bot_user_id, display_name }` from a token. Today: slack (`auth.test` returns `user_id` + `user`), notion (`users/me` returns `id` + `name`), linear (`viewer` returns `id` + `name`). Adding a fourth is a single function. No generic abstraction.

- **When whoami runs:**
  1. **Custom-token mode:** synchronously inside `saveCustomAuthConnector` after `connectedAccounts.create` succeeds.
  2. **Managed/BYOA OAuth:** inside the OAuth callback handler. Because Composio's connected-account state transitions INITIATED → ACTIVE asynchronously, the callback handler **polls** `client.connectedAccounts.retrieve(connectedAccountId)` up to 10 attempts at 500ms intervals (5s ceiling). On ACTIVE → run whoami. On ceiling-without-ACTIVE → mark capture as deferred (`bot_user_id: null`, `capture_deferred: true` in metadata) and let the user re-capture via the UI button (R3 follow-up button is now in-scope, see U4).
  3. Failures (whoami HTTP error, missing access_token) never fail the connect.

- **Access token handling for whoami:** the access token retrieved from the connected-account record is used in a **single HTTP call** and immediately dropped from scope — never assigned to a stored field, never logged, never echoed in error messages. The whoami HTTP error path catches the error, logs only `{ status, slug }` (no body), and returns null.

- **Scheme switching:**
  1. **Required user confirmation** via `ConfirmDialog` before destructive replace.
  2. **Create-then-swap-then-delete order** (not delete-then-create). Reduces the window where a running agent has no valid creds to near-zero. Implementation: create the new auth config + connected account first, update `composio_connection_metadata` to point to the new method, then `removeToolkitConnections` for the old one. If create fails, old connection stays — no degraded state.
  3. **Idempotency:** the POST accepts an `idempotency_key` (uuid generated client-side, stored in our DB for 5 minutes); duplicate submissions with the same key short-circuit to the cached response.

- **Tenant scoping (R8):** every admin route under `/api/admin/agents/[agentId]/...` runs `SELECT * FROM agents WHERE id = $1 AND tenant_id = $2` where `$2` is the active company context resolved from the admin session. Pattern is added to a small helper (`requireAgentInActiveCompany`) and applied in all new + modified routes.

- **MCP server creation auth-config selection (U5 — promoted from "tighten" to "fix"):** today's `getOrCreateAuthConfig` does not filter by tenant and is not safe in a per-tenant-config world. Rewrite: look up the tenant's connected account first (`connectedAccounts.list({ toolkit_slugs, user_ids: [tenantId] })`), pick its `auth_config.id`, and only fall back to creating a managed-OAuth config when no connected account exists. Order: connected-account-pinned → first ENABLED owned by this tenant → create.

- **Drift reconciliation:** `getConnectorStatuses` already lists tenant-scoped connected accounts. If a tenant has a `composio_connection_metadata[slug]` entry but Composio reports no connected account, clear the metadata entry on read and surface `connectionStatus: null`. Self-healing; no background job.

- **AuthScheme widening:** add the full SDK enum (BEARER_TOKEN, BASIC, BASIC_WITH_JWT, BILLCOM_AUTH, CALCOM_AUTH, GOOGLE_SERVICE_ACCOUNT, SERVICE_ACCOUNT, SAML, DCR_OAUTH) to `AuthScheme` so detection survives. The picker hides the unsupported subset; the type just stops dropping them to `OTHER`.

- **No backfill:** Existing rows have `composio_connection_metadata = '{}'`. For toolkits already added with the legacy single-scheme detection, the picker pre-selects the today's-priority `auth_method` (mapped from the dominant scheme) so the user sees no behavior change unless they explicitly switch. For fresh adds with multiple supported schemes, the picker default is the today's-priority pick (e.g., OAUTH2 → composio_oauth) — never an unselected radio.

---

## Open Questions

### Resolved During Planning

- **Schema:** JSONB on `agents`, with explicit deferral of audit history.
- **Whoami dispatch:** small slug-keyed registry; captures both `bot_user_id` and `display_name`.
- **Scheme switching:** confirm dialog + create-then-swap-then-delete + idempotency key.
- **Migration:** no backfill; default `{}` maps to today's priority for the picker pre-selection.
- **`AuthScheme` widening:** include all 13 SDK-published values.
- **Tenant scoping (IDOR defense):** explicit `tenant_id` check on every admin agent lookup.
- **BYOA CSRF:** reuse `signOAuthState` exactly as managed OAuth does.
- **Display name source:** part of the existing whoami round-trip — no extra HTTP calls.
- **Default picker selection on fresh multi-scheme add:** today's-priority pick.
- **Drift reconciliation:** lazy on read in `getConnectorStatuses`.

### Deferred to Implementation

- **Exact BYOA payload:** verify in U0 whether `shared_credentials: { client_id, client_secret }` is accepted by the SDK or if a thin direct HTTP call is needed. Pin the answer before U2 starts.
- **Slack/Notion/Linear `auth_schemes` reported by Composio:** verify in U0 against a real account whether they expose `BEARER_TOKEN` separately from `OAUTH2`/`API_KEY`. If only one scheme reported, the picker for those toolkits relies on a synthetic mode-override (planned in U2) rather than data-driven detection. Document the override clearly.
- **Audit log:** add a single structured `logger.info` line on credential install/replace (`{ event: "connector.credential_change", agent_id, tenant_id, toolkit, auth_method, actor }`). No separate audit table this round.

---

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification.*

```
┌────────────────────────────────────────────────────────────────────────┐
│                       Connector Card (UI)                              │
│                                                                        │
│  toolkit.available_schemes ∩ supportedSchemes  →  picker if size > 1   │
│                                                                        │
│  Method picker  ──┬── Composio OAuth   → Connect button                │
│                   ├── BYOA OAuth       → client_id + secret + Connect  │
│                   └── Custom token     → token field + Save            │
│                                                                        │
│  Switch confirm: ConfirmDialog ("This replaces your active …")         │
└─────────────────────────────────┬──────────────────────────────────────┘
                                  │  idempotency_key + active_company_id
                ┌─────────────────┴─────────────────┐
                ▼                                   ▼
      Admin route (verifies                  Admin route (verifies
      agents.tenant_id = active)             agents.tenant_id = active)
                │                                   │
                │ create-then-swap-then-delete      │
                ▼                                   ▼
   Composio authConfigs.create               connectedAccounts.create
   • managed: use_composio_managed_auth      • per-tenant config
   • BYOA:    use_custom_auth +              • whoami runs sync
              shared_credentials {                  │
                client_id, client_secret }          │
                │                                   ▼
                │ + signed state on callbackUrl   captureBotUserId →
                ▼                                  { bot_user_id,
        Callback handler:                            display_name }
        - verify state                                │
        - poll connected_accounts.retrieve            │
          until ACTIVE (≤5s)                          │
        - run whoami → metadata                       │
        - on ceiling: capture_deferred=true           │
                │                                   ▼
                ▼                          Persist metadata atomically
        Persist metadata atomically        (jsonb_set, redacted body
        (jsonb_set)                          never logged)
```

---

## Implementation Units

- U0. **Spike: pin Composio SDK shape and toolkit auth_schemes**

**Goal:** Empirically confirm the BYOA `authConfigs.create` shape and what `auth_schemes` Composio reports for Slack, Notion, and Linear before writing code that depends on it.

**Requirements:** prerequisite to R2, R3, R4

**Dependencies:** None

**Files:**
- Create: `scripts/spike-composio-auth-shapes.ts` (one-off, deletable; not committed if too noisy)

**Approach:**
- Against a dev Composio account, call `client.toolkits.list({ search: "<slug>" })` for `slack`, `notion`, `linear`; record `auth_schemes` exactly.
- Try `client.authConfigs.create({ toolkit: { slug: "linear" }, auth_config: { type: "use_custom_auth", authScheme: "OAUTH2", shared_credentials: { client_id: "test", client_secret: "test" } } })` and record whether the SDK accepts it (200) or 400s with which error.
- Capture findings as a comment block at the top of `src/lib/composio.ts` so subsequent units have ground truth.

**Patterns to follow:**
- Existing one-off scripts in `scripts/`.

**Test scenarios:**
- Test expectation: none — exploratory spike. Output is documented findings.

**Verification:**
- BYOA payload shape pinned (`shared_credentials` confirmed or alternative documented).
- Slack/Notion/Linear `auth_schemes` lists captured. If `BEARER_TOKEN` is not reported separately for Slack/Notion, `synthetic_modes` overrides are documented for U2.

---

- U1. **DB migration: connection metadata column**

**Goal:** Add the column we'll write `auth_method`, `auth_scheme`, `bot_user_id`, `display_name`, `captured_at`, and `capture_deferred` into.

**Requirements:** R3, R6

**Dependencies:** None (parallel to U0)

**Files:**
- Create: `src/db/migrations/<NNN>_composio_connection_metadata.sql` — verify next sequence number against current `main` HEAD before naming.

**Approach:**
- Single column add: `ALTER TABLE agents ADD COLUMN IF NOT EXISTS composio_connection_metadata JSONB NOT NULL DEFAULT '{}'::jsonb;`
- No backfill required — default `{}` means "use today's auto-detected scheme as picker default."
- Forward-only; no down migration.

**Patterns to follow:**
- `src/db/migrations/005_add_composio_mcp_cache.sql`, `src/db/migrations/025_agent_identity.sql`.

**Test scenarios:**
- Test expectation: none — pure additive schema migration. Verified by `npm run migrate` succeeding and `\d agents` showing the column with the `{}` default.

**Verification:**
- `npm run migrate` exits zero against fresh and upgraded DBs.
- New rows default to `{}`; existing rows backfill to `{}` automatically (Postgres 16+ lazy default).

---

- U2. **Backend lib: widen Composio auth model, add BYOA + generalized custom-token + whoami**

**Goal:** Implement the three connect paths, widen status, capture identity, and rewrite the auth-config lookup to be tenant-scoped.

**Requirements:** R1, R2, R3, R4, R6, R7, R8 (helper), R10

**Dependencies:** U0 (BYOA shape pinned), U1

**Files:**
- Modify: `src/lib/composio.ts`
- Modify: `src/lib/types.ts` — widen `AuthScheme` to all 13 SDK values; add `AuthMethod`, `ConnectionMetadata`, `WhoamiResult`.
- Test: `tests/unit/composio.test.ts` (create if absent).

**Approach:**
- Replace single-scheme detection in `getConnectorStatuses` with `availableSchemes: AuthScheme[]` (raw from Composio) plus drift-reconcile: if `composio_connection_metadata[slug]` exists locally but no connected account on Composio, clear it.
- Rename `saveApiKeyConnector` → `saveCustomAuthConnector(tenantId, slug, scheme, credentials)`. `scheme` is `"API_KEY" | "BEARER_TOKEN"`; `credentials` is the token. Internally `use_custom_auth`, with `shared_credentials` keyed on the actual scheme. After save, call `captureBotUserId` synchronously and write metadata.
- Add `initiateByoaOAuthConnector(tenantId, slug, clientId, clientSecret, callbackUrl)` — creates per-tenant auth config with `type: "use_custom_auth"`, `authScheme: "OAUTH2"`, and `shared_credentials: { client_id, client_secret }` (per U0 finding). Returns `{ redirectUrl, connectedAccountId }`.
- Add `captureBotUserId(slug, connectedAccountId): Promise<WhoamiResult>` returning `{ bot_user_id, display_name } | null`. Slug-keyed registry of three handlers. Each handler: fetch access token from `connectedAccounts.retrieve`, single HTTPS call to provider whoami, return both fields. Token never assigned to outer scope; error path logs only `{ status, slug }`.
- Add `pollConnectedAccountActive(connectedAccountId, { maxAttempts: 10, intervalMs: 500 })` — used by callback handler.
- **Rewrite `getOrCreateAuthConfig`** to be tenant-scoped: `connectedAccounts.list({ toolkit_slugs, user_ids: [tenantId] }).items[0]?.auth_config?.id` first; fall back to creating a fresh per-tenant config. Document old behavior was tenant-leaking.
- `removeToolkitConnections` unchanged.

**Patterns to follow:**
- Existing per-tenant scoping pattern in `saveApiKeyConnector`.
- Existing `initiateOAuthConnector` callback flow.

**Test scenarios:**
- Happy: `saveCustomAuthConnector` API_KEY → per-tenant auth config + connected account.
- Happy: `saveCustomAuthConnector` BEARER_TOKEN → routed under correct shared-credentials key.
- Happy: `initiateByoaOAuthConnector` returns non-empty redirectUrl with valid client_id/secret.
- Happy: `captureBotUserId` slack/notion/linear returns both `bot_user_id` and `display_name`.
- Edge: `getOrCreateAuthConfig` for tenant A returns tenant A's config when tenant B has a different one for the same toolkit (regression test for the pre-deepening bug).
- Edge: `pollConnectedAccountActive` resolves on attempt 3 (status flips ACTIVE mid-poll).
- Edge: `pollConnectedAccountActive` returns INITIATED after maxAttempts → caller marks deferred.
- Edge: drift reconcile: tenant has metadata entry but Composio list returns empty → metadata entry cleared.
- Error: `initiateByoaOAuthConnector` propagates sanitized error when client_secret rejected.
- Error: `captureBotUserId` returns null on HTTP failure; never logs raw response body.
- Error: `captureBotUserId` for unknown slug returns null without dispatch.
- Integration: end-to-end token save → whoami → metadata returned (mocked Composio + provider).

**Verification:**
- `npm run test` green.
- Existing API-key flow continues to work unchanged.
- Cross-tenant regression test passes (no leakage from `getOrCreateAuthConfig`).

---

- U3. **API: scheme save + BYOA OAuth + custom-token routes + callback ACTIVE-poll**

**Goal:** Expose the three connect modes; persist metadata; enforce tenant scoping; redact credentials in transit.

**Requirements:** R1, R2, R3, R6, R8, R9, R10

**Dependencies:** U1, U2

**Files:**
- Create helper: `src/lib/admin-context.ts` exposing `requireAgentInActiveCompany(req, agentId): Promise<{ agent, tenantId }>` — runs `SELECT * FROM agents WHERE id = $1 AND tenant_id = $2`.
- Modify: `src/app/api/admin/agents/[agentId]/connectors/[toolkit]/route.ts` — widened POST body via discriminated union; runs `requireAgentInActiveCompany`; on scheme switch, runs idempotency check + create-then-swap-then-delete order.
- Modify: `src/app/api/admin/agents/[agentId]/connectors/[toolkit]/callback/route.ts` — verify signed state (existing), then `pollConnectedAccountActive`, then `captureBotUserId`, then atomic `jsonb_set` on `composio_connection_metadata`. On poll ceiling, write `capture_deferred: true`.
- Create: `src/app/api/admin/agents/[agentId]/connectors/[toolkit]/byoa/route.ts` — POST → `requireAgentInActiveCompany` → `initiateByoaOAuthConnector` → return `{ redirect_url }`. **The callbackUrl passed to Composio MUST embed the same signed state token as the managed-OAuth path.**
- Create: `src/app/api/admin/agents/[agentId]/connectors/[toolkit]/recapture/route.ts` — POST → re-runs `captureBotUserId` against the existing connected account. Used by the UI re-capture button.
- Modify: `src/lib/validation.ts` — `SaveConnectorRequest` discriminated by `auth_method`:
  - `composio_oauth`: `{ auth_method, idempotency_key }`
  - `byoa_oauth`: `{ auth_method, client_id, client_secret, idempotency_key }`
  - `custom_token`: `{ auth_method, scheme, token, idempotency_key }`
  Add a `redact()` schema transform that, **after Zod validates non-empty**, replaces sensitive strings with `[REDACTED]` in the parsed object before it's eligible for any logger sink. The raw values are kept in a non-loggable closure scope inside the route handler.
- Modify: `src/lib/api.ts` — extend `withErrorHandler` so connector routes' raw bodies are excluded from any error log line (log path + status only).
- Test: `tests/unit/connectors-route.test.ts`.

**Approach:**
- POST handler in `connectors/[toolkit]/route.ts` is the single entry. Discriminator on `auth_method`:
  - `composio_oauth` → existing redirect path (unchanged).
  - `byoa_oauth` → 307 to BYOA route (or inline). Returns `{ redirect_url }`.
  - `custom_token` → `saveCustomAuthConnector` → `captureBotUserId` → metadata write.
- **Scheme-switching:** if `composio_connection_metadata[slug].auth_method` exists and differs:
  1. Check `idempotency_key` against a small in-memory or DB-backed cache (5 min TTL) — duplicate replays return cached response.
  2. **Create new auth config + connected account first** (via the appropriate save path).
  3. **Update metadata** to point at the new method (atomic `jsonb_set`).
  4. **Then** call `removeToolkitConnections(tenantId, [slug])` filtered to delete only the OLD auth-config / connected-account IDs (NOT the just-created ones). Track old IDs explicitly via a snapshot before step 2.
- Callback handler: verify signed state → `pollConnectedAccountActive` → `captureBotUserId` (best-effort) → `jsonb_set` metadata. Deferred capture writes `capture_deferred: true`.
- All credential payloads validated by Zod; `client_secret`, tokens, and access tokens never logged.
- Audit log line on every credential install/replace.

**Patterns to follow:**
- `withErrorHandler` + `withTenantTransaction`.
- `sanitizeComposioError`.
- Existing `signOAuthState` / `verifyOAuthState`.

**Test scenarios:**
- Happy: POST `custom_token` slack → metadata persists `auth_method`, `bot_user_id`, `display_name`.
- Happy: POST `byoa_oauth` linear → returns `redirect_url` containing signed state; callback writes metadata.
- Happy: POST `composio_oauth` notion → callback now also writes `bot_user_id` + `display_name`.
- Happy: re-capture endpoint refreshes `bot_user_id` for an active connection.
- Edge: switching from `custom_token` to `byoa_oauth` — old connected account deleted only after new one is ACTIVE; failed switch leaves old intact.
- Edge: callback poll hits ceiling (10×500ms) → metadata writes `capture_deferred: true`, no error.
- Edge: idempotency replay → second POST with same key returns first's response without side effects.
- Error: cross-tenant agent lookup (admin in company A POSTs against company B's agentId) → 404 (NOT 403; don't leak existence).
- Error: BYOA POST without `client_id`/`client_secret` → 400; payload not echoed in error body or logs.
- Error: custom_token POST with invalid token → sanitized 422; `bot_user_id` not written.
- Error: callback without valid signed state → 400 (existing behavior preserved for BYOA).
- Error: POST for a toolkit reporting only unsupported schemes → 422 with clear message.
- Integration: end-to-end POST → DB metadata reflects exactly the response.

**Verification:**
- All three modes work in dev against real Slack/Notion/Linear accounts.
- Audit log line present on each credential change.
- `client_secret`/token never appears in any structured log line during the full test suite.

---

- U4. **UI: scheme picker + per-mode forms + confirm-dialog + popup state + recapture button**

**Goal:** Replace the single auth-scheme branch with a picker, three credential forms, and the missing UX states the design review surfaced.

**Requirements:** R1, R2, R5, R6 (confirm), R3 (display name fallback)

**Dependencies:** U2, U3

**Files:**
- Modify: `src/app/admin/(dashboard)/agents/[agentId]/connectors-manager.tsx`.
- Modify: `src/lib/composio.ts` (`toTenantConnectorInfo` shape — add deprecated `auth_scheme` alongside new fields).
- Test: `tests/unit/connectors-manager.test.tsx`.

**Approach:**
- Card receives `available_schemes`, `selected_method`, `display_name`, `bot_user_id`, `capture_deferred`.
- **Single-supported-scheme branch (R5):** `available_schemes ∩ supportedSchemes` size 1 → render today's UI unchanged.
- **Multi-supported-scheme branch (R1):** render a labeled picker (segmented control) with one option per supported method:
  - "**Composio OAuth** — Use AgentPlane's app credentials. Fastest setup."
  - "**Bring your own app** — Use your own OAuth client. Required for `actor=app` flows."
  - "**Custom token** — Paste a long-lived bot/integration token (Slack `xoxb-`, Notion `secret_…`)."
  Pre-selection: stored `selected_method`, falling back to today's-priority pick when metadata is empty.
- **Per-mode form bodies:**
  - Composio OAuth: existing Connect button.
  - BYOA OAuth: two password-typed inputs (`Client ID`, `Client Secret`) + Connect → POST → popup → callback.
  - Custom token: single password-typed input + Save.
- **Popup state (BYOA):** while popup open, disable form inputs + Save button, show "Waiting for OAuth completion…" hint. On `popup.closed` without callback, restore form and show "Connection cancelled." On `postMessage` callback, call `loadComposio`.
- **Switch confirmation (R6):** when picker changes from a value matching `selected_method` to a different supported method AND `connectionStatus === "ACTIVE"`, opening the form requires `ConfirmDialog`: "Replacing your active <toolkit> connection will sign out the agent and require re-authorization. Continue?". Cancel reverts the picker.
- **Identity badge:** "Connected as **{display_name}** ({bot_user_id})" when both present. Falls back to "Connected as {bot_user_id}" when display_name null. Falls back to plain "✓ Connected" when both null.
- **Re-capture button:** when `connectionStatus === "ACTIVE"` and (`bot_user_id === null` OR `capture_deferred === true`), show a small "Re-capture identity" link below the badge. Click → POST `/recapture`; on success, refresh the card.
- **Invalid token error recovery:** input value preserved on error (so user can edit), Save button re-enables, `FormError` shows sanitized Composio message under the input. Connection state re-fetched via `loadComposio` to ensure no false-positive ACTIVE.
- **Unsupported schemes:** hidden from the picker entirely. Schemes Composio reports that aren't in `supportedSchemes` are silently dropped. The card still shows the toolkit; only connect modes outside the supported set are missing.
- **Auth-scheme badge in card header** updates to show the **selected method's display label** instead of the raw scheme enum (e.g., "Custom token" instead of "BEARER_TOKEN").

**Patterns to follow:**
- Existing card grid; existing MCP popup-and-postMessage pattern.
- Existing `ConfirmDialog` for destructive operations.

**Test scenarios:**
- Happy: single-scheme toolkit (e.g., a hypothetical CalendlyManagedOnly) renders unchanged from today.
- Happy: multi-scheme toolkit shows picker; selecting custom-token reveals token field.
- Happy: pasting valid `xoxb-…` and clicking Save persists; UI shows "Connected as Acme Bot (U089…)".
- Happy: re-capture button on a `capture_deferred` connection refreshes identity.
- Edge: switching from active `custom_token` to `byoa_oauth` opens `ConfirmDialog`; Cancel reverts the picker.
- Edge: BYOA OAuth popup closes without callback → "Connection cancelled" banner; form re-enabled.
- Edge: invalid token → `FormError` rendered; input preserved; no false-positive ACTIVE.
- Edge: unsupported scheme reported by Composio → hidden from picker.
- Edge: identity badge shows graceful fallback when display_name null.
- Integration: changing method, hitting Save, refreshing the page → new method selected (DB-backed), identity badge persists.

**Verification:**
- Manual check in dev against personal Slack/Notion/Linear.
- Component tests green.
- Picker labels readable to a non-engineer.

---

- U5. **MCP server creation: tenant-scoped auth-config selection (rewrite, not tighten)**

**Goal:** Eliminate the tenant-leaking auth-config lookup in `getOrCreateAuthConfig`/`splitToolkitsForMcp` so MCP server creation never references another tenant's credentials.

**Requirements:** R2, R7, R8

**Dependencies:** U2 (rewrites the helper) — this unit is mostly ensuring the rewritten helper is exercised end-to-end through MCP creation.

**Files:**
- Modify: `src/lib/composio.ts` (verify the rewrite from U2 is what `splitToolkitsForMcp` uses).
- Test: extend `tests/unit/composio.test.ts` with an MCP-creation regression scenario.

**Approach:**
- Confirm `splitToolkitsForMcp` reads auth config IDs via the rewritten tenant-scoped lookup.
- Add a regression test: create per-tenant auth configs for tenants A and B on the same toolkit (via mocked `connectedAccounts`); call `splitToolkitsForMcp` for tenant A; assert the returned auth_config_id matches A's, never B's.
- One-off audit script (deletable): `scripts/audit-composio-multi-config-tenants.ts` — list tenants whose toolkits have multiple ENABLED auth configs in Composio, so ops can verify no anomalies before deploy.

**Patterns to follow:**
- Existing `connectedAccounts.list({ user_ids: [tenantId] })` pattern.

**Test scenarios:**
- Happy: tenant with custom-token Slack + managed-OAuth GitHub → MCP server wired to both correct configs.
- Edge: tenant switched Slack mid-flight → MCP creation picks the new config, never the old.
- Edge: orphaned auth config from a deleted toolkit not picked up.
- Edge: cross-tenant regression — tenant A never gets tenant B's auth_config_id even when both have a config for the same slug.
- Integration: a real run in dev using a BYOA Linear connection successfully invokes Linear tools.

**Verification:**
- A run executed in dev against a BYOA Linear connection runs Linear tools.
- Cross-tenant regression test passes.
- Audit script lists zero anomalies on prod-like data (or anomalies are documented and accepted).

---

- U6. **End-to-end verification + docs touch-ups + audit log validation**

**Goal:** Verify the three target toolkits work end-to-end; confirm no credential-bearing log lines; update CLAUDE.md.

**Requirements:** R3, all success criteria, R10

**Dependencies:** U1–U5

**Files:**
- Modify: `CLAUDE.md` — Composio paragraph reflects three modes + `composio_connection_metadata` + identity capture.
- Modify: code comments in `src/lib/composio.ts` where auth-scheme detection logic was rewritten.

**Approach:**
- Run all three flows end-to-end in dev with real Slack/Notion/Linear.
- Tail structured logs during the test run; grep for `xoxb-`, `secret_`, and the BYOA `client_secret` value — assert none appear.
- Verify audit log line present on each credential install/replace.

**Test scenarios:**
- Test expectation: none — verification + docs.

**Verification:**
- One Slack `xoxb-…`, one Notion `secret_…`, one Linear OAuth-app pair all complete connect → run → tool call.
- Identity badge correctly populated for each.
- No credentials in logs across the test run.
- Audit log line present per credential change.
- CLAUDE.md updated.

---

## System-Wide Impact

- **Interaction graph:** Connector card UI; admin POST connectors / OAuth callback / new BYOA route / new recapture route; `composio.ts` shared by admin routes and run preparation; `withErrorHandler` body-redaction policy. Tenant-facing `GET /api/agents/[agentId]/connectors` returns updated `TenantConnectorInfo` (deprecated `auth_scheme` retained one release).
- **Error propagation:** Whoami best-effort; never fails the connect. Per-tenant auth-config errors sanitized via `sanitizeComposioError`. Polling ceiling sets `capture_deferred: true`.
- **State lifecycle risks:** Scheme-switch race — mitigated by create-then-swap-then-delete + idempotency key. Stuck INITIATED accounts pruned by `removeToolkitConnections` on next switch. Out-of-band Composio dashboard deletions detected and cleaned by `getConnectorStatuses` drift reconciliation.
- **API surface parity:** Tenant self-service `GET /api/agents/:id/connectors` updated alongside admin; `auth_scheme` deprecated for one release.
- **Integration coverage:** U5 regression test exercises cross-tenant boundary on MCP creation. U2 integration test exercises end-to-end token save → whoami → metadata.
- **Unchanged invariants:** `composio_toolkits`, `composio_allowed_tools`, `composio_mcp_*` columns are untouched. No backfill on existing rows. The fixed-priority detection in `getConnectorStatuses` becomes the *fallback* default for picker pre-selection when metadata is empty.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| Composio SDK rejects `shared_credentials: { client_id, client_secret }` for BYOA | Pinned by U0 spike. If rejected, U2 falls back to a thin direct HTTPS call to `authConfigs.create` with the documented body and continues. |
| `connectedAccounts.list` ordering not stable; `items[0]` returns wrong account on duplicates | Idempotency key on save + reconcile-on-read in `getConnectorStatuses` collapse duplicates lazily. If duplicates persist, MCP creation prefers the most recently `created_at` from the list. |
| `getOrCreateAuthConfig` rewrite breaks existing tenants whose connected accounts reference a deleted auth config | U5 audit script lists anomalies before deploy; fall-back path creates a fresh per-tenant managed-OAuth config when no connected account exists, restoring service. |
| Whoami fails for a tenant (e.g., Notion permission gap) | `capture_deferred: true` + UI "Re-capture identity" button. No degraded silent state. |
| OAuth callback poll ceiling reached before Composio activates the connection | Metadata writes `capture_deferred: true`; user can re-capture. Connection itself is still ACTIVE in Composio when activation eventually completes — no data loss. |
| Scheme-switch races duplicate auth configs in Composio | Idempotency key + create-then-swap-then-delete order leaves the old connection untouched on any failure. |
| User pastes a token whose scheme doesn't match the toolkit's expectations | Composio rejects on `connectedAccounts.create`; sanitized error returned; UI restores form with input preserved. |
| `client_secret` or token leaked via logs | (1) Zod `.transform(redact)` after parse; (2) `withErrorHandler` body-redaction for connector routes; (3) U6 grep validation in dev. |
| Cross-tenant credential exposure via `splitToolkitsForMcp` | U2/U5 rewrite tenant-scopes the lookup; U5 cross-tenant regression test guards against regression. |
| BYOA callback CSRF | BYOA `callbackUrl` MUST embed signed state from `signOAuthState`; existing `verifyOAuthState` check applies unchanged. |
| Admin operating in company A modifies company B's agent | `requireAgentInActiveCompany` helper enforces `tenant_id = $2` on every admin agent lookup; cross-tenant regression test in U3. |
| Two-axis storage (`auth_method` + `auth_scheme`) over-abstracts | Justified by runtime split: Composio reports `OAUTH2` for both managed and BYOA. Single-axis storage cannot distinguish. Accepted complexity. |

---

## Documentation / Operational Notes

- Update `CLAUDE.md` Composio bullet to mention the three modes, `composio_connection_metadata`, and identity capture.
- Audit log line emitted per credential install/replace; observable in existing structured logger sinks (no monitoring change required initially).
- One-off `scripts/audit-composio-multi-config-tenants.ts` run before deploy; document any anomalies as ops items.
- One-release deprecation of `TenantConnectorInfo.auth_scheme` — remove in the follow-up plan after sdk/ui consumers update.

---

## Sources & References

- **Origin document:** `docs/brainstorms/2026-04-26-composio-auth-method-picker-requirements.md`
- Related code: `src/lib/composio.ts`, `src/app/admin/(dashboard)/agents/[agentId]/connectors-manager.tsx`, `src/lib/types.ts`, `src/app/api/admin/agents/[agentId]/connectors/[toolkit]/{route,callback,initiate-oauth}/route.ts`
- SDK reference: `node_modules/@composio/client/resources/auth-configs.d.ts`
- Recent migration patterns: `src/db/migrations/005_add_composio_mcp_cache.sql`, `src/db/migrations/025_agent_identity.sql`
- Review artifacts: 5-persona review run on 2026-04-26 (coherence, feasibility, security-lens, design-lens, adversarial). 24 findings synthesized; safe_auto fixes applied; remaining integrated via best-judgment auto-resolve.
