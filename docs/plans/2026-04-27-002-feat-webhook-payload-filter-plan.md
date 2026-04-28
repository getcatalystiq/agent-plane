---
title: "feat: Webhook payload filter"
type: feat
status: active
date: 2026-04-27
origin: docs/brainstorms/2026-04-27-webhook-payload-filter-requirements.md
---

# feat: Webhook payload filter

## Overview

Add per-source payload filtering to the webhook ingress pipeline. After signature verification and content-dedupe, evaluate a tenant-defined boolean expression against the parsed payload. Drop deliveries that don't match — record them in `webhook_deliveries` with a `filtered: true` flag, return `200` to the sender, never invoke `createRun`. Empty rule list preserves today's "every verified event runs the agent" behavior.

The filter is a single AND/OR group over a flat list of `{ keyPath, operator, value }` conditions. Operators at v1: `equals`, `not_equals`, `contains`, `not_contains`, `exists`, `not_exists`. Stored as a JSONB document on `webhook_sources`. Tenants edit it from the New / Edit webhook dialog in the admin UI; the per-source row badge surfaces "Filtering: N condition(s) (ALL|ANY)" when rules are configured.

---

## Problem Frame

A `webhook_sources` row binds one signed inbound URL to one agent + prompt template. Senders like Linear emit a wide range of events on the same URL (`Issue.create`, `Issue.update`, `Comment.create`, `Reaction.create`). Today, every verified delivery triggers a run. Today's workarounds — filtering inside the agent prompt, external pre-processing, multiple webhook sources — all leak budget or operational overhead.

Server-side filtering on the ingress route is the right layer: cheap to evaluate, decision happens before sandbox spin-up, full audit trail for "why didn't this delivery trigger a run?".

See origin: `docs/brainstorms/2026-04-27-webhook-payload-filter-requirements.md`.

---

## Requirements Trace

- R1. Per-source filter rule list edited from the admin webhook source UI; when non-empty, only matching deliveries trigger a run.
- R2. Rules are tenant-editable: dot-path field reference + operator + value, composed via top-level AND/OR.
- R3. Audit trail: every filtered delivery is recorded in `webhook_deliveries` with `filtered: true` and the rule context, queryable from admin.
- R4. **Failure-open for missing fields only.** A payload path that doesn't exist makes the condition `false` (or `true` for `not_exists`); the evaluator never throws. Genuine evaluator errors (parse failures, type errors, anything else) are a separate failure mode: caught, audited as `filtered: true` with `filtered_reason` starting `evaluator_error:`, and the sender receives the standard 200 response (no run created). See Key Technical Decisions / Evaluator-error policy.
- R5. Empty rule list = current behavior preserved (every verified delivery runs the agent).
- R6. Sender-facing response on filter mismatch: `200 { run_id: null, accepted: false, filtered: true, status_url: null }`. **Senders can distinguish a `202` (run created) from a `200 + filtered: true` (filter mismatched), which leaks the existence of a filter rule but not its shape.** This trade-off is accepted for debuggability; a sender probing rule structure by sending varied payloads is an unlikely threat against signed inbound webhooks. If a tenant treats their filter rules as sensitive, they should not rely on response distinguishability for security.
- R7. Filter runs **after** content-dedupe. Dedupe-suppressed deliveries take the existing dedupe-response path; they do not also evaluate the filter.

---

## Scope Boundaries

- No code execution / sandboxed JS expressions in filter values.
- No regex matching at v1 (`contains` covers most string-shape needs).
- No nested rule groups beyond two levels (top-level combinator over a flat list of conditions).
- No live "test against last delivery" panel in the UI at v1.
- No filter-versioning / history.
- No filter expressions referencing request headers — payload fields only.
- No provider-shipped default filters (filters are agent-specific, not provider-shaped).
- No "transform the payload" stage — filter only decides go/no-go.
- No "force-run" header for replay of a filtered delivery.

### Deferred to Follow-Up Work

