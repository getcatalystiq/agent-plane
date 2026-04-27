-- Webhook payload filter.
--
-- Adds tenant-defined per-source content filtering: deliveries are evaluated
-- against a boolean expression after content-dedupe and before createRun.
-- Mismatches are recorded with `filtered: true` + `filtered_reason` and the
-- sender receives 200 (no run created).

-- ============================================================
-- 1. webhook_sources: filter_rules
-- ============================================================
--
-- Single nullable JSONB document. Rule shape (validated server-side via Zod
-- in src/lib/validation.ts) is:
--   { combinator: "AND" | "OR",
--     conditions: [{ keyPath, operator, value? }, ...] }   (0..50 conditions)
-- NULL or empty conditions evaluates as matched (no filtering).

ALTER TABLE webhook_sources
  ADD COLUMN IF NOT EXISTS filter_rules JSONB NULL;

-- ============================================================
-- 2. webhook_deliveries: filtered audit
-- ============================================================
--
-- `filtered = true` means the delivery was suppressed by a filter rule
-- (either condition mismatch or evaluator error). Run rows have
-- `filtered = false`. Dedupe-suppressed deliveries also leave filtered=false
-- (the dedupe branch never invokes the filter).

ALTER TABLE webhook_deliveries
  ADD COLUMN IF NOT EXISTS filtered BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE webhook_deliveries
  ADD COLUMN IF NOT EXISTS filtered_reason TEXT NULL;
