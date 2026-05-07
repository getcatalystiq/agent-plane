---
date: 2026-05-05
topic: workflow-sdk-dispatch
---

# Wrap AgentPlane Dispatch in Vercel Workflow SDK

## Summary

Replace `dispatcher.ts`'s ad-hoc orchestration with a Vercel Workflow SDK workflow whose steps mirror the existing dispatch lifecycle: reserve, ensure-sandbox, run-turn, finalize, tail. The agent stays inside the sandbox, the runner script stays as-is, subscription billing stays as-is — only the outer dispatch becomes a durable, replayable, retryable workflow.

---

## Problem Frame

The dispatcher is the active firefighting center of the codebase. Five of the last five commits on `main` are dispatcher / cleanup / schedule fixes — each one a targeted patch to a state-machine edge case (empty stream, iterator throw, post-drain fallback after detach, stuck-running fallback, per-agent active watchdog). Each fix lands and a new edge case surfaces, because the dispatcher coordinates async work, idempotent CAS transitions, sandbox lifecycle, streaming, cancellation, and salvage across multiple entry points (public REST, schedule cron, webhook ingress, A2A, cleanup cron) without a primitive that gives those concerns a durable, observable spine.

The work that the dispatcher does is structurally the work a workflow primitive does well: idempotent steps, explicit retries with backoff, replay for debugging, cancellation as a first-class signal, observability of step-level failures. open-agents.dev's published architecture confirms this is a workable pattern at this exact problem shape. AgentPlane has not adopted it because subscription billing and the Claude Agent SDK runner constrain how far the open-agents inversion (agent-outside-VM) can go — but that constraint applies to the *inside* of a turn, not to the dispatch loop *around* turns.

The carrying cost of staying on the custom dispatcher compounds: every new entry point (next was webhooks, then A2A) inherits the patch surface and re-validates the same edge cases.

---

## Actors

- A1. Tenant API consumer: calls public REST endpoints to start sessions and send messages
- A2. Schedule cron: per-minute dispatcher claims due agents and sends messages with `triggeredBy='schedule'`
- A3. Webhook ingress: HMAC-verified inbound delivery dispatches an ephemeral message
- A4. A2A client: external agent-to-agent caller starting or continuing a contextId-keyed session
- A5. Cleanup cron: periodic sweeper for idle TTL, stuck `creating`, stuck `active`, orphan sandbox, expires_at cap
- A6. Operator: AgentPlane maintainer reading run history, replays, and metrics for triage

---

## Key Flows

- F1. Public REST single-message dispatch
  - **Trigger:** A1 POSTs `/api/sessions/:id/messages`
  - **Actors:** A1
  - **Steps:** route handler resolves tenant + session → starts workflow run with `(sessionId, messageId, prompt, audit)` → workflow reserves message + budget + concurrency → ensures sandbox → runs turn (streams NDJSON to caller) → finalizes billing/transcript → tails session backup
  - **Outcome:** caller receives streamed result; session transitions to `idle` (or `stopped` if ephemeral); workflow run is queryable for replay
  - **Covered by:** R1, R2, R3, R4, R7, R8

- F2. Cancellation mid-turn
  - **Trigger:** A1 or A6 POSTs `/api/sessions/:id/cancel`
  - **Actors:** A1, A4, A6
  - **Steps:** cancel handler signals the workflow run → run-turn step receives abort signal → sandbox process killed → finalize step records `cancelled` status → tail step skipped or runs salvage
  - **Outcome:** message marked `cancelled`, session marked `stopped`, transcript salvaged where possible
  - **Covered by:** R5, R12

- F3. Crash recovery during run-turn
  - **Trigger:** Vercel deploys a new version, or the function host crashes, while a run-turn step is mid-flight
  - **Actors:** A6
  - **Steps:** workflow runtime restarts the run → reserve and ensure-sandbox steps replay (idempotent on `(sessionId, messageId)`) → run-turn either re-attaches via session resume or fails-fast with explicit `recovery_unsupported` so finalize records the canonical failure
  - **Outcome:** no half-finalized messages; either the message completes on retry or it is recorded as failed with a reason
  - **Covered by:** R6, R9, R12

- F4. Cleanup of stuck or expired sessions
  - **Trigger:** A5 cleanup cron tick
  - **Actors:** A5, A6
  - **Steps:** scan database for sessions in offending states → for each, signal the corresponding workflow run to cancel → workflow's cancel path runs salvage and finalize → session transitions to `stopped`
  - **Outcome:** stuck sessions terminate via the same workflow primitive used for explicit cancels; salvage rules unify
  - **Covered by:** R5, R10, R12

---

## Requirements

