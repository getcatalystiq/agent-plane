---
module: src/db/index.ts
date: 2026-05-07
problem_type: tooling_decision
component: database
severity: high
applies_when:
  - "An architecture pattern holds a single PG pool client open for seconds-to-minutes (gateway listener, advisory-lock holder, long stream consumer)"
  - "Other consumers in the same function instance compete for the same pool"
  - "Pool max determines how many long-held holders can coexist with normal traffic"
related_components:
  - background_job
  - service_object
tags:
  - postgres
  - connection-pool
  - pool-max
  - neon
  - pgbouncer
  - long-held-connections
  - resource-contention
---

# PG pool sizing for long-held connections

## Context

A connection pool sized for short-transaction traffic (`max=5`) starves immediately when even one consumer holds a client for seconds. The Discord gateway listener pattern is the canonical example: each enabled bot's listener holds a single pool client for ~700s per cron tick to keep its `pg_advisory_xact_lock` alive, blocking ingress webhooks, schedule cron, watchdog sweeps, and admin actions on the same function instance.

Pool-max sizing is a tooling decision that depends on the architecture's worst-case concurrent long-holders + steady-state short-traffic headroom + the upstream connection ceiling (Neon's per-branch limit, PgBouncer's pool_size, etc.).

## Guidance

### The framing

Pool max should equal `max_concurrent_long_holders + ceil(steady_state_short_traffic × p99_burstiness)`. The first term comes from the architecture (count the long-held client patterns); the second comes from observability (`pg_stat_activity`, request burst histograms).

For this codebase as of round-6:
- **Long-holders**: 1 client per enabled Discord bot listener for ~700s during cron tick. Estimated practical ceiling: 10 enabled bots per tenant × multiple tenants. Reduced to per-instance bound via the per-tenant per-platform cap (10) AND the fact that listeners run sequentially within a single cron tick (not all 10 simultaneously).
- **Short-traffic**: ingress chat webhooks, scheduled-runs cron, watchdog sweeps, admin upserts. Steady state ~3-5 concurrent; bursts can be ~10.
- **Upstream ceiling**: Neon serverless pooled URL provides ~100 connections per branch.

Settled at `max=20` as of round-6. Comment in `src/db/index.ts` cites the Discord gateway listener as the load-bearing constraint:

```ts
_pool = new Pool({
  connectionString,
  // Pool size note: the Discord gateway listener holds one client for
  // ~700s per enabled bot to keep pg_advisory_lock alive across the cron
  // tick. With max=5 we starved at ≥5 enabled discord bots — every other
  // DB consumer in the same function instance blocked on connect(). 20
  // gives headroom for the listener workload + ingress traffic without
  // blowing past Neon's typical per-branch connection ceiling. Tune if
  // the listener architecture changes (e.g., moves to a per-bot lambda).
  max: 20,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 10_000,
});
```

### The trade-offs

- **Too low** (`max=5`): one long-held holder consumes 20% of the pool. Five holders saturate it. Every other consumer blocks on `pool.connect()`.
- **Too high** (`max=100`): risks blowing past the upstream ceiling. Serverless function instances multiply this — at 50 instances × 100 = 5000 concurrent connections, well past most managed-PG limits.
- **At `max=20`**: 10 enabled bots can each hold a client without saturating. Steady-state traffic gets the remaining 10 slots. Multiple function instances multiply the total — verify against the upstream ceiling.

### When to revisit

Pool sizing is a moving target. Revisit when:

- The long-holder pattern changes (Discord listener moves to a per-bot lambda, the advisory-lock holder shrinks to per-tx, etc.).
- The per-tenant cap changes (currently 10/platform; if raised, pool max should rise proportionally).
- A new long-held pattern lands (e.g., a streaming-query consumer that holds a client for the duration of an LLM call).
- Observability shows sustained `connect()` waits (a `pool.waitingCount` metric gauge would surface this).

### When pool sizing is the WRONG knob

Some symptoms look like pool starvation but aren't:

- **`SELECT … FOR UPDATE` deadlocks** — two clients each holding row locks waiting on each other. Pool size doesn't help; restructure the lock acquisition order or use advisory locks (see `architecture-patterns/pg-advisory-locks-for-per-tenant-resource-caps-2026-05-07.md`).
- **Slow query saturating the pool** — fix the query (index, batch, restructure) before raising max.
- **Idle-in-transaction connections** — find the unwrapped `BEGIN` and close it; raising max only postpones the symptom.
- **Per-tenant noisy neighbor** — a single tenant burning all the connections needs per-tenant rate limiting OR a per-tenant cap, not a bigger pool.

## Why This Matters

Pool exhaustion is a particularly insidious failure mode because it cascades:

1. Pool saturated.
2. New consumers block on `pool.connect()` until `connectionTimeoutMillis` fires (10s default).
3. Webhook handlers time out → upstream platform retries.
4. Retries pile on more pool pressure.
5. Cron jobs miss their tick → backlog grows.
6. Eventually function instance recycles, but the backlog persists across instances.

The fix isn't always "more pool slots." Sometimes the architecture is wrong (an HTTP probe inside a locked transaction, an unbounded background loop holding a connection). Round-6 traced the bot-cap probe holding a connection during the 5s Slack/Discord HTTP call as the load-bearing factor under concurrent admin connects; the fix wasn't more pool slots, it was moving the probe outside the lock.

But once the architecture is right, pool sizing is the dial that matches concurrency capacity to observed load. The `max=20` settled value reflects today's architecture; future architectural changes should re-evaluate.

## When to Apply

Use this guidance when:

- An architecture review surfaces a long-held connection pattern.
- `pool.connect()` waits or `connectionTimeoutMillis` fires under realistic load.
- Adding a new feature that holds a client for >10ms.

The decision rubric:

1. Count concurrent long-holders in the worst case.
2. Add headroom for steady-state short-traffic burstiness.
3. Bound by the upstream ceiling (single function instance × pool max ≤ branch ceiling / instance count).
4. Document the load-bearing constraint in a comment so future tuning has context.

## References

- **Reference implementation:** `src/db/index.ts:7-20` — pool config with rationale comment
- **Long-holder examples:**
  - `src/app/api/discord/gateway/route.ts` — gateway listener holding the advisory-lock client
  - Future: per-tenant streaming consumers, long-running migrations
- **Related patterns:**
  - `architecture-patterns/pg-advisory-locks-for-per-tenant-resource-caps-2026-05-07.md` — the long-holders' source
- **Origin commits:**
  - `f19f1a3` — round-3 fix #4: bumped pool max 5 → 20 with explanatory comment
