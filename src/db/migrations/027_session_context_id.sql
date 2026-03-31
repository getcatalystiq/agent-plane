-- Add context_id column to sessions for A2A multi-turn session reuse.
-- When an A2A message includes a contextId, we look up an existing session
-- by context_id to reuse its sandbox instead of creating a new one.

ALTER TABLE sessions ADD COLUMN IF NOT EXISTS context_id TEXT;

-- Unique index scoped to tenant + agent for active/idle sessions.
-- Only one active session per contextId per agent per tenant.
CREATE UNIQUE INDEX IF NOT EXISTS idx_sessions_context_id
  ON sessions (tenant_id, agent_id, context_id)
  WHERE context_id IS NOT NULL AND status IN ('creating', 'active', 'idle');
