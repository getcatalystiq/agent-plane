---
module: src/db/migrate.ts
date: 2026-05-07
problem_type: workflow_issue
component: database
severity: high
applies_when:
  - "An unmerged migration shipped to dev/preview in one shape, then needs to ship to production in a different shape"
  - "The migration runner tracks applied migrations by filename + checksum (or filename only)"
  - "Modifying the migration in place would skip silently on environments that already ran the prior shape"
  - "Multiple environments may have run the migration at different revisions"
related_components:
  - development_workflow
tags:
  - migrations
  - schema
  - checksum-tracking
  - reconcile-checksums
  - dev-preview-drift
  - cutover
---

# Migration revert + follow-up pattern

## Context

A migration ships through the dev/preview lifecycle in one shape (call it `036.v1`). The team iterates on it in subsequent commits, reaching `036.v2`. By the time the branch lands in production, dev and preview may have run `036.v1` (because they pulled an older commit) while production has never run any version of `036`.

If the migration runner is keyed on filename + checksum (the strict default in this codebase), modifying `036` in place silently fails on environments that already applied `036.v1`. The runner detects checksum mismatch and aborts; even with `MIGRATIONS_RECONCILE_CHECKSUMS=true` it merely UPDATEs the stored hash without re-executing the SQL — the schema differences between `036.v1` and `036.v2` never land.

The pattern: never modify an applied migration. Revert the migration to the first applied shape (`036.v1`) and ship the revisions as a new follow-up migration (`036.v1` + `037-changes`). Every environment converges to the same final shape via SQL-level deltas, regardless of which intermediate shapes they ran.

## Guidance

### When to use

- A branch's migration was applied on dev/preview but is iterating before production cutover.
- Multiple environments could have run different intermediate shapes.
- The intermediate shapes need consolidation but the migration runner can't safely re-execute them.

### The mechanic

1. **Identify the first applied shape.** The version that landed in any environment first is `036.v1`. Often this is the original commit on the feature branch.

2. **Revert the migration to that shape.** `git checkout <first-applied-sha> -- src/db/migrations/<filename>.sql` restores the file content. The filename + checksum now match what dev/preview applied.

3. **Ship the revisions as a new migration.** Create `src/db/migrations/<next-number>_<descriptive>.sql` with `ALTER TABLE` statements that produce the same shape as the in-place revisions would have.

4. **Make the new migration idempotent.** Use `IF NOT EXISTS`, `IF EXISTS`, and `DO $$ IF NOT EXISTS (SELECT 1 FROM pg_constraint ...)` blocks so the new migration is safe to apply on environments where the old shape was partially or fully present.

5. **Document the reconcile flag in the runbook.** Some environments may still need `MIGRATIONS_RECONCILE_CHECKSUMS=true` for ONE deploy if the migration runner detected the in-place modification before the revert. After the cutover, unset it immediately — leaving it set is unsafe (future in-place edits silently pass without re-running SQL).

### The runner contract

`src/db/migrate.ts` keys applied migrations on `(filename, sha256(content))`. Mismatched checksum → exit(1) by default. With `MIGRATIONS_RECONCILE_CHECKSUMS=true`, the runner UPDATEs the stored hash and SKIPS the SQL execution. There is no auto-replay path; every "fix" must be a forward-only delta.

## Why This Matters

A migration is a state-machine transition: the schema before, the SQL applied, the schema after. The runner's filename-based identity assumes one transition per migration. In-place modification breaks that assumption — the same identity now claims two different transitions, and only one can be applied. The other is silently lost on environments that took the first.

The drift is invisible at the moment of the in-place edit. It becomes visible later when:
- Code expects the round-2 shape (e.g. a column added in the in-place edit) but the column doesn't exist on the dev/preview schema.
- A constraint added in the in-place edit doesn't fire on rows that violate it (because the constraint isn't there).
- A test passes locally on the new schema but fails in CI on the un-reconciled environment.

The revert + follow-up pattern restores the runner's invariant. Each migration is one transition. Every environment converges to the same final shape by sequentially applying every migration's SQL. Differences between environments collapse to a known, monotonic application order.

