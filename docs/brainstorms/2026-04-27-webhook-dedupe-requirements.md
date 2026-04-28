# Webhook content-based dedupe — requirements

**Date:** 2026-04-27
**Status:** Brainstorm complete, ready for planning
**Scope:** Standard

## Problem

Linear is delivering 2+ webhooks per real event. Each retry carries a different `webhookTimestamp`, so they pass the existing `delivery_id`-based idempotency in `webhook_deliveries`, and the agent runs once per duplicate — wasted budget, duplicate side effects (e.g., agent posts the same Slack message twice).

The existing layer:

- `webhook_deliveries.UNIQUE (source_id, delivery_id)` — catches identical retries from senders that send a stable per-delivery id.
- For Linear, `delivery_id` is synthesized from `webhookId + webhookTimestamp`. When Linear varies `webhookTimestamp` between duplicates of the same logical event, this layer is bypassed.

We need a second layer: **content-based dedupe** that hashes a configurable subset of the payload and rejects within a configurable window — implemented as a general service with provider-specific rules.

## Goals

- Drop logical duplicates from Linear within a 60-second window before a run is created.
- Generalize so adding more providers later is a registry entry, not a refactor.
- Mirror the existing 200-duplicate response shape so callers see consistent behavior.

## Non-goals

- No per-source admin override UI. Dedupe is provider-shaped, not tenant-shaped — overrides land as code changes to the registry if a real need surfaces.
- No new admin DB columns on `webhook_sources`. Configuration lives in code.
- No content-dedupe for providers whose existing `delivery_id`-based dedupe already works (GitHub, Stripe/Svix). Those keep using the existing path.

## Admin visibility (required)

Admins cannot configure dedupe per source, but they **must** be able to see that it is happening and what the rule is — otherwise debugging "why didn't this Linear webhook trigger a run?" is opaque.

Surface in the webhook source detail page (`/admin/agents/[agentId]` → webhooks section, or wherever webhook sources render):

- **Status line** when the source's provider preset has a dedupe rule registered:
  > Deduping enabled · key `data.url` · window 60s · provider rule (read-only)
- When no rule applies (preset is generic or unrecognized), no badge / no clutter.
- Tooltip or help text explaining that the rule is set by the platform per provider and is not editable from the UI.
- In the deliveries audit list (if/when one exists), a "deduped" badge on suppressed rows linking to the original run that absorbed this delivery.

This keeps the per-source UI free of editable fields while making the behavior discoverable. If overrides are added later, this is the natural slot to upgrade from read-only to editable.

## Behavior

1. Webhook arrives at `/api/webhooks/{source_id}`.
2. Existing pipeline runs unchanged through rate-limit, signature verify, body parse, and `delivery_id` insert.
3. If the source's provider preset has a dedupe rule registered:
   - Extract the dedupe key from the parsed payload using the configured key path (e.g., `data.url`).
   - If the key extracts cleanly and is non-empty: look up the most recent prior delivery for the same `source_id` whose dedupe key matches and was created within the window.
   - If found: respond with the original run's response shape — `200 { run_id, duplicate: true, status_url }` — and skip `createRun`. The current delivery is still recorded for audit, with a flag indicating it was suppressed and which run it matched.
   - If the key cannot be extracted (path missing, empty, non-string): fall through to the normal `createRun` path. **Failure-open: never drop a legit event because the registry rule didn't match the payload shape.**
4. If no provider rule is registered or the source has no provider preset: pipeline continues unchanged.

## Provider registry — v1

| Provider | Dedupe key path | Window |
|---|---|---|
| `linear` | `data.url` | 60s |

That is the entire registry at v1. Other providers are added when a real duplicate-delivery problem is observed for them.

### Linear key composition — explicit decision

The user accepted the trade-off that **a legit `update` or `remove` event arriving within 60s of a `create` on the same issue will be dropped**. The dedupe key is just `data.url` — not `action + data.url`. The agents this is wired to today only care about the first event for a given Linear issue within the window. Revisit if an agent emerges that needs to react to in-flight updates.

## Storage

Extend `webhook_deliveries` rather than adding a new table — it already has `source_id`, `payload_hash`, `run_id`, `created_at`, and the right RLS posture. Planning will decide between:

- A new nullable `dedupe_key TEXT` column with a partial index `(source_id, dedupe_key, created_at DESC) WHERE dedupe_key IS NOT NULL`, and a nullable `suppressed_by_run_id UUID` to record which prior run absorbed this delivery.
- Reusing `payload_hash` for content matching is **not** sufficient: Linear's duplicates differ in `webhookTimestamp` and `createdAt`, so `payload_hash` differs. We must hash a deterministic projection of the payload (e.g., the extracted key).

Schema specifics are deferred to `/ce-plan`.

## Response semantics

- Sender's view: identical to the existing `delivery_id`-duplicate path — `200 { run_id, duplicate: true, status_url }`. Linear's retry logic stops, no action needed from sender.
- Admin's view: the deliveries audit log shows the suppressed delivery linked to the original run, so an operator debugging "why didn't my agent run twice?" can trace it.

## Edge cases

- **Concurrent duplicates** (T=0 valid + T=200ms duplicate): the second hits while the first is still mid-`createRun`. The window query reads from `webhook_deliveries`, so as long as the first delivery's row insert (with its `dedupe_key`) commits before the second's lookup, the second is suppressed. Planning needs to confirm the first row write happens before the early-return path for the second — likely means writing `dedupe_key` on the same `INSERT ... ON CONFLICT DO NOTHING` call, before `createRun`.
- **Missing/empty key**: failure-open — run the agent. Logged at `info` level so we can spot misconfigured providers.
- **Window edge**: standard sliding window from `now()` back N seconds. No anchor-reset semantics.
- **Disabled source**: existing `genericUnauthorized()` path runs first; dedupe never sees the request.
- **Invalid signature**: same — the verify step rejects before dedupe.

## Out of scope

- Per-source dedupe **editable** configuration UI (read-only display is in scope — see Admin visibility).
- Per-tenant overrides.
- Content-dedupe for providers other than Linear at v1.
- Replaying a previously-suppressed delivery (no "force" header).

## Open questions for planning

- Exact column shape on `webhook_deliveries` (`dedupe_key TEXT NULL` + `suppressed_by_run_id UUID NULL` vs. a single JSONB column).
- Where the registry lives: a typed const map in `src/lib/webhooks.ts` keyed by provider preset slug, returning `{ keyPath, windowSeconds }`.
- Key extraction: simple dot-path walker or a lightweight `lodash.get`-style helper. Probably 10 lines, no dependency.
- Whether `suppressed_by_run_id` writes should be best-effort (off the hot path) or part of the same insert.

## Dependencies / assumptions

- Provider preset is already a column on `webhook_sources` (per recent commit `0fe30cf feat(webhooks): provider preset dropdown`). If the preset is null, dedupe is a no-op.
- The webhook hot path can absorb one extra DB read (the dedupe lookup) without breaking the 5s Linear retry threshold. The lookup is index-backed and runs in the same transaction context as `recordDelivery`.
