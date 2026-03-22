# Deployment Checklist: Migration 023 — Add Subscription Token Columns

**PR:** Add `subscription_token_enc` and `subscription_base_url` to `tenants` table
**Date:** 2026-03-21
**Risk level:** Low (additive columns only, no data transformation)

---

## Answers to Deployment Questions

### 1. Is this migration safe for zero-downtime deploy?

**YES.** `ALTER TABLE ... ADD COLUMN` with nullable columns and no DEFAULT does not rewrite the table on Postgres 11+. Neon (Postgres 16) acquires only a brief `ACCESS EXCLUSIVE` lock to update the catalog — no full table rewrite, no row locks. Existing queries are unaffected because:

- New columns default to NULL
- No NOT NULL constraint
- No DEFAULT value (avoids table rewrite)
- `IF NOT EXISTS` makes it idempotent

### 2. Does the application code handle NULL gracefully during the deploy window?

**CRITICAL CONCERN.** The `TenantRow` Zod schema (line 328 of `src/lib/validation.ts`) currently does NOT include `subscription_token_enc` or `subscription_base_url`. Multiple routes execute `SELECT * FROM tenants WHERE id = $1` and parse through `TenantRow`.

- Zod's default behavior with `.object()` is to **strip** unknown keys — so `SELECT *` returning the new columns will NOT break existing parsing. The extra columns are silently dropped.
- The new `resolveSandboxAuth()` function must handle NULL values for both columns. The plan already accounts for this (falls back to AI Gateway when token is NULL).

**Sequencing requirement:** The migration runs BEFORE `next build` (per `vercel.json`: `npm run migrate && next build`). This means the columns exist by the time the new application code runs. There is NO window where new code runs against the old schema on the same deploy.

However, during rollout there is a brief window where old Vercel function instances (pre-deploy) serve requests against the new schema. This is safe because:

- Old code uses `SELECT *` parsed through Zod `.object()` which strips unknown keys
- Old code never references the new columns

**Verdict: SAFE. No code change needed for NULL handling.**

### 3. Rollback procedure if migration fails?

See Rollback Plan section below.

### 4. Monitoring needed post-deploy?

Minimal — see Post-Deploy Monitoring section. This is a schema-only change with no data transformation.

### 5. SQL verification queries?

See Pre-Deploy and Post-Deploy sections below.

---

## [PRE-DEPLOY] Required Checks

- [ ] Verify current tenants table column count (baseline)

```sql
SELECT column_name, data_type, is_nullable
FROM information_schema.columns
WHERE table_name = 'tenants'
ORDER BY ordinal_position;
```

**Expected:** No `subscription_token_enc` or `subscription_base_url` columns present.

- [ ] Record tenant count baseline

```sql
SELECT COUNT(*) AS tenant_count FROM tenants;
SELECT id, slug, status FROM tenants ORDER BY created_at;
```

**Save this output — compare post-deploy.**

- [ ] Confirm no active long-running transactions that could block DDL

```sql
SELECT pid, state, query, age(clock_timestamp(), query_start) AS duration
FROM pg_stat_activity
WHERE state != 'idle'
  AND query NOT LIKE '%pg_stat_activity%'
ORDER BY duration DESC;
```

**Expected:** No queries running longer than 30 seconds.

- [ ] Verify migration file exists and is correct

```
cat src/db/migrations/023_add_subscription_token.sql
```

**Expected content:**
```sql
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS subscription_token_enc TEXT,
  ADD COLUMN IF NOT EXISTS subscription_base_url TEXT;
```

- [ ] Confirm staging deploy passed (if applicable)
- [ ] Confirm rollback plan reviewed by second engineer

---

## [DEPLOY] Migration Steps

| Step | Action | Estimated Runtime | Batching | Rollback |
|------|--------|-------------------|----------|----------|
| 1 | Push to `main` triggers Vercel deploy | ~2 min total | N/A | Revert commit |
| 2 | `npm run migrate` runs automatically (adds 2 columns) | < 1 second | N/A | `ALTER TABLE DROP COLUMN` |
| 3 | `next build` compiles new application code | ~60 sec | N/A | Revert commit |
| 4 | Vercel swaps traffic to new deployment | Instant | N/A | Instant rollback via Vercel dashboard |

**Key:** No backfill step. No data transformation. Columns are added as NULL and only populated when tenants configure subscription tokens via the Admin UI.

---

## [POST-DEPLOY] Verification (Within 5 Minutes)

- [ ] Verify columns exist

