-- Prompt-injection scanner audit columns + tenant policy mode.
--
-- Adds the same audit-column triple to every row that the dispatch-time gate
-- (session_messages) or the write-time gate (agents, schedules) populates:
--
--   injection_detected   boolean NOT NULL DEFAULT false
--   injection_confidence text NULL  -- 'high' | 'medium' | 'low' when detected
--   injection_patterns   text[] NULL
--
-- Adds tenants.injection_enforce_mode TEXT default 'log_only' with a CHECK
-- constraint. v1 ships every tenant in 'log_only' so the scanner produces
-- telemetry without blocking; the flip to 'enforce' is gated on a follow-up
-- plan that consumes v1 telemetry.
--
-- See docs/plans/2026-05-06-002-feat-prompt-injection-scanner-plan.md (U2).
--
-- All column adds use IF NOT EXISTS for idempotency. The CHECK on
-- injection_enforce_mode is wrapped in a DO block (Postgres lacks IF NOT
-- EXISTS for ADD CONSTRAINT) — matches the precedent in 034.
--
-- RLS is not re-asserted: policies on session_messages, agents, schedules,
-- and tenants are table-wide and apply automatically to new columns.

-- ============================================================
-- 1. session_messages — dispatch-time gate audit columns
-- ============================================================

ALTER TABLE session_messages
  ADD COLUMN IF NOT EXISTS injection_detected   BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE session_messages
  ADD COLUMN IF NOT EXISTS injection_confidence TEXT;
ALTER TABLE session_messages
  ADD COLUMN IF NOT EXISTS injection_patterns   TEXT[];

-- ============================================================
-- 2. agents — write-time gate audit columns (covers SoulSpec
--    markdown columns and the skills JSONB)
-- ============================================================

ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS injection_detected   BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS injection_confidence TEXT;
ALTER TABLE agents
  ADD COLUMN IF NOT EXISTS injection_patterns   TEXT[];

-- ============================================================
-- 3. schedules — write-time gate audit columns (covers
--    schedules.prompt)
-- ============================================================

ALTER TABLE schedules
  ADD COLUMN IF NOT EXISTS injection_detected   BOOLEAN NOT NULL DEFAULT FALSE;
ALTER TABLE schedules
  ADD COLUMN IF NOT EXISTS injection_confidence TEXT;
ALTER TABLE schedules
  ADD COLUMN IF NOT EXISTS injection_patterns   TEXT[];

-- ============================================================
-- 4. tenants.injection_enforce_mode
--
-- Per-tenant policy gate. v1 ships every tenant in 'log_only' — the scanner
-- runs and persists verdicts but never blocks at dispatch. Flipping a tenant
-- to 'enforce' activates the per-trigger policy matrix; that flip is the
-- subject of a follow-up plan.
-- ============================================================

ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS injection_enforce_mode TEXT NOT NULL DEFAULT 'log_only';

-- CHECK in a DO block for idempotency. ADD CONSTRAINT does not support
-- IF NOT EXISTS in Postgres.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
      FROM pg_constraint
     WHERE conname = 'chk_tenants_injection_enforce_mode'
       AND conrelid = 'tenants'::regclass
  ) THEN
    ALTER TABLE tenants ADD CONSTRAINT chk_tenants_injection_enforce_mode
      CHECK (injection_enforce_mode IN ('log_only', 'enforce'));
  END IF;
END $$;