- **Per-source filtered count (last 7 days) inline in the source list** — originally scoped as U6, now deferred. R3 is satisfied by U3's audit trail alone; admins debug filtered deliveries via SQL or future audit-browsing UIs during the v1 soak window. Add this surface once we know how often filters actually misfire in production.
- Live rule-tester ("paste a payload, see if it matches") — useful but not v1.
- Versioned rule history.
- Filter-error escape hatch (per-source policy on evaluator errors) — current default is "drop with audit".
- `in` operator (set-membership). Expressible today as OR-chained `equals`. Re-evaluate if real tenant rules need it after launch.

---

## Context & Research

### Relevant Code and Patterns

- `src/app/api/webhooks/[sourceId]/route.ts` — ingress POST handler. Hot path: rate-limit → load source → verify signature → parse JSON → content-dedupe → `recordDelivery` → `buildPromptFromTemplate` → `createRun` via `after()`. New filter step lands between dedupe and `createRun`.
- `src/lib/webhooks.ts` — `recordDelivery()` was just extended with `dedupeKey`; this plan extends it again with `filtered` + filter context. Same pattern, same insert.
- `src/lib/webhook-dedupe.ts` — has `extractDedupeKey` (dot-path walker). The filter evaluator can either reuse it directly or copy the pattern into `src/lib/webhook-filter.ts`. Plan-of-record: extract the dot-path walker into a shared helper to avoid drift.
- `src/db/migrations/029_webhook_triggers.sql` — defines `webhook_sources` + `webhook_deliveries`. Migration 031 already added `dedupe_key` + `suppressed_by_run_id` to `webhook_deliveries`. Migration 032 adds two more.
- `src/app/admin/(dashboard)/agents/[agentId]/webhooks-manager.tsx` — admin UI that owns the webhook source list, create dialog, edit flow. Filter editor is a new section inside the existing create/edit dialog.
- `src/lib/validation.ts` — Zod schemas for create/update webhook source. Filter rule schema lands here.
- `tests/unit/webhook-dedupe.test.ts` — pattern for testing pure evaluator helpers with mocked DB layer.
- `tests/unit/api/webhooks-ingress.test.ts` — pattern for testing the ingress route's branching paths (after `next/server` `after()` mock that we already added).
- `tests/unit/api/webhooks-crud.test.ts` — pattern for testing tenant CRUD routes.

### Institutional Learnings

- The webhook ingress hot path is response-time-sensitive (Linear retries within ~5s). The filter step is in-memory CPU only — no DB calls — so cost is negligible. Fits within the existing budget.
- Existing convention: `recordDelivery` is the single insert for the audit row, with `dedupeKey` already optional. Adding `filtered` + `filteredReason` keeps that one-insert pattern.
- Admin UI pages are dark-mode-only. Filter editor uses existing `Input` / `FormField` / `Button` / `Dialog` primitives from `src/components/ui/`.

### External References

- None. The pattern is standard webhook-receiver event filtering. Local patterns suffice.

---

## Key Technical Decisions

