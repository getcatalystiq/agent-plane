---
title: Workflow Dispatch Incident Runbook
date: 2026-05-06
plan: docs/plans/2026-05-05-001-refactor-workflow-sdk-dispatch-plan.md
audience: oncall + platform team
---

# Workflow Dispatch Incident Runbook

The dispatch refactor (U2–U10) moved every entry point onto a Vercel Workflow DevKit (WDK) workflow. This runbook covers the operational levers and recovery procedures for incidents on the workflow path.

> **Read the plan first.** The plan in `docs/plans/2026-05-05-001-refactor-workflow-sdk-dispatch-plan.md` is the single source of truth for the architecture; this runbook only covers operations.

## Quick reference

| Lever | Effect | Latency |
|---|---|---|
| `tenants.workflow_dispatch_overrides` JSONB | Per-tenant force-on/off (canary cohort or emergency disable) | ≤60s (cache TTL) |
| `WORKFLOW_DISPATCH_{API,SCHEDULE,WEBHOOK,A2A,CLEANUP,ADMIN}` env var | Per-trigger global toggle | One redeploy |
| `LEGACY_DISPATCH_GLASS_BREAK=on` env var | Force legacy for ALL triggers (post-U10a glass-break) | One redeploy |
| Clear `sessions.workflow_run_id` for one row | Force a stuck workflow-backed session back to legacy cleanup | Immediate |

## 1. Triage a stuck workflow

A workflow is "stuck" when its session row's status is `creating`, `active`, or `idle` past the per-row TTL or watchdog threshold AND `workflow_run_id` is non-null.

```bash
# Find stuck workflow-backed sessions
psql "$DATABASE_URL" -c "
  SELECT id, status, agent_id, workflow_run_id, idle_since, expires_at
  FROM sessions
  WHERE workflow_run_id IS NOT NULL
    AND status NOT IN ('stopped')
    AND created_at < NOW() - INTERVAL '1 hour'
  ORDER BY created_at;
"
```

For each stuck row:
1. **Read the WDK run state** — copy the `workflow_run_id` (strip the `wdk_v1_` prefix), open Vercel dashboard → Workflows → Runs, paste the run id. Inspect step boundaries + retry counts.
2. **Signal cancel from the cleanup cron** — the cron runs every 5 minutes and signals cancel for stuck sessions automatically. If the cron is failing, run `tryWorkflowCancel(sessionId, reason)` manually via a one-off endpoint or the Node REPL.
3. **If WDK cancel hangs** — the cleanup cron's 30s timeout fires and falls through to legacy direct-stop. The row ends up `stopped` either way, just slower.

## 2. Disable workflow for one tenant (emergency)

When a single tenant's workload exposes a workflow regression:

```bash
# Read current overrides
psql "$DATABASE_URL" -c "
  SELECT id, name, workflow_dispatch_overrides
  FROM tenants WHERE id = '<tenant-uuid>';
"

# Set per-trigger deny (api, schedule, webhook, a2a, cleanup, admin)
psql "$DATABASE_URL" -c "
  UPDATE tenants
  SET workflow_dispatch_overrides = workflow_dispatch_overrides ||
      '{\"api\": false, \"schedule\": false, \"webhook\": false, \"a2a\": false, \"cleanup\": false, \"admin\": false}'::jsonb
  WHERE id = '<tenant-uuid>';
"
```

The 60s process-level cache means propagation completes within a minute across function instances. **No redeploy needed.**

To re-enable: remove the keys from the JSONB or set them to `true`.

## 3. Disable workflow globally (per trigger)

When a regression affects all tenants on a specific trigger:

1. Vercel dashboard → Project → Settings → Environment Variables
2. Set the matching `WORKFLOW_DISPATCH_*` to `off`
3. Redeploy production

| Trigger | Env var |
|---|---|
| Public REST | `WORKFLOW_DISPATCH_API` |
| Schedule cron | `WORKFLOW_DISPATCH_SCHEDULE` |
| Webhook ingress | `WORKFLOW_DISPATCH_WEBHOOK` |
| A2A protocol | `WORKFLOW_DISPATCH_A2A` |
| Cleanup cron | `WORKFLOW_DISPATCH_CLEANUP` |
| Admin (playground+chat) | `WORKFLOW_DISPATCH_ADMIN` |

