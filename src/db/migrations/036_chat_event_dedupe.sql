-- Idempotency dedupe table for chat ingress.
--
-- Plan reference: A6 fix for review run 20260506-221948-2402b0ed P1 #13.
--
-- The chat workflow's startInnerDispatchStep calls reserveSessionAndMessage
-- which inserts into session_messages. WDK retries an entire step on
-- transient failure — that would re-run reserveSessionAndMessage and
-- double-create rows. The fix: a unique-key dedup table keyed on the
-- inbound chat event id. The step CAS-inserts into chat_event_dedupe
-- BEFORE reserve; on retry, the existing row's recorded innerRunId is
-- returned and reserve is skipped.
--
-- The plan's runbook telemetry counter `chat.workflow_resume_count`
-- maps to inserts that hit the conflict path.

-- session_id, message_id, inner_run_id are filled in via a follow-up
-- UPDATE after reserveSessionAndMessage + start(). The placeholder row
-- (with NULL fillables) is inserted FIRST as a claim, so concurrent
-- step retries serialize at the unique constraint — the loser sees
-- the placeholder, polls for completion, and returns the winner's
-- runId without ever invoking reserveSessionAndMessage. This avoids
-- the orphan-on-retry pattern flagged in review run 20260506-232400-round2
-- as REL-R2-01.
CREATE TABLE IF NOT EXISTS chat_event_dedupe (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  platform        chat_platform NOT NULL,
  event_id        TEXT NOT NULL,
  session_id      TEXT,
  message_id      TEXT,
  inner_run_id    TEXT,
  claimed_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, platform, event_id),
  -- Once filled, all three must be non-null together.
  CONSTRAINT chat_event_dedupe_filled_atomically CHECK (
    (session_id IS NULL AND message_id IS NULL AND inner_run_id IS NULL) OR
    (session_id IS NOT NULL AND message_id IS NOT NULL AND inner_run_id IS NOT NULL)
  )
);

ALTER TABLE chat_event_dedupe ENABLE ROW LEVEL SECURITY;
ALTER TABLE chat_event_dedupe FORCE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON chat_event_dedupe
  FOR ALL TO app_user
  USING (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = NULLIF(current_setting('app.current_tenant_id', true), '')::uuid);

CREATE INDEX IF NOT EXISTS idx_chat_event_dedupe_lookup
  ON chat_event_dedupe (tenant_id, platform, event_id);

-- Auto-clean: a 7-day TTL via a cleanup-cron sweep is sufficient. The
-- workflow's idempotency window is bounded by the inner workflow's
-- runId being valid; runIds typically live for hours, not days. 7 days
-- gives generous headroom for replay-on-incident scenarios.
CREATE INDEX IF NOT EXISTS idx_chat_event_dedupe_created_at
  ON chat_event_dedupe (created_at);