**Workflow shape**
- R1. The dispatch lifecycle is implemented as a single workflow type whose steps correspond to: reserve, ensure-sandbox, run-turn, finalize, tail. Step boundaries align with the durable transition points of the existing dispatcher.
- R2. Each step is independently retryable on idempotent inputs keyed by `(sessionId, messageId)`. Reserve is idempotent on the message row; ensure-sandbox on the sandbox handle; finalize on the message billing row; tail on the session backup blob path.
- R3. The workflow is the single chokepoint for execution: every entry point that today calls `dispatchSessionMessage` instead starts a workflow run. No alternative dispatch path is added.

**Streaming and cancellation**
- R4. Public REST and A2A both stream directly off the same workflow handle. Each entry point keeps its existing wire-format vocabulary (NDJSON for REST, A2A-spec SSE events for A2A); the workflow emits a canonical event stream and each route renders it into its own surface. There is one streaming codepath and one cancellation path: `tasks/cancel` and `/api/sessions/:id/cancel` both signal the workflow run.
- R5. Cancellation is a first-class workflow signal. Every entry point that can cancel (REST cancel, schedule release, cleanup cron, A2A `tasks/cancel`) signals the workflow run; the run-turn step responds via abort. No second cancellation path exists.

**Durability boundaries**
- R6. Mid-turn durability is explicitly out of scope: the run-turn step is one workflow step. On retry, the workflow first attempts SDK session resume against the existing sandbox. If resume is impossible (sandbox gone, `sdk_session_id` expired), the workflow performs exactly one auto-reissue — boot a fresh sandbox and re-issue the same prompt as a new turn in the same session. If the auto-reissue also fails, finalize records `recovery_unsupported` and marks the message `failed`. Auto-reissue is bounded at one attempt to bound double-billing exposure on transient failures.
- R7. Sandbox boot and reconnect are inside ensure-sandbox; the existing snapshot-based cold-start logic is reused. The workflow does not change snapshot management.
- R8. Subscription billing via per-tenant `CLAUDE_CODE_OAUTH_TOKEN` flows unchanged into the run-turn step's sandbox env. AI Gateway routing for non-Anthropic models is unchanged.

**Migration and rollout**
- R9. Migration is staged by entry point. Public REST sessions/messages and the cleanup cron migrate first. Schedule cron, webhook ingress, and A2A migrate after, each behind its own toggle.
- R10. During migration, both the legacy dispatcher path and the workflow path coexist with a per-entry-point toggle. In-flight sessions started under one path always finish under that path; toggle changes only affect new starts.
- R11. The legacy dispatcher is retired once all five entry points (REST, schedule, webhook, A2A, cleanup) have run on workflow in production for one full cleanup-cron cycle without regression.

**Observability**
- R12. Workflow run history is the operational audit surface for execution: each step's start, end, retry, and failure reason are inspectable from the admin UI without scraping logs. The `session_messages` table remains the billing record and is unchanged in shape.
- R13. Existing structured log lines emitted from the runner and from finalize are preserved (the workflow does not replace logging) so that ad-hoc log queries continue to work during and after migration.

---

## Acceptance Examples

- AE1. **Covers R5, R12.** Given a session in `active` status with a run-turn step in flight, when A1 POSTs `/api/sessions/:id/cancel`, the workflow run receives a cancel signal, the sandbox process exits, the finalize step records `cancelled` with whatever transcript was salvaged, and the session transitions to `stopped`. The workflow's run history shows the cancel signal and the salvage outcome inline with the failed step.

- AE2. **Covers R6, R9, R12.** Given a run-turn step is mid-flight when Vercel rolls out a new deploy that terminates the function host, when the workflow runtime restarts the run on the new version, the reserve and ensure-sandbox steps replay to no-op (idempotent), and the run-turn step either re-attaches to the SDK session via `sdk_session_id` and continues, or — if the original sandbox is gone — auto-reissues the prompt against a fresh sandbox exactly once. If the reissue also fails, finalize marks the message `failed` with reason `recovery_unsupported`. The message is never half-finalized; the user is never billed for more than two turns from one prompt.

- AE3. **Covers R10.** Given the workflow toggle is enabled for public REST and disabled for schedule cron, when a schedule tick dispatches an agent and a separate REST request hits an unrelated session, the schedule message executes on the legacy dispatcher and the REST message executes on the workflow. Neither path interferes with the other; both write to the same `sessions` and `session_messages` tables under the existing schema.

- AE4. **Covers R3.** When a new execution entry point is added (e.g., a future trigger source), it integrates by starting a workflow run with the existing audit triple. No new branch in `dispatcher.ts` and no parallel dispatch helper is introduced.

---

## Success Criteria

