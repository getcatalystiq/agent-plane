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
-- 3. schedules.last_fired_dispatch_key + UNIQUE constraint
-- ============================================================

ALTER TABLE schedules ADD COLUMN IF NOT EXISTS last_fired_dispatch_key TEXT;

-- Partial unique index: prevents duplicate (schedule_id, fireTime) dispatches.
-- Partial because rows where last_fired_dispatch_key IS NULL (no dispatch yet
-- this session of the cron's lifetime) should not collide.
CREATE UNIQUE INDEX IF NOT EXISTS uniq_schedules_last_fired_dispatch_key
  ON schedules (id, last_fired_dispatch_key)
  WHERE last_fired_dispatch_key IS NOT NULL;

-- ============================================================
-- 4. tenants.workflow_dispatch_overrides
-- ============================================================

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS workflow_dispatch_overrides JSONB NOT NULL DEFAULT '{}'::jsonb;

-- Constrain JSONB shape: object only (not array/string/number/null at the top).
-- Per-trigger keys are validated in application code (Zod) so a future trigger
-- can be added without a schema migration. We just guarantee it's an object.
ALTER TABLE tenants ADD CONSTRAINT chk_workflow_dispatch_overrides_object
  CHECK (jsonb_typeof(workflow_dispatch_overrides) = 'object')
  NOT VALID;

ALTER TABLE tenants VALIDATE CONSTRAINT chk_workflow_dispatch_overrides_object;
