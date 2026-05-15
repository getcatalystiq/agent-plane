---
title: "feat: Per-tenant Slack webhook notifications for MCP connection failures"
type: feat
status: active
date: 2026-05-08
---

# feat: Per-tenant Slack webhook notifications for MCP connection failures

## Summary

Add per-tenant Slack incoming-webhook alerting that fires once when a custom MCP connection transitions `active → failed` inside `buildMcpConfig()`. Webhook URL is encrypted at rest on the `tenants` row, set/cleared from the company settings page, and dispatched fire-and-forget via `after()` so it never adds latency or breaks a run. Composio MCP failures, proactive probing, and dedup/cooldown are explicit non-goals for v1.

---

## Problem Frame

Custom MCP connections silently disconnect — OAuth refresh tokens expire, server hosts go away, base URLs change — and today the only signal is an `errors` entry on a session message that the operator may or may not see. The platform marks the connection `failed` in the database (`src/lib/mcp.ts:148` → `markConnectionFailed()`), but no human is told. Operators have asked for a low-friction Slack alert when a connection breaks so they can re-authorize before the next scheduled run also fails.

---

## Requirements

- R1. Each tenant can store one Slack incoming-webhook URL, encrypted at rest using the existing `ENCRYPTION_KEY` AES-256-GCM pattern.
- R2. The URL is set, cleared, and (optionally) test-fired from the company settings page in the admin UI.
- R3. When a custom MCP connection transitions from `status='active'` to `status='failed'` inside `buildMcpConfig()`, exactly one Slack notification is dispatched per transition.
- R4. Already-failed connections that fail again on subsequent runs do NOT re-notify (the transition is the trigger, not the failure itself).
- R5. The notification carries: tenant name, agent name, MCP server name, error message, and a clickable link to the agent's Connectors tab in admin UI.
- R6. Notification dispatch is fire-and-forget via `after()`, wrapped in try/catch with a hard timeout, and never blocks or fails a run regardless of webhook outcome.
- R7. A misconfigured webhook URL (404, 5xx, malformed) logs a warning but does not surface as a user-facing error during runs.
- R8. Tenants that have not configured a webhook URL pay no extra cost and receive no notifications.

---

## Scope Boundaries

- **Composio MCP failures are out of scope.** The Composio path uses different code (`src/lib/composio.ts`) with its own server lifecycle and failure modes. Adding it is a follow-up.
- **No proactive cron-based probing.** Detection is run-time only. Connections that go stale between runs are detected and notified on the next run.
- **No per-agent or per-channel routing.** One URL per tenant.
- **No dedup, cooldown, or rate-limit.** Repeated `active → failed` cycles produce repeated notifications by design — the transition gate already prevents the loud case (the same broken connection notifying every run).
- **No proactive recovery alerts** (e.g., "MCP connection X is back online"). Only failure transitions notify.

### Deferred to Follow-Up Work

- Composio MCP failure notifications: separate plan once this v1 is shipped.
- Cron-based "probe-MCP-connections" job: only if operator feedback shows the next-run-detection latency is too high.
- Templating / Block Kit formatting: only if plain mrkdwn proves insufficient.

---

## Context & Research

### Relevant Code and Patterns

