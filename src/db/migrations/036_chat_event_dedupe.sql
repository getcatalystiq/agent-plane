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

CREATE TABLE IF NOT EXISTS chat_event_dedupe (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  platform        chat_platform NOT NULL,
  event_id        TEXT NOT NULL,
  -- Persisted output of the first successful step run. WDK retry returns
  -- this so the workflow body sees the same { sessionId, messageId,
  -- innerRunId } on replay.
  session_id      TEXT NOT NULL,
  message_id      TEXT NOT NULL,
  inner_run_id    TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),

  UNIQUE (tenant_id, platform, event_id)
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
