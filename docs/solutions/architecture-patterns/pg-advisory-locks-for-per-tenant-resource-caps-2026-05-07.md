---
module: src/lib/platform/operations.ts
date: 2026-05-07
problem_type: architecture_pattern
component: database
severity: high
applies_when:
  - "Adding a per-tenant numeric cap enforced via SELECT COUNT then INSERT/UPSERT"
  - "Cap-check and write happen in different transactions, or a slow probe sits between them"
  - "Running on Postgres READ COMMITTED — concurrent writers can each pass the gate and both write"
  - "Cap key composes more than just tenant id (tenant + resource + sub-resource); collision resistance matters"
  - "Stack uses Neon or another PgBouncer transaction-mode pooler — session-scoped advisory locks would silently break"
related_components:
  - service_object
  - background_job
tags:
  - postgres
  - advisory-locks
  - toctou
  - tenant-isolation
  - concurrency
  - read-committed
  - resource-caps
  - pgbouncer
---

# PG advisory locks for per-tenant resource caps (TOCTOU closure)

## Context

Per-tenant resource caps under `withTenantTransaction` are vulnerable to count-then-check TOCTOU races. The codebase runs at PostgreSQL's default isolation (READ COMMITTED via plain `BEGIN`), so two concurrent transactions both read `COUNT(*) = N-1` against the cap of `N`, both pass the check, and both INSERT — silently overshooting the cap.

This pattern surfaces for any "≤K rows per tenant per resource" rule: the 50-active-sessions cap in `dispatcher.ts`/`sessions.ts`, the per-platform 10-bots cap in `platform/operations.ts`, and any future cap (custom MCP servers, webhook sources, plugin marketplaces). It is especially tricky when work spans multiple transactions (e.g. cap pre-check → slow HTTP probe → cap re-check → INSERT), because the lock from the first tx releases at COMMIT and a racing caller can slot in before the second tx opens.

## Guidance

The pattern, in five rules:

### 1. Lock key shape

Namespaced string `'<scope>:<tenantId>[:<sub-resource>]'`. Scope is the cap kind (`session_cap`, `bot-cap`); sub-resource is the per-tenant axis the cap partitions on (platform, agent kind, etc.). Distinct keys must not contend.

| Resource | Lock key |
|---|---|
| 50 active sessions/tenant | `session_cap:<tenantId>` |
| 10 bots/tenant/platform | `bot-cap:<tenantId>:<platform>` |
| Future: 25 MCP servers/tenant | `mcp-cap:<tenantId>` |
| Future: 50 webhooks/tenant | `webhook-cap:<tenantId>` |

### 2. Use `pg_advisory_xact_lock` (transaction-scoped), NOT `pg_advisory_lock` (session-scoped)

```sql
SELECT pg_advisory_xact_lock(hashtextextended($1, 0))
```

The `_xact_` variant auto-releases on COMMIT/ROLLBACK so callers cannot leak locks. **Session-scoped locks (`pg_advisory_lock`) silently break under Neon's PgBouncer transaction-mode pooling** — the lock is acquired on one backend connection, the next query can land on a different connection that doesn't hold it. Two prior plans (`docs/plans/2026-03-07-feat-scheduled-agent-runs-plan.md:88`, `docs/plans/2026-03-08-feat-multiple-agent-schedules-plan.md:246`) already document this and prescribe `FOR UPDATE SKIP LOCKED` for the session-scoped use case. Transaction-scoped advisory locks DO work through PgBouncer's transaction pooling because the entire transaction lives on one backend.

### 3. Use `hashtextextended()` for 64-bit lock keys

```sql
-- CORRECT — 64-bit hash, collision birthday at ~4 billion keys
SELECT pg_advisory_xact_lock(hashtextextended($1, 0))

-- WRONG — 32-bit hash, collision birthday at ~65k keys
SELECT pg_advisory_xact_lock(hashtext($1))
```

`pg_advisory_lock` takes a BIGINT (or two INT4s); `hashtext` is 32-bit and collides at ~65k keys via the birthday bound. With tenant UUIDs in the key string, key volume can scale fast. The legacy `acquireSessionCapLock` in `sessions.ts:45-53` uses `hashtext` for historical reasons; new helpers use `hashtextextended` and the legacy one should be migrated when convenient. Collision between `'session_cap:<uuid>'` and an unrelated future key would deadlock or false-block — quiet but real.