- `src/lib/mcp.ts:148` — sole call site that transitions a connection to `failed`. The `for (const result of tokenResults)` loop in `buildMcpConfig()` is the attachment point for the notification dispatch.
- `src/lib/mcp-connections.ts:521` — `markConnectionFailed()`. Today returns `void`; needs to return whether the row's prior status was `active` so the caller can gate notification dispatch on the transition.
- `src/lib/crypto.ts:69` — `encrypt(plaintext, key)` returns `{ciphertext, iv}` which is JSON.stringified into the `*_enc` column. Mirrored by `decrypt(JSON.parse(row.x_enc), key)`.
- `src/app/api/admin/tenants/[tenantId]/route.ts:62` — `PATCH` handler. `UpdateTenantSchema` (line 51) is the Zod schema; the encrypt-on-save pattern is already used at line 102 for `subscription_token`.
- `src/app/admin/(dashboard)/settings/clawsouls-section.tsx` — closest UI analog. Plaintext-in / encrypted-at-rest, "Connected" badge, "Clear" button, password-style input. The new section copies this shape.
- `src/app/api/webhooks/slack/route.ts:287` and `src/app/api/webhooks/discord/route.ts` — established `after()` usage patterns in the codebase. `after()` is imported from `next/server` and works inside any route-handler call stack including helpers called transitively from `buildMcpConfig()`.
- Tenant lookup of name/slug for the notification payload: existing `withTenantTransaction` provides RLS, but a single SELECT on `tenants` from the dispatcher's tenant context is sufficient — the tenant row is already in scope when `buildMcpConfig()` runs (the dispatcher has `tenantId`; the helper can do the lookup).

### Institutional Learnings

- `docs/solutions/` doesn't yet contain a "fire-and-forget Vercel `after()`" pattern doc, but the inbound-Slack webhook flow in `src/app/api/webhooks/slack/route.ts` is the de facto reference and uses `after()` correctly with `waitUntil` integration.

### External References

- Slack incoming webhooks: <https://api.slack.com/messaging/webhooks> — POST a JSON body with `text` (plain or mrkdwn) to `https://hooks.slack.com/services/T.../B.../...`. Returns `200 OK` with body `ok` on success; `400`/`404` on misconfiguration.
- mrkdwn vs Block Kit: mrkdwn is sufficient for the v1 payload (5 fields, one link). Block Kit is overkill until we have a layout reason.

---

## Key Technical Decisions

- **Migration number 042**: next sequential after `041_schedules_target_channel.sql`. Adds `slack_alert_webhook_url_enc TEXT NULL` to `tenants`. No backfill needed (NULL = unconfigured = no notifications).
- **Plain-text mrkdwn payload, not Block Kit**: simpler to format, easier to read, easier to change. Body shape: `*MCP connection failed*\n*Agent:* <name>\n*Server:* <name>\n*Error:* <msg>\n<link|Open agent>`.
- **Format-validate on save + manual "Send test alert" button** instead of round-trip-test on save: validation regex matches `^https://hooks\.slack\.com/services/T[A-Z0-9]+/B[A-Z0-9]+/[A-Za-z0-9]+$`. A separate POST endpoint (and button in the UI) lets the operator verify the URL on demand. Round-tripping on save would either block the save (slow UX) or leave the door open for inconsistent state if the URL works at save time but breaks later — the manual test button gives equivalent assurance without coupling save to network reachability.
- **Helper module location**: `src/lib/notifications/slack.ts`. New `notifications/` subdirectory keeps it open for future channels (email, PagerDuty, etc.) without churning lib root.
- **Notification dispatch lives inside `buildMcpConfig()`**, not threaded back to the route handler. `after()` from `next/server` works correctly when called transitively from a route handler's call stack, and threading the transition info up through the dispatcher would bloat the dispatcher's return shape for one consumer.
- **Transition detection via `UPDATE ... RETURNING (CASE WHEN ... THEN true ELSE false END) AS was_active`**: one round-trip, atomic, no read-then-write race. Caller gates notification on `was_active = true`.
- **Hard timeout: 3 seconds** on the outbound `fetch()` via `AbortController`. Slack webhooks usually respond in <500ms; 3s is generous and well under any sandbox/run budget.
- **Tenant name lookup happens inside the notifier helper**, not the call site. The helper takes `(tenantId, agentName, serverName, errorMessage, agentId)` and does its own tenant SELECT under RLS context. Keeps the call site at the failure point clean.

---

## Open Questions

### Resolved During Planning

