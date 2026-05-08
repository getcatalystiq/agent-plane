-- Migration 041: schedules can publish their final agent reply to a chat
-- platform channel via the Chat SDK adapter, replacing the previous
-- pattern of having the agent itself call Composio's SLACKBOT_SEND_MESSAGE
-- tool to deliver scheduled posts.
--
-- Background. The agent today posts weekly summaries to #general by
-- invoking `mcp__composio__SLACKBOT_SEND_MESSAGE` from inside its
-- reasoning loop. That works but ties the schedule's delivery channel
-- to the agent's prompt + tool inventory. Removing Composio (the
-- direction we're heading — see PR #38 on native typing indicators
-- and follow-ups) breaks that delivery path.
--
-- This migration adds two NULL-default columns on the schedules table:
--
--   target_platform  — 'slack' | 'discord' | NULL.  When NULL, the
--                       schedule has no platform delivery and behaves
--                       exactly like today (agent runs, output lives
--                       only in the session_messages transcript).
--                       When set, the scheduled-runs cron collects the
--                       agent's final reply text from the dispatch
--                       stream and posts it to `target_channel` via the
--                       cached bot's adapter (`postChannelMessage`).
--
--   target_channel   — platform-native channel id.
--                       Slack: a `C…` channel id, or `G…` for private
--                       groups, or `D…` for DMs.
--                       Discord: an 18-19 digit channel snowflake.
--                       Stored as TEXT (no length cap — Slack ids are
--                       short, Discord snowflakes are short, no need to
--                       impose a per-platform constraint here).
--
-- Validity rule: both NULL or both set. Half-set = invalid because the
-- cron has nothing to do with one without the other. Enforced via a
-- CHECK constraint to keep the cron's runtime branching simple ("either
-- target_platform IS NOT NULL AND we have a channel, or skip").

ALTER TABLE schedules
  ADD COLUMN IF NOT EXISTS target_platform TEXT NULL
    CHECK (target_platform IS NULL OR target_platform IN ('slack', 'discord'));

ALTER TABLE schedules
  ADD COLUMN IF NOT EXISTS target_channel TEXT NULL;

ALTER TABLE schedules
  DROP CONSTRAINT IF EXISTS chk_sched_target_paired;

ALTER TABLE schedules
  ADD CONSTRAINT chk_sched_target_paired CHECK (
    (target_platform IS NULL AND target_channel IS NULL) OR
    (target_platform IS NOT NULL AND target_channel IS NOT NULL AND length(target_channel) > 0)
  );
