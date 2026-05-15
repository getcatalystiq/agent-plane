-- Migration 040: relax chat_event_dedupe atomic-fill constraint to permit
-- the two-stage fill the chat workflow actually performs.
--
-- Background. Migration 037 added:
--
--   CHECK (
--     (session_id IS NULL AND message_id IS NULL AND inner_run_id IS NULL) OR
--     (session_id IS NOT NULL AND message_id IS NOT NULL AND inner_run_id IS NOT NULL)
--   )
--
-- The intent was "all-or-none atomicity" so a failed UPDATE wouldn't leave
-- a partially-filled placeholder. But the chat workflow's actual fill
-- pattern in `startInnerDispatchStep` (chat-dispatch-workflow.ts) is
-- TWO-stage by design:
--
--   1. INSERT (..., NULL, NULL, NULL) — wins the ON CONFLICT race.
--   2. reserveSessionAndMessage() returns (session_id, messageId).
--   3. UPDATE SET session_id, message_id  ← stage 1 fill (inner_run_id
--      still NULL — we don't have it yet).
--   4. start(dispatchWorkflow, ...) returns runId.
--   5. UPDATE SET inner_run_id  ← stage 2 fill.
--
-- The two-stage pattern is intentional (per the existing code comment):
-- pinning session_id + message_id BEFORE `start()` lets a crash between
-- (4) and (5) leave a "recoverable orphan" the cleanup sweep can finish,
-- instead of letting a WDK retry double-dispatch.
--
-- The 037 constraint is incompatible with that pattern: stage-1 UPDATE
-- produces (session NOT NULL, message NOT NULL, inner_run_id NULL),
-- which neither branch of the OR allows → CHECK violation → step throws
-- → WDK retries → loser path → eventually FatalError.
--
-- Fix. Relax the constraint to permit the legitimate intermediate state
-- (RESERVED — session + message pinned, inner_run_id pending). Still
-- forbid the impossible states (inner_run_id set without session, or
-- message set without session, etc.) so the orphan cleanup sweep
-- continues to have a clean predicate (`inner_run_id IS NULL`) for
-- finding placeholders that need a final UPDATE.
--
-- Valid states after this migration:
--   - EMPTY:    (NULL,    NULL,    NULL)    — fresh INSERT, race winner
--   - RESERVED: (set,     set,     NULL)    — stage 1 fill, awaiting start()
--   - FILLED:   (set,     set,     set)     — stage 2 fill, fully claimed
--
-- Forbidden states:
--   - inner_run_id NOT NULL while session_id or message_id is NULL
--     (would mean a runId exists for a session/message that doesn't)
--   - session_id NOT NULL with message_id NULL, or vice versa
--     (incomplete reservation that the workflow never produces)

ALTER TABLE chat_event_dedupe
  DROP CONSTRAINT IF EXISTS chat_event_dedupe_filled_atomically;

ALTER TABLE chat_event_dedupe
  ADD CONSTRAINT chat_event_dedupe_filled_atomically CHECK (
    -- EMPTY placeholder
    (session_id IS NULL AND message_id IS NULL AND inner_run_id IS NULL) OR
    -- RESERVED (post-reserveSessionAndMessage, pre-start())
    (session_id IS NOT NULL AND message_id IS NOT NULL AND inner_run_id IS NULL) OR
    -- FILLED (post-start(), workflow fully claimed)
    (session_id IS NOT NULL AND message_id IS NOT NULL AND inner_run_id IS NOT NULL)
  );