- **Block Kit vs plain text**: plain mrkdwn (see Key Technical Decisions).
- **Validate on save vs round-trip-test**: format-validate + manual test button (see Key Technical Decisions).
- **Helper location**: `src/lib/notifications/slack.ts` (see Key Technical Decisions).
- **Dedup/cooldown**: none. Transition gate is the only guard. (Per scope.)

### Deferred to Implementation

- Exact wording of the Slack message body — finalize during U2 once the helper is wired up and a real webhook is fired during dev.
- Whether the "Send test alert" button POSTs synchronously and shows a toast result, or just queues an `after()` send and shows "test queued". Decide at UI implementation time based on what feels right.

---

## Implementation Units

### U1. DB migration: add `slack_alert_webhook_url_enc` to tenants

**Goal:** Add the encrypted column and document its semantics. NULL means unconfigured (no notifications).

**Requirements:** R1, R8

**Dependencies:** None

**Files:**
- Create: `src/db/migrations/042_tenants_slack_alert_webhook.sql`

**Approach:**
- `ALTER TABLE tenants ADD COLUMN slack_alert_webhook_url_enc TEXT NULL;`
- No backfill, no default. NULL is the unconfigured state.
- No new index — column is read once per `buildMcpConfig()` only when a connection just transitioned to failed (rare path).
- Migration runs automatically on deploy via `vercel.json buildCommand` per CLAUDE.md.

**Patterns to follow:**
- `src/db/migrations/038_tenant_bot_caps.sql` — same shape (single column add on tenants).

**Test scenarios:**
- Test expectation: none — pure schema migration with no behavioral change. U3 and U4 cover the column's behavior.

**Verification:**
- `npm run migrate` succeeds on a fresh DB.
- `\d tenants` in psql shows the new nullable TEXT column.

---

### U2. New notifier helper: `src/lib/notifications/slack.ts`

**Goal:** Single-purpose helper that takes a Slack webhook URL plus payload fields and POSTs the message with timeout + error swallowing. Pure I/O; no DB access; no transition logic.

**Requirements:** R5, R6, R7

**Dependencies:** None (standalone helper)

**Files:**
- Create: `src/lib/notifications/slack.ts`
- Test: `tests/unit/notifications/slack.test.ts`

**Approach:**
- Export `postSlackMcpFailureAlert({ webhookUrl, tenantName, agentName, agentId, serverName, errorMessage, baseUrl })`.
- Format payload as plain mrkdwn (`{ text: "..." }`); link points to `<baseUrl>/admin/agents/<agentId>?tab=connectors`.
- Use `AbortController` with 3-second timeout.
- Wrap whole `fetch()` in try/catch. Log warnings via `src/lib/logger.ts` on non-2xx, on abort, and on network error. Never throw to caller.
- Also export `validateSlackWebhookUrl(url: string): { ok: true } | { ok: false; reason: string }` using the regex from Key Technical Decisions. Used by U4 (PATCH) and U6 (test endpoint).

**Patterns to follow:**
- Logger usage in `src/lib/mcp.ts` (`logger.warn(message, { ...context })`).
- AbortController + timeout pattern from `src/lib/mcp-oauth.ts` (token refresh has the same shape).

**Test scenarios:**
- Happy path: stub `fetch` returns 200; `postSlackMcpFailureAlert` resolves to `undefined`; payload includes all five fields and the agent link.
- Error path: stub `fetch` throws (network); helper resolves (no throw); `logger.warn` is invoked once with `{ status: 'network_error' }` context.
- Error path: stub `fetch` returns 404; helper resolves; `logger.warn` invoked with `{ status: 404 }`.
- Edge case: AbortController fires at 3s; helper resolves; `logger.warn` invoked with `{ status: 'timeout' }`.
- Validation: `validateSlackWebhookUrl` accepts a real-shaped Slack webhook URL.
- Validation: `validateSlackWebhookUrl` rejects `http://`, `https://example.com/foo`, and an empty string with a specific reason string per case.

