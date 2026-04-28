# Webhook payload filter — requirements

**Date:** 2026-04-27
**Status:** Brainstorm complete, ready for planning
**Scope:** Standard

## Problem

Each `webhook_sources` row binds one signed inbound URL to one agent + one prompt template. After signature verification (and the new content-dedupe layer), **every** delivery triggers a run. Senders like Linear emit a wide range of events on the same webhook URL — `Issue.create`, `Issue.update`, `Comment.create`, `Reaction.create`, etc. — but a given agent typically only cares about a narrow slice (e.g. "newly-created issues with label X").

Today, the only ways to filter are:

- **In-prompt filtering** — agent reads the payload, decides "not for me", exits. Burns budget on every event.
- **External pre-processing** — pipe webhooks through some intermediary (n8n, Zapier, etc.) before they hit AgentPlane. High operational overhead.
- **Multiple webhook sources for the same URL** — not possible; senders emit one URL per integration.

We need server-side filtering on the ingress route: drop deliveries that don't match the source's filter rules **before** `createRun` is called, with full audit trail so admins can see what was filtered and why.

The filter must be fully configurable from the admin UI — no hardcoded provider rules, no fixed schemas, no "just `action == "create"`". Tenants need to express arbitrary boolean conditions over arbitrary payload paths.

## Goals

- R1. Per-source filter rule list, configured from the admin webhook source UI. When non-empty, only deliveries that satisfy the rules trigger a run.
- R2. Rules are tenant-editable strings: dot-path field reference + operator + value, composed via AND/OR groups.
- R3. Audit trail: every filtered delivery is recorded in `webhook_deliveries` with a flag indicating the rule that filtered it. Admins can answer "why didn't this delivery trigger a run?".
- R4. **Failure-open semantics for malformed rules**: a misconfigured rule does not block legit events. If extracting a field path throws, treat the rule as "not matched" and log a warning. (See open question on filter-error policy below — admin may prefer "deny all unmatched" instead.)
- R5. Empty rule list = no filtering (every verified delivery runs the agent — current behavior preserved).
- R6. The sender sees a uniform `200 { run_id: null, accepted: false, filtered: true }` response on filtered deliveries (or `202` like today — see open questions). Senders should not be able to tell *why* a delivery was filtered (no payload-shape disclosure to non-authenticated callers).

## Non-goals

- No code execution / sandboxed JavaScript expressions. Tightly-scoped operator set only.
- No regex matching at v1 (revisit if a real need surfaces — `contains` covers most string-shape needs).
- No "transform the payload" stage — filter only decides go/no-go.
- No per-tenant default rules. Filtering is per-source, period.
- No replaying a filtered delivery later (no "force-run" header).
- No nested rule groups beyond two levels (top-level AND/OR over groups, group has flat list of conditions). Saves UI complexity; deep nesting is rarely needed.

## Behavior

1. Webhook arrives at `/api/webhooks/{source_id}`.
2. Existing pipeline runs unchanged through rate-limit, signature verify, JSON parse, content-dedupe.
3. If the source has no filter rules: pipeline continues as today.
4. If the source has filter rules:
   - Evaluate the rule expression against the parsed payload.
   - **Match → continue** to `createRun` (same as today).
   - **No match → record the delivery** with `filtered: true` and the matched-against rule id, return `200 { run_id: null, accepted: false, filtered: true, status_url: null }`, skip `createRun`.
5. The deliveries audit list shows filtered rows with a "filtered" badge, the rule that didn't match, and the actual payload (so admins can debug their rules against real data).

## Filter expression model

A source's filter is a **single boolean expression**:

```
expression = group
group      = { combinator: "AND" | "OR", conditions: condition[] }
condition  = { keyPath, operator, value }
```

A group's `conditions` array is **flat** — at most one level of `combinator`. The top-level expression is one group. Senders configure exactly one combinator per source ("all of these" or "any of these"). If they need both, they nest at the next level — but that's deferred (see Non-goals).

### Operators (v1)

| Operator | Type | Description |
|---|---|---|
| `equals` | string, number, boolean | Exact match. Type coerced from `value` JSON parse. |
| `not_equals` | same | Inverse. |
| `contains` | string, array | Substring (string) or element membership (array). Case-sensitive. |
| `not_contains` | same | Inverse. |
| `in` | comma-separated value list | Field value is one of the listed values. Sugar for `equals` OR-group. |
| `exists` | n/a | Field path resolves to a non-null, non-undefined value. |
| `not_exists` | n/a | Field path is null/undefined/missing. |

`value` is a JSON-typed scalar entered as a string in the UI (with type pickers for booleans/numbers). The evaluator coerces sensibly: `"true"` becomes `true`, `"42"` becomes `42`, anything quoted is a string.