- The patch-of-the-week pattern stops: in the quarter after full cutover, dispatcher-shaped fixes drop to near zero, replaced by either workflow-runtime fixes (which Vercel owns) or fixes inside the runner / sandbox layers (orthogonal to dispatch).
- Operators can answer "what happened to message X" from a single workflow run page in the admin UI, without correlating logs and database state by hand.
- A new entry point can be added by writing a route handler that starts a workflow run, with no new dispatcher branches and no new lifecycle bookkeeping.
- For ce-plan: every step in the workflow shape has a concrete idempotency key, retry policy, and cancellation behavior named in the requirements doc; planning chooses the API surface and code organization, not the lifecycle semantics.

---

## Scope Boundaries

- Adopting open-agents.dev's "agent outside the VM" inversion. Explicitly rejected as Option A in dialogue; subscription billing and Claude SDK ergonomics keep the agent inside the sandbox.
- Switching to a Vercel-AI-SDK-only runner. Rejected as Option C; would drop subscription billing.
- Adopting open-agents' explorer/executor subagent split. Orthogonal to dispatch; separate brainstorm if pursued.
- Pivoting positioning (B2B → prosumer) or distribution (multi-tenant SaaS → deploy-your-own).
- Replacing API-key auth with Better Auth + Vercel/GitHub OAuth.
- Changing the runner shape (`runner-<messageId>.mjs` per-message script, NDJSON wire format, transcript upload protocol).
- Changing the connector model (Composio + custom MCP servers + plugin marketplace).
- Mid-turn checkpointing or surviving sandbox hibernation across a single SDK call.
- Schema changes to `sessions` or `session_messages`. The workflow rides on top of the existing schema.

---

## Key Decisions

- Workflow boundary is the dispatch loop, not the SDK loop. Rationale: the SDK is opaque; only the work between SDK calls is durable-friendly. This is the explicit trade vs open-agents.dev, which uses AI SDK so each tool call can be a workflow step.
- Migration is staged per entry point with coexistence, not a flag-day cutover. Rationale: five entry points with subtly different lifecycle semantics; staged migration lets each one stabilize before the next moves over.
- Workflow run history becomes the audit surface; `session_messages` stays the billing record. Rationale: avoid doubling state of record. Billing has hard requirements (immutability, reconciliation) that workflow run history does not satisfy.
- Cancellation, schedule release, and cleanup all funnel into one workflow signal. Rationale: today these have three near-but-not-quite-identical paths in `dispatcher.ts` + `cleanup-sessions` cron + `scheduled-runs` cron; collapsing them is half the maintenance win.
- Crash-recovery policy is bounded auto-reissue: try SDK session resume first; on impossibility, boot a fresh sandbox and re-issue the same prompt exactly once; on second failure, record `recovery_unsupported`. Rationale: smooths transient infra hiccups (the user-perceived common case) without unbounded double-billing exposure (the long-tail correctness concern).
- REST and A2A share one streaming primitive — a canonical workflow event stream rendered to each entry point's wire format. Rationale: unifies cancellation (one signal path) and stops dispatch-shaped bugs from being two near-but-not-identical bugs in two routes. Cost is a render shim per entry point, which is cheaper than two streaming codepaths to maintain.

---

## Dependencies / Assumptions

- Vercel Workflow SDK supports streaming output from a step to an HTTP route (open-agents.dev demonstrates this in production; verified at the architecture-fact level, not yet at the API level for AgentPlane's specific streaming patterns).
- Workflow SDK supports sub-300s step durations consistently (run-turn currently runs up to `agent.max_runtime_seconds`, default 600s, max 3600s). If step duration is bounded shorter, R6 needs revisiting.
- The 5-min process-level caches (`authCache`, MCP server cache, plugin tree cache) tolerate workflow restarts (a restart re-reads from DB on miss). No state is migrated into workflow-local memory.
- The existing 50-active-sessions-per-tenant concurrency cap is enforced by an atomic SQL guard inside reserve, not by workflow runtime quotas. Concurrency stays a database concern.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R4][Technical] Concrete shape of the workflow's canonical event stream and the per-entry-point render shims (REST NDJSON vs A2A SSE). Driven by the Workflow SDK API surface and existing `streaming.ts` patterns.

- [Affects R1, R7][Technical] Whether ensure-sandbox is one step or two (boot vs reconnect). Two steps gives finer retry granularity but more state to thread.
- [Affects R12][Technical][Needs research] Whether workflow run history can be embedded in the admin UI's existing run-detail page directly, or requires a separate "workflow run" tab. Depends on Workflow SDK's read APIs.
- [Affects R10][Technical] Toggle implementation: per-tenant column on `tenants`, env var, or KV-backed flag. Trade-off between blast radius of toggle changes and ease of incremental rollout.
- [Affects R5][Technical] How the cleanup cron signals the workflow when the workflow ID is not in process memory — likely requires recording the workflow run ID on the `sessions` row (one-column schema add at planning time, not in this brainstorm's scope).