**Verification:**
- All test scenarios pass under `npm run test`.

---

### U3. Make `markConnectionFailed` transitional, dispatch on transition

**Goal:** Detect the `active → failed` transition atomically, and from `buildMcpConfig()` schedule a notification via `after()` only when the row was previously active. No-op when no webhook URL is configured.

**Requirements:** R3, R4, R6, R8

**Dependencies:** U1, U2

**Files:**
- Modify: `src/lib/mcp-connections.ts` (change `markConnectionFailed` signature)
- Modify: `src/lib/mcp.ts` (call site)
- Test: `tests/unit/mcp-connections.test.ts` (extend)
- Test: `tests/unit/mcp-build-config.test.ts` (extend or create)

**Approach:**
- Change `markConnectionFailed()` to:
  ```sql
  UPDATE mcp_connections
     SET status = 'failed'
   WHERE id = $1
   RETURNING (status_before = 'active') AS was_active
  ```
  Implementation note: Postgres doesn't expose pre-update column values directly in `RETURNING` for a column we just wrote. Use a CTE: `WITH prev AS (SELECT status FROM mcp_connections WHERE id = $1 FOR UPDATE) UPDATE mcp_connections SET status='failed' WHERE id = $1 RETURNING (SELECT status='active' FROM prev) AS was_active`. Returns boolean. Returns 0 rows if the connection no longer exists — caller treats as `was_active = false`.
- Return type: `Promise<{ was_active: boolean }>`.
- In `src/lib/mcp.ts:148`, after `markConnectionFailed`, if `was_active === true`, look up the tenant's webhook URL (decrypt) and the tenant name in one query. If both present, schedule the notification:
  ```ts
  after(async () => {
    await postSlackMcpFailureAlert({ ...payload });
  });
  ```
- Tenant lookup: a small new helper in `src/lib/mcp-connections.ts` or inline in `mcp.ts`: `SELECT name, slack_alert_webhook_url_enc FROM tenants WHERE id = $1`. Decrypt the URL with `decrypt(JSON.parse(...), env.ENCRYPTION_KEY)`. Skip dispatch if NULL.
- `baseUrl` for the link: reuse `getCallbackBaseUrl()` from `src/lib/mcp-connections.ts:541` — same logic (prefers `VERCEL_PROJECT_PRODUCTION_URL`).
- All notification work happens inside the existing `for (const result of tokenResults)` loop's rejected branch. Keep changes to that block tight.

**Patterns to follow:**
- `after()` import: `import { after } from "next/server"` (see `src/app/api/webhooks/slack/route.ts:287`).
- Decrypt-from-tenant pattern from `src/app/api/admin/tenants/[tenantId]/route.ts` GET handler region.

**Test scenarios:**
- Happy path: `markConnectionFailed` on a row with `status='active'` returns `{was_active: true}` and the row is now `status='failed'`. *Covers R3.*
- Idempotency: calling `markConnectionFailed` again on the now-failed row returns `{was_active: false}` and does not re-trigger notification. *Covers R4.*
- Edge case: `markConnectionFailed` on a non-existent connection id returns `{was_active: false}` (0 rows) and does not throw.
- Integration: in `buildMcpConfig` test, with the tenant configured (webhook URL set, mocked `postSlackMcpFailureAlert`), forcing token refresh to fail causes exactly one `postSlackMcpFailureAlert` call with the right payload. *Covers R3, R5.*
- Integration: same setup but the tenant has NO webhook URL configured — `postSlackMcpFailureAlert` is never called. *Covers R8.*
- Integration: a connection that's already `failed` failing again does NOT call `postSlackMcpFailureAlert`. *Covers R4.*
- Error path: `postSlackMcpFailureAlert` rejecting (helper itself is bug-free per U2, but assert: even if it threw, `buildMcpConfig` still completes normally) — wrap dispatch site in try/catch as belt-and-suspenders. *Covers R6.*