### Examples

Linear: only run on issue creates with priority Low:
```
combinator: AND
conditions:
  - { keyPath: "action",        operator: equals, value: "create" }
  - { keyPath: "type",           operator: equals, value: "Issue" }
  - { keyPath: "data.priority",  operator: equals, value: "4" }
```

GitHub: only run on PRs targeting main, opened or reopened:
```
combinator: AND
conditions:
  - { keyPath: "action",         operator: in,     value: "opened,reopened" }
  - { keyPath: "pull_request.base.ref", operator: equals, value: "main" }
```

Slack: ignore bot messages:
```
combinator: AND
conditions:
  - { keyPath: "event.bot_id", operator: not_exists }
  - { keyPath: "event.type",   operator: equals, value: "message" }
```

## Admin UI (per webhook source)

In the New / Edit webhook dialog (and as a section on the webhook source detail row when expanded):

- **Empty state**: "No filters — every verified event triggers a run. Add a filter to narrow what fires the agent."
- **Filter editor**:
  - Combinator toggle: "Match ALL conditions" / "Match ANY condition" (top-level AND/OR).
  - List of conditions, each row: `Field path` text input · operator dropdown · value text input · delete button.
  - "Add condition" button.
  - Live "test against last delivery" panel (deferred to a follow-up — nice-to-have, not v1).
- **Save**: validates each condition (key_path regex, operator vs value type) and persists.
- **Per-source row badge** (in the webhooks-manager list): when filters exist, show "Filtering: N condition(s) (ALL|ANY)" with a small chevron to expand the rule list inline.

## Audit trail

Each filtered delivery becomes a row in `webhook_deliveries` (existing audit table) with:

- `valid: true` — the request was well-formed and signed; it just didn't match the filter.
- `filtered: true` (new column).
- `filtered_by_rule_id` (new column, optional) — which rule was the deciding factor for the no-match. Implementation may simplify this to "first failing condition's id" or just record the whole rule-set was unmatched.
- `run_id: null` — no run was created.

Existing dedupe-suppressed deliveries already use `suppressed_by_run_id`. The new flag is parallel — a delivery may be suppressed (dedupe), filtered (no rule match), or accepted (run created).

## Edge cases

- **Filter rule references a path that doesn't exist in this payload**: `exists` → false, `not_exists` → true, all comparison operators → false. Same as content-dedupe failure-open semantics.
- **Combination with dedupe**: dedupe runs first (it's the cheaper check, and a dedupe hit means we already have an answer). If the dedupe-suppressed delivery would also have been filtered out, the sender sees the dedupe response, not the filter response. Order of audit recording: dedupe-suppression takes precedence.
- **Empty conditions list with combinator set**: treated as "no filter applies" — passes through.
- **Filter applies on the duplicate `delivery_id` path?**: No. If `recordDelivery` returns `kind: "duplicate"`, we already know the answer from the prior run — the existing 200 response stands. Filter only runs on freshly-inserted deliveries.

## Out of scope

- Live rule-tester panel ("paste a payload, see if it matches"). Useful but not required for v1.
- Versioned rule history.
- Multi-source / cross-source rules.
- Filter expressions referencing request headers (only payload fields).
- Provider-shipped default filters (analogous to dedupe defaults). Filters are inherently agent-specific — not provider-shaped.
- Forwarding filtered events to a different agent / sink.

## Resolved decisions

- **Schema shape**: JSONB column `filter_rules` on `webhook_sources` (one document per source). Edited as a unit; no normalized rule table.
- **Filter-error policy**: drop with audit. A genuine evaluator error (not just a missing field) records the delivery with `filtered: true` and an error annotation, and the sender gets the same 200 response as a normal mismatch. R4 stands — failure-open is for *missing fields*, not for *broken evaluators*. Admins can spot the broken rule via the audit row's error annotation.
- **Response status on filter mismatch**: `200`. Filter mismatch is a terminal "we read your event and chose not to act on it" outcome, not "accepted-for-async-work". The 202 path is reserved for deliveries that will produce a run.

## Open questions for planning

- (none — all settled in brainstorm.)

## Dependencies / assumptions

- Builds on the existing `webhook_deliveries` audit table.
- Reuses the dot-path key extractor from `src/lib/webhook-dedupe.ts` (extracted into a shared helper or stays separate; planning will decide).
- The admin UI builds on `src/app/admin/(dashboard)/agents/[agentId]/webhooks-manager.tsx` patterns for table rows + edit dialogs.
- Assumes the volume of filtered deliveries does not balloon `webhook_deliveries` — if it does, a retention policy becomes necessary, but it's not a v1 concern.