- **Storage on `webhook_sources`**: a single nullable `filter_rules JSONB` column. Edited as a unit; no normalized rule table. Validates against a Zod schema on save and on every evaluation.
- **Audit columns on `webhook_deliveries`**: add `filtered BOOLEAN NOT NULL DEFAULT false` and `filtered_reason TEXT NULL`. `filtered_reason` records the failing-condition summary (e.g. `condition_no_match: data.action != "create"` or `evaluator_error: <message>`) for admin debugging.
- **Filter sequencing**: dedupe runs first (existing); filter runs second; `createRun` runs third. Dedupe-suppressed deliveries skip the filter check (the original delivery already decided). This preserves the simpler "filter only on freshly-inserted deliveries" rule from the brainstorm.
- **Evaluator location**: new `src/lib/webhook-filter.ts` with pure helpers — `evaluateFilter(rules, payload)`, `validateFilterRules(rules)`, plus the operator implementations. Tests against a mocked DB-free surface.
- **Dot-path walker reuse**: extract `walkDotPath(payload, path): unknown` into `src/lib/webhook-filter.ts` (or a new `src/lib/payload-path.ts`). The dedupe code's `extractDedupeKey` becomes a thin wrapper that adds the "non-empty string" check on top. Avoids two diverging walkers; both modules import the same primitive.
- **Operator value coercion**: the UI stores `value` as a string; the evaluator applies a locked policy (case-sensitive comparison, no whitespace trim, `"true"`/`"false"` → boolean, numeric strings parsed via `Number()` only when the payload field is also a number). Coercion lives in the evaluator, not the schema, so the rule remains JSON-typed but is interpreted at evaluation time. See U2 Approach for the full coercion rules.
- **Failure-open semantics for missing paths**: `walkDotPath` returns `undefined` for any miss. Operators against `undefined`: `equals`/`not_equals`/`contains`/`not_contains` → `false`; `exists` → `false`; `not_exists` → `true`. No throw.
- **Evaluator-error policy**: any throw inside `evaluateFilter` is caught at the route level. The delivery is recorded as `filtered: true, filtered_reason: "evaluator_error: <message>"` and the sender gets the standard 200 response. (Per resolved decision: failure-open is only for missing fields, not for broken rules.)
- **Sender response**: filter mismatch returns `200 { run_id: null, accepted: false, filtered: true, status_url: null }`. The 202 path is reserved for deliveries that will produce a run; 200 means "we read your event and chose not to act on it."
- **Persistence shape on the wire**: `filter_rules` is shipped to the client as the same JSONB shape it's stored in. Client edits the rule tree and sends it back wholesale on save. No partial-update API — admin always replaces the whole rule set.
- **Concurrent edits**: not a concern at v1 (single admin per tenant in practice). Last write wins.

---

## Open Questions

### Resolved During Planning

- **Where does the rule editor live in the UI?** Inside the existing New / Edit Webhook dialog as a new collapsible section, not a separate dialog or sub-page. Same edit transaction as name / signature header / prompt template.
- **Combinator scope**: a top-level combinator (`AND` / `OR`) over a flat list of conditions. No nested groups at v1. Brainstorm's "two levels" hedge is deferred — flat is enough for the use cases we have.
- **What does the audit log show for a filtered delivery?** `filtered: true`, `filtered_reason: <string>`, `valid: true`, `run_id: null`. The deliveries audit list (when it exists) shows a "Filtered" badge with the reason on hover.
- **Is the dot-path walker shared with dedupe?** Yes — extracted to `src/lib/webhook-filter.ts` or a new `src/lib/payload-path.ts`; dedupe imports it.

### Deferred to Implementation

- Final placement of the dot-path walker (`src/lib/webhook-filter.ts` vs new `src/lib/payload-path.ts`). Both work; the implementer picks based on whether other modules are likely to need it.
- Exact wording of `filtered_reason` strings. Implementer chooses readable forms; not load-bearing for behavior.
- Whether the per-source badge expands inline to show the rule list, or just opens the edit dialog on click. Either is fine; default to opening the dialog.

---

## Implementation Units

- U1. **Migration 032: filter columns**

**Goal:** Add the storage layer for filter rules and filter audit.

**Requirements:** R1, R3.

**Dependencies:** None.

**Files:**
- Create: `src/db/migrations/032_webhook_filter.sql` (chains after `031_webhook_dedupe.sql`, the current latest migration; sequential numbering, RLS already on the affected tables).
- Test expectation: none — pure schema change. Migration runs in CI on every deploy.

**Approach:**
- Add `filter_rules JSONB NULL` to `webhook_sources`. Nullable preserves the "no filter" default.
- Add `filtered BOOLEAN NOT NULL DEFAULT false` to `webhook_deliveries`.
- Add `filtered_reason TEXT NULL` to `webhook_deliveries`.
- All `IF NOT EXISTS` so re-runs are safe.
- No new index — filter audit is queried per-source via the existing `(source_id, created_at DESC)` index.

**Patterns to follow:**
- `src/db/migrations/031_webhook_dedupe.sql` for shape of nullable column adds + RLS-already-on-table.

**Verification:**
- `npm run migrate` applies cleanly to a fresh and an upgraded database.
- `\d webhook_sources` shows `filter_rules`.
- `\d webhook_deliveries` shows `filtered` + `filtered_reason`.

---

- U2. **Filter rule schema + evaluator**

