# Multiple Agent Schedules

**Date:** 2026-03-08
**Status:** Ready for planning

## What We're Building

Move from a single schedule per agent (stored as flat columns on `agents`) to an arbitrary number of independent schedules per agent. Each schedule has its own name, frequency, prompt, enabled toggle, and run tracking.

**Current state:** 7 schedule columns on the `agents` table (`schedule_frequency`, `schedule_time`, `schedule_day_of_week`, `schedule_prompt`, `schedule_enabled`, `schedule_last_run_at`, `schedule_next_run_at`). Max 1 schedule per agent. Admin-only feature.

**Target state:** A dedicated `schedules` table with FK to `agents`. Unlimited schedules per agent. Each independently configurable and trackable.

## Why This Approach

**Dedicated `schedules` table** over JSONB because:
- The cron dispatcher needs `FOR UPDATE SKIP LOCKED` on individual schedule rows — this is the core dispatch mechanism and JSONB can't support it
- Partial index on `next_run_at WHERE enabled = true` works naturally on rows
- Clean relational model, easy to query due schedules across all agents
- RLS enforcement per-tenant follows existing patterns

**Rejected: JSONB array on agents** — can't claim individual schedules atomically, no partial indexes, complex array mutations for concurrent updates.

## Key Decisions

1. **Fully independent schedules** — each schedule has its own enabled/disabled toggle, frequency, time, day_of_week, prompt, last_run_at, next_run_at. No agent-level master toggle.

2. **New `schedules` table** — not JSONB. FK to `agents`, tenant_id for RLS, branded `ScheduleId` type.

3. **Optional name per schedule** — e.g. "Morning report", "Weekly digest". Helps identify schedules in UI and run history.

4. **No hard limit** on schedules per agent — rely on tenant budget to constrain usage naturally.

5. **Claim individual schedules** in the cron dispatcher — each schedule row is independently claimable via `FOR UPDATE SKIP LOCKED`. Multiple schedules on the same agent can fire at different times.

6. **Link runs to schedules** — add nullable `schedule_id` FK on `runs` table so you can trace which schedule produced which run.

7. **Migrate existing data** — migration copies current agent schedule columns into the new `schedules` table, then drops the old columns.

8. **Admin UI: list with add/remove** — schedule cards on the agent detail page. Each card is inline-editable with a delete button. "Add Schedule" button appends a new one.

## Scope

### In scope
- New `schedules` table + migration (data migration from agent columns)
- `schedule_id` FK on `runs` table
- Branded `ScheduleId` type
- Admin CRUD API for schedules (nested under agents)
- Updated cron dispatcher to claim schedule rows instead of agent rows
- Updated cron executor to accept schedule_id and use per-schedule prompt
- Admin UI: schedule list on agent detail page (add/edit/delete)
- Agent list page: updated schedule column (show count or summary)

### Out of scope (for now)
- Tenant-facing schedule API (remains admin-only)
- SDK schedule types
- Per-schedule model/tool overrides (each schedule uses the agent's config)
- Schedule templates or presets

## Schema Sketch

```sql
CREATE TABLE schedules (
  id VARCHAR(20) PRIMARY KEY,
  tenant_id VARCHAR(20) NOT NULL REFERENCES tenants(id),
  agent_id VARCHAR(20) NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  name VARCHAR(100),
  frequency VARCHAR(20) NOT NULL DEFAULT 'manual',
  time TIME,
  day_of_week SMALLINT,
  prompt TEXT,
  enabled BOOLEAN NOT NULL DEFAULT false,
  last_run_at TIMESTAMPTZ,
  next_run_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Same CHECK constraints as current agent columns
-- RLS policy on tenant_id
-- Partial index: idx_schedules_due ON schedules(next_run_at) WHERE enabled = true

ALTER TABLE runs ADD COLUMN schedule_id VARCHAR(20) REFERENCES schedules(id) ON SET NULL;
```