**Coexistence rule:** in-flight workflow-backed sessions continue on workflow even after the toggle is off. The toggle only affects NEW dispatches. If you need to migrate in-flight sessions, see step 4.

## 4. Force a workflow-backed row back to legacy

Valid only during Phases 2–3 (before U10a retirement) while the legacy paths still exist. Post-U10a, the legacy code is removed except behind glass-break (step 5).

```bash
psql "$DATABASE_URL" -c "
  UPDATE sessions
  SET workflow_run_id = NULL
  WHERE id = '<session-uuid>'
    AND tenant_id = '<tenant-uuid>';
"
```

The cleanup cron's `expires_at` sweep terminates the row via the legacy salvage-then-stop path on its next 5-minute tick. The associated workflow run becomes orphaned (it'll eventually expire on its own; logs show the abandonment).

**This is unsafe in general** — you're discarding the workflow's state-of-the-world. Only use when the workflow is genuinely stuck AND the cleanup cron's `tryWorkflowCancel` isn't recovering.

## 5. Glass-break revert (post-U10a)

When U10a retirement has merged but a long-tail workflow regression appears (e.g., week 4 after retirement), and you need an emergency revert without re-implementing dispatcher.ts:

1. Vercel dashboard → Set `LEGACY_DISPATCH_GLASS_BREAK=on`
2. Redeploy production

The `shouldUseWorkflow` helper short-circuits to `false` for ALL triggers when this env var is `on`. New dispatches go via the legacy path that's preserved behind the glass-break wrapper for one additional release cycle (~2 weeks post-U10a).

By-row rule still applies: existing workflow rows continue on workflow until their natural lifecycle ends (the glass-break does NOT migrate in-flight workflow sessions).

After the glass-break wrapper is removed in the follow-up cleanup PR, this lever is gone — the only path to legacy dispatch is reverting the U10a merge.

## 6. Deploy rollback during migration

Rolling back a deploy that ships any of U1–U10 is **unsafe** if there are in-flight workflow-backed sessions:

- Their `workflow_run_id` references a runtime version that may no longer recognise it (post-rollback)
- The `wdk_v1_` prefix lets rollback code detect format-incompatible runIds and route them to legacy salvage, but only if the rolled-back code still contains the legacy paths

**Before rolling back during a workflow migration phase:**

1. Check active workflow sessions: `SELECT count(*) FROM sessions WHERE workflow_run_id IS NOT NULL AND status NOT IN ('stopped');`
2. If non-zero AND your rollback target is older than U1's schema migration: those rows reference columns that don't exist post-rollback. The DB itself stays at the higher migration; the application code's queries will fail with "column does not exist." Either (a) accept the application errors and restore the rolled-back-from version after fixing the bug, or (b) drain the workflow rows manually via step 4 first.
3. If non-zero AND your rollback target is newer than U1's schema migration: the columns exist; in-flight rows may produce `WorkflowRunNotFoundError` from WDK after rollback. Cleanup cron's stuck-active watchdog (step 1) recovers them within one cron cycle.

**During Phase 4+ (post-U10a retirement):** rollback is a one-way door. Glass-break (step 5) is the supported revert lever.

## 7. Long-tail bugs to escalate

These class-of-bug signals warrant immediate escalation (paging on-call author of the U2-U10a stack):

- `WorkflowRuntimeError: Failed to serialize step arguments` — a step argument has Symbols/functions; this was the U0 spike's first failure mode and shouldn't reach production
- `Error: createHook() can only be called from inside a workflow function` — a step is calling createHook; same family
- `Error: Not supported in workflow functions` — a workflow body is calling getWritable/etc. directly; same family
- `WorkflowRuntimeError: Unconsumed event in event log: eventType=run_cancelled` — a render shim called `.cancel()` on a `WorkflowReadableStream`; verifies the U0 trap
- `HookNotFoundError` from a runner POST — runner backoff exhausted (30s budget); typically signals a slow cold-start chain or a failed createHook call inside the workflow body
- Watchdog firing on >5% of sessions — an indication that the workflow path is hanging at a higher rate than legacy did. Compare to pre-cutover commit-sha pain (the 5-of-5 commits the refactor was trying to eliminate); if regression > improvement, glass-break (step 5) and reopen the brainstorm
