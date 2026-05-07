-- U1: Workflow dispatch columns.
--
-- Adds four nullable columns across three tables to support the workflow path
-- introduced by the dispatch refactor (see docs/plans/2026-05-05-001-refactor-workflow-sdk-dispatch-plan.md).
--
-- All columns are nullable so this migration is safe to run alongside the legacy
-- dispatcher path during coexistence — rows written by the legacy path simply
-- carry NULLs for the new columns.
--
--   1. sessions.workflow_run_id        — WDK run id (wdk_v1_<id> prefix), used
--                                         by cancel/stream/cleanup paths
--   2. session_messages.runner_started_at — DB-side spawn idempotency primitive;
--                                         set transactionally inside launchRunner
--                                         step so workflow replay skips re-spawn
--   3. schedules.last_fired_dispatch_key — DB-side dedup primitive replacing the
--                                         non-existent WDK start() idempotency
--                                         (UNIQUE per schedule_id)
--   4. tenants.workflow_dispatch_overrides JSONB — per-tenant deny-list override
--                                         so on-call can disable workflow for
--                                         one tenant without redeploying

-- ============================================================
-- 1. sessions.workflow_run_id
-- ============================================================

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS workflow_run_id TEXT;

-- ============================================================
-- 2. session_messages.runner_started_at
-- ============================================================

ALTER TABLE session_messages ADD COLUMN IF NOT EXISTS runner_started_at TIMESTAMPTZ;

-- ============================================================
-- 3. schedules.last_fired_dispatch_key
--
-- Single-column add; no UNIQUE constraint needed. There is one row per
-- schedule, and `last_fired_dispatch_key` stores the most recent fire's
-- key. Duplicate-fire dedup is a CAS pattern in the schedule cron's
-- /execute handler (U7), not a DB-level uniqueness constraint.
-- ============================================================

ALTER TABLE schedules ADD COLUMN IF NOT EXISTS last_fired_dispatch_key TEXT;

-- ============================================================
-- 4. tenants.workflow_dispatch_overrides
-- ============================================================

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS workflow_dispatch_overrides JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Constrain JSONB shape: object only (not array/string/number/null at the top).
-- Per-trigger keys are validated in application code (Zod) so a future trigger
-- can be added without a schema migration. We just guarantee it's an object.
--
-- Wrapped in a DO block so the migration is idempotent on the constraint —
-- ALTER TABLE ADD CONSTRAINT does not support IF NOT EXISTS in Postgres.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'chk_workflow_dispatch_overrides_object'
       AND conrelid = 'tenants'::regclass
  ) THEN
    ALTER TABLE tenants ADD CONSTRAINT chk_workflow_dispatch_overrides_object
      CHECK (jsonb_typeof(workflow_dispatch_overrides) = 'object');
  END IF;
END $$;