**Verification:**
- All test scenarios pass.
- Manual smoke: in dev, configure a webhook, force a token refresh failure (e.g., set an MCP server's URL to an unreachable host), trigger a run, confirm exactly one Slack message arrives.

**Execution note:** Update the existing `markConnectionFailed` test first to fail on the new return shape, then implement.

---

### U4. Admin tenants PATCH: accept and encrypt `slack_alert_webhook_url`

**Goal:** Extend the existing `PATCH /api/admin/tenants/[tenantId]` to accept `slack_alert_webhook_url`, format-validate it, encrypt at rest, and accept empty string as "clear".

**Requirements:** R1, R2

**Dependencies:** U1, U2 (uses `validateSlackWebhookUrl`)

**Files:**
- Modify: `src/app/api/admin/tenants/[tenantId]/route.ts`
- Modify: `src/lib/validation.ts` (add field to `TenantRow` flag if needed for GET response shape)
- Test: `tests/unit/admin-tenants-patch.test.ts` (extend or create)

**Approach:**
- Add to `UpdateTenantSchema`:
  ```ts
  slack_alert_webhook_url: z.string().trim().optional()
  ```
  Empty string → clear. Non-empty → run through `validateSlackWebhookUrl`; reject 400 with a helpful message if invalid.
- Encrypt with `encrypt(input.slack_alert_webhook_url, env.ENCRYPTION_KEY)`, JSON.stringify, store in `slack_alert_webhook_url_enc`. Mirror the `subscription_token` block already in this file.
- Empty-string clear: `SET slack_alert_webhook_url_enc = NULL`.
- Extend `TENANT_SELECT` to include `slack_alert_webhook_url_enc IS NOT NULL AS has_slack_alert_webhook` so the UI can render the "Connected" badge without exposing the URL.
- Extend `TenantWithTokenFlag` Zod schema accordingly.

**Patterns to follow:**
- `subscription_token` block at `src/app/api/admin/tenants/[tenantId]/route.ts:102`.
- `has_subscription_token` flag at line 19 / 15.

**Test scenarios:**
- Happy path: PATCH with a valid `slack_alert_webhook_url` saves an encrypted blob; GET returns `has_slack_alert_webhook: true` and never the plaintext URL.
- Edge case: PATCH with empty string clears the column to NULL; GET returns `has_slack_alert_webhook: false`.
- Error path: PATCH with `https://example.com/foo` returns 400 with a message naming the expected URL shape.
- Error path: PATCH with `not-a-url` returns 400.
- Edge case: PATCH that doesn't include the field at all leaves the existing value untouched.

**Verification:**
- All test scenarios pass.
- Manual: hit the endpoint with curl, confirm row encrypts and decrypts cleanly.

---

### U5. Admin UI: Slack alerts section in company settings

**Goal:** New section on `/admin/settings` to set, clear, and (via U6) test-fire the Slack webhook URL. Mirrors the ClawSouls section's layout.

**Requirements:** R2

**Dependencies:** U4

**Files:**
- Create: `src/app/admin/(dashboard)/settings/slack-alerts-section.tsx`
- Modify: `src/app/admin/(dashboard)/settings/page.tsx` (mount the new section, pass `hasWebhook` flag)

**Approach:**
- Copy `clawsouls-section.tsx` as the structural template. Substitutions:
  - Title: "Slack Alerts"
  - Body: "Receive a Slack notification when a custom MCP connection fails. We'll only alert you on the transition from active to failed — not every retry."
  - Field label: "Incoming Webhook URL"
  - Placeholder: `https://hooks.slack.com/services/...` or `https://hooks.slack.com/services/T•••/B•••/•••` when configured.
  - Save calls `PATCH /admin/tenants/[tenantId]` with `{ slack_alert_webhook_url: <value> }`.
  - Clear calls same with `{ slack_alert_webhook_url: "" }`.
  - "Connected" badge when `hasWebhook === true`.
- The "Send test alert" button (U6) will be added in this same component but its handler is implemented under U6.

**Patterns to follow:**
- `src/app/admin/(dashboard)/settings/clawsouls-section.tsx` (exact structural template).
- `src/app/admin/(dashboard)/settings/page.tsx` for how to read `has_slack_alert_webhook` from the GET payload.

**Test scenarios:**
- Test expectation: none — view-only React component with no novel logic. Behavior is covered by the U4 API tests; UI smoke is verified manually per the Verification section.

**Verification:**
- Manual: load `/admin/settings`, paste a webhook URL, save, see the badge flip to "Connected", refresh and confirm the badge stays. Click "Clear" and confirm the badge disappears.
- Type checks pass under `npm run build`.

---

### U6. Admin "Send test alert" endpoint + button

**Goal:** Operator-facing roundtrip-test path. POST sends a fixed-payload Slack message ("This is a test alert from AgentPlane") using the saved webhook, and the UI surfaces success/failure inline.

**Requirements:** R2 (the "test-fire" half)

**Dependencies:** U2, U4, U5

**Files:**
- Create: `src/app/api/admin/tenants/[tenantId]/slack-alerts/test/route.ts`
- Modify: `src/app/admin/(dashboard)/settings/slack-alerts-section.tsx` (add button + result rendering)
- Test: `tests/unit/admin-slack-alerts-test.test.ts`

**Approach:**
- Endpoint: `POST /api/admin/tenants/[tenantId]/slack-alerts/test`. Loads the tenant, decrypts the URL, builds a fixed test payload via the same `postSlackMcpFailureAlert` helper but with `agentName: "(test alert)"`, `serverName: "(test alert)"`, `errorMessage: "This is a test alert from AgentPlane. If you can read this, your webhook is configured correctly."`, `agentId` synthetic.
- Response: `{ ok: true }` on 2xx, `{ ok: false, status: <int>, message: <string> }` on Slack 4xx/5xx, 400 if no URL configured. Helper currently swallows errors; for THIS endpoint we want a result, so call `fetch()` directly with the same timeout — accept the small duplication, or refactor `postSlackMcpFailureAlert` to optionally return a `{ ok, status }` shape (preferred).
  - Decision deferred to U2 implementation time: refactor U2's helper to internally compute and return `{ ok: boolean; status?: number | 'timeout' | 'network_error' }`. The `after()` call site in U3 ignores the return; the test endpoint surfaces it.
- UI: button rendered next to "Save" when `hasWebhook === true`. POSTs the test endpoint. Renders result inline (green "Test alert sent" / red "Failed: <message>"), auto-clears after 5s.

**Patterns to follow:**
- Existing admin POST endpoints under `src/app/api/admin/` for the route shape and `withErrorHandler`.
- Toast/inline-result patterns elsewhere in the settings page.

**Test scenarios:**
- Happy path: webhook configured, fetch returns 200 → endpoint returns `{ ok: true }`.
- Error path: webhook configured, fetch returns 404 → endpoint returns `{ ok: false, status: 404 }`.
- Error path: no webhook configured → endpoint returns 400 with `not_configured` code.
- Edge case: timeout (mock AbortController firing) → endpoint returns `{ ok: false, status: 'timeout' }`.

**Verification:**
- All test scenarios pass.
- Manual: paste a working webhook, click "Send test alert", see message in Slack and "Test alert sent" inline.
- Manual: paste a syntactically valid but dead webhook (`https://hooks.slack.com/services/T0/B0/zzz`), click test, see "Failed: 404" inline.

---

## System-Wide Impact

- **Interaction graph:** new write path on `tenants` (admin PATCH); new read path inside the dispatcher's MCP setup (`buildMcpConfig`); new outbound HTTP call (Slack); new admin route under `/api/admin/tenants/[tenantId]/slack-alerts/test`.
- **Error propagation:** dispatcher path is fire-and-forget — any helper failure logs and ends. Admin PATCH path returns 400 on validation failure, 500 on encryption failure (matches existing `subscription_token` shape).
- **State lifecycle risks:** the `was_active` transition gate is the single source of truth for "should we notify". If U3's CTE returns the wrong value (e.g., on row not found), we miss notifications but never duplicate them. Test scenario covers this.
- **API surface parity:** none — `slack_alert_webhook_url` is an admin-only field. Public/A2A/SDK API is unchanged.
- **Integration coverage:** U3's "configured tenant + token refresh failure → exactly one Slack call" scenario is the integration test that proves the wiring end to end.
- **Unchanged invariants:**
  - `mcp_connections.status` enum and transitions are unchanged.
  - `buildMcpConfig()` return shape (servers/errors) is unchanged.
  - Run latency is unchanged: notification dispatch happens in `after()`, not in the request path.
  - Existing `markConnectionFailed` callers (only the one site in `mcp.ts`) are migrated in lockstep with U3.

---

## Risks & Dependencies

| Risk | Mitigation |
|------|------------|
| `after()` doesn't fire when called transitively from `buildMcpConfig()` outside a route-handler stack (e.g., from a script). | Only the dispatcher calls `buildMcpConfig`, and the dispatcher is only invoked from route handlers and cron handlers (both are request contexts). The notification is best-effort; if `after()` no-ops in some unforeseen context, the connection is still marked failed and the next-run path will retry. |
| Slack incoming webhook is rate-limited (1 msg/sec per webhook). | Failure transitions are inherently rare — once a connection is failed, it stays failed until re-authorized. The transition gate prevents loop-storming. If we ever hit it, we add a per-webhook in-process throttle. |
| Webhook URL leakage via logs. | Helper logs status code + error class only, never the URL. Encryption at rest is mandatory (no plaintext column). PATCH responses never echo the URL back; GET only exposes a `has_slack_alert_webhook` boolean. |
| CTE-based RETURNING returns the wrong value if Postgres reorders the subquery. | The pattern (`WITH prev AS (... FOR UPDATE)`) is standard and well-tested; the `FOR UPDATE` clause prevents the row from being read after the UPDATE. Verified via the U3 idempotency test scenario. |
| Operator pastes a Discord/Teams webhook URL. | `validateSlackWebhookUrl` regex pinned to `hooks.slack.com/services/...` rejects it at PATCH time with a clear error. |
| Race: the row transitions to `failed` from two parallel runs, both seeing `was_active=true`. | `FOR UPDATE` in the CTE serializes the read+write per row. Whichever transaction commits second sees `status='failed'` already and gets `was_active=false`. |

---

## Documentation / Operational Notes

- **CLAUDE.md update**: add `slack_alert_webhook_url_enc` to the `tenants` table column list under Database section.
- **Settings UI screenshot** in PR description (the section is the user-visible artifact).
- **Runbook**: not warranted for v1 — the failure mode is "Slack message didn't arrive", and the fix is "click 'Send test alert'". Add a runbook page only if operator feedback shows recurring confusion.
- **Monitoring**: no new metrics. The existing structured logger already tags `Failed to build custom MCP config` with `agent_id` / `mcp_server_id` — searchable in Vercel logs. Notification-dispatch logs add `slack_alert: { status }`.

---

## Sources & References

- Failure-detection site: `src/lib/mcp.ts:148`
- Transition write site: `src/lib/mcp-connections.ts:521`
- Encryption helper: `src/lib/crypto.ts:69`
- Admin tenants PATCH: `src/app/api/admin/tenants/[tenantId]/route.ts:62`
- UI section template: `src/app/admin/(dashboard)/settings/clawsouls-section.tsx`
- `after()` reference usage: `src/app/api/webhooks/slack/route.ts:287`
- Slack incoming webhooks docs: <https://api.slack.com/messaging/webhooks>