### 4. When work spans two transactions, lock both AND re-check the cap in the second

The advisory lock is tx-scoped. The gap between `COMMIT` of the pre-check tx and `BEGIN` of the upsert tx is unguarded — a racing writer can commit between them. So:

- Pre-check tx: lock + count + fail-fast on cap exceeded. Releases at COMMIT.
- Slow operation (probe, attestation, etc.) runs UNLOCKED.
- Upsert tx: re-acquire lock + re-check cap + INSERT. The re-check closes the inter-tx window.

The pre-check exists only to fail fast before the slow probe runs. The authoritative gate is the re-check.

### 5. Slow operations stay OUTSIDE the lock

Holding the advisory lock across an HTTP probe pins both a pool client AND the lock for the duration. With `pool max=20`, eight concurrent connects each holding a 5s probe saturate the pool. The round-6 fix moved the 5s Slack/Discord probe in `upsertBotConfig` outside the locked tx; the pool client is now held only for fast SQL.

### 6. Cap formula excludes self for UPSERT idempotency

When the cap covers a row that the same call may be replacing, `COUNT(*)` must filter out the current target. `WHERE … AND agent_id <> $3` lets a re-upsert of an already-counted row stay under the cap instead of double-counting.

## Why This Matters

`withTenantTransaction` (in `src/db/index.ts`) issues a plain `BEGIN` — that's READ COMMITTED. `COUNT(*)` is a non-locking read, so two concurrent transactions see the same pre-INSERT count and both pass. The classic remedies all have downsides:

- **`SERIALIZABLE`** works but adds retry-on-`40001` complexity at every callsite, and the failure mode (`serialization_failure`) doesn't say "you hit a cap" — it says "retry me," which has to be wrapped at the dispatcher layer.
- **`SELECT … FOR UPDATE`** on a counted row doesn't work — there is no single row to lock; the cap is over a set, and a concurrent INSERT into that set is invisible to row locks.
- **Unique partial index** works for "≤1" caps (e.g. one active session per `(tenant, agent, contextId)`) but doesn't generalize to "≤N".
- **`pg_advisory_lock` (session-scoped)** breaks under Neon's PgBouncer transaction pooling — see rule 2.
- **`pg_advisory_xact_lock` (transaction-scoped)** is the precision tool: a single call serializes only the contending callers (same tenant + same sub-resource), leaves everyone else's traffic running at READ COMMITTED, fails loudly with the existing typed error (`TenantBotCapExceededError`, `ConcurrencyLimitError`) instead of an opaque `40001`, and works correctly through the PgBouncer pooler.

The session-cap precedent in `src/lib/sessions.ts:45-53` shipped first; the bot-cap helpers in `src/lib/platform/operations.ts` are the second instance and prove the shape generalizes. Both feed into `withTenantTransaction`'s `TxClient`, so the helper signature is portable.

## When to Apply

Use this pattern whenever:

- You have a per-tenant (or per-tenant + per-sub-resource) cap of `N` rows.
- The cap-check is a `COUNT(*)` (or equivalent aggregation) that races with concurrent INSERTs.
- The work commits inside `withTenantTransaction` (READ COMMITTED).
- You want concurrent dispatchers/upserts in DIFFERENT scopes to run in parallel — not block on a single tenant-wide lock.

Do NOT use:

- For "≤1" caps where a unique partial index expresses the rule directly.
- For inter-process coordination across long-running work outside a single transaction (advisory locks need a live tx; for cron singletons, use `FOR UPDATE SKIP LOCKED` instead).
- When the row being inserted has a natural unique key — let the unique index do the work.

## Examples

### BEFORE — racy two-transaction shape

```ts
// Tx 1: cap pre-check
await withTenantTransaction(tenantId, async (tx) => {
  const enabled = await countEnabledBots(tx, tenantId, agentId, platform);
  if (enabled >= cap) throw new TenantBotCapExceededError(platform, cap);
});

// Slow HTTP probe (5s)
const probe = await probeWorkspaceSize(credentials, identity);

// Tx 2: INSERT — TWO callers can both reach here under the cap
await withTenantTransaction(tenantId, async (tx) => {
  await tx.execute(`INSERT INTO platform_bot_configs ...`);
});
```