```sql
SELECT column_name, data_type, is_nullable, column_default
FROM information_schema.columns
WHERE table_name = 'tenants'
  AND column_name IN ('subscription_token_enc', 'subscription_base_url')
ORDER BY column_name;
```

**Expected:**

| column_name | data_type | is_nullable | column_default |
|---|---|---|---|
| subscription_base_url | text | YES | NULL |
| subscription_token_enc | text | YES | NULL |

- [ ] Verify all existing tenant data is intact

```sql
SELECT COUNT(*) AS tenant_count FROM tenants;
```

**Expected:** Same count as pre-deploy baseline.

- [ ] Verify new columns are NULL for all existing tenants

```sql
SELECT COUNT(*) FROM tenants WHERE subscription_token_enc IS NOT NULL;
SELECT COUNT(*) FROM tenants WHERE subscription_base_url IS NOT NULL;
```

**Expected:** Both return 0.

- [ ] Verify existing tenant queries still work (hit the health and tenant endpoints)

```bash
curl -s https://<production-url>/api/health
# Expected: 200 OK

curl -s -H "Authorization: Bearer <test-api-key>" https://<production-url>/api/tenants/me | jq '.id, .slug, .status'
# Expected: valid tenant data returned, no errors
```

- [ ] Check Vercel function logs for errors

```bash
vercel logs <production-url> --since 5m 2>&1 | head -100
```

**Expected:** No 500 errors related to tenant queries.

- [ ] Verify migration is recorded in migrations tracking

```sql
SELECT * FROM _migrations ORDER BY applied_at DESC LIMIT 3;
```

**Expected:** `023_add_subscription_token.sql` appears as the most recent migration.

---

## [ROLLBACK] Plan

**Can we roll back?**

- [x] **YES — trivially.** This is an additive-only migration with no data in the new columns at deploy time.

**Rollback steps (if migration itself fails):**

The deploy will abort automatically — `vercel.json` runs `npm run migrate && next build`, so a failed migration prevents the build from running and the deploy does not go live.

**Rollback steps (if application errors after deploy):**

1. [ ] **Instant rollback via Vercel dashboard** — redeploy previous production deployment (does not touch database)
2. [ ] If column removal is needed (unlikely):

```sql
ALTER TABLE tenants DROP COLUMN IF EXISTS subscription_token_enc;
ALTER TABLE tenants DROP COLUMN IF EXISTS subscription_base_url;
```

**WARNING:** Only run the DROP COLUMN statements if no tenants have stored subscription tokens yet. Check first:

```sql
SELECT COUNT(*) FROM tenants WHERE subscription_token_enc IS NOT NULL;
-- Must be 0 before dropping
```

3. [ ] Add a DOWN migration file (`023_add_subscription_token_rollback.sql`) if automated rollback is needed

**Data loss risk:** NONE at deploy time (columns are empty). If tokens have been stored post-deploy and you drop the columns, those encrypted tokens are lost.

---

## [MONITORING] First 24 Hours

| Signal | Alert Condition | How to Check |
|--------|-----------------|--------------|
| API error rate | Any 500s on `/api/tenants/*` routes | Vercel dashboard > Functions |
| Tenant query failures | Zod parse errors in logs | `vercel logs --since 1h` grep for "ZodError" |
| Sandbox creation failures | Runs failing at auth resolution | Vercel logs grep for "resolveSandboxAuth" |
| Migration table state | 023 migration not recorded | Query `_migrations` table |

**Console spot-checks (run at +1h, +4h, +24h):**

```sql
-- Confirm no unintended writes to new columns
SELECT COUNT(*) FROM tenants WHERE subscription_token_enc IS NOT NULL;
-- Expected: 0 (unless a tenant has configured a token via Admin UI)

-- Confirm existing functionality unaffected
SELECT id, slug, status, current_month_spend FROM tenants WHERE status = 'active';
-- Expected: all active tenants listed, no anomalies
```

---

## Summary Assessment

| Question | Answer |
|----------|--------|
| Zero-downtime safe? | **YES** — additive nullable columns, no table rewrite |
| NULL handling safe? | **YES** — Zod strips unknown keys; new code handles NULL with fallback |
| Deploy ordering safe? | **YES** — migrate runs before build; no window of new code vs old schema |
| Rollback available? | **YES** — Vercel instant rollback + optional DROP COLUMN |
| Data risk? | **NONE** — no existing data modified, no backfill |
| Estimated total risk | **LOW** |

**GO decision criteria:** All pre-deploy checks pass, staging verified, second engineer has reviewed rollback plan.
