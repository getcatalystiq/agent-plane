---
module: src/lib/platform/adapters/discord.ts
date: 2026-05-07
problem_type: logic_error
component: integration_issue
severity: high
symptoms:
  - "Two events arriving in the same millisecond produce identical fallback IDs"
  - "Dedupe table uses event_id as part of its unique key; collisions silently merge events"
  - "Wrong reply lands in wrong thread when the second event attaches to the first event's stream"
  - "Cross-tenant collision is bounded by the tenant_id scope, but within-tenant collisions hit hard"
root_cause: logic_error
resolution_type: code_fix
tags:
  - event-id
  - dedupe
  - randomuuid
  - timestamp-collision
  - fallback-id
  - tenant-isolation
---

# Event-id fallback: `crypto.randomUUID()` not `Date.now()`

## Problem

When an upstream platform's message ID is missing or the schema is permissive, code often falls back to `${Date.now()}` as a synthetic event ID. Date.now() has millisecond precision; two events arriving in the same millisecond produce the same ID. If the ID is used as part of a uniqueness key (chat-event dedupe, idempotency tokens, request correlation), the collision silently merges events.

In the chat-platform-bots flow, the dedupe key is `(tenant_id, platform, event_id)`. Two within-tenant events hitting the same millisecond fallback collide on `event_id` and the second event attaches to the first event's stream — wrong reply, wrong thread.

## Symptoms

- Adversarial review trace: "Two concurrent events with `m.id` undefined in the same millisecond produce identical eventIds."
- Within-tenant collision: second user's dispatch attaches to first user's inner-workflow stream.
- The bug is hidden when message IDs are reliably present (the platform always sets them); it surfaces on edge cases — bot-emitted messages, bridged channels, deleted-then-replayed, schema variants.
- Even with low message volume, busy tenants can hit the same millisecond on legitimate concurrent dispatches.

## What Didn't Work

`Date.now() + Math.random()` would reduce but not eliminate collisions. `Date.now()` alone is fully exposed.

```ts
// BUG — millisecond precision; collisions at sub-ms message rates
eventId: m.id ?? `${Date.now()}`
```

## Solution

`crypto.randomUUID()` (Node 14+, Web Crypto API) provides 122 bits of entropy with cryptographically strong collision resistance. Same one-line interface; no shape change to callers.

```ts
eventId: m.id ?? crypto.randomUUID()
```

Apply consistently at every fallback site. The chat-platform branch had four sites: two each in `discord.ts` and `slack.ts` (one each for `onNewMention` and `onSubscribedMessage`).

## Why This Works

UUIDv4 collision probability at scale: with 122 bits of entropy, the birthday-bound probability of a collision among N IDs is approximately N²/2^123. Even at 1 billion events per tenant, the per-tenant collision probability is astronomically below any operational concern.

Cross-tenant: the dedupe key is `(tenant_id, platform, event_id)`, so a UUID collision between tenants would still need the tenant_id to match — vanishingly unlikely AND blocked by RLS.

The cost is one syscall to crypto.getRandomValues per fallback. On Node 14+ and the Vercel runtime, `crypto.randomUUID()` is a global; no import needed.

## Prevention

- **Audit pattern**: grep for `Date.now()` in fallback positions. The pattern `?? \`${Date.now()}\`` or `?? Date.now()` is a code smell when the result is used as an ID. `Date.now()` is fine for log timestamps, retry-after backoffs, monotonic sleep budgets — never for IDs that must be unique.
- **Type help**: a branded `EventId = string & { __brand: "EventId" }` with a constructor that requires either a real platform ID or `crypto.randomUUID()` makes the rule explicit at the type level.
- **Testing hint**: a unit test that fires N concurrent events with `m.id` undefined and asserts N distinct dedupe rows catches regressions. The current test suite doesn't have this — could be added with `Promise.all([...Array(100)].map(() => dispatch(emptyId)))`.
- **Documentation**: when a fallback is the ONLY path that produces synthetic IDs (rare in practice — platforms usually set IDs), say so in a comment so a future reader knows whether to optimize the fallback or rely on it.

## Concrete instances on this branch

Round-3 review #3 (correctness + adversarial). Both adapters had two fallback sites each. The `Date.now()` fallback predated the dedupe table; once dedupe became the primary safety net, the millisecond-precision fallback became a within-tenant collision risk. Round-4 fix replaced all four sites with `crypto.randomUUID()`.

```diff
-      eventId: m.id ?? `${Date.now()}`,
+      eventId: m.id ?? crypto.randomUUID(),
```

## References

- **Reference implementations:**
  - `src/lib/platform/adapters/discord.ts` — `onNewMention`, `onSubscribedMessage` event_id fallbacks
  - `src/lib/platform/adapters/slack.ts` — same shape, two sites
- **Companion pattern:** `architecture-patterns/pg-advisory-locks-for-per-tenant-resource-caps-2026-05-07.md` — the dedupe key whose uniqueness this fallback was breaking
- **Origin commit:** `413a38e` — round-4 review #3 fix
