-- Convert chat_event_dedupe to a claim-then-reserve placeholder pattern.
--
-- Round-3 originally modified 036 in place to add the placeholder shape.
-- That edit is invisible to the migration runner (filename + sha256 keyed)
-- on environments that already ran the prior 036, leaving them schema-skewed.
-- This 037 explicitly applies the same deltas as ALTER TABLE statements so
-- every environment converges to the placeholder shape on next deploy.
--
-- =============================================================================
-- DEPLOY-TIME REQUIREMENT (round-4 review #1):
-- =============================================================================
-- Environments that previously ran the round-2 in-place 036 (placeholder
-- shape) have a stored sha256 that no longer matches the current 036
-- (reverted to its c02f40b shape). The migration runner aborts with
-- exit(1) on checksum mismatch UNLESS `MIGRATIONS_RECONCILE_CHECKSUMS=true`.
--
-- For the cutover deploy ONLY:
--   1. Set MIGRATIONS_RECONCILE_CHECKSUMS=true in the Vercel project env.
--   2. Deploy this branch. The runner reconciles 036's stored checksum
--      (without re-executing the SQL) and then applies 037 normally.
--   3. UNSET MIGRATIONS_RECONCILE_CHECKSUMS immediately after the deploy
--      completes. Leaving it set is unsafe — future in-place edits to
--      applied migrations would silently pass without re-running SQL,
--      reintroducing the exact failure mode this 037 exists to fix.
--
-- Production is unaffected (main never had 036 of any shape) — main
-- applies 036 fresh + 037 cleanly without the env var. The reconcile
-- requirement is dev/preview only.
-- =============================================================================
--
-- Deltas:
--   1. Drop NOT NULL on session_id, message_id, inner_run_id (placeholder
--      INSERT writes only tenant/platform/event_id; UPDATE fills the rest).
--   2. Add claimed_at column (used by the orphan-sweep cron and the
--      atomic stale-claim guard).
--   3. Add CHECK constraint enforcing all-or-none atomicity on the three
--      fillable columns.

ALTER TABLE chat_event_dedupe
  ALTER COLUMN session_id   DROP NOT NULL,
  ALTER COLUMN message_id   DROP NOT NULL,
  ALTER COLUMN inner_run_id DROP NOT NULL;

ALTER TABLE chat_event_dedupe
  ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ NOT NULL DEFAULT now();

-- Drop first if it already exists (in case 036-in-place ran on this DB).
ALTER TABLE chat_event_dedupe
  DROP CONSTRAINT IF EXISTS chat_event_dedupe_filled_atomically;

ALTER TABLE chat_event_dedupe
  ADD CONSTRAINT chat_event_dedupe_filled_atomically CHECK (
    (session_id IS NULL AND message_id IS NULL AND inner_run_id IS NULL) OR
    (session_id IS NOT NULL AND message_id IS NOT NULL AND inner_run_id IS NOT NULL)
  );

-- Partial index on stale placeholders so the orphan-sweep cron can scan
-- without table-walking the filled rows (which dominate steady state).
CREATE INDEX IF NOT EXISTS idx_chat_event_dedupe_stale_placeholders
  ON chat_event_dedupe (claimed_at)
  WHERE inner_run_id IS NULL;