Two concurrent connects with `enabled = cap - 1` both pass the pre-check, both pass the probe, both INSERT — overshoots the cap by 1.

### AFTER — advisory lock on both transactions, probe outside

```ts
// Tx 1: lock + cap pre-check (fast SQL only)
const threshold = await withTenantTransaction(tenantId, async (tx) => {
  await acquireBotCapLock(tx, tenantId, platform);
  const { cap, threshold } = await getTenantConfig(tx, tenantId, platform);
  const enabled = await countEnabledBots(tx, tenantId, agentId, platform);
  if (enabled >= cap) throw new TenantBotCapExceededError(platform, cap);
  return threshold;
});

// Slow probe runs UNLOCKED
const probe = await enforceAttestationGate({
  tenantId, credentials, identity, attestations, maxTrustedMembers: threshold,
});

// Tx 2: re-acquire the lock + re-check + INSERT
return withTenantTransaction(tenantId, async (tx) => {
  await acquireBotCapLock(tx, tenantId, platform);
  await assertBotCapAvailable(tx, tenantId, agentId, platform);
  return tx.queryOne(PlatformBotConfigRow, `INSERT ... ON CONFLICT ...`, [...]);
});
```

### Helper signatures (copy-paste shape)

```ts
// Lock-key construction + acquisition. Tx-scoped: auto-releases at COMMIT.
async function acquireBotCapLock(
  tx: TxClient,
  tenantId: TenantId,
  platform: ChatPlatform,
): Promise<void> {
  await tx.execute(
    "SELECT pg_advisory_xact_lock(hashtextextended($1, 0))",
    [`bot-cap:${tenantId}:${platform}`],
  );
}

// Caller is expected to have already acquired the advisory lock.
async function assertBotCapAvailable(
  tx: TxClient,
  tenantId: TenantId,
  agentId: AgentId,
  platform: ChatPlatform,
): Promise<number> {
  const { cap } = await getTenantConfig(tx, tenantId, platform);
  const enabled = await countEnabledBots(tx, tenantId, agentId, platform);
  if (enabled >= cap) throw new TenantBotCapExceededError(platform, cap);
  return cap;
}

// Cap formula EXCLUDES self for UPSERT idempotency.
async function countEnabledBots(
  tx: TxClient,
  tenantId: TenantId,
  agentId: AgentId,
  platform: ChatPlatform,
): Promise<number> {
  const row = await tx.queryOne(
    EnabledBotCountRow,
    `SELECT COUNT(*) AS count FROM platform_bot_configs
      WHERE tenant_id = $1 AND platform = $2 AND enabled = true
        AND agent_id <> $3`,
    [tenantId, platform, agentId],
  );
  return row?.count ?? 0;
}
```

## References

- **Reference implementations:**
  - `src/lib/sessions.ts:45-53` — `acquireSessionCapLock` (50 active sessions/tenant; uses legacy `hashtext`)
  - `src/lib/platform/operations.ts` — `acquireBotCapLock`, `assertBotCapAvailable`, `getTenantConfig`, `upsertBotConfig` (10 bots/tenant/platform; uses `hashtextextended`)
  - `src/lib/dispatcher.ts` — usage of `acquireSessionCapLock` in the dispatch path
- **Plan-level discussion** of the 50-active-sessions cap and atomic-SQL-guard alternative:
  - `docs/plans/2026-04-27-003-refactor-runs-sessions-unification-plan.md` (lines 111, 204, 271)
- **PgBouncer / session-scoped advisory lock incompatibility** (the reason `_xact_lock` is mandatory here):
  - `docs/plans/2026-03-07-feat-scheduled-agent-runs-plan.md:88`
  - `docs/plans/2026-03-08-feat-multiple-agent-schedules-plan.md:246` (session history)
- **Origin commits** in this codebase:
  - `e55f1c6` — round-5 fix introducing `acquireBotCapLock`
  - `82cbf49` — round-6 helper extraction (`acquireBotCapLock`/`assertBotCapAvailable`)
  - `f3cfec3` — round-6 /simplify pass collapsing duplication and unifying `getTenantConfig`
