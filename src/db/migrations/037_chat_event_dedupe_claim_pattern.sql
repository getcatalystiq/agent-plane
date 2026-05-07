-- Convert chat_event_dedupe to a claim-then-reserve placeholder pattern.
--
-- Plan reference: REL-R2-01 follow-up for review run 20260507-000226-14dd9f0a
-- (round-3 P0 #2 — migration safety).
--
-- Round-3 originally modified 036 in place to add the placeholder shape.
-- That edit is invisible to the migration runner (filename + sha256 keyed)
-- on environments that already ran the prior 036, leaving them schema-skewed.
-- This 037 explicitly applies the same deltas as ALTER TABLE statements so
-- every environment converges to the placeholder shape on next deploy.
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
