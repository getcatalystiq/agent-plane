---
title: AgentPlane runs + sessions unification
type: requirements
status: active
date: 2026-04-27
related-plan: docs/plans/2026-04-27-003-refactor-runs-sessions-unification-plan.md
---

# AgentPlane runs + sessions unification

## Problem Frame

AgentPlane today runs agents through two parallel execution paths:

1. **One-shot runs** — `prepareRunExecution` + `finalizeRun` in `src/lib/run-executor.ts`, persisted to the `runs` table. Sandbox is killed when the response stream closes.
2. **Sessions** — `src/lib/session-executor.ts` writes a per-message runner script and resumes the SDK session. Sandbox is kept warm; cleanup cron stops idle sessions after ~10 minutes.

The two pipelines duplicate sandbox provisioning, MCP config building, transcript persistence, billing, and cancellation logic. The split also leaks into the public API (`/api/runs/*` vs `/api/sessions/*`) and the admin UI (`/admin/runs` vs the playground).

The sister codebase at `~/code/agent-co` was session-first from day one — there is no separate one-shot path. Every execution is a session; "one-shot" simply means a session marked `ephemeral` that stops after the first reply.

This document scopes a transition to that same shape: **everything is a session**, single dispatch chokepoint, hard cut on the legacy runs API.

## Goals

- One execution pipeline. One DB row shape per execution. One client concept.
- Structural parity with agent-co so that patterns, components, and bug fixes port between the two repos.
- Preserve AgentPlane's distinctive surface area: webhooks, public A2A, SoulSpec identity, plugin marketplace, dual runner.

## Non-Goals

- HITL / pause-resume / `thread_checkpoints` / `pending_runs` (agent-co has these; not porting).
- `is_orchestrator` / governance escalation / `run_audit_log`.
- Touching runner internals (Claude Agent SDK / Vercel AI SDK ToolLoopAgent dual-runner stays).
- Migration of historical run rows. Hard cut, drop the table.

## Decisions

- **R1.** Sessions become the only execution unit. The `runs` table and `/api/runs*` endpoints are removed (hard cut, no shim, no deprecation window).
- **R2.** New schema: `sessions` (one row per logical conversation/execution) + `session_messages` (one row per user-prompt → agent-reply turn, holds cost / tokens / triggered_by / transcript_blob_url / status / error_type).
- **R3.** Default lifecycle is **persistent**: sandbox stays warm after a response, cleanup cron stops it after the existing idle timeout (~10 min).
- **R4.** Internal triggers — `schedule`, `webhook`, `a2a` — set `ephemeral: true` on dispatch. The sandbox stops as soon as the message completes. Public API and admin chat / playground default persistent.
- **R5.** A2A `taskId` maps to `session_message_id`. Each `message/send` call creates a fresh ephemeral session.
- **R6.** Single dispatch chokepoint replaces `prepareRunExecution`+`finalizeRun` and `session-executor.ts`. Caller passes `(sessionId | undefined, prompt, triggeredBy, ephemeral?)`.
- **R7.** Cancellation is coarse: `POST /api/sessions/:id/cancel` aborts the in-flight message **and** stops the sandbox. There is no message-level cancel verb.
- **R8.** In-session concurrency: atomic CAS on `sessions.status idle → active`. A second message arriving while the first is in flight returns 409 Conflict.
- **R9.** Tenant concurrency cap: 10 concurrent **active** sessions per tenant (rename of the existing 10-runs cap).
- **R10.** Streaming endpoint: `GET /api/sessions/:id/messages/:msgId/stream` (per-message reconnect). `GET /api/sessions/:id/stream` is sugar that resolves to the in-flight message.
- **R11.** Idempotency keys stay valid on `POST /api/sessions` and `POST /api/sessions/:id/messages`.
- **R12.** Admin UI: `/admin/runs` is removed. `/admin/sessions` shows the session list; clicking a session shows its messages with transcripts and cost.
- **R13.** Existing run history is dropped at cutover; orphaned transcript blobs are cleaned up with a one-time pass.

## Acceptance Examples

- **AE1.** Tenant POSTs `/api/sessions` with a prompt → receives streamed NDJSON ending with `result`. Session row is `idle`, sandbox is warm. (R3, R6)
- **AE2.** Tenant POSTs `/api/sessions/:id/messages` while the previous message is mid-flight → 409 Conflict. (R8)
- **AE3.** Schedule cron tick at 09:00 → creates a session with `ephemeral: true`, runs the agent, sandbox stops. `session_messages.triggered_by = 'schedule'`. (R4)
- **AE4.** Webhook delivery POSTed by GitHub → HMAC verified, session created with `ephemeral: true`, sandbox stops after response. (R4)
- **AE5.** External A2A `message/send` → returns `taskId` whose value is the new `session_message_id`. `tasks/get(taskId)` returns terminal state. (R5)
- **AE6.** Tenant POSTs `/api/sessions/:id/cancel` mid-stream → stream closes, session row is `stopped`, sandbox is killed. (R7)
- **AE7.** Tenant POSTs `/api/runs` (legacy) → 404. (R1)
- **AE8.** Admin UI: `/admin/sessions/:id` renders session metadata + a list of messages with transcripts and cost. (R12)

## Open Questions

None outstanding — brainstorm decisions are locked.

## Sources

- Sister repo: `~/code/agent-co` — session-first execution model.
- AgentPlane `CLAUDE.md` — current execution flows.
- Brainstorm conversation 2026-04-27 (this session).
