-- A2A Protocol Support: add a2a_enabled to agents, created_by_key_id to runs,
-- update triggered_by CHECK to include 'a2a'

-- ============================================================
-- 1. Add a2a_enabled column to agents
-- ============================================================
-- Safe: Postgres 11+ lazy default, no table rewrite
ALTER TABLE agents ADD COLUMN IF NOT EXISTS a2a_enabled BOOLEAN NOT NULL DEFAULT FALSE;

-- ============================================================
-- 2. Add created_by_key_id to runs
-- ============================================================
-- Nullable — existing runs have no key tracking.
-- Used by A2A tasks/get and tasks/cancel to scope visibility to the creating API key.
ALTER TABLE runs ADD COLUMN IF NOT EXISTS created_by_key_id UUID REFERENCES api_keys(id) ON DELETE SET NULL;

-- ============================================================
-- 3. Update triggered_by CHECK to include 'a2a'
-- ============================================================
-- Use dynamic PL/pgSQL constraint lookup (migration 015 pattern).
-- Drop ALL triggered_by CHECK constraints, then add the new one.
DO $$
DECLARE
  r RECORD;
BEGIN
  FOR r IN
    SELECT con.conname
    FROM pg_constraint con
    JOIN pg_attribute att ON att.attrelid = con.conrelid AND att.attnum = ANY(con.conkey)
    WHERE con.conrelid = 'runs'::regclass
      AND con.contype = 'c'
      AND att.attname = 'triggered_by'
  LOOP
    EXECUTE format('ALTER TABLE runs DROP CONSTRAINT %I', r.conname);
  END LOOP;
END $$;

ALTER TABLE runs ADD CONSTRAINT runs_triggered_by_check
  CHECK (triggered_by IN ('api', 'schedule', 'playground', 'chat', 'a2a'))
  NOT VALID;
ALTER TABLE runs VALIDATE CONSTRAINT runs_triggered_by_check;