## When to Apply

Apply this pattern when:

- A migration's content needs to change and the migration may have been applied anywhere.
- You need to reason about the schema state of "production after the deploy" without hand-coordinating every environment's manual catch-up.
- The team has not yet agreed on a single canonical revision (multiple developers iterating on the same migration's content).

Do NOT apply:

- Before the migration has shipped anywhere — just keep editing in place; the runner doesn't care until it runs.
- For purely cosmetic changes (comment updates, formatting) that don't affect schema — but do remember the runner's checksum will change and you'll still need the reconcile flag once.

## Examples

### BEFORE — in-place modification (leaves dev/preview drifted)

```diff
- 036_chat_event_dedupe.sql  (round-1 shape: NOT NULL columns)
+ 036_chat_event_dedupe.sql  (round-2 shape: nullable columns, CHECK constraint, claimed_at)
```

Effect: dev/preview that ran round-1 now have a stored checksum mismatching the file. With reconcile-on, the runner updates the stored checksum and skips the SQL. The CHECK constraint and `claimed_at` column never land. Production has never run any version, so it cleanly applies round-2.

### AFTER — revert + follow-up

```diff
036_chat_event_dedupe.sql  (round-1 shape — restored to original content)
+ 037_chat_event_dedupe_claim_pattern.sql  (NEW: ALTER statements to add the round-2 deltas)
```

Where `037_*.sql` contains:

```sql
ALTER TABLE chat_event_dedupe
  ALTER COLUMN session_id   DROP NOT NULL,
  ALTER COLUMN message_id   DROP NOT NULL,
  ALTER COLUMN inner_run_id DROP NOT NULL;

ALTER TABLE chat_event_dedupe
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ NOT NULL DEFAULT now();

ALTER TABLE chat_event_dedupe
  DROP CONSTRAINT IF EXISTS chat_event_dedupe_filled_atomically;
ALTER TABLE chat_event_dedupe
  ADD CONSTRAINT chat_event_dedupe_filled_atomically CHECK (
    (session_id IS NULL AND message_id IS NULL AND inner_run_id IS NULL)
    OR (session_id IS NOT NULL AND message_id IS NOT NULL AND inner_run_id IS NOT NULL)
  );

CREATE INDEX IF NOT EXISTS idx_chat_event_dedupe_stale_placeholders
  ON chat_event_dedupe (claimed_at)
  WHERE inner_run_id IS NULL;
```

Effect: every environment converges to the same final shape. Dev/preview that ran round-1 → 036 stays as-is, 037 adds the deltas. Production never ran any → 036 runs as round-1, 037 then adds the deltas. Both end identical.

### Cutover deploy gate

The runbook entry:

> Migration `037_*.sql` lands the placeholder pattern via `ALTER TABLE`. Round-2 originally landed the same shape by modifying 036 in place; round-3 reverted 036 and added 037. On any environment that ran the round-2 in-place 036, the stored sha256 for 036 no longer matches the on-disk file, so the migration runner aborts the deploy.
>
> For the cutover deploy ONLY, set `MIGRATIONS_RECONCILE_CHECKSUMS=true` on the Vercel project env. The runner reconciles 036's stored checksum (without re-executing the SQL) and applies 037 cleanly. **Unset the env var immediately after the deploy completes.** Leaving it set is unsafe — future in-place edits to applied migrations would silently pass without re-running SQL.

## References

- **Reference implementation:** `src/db/migrations/036_chat_event_dedupe.sql` (reverted) + `src/db/migrations/037_chat_event_dedupe_claim_pattern.sql` (follow-up)
- **Migration runner:** `src/db/migrate.ts` — filename + sha256 keying; `MIGRATIONS_RECONCILE_CHECKSUMS` env var
- **Runbook entry:** `docs/runbooks/chat-platform-bots.md` "Migration 037 deploy gate" + "Cutover deployment (rounds 5-6)"
- **Origin commits:**
  - `2db6aa7` — round-2: in-place modification of 036 (the antipattern)
  - `f19f1a3` — round-3: revert 036 + add 037 (the fix)