**Goal:** Encode the filter rule shape in Zod, implement the evaluator, and ship the dot-path walker.

**Requirements:** R2, R4.

**Dependencies:** U1.

**Files:**
- Create: `src/lib/webhook-filter.ts`
- Modify: `src/lib/validation.ts` (add `FilterRulesSchema`)
- Modify: `src/lib/webhook-dedupe.ts` (replace inline walker with import from filter module if extracted there; otherwise leave alone)
- Test: `tests/unit/webhook-filter.test.ts`

**Approach:**
- Define types: `FilterCondition = { keyPath, operator, value? }`, `FilterRules = { combinator: "AND" | "OR", conditions: FilterCondition[] } | null`.
- Operators enum (6 total): `equals`, `not_equals`, `contains`, `not_contains`, `exists`, `not_exists`. **`in` is intentionally not included** — set-membership is expressible as OR-chained `equals`. Dropping `in` removes a class of comma-escape edge cases at no expressive cost.
- **Display-label map** for the admin dropdown (locked here so UI doesn't render snake_case): `equals` → "Equals", `not_equals` → "Does not equal", `contains` → "Contains", `not_contains` → "Does not contain", `exists` → "Exists (any value)", `not_exists` → "Is missing". Define this in `src/lib/webhook-filter.ts` and import from the UI.
- `walkDotPath(payload, path)` — returns the leaf value or `undefined`. Inline a fresh 10-line implementation in `src/lib/webhook-filter.ts`. **The dedupe `extractDedupeKey` is left as-is — it already does dot-path walking with a non-empty-string check baked in.** No shared-helper extraction at v1; defer until a third consumer arrives.
- `evaluateCondition(condition, payload): boolean` — dispatches on `operator`, applies a **locked coercion policy**:
  - String comparisons (`equals`, `not_equals`, `contains`, `not_contains`) are **case-sensitive**. No whitespace trimming.
  - For `equals` / `not_equals`: if `value` is the literal string `"true"` or `"false"`, coerce to boolean. If `value` parses as a finite number via `Number()` AND the payload field is a number, compare as numbers. Otherwise compare as strings.
  - `contains` / `not_contains`: works on strings (substring) and arrays (`.includes` element match). On any other type → `false`. No throw.
  - `exists` returns `true` if the path resolves to a value that is not `undefined` and not `null`. `not_exists` is the inverse.
- `evaluateFilter(rules, payload): { matched: boolean, failingCondition?: FilterCondition, error?: string }` — returns `{ matched: true }` if rules are null / empty conditions / all conditions match (AND) or any matches (OR). Returns `{ matched: false, failingCondition }` for normal mismatch and `{ matched: false, error }` on internal exception. **The evaluator owns all try/catch — callers never see a throw.** The route in U3 treats both branches identically: writes `filtered: true` with the appropriate reason, returns 200.
- Zod `FilterRulesSchema`: nullable; when present, validates `combinator` is `AND`|`OR`, conditions array is **0..50 items** (length 0 is valid and evaluates as matched, preserving backward compatibility with sources that have a rule object but no conditions), each condition has key_path matching the same regex as dedupe (`^[a-zA-Z_][a-zA-Z0-9_]{0,63}(\.[a-zA-Z_][a-zA-Z0-9_]{0,63}){0,9}$`), operator from the enum, value optional (required for non-existence operators). The evaluator additionally guards `conditions.length > 50` defensively (DB-direct writes that bypass Zod still cap at 50; excess conditions evaluate as `error: "condition_cap_exceeded"`).
- `FilterRulesSchema` is defined once in `src/lib/validation.ts` and exported. U4 imports it; no separate redefinition.

**Patterns to follow:**
- `src/lib/webhook-dedupe.ts` for module shape — pure helpers, Zod schemas, no imports from `src/app/`.
- `src/lib/validation.ts` for where the schema lives.

**Test scenarios:**
- Happy path: `data.action == "create"` against `{ data: { action: "create" } }` → matched.
- Happy path: AND with two matching conditions → matched.
- Happy path: OR with one of three matching → matched.
- Happy path: `exists` against present non-null path → matched. `not_exists` against missing path → matched.
- Edge case: empty conditions array → matched (no filter applies).
- Edge case: null rules → matched.
- Edge case: missing key path with `equals` → not matched (failure-open).
- Edge case: missing key path with `not_exists` → matched.
- Edge case: type coercion — `value: "42"` against numeric `42` → matched. Against string `"42"` → matched. Against numeric `43` → not matched.
- Edge case: `contains` on string substring → matched. `contains` on array element → matched. `contains` on number → not matched (fail clean, no throw).
- Edge case: case-sensitivity — `equals "create"` against payload `"Create"` → not matched (case-sensitive).
- Edge case: numeric-vs-string coercion — `equals "42"` against payload number `42` → matched (both parse as 42). Against payload string `"42"` → matched. Against payload string `" 42 "` → not matched (no whitespace trim).
- Error path: payload is not an object → all comparison operators return false; `not_exists` returns true.
- Error path: an operator the schema doesn't allow (only reachable if rules are written directly to the DB) → evaluator returns `{ matched: false, error: "unknown_operator" }`, no throw.
- Schema validation: invalid `key_path` (special chars, leading dot, trailing dot, double dot) → Zod parse fails.
- Schema validation: > 50 conditions → fails.
- Schema validation: missing `value` for `equals` → fails.
- Schema validation: extraneous `value` for `exists` / `not_exists` → ignored or rejected (implementer chooses; cover whichever is shipped).

**Verification:**
- All test cases pass.
- No imports from `src/app/` (lib code stays UI-tree-free).
- `evaluateFilter` never throws on adversarial payload shapes (covered by error-path tests).

---

- U3. **Wire filter into ingress route**

**Goal:** Run the filter between dedupe and `createRun`. Persist filter outcome on the delivery row. Short-circuit with the standard 200 response on mismatch.

**Requirements:** R1, R3, R4, R5, R6, R7.

**Dependencies:** U1, U2.

**Files:**
- Modify: `src/lib/webhooks.ts` — extend `recordDelivery` to accept `filtered` and `filteredReason`; update `WebhookDeliveryRow` Zod.
- Modify: `src/app/api/webhooks/[sourceId]/route.ts` — call `evaluateFilter(source.filter_rules, payload)` after the dedupe step; on `matched: false` write the filtered audit row and return the standard 200 response.
- Modify: `src/lib/webhooks.ts` — extend `WebhookSourceRow` Zod with `filter_rules: FilterRulesSchema.nullable()`.
- Test: `tests/unit/api/webhooks-ingress.test.ts` (extend with new scenarios).

**Approach:**
- Inside the route, after the dedupe short-circuit (the existing `if (dedupeContext.key && dedupeContext.rule) { ... }` block) and before `buildPromptFromTemplate`:
  - Call `evaluateFilter(source.filter_rules, payload)` from U2. The evaluator owns try/catch and never throws — it returns `{ matched: true }`, `{ matched: false, failingCondition }`, or `{ matched: false, error }`.
  - If `matched === false`:
    - Call `markDeliveryFiltered(deliveryRowId, reason)` (UPDATE on the already-inserted row — `recordDelivery` already inserted it earlier in the route, mirroring how `markDeliverySuppressed` works for dedupe).
    - The `reason` string is `condition_no_match: <keyPath> <operator> <value>` for normal mismatches, or `evaluator_error: <message>` for the error branch.
    - Log `webhook_filter_dropped { source_id, reason, failing_condition }` at info level.
    - Return `200 { run_id: null, accepted: false, filtered: true, status_url: null }`.
    - Skip `buildPromptFromTemplate` and the `after()` callback.
- If `matched === true`: pipeline continues as today.
- **Plan-of-record:** insert-then-UPDATE pattern, not insert-with-flag. `recordDelivery` continues to insert with `filtered: false` (its column DEFAULT); `markDeliveryFiltered` is the only place that flips the flag, mirroring `markDeliverySuppressed`. Avoids a two-headed write path on the existing audit row.
- Dedupe-suppressed deliveries leave `filtered = false` (the column DEFAULT) — the dedupe branch never invokes the filter.
- Update `WebhookSourceRow` Zod schema in `src/lib/webhooks.ts` to include `filter_rules: FilterRulesSchema.nullable()`. **Also update `PublicWebhookSourceRow` and `PUBLIC_SOURCE_COLUMNS`** so the column round-trips through `listWebhookSources`, `getWebhookSource`, and `updateWebhookSource` — without these the CRUD layer silently drops `filter_rules` even after migration 032 lands. Add `filter_rules` to the SELECT list in `loadWebhookSource` too.

**Patterns to follow:**
- The dedupe-suppression path in the same route (commit `66d397b`) — same shape: detect, mark audit row, log, return early.
- `markDeliverySuppressed` in `src/lib/webhooks.ts` for the new `markDeliveryFiltered` helper.

**Test scenarios:**
- Happy path: source with no filter rules (`filter_rules: null`) → filter step is a no-op; existing flow proceeds. Same as today.
- Happy path: source with filter, payload matches → run created (verify `createRun` called via `after()` mock).
- Happy path: source with filter, payload does NOT match → response is `200 { run_id: null, accepted: false, filtered: true, status_url: null }`, `createRun` not called, `markDeliveryFiltered` called with the failing-condition summary.
- Edge case: source has filter rules, payload missing the configured field → counted as not-matched, filtered audit written.
- Edge case: source has filter rules + a dedupe rule, dedupe matches a prior delivery → existing dedupe response wins; filter does not run.
- Edge case: source has filter rules but the rule list is empty (`[]`) → matched, run created.
- Error path: filter evaluator throws on adversarial payload → caught at route, `markDeliveryFiltered` called with `evaluator_error: <message>`, sender sees 200 + filtered, no run.
- Error path: signature failure → 401 returned, filter never runs.
- Integration: a filtered delivery row exists with `valid: true`, `filtered: true`, `filtered_reason` populated, `run_id: null`.
- Integration: `attachDeliveryRun` is NOT called when the delivery is filtered.

**Verification:**
- New ingress tests pass.
- Existing ingress tests still pass (no regression in the no-rules path).

---

- U4. **Filter rules in tenant + admin webhook source CRUD**

**Goal:** Accept `filter_rules` on create / update; persist to JSONB; return on read.

**Requirements:** R1, R2.

**Dependencies:** U1, U2.

**Files:**
- Modify: `src/lib/webhooks.ts` — `CreateWebhookSourceSchema`, `UpdateWebhookSourceSchema`, `createWebhookSource`, `updateWebhookSource`, the SELECT column list and the `WebhookSourceRow` projection.
- Modify: `src/app/api/admin/webhooks/route.ts` — pass `filter_rules` from request body into `createWebhookSource`.
- Modify: `src/app/api/admin/webhooks/[id]/route.ts` — pass `filter_rules` into `updateWebhookSource` patch.
- Modify: `src/app/api/webhooks/route.ts` (tenant-scoped) — same.
- Modify: `src/app/api/webhooks/[sourceId]/route.ts` PATCH branch — same.
- Modify: `src/lib/validation.ts` — re-export `FilterRulesSchema` if needed by other modules.
- Test: `tests/unit/api/webhooks-crud.test.ts` (extend).

**Approach:**
- Both `Create` and `Update` Zod schemas accept `filter_rules: FilterRulesSchema.nullable().optional()`. On the wire: **omitted = no change, `null` = clear filter, object = replace with this.** This is a tri-state — the existing CRUD set-builder pattern uses `!== undefined` to push SET clauses, which already maps `null` to a clearing UPDATE and `undefined` to a no-op. Confirm this in `updateWebhookSource` rather than relying on it implicitly.
- `createWebhookSource` writes the JSONB column on insert; `updateWebhookSource` includes it in the SET list when `patch.filter_rules !== undefined` (the existing pattern).
- `PublicWebhookSourceRow` and `PUBLIC_SOURCE_COLUMNS` (defined in `src/lib/webhooks.ts`) both grow by one — `filter_rules` joins the public projection.
- Server-side validation runs the same `FilterRulesSchema` the evaluator uses — a malformed rule set rejects with 400 before reaching the DB.
- `FilterRulesSchema` is imported from `src/lib/validation.ts` (defined in U2); no separate definition lives here.

**Patterns to follow:**
- The existing `signature_header` field flow — same shape: optional in both create/update, persisted as a column, returned on read.

**Test scenarios:**
- Happy path: POST with a valid `filter_rules` object → row created with the JSONB column populated; GET echoes it.
- Happy path: PATCH with `filter_rules: null` → row updated with the column cleared.
- Happy path: PATCH omitting `filter_rules` → existing rules preserved.
- Error path: POST with invalid `filter_rules` (bad operator, > 50 conditions, malformed key_path) → 400 with Zod error message.
- Error path: PATCH with rules pointing at an unknown operator → 400.
- Edge case: admin creates a source with `filter_rules: { combinator: "AND", conditions: [] }` (empty list) → accepted; treated as "no filter" at evaluation time. Decision: schema allows length 0, evaluator treats as matched.

**Verification:**
- New CRUD tests pass.
- Existing CRUD tests still pass.

---

- U5. **Admin UI: filter editor in webhook dialog**

**Goal:** Tenants edit filter rules from the New / Edit Webhook dialog. Per-source row badge surfaces "Filtering: N condition(s) (ALL|ANY)" when rules exist.

**Requirements:** R1, R2.

**Dependencies:** U4.

**Files:**
- Modify: `src/app/admin/(dashboard)/agents/[agentId]/webhooks-manager.tsx` — add a `<FilterEditor>` section inside the existing `<CreateWebhookDialog>` (and Edit dialog if separate). Include a per-row badge in the source list.
- Test expectation: none — UI presentational change. Logical coverage is via U3 / U4 tests.

**Approach:**
- New collapsible "Payload filter" section in the create / edit dialog, below the existing fields. Default collapsed; expanded if rules are present.
- Inside the section:
  - "Match ALL conditions" / "Match ANY condition" radio (`combinator`).
  - Repeating row of: `Field path` (text input) · operator (dropdown) · `Value` (text input, hidden when operator is `exists` / `not_exists`) · delete button.
  - "Add condition" button at the bottom of the list.
  - Inline validation hints per row when the key_path regex fails or value is required but blank.
- "Save" submits the rules along with the existing fields.
- In the source list, when `filter_rules` is non-null and `conditions.length > 0`, render under the source name:
  > Filtering: 3 condition(s) (ALL) · [Edit →]
  ([Edit →] opens the existing edit dialog scrolled to the filter section.)

**Patterns to follow:**
- `src/app/admin/(dashboard)/settings/dedupe-rules-manager.tsx` for the table-of-conditions + add/remove pattern.
- `src/app/admin/(dashboard)/agents/[agentId]/webhooks-manager.tsx` for the existing dialog structure.
- `src/components/ui/form-field.tsx` and `src/components/ui/select.tsx` for inputs.

**Verification:**
- Visual smoke: open create dialog → expand Payload filter → add `data.action equals create` → save → reopen edit → rule reappears.
- Visual smoke: source list shows "Filtering: 1 condition(s) (ALL)" under the row.
- Visual smoke: send a Linear `Issue.update` to a source filtered to `action equals create` → no run created, deliveries audit shows filtered row (this only works if a deliveries page exists — otherwise verify via DB).

---

**(U6 deferred — see Scope Boundaries → Deferred to Follow-Up Work. The U-ID `U6` is reserved; the gap is intentional and stable per the U-ID stability rule.)**

---

## System-Wide Impact

- **Interaction graph:** Only `src/app/api/webhooks/[sourceId]/route.ts` and `src/lib/webhooks.ts` change in the hot path. No new cron, queue, or background job. No new inbound FKs.
- **Error propagation:** Any throw inside `evaluateFilter` is caught at the route boundary; the delivery is recorded as filtered with an `evaluator_error: <msg>` reason. The sender always sees the standard 200 response on filter mismatch — they cannot distinguish "your rule didn't match" from "your rule is broken".
- **State lifecycle risks:** None. The filter is a pure-function check between two existing DB writes (recordDelivery and the optional run-attach update). No partial-write windows.
- **API surface parity:** The `WebhookSourceRow` type grows by one field. Any downstream code (only the admin UI today) that destructures the row needs to be aware of the new field — but this is additive, not breaking.
- **Integration coverage:** U3 ingress tests + U4 CRUD tests cover the cross-layer scenarios end-to-end.
- **Unchanged invariants:** Existing `(source_id, delivery_id)` UNIQUE index, RLS policies on both tables, the dedupe layer, the rate-limit envelope, the `after()` deferred-run pattern — all unchanged. Sources with `filter_rules: null` (the default) behave bit-for-bit identically to today.

---

## Risks & Dependencies

| Risk | Mitigation |
|---|---|
| Tenant configures a filter that drops every event (wrong field name, typo). | `webhook_filter_dropped` and `webhook_filter_evaluator_error` log tags let ops grep / alert. The deferred per-source count (U6 in follow-up) is the eventual inline signal; until then, audit rows are queryable via SQL during the soak window. |
| Filter expression performance — large rule lists evaluated on every delivery. | Capped at 50 conditions per Zod schema; evaluator additionally guards `conditions.length > 50` so DB-direct writes that bypass Zod still bound the loop. Pure CPU, no I/O. Negligible at this scale. |
| Adding `filter_rules` to `loadWebhookSource` SELECT widens the payload. | JSONB and bounded (50 conditions × ~100 bytes = ~5 KB worst case). Acceptable. |
| Tenant misuses operators (e.g. `equals` on an array). | Evaluator returns `false` cleanly, no throw. Filter mismatches but doesn't crash. |
| Broken evaluator silently drops production traffic indefinitely (sender retries succeed at 200, admin doesn't notice). | Distinct `webhook_filter_evaluator_error` log tag. Any non-zero rate is a real bug. The deferred per-source count (U6) will eventually show this inline. |
| Sender can distinguish 202 vs 200+filtered, leaking filter-rule existence. | Accepted. Documented in R6. |
| Order-of-evaluation regression with dedupe. | U3 tests explicitly cover "dedupe match short-circuits before filter" and "filter runs after a no-dedupe-match insert". Dedupe-suppressed deliveries leave `filtered = false` (column DEFAULT). |

---

## Documentation / Operational Notes

- Update `CLAUDE.md` "Patterns & Conventions" section with one short bullet about webhook payload filtering (mirrors the dedupe entry).
- No env var changes.
- No public-API documentation change for senders. The 200 + `filtered: true` response is opaque from the sender's view.
- New admin endpoints (or extended endpoints): no new routes — `filter_rules` flows through the existing webhook source create / update endpoints.
- Monitoring: two distinct `info`-level log tags so operators can separate signal from noise:
  - `webhook_filter_dropped { source_id, failing_condition }` — normal filter mismatch (working as configured).
  - `webhook_filter_evaluator_error { source_id, error }` — evaluator threw or condition cap exceeded (broken rule). Operators should alert on any non-zero rate; broken rules silently drop production traffic indefinitely otherwise.

---

## Sources & References

- **Origin document:** [docs/brainstorms/2026-04-27-webhook-payload-filter-requirements.md](../brainstorms/2026-04-27-webhook-payload-filter-requirements.md)
- Related code: `src/app/api/webhooks/[sourceId]/route.ts`, `src/lib/webhooks.ts`, `src/lib/webhook-dedupe.ts`, `src/db/migrations/029_webhook_triggers.sql`, `src/db/migrations/031_webhook_dedupe.sql`, `src/app/admin/(dashboard)/agents/[agentId]/webhooks-manager.tsx`, `src/app/admin/(dashboard)/settings/dedupe-rules-manager.tsx`
- Related migrations: latest is `031_webhook_dedupe.sql`; this plan adds `032_webhook_filter.sql`.
- Related tests: `tests/unit/webhook-dedupe.test.ts`, `tests/unit/api/webhooks-ingress.test.ts`, `tests/unit/api/webhooks-crud.test.ts`
- Related PRs: #4 (webhook content-based dedupe — most recent webhook-area work).
