-- Multiple Schedules per Agent
-- Moves from 7 flat schedule_* columns on agents to a dedicated schedules table.
-- Each schedule is independently configurable, claimable, and trackable.

-- ============================================================
-- 1. Create schedules table
-- ============================================================

CREATE TABLE IF NOT EXISTS schedules (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL,
  agent_id        UUID NOT NULL,
  name            VARCHAR(100),
  frequency       VARCHAR(20) NOT NULL DEFAULT 'manual'
                  CHECK (frequency IN ('manual', 'hourly', 'daily', 'weekdays', 'weekly')),
  time            TIME,
  day_of_week     SMALLINT CHECK (day_of_week BETWEEN 0 AND 6),
  prompt          TEXT,
  enabled         BOOLEAN NOT NULL DEFAULT false,
  last_run_at     TIMESTAMPTZ,
  next_run_at     TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  -- Composite FK: prevent schedules referencing agent from different tenant
  CONSTRAINT fk_schedules_agent_tenant FOREIGN KEY (agent_id, tenant_id)
    REFERENCES agents(id, tenant_id) ON DELETE CASCADE,

  -- Cross-column constraints (same logic as old agent columns)
  CONSTRAINT chk_sched_time_required CHECK (
    frequency IN ('manual', 'hourly')
    OR time IS NOT NULL
  ),
  CONSTRAINT chk_sched_day_of_week_weekly CHECK (
    (frequency = 'weekly' AND day_of_week IS NOT NULL)
    OR (frequency != 'weekly' AND day_of_week IS NULL)
  ),
  CONSTRAINT chk_sched_prompt_required CHECK (
    enabled = false
    OR (prompt IS NOT NULL AND length(prompt) > 0)
  ),
  CONSTRAINT chk_sched_enabled_not_manual CHECK (
    enabled = false
    OR frequency != 'manual'
  )
);

-- ============================================================
-- 2. Indexes
-- ============================================================

-- Hot path: cron dispatcher queries due schedules
CREATE INDEX idx_schedules_due
  ON schedules (next_run_at)
  WHERE enabled = true;

-- Tenant-scoped queries
CREATE INDEX idx_schedules_tenant ON schedules (tenant_id);

-- Agent-scoped queries (list schedules for an agent)
CREATE INDEX idx_schedules_agent ON schedules (agent_id);

-- ============================================================
-- 3. RLS
-- ============================================================

ALTER TABLE schedules ENABLE ROW LEVEL SECURITY;
ALTER TABLE schedules FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON schedules
  FOR ALL TO app_user
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

-- ============================================================
-- 4. Triggers
-- ============================================================

CREATE TRIGGER schedules_updated_at
  BEFORE UPDATE ON schedules
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- ============================================================
-- 5. Grant permissions to app_user
-- ============================================================

GRANT SELECT, INSERT, UPDATE, DELETE ON schedules TO app_user;

-- ============================================================
-- 6. Add schedule_id FK on runs
-- ============================================================

ALTER TABLE runs ADD COLUMN IF NOT EXISTS schedule_id UUID;

-- Use NOT VALID to avoid ACCESS EXCLUSIVE lock on large runs table,
-- then validate separately (only takes SHARE UPDATE EXCLUSIVE lock).
ALTER TABLE runs ADD CONSTRAINT fk_runs_schedule
  FOREIGN KEY (schedule_id)
  REFERENCES schedules(id)
  ON DELETE SET NULL
  NOT VALID;

ALTER TABLE runs VALIDATE CONSTRAINT fk_runs_schedule;

-- One-directional: scheduled runs should have a schedule_id,
-- but historical scheduled runs before this migration won't have one
ALTER TABLE runs ADD CONSTRAINT chk_runs_schedule_id
  CHECK (triggered_by = 'schedule' OR schedule_id IS NULL)
  NOT VALID;

ALTER TABLE runs VALIDATE CONSTRAINT chk_runs_schedule_id;

-- Index for looking up runs by schedule
CREATE INDEX IF NOT EXISTS idx_runs_schedule ON runs (schedule_id) WHERE schedule_id IS NOT NULL;

-- ============================================================
-- 7. Migrate existing schedule data from agents to schedules
-- ============================================================

INSERT INTO schedules (tenant_id, agent_id, name, frequency, time, day_of_week, prompt, enabled, last_run_at, next_run_at)
SELECT
  tenant_id,
  id,
  'Default schedule',
  COALESCE(schedule_frequency, 'manual'),
  schedule_time,
  schedule_day_of_week,
  schedule_prompt,
  COALESCE(schedule_enabled, false),
  schedule_last_run_at,
  schedule_next_run_at
FROM agents
WHERE schedule_frequency IS NOT NULL
  AND schedule_frequency != 'manual';

-- ============================================================
-- 8. Drop old schedule columns from agents
-- ============================================================

-- Drop constraints first
ALTER TABLE agents DROP CONSTRAINT IF EXISTS chk_schedule_time_required;
ALTER TABLE agents DROP CONSTRAINT IF EXISTS chk_schedule_day_of_week_weekly;
ALTER TABLE agents DROP CONSTRAINT IF EXISTS chk_schedule_prompt_required;
ALTER TABLE agents DROP CONSTRAINT IF EXISTS chk_schedule_enabled_not_manual;

-- Drop index
DROP INDEX IF EXISTS idx_agents_schedule_due;

-- Drop columns
ALTER TABLE agents DROP COLUMN IF EXISTS schedule_frequency;
ALTER TABLE agents DROP COLUMN IF EXISTS schedule_time;
ALTER TABLE agents DROP COLUMN IF EXISTS schedule_day_of_week;
ALTER TABLE agents DROP COLUMN IF EXISTS schedule_prompt;
ALTER TABLE agents DROP COLUMN IF EXISTS schedule_enabled;
ALTER TABLE agents DROP COLUMN IF EXISTS schedule_last_run_at;
ALTER TABLE agents DROP COLUMN IF EXISTS schedule_next_run_at;
