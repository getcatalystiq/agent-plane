---
title: Replace Custom Dispatcher with Vercel Workflow SDK
type: refactor
status: active
date: 2026-05-05
origin: docs/brainstorms/2026-05-05-workflow-sdk-dispatch.md
---

# Replace Custom Dispatcher with Vercel Workflow SDK

## Summary

Replace `src/lib/dispatcher.ts`'s ad-hoc orchestration with a Vercel Workflow DevKit (WDK) workflow whose steps mirror the existing dispatch lifecycle: reserve, ensureSandbox, launchRunner, awaitFinalize, finalize, tail. The runner stays inside the Vercel Sandbox (separate compute), and the workflow uses a WDK hook (`createHook` inside a step + `resumeHook` from the internal upload endpoint) — not a long-lived function — to wait for the runner's terminal event and to receive per-line transcript chunks, so the function-duration limit (300–900s) does not constrain the SDK call's runtime (up to 3600s). Hook iteration drives both the durable stream and the terminal-event wakeup; there is no "stream write from outside" API.

---

## Problem Frame

Five of the last five commits on `main` are dispatcher / cleanup / schedule fixes. The dispatcher coordinates async work, idempotent CAS transitions, sandbox lifecycle, streaming, cancellation, and salvage across five entry points (REST, schedule cron, webhook, A2A, cleanup cron) without a primitive that gives those concerns a durable, observable spine. WDK is purpose-built for this shape — see origin: `docs/brainstorms/2026-05-05-workflow-sdk-dispatch.md` for the full pain narrative and the rejected alternatives.

---

## Requirements

Carried from origin doc with R-IDs preserved. R1's step list is refined: origin R1's single run-turn step is split into launchRunner + awaitFinalize because Vercel's function-duration limit makes a single SDK-call-owning step infeasible — see Key Technical Decisions for the rationale.

**Workflow shape**
- R1. Dispatch lifecycle implemented as a single workflow type with steps reserve, ensureSandbox, launchRunner, awaitFinalize, finalize, tail (origin R1 refined — see Key Technical Decisions for the launchRunner / awaitFinalize split).
- R2. Each step independently retryable, idempotent on `(sessionId, messageId)`.
- R3. Workflow is the single chokepoint: every entry point that today calls `dispatchSessionMessage` instead starts a workflow run.

**Streaming and cancellation**
- R4. Public REST and A2A both stream off the same workflow handle. REST renders NDJSON; A2A renders A2A-spec SSE. One streaming codepath, one cancellation path.
- R5. Cancellation is a first-class workflow signal. REST cancel, schedule release, cleanup cron, A2A `tasks/cancel` all signal the workflow run.

**Durability boundaries**
- R6. Mid-turn checkpointing inside an SDK loop is out of scope. On retry where SDK session resume is impossible, the workflow performs exactly one auto-reissue (fresh sandbox + re-issue prompt). Second failure records `recovery_unsupported`.
- R7. Sandbox boot/reconnect inside ensureSandbox; existing snapshot logic reused.
- R8. Subscription billing via per-tenant `CLAUDE_CODE_OAUTH_TOKEN` flows unchanged into the runner's sandbox env. AI Gateway routing for non-Anthropic models unchanged.

**Migration and rollout**
- R9. Migration staged by entry point: REST + cleanup first; schedule, webhook, A2A after.
- R10. Coexistence with per-entry-point toggle. In-flight sessions complete on whichever path started them.
- R11. Legacy dispatcher retired only after all five entry points have run on workflow in production for one full cleanup-cron cycle without regression.

**Observability**
- R12. Workflow run history is the operational audit surface. `session_messages` remains the billing record, schema unchanged.
- R13. Existing structured log lines from runner and finalize preserved.

**Origin actors:** A1 (Tenant API consumer), A2 (Schedule cron), A3 (Webhook ingress), A4 (A2A client), A5 (Cleanup cron), A6 (Operator). Plan adds an implicit A7 (Admin user via playground/chat) covered by U5b — origin doc didn't enumerate the admin entry points but the codebase has them.
**Origin flows:** F1 (Public REST single-message dispatch), F2 (Cancellation mid-turn), F3 (Crash recovery during run-turn), F4 (Cleanup of stuck or expired sessions)
**Origin acceptance examples:** AE1 (covers R5, R12, tested in U6), AE2 (covers R6, R9, R12, tested in U2), AE3 (covers R10, tested in U5), AE4 (covers R3, tested in U9 via the explicit test-trigger extensibility scenario)

---

## Scope Boundaries

- Adopting open-agents.dev's "agent outside the VM" inversion (origin-rejected as Option A)
- Switching to AI-SDK-only (origin-rejected as Option C — would drop subscription billing)
- Adopting open-agents' explorer/executor subagent split — orthogonal, separate brainstorm
- Pivoting positioning (B2B → prosumer) or distribution (SaaS → deploy-your-own)
- Replacing API-key auth with Better Auth + Vercel/GitHub OAuth
- Changing the runner shape (per-message script, NDJSON wire format, internal upload protocol) beyond the targeted change in U3 to make per-line streaming the default
- Changing the connector model (Composio + custom MCP servers + plugin marketplace)
- Mid-turn checkpointing or surviving sandbox hibernation across a single SDK call
- Schema changes to `session_messages` are out of scope. `sessions` gains one nullable column (`workflow_run_id`) to carry the WDK run id for cancel/stream signaling — this is the planned narrowing of the origin's "no schema changes" boundary, called out explicitly so the deviation is deliberate.

### Deferred to Follow-Up Work

- Migration of in-flight legacy sessions onto the workflow path on cutover. Sessions drain on whichever path they started.
- Per-tenant toggle override (env-var-only is sufficient for v1 rollout; per-tenant override deferred until staging traffic validates the workflow path).
- Replacing `src/lib/streaming.ts`'s `createNdjsonStream` for non-workflow paths during coexistence — the legacy NDJSON helper continues to back legacy dispatch.
- Workflow-run-history admin UI (separate plan after the migration lands; placeholder log-correlation observability lives in U10 of this plan).

---

## Context & Research

### Relevant Code and Patterns

- `src/lib/dispatcher.ts` — current chokepoint (~1100 lines). Functions to extract / refactor:
  - `dispatchSessionMessage` (entry point) — replaced by workflow `start()` calls
  - `reserveSessionAndMessage` — becomes step 1 (the body is reused as-is; tx semantics unchanged)
  - `coldStartSandbox` + warm-handle cache + reconnect path (lines ~547–730) — becomes step 2
  - `runMessageStream` (lines ~547–874) — split across launchRunner step + per-line streaming bridge
  - `finalizeMessage` — becomes step 4 (already idempotent on message status check)
  - `sessionTail` — becomes step 5
  - `cancelSession` — preserves DB CAS, additionally signals workflow cancel
  - `invalidateSandboxHandle` — process-local cache invalidation; called from cancel and cleanup paths
- `src/lib/streaming.ts` — `createNdjsonStream` with heartbeat + 4.5min detach. Workflow streams replace this for workflow-backed paths; legacy keeps using it during coexistence.
- `src/lib/sessions.ts` — atomic CAS helpers (`casCreatingToActive`, `casToStopped`, `transitionSessionStatus`, `casActiveToIdle`, `casExpireToStopped`, `forceStopSession`) and stuck-state queries. All reused as-is from inside workflow steps.
- `src/lib/session-messages.ts` — `transitionMessageStatus`, `checkTenantBudget`. Reused as-is.
- `src/lib/sandbox.ts` — `createSessionSandbox`, `reconnectSessionSandbox`, `reconnectSandbox`, `salvageRunnerTranscript`. Reused as-is.
- `src/app/api/internal/messages/[messageId]/transcript/route.ts` — currently the runner's "I'm done" upload endpoint. Refactored in U3 to accept incremental per-line POSTs and forward each chunk to the workflow stream via `getRun(runId).getWritable()`, plus fire the `runner-terminal` signal on the terminal event.
- `src/app/api/cron/cleanup-sessions/route.ts` — sweeps for idle, stuck-creating, stuck-active, expired, orphan-sandbox. Each sweep gains a workflow-aware branch in U6.
- `src/app/api/cron/scheduled-runs/execute/route.ts` — has a 30s-per-read drain loop with `stream_detached` substring scanning that becomes a single `await run.returnValue` in U7.
- `src/app/api/webhooks/[sourceId]/route.ts` — `after()` handler with manual reader-drain (lines ~450–492). Replaced by workflow `start()` with `delivery_id` as idempotency key in U8.
- `src/lib/a2a.ts` — `SandboxAgentExecutor` (line ~514+) calls `dispatchSessionMessage`; `tasks/cancel` calls `cancelSession`. Both rewired to workflow APIs in U9.

### Institutional Learnings

- `docs/solutions/logic-errors/transcript-capture-and-streaming-fixes.md` — `result` and `error` events MUST always be captured even after `MAX_TRANSCRIPT_EVENTS` truncation; `text_delta` events MUST NOT be stored in `chunks[]`. The streaming bridge in U3 must preserve these rules when translating runner NDJSON to workflow stream writes.
- The same doc's "Bounded buffers need allowlists" principle applies to the workflow stream too: the per-line forwarder must not silently drop critical event types under any cap.

### External References

- [Vercel Workflow DevKit overview](https://vercel.com/docs/workflows) — public-beta TypeScript framework, Redis-backed durable streams on Vercel.
- [Workflow SDK foundations: starting workflows](https://workflow-sdk.dev/docs/foundations/starting-workflows) — `start(workflowFn, [args])` returns a `Run` with `runId`, `getReadable()`, `returnValue`, `status`.
- [Workflow SDK foundations: streaming](https://workflow-sdk.dev/docs/foundations/streaming) — `getWritable<T>()` inside a step writes to a Redis-backed stream; `getRun(runId).getReadable({ startIndex })` reconnects from any position; survives client disconnect.
- [Workflow SDK foundations: idempotency](https://workflow-sdk.dev/docs/foundations/idempotency) — `getStepMetadata().stepId` is stable across retries; pass it as the idempotency key to external APIs.
- [Vercel Functions duration limits](https://vercel.com/docs/functions/configuring-functions/duration) — Fluid Compute default 300s, configurable up to 800s on Pro / 900s on Enterprise. Anchors the function-timeout-vs-runtime decision below.
- [GitHub vercel/workflow](https://github.com/vercel/workflow) — source repo. Open-agents.dev (vercel-labs/open-agents) is the reference implementation that demonstrates the pattern in production for AI agents.

---

## Key Technical Decisions

> **U0 spike outcome (2026-05-06):** All 8 verification scenarios passed against a deployed Vercel preview. Several non-obvious WDK constraints surfaced and are now baked into the decisions below; the full rundown lives in `docs/research/wdk-spike-results.md`. Most consequential: `createHook` and the `for await` iterator MUST live in workflow body, but stream writes MUST live in a step — forcing a per-chunk-write step shape (not the original "one streamFromHook step that owns iteration + writes").

- **Run-turn semantics split, not preserved as one step.** Origin R6's *meaning* (no mid-turn checkpointing inside an SDK loop) is preserved, but the *step boundary* shifts: the SDK call lives in the sandbox runner, not in a workflow step. The workflow uses a WDK hook iterator (Pattern A — see below) to wait without holding function compute across the SDK call's duration. This is the only viable shape given Vercel function max duration (300s default Fluid Compute, up to 900s Enterprise) < worst-case `agent.max_runtime_seconds` (3600s).
- **Pattern A (Hook) for runner→workflow streaming, U0-spike-corrected.** The runner POSTs each NDJSON line to `/api/internal/messages/:messageId/transcript` (refactored to incremental). The endpoint calls WDK's `resumeHook(token, payload)` against a deterministic per-message hook token (`transcript:${messageId}`). The workflow body creates the hook *before* `launchRunner` runs, so the token exists by spawn time. **The U0 spike (verified 2026-05-06 against the deployed workflow runtime) measured a 500ms–1.2s registration window on Vercel cold-start during which `resumeHook` returns `HookNotFoundError`** — runner-side backoff (100ms→1.6s, 30s budget) absorbs it; the WDK resume-queue holds racy resumes once the hook does register. The workflow body iterates the hook with `for await (const chunk of hook)` and **dispatches each chunk's data to a small per-chunk `writeChunk(data: string)` step** that owns the actual `getWritable().getWriter().write()` call. The split is required by WDK: `createHook` and the iterator must live in the workflow body (calling them from a step throws `Error: createHook() can only be called from inside a workflow function`), while stream writes must live in a step (calling them from workflow body throws `Error: Not supported in workflow functions`). The terminal-kind chunk breaks the body's loop, returning to finalize. Function compute is held only inside the per-step invocations; long idle gaps between runner POSTs do not consume function time. **Cost note:** each `resumeHook` re-triggers the workflow runtime, AND each chunk produces one `writeChunk` step invocation. The coalescing strategy below caps this at ~50 events/min for typical agent runs.
- **Per-line POST coalescing (10 lines OR 100ms, whichever first).** Runner buffers NDJSON output and flushes either after 10 lines or 100ms, whichever fires first. Critical events (`result`, `error`) flush immediately and ignore the coalesce. This caps `resumeHook` calls at ~50/min for typical agent runs and bounds the workflow re-trigger event count — without losing the per-line truncation/text_delta rules from `docs/solutions/logic-errors/transcript-capture-and-streaming-fixes.md` (those run on each line as it's appended to the buffer, not on each POST).
- **Streaming bridge runs `scrubSecrets()` + `processLineAssets()` per-line, inside the `writeChunk` step (not on the POST endpoint and not in the render shims).** This preserves the institutional learning from `docs/solutions/logic-errors/transcript-capture-and-streaming-fixes.md`: secret redaction happens before any byte reaches the workflow stream (which is durable and consumed by both REST and A2A render shims and the transcript blob), and Composio/Firecrawl ephemeral asset URLs are persisted to Vercel Blob before the URL leaves the platform's trust boundary. The internal endpoint parses incoming NDJSON into `RunnerChunk`s and forwards them to `resumeHook`; scrubbing happens downstream, in the step.
- **Idempotency is DB-side; WDK `start()` is not used as a dedupe primitive.** WDK 4.x `start()` accepts `world`, `specVersion`, `deploymentId` only — there is no `idempotencyKey` parameter. Each entry point owns its own DB-side dedupe BEFORE calling `start()`: webhook uses `webhook_deliveries.delivery_id` UNIQUE index; REST/A2A use `(tenantId, idempotencyKey)` cache + the `(session_id, message_id)` schema uniqueness; schedule uses `(scheduleId, fireTime)` UNIQUE constraint added in U1. On duplicate, the entry point reads the prior `workflow_run_id` from the existing message row and returns its `getRun(runId)` handle to the caller.
- **One column added on sessions, one on schedules, one on tenants. Versioned run-id prefix.**
  - `sessions.workflow_run_id text NULL` carries the WDK run id (used by cancel/stream/cleanup). Stored as `wdk_v1_<id>` so a future incompatible WDK upgrade can detect format-incompatible runIds and route them to the salvage path on rollback.
  - `schedules.last_fired_dispatch_key text NULL` (UNIQUE per `schedule_id`) carries `(scheduleId, fireTime)` to prevent duplicate-fire idempotency races.
  - `tenants.workflow_dispatch_overrides JSONB DEFAULT '{}'` per-tenant deny-list `{"api": false, "schedule": false, …}` so on-call can opt one tenant out of workflow without redeploying. Empty default = follow global toggle.
- **Per-trigger env-var toggle + per-tenant deny-list.** `WORKFLOW_DISPATCH_{API,SCHEDULE,WEBHOOK,A2A,CLEANUP,ADMIN}` (six toggles, see below) plus the per-tenant override column. `shouldUseWorkflow(trigger, tenantId)` reads both: tenant override wins.
- **Six entry-point migrations, not five.** `src/app/api/admin/sessions/route.ts` and `src/app/api/admin/sessions/[sessionId]/messages/route.ts` (admin playground + chat triggers) are a sixth dispatch chokepoint. They get a sixth toggle (`WORKFLOW_DISPATCH_ADMIN`) and a sixth migration unit (U5b). Origin doc didn't enumerate them; their inclusion is mandatory for R3 ("workflow is the single chokepoint").
- **Cancellation: tenant-scoped lookup, signal, then DB.** `cancelSession(sessionId, tenantId)` reads the row tenant-scoped via existing RLS, extracts `workflow_run_id`, calls `getRun(runId).cancel()` only after confirming the row's tenant matches the caller. Then preserves the existing DB CAS-to-stopped path. The workflow body's `for await` iterator throws on cancel (verified U0 spike scenario 5); the catch block routes through finalize (which performs salvage-before-stop ordering matching the legacy cleanup cron). For legacy sessions (no runId), the existing direct-stop path runs unchanged. **Tenant binding is at the cancelSession boundary because WDK runIds are not tenant-scoped at the SDK level.** **Render shims must NEVER call `.cancel()` on `WorkflowReadableStream`** — that propagates upstream and cancels the run; only the explicit `cancelSession` path may cancel.
- **Auto-reissue (R6) is gated on three checks, not just attempt count.** Before reissue: (1) `session_messages.status` is still `running` (skip reissue if already completed/failed/cancelled), (2) workflow stream has zero chunks for this messageId (a non-empty stream means the runner reached operational state and side-effectful tools may have executed), (3) `reissue_attempts < 1` (the original cap). All three must pass; otherwise finalize records `recovery_unsupported`.
- **Runner has explicit retry contract; workflow has no implicit retry of runner spawn.** The runner's per-line POST gains an `X-Runner-Attempt-Sequence` monotonic header (resets per run). The streaming bridge's dedup tuple is `(messageId, attemptSequence, batchSequence)` so duplicate POSTs from the runner's own retries are skipped without entering the stream. The runner's exponential backoff is U0-derived: **100ms → 200ms → 400ms → 800ms → 1.6s, capped at 30s total budget on `HookNotFoundError`** (the cold-start hook-registration window WDK exhibits on Vercel). On other 5xx: same backoff, max 5 attempts. `launchRunner` step's idempotency uses a DB-side `session_messages.runner_started_at TIMESTAMPTZ NULL` column set transactionally inside the same step's tx — replay finds non-null and skips spawn. Sandbox-side process inspection is NOT relied upon.
- **Test posture: characterization-first, with named test cases per recent commit.** A new `tests/unit/dispatcher-characterization.test.ts` pins current dispatcher behavior; named scenarios reference the originating commit shas (e.g., `// Pins behavior from 277a5e5: finalize message on empty stream + iterator throw`). The same scenarios run against the workflow path during coexistence. **Plus** a Phase-2 staging-soak that intentionally injects each commit's failure scenario under load before the matching toggle goes to `on` in production.
- **Legacy coexistence: by-row, not by-flag, with rollback runbook.** Sessions with `workflow_run_id IS NULL` continue on legacy; sessions with non-null `workflow_run_id` continue on workflow. No mid-flight switchover. Toggle only affects new dispatches. **Deploy rollback during migration is unsafe** — see the Operational Notes section's runbook for the steps required (drain workflow rows OR force-clear `workflow_run_id` to fall back to legacy salvage, valid only through Phase 3 while legacy paths exist).

---

## Open Questions

### Resolved During Planning

- *How does the workflow wait for a 3600s SDK call inside a 300s function?* Pattern A — runner POSTs to internal endpoint which calls `resumeHook` against a deterministic per-message hook token; workflow's `streamFromHook` step iterates the hook with `for await`. Function compute held only inside iteration, never across the SDK call's idle gaps.
- *How many columns does the schema migration add?* Four: `sessions.workflow_run_id`, `session_messages.runner_started_at`, `schedules.last_fired_dispatch_key` (UNIQUE), `tenants.workflow_dispatch_overrides`.
- *Toggle granularity?* Two layers: per-trigger env vars (six: API/SCHEDULE/WEBHOOK/A2A/CLEANUP/ADMIN) AND per-tenant deny-list JSONB. Tenant override wins.
- *How is admin/playground/chat dispatch covered?* New U5b unit; sixth toggle `WORKFLOW_DISPATCH_ADMIN`. Origin doc enumerated five entry points; codebase has six; plan now matches reality.
- *How does crash recovery actually bound double-billing?* Three pre-reissue gates: status check, stream-empty check, attempt-count check. All three must pass; otherwise finalize records `recovery_unsupported`.
- *How does the runner avoid double-spawn on workflow retry?* DB-side primitive: `session_messages.runner_started_at` set transactionally inside `launchRunner` step's tx. Replay finds non-null and skips. Sandbox-side process inspection NOT used.
- *Where do `scrubSecrets` and `processLineAssets` run on the workflow path?* In the `streamFromHook` step (workflow-side), per-line, BEFORE any byte reaches `getWritable()`. Render shims passthrough.
- *How does idempotency work without WDK `start()` taking an idempotency key?* DB-side, per-trigger: webhook `(source_id, delivery_id)` UNIQUE; REST/A2A `(tenantId, idempotencyKey)` cache or `(tenantId, requestId)` UUID fallback; schedule `(schedule_id, last_fired_dispatch_key)` UNIQUE.
- *Should A2A streaming use the same workflow stream as REST?* Yes. One `getReadable()` source; render shims diverge per-route. Confirmed in brainstorm dialogue.
- *Crash-recovery policy when SDK resume is impossible?* Bounded auto-reissue (max 1) with three pre-flight gates. Confirmed in brainstorm dialogue and refined here.
- *How are cross-tenant cancellations prevented?* Tenant-scoped DB row read in `cancelSession` is the binding step — happens BEFORE any WDK call. Cross-tenant attempts return NotFoundError without ever reaching WDK.
- *How is the stolen-token flood vector bounded?* Per-message line cap at the internal endpoint (`max_runtime_seconds * 100`); status check rejects post-terminal POSTs; sequence-number dedup stops replay.

### Deferred to Implementation

- [Affects U2, U3][Technical][Needs research] Exact name and signature of WDK `createHook` / `resumeHook` API on the pinned package version. U0 spike must verify before U1 lands. Plan assumes the documented `for await (const item of hook)` shape from the WDK Slack-bot reference.
- [Affects U10b][Technical][Needs research] WDK run-history read API for the admin UI panel. If absent on pinned version, U10b ships a fallback "view in Vercel dashboard" link.
- [Affects U3][Technical] Endpoint mode discrimination — `Content-Type: application/x-ndjson` vs query param `?mode=stream`. Implementation choice; both viable.
- [Affects U6][Technical] `getRun(runId).status` polling cadence in cleanup cron's `await terminal` loop. 1s default; tunable post-Phase-2.
- [Affects U8][Technical] Whether `webhook_deliveries` UNIQUE index already implies tenant scoping via `source_id → source.tenant_id`, or if explicit `tenant_id` should join the namespaced key. Likely the former; verify in implementation.

---

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

### Workflow shape (Pattern A — hook-based, U0-spike-corrected)

```
                           ┌────────────────────────────────────────┐
HTTP route (REST/A2A/etc.) │ DB-side dedup → start(dispatchWorkflow)│
   │                       └────────────────┬───────────────────────┘
   ▼                                        ▼

WORKFLOW BODY ("use workflow" — directly executes; any DB write must be
in a step; createHook AND for-await iteration MUST be in body, not a step).

   ┌──────────┐
   │  reserve │ STEP — persists workflow_run_id = "wdk_v1_" +
   │  (~ms)   │        getWorkflowMetadata().workflowRunId on session row
   └────┬─────┘        (same tx as message INSERT; durable)
        ▼
   ┌──────────────────────────────────────────────────────────────────┐
   │ createHook({ token: "transcript:" + messageId })   in body       │
   │   token is deterministic so the internal endpoint reconstructs   │
   │   it from messageId. Created BEFORE launchRunner.                │
   └──────────────────────────────────────────────────────────────────┘
        │
        ▼
   ┌──────────────┐
   │ ensureSandbox│ STEP — cold-start or reconnect (5–30s)
   └────┬─────────┘
        ▼
   ┌────────────┐                 ┌─────────────────────────────────────────┐
   │launchRunner│ ──spawn──────▶  │ runner-<messageId>.mjs in sandbox       │
   │  (~1–2s)   │  STEP — sets    │  • coalesces NDJSON: 10 lines OR 100ms  │
   │            │  runner_started │  • flushes critical events immediately  │
   │            │  _at in same tx │  • POSTs to internal endpoint with      │
   │            │  → replay skip  │    X-Runner-Attempt-Sequence header     │
   │            │                 │  • backoff on HookNotFoundError:        │
   │            │                 │    100ms→1.6s, 30s budget (U0-derived)  │
   └────┬───────┘                 └────────────────┬────────────────────────┘
        ▼                                           │ resumeHook(token, payload)
   ┌─────────────────────────────────────────┐      │
   │ for await (chunk of hook) {  in body    │ ◀────┘
   │   await writeChunk(...)                  │
   │   if (chunk.kind === "terminal") break  │      ┌──────────────────────────┐
   │ }                                        │      │ /api/internal/messages/  │
   │                                          │      │   :id/transcript         │
   │ where:                                   │      │  • verify bearer token    │
   │  writeChunk(tenantId, msgId, chunk) {   │      │  • status='running' check │
   │    "use step"                            │      │  • (messageId, attemptSeq,│
   │    scrubSecrets / processLineAssets      │      │    batchSeq) KV dedup    │
   │    getWritable().getWriter().write()     │      │  • per-message line cap   │
   │    releaseLock()                         │      │  • parses NDJSON to       │
   │  }                                       │      │    RunnerChunk            │
   │                                          │      │  • resumeHook(token, ...) │
   └────────┬─────────────────────────────────┘      └──────────────────────────┘
            ▼ (natural break OR catch-cancellation)
   ┌──────────┐  ┌─────┐
   │ finalize │→ │ tail│   STEPs — billing/transcript blob/CAS-to-idle-or-stopped
   └──────────┘  └─────┘

REST/A2A clients consume: getRun(runId).getReadable({ startIndex })
  Render shims (REST=NDJSON passthrough, A2A=SSE per spec) translate the
  already-scrubbed bytes. **Use getTailIndex() to bound reads on a
  terminal run** — WDK's writable does NOT auto-close on workflow
  termination, so a plain for-await over the readable hangs. Reconnect
  across function boundaries is automatic via Redis-backed stream +
  startIndex. **Render shims MUST NEVER call .cancel() on a
  WorkflowReadableStream** — that propagates upstream and cancels the run.
```

### Cancellation path (tenant-scoped)

```
Caller intent (REST cancel, schedule release, A2A tasks/cancel, cleanup cron)
   │
   ▼
cancelSession(sessionId, tenantId)
   │
   ├─ Tenant-scoped session row read (RLS enforces tenant ownership)
   │     ▶ row.tenant_id MUST equal caller's tenantId — otherwise NotFoundError
   ├─ Extract workflow_run_id from the verified row
   ├─ If non-null: getRun(runId).cancel()  (U0 spike scenario 5 verified)
   │     ▼
   │     workflow body's `for await (chunk of hook)` throws (WDK delivers
   │     cancellation as an exception inside the iterator)
   │        ▼
   │        catch block runs finalize STEP: salvage transcript file from
   │        sandbox FIRST, then mark message cancelled, then stop sandbox
   │        (matches the legacy cleanup-cron salvage-before-stop ordering)
   │
   └─ Always: existing DB CAS-to-stopped path (atomic DB visibility for
              callers that observe DB state without WDK)
   └─ Always: invalidateSandboxHandle(sessionId) to drain the in-process
              warm-handle cache during coexistence (kept until U10)
```

### Crash recovery (R6, three-gate policy)

```
runMessage in sandbox crashes mid-flight
   │
   ▼
Workflow runtime retries launchRunner step (and downstream)
   │
   ▼
Pre-reissue guards (ALL must pass):
   │
   ├─ Gate 1: session_messages.status == 'running' ?
   │     │   (Skip reissue if already completed/failed/cancelled —
   │     │    the original runner's terminal POST may have arrived
   │     │    while the function was crashing.)
   │     └─ FAIL → finalize from existing message status, no reissue
   │
   ├─ Gate 2: workflow stream has zero chunks for messageId?
   │     │   (Non-empty stream = runner reached operational state;
   │     │    side-effectful tools may have executed. Reissuing
   │     │    would re-execute Composio actions, file writes, etc.)
   │     └─ FAIL → finalize records "recovery_unsupported"
   │
   ├─ Gate 3: reissue_attempts (workflow step state) < 1?
   │     └─ FAIL → finalize records "recovery_unsupported"
   │
   ▼
All gates pass → try SDK session resume against existing sandbox
   │
   ├─ Resume succeeds → continue normally
   └─ Resume impossible (sandbox gone OR sdk_session_id expired)
        │
        ▼
        Auto-reissue: increment reissue_attempts to 1; boot fresh sandbox;
        re-issue prompt as new turn in same session
        │
        ├─ Reissue succeeds → continue (one extra billable turn)
        └─ Reissue fails → finalize records "recovery_unsupported"
```

---

## Implementation Units

### U0. Phase 0 spike: verify WDK primitives on the pinned version

**Goal:** Hard-verify the WDK primitives this plan depends on against the actual installed version in a deployed Vercel preview, BEFORE any other code lands. The plan's central architectural claims (per-line streaming via `resumeHook`, hook iteration inside a step, cancellation propagating to a parked hook iterator, persistent stream survives function restarts and is reconnectable by `runId + startIndex`) all derive from public WDK docs that may differ from the pinned package's actual behavior. A failed spike here should re-shape the plan — possibly to Pattern B (status-polling, see Alternatives Considered) or to wait for WDK maturity.

**Requirements:** Gates R1, R2, R4, R5, R6, R7

**Dependencies:** None — this is the very first unit.

**Files:**
- Create: `scripts/wdk-spike.ts` — single-file end-to-end smoke test of WDK primitives
- Create: `docs/research/wdk-spike-results.md` — record verified-yes / verified-no / unverified status for each primitive
- Test: spike runs as a script against a live Vercel preview deployment, not as a unit test

**Approach:**
Spike script must verify (deployed, not just import-checked):
1. **createHook + resumeHook with custom token.** Workflow body creates hook via `createHook({ token: "transcript:msg-123" })`; an HTTP route calls `resumeHook("transcript:msg-123", "line")` from outside; the workflow step iterating `for await (const line of hook)` receives it. Confirm: ordering preserved across multiple `resumeHook` calls, late-arriving call resolves a pre-parked iterator without error.
2. **Resume race: signal before park.** Fire `resumeHook` BEFORE the iterating step starts — confirm the token's queue holds the value and delivers on first iteration. If WDK drops pre-step `resumeHook` calls, the workflow body must `createHook` BEFORE `launchRunner`, and that pattern must work with deterministic token construction from messageId.
3. **getWritable inside step + getReadable from outside.** Step writes 100 lines via `getWritable().write(line)`; HTTP route reads via `getRun(runId).getReadable({ startIndex: 0 })`. Confirm bytes survive a simulated function restart (deploy a new build mid-stream).
4. **Reconnect by runId + startIndex.** Read 50 lines, close the readable, reopen with `startIndex: 50`, confirm next 50 arrive without duplication.
5. **getRun(runId).cancel() during hook iteration.** Cancellation propagates as a thrown exception inside the `for await` loop, and `try/finally` runs.
6. **Step retry with idempotent body.** Force a step to throw, observe replay; confirm `getStepMetadata().stepId` is stable across retries.
7. **Long-idle workflow.** Workflow parks for 30+ minutes between writes (simulating a long agent run); confirm function compute is NOT held during the idle period (check Vercel function-invocation logs for the project).
8. **Package name + framework integration.** Confirm `bun add workflow` (or `npm install workflow`) installs the right package and the Next.js framework integration works without warnings.

**Patterns to follow:** None — this is the first WDK code in the codebase.

**Test scenarios:**
Each numbered item above is its own scenario. Each produces a single line in `docs/research/wdk-spike-results.md`: `verified | unverified-but-workaround-known | failed-spike-stop`.

**Verification:**
- All 8 items in the spike result doc are `verified` OR every `unverified` / `failed` item has a documented mitigation that is incorporated back into the plan (a Risk-table row, an Open Question demoted to Resolved-During-Planning, or a unit's Approach updated)
- If item 1, 2, 5, or 7 fails, the plan returns to brainstorm — Pattern A is not viable on this WDK version

---

### U1. Add `workflow_run_id` to sessions, plus schedule + tenant override columns

**Goal:** Schema migration adding four columns across three tables to support the workflow path: workflow run-id reference, runner-spawn idempotency, schedule fire-time uniqueness, and per-tenant deny-list override.

**Requirements:** R1, R2, R8, R10

**Dependencies:** U0 (cannot land if WDK primitives are unverified)

**Files:**
- Create: `src/db/migrations/034_workflow_dispatch_columns.sql`
- Modify: `src/lib/validation.ts` — extend `SessionRow`, `SessionMessageRow`, `ScheduleRow`, `TenantRow` schemas
- Modify: `src/lib/sessions.ts` — extend `Session` type; add `setWorkflowRunId` / `clearWorkflowRunId` helpers
- Modify: `src/lib/session-messages.ts` — add `markRunnerStarted` helper (sets `runner_started_at` transactionally)
- Modify: `src/lib/schedule.ts` — extend ScheduleRow shape; idempotency-key helpers
- Modify: `src/lib/types.ts` — branded type for workflow run id (`type WorkflowRunId = string & { __brand: "WorkflowRunId" }`)
- Test: `tests/unit/db/sessions-schema.test.ts` (extend), `tests/unit/db/workflow-dispatch-schema.test.ts` (new)

**Approach:**
Four columns; all nullable so backfill is unnecessary:
- `sessions.workflow_run_id text NULL` — stored with `wdk_v1_` prefix so a future WDK upgrade can detect format-incompatible runIds and route them to the salvage path on rollback.
- `session_messages.runner_started_at timestamptz NULL` — set inside `launchRunner`'s tx; idempotency primitive for runner-spawn replay (replay finds non-null and skips spawn). Replaces "check sandbox process list" with a transactional DB primitive that survives function restarts.
- `schedules.last_fired_dispatch_key text NULL` with `UNIQUE (schedule_id, last_fired_dispatch_key)` partial index — DB-side dedupe primitive for the (`scheduleId`, `fireTime`) idempotency key replacing the assumed WDK `start()` idempotency.
- `tenants.workflow_dispatch_overrides JSONB DEFAULT '{}'` — per-tenant deny-list. Shape: `{"api": false, "schedule": false, ...}`. Empty default = follow global toggle. RLS already covers `tenants` selects.

RLS unchanged (all tables already enforce tenant boundaries). Validation schemas get optional fields; existing rows have NULL and continue parsing.

**Patterns to follow:**
- Migration sequencing: `src/db/migrations/033_runs_sessions_unify.sql` (recent pure-DDL precedent)
- Branded type pattern: existing `TenantId`, `AgentId`, etc. in `src/lib/types.ts`
- `setWorkflowRunId` mirrors `updateSessionSandbox` in `src/lib/sessions.ts`

**Test scenarios:**
- *Happy path: schema add.* Migration up adds all four columns with NULL/default; existing rows readable; round-trip insert/update for each column
- *Idempotency: re-run migration.* `ADD COLUMN IF NOT EXISTS` and `CREATE UNIQUE INDEX IF NOT EXISTS` re-run cleanly
- *Integration: helper round-trip.* `setWorkflowRunId('wdk_v1_abc')` then read returns prefix-validated value; `clearWorkflowRunId` reverts to null
- *Integration: schedule idempotency UNIQUE.* Two inserts with the same `(schedule_id, last_fired_dispatch_key)` produce a constraint error; helper handles via `ON CONFLICT DO NOTHING` returning whether a fresh dispatch should fire
- *Integration: tenant override JSONB.* Updates to `workflow_dispatch_overrides` are RLS-scoped; cross-tenant read returns empty
- *Edge case: prefix validation.* `setWorkflowRunId('not-prefixed-id')` is rejected at the helper boundary (so a future WDK format change can't silently store unparseable ids)

**Verification:**
- `npm run migrate` succeeds against a clean DB and against migration 033
- All four columns + the unique index visible in schema dump
- `tests/unit/db/workflow-dispatch-schema.test.ts` passes

---

### U2. Define the workflow function with hook-based streaming

**Goal:** Add `dispatchWorkflow` with the steps required by Pattern A: reserve (persists workflow_run_id), ensureSandbox, launchRunner (with DB-backed spawn idempotency), and finalize/tail. The workflow body itself owns hook iteration (the spike confirmed `createHook` and `for await` must live in workflow body, not a step). Each iterated chunk is forwarded via a small `writeChunk(data)` step that owns the `getWritable().getWriter().write()` call (also confirmed by the spike: stream writes throw "Not supported in workflow functions" when called from workflow body). Cancellation propagates through the hook iterator's catch/finally. Crash recovery's three pre-reissue gates are encoded in `launchRunner`.

**WDK constraints from the U0 spike** (recorded in `docs/research/wdk-spike-results.md`; codified in U2's design here):

- `createHook()` must be in workflow body, NOT a step
- `Hook<T>` cannot cross workflow→step boundary (carries non-serializable Symbols)
- `getWritable().getWriter().write()` must be inside a step
- → Workflow body owns iteration; per-chunk `writeChunk(data: string)` step owns the write
- Hook registration takes ~500ms–1.2s on Vercel cold-start; runner-side backoff is mandatory (handled in U3)
- `WorkflowReadableStream.cancel()` cancels the entire run — render shims must NEVER call it (handled in U3)
- `getReadable` after run-completion needs `getTailIndex()`-bounded reads — writable does NOT auto-close on workflow termination (handled in U3)

**Requirements:** R1, R2, R5, R6, R7, R8, AE2

**Dependencies:** U0, U1

**Files:**
- Create: `src/lib/workflows/dispatch-workflow.ts` — the workflow function and its steps
- Create: `src/lib/workflows/index.ts` — re-export for callers
- Modify: `src/lib/dispatcher.ts` — extract reusable bodies (`reserveSessionAndMessage`, sandbox prep, `finalizeMessage`, `sessionTail`) into named exports the workflow steps import; legacy `dispatchSessionMessage` continues to work for the coexistence window
- Modify: `package.json` — add `workflow` (npm package name; current latest 4.2.x) and its `@workflow/*` peer deps as required by the WDK install
- Modify: `next.config.ts` — register WDK if framework integration is required (per WDK docs: "Inside Workflow DevKit: How framework integrations work")
- Test: `tests/unit/workflows/dispatch-workflow.test.ts` (new)
- Test: `tests/unit/dispatcher-characterization.test.ts` (new — pins current behavior; named scenarios reference originating commit shas; lands BEFORE any workflow code so parity is measurable against an immutable baseline)

**Approach:**

Workflow body shape (steps marked with `"use step"`; non-step body code is non-durable). The hook iterator runs in workflow body — that's the only place WDK allows `createHook` and `for await (const x of hook)`. Each iterated chunk is forwarded via a small per-chunk write step.

1. `reserve(input, runId)` step — DB tx that runs `reserveSessionAndMessage` AND persists `workflow_run_id = "wdk_v1_" + runId` on the session row in the SAME transaction. RunId is sourced from `getWorkflowMetadata().workflowRunId` in the workflow body and passed in. Co-locating the runId persist with reserve's tx makes the write durable; a function-host crash between reserve and ensureSandbox cannot leave a session row with a stale runId.
2. `createHook` call inside workflow body using a deterministic token: `transcript:${prepared.messageId}`. Token is reconstructable from messageId so the internal POST endpoint computes it without extra state. Created BEFORE `launchRunner` so the runner's first POST always finds a registered hook (covers the signal-before-park race; the U0 spike measured ~500ms–1.2s registration latency on cold start, absorbed by runner-side backoff in U3).
3. `ensureSandbox(prepared)` step — cold-start or reconnect. Idempotent on `session.sandbox_id`.
4. `launchRunner(prepared, sandbox)` step:
   - Pre-spawn check: read `session_messages.runner_started_at` for this messageId. If non-null, runner already spawned in a prior step invocation; skip spawn and return.
   - Pre-reissue gates (apply only on retry, where step state's `reissueAttempts > 0`): (a) `session_messages.status == 'running'`, else short-circuit to finalize, (b) workflow stream chunk count for this messageId == 0, else record `recovery_unsupported`, (c) `reissueAttempts < 1`, else record `recovery_unsupported`.
   - If gates pass and prior runner is gone: try SDK session resume; on resume-impossible, increment `reissueAttempts`, boot fresh sandbox, re-issue.
   - On spawn: `session_messages.runner_started_at = now()` set transactionally inside the step's tx BEFORE the actual spawn call returns. Even if the function crashes mid-spawn, the column is set, replay skips, and the orphaned runner is reaped by cleanup cron's stuck-active watchdog.
5. **Hook iteration loop in workflow body** (NOT a step):
   - `for await (const line of hook) { ... }`
   - For each iterated line, the body **must dispatch to a `writeChunk` step**, not call `getWritable().write()` directly — workflow-body stream writes throw `Error: Not supported in workflow functions`.
   - The body recognises the runner's terminal-sentinel line shape (e.g., a JSON line with `kind === "terminal"`) and breaks out of the loop after dispatching it.
6. `writeChunk(data: string)` step — receives the chunk's serializable string, runs `scrubSecrets(data)` and `processLineAssets(data, tenantId, messageId)`, then `getWritable<string>().getWriter().write(scrubbedLine)`. Releases the writer's lock in `finally`. The truncation rule from `transcript-capture-and-streaming-fixes.md` applies inside this step: `result` and `error` events always written even after `MAX_TRANSCRIPT_EVENTS`; `text_delta` events written to the stream but flagged so finalize excludes them from the final transcript blob.
7. `finalize(prepared, sandbox, streamMetadata)` step (entered both on natural loop-end and via cancel-throws path) — calls extracted `finalizeMessage` body. On the cancel path, runs salvage-from-sandbox FIRST, then transitions message to `cancelled`/`timed_out`/`failed`, THEN stops sandbox. Matches legacy cleanup-cron salvage-before-stop ordering.
8. `tail(prepared, sandbox)` step — calls `sessionTail` body. Idempotent.

Step state (workflow-internal, opaque to callers): `reissueAttempts` (number), `cancelReason` (string?). No other internal state needed — the persistent stream is the source of truth for emitted bytes.

**Why the per-chunk-step shape is correct (not a perf concern at v1):** Each `resumeHook` from the runner re-triggers the workflow runtime; each `writeChunk` step is one additional event. The U0 coalescing strategy (10 lines OR 100ms in the runner) caps `resumeHook` calls at ~50/min for typical agent runs, so writeChunk invocations are bounded by the same budget. If the cost shows up in Phase 2 monitoring, the writeChunk step can batch (accept `data: string[]` and write all at once).

**Execution note:** Characterization-first. `tests/unit/dispatcher-characterization.test.ts` lands as the very first commit in this unit; no workflow code in the same PR. Test scenarios named per originating commit sha so the workflow path's parity bar is unambiguous.

**Technical design:**
> *Directional guidance, not implementation specification. WDK API names below are spike-verified against the pinned package; implementer reads `docs/research/wdk-spike-results.md` for any deltas.*

```ts
// src/lib/workflows/dispatch-workflow.ts (sketch)
export async function dispatchWorkflow(input: DispatchInput): Promise<DispatchResult> {
  "use workflow";

  const runId = getWorkflowMetadata().workflowRunId;

  // Step 1: reserve (persists wdk_v1_<runId> on sessions row in same tx).
  const prepared = await reserve(input, runId);

  // Hook MUST be created in workflow body BEFORE launchRunner so the runner's
  // first POST never 404s. createHook in a step throws "Not supported in
  // workflow functions" — verified in U0 spike.
  const hook = createHook<RunnerChunk>({
    token: `transcript:${prepared.messageId}`,
  });

  const sandbox = await ensureSandbox(prepared);
  await launchRunner(prepared, sandbox);  // sets runner_started_at transactionally

  try {
    // Iterate hook in workflow body. Each iterated chunk's data goes to a
    // writeChunk STEP — workflow-body stream writes are not allowed.
    for await (const chunk of hook) {
      await writeChunk(prepared.tenantId, prepared.messageId, chunk);
      if (chunk.kind === "terminal") break;
    }
    await finalize(prepared, sandbox, { cancelled: false });
  } catch (err) {
    // WDK cancel propagates here; runner crash also lands here.
    await finalize(prepared, sandbox, {
      cancelled: err instanceof CancellationError,
      reason: err instanceof Error ? err.message : String(err),
    });
  }

  await tail(prepared, sandbox);
  return { sessionId: prepared.session.id, messageId: prepared.messageId };
}

async function writeChunk(
  tenantId: string,
  messageId: string,
  chunk: RunnerChunk,
): Promise<void> {
  "use step";
  const scrubbed = scrubSecrets(chunk.data);
  await processLineAssets(scrubbed, tenantId, messageId);
  const writer = getWritable<string>().getWriter();
  try {
    await writer.write(scrubbed);
  } finally {
    writer.releaseLock();
  }
}
```

**Patterns to follow:**
- Existing `withTenantTransaction` wrapper (`src/db/index.ts`) reused inside reserve and launchRunner step bodies for atomic DB writes
- `transitionMessageStatus`'s expected-current-status guard for `running → terminal` idempotency
- `captureTranscript` truncation rules from `transcript-capture-and-streaming-fixes.md` ported into `streamFromHook` line-by-line — preserved, not bypassed

**Test scenarios:**
- *Happy path: workflow runs all steps in order, terminal-kind chunk breaks the body's `for await` loop, returnValue matches legacy dispatcher output for the same input fixture*
- *Idempotency: reserve replay.* Re-invoking with same input returns the same `PreparedExecution` (and same workflow_run_id since it's keyed by runId)
- *Idempotency: ensureSandbox replay.* Sandbox handle reused
- *Idempotency: launchRunner replay finds runner_started_at non-null and skips spawn (DB-backed primitive — does NOT inspect sandbox processes)*
- *Idempotency: writeChunk step is naturally idempotent on per-step replay because the workflow body's `for await` only delivers each chunk to the iterator once; on retry the workflow runtime replays from the last committed step, not from the start of the loop*
- *Idempotency: finalize replay short-circuits on non-running status*
- *Crash recovery gate 1: status check.* Original runner's terminal POST landed during function crash; replay sees `status='completed'`, finalize from existing data, no reissue
- *Crash recovery gate 2: stream non-empty.* Stream has 5 chunks but session crashed; replay sees non-empty stream, records `recovery_unsupported`, no reissue (preserves side-effectful tool execution boundary)
- *Crash recovery gate 3: SDK resume succeeds.* All gates pass, resume succeeds, run continues normally, no extra billable turn
- *Crash recovery: reissue once succeeds.* `Covers AE2.` Resume impossible, reissue boots fresh sandbox, second runner produces terminal event, message succeeds with `reissueAttempts: 1`
- *Crash recovery: reissue fails.* Second crash records `recovery_unsupported`, finalize marks message `failed`
- *Cancellation: thrown inside the workflow body's hook iterator.* External `getRun(runId).cancel()` while the body is awaiting the next iterated chunk; the `for await` throws; `finalize` runs salvage-before-stop in the catch block; sandbox killed only after transcript salvaged; message `cancelled`. **(U0 spike scenario 5 verified this primitive on the deployed runtime.)**
- *Race: hook resumed before iterator parks.* Runner POSTs first line in <1ms after launchRunner; WDK queues the resume payload until the iterator picks it up. **(U0 spike scenario 2 verified WDK's resume queue absorbs the race; spike measured 500ms–1.2s registration latency.)** The runner-side backoff in U3 is mandatory.
- *Race: cancel during launchRunner BEFORE iteration begins.* Cancellation arrives before the body enters the `for await`; WDK propagates to the next workflow body operation; iterator throws on first iteration; finalize records cancelled
- *Race: terminal POST during finalize.* Runner's final POST arrives while finalize is running (after iterator broke); endpoint sees `status != 'running'` and rejects with 409 (no double-finalize)
- *Per-commit named scenarios* (referencing the recent commit history this plan exists to address):
  - `// 277a5e5 — finalize on empty stream` — runner exits before any non-text_delta event; stream has zero non-text_delta lines; finalize records `error_type: 'empty_stream'`
  - `// ca384ff — schedule skip post-drain after stream_detached` — schedule cron's drain saw stream_detached; workflow path's equivalent is the streamFromHook iterator parking past the cron's `await run.returnValue` deadline; verify cron exits cleanly without flipping the message to failed
  - `// 09ed4f0 — release active session when stuck-running fallback fires` — replays the stuck-active watchdog scenario against a workflow-backed session; verify cleanup cron signals cancel and finalize transitions correctly
- *Characterization parity.* For each scenario in `dispatcher-characterization.test.ts`, the workflow path produces the same DB end-state and same emitted (post-scrub) line sequence

**Verification:**
- All scenarios pass; characterization scenarios pass against both legacy and workflow paths
- WDK run history (per spike-verified inspection API) shows step boundaries and retry counts as expected for each crash-recovery scenario

---

### U3. Internal endpoint refactor + per-route render shims

**Goal:** Refactor `/api/internal/messages/[messageId]/transcript` to accept incremental per-batch POSTs from the runner, dedup by `(messageId, attemptSequence)`, enforce a per-message line cap, and translate each batch into `resumeHook(token, line)` calls. Add REST and A2A render shims that read from `getRun(runId).getReadable()`. Justify the runner-protocol change against origin scope.

**Requirements:** R4, R12, R13

**Dependencies:** U0, U1, U2

**Files:**
- Modify: `src/app/api/internal/messages/[messageId]/transcript/route.ts` — supports both legacy single-blob terminal POST (kept until U10) and new per-batch streaming POST. Per-batch path: verify per-message bearer token → check `(messageId, attemptSequence)` dedup → check per-message line-count cap → check `session_messages.status == 'running'` → call `resumeHook("transcript:" + messageId, line)` for each line in the batch.
- Modify: `src/lib/sandbox.ts` — runner template emits batched per-line POSTs. Coalesce: 10 lines OR 100ms, whichever first. Critical events (`result`, `error`) flush immediately, ignoring the coalesce window. Each POST carries `X-Runner-Attempt-Sequence: <n>` (monotonic, resets on auto-reissue). Existing single-terminal-POST path retained behind a runner-side flag for legacy.
- Create: `src/lib/workflows/stream-bridge-server.ts` — server-side helpers for the route: `verifyAndDedupBatch`, `enforceLineCap`, `resumeHookBatch`. The dedup state lives in Vercel KV keyed `transcript-dedup:${messageId}:${attemptSequence}` with a TTL matching `agent.max_runtime_seconds + 5min`.
- Create: `src/lib/workflows/render-rest.ts` — wraps `getRun(runId).getReadable()` to produce NDJSON byte stream matching legacy `createNdjsonStream` (heartbeat 15s, detach event informational since stream is durable, reconnect-by-startIndex supported)
- Create: `src/lib/workflows/render-a2a.ts` — wraps `getReadable()` to produce A2A-spec SSE events; reuses event-mapping logic from `src/lib/a2a.ts`
- Test: `tests/unit/api/internal-transcript-streaming.test.ts` (new)
- Test: `tests/unit/workflows/render-rest.test.ts` (new)
- Test: `tests/unit/workflows/render-a2a.test.ts` (new)

**Approach:**

**Why per-line POSTs (justifying the origin-scope deviation):** Origin Scope Boundaries excluded "changing the runner shape (transcript upload protocol)". Per-line streaming is in scope here because it is the minimum runner-side change required to make Pattern A work — and Pattern A was the explicitly-confirmed adaptation shape (option B in brainstorm dialogue). The Alternatives Considered section evaluates Pattern B (workflow status-polling, no runner-side change), which would respect the origin boundary unchanged but loses live streaming and adds polling cost. The plan's selection of Pattern A is the brainstorm-confirmed direction; the runner change is a consequence of that choice, not a "while we're here" expansion.

**Endpoint shape:**
- Single endpoint, two modes distinguished by request `Content-Type`:
  - `application/x-ndjson` (new): batched per-line streaming. Body is one or more NDJSON lines. Headers carry `X-Runner-Attempt-Sequence` and `X-Batch-Sequence` (within an attempt). Repeat sequences are 200-OK no-ops (idempotent).
  - `application/octet-stream` or `application/json` (legacy): single terminal POST with full transcript. Kept until U10 retirement.
- Auth: existing per-message bearer token (`generateMessageToken` / verify). Token bound to messageId; reuse against another messageId rejected.
- Three guards before forwarding any byte to the hook:
  1. `(messageId, attemptSequence, batchSequence)` not in KV dedup → first time, mark seen with TTL
  2. Per-message line count under cap (default `MAX_TRANSCRIPT_LINES_PER_MESSAGE = max_runtime_seconds * 100`, computed at message-create time and stored in KV with same TTL) → bounds stolen-token blast radius from SEC-002
  3. `session_messages.status == 'running'` → 409 if not (closes SEC-006 token-after-terminal window)
- After guards: `resumeHook("transcript:" + messageId, payload)` per line. Errors fail the batch with retryable 5xx so the runner's retry path (designed in this unit) re-sends. **The payload SHAPE matters — the U2 hook iterator expects a structured object (e.g., `{ kind: "chunk" | "terminal", data: string, eventType: ... }`), not a raw string. Each POSTed line is parsed/validated by this endpoint before resumeHook so the workflow body's `for await` always sees valid `RunnerChunk`s.**

**Coalescing + cold-start backoff in the runner (sandbox.ts template):**
- Buffer NDJSON output. Flush triggers (whichever first):
  - Buffer reaches 10 lines
  - 100ms since last flush
  - Critical event seen (`result`, `error` event types — flush immediately and reset timer)
- Each flush is one POST with the batch as NDJSON body. Sequence `(attemptSequence, batchSequence)` increments per POST.
- **Hook-not-found backoff (mandatory, U0-derived):** the runner's first POST after spawn frequently lands during the WDK hook-registration window (~500ms–1.2s on Vercel cold-start; verified via U0 spike scenarios 1+2). The endpoint returns a retryable 5xx when `resumeHook` throws `HookNotFoundError`; the runner retries with exponential backoff: **100ms → 200ms → 400ms → 800ms → 1.6s, capped at 30s total budget** (matches the spike's `resumeHookWithBackoff`). After the first successful POST per attempt, subsequent POSTs go through immediately.
- Other 5xx response: same backoff, but only 5 attempts. On final failure: log + continue (the cleanup cron's salvage path will pick up the in-sandbox transcript file).

**Render shims (U0-derived constraints baked in):**
- REST: byte-passthrough from `getReadable()`. Heartbeats injected by the shim every 15s (workflow stream doesn't heartbeat natively). Detach event becomes informational since reconnect is durable; clients can reconnect via `/api/sessions/:id/messages/:messageId/stream` which returns `getReadable({ startIndex })`.
- A2A: parse each NDJSON line, map to A2A SSE events using existing `a2a.ts` event-mapping logic. Reuse `MessageBackedTaskStore`'s save-skip optimization.
- **Both shims MUST follow these rules from the U0 spike:**
  - **Never call `.cancel()` on `WorkflowReadableStream`.** Calling cancel on the readable propagates upstream and cancels the workflow run itself. To release a reader: `reader.releaseLock()` only.
  - **Use `getTailIndex()` to bound reads when the run is already terminal.** WDK's writable doesn't auto-close on workflow termination — a plain `for await` over the readable hangs because `done` never fires. After `run.returnValue` resolves, call `await readable.getTailIndex()` and read exactly `tail - startIndex + 1` chunks.
  - **For live (in-flight) reads**, the same rule still applies but the tail index advances as the writer writes. Either poll `getTailIndex()` periodically, or read until the consumer disconnects (heartbeat-driven loop). Never assume a particular line is the last one.
  - **Heartbeats are shim-side, not WDK-side.** WDK doesn't emit heartbeats on its readable; the REST shim's 15s heartbeat injection is what keeps clients' connections alive on long-running streams.

**Patterns to follow:**
- Existing `src/lib/streaming.ts` for heartbeat cadence and stream-shape conventions
- Existing event vocabulary in `src/lib/transcript-utils.ts` (truncation/text_delta rules) — the rules now live in U2's `writeChunk` step, NOT in this endpoint or in render shims. The endpoint forwards parsed `RunnerChunk`s; the writeChunk step scrubs/applies rules before `getWritable().write()`; render shims passthrough.
- Authentication on the internal endpoint stays per-message bearer token (`generateMessageToken` / verify) — unchanged
- KV usage pattern: existing `src/lib/rate-limit.ts` shows the platform's KV access pattern

**Test scenarios:**
- *Happy path: batched POST.* Runner sends 5 NDJSON lines in one POST; endpoint dedups, line-cap-checks, status-checks, calls `resumeHook` 5 times; workflow's `streamFromHook` step receives 5 lines in `for await` order
- *Idempotency: duplicate batch.* Same `(messageId, attemptSequence, batchSequence)` posted twice; second 200-OK no-op without re-firing `resumeHook`
- *Idempotency: out-of-order batches.* Batch 5 arrives before batch 4 due to network reorder; KV dedup tracks each batchSequence independently; both eventually delivered. (Hook iterator order = arrival order at `resumeHook`, not runner emission order. Acceptable because the runner's coalescing window keeps batches small and within-batch order is preserved.)
- *Edge case: terminal POST without prior chunks.* Runner crashes very early; emits a single `error` event in one POST; line cap = 1; status check passes; resumeHook delivers it; finalize sees the error
- *Edge case: per-message line cap exceeded.* Stolen token attempts to flood the endpoint; line-cap exhausted at line N+1; endpoint returns 429 with `Retry-After`; subsequent legitimate POSTs from the actual runner also rejected — but the workflow's `streamFromHook` step has already received N lines and the cleanup cron's stuck-active watchdog handles the eventual termination. (Trade: a malicious flood degrades that one session's quality; it does not cross-tenant.)
- *Edge case: status check on terminal message.* POST arrives after the workflow has already finalized; `session_messages.status != 'running'` → 409 Conflict; runner gives up after retry exhaustion (transcript salvage handles the in-sandbox file)
- *Error path: resumeHook fails.* WDK transient error; endpoint returns 5xx; runner retries with backoff
- *Truncation preserved.* Run produces 12,000 events including a final `result` event past `MAX_TRANSCRIPT_EVENTS`; the workflow's `streamFromHook` step (U2) — not this endpoint — applies the always-keep-result rule. Verifying here: this endpoint forwards every line to `resumeHook` regardless; rule application is downstream
- *Secret scrubbing.* Runner emits a line containing a Composio API key; endpoint forwards to `resumeHook`; `streamFromHook` scrubs before `getWritable().write()`; REST and A2A consumers see scrubbed line; transcript blob (assembled in finalize) is also scrubbed
- *text_delta exclusion.* 200 `text_delta` events arrive at REST clients via getReadable; finalize-assembled transcript blob omits them per the workflow step's flag
- *Integration: REST end-to-end.* `Covers F1.` POST `/api/sessions/:id/messages` starts workflow; client receives streamed NDJSON byte-identical to legacy for a fixed input fixture; terminal event closes stream cleanly
- *Integration: A2A end-to-end.* `Covers F1.` `message/stream` JSON-RPC produces A2A-spec SSE events matching the legacy executor's output for a fixed input fixture
- *Integration: client disconnect mid-stream.* Client reconnects via `/api/sessions/:id/messages/:messageId/stream` using runId from the session row; `getReadable({ startIndex: -200 })` returns last 200 chunks; new chunks arrive live
- *Integration: runner backoff after 5xx.* Endpoint returns 503 once; runner retries after 100ms (U0-spec backoff); second POST succeeds; no lines lost
- *Integration: runner backoff during cold-start hook-registration window.* `resumeHook` throws `HookNotFoundError` for first ~500ms–1.2s after `start()`. Runner retries with the U0-derived schedule (100ms → 1.6s, 30s budget); first POST eventually lands. **(Calibrated against U0 spike scenarios 1+2 measurements.)**
- *Render: getTailIndex bounds reads on a terminal run.* Run completes with 6 chunks; render shim calls `getTailIndex()` (returns 5), reads exactly 6 chunks, exits cleanly. **(U0 spike scenario 3 verified; the prior `for await ... done` pattern hung because the writable never closes.)**
- *Render: NEVER call .cancel() on the readable.* Test deliberately calls `readable.cancel()` and asserts it propagates upstream killing the run (sanity check). Production render shim code path uses `reader.releaseLock()` only and is verified to leave the run alive. **(U0 spike scenario 4 documented this trap.)**
- *Render: live read across reconnect.* Client opens stream while run is in-flight; reads N chunks; disconnects; reconnects via `getReadable({ startIndex: N })`; receives chunk N onwards without duplication or skip. **(U0 spike scenario 4 verified the primitive on a completed run; this test extends to a still-running run.)**

**Verification:**
- Per-line streaming works end-to-end on a deployed Vercel preview
- A REST request and an A2A `message/stream` request against the same input fixture produce identical observable output sequences vs the legacy path
- KV dedup state visible during a run; expires after `agent.max_runtime_seconds + 5min`
- Render shims demonstrably never call `.cancel()` on a `WorkflowReadableStream` (covered by lint rule or assertion in tests)

---

### U4. Per-trigger toggle + per-tenant deny-list

**Goal:** Add a two-layer toggle: env-var-driven global toggle per trigger source, and a per-tenant override stored in `tenants.workflow_dispatch_overrides` (added in U1). On-call can disable workflow for one tenant without redeploying — addresses the binary blast radius problem (ADV-5) without deferring the per-tenant control until "after staging validates."

**Requirements:** R10, R11

**Dependencies:** U1 (per-tenant override column)

**Files:**
- Modify: `src/lib/env.ts` — add six optional env vars: `WORKFLOW_DISPATCH_API`, `WORKFLOW_DISPATCH_SCHEDULE`, `WORKFLOW_DISPATCH_WEBHOOK`, `WORKFLOW_DISPATCH_A2A`, `WORKFLOW_DISPATCH_CLEANUP`, `WORKFLOW_DISPATCH_ADMIN` (Zod-parsed, default `off`). Note: ADMIN added per SG-001.
- Create: `src/lib/workflows/toggle.ts` — exports `shouldUseWorkflow(trigger: RunTriggeredBy | "cleanup" | "admin", tenantId: TenantId): Promise<boolean>`. Reads global env then per-tenant override; tenant override wins.
- Modify: `src/lib/sessions.ts` (or a new `src/lib/tenants.ts` if more tenant utilities accumulate) — `getTenantWorkflowOverrides(tenantId)` cached at process level for 60s, invalidated on tenant update
- Test: `tests/unit/workflows/toggle.test.ts` (new)

**Approach:**
- Six env vars (one per dispatch chokepoint, including the previously-missed admin). Zod rejects unknown values; typo at deploy fails build rather than silently disabling.
- Per-tenant override JSONB shape: `{"api": false}` means "this tenant uses legacy for `api` triggers regardless of global toggle." Allowed keys match the six trigger names; extra keys rejected by Zod.
- Decision precedence: tenant-override-explicit-false > tenant-override-explicit-true > global-env-toggle. (Tenants can also force-on workflow ahead of global rollout for canary cohorts.)
- Cache is process-level Map with 60s TTL — short enough that emergency disable propagates across active function instances within a minute, long enough that the lookup isn't a per-request DB round-trip
- Helper signature is async because it reads from DB. Routes that already do tenant-scoped DB reads can share the read; the helper returns the raw override JSONB shape for that case

**Why earn the abstraction over inline reads (responding to SG-006):** The function does three things — env read, DB read, decision precedence — and is consumed by six entry points plus the cleanup cron. Inlining 7 callers' worth of "read env, read tenant override JSONB, compute precedence, possibly cache" trades one new file for ~50 lines of duplicated logic across handlers. The abstraction earns its keep on day 1, not on hypothetical future complexity.

**Test scenarios:**
- *Happy path: global toggle on, no tenant override.* Returns true
- *Happy path: global toggle off, no tenant override.* Returns false
- *Per-tenant force-off.* Global on, tenant override `{"api": false}` → returns false for that tenant only; other tenants on the same instance return true
- *Per-tenant force-on.* Global off, tenant override `{"api": true}` → returns true for that tenant; canary use case
- *Per-trigger isolation.* Tenant has `{"api": false}`; `shouldUseWorkflow("schedule", tenantId)` returns the global value, not the api override
- *Cache invalidation.* Tenant override updated; cache TTL ensures within 60s the new value is honored (the test mocks Date.now to advance past TTL)
- *Edge case: malformed override JSONB.* `tenants.workflow_dispatch_overrides = '{"invalid_trigger": false}'` → Zod parse fails → fall back to global env (fail-safe)
- *Edge case: env var unknown value.* `WORKFLOW_DISPATCH_API=maybe` → Zod parse fails at startup; build fails

**Verification:**
- All six toggles work independently in env; per-tenant overrides modify behavior without redeploy
- Cache invalidation test confirms 60s upper bound on emergency disable propagation

---

### U5. REST entry point migration (with tenant-scoped cancel + DB-side idempotency)

**Goal:** `/api/sessions`, `/api/sessions/:id/messages`, and `/api/sessions/:id/cancel` consult the toggle and start a workflow run when on. DB-side idempotency replaces the (non-existent) WDK `start()` idempotency. Cancel verifies tenant ownership before signaling WDK to close the cross-tenant cancellation gap (SEC-001).

**Requirements:** R3, R4, R5, R10, AE3, AE4

**Dependencies:** U0, U1, U2, U3, U4

**Files:**
- Modify: `src/app/api/sessions/route.ts` (POST creates session) — toggle gate; legacy path unchanged when off
- Modify: `src/app/api/sessions/[sessionId]/messages/route.ts` (POST sends next message) — toggle gate; on-path runs DB-side dedup THEN calls `start(dispatchWorkflow, [input])`, returns `render-rest` stream
- Modify: `src/app/api/sessions/[sessionId]/cancel/route.ts` — calls `cancelSession(sessionId, tenantId)` which now (a) reads tenant-scoped row, (b) verifies row's tenant_id matches caller, (c) signals WDK only after verification. Cross-tenant cancel attempts are rejected at step (a) by RLS — returning 404 not 403 to avoid leaking existence.
- Modify: `src/app/api/sessions/[sessionId]/messages/[messageId]/stream/route.ts` (existing reconnect endpoint) — when session has `workflow_run_id`, returns `getReadable({ startIndex })`; legacy path unchanged
- Modify: `src/lib/dispatcher.ts` — `cancelSession` adds tenant-ownership-verified workflow signal branch
- Test: `tests/unit/api/sessions-route.test.ts` (extend), `tests/unit/api/sessions-cancel-tenant-isolation.test.ts` (new — explicit cross-tenant attack scenarios)

**Approach:**

**Idempotency (DB-side only, since WDK start() takes no key):**
- `Idempotency-Key` header present: lookup `(tenantId, idempotencyKey) → messageId` in the existing in-memory idempotency cache (`src/lib/idempotency.ts`); if hit, return the cached `(sessionId, messageId)` and the workflow run id from the message row's session — no new `start()` call. If miss: insert message row, then `start()`, then cache the result.
- `Idempotency-Key` header absent: a request-scoped UUID generated at the top of the route handler (BEFORE any DB write) is used as the cache key, scoped per-(tenantId, route, requestId). This handles immediate-retry-without-key cases from the same caller. The original plan's "(tenantId, messageId)" fallback was a chicken-egg problem (F2) — the messageId doesn't exist until reserve has run.
- The `In-Session Conflict` 409 case is surfaced from the reserve step's CAS via `ConcurrencyLimitError`, mapped to HTTP 409 by the route handler — same as legacy.

**Cross-tenant cancel hardening (SEC-001):**
- `cancelSession(sessionId, tenantId)` first does a tenant-scoped DB read (existing pattern; RLS enforces `app.current_tenant_id`). If the row doesn't exist for the requesting tenant: returns NotFoundError. Critical: this read is the tenant-ownership verification — only after it succeeds do we have a tenant-bound `workflow_run_id` value to pass to `getRun().cancel()`.
- Even if WDK runIds were guessable (they're opaque UUIDs, but assume worst case), the tenant binding is established by the row read, not by the runId itself. A tenant who guesses a foreign runId and passes it to their own session's cancel would still need that runId to be on a row their RLS view sees — which it cannot be.
- Defense in depth: log every WDK cancel call with `(tenantId, sessionId, runId)`; alert on any mismatch between sessionId.tenant_id and authenticated tenantId (would indicate an RLS bypass).

**Stream reconnect:**
- Workflow-backed: `getReadable({ startIndex: parseInt(query.startIndex ?? "-200") })` returns durable stream
- Legacy: existing poll-DB behavior unchanged

**Patterns to follow:**
- Existing `withErrorHandler`, `withApiAuth` route shape
- Existing tenant-scoped query pattern in `src/db/index.ts` (`withTenantTransaction`)
- Existing 410 Gone handling in legacy session-stopped path

**Test scenarios:**
- *Happy path: toggle on.* POST message → workflow starts → `sessions.workflow_run_id` populated → client receives streamed NDJSON identical-shape to legacy for fixed input fixture
- *Happy path: toggle off.* Same POST → legacy `dispatchSessionMessage` runs → `workflow_run_id` is NULL → existing behavior unchanged
- *Per-tenant override.* Tenant has `workflow_dispatch_overrides: {"api": false}`; POST message uses legacy path even when global toggle is on
- *Coexistence.* `Covers AE3.` Toggle enabled mid-session: existing session with `workflow_run_id IS NULL` continues on legacy for its next message
- *Cancel: workflow-backed, same tenant.* `Covers F2.` POST cancel → DB read confirms ownership → `getRun(runId).cancel()` → workflow's hook iterator throws → finalize runs salvage-then-stop in catch block → message `cancelled`
- *Cancel: workflow-backed, cross-tenant attempt.* Tenant A authenticates and sends `POST /api/sessions/<tenant_B_session_id>/cancel`. RLS-scoped DB read returns no row → 404 NotFound → WDK never called. Audit log shows the attempt. (SEC-001 attack vector closed.)
- *Cancel: legacy session.* POST cancel on session without runId → existing path runs unchanged
- *Cancel: race.* Cancel during runner-terminal emission → if cancel CAS wins, message `cancelled`; if terminal wins, message `completed` and cancel is 204 idempotent no-op
- *Cancel: WDK throws on stale runId.* `getRun(runId).cancel()` rejects (run already terminal); fallthrough to legacy DB CAS — outcome same as a successful cancel
- *Stream reconnect: workflow-backed.* Client disconnects mid-stream, reconnects to stream URL → `getReadable({ startIndex: -200 })` returns last 200 chunks; new chunks arrive live
- *Stream reconnect: across function restart.* Stream survives a Vercel deploy (verified in U0 spike); client reconnect after deploy gets continued bytes
- *Edge case: NULL runId on workflow-backed row.* Toggle on but row has `workflow_run_id IS NULL` (rare race or rollback aftermath) → handler treats as legacy
- *Edge case: stale runId after rollback.* `workflow_run_id` references a runtime that no longer recognises it (post-rollback) → `getRun().cancel()` returns null/error → fall through to legacy salvage path; row's `workflow_run_id` cleared so cleanup cron handles via legacy
- *Idempotent retry: with Idempotency-Key.* Two POSTs same key within TTL → both return same `messageId`; only one `start()` call (verified via WDK run history)
- *Idempotent retry: without Idempotency-Key.* Caller retries the same request body without a key → request-UUID dedup is per-request so caller gets a fresh dispatch (matches existing legacy semantics)
- *Integration: 410 Gone preserved.* POST message on stopped session → reserve step → SessionStoppedError → 410, identical to legacy

**Verification:**
- All API contract tests pass under both toggle states and per-tenant override states
- Cross-tenant cancel attack test in `sessions-cancel-tenant-isolation.test.ts` produces no WDK call and 404
- A workflow-backed message from POST through reconnect produces the same observable response sequence as legacy

---

### U5b. Admin entry point migration (playground + chat)

**Goal:** Migrate the two previously-missed admin dispatch chokepoints — `/api/admin/sessions/route.ts` (playground) and `/api/admin/sessions/[sessionId]/messages/route.ts` (chat) — onto the workflow path under the `WORKFLOW_DISPATCH_ADMIN` toggle. Without this, R3 ("workflow is the single chokepoint") fails and U10's retirement verification (`git grep dispatchSessionMessage` returns nothing) cannot pass.

**Requirements:** R3, R10, R11

**Dependencies:** U2, U3, U4

**Files:**
- Modify: `src/app/api/admin/sessions/route.ts` — toggle gate; on-path delegates to the workflow `start()` flow
- Modify: `src/app/api/admin/sessions/[sessionId]/messages/route.ts` — toggle gate; on-path same as U5
- Modify: `src/app/api/admin/sessions/[sessionId]/cancel/route.ts` — same tenant-scoped cancel path as U5 (admin auth still scopes by company/tenant)
- Test: `tests/unit/api/admin-sessions-workflow.test.ts` (new)

**Approach:**
- Admin routes use admin JWT auth (`/api/admin/login`) but still operate within a selected company/tenant context. The workflow path treats admin triggers identically to API triggers in terms of dispatch shape; the difference is on the trigger label (`triggered_by = 'playground' | 'chat'`) recorded on the message row.
- Toggle key is `WORKFLOW_DISPATCH_ADMIN`; per-tenant override key is `"admin"` in the JSONB shape.
- All other behavior (idempotency, cancel, reconnect, render shim) inherits from U2/U3/U5 with no admin-specific deviation.

**Patterns to follow:**
- Existing admin route shape with admin-auth middleware
- U5's tenant-scoped cancel pattern

**Test scenarios:**
- *Happy path: admin playground POST with toggle on.* Workflow starts; `triggered_by='playground'` recorded; admin UI receives stream
- *Happy path: admin chat POST with toggle on.* Workflow starts; `triggered_by='chat'` recorded
- *Toggle off.* Admin routes use legacy path; behavior unchanged
- *R3 verification.* `git grep dispatchSessionMessage src/app/api/admin/` returns no matches once both admin routes are migrated and toggle is on
- *Idempotency: admin replay.* Same admin request twice → DB-side dedup applies the same as REST

**Verification:**
- Admin playground and chat features work identically under workflow path; admin UI tests pass
- Combined with U5 and U6, the `WORKFLOW_DISPATCH_*` toggle space covers all six dispatch chokepoints

---

### U6. Cleanup cron migration with explicit cancel-throws-then-finalize wiring

**Goal:** `/api/cron/cleanup-sessions` gains workflow-aware branches per sweep. Critically, the workflow path's cancel-then-finalize wiring is specified — not deferred — so the salvage-before-stop ordering that the legacy cleanup cron enforces (and that recent commits like `375d826 fix(cleanup): per-agent active-watchdog + pre-kill transcript salvage` repeatedly fixed) is preserved. Cache invalidation during coexistence is also handled.

**Requirements:** R3, R5, R10, R12, AE1

**Dependencies:** U2 (workflow's finalize step must implement salvage-before-stop in its catch block), U4

**Files:**
- Modify: `src/app/api/cron/cleanup-sessions/route.ts` — each sweep (`sweepIdle`, `sweepCreatingWatchdog`, `sweepActiveWatchdog`, `sweepExpired`, `sweepOrphanSandbox`, `sweepActiveNoRunningMessage`) gains a per-session branch on `workflow_run_id`
- Modify: `src/lib/sessions.ts` — `getStuckActiveSessions` etc. already `SELECT *` so the new column is included automatically; add `getRunningWorkflowRunIdsForSession` helper for the cancel branch
- Modify: `src/lib/dispatcher.ts` — `invalidateSandboxHandle(sessionId)` called from the cleanup cron's workflow branch too (drains warm-handle cache during coexistence)
- Test: `tests/unit/sessions.test.ts` (extend), `tests/unit/api/cleanup-sessions-workflow.test.ts` (new)

**Approach:**

**Workflow-backed cancel wiring (the load-bearing part):**
1. Cleanup cron identifies stuck/expired session row with non-null `workflow_run_id`
2. Cron calls `getRun(runId).cancel(reason)` where `reason` carries the cleanup classification (`creating_watchdog`, `active_watchdog`, `idle_ttl`, `expired`, `orphan_sandbox`)
3. WDK propagates cancellation as a thrown exception inside the workflow's currently-parked step (typically `streamFromHook`'s hook iterator)
4. The workflow's body (sketch from U2) catches into the `finalize` step with `{ cancelled: true, reason }`
5. `finalize` step's cancel branch runs in this exact order:
   - Salvage transcript from sandbox FS via existing `salvageRunnerTranscript` (sandbox still alive)
   - Upload salvaged blob via existing `uploadTranscript`
   - `markInFlightMessage(sessionId, terminalStatus, errorType, errorMessage, transcriptBlobUrl)` — sets `transcript_blob_url` BEFORE message is no longer `running`
   - Stop sandbox via `sandbox.stop()` (only AFTER salvage)
   - CAS session to stopped
6. The workflow's `tail` step then runs `cleanupBlob` for `session_blob_url` (the SDK-session backup, separate from transcript blob)
7. `invalidateSandboxHandle(sessionId)` called explicitly on the way out; covers ADV-8 cache staleness during coexistence
8. The cleanup cron `await getRun(runId).status` until terminal (with a 30s timeout per row to avoid hanging the cron); if timeout, fall through to legacy direct-stop as defense in depth

**Legacy branch:** unchanged. Existing `salvageRunnerTranscript` + `stopSandboxBestEffort` + `markInFlightMessage` logic intact.

**Why both branches in coexistence:** Per-row dispatch (`workflow_run_id IS NULL → legacy`) means a single sweep can contain both kinds. `withConcurrency(SANDBOX_STOP_CONCURRENCY)` handles them in parallel.

**Patterns to follow:**
- Existing per-sweep structure (`withConcurrency`, `countSweepResults`)
- Existing salvage-stop-mark ordering in the legacy branch, which the workflow's finalize cancel branch mirrors exactly
- Logging: existing `logger.info("Watchdog fired", ...)` shape augmented with `workflow_run_id` field

**Test scenarios:**
- *Happy path: workflow-backed idle TTL.* Idle session past TTL → cron signals cancel → workflow's finalize records `timed_out` with reason `idle_ttl` → session stopped → transcript salvaged and attached
- *Happy path: legacy idle TTL.* NULL runId → legacy direct-stop path runs unchanged
- *Active watchdog: workflow-backed.* `Covers AE1, F4.` Active session past `max_runtime_seconds + 120s` → cron signals cancel → workflow's finalize: salvage FIRST → mark `timed_out` WITH transcript_blob_url → THEN stop sandbox. Order verified by mock-spy assertions (salvage call precedes sandbox.stop call).
- *Active watchdog: legacy.* Same scenario without runId → existing salvage-then-stop runs unchanged
- *Cancel propagation race.* Cron signals cancel during the sub-millisecond window where workflow has already entered `finalize` happy-path. WDK delivers cancel to a non-parked workflow gracefully (no-op or already-terminal); cron's `await status` resolves to terminal; no double-finalize
- *Expires_at sweep: workflow-backed.* Session past 4h cap with sandbox already gone → cron signals cancel → workflow's finalize tries salvage which returns null (sandbox unreachable) → message marked timed_out without transcript blob; behavior matches legacy null-salvage handling
- *Orphan sandbox: workflow-backed.* Stopped session with non-null `sandbox_id` and `workflow_run_id` → cron signals cancel (idempotent no-op since workflow already terminal) → orphan-stop clears `sandbox_id`
- *Mixed sweep.* Batch of 5 sessions, 3 workflow-backed and 2 legacy → both branches execute in parallel; per-session outcomes match per-branch expectations
- *Idempotency.* Cron runs twice on same stuck session in quick succession → second run no-ops (status already terminal); avoid double-cancel
- *Cache invalidation during coexistence.* After workflow-backed cancel, `invalidateSandboxHandle(sessionId)` drains the in-process warm-handle cache. Subsequent legacy-path read on the same isolate doesn't see stale handle. (Tested by snapshot of cache state before/after.)
- *Cron timeout fallback.* WDK cancel hangs (simulated); cron's 30s per-row timeout fires; legacy direct-stop runs as defense in depth; row ends up `stopped` either way

**Verification:**
- All scenarios pass; salvage-then-stop ordering verified by mock spy in the workflow-backed active-watchdog scenario
- A deliberately-stuck workflow-backed session is fully cleaned up within one cron cycle, with transcript salvage attached, matching legacy parity

---

### U7. Schedule cron migration (drain pain relocated, not removed — explicit)

**Goal:** `/api/cron/scheduled-runs/execute` consults the toggle. On-path uses DB-side dedup on `schedules.last_fired_dispatch_key` then starts the workflow. The drain-loop pain doesn't disappear — it relocates from the cron's per-read race-handling to the cleanup cron's stuck-active watchdog. This unit makes the relocation explicit and verifies the new failure surface against the originating commit shas.

**Requirements:** R3, R5, R10

**Dependencies:** U0, U1, U2, U4, U6

**Files:**
- Modify: `src/app/api/cron/scheduled-runs/execute/route.ts` — gate on `shouldUseWorkflow("schedule", tenantId)`. On-path: insert `(schedule_id, last_fired_dispatch_key)` (UNIQUE constraint added in U1) — duplicate returns 200 with `duplicate_skipped`; if accepted, `start(dispatchWorkflow, [input])` then `await Promise.race([run.returnValue, sleep(maxDuration - 30s)])`. Off-path: existing drain-loop code unchanged.
- Modify: `src/app/api/cron/scheduled-runs/route.ts` (claim cron) — unchanged, still claims agents with `FOR UPDATE SKIP LOCKED` and POSTs to `/execute`
- Modify: `vercel.json` — declare `maxDuration` for `app/api/cron/scheduled-runs/execute/**` explicitly (currently inherits Fluid Compute default 300s; making it explicit so the timeout math is visible to reviewers)
- Test: `tests/unit/api/scheduled-runs-workflow.test.ts` (new)

**Approach:**

**Drain-pain relocation (responding to fz-007):** The legacy schedule cron has 30s-per-read race-handling (FIX #20), `stream_detached` substring scanning (`ca384ff`), `schedule_no_terminal_event` post-drain fallback, and `casActiveToIdle` patching (`09ed4f0`). The workflow path collapses these into `await run.returnValue` with a maxDuration-bounded timeout — but the underlying problem (function host can't outlive a 1hr agent run) doesn't go away. It moves to:
- Cleanup cron's `sweepActiveWatchdog` becomes the backstop for runs that never emit terminal — no longer triggered by `schedule_no_terminal_event` from this cron, but by the per-agent `max_runtime_seconds + 120s` threshold detecting a stuck workflow
- The `streamDetached` event in legacy NDJSON is replaced by the cron's `await` timeout firing — same observability event, renamed to `schedule_workflow_detached`
- The `casActiveToIdle` patch is no longer needed — workflow's finalize handles all transitions whether the cron drained or the cleanup watchdog fired

This unit's tests verify the new failure surface against the 5 recent dispatcher/schedule commit shas explicitly.

**On-path flow:**
1. DB-side dedup via UNIQUE constraint on `(schedule_id, last_fired_dispatch_key)`; duplicate fire → 200 `duplicate_skipped` (replaces non-existent WDK `start()` idempotency)
2. `start(dispatchWorkflow, [input])` returns Run handle
3. `await Promise.race([run.returnValue, sleep(maxDuration - 30s)])`
4. On terminal: `{ status: 'completed', message_id }`
5. On timeout: `{ status: 'detached', message_id, workflow_run_id }`; workflow continues; cleanup cron is the backstop

**Patterns to follow:**
- Existing `verifyCronSecret` and `withErrorHandler` wrappers
- Existing logging keys (`schedule_id`, `agent_id`, `message_id`); add `workflow_run_id`
- Existing warm-session reuse via `findWarmScheduleSession`

**Test scenarios:**
- *Happy path: short run.* Schedule fires; workflow starts; runner emits terminal within 30s; cron returns `{ status: 'completed' }`
- *Happy path: long run (relocation case).* `max_runtime_seconds: 1800`; cron's await times out at `maxDuration - 30s` and returns `{ status: 'detached' }`; workflow continues; runner finishes 25min later; cleanup cron observes terminal status, no action needed
- *Idempotency: duplicate fire.* Two `/execute` POSTs for same `(scheduleId, fireTime)` → second returns 200 `duplicate_skipped` from UNIQUE conflict; no second workflow start
- *Concurrency limit.* Tenant at cap; `reserve` throws → cron returns `{ status: 'skipped', reason: 'concurrency_limit' }` matching legacy
- *Budget exceeded.* Same shape with `budget_exceeded`
- *Stuck workflow (relocated drain pain).* Runner never emits terminal; cleanup cron's active-watchdog signals cancel after `max_runtime_seconds + 120s`; finalize records `timed_out` with salvaged transcript
- *Per-commit named scenarios:*
  - `// 277a5e5 — finalize on empty stream` — workflow path equivalent: hook iterator never receives any non-text_delta line; streamFromHook's terminal sentinel never fires; cleanup cron's active-watchdog fires; finalize records `error_type: 'empty_stream_workflow'`
  - `// ca384ff — schedule skip post-drain after stream_detached` — workflow path equivalent: cron returns `detached`; cleanup cron has nothing to do because the runner is healthy and emits terminal 5min later. Verify cron does NOT mark the message failed prematurely.
  - `// 09ed4f0 — release active session when stuck-running fallback fires` — workflow path equivalent: cleanup cron's active-watchdog fires; cancel signals reach workflow; finalize transitions message to `timed_out` AND session to `stopped`; no leaked `active` row
- *Edge case: schedule disabled mid-run.* Schedule disabled while workflow in flight; cron's POST is fire-and-forget; run continues; matches legacy
- *Integration: warm-session reuse.* `findWarmScheduleSession` returns idle session from prior tick; reserve CAS idle→active; ensureSandbox reconnects warm sandbox

**Verification:**
- The 5 named per-commit scenarios pass against the workflow path
- Schedule tick cron stays within `maxDuration` even for hour-long runs
- The drain-pain relocation framing is documented in the test file as a comment block linking to the originating commits

---

### U8. Webhook ingress migration (with namespaced idempotency key)

**Goal:** `/api/webhooks/[sourceId]` `after()` handler consults the toggle. On-path uses DB-side dedup on `webhook_deliveries.delivery_id` (already enforced by UNIQUE index) as the only line of defense — WDK `start()` has no idempotency key. Idempotency key is namespaced as `(tenantId, sourceId, deliveryId)` in any cache lookups so cross-source `delivery_id` collisions cannot suppress legitimate dispatches (SEC-005).

**Requirements:** R3, R10

**Dependencies:** U0, U1, U2, U4

**Files:**
- Modify: `src/app/api/webhooks/[sourceId]/route.ts` — `after()` block gated on `shouldUseWorkflow("webhook", tenantId)`. On-path: existing `recordDelivery` UNIQUE-index insert is the dedup primitive; on accept, call `start(dispatchWorkflow, [input])`, await `run.returnValue` with bounded timeout; preserve existing `attachDeliveryMessage` and `markDeliveryError`
- Test: `tests/unit/api/webhooks-ingress.test.ts` (extend), `tests/unit/api/webhooks-cross-source-collision.test.ts` (new for SEC-005 attack)

**Approach:**

**Idempotency strategy (DB-side, single-layer):**
- `recordDelivery` insert into `webhook_deliveries` with `UNIQUE (source_id, delivery_id)` constraint is the only line of defense. WDK has no `start()` dedup. The plan's earlier "second-layer workflow dedup" mitigation (fz-002) is replaced by this single primitive.
- Namespaced key for any in-process cache lookups: `(tenantId, sourceId, deliveryId)`. Two webhook sources from different providers that happen to use the same `delivery_id` value (e.g., both numeric counters starting at 1) cannot collide because the DB constraint is `(source_id, delivery_id)` and any cache lookup uses the namespaced tuple.
- Failure-mode mapping (`ConcurrencyLimitError → rate_limited`, `BudgetExceededError → budget_exceeded`) preserved in catch block.

**Patterns to follow:**
- Existing Next.js `after()` pattern for fire-and-forget background work
- Existing `recordDelivery` + `attachDeliveryMessage` + `markDeliveryError` audit triple
- Existing HMAC verification + content dedupe + filter chain (unchanged — workflow start runs after the existing chain)

**Test scenarios:**
- *Happy path.* Valid webhook → `recordDelivery` creates row → workflow starts → runner executes → `attachDeliveryMessage` succeeds → `touchSourceLastTriggered` succeeds
- *Idempotency: same source duplicate.* Duplicate `delivery_id` from same source → `recordDelivery` returns existing → 200 with original `message_id`, no workflow start (verified by spy on `start()`)
- *Idempotency: cross-source collision.* `Covers SEC-005.` Two webhook sources, each emits `delivery_id=42`. Both ingest as separate `webhook_deliveries` rows (different `source_id`). Both fire workflows independently. Verifies the namespaced key actually allows distinct dispatches.
- *Failure: concurrency.* Tenant at cap → workflow's reserve step throws → `markDeliveryError(rate_limited)` → response `{ status: 503, retry-after: 60 }` matching legacy
- *Failure: budget.* Same shape with `budget_exceeded`
- *Failure: workflow runtime error.* Step crashes irrecoverably → `markDeliveryError(internal_error)` → message marked `failed`
- *Edge case: long-running webhook.* Webhook triggers 30-min agent run; `after()` handler awaits up to `maxDuration`, then exits; runner continues; cleanup cron handles eventual cleanup
- *Integration: filter rules.* Payload fails filter → existing 200 with `filtered: true` → no workflow start (filter chain unchanged)

**Verification:**
- Webhook ingress tests pass under both toggle states
- Cross-source `delivery_id` collision test confirms both sources can dispatch independently
- Duplicate-delivery dedupe still 200s with original `message_id`

---

### U9. A2A migration (with explicit AE4 extensibility coverage)

**Goal:** `SandboxAgentExecutor` consults the toggle. On-path uses DB-side idempotency, `render-a2a` shim, and the tenant-scoped cancel path. Includes an explicit AE4 test scenario verifying that adding a new entry point integrates by starting a workflow run with no new dispatcher branches and no parallel dispatch helper.

**Requirements:** R3, R4, R5, R10, AE4, F1, F2

**Dependencies:** U0, U1, U2, U3, U4

**Files:**
- Modify: `src/lib/a2a.ts` — `SandboxAgentExecutor.execute` gated on `shouldUseWorkflow("a2a", tenantId)`. On-path: build `DispatchInput`, run DB-side dedup on `(tenantId, requestId)` (request-UUID generated inside the executor before any DB write), call `start(dispatchWorkflow, [input])`. A2A SSE eventBus consumes from `render-a2a`'s output.
- Modify: `src/lib/a2a.ts` — `cancelTask` resolves `taskId → messageId → sessionId`, then calls the new tenant-scoped `cancelSession` (from U5); existing tenant binding via the executor's `deps.tenantId` is enforced in the cancel path.
- Modify: `src/app/api/a2a/[slug]/[agentSlug]/jsonrpc/route.ts` — pass workflow gating context to `createA2aHandler`. Agent Card metadata version unchanged.
- Test: `tests/unit/a2a.test.ts` (extend), `tests/unit/a2a-ae4-extensibility.test.ts` (new — verifies a new test entry point integrates by starting a workflow run, with no new branch in `dispatcher.ts`)

**Approach:**
- ContextId-keyed reuse logic unchanged. A session's path (workflow vs legacy) is fixed at first message — by-row coexistence rule from U5 applies here too.
- A2A SSE event sequence preserved bit-identical: `render-a2a` parses each NDJSON line from the workflow stream and emits same `task` / `status-update` / `artifact-update` events as legacy executor for the same input fixture.
- 15s heartbeat and `[DONE]` sentinel emitted by render shim.
- Tenant-scoped cancel: `cancelTask` calls `cancelSession(sessionId, tenantId)` (the U5 hardened path). Cross-tenant `taskId` attempts get a NotFoundError equivalent (A2A error code `-32001` task-not-found, no information leaked).

**Patterns to follow:**
- Existing `MessageBackedTaskStore` save-skip optimization (preserves DB-call savings)
- Existing `A2AError.internalError()` sanitization
- Tenant-scoped cancel pattern from U5

**Test scenarios:**
- *Happy path: first message with contextId.* `message/send` with new contextId → DB-side dedup accepts → workflow starts → both `sessions.context_id` and `sessions.workflow_run_id` set; response `taskId === messageId`
- *Happy path: follow-up message with same contextId.* Reuse hits existing session → workflow starts under same session; new run id overwrites the session's `workflow_run_id` (each message owns one workflow run)
- *Streaming: message/stream.* Client opens SSE → render-a2a emits A2A-spec events → `[DONE]` on terminal — sequence matches legacy for fixed input fixture
- *Cancel: same tenant.* `Covers F2.` `tasks/cancel` → resolves to messageId → sessionId → tenant-scoped `cancelSession` → workflow signal → message cancelled
- *Cancel: cross-tenant.* `Covers SEC-001 cross-tenant attack on A2A.* Tenant A authenticated; `tasks/cancel` with foreign tenant's taskId → `cancelSession` row read returns no row → A2AError task-not-found; WDK never called
- *Cancel: legacy session.* Same RPC against pre-toggle-flip session → existing path unchanged
- *ContextId === inboundTaskId edge case.* Existing logic discards as non-real contextId → fresh ephemeral session; matches legacy
- *Concurrency limit.* Tenant at cap → `A2AError(-32000, 'busy')` matching legacy
- *Budget exceeded.* `A2AError(-32001, 'budget')` matching legacy
- *Reconnect.* Client closes SSE mid-stream, re-issues `message/stream` → render-a2a reads `getReadable({ startIndex })` and resumes; legacy path unchanged for legacy sessions
- *AE4 — extensibility coverage.* `Covers AE4.` A test-only "test trigger" entry point is added that calls `start(dispatchWorkflow, [input])` with `triggered_by='test'`. The test asserts: (a) no new branch was added to `dispatcher.ts`, (b) no parallel dispatch helper exists, (c) the workflow runs end-to-end and produces the same DB state as any other entry point. Closes the F4 origin acceptance example explicitly.
- *Integration: Agent Card cache.* Public `.well-known/agent-card.json` cache hit/miss unchanged

**Verification:**
- A2A executor tests pass under both toggle states; SSE stream matches legacy event-for-event
- AE4 extensibility test confirms no `dispatcher.ts` branch was added for the test trigger
- Cross-tenant cancel produces task-not-found with no information leaked

---

### U10a. Legacy retirement (delete-only)

**Goal:** Delete the legacy dispatcher path once all six toggles have been at `on` in production for the lengthened soak period — **14 days** of production traffic across all entry points without a dispatcher-shaped regression, with at least one observed Vercel deploy roll-forward during a workflow run, AND zero new commits to `src/lib/workflows/` for 7 days. Keep the legacy `dispatchSessionMessage` body around behind a hard-coded `LEGACY_DISPATCH_GLASS_BREAK` env var for one additional release cycle as a glass-break recovery path.

**Requirements:** R11

**Dependencies:** U5, U5b, U6, U7, U8, U9 — all six entry points migrated and stable in production for 14d

**Files:**
- Modify: `src/lib/dispatcher.ts` — `dispatchSessionMessage` body extracted into a `if (process.env.LEGACY_DISPATCH_GLASS_BREAK === 'on')` branch; non-glass-break path always invokes the workflow. Helpers used by both paths (e.g., `reserveSessionAndMessage` body, `coldStartSandbox` body, `finalizeMessage` body, `sessionTail` body) move to `src/lib/workflows/steps/*.ts` as the workflow's internal helpers.
- Delete: process-local caches that no longer have callers (`activeSessions` LRU, `sessionBootAborts`)
- Modify: All routes that import from `src/lib/dispatcher.ts` — update imports to the workflow API surface; any unguarded toggle reads removed
- Modify: `src/lib/env.ts` — `WORKFLOW_DISPATCH_*` env vars marked deprecated; still parsed but always coerced to `on`. `LEGACY_DISPATCH_GLASS_BREAK` added.
- Modify: `vercel.json` — re-evaluate per-route `maxDuration`; many routes can have shorter durations now that they don't drain
- Convert (do not delete): `tests/unit/dispatcher-characterization.test.ts` → `tests/unit/workflow-characterization.test.ts`. Drop the legacy comparison; keep the cases. The named-per-commit scenarios (from U2, U7) become the post-retirement regression suite.
- Modify: `tests/unit/api/admin-sessions-workflow-context.test.ts` (new or extend)

**Approach:**
- Retirement is a code-delete (and characterization-test conversion); no behavior change beyond the legacy path becoming unreachable except via glass-break
- Coexistence cleanup: code paths that handled `workflow_run_id IS NULL` as "legacy session" can simplify (all new rows are workflow-backed; old `idle`/`stopped` rows aged out via 4h `expires_at` cap)
- The glass-break env var stays in code for one additional release cycle (~2 weeks) and is removed in a follow-up cleanup PR. Cost is dead code; benefit is a one-deploy revert path if a long-tail workflow regression appears post-retirement.

**Test scenarios:**
- *No-op gate: 14d soak required.* Pre-merge check (manual): all six toggles have been `on` in production for 14 calendar days, including at least one Vercel deploy during a workflow run, with zero new commits to `src/lib/workflows/` for 7 days
- *Happy path: post-retirement run.* Standard message flow runs via workflow path; legacy path unreachable without glass-break
- *Glass-break revert.* Setting `LEGACY_DISPATCH_GLASS_BREAK=on` returns dispatch to the legacy path; new sessions take legacy; workflow-backed in-flight sessions complete on workflow per the by-row rule
- *Cancel: post-retirement.* `cancelSession` always signals workflow; no legacy branch
- *Cleanup cron: post-retirement.* All sweeps assume `workflow_run_id` set; assert in tests no legacy-fallback path was reached
- *Edge case: aged legacy row.* A session row from before retirement (rare — would be from before phase 1) appears in DB; cleanup cron's expires_at sweep terminates it; the workflow-only path gracefully handles null runId by clearing `sandbox_id` and CAS-to-stopped
- *Test conversion: characterization survives.* The converted `workflow-characterization.test.ts` keeps every scenario from the pre-retirement characterization suite (including the named-per-commit scenarios) and they all pass against the workflow-only path

**Verification:**
- `git grep dispatchSessionMessage src/app` returns nothing (only the glass-break-gated wrapper in `src/lib/dispatcher.ts` remains)
- Glass-break env var verified to switch paths in a staging deploy
- Converted characterization suite passes; per-commit named scenarios still tracked

---

### U10b. Workflow run admin UI surface

**Goal:** Add the admin UI surface that shows workflow context per message. Split from U10a because this depends on WDK read-API maturity (an open question the plan has flagged), and the retirement (U10a) should not be blocked by an external API dependency.

**Requirements:** R12

**Dependencies:** U10a (retirement) AND a Phase-0 verified WDK read API for run history (verified via U0 spike or in a follow-up validation)

**Files:**
- Modify: `src/app/admin/sessions/[sessionId]/page.tsx` — show `workflow_run_id` field; link to step-list panel
- Create: `src/app/admin/sessions/[sessionId]/workflow-run-panel.tsx` — fetches step list via WDK read API; shows step names, status, duration, retry count, error message inline for failed steps
- Create: `src/app/api/admin/sessions/[sessionId]/workflow-run/route.ts` — admin-auth route that reads from WDK and returns step metadata as JSON for the panel
- Test: `tests/unit/api/admin-workflow-run.test.ts` (new)

**Approach:**
- Spike-derived: U0 (or a follow-up spike before this unit) must verify WDK exposes a queryable run-history API for steps. If absent, U10b ships a placeholder "view in Vercel dashboard" link instead of an inline panel — graceful degradation.
- Panel is read-only; no admin actions on workflow runs (cancel still routes through `cancelSession`).

**Test scenarios:**
- *Happy path.* Click a message in admin UI → panel shows seven step names, terminal status, duration; failed steps show error inline
- *Edge case: WDK read API unavailable.* Panel shows fallback "view in Vercel dashboard" link; no error
- *Edge case: workflow run still active.* Panel shows in-progress status; auto-refresh polling at 5s intervals while step list is non-terminal

**Verification:**
- Panel renders for at least one workflow-backed message in a deployed Vercel preview
- Fallback path (read API unavailable) renders a usable link without breaking the page

---

## System-Wide Impact

- **Interaction graph:** The internal-upload endpoint (`/api/internal/messages/:messageId/transcript`) becomes the critical join point — it's the only path the runner uses to communicate with the workflow via `resumeHook`. Outage breaks all runs. Per-message bearer-token auth, runner-side retry-with-backoff (added in U3), per-message line cap, and `(messageId, attemptSequence)` dedup tuple bound the abuse and reliability surfaces.
- **Error propagation:** Workflow step errors propagate as exceptions inside the workflow runtime; route handlers see them as `await run.returnValue` rejections. Standard error mapping (`ConcurrencyLimitError`, `BudgetExceededError`, `SessionStoppedError`, `NotFoundError`) preserved by re-throwing from inside `reserve` step.
- **State lifecycle risks:** Four columns added; all nullable for safe coexistence. Drift between `workflow_run_id`, `sandbox_id`, and `runner_started_at` is bounded by all transitions going through helpers in `src/lib/sessions.ts` and `src/lib/session-messages.ts`, inside the same step's tx where applicable. The `runner_started_at` column is the spawn-idempotency primitive (replaces the unsupported sandbox-process-inspection check).
- **API surface parity:** REST, A2A, admin, webhook, and schedule responses are byte-identical to legacy for the same inputs (characterization-test bar). Admin UI gains a workflow-context surface (U10b); otherwise unchanged.
- **Integration coverage:** The streaming bridge (U3) is the most-tested area because it crosses runner / sandbox / workflow / route-handler / client. Two render shims (REST, A2A) plus the internal-endpoint refactor plus reconnect endpoints.
- **Tenant isolation:** Strengthened — `cancelSession` now enforces tenant ownership via tenant-scoped DB read BEFORE WDK is touched; cross-tenant cancel attempts return NotFoundError. Per-tenant deny-list JSONB allows operator to disable workflow for one tenant without redeploy.
- **Subscription billing:** Unchanged in shape. `ensureSandbox` step calls existing `resolveSandboxAuth` + `buildSandboxAuthEnv` per-invocation; `CLAUDE_CODE_OAUTH_TOKEN` flows into runner env identically to legacy.
- **Unchanged invariants:**
  - `session_messages` and `agents` schemas unchanged in shape (only `runner_started_at` added; existing columns untouched)
  - Tenant concurrency cap of 50 active sessions, atomic SQL guard inside `reserve`, unchanged
  - In-session concurrency cap of 1, enforced via session status CAS, unchanged
  - 4h `expires_at` cap, unchanged
  - Per-trigger `idle_ttl_seconds` defaults, unchanged
  - Per-message bearer-token auth on internal endpoint, unchanged (TTL also unchanged at 1h)
  - HMAC verification + content dedupe on webhook ingress, unchanged
  - SoulSpec, plugins, MCP, schedule columns on `agents` — all untouched

---

## Alternative Approaches Considered

### Pattern B (workflow polls runner status) — viable fallback if U0 spike fails

**Shape:** Workflow's `awaitFinalize` step is a polling step that reads `session_messages.status` every N seconds. Runner keeps its current single-batched-terminal POST behavior — no per-line streaming change. REST/A2A streaming continues to use existing `streaming.ts` (unchanged) reading directly from runner output the same way legacy does.

**What you keep:**
- Zero runner-side changes (origin scope boundary on "no runner protocol changes" is honored)
- Smaller new-code surface in U3 (no `stream-bridge-server.ts`, no per-line dedup KV, simpler render shims because they just wrap legacy `createNdjsonStream`)
- Lower workflow event cost (one `getRun.status` poll every 5–10s vs 50+ `resumeHook` calls per run)

**What you lose:**
- Live streaming through the workflow path is gone — REST/A2A clients consume the same way they do today (direct from sandbox runner via the route handler, with `streaming.ts`'s 4.5min detach + reconnect machinery preserved)
- Workflow run history shows step boundaries but NOT the per-line transcript stream as a durable artifact
- Polling cost: a 1hr run with 5s polling = 720 polls. Each poll re-triggers the workflow runtime — comparable cost to Pattern A's coalesced POSTs (50/min for a typical run = 3000/hr). Not obviously better.

**Why Pattern A was selected:** brainstorm dialogue confirmed Pattern A as the answer to the "how does the workflow wait" question. Pattern A unifies REST and A2A on the same workflow stream, addressing origin R4 cleanly. Pattern B leaves R4 partially achieved — REST and A2A continue to use the existing two streaming codepaths instead of one.

**When Pattern B becomes the right choice:**
- U0 spike reveals that `createHook` / `resumeHook` don't work on the pinned WDK version, OR
- WDK signal-from-outside primitives are absent, OR
- The Phase-2 staging-soak shows Pattern A's per-line cost is excessive at production fan-in

**If Pattern B is selected post-U0:** plan returns to brainstorm to revise R4 (one streaming primitive vs two). Implementation units U2/U3 are substantially re-shaped; U4–U10 are largely unchanged.

### Workflow per-line `getWritable()` from outside (rejected)

The plan's earlier draft assumed `getRun(runId).getWritable().write(chunk)` could be called from the internal endpoint. Verified-no on the WDK API. Listed here so reviewers don't re-suggest it: `getWritable()` is documented to be callable only inside a workflow or step function. Pattern A's hook-based design replaces this assumption.

### Mid-turn workflow checkpointing (rejected — origin R6)

Origin R6 explicitly rules out checkpointing inside an SDK loop. Bounded auto-reissue with three pre-flight gates is the policy. Listed here so reviewers don't re-suggest it.

### Status-of-record swap (workflow run history replaces `session_messages`) (rejected)

Workflow run history is the *operational* audit surface (R12). `session_messages` remains the *billing* record because billing has hard requirements (immutability, monthly reconciliation, audit retention) that workflow run history does not satisfy. Listed here so reviewers don't propose collapsing them.

---

## Risks & Dependencies

| Risk | Likelihood | Impact | Mitigation |
|------|-----------|--------|------------|
| ~~WDK signal API differs from searched docs~~ — **RESOLVED via U0 spike (2026-05-06).** Hook lifecycle, signal-from-outside, cancel propagation, getReadable reconnect, step retry, and long-idle suspension all verified on a deployed Vercel preview. Three non-obvious constraints surfaced and are now baked into U2/U3 (createHook in body not step; Hook<T> non-serializable across boundary; stream writes must be in step). | Resolved | n/a | Done — see `docs/research/wdk-spike-results.md` for the full record. |
| `getReadable` after run terminates hangs without `getTailIndex()` bound | Medium | Medium | U3 render shims MUST use `getTailIndex()` — documented in U3's Render shims section. Test scenario covers it explicitly. |
| Render shim accidentally calls `.cancel()` on a `WorkflowReadableStream` and kills the run | Low | High | U3 documents the rule; test scenario verifies; consider a lint rule ban on `WorkflowReadableStream.cancel()` calls outside the explicit `cancelSession` path. |
| Hook registration latency on Vercel cold-start (~500ms–1.2s measured) burns runner POSTs without backoff | Resolved (mitigated) | Medium | U3 runner-side backoff is U0-derived (100ms→1.6s, 30s budget). Verified absorbing the window in U0 spike scenarios 1+2. |
| Cross-tenant workflow cancellation via guessed runId | Low | High | `cancelSession` does tenant-scoped DB read FIRST; only after row's `tenant_id` matches caller does the `getRun().cancel()` call fire. Audit-logged. RLS bypass would be required to reach the cancel — and would already be a higher-severity break elsewhere. |
| Stolen per-message bearer token used to flood internal endpoint with malicious NDJSON | Low | High | Per-message line cap enforced at endpoint (default `max_runtime_seconds * 100` lines); `(messageId, attemptSequence, batchSequence)` dedup; `session_messages.status == 'running'` check rejects post-terminal POSTs. Token TTL unchanged from today (1h). |
| Auto-reissue (R6) re-executes side-effectful tools (Composio, file writes) twice | Medium | High | Three pre-reissue gates: status check, stream-empty check, attempt-count check. All three must pass before reissue fires. A non-empty stream is treated as "runner reached operational state" and blocks reissue. |
| Runner's own retry layers (SDK 429/5xx, internal POST retries, workflow step retries) compound to multi-billed runs | Medium | High | `(messageId, attemptSequence)` dedup tuple at the bridge ensures duplicate runner POSTs don't enter the stream twice. `launchRunner` uses `runner_started_at` DB column (transactional) as spawn idempotency primitive — replay finds non-null and skips. Sandbox-side process inspection NOT relied upon. |
| Workflow stream cost (each `resumeHook` re-triggers workflow): high fan-in tenants hit cost ceiling | Medium | Medium | Coalescing strategy: 10 lines OR 100ms. Critical events (`result`, `error`) flush immediately. Caps per-message POST count at ~50/min for typical runs. Monitor in Phase 2 before flipping more toggles. |
| Per-line POST sequence reordering corrupts stream | Low | Medium | KV-backed dedup tuple `(messageId, attemptSequence, batchSequence)`; within-batch order preserved via NDJSON. Cross-batch reorder accepted (rare on internal Vercel-to-Vercel paths) — coalesced batch sizes keep within-batch order sufficient for client UX. |
| Cancel signal arrives after workflow is already terminal (race) | High | Low | `getRun().cancel()` documented to be safe at any state. Plus existing DB CAS-to-stopped is the source of truth. |
| Function host crashes mid-`launchRunner` produces a runner spawned in sandbox without a workflow waiter | Medium | High | DB-backed idempotency: `runner_started_at` column set inside the spawn step's tx BEFORE the actual sandbox call returns. Replay finds non-null and skips spawn. Orphaned runners reaped by cleanup cron's stuck-active watchdog. |
| Render-a2a parity drift — A2A SSE events accidentally diverge from legacy | Medium | High | Characterization tests capture event sequences for fixed fixtures; U9's tests assert byte-for-byte parity. Per-commit-named test scenarios cover the 5 recent edge cases explicitly. |
| Schedule cron's `await run.returnValue` extends function duration past `maxDuration` for long agents | High | Medium | Cron `/execute` always exits at `maxDuration - 30s` (timeout-bounded await). Drain pain doesn't disappear — relocated to cleanup cron's stuck-active watchdog. New failure surface tested explicitly with per-commit named scenarios. |
| Deploy rollback during migration strands workflow-backed sessions on a runtime that no longer recognises their runId | Medium | High | Versioned runId prefix (`wdk_v1_`) at U1; rollback runbook (Operational Notes) specifies forward-version detection and the legacy-fallback path while it still exists (Phases 2–3). Post-retirement: rollback is a one-way door requiring forward fix. |
| Stale `authCache` (process-local 5min TTL) injects expired subscription token on workflow retry | Low | Medium | `ensureSandbox` step calls `resolveSandboxAuth` on every invocation (per spec). 5min TTL is a documented limitation matching the legacy behavior. Tenant token updates currently take up to 5min to propagate; unchanged. |
| Subscription billing breaks because auth env var doesn't reach the runner via the workflow path | Low | Critical | `ensureSandbox` step calls `resolveSandboxAuth` + `buildSandboxAuthEnv` — same code as legacy. Verified in U2 happy-path test scenario. |
| Characterization tests can't pin timing-sensitive race fixes (the actual content of recent commits) | Medium | High | Two-prong: (a) per-commit-named test scenarios in U2/U7 reference the originating shas; (b) Phase-2/3 staging-soak intentionally injects each commit's failure scenario under load before each toggle goes to `on` in production. |
| Toggle flip causes some entry points workflow / others legacy on same session | Low | Low | By-row coexistence (`workflow_run_id IS NULL → legacy`) makes path immutable per session once set. Toggle only affects new sessions. |
| Per-tenant deny-list cache (60s TTL) propagates emergency disable too slowly | Low | Medium | 60s upper bound documented; tested. Critical incidents: operator can also flip the global env toggle (instant-on-deploy) as a stronger lever. |
| 14d retirement gate is still insufficient for a long-tail bug appearing at week 6 | Medium | Medium | Glass-break env var (`LEGACY_DISPATCH_GLASS_BREAK=on`) preserves a one-deploy revert path for one additional release cycle (~2 weeks) post-retirement. Cost is dead code; benefit is bounded recovery time on long-tail. |

---

## Documentation / Operational Notes

### Documentation updates

- After U10a cutover: update `CLAUDE.md`'s "Execution flow (unified)" section to replace step 1–12 with the workflow's seven-step shape and the runner's per-line POST coalescing pattern.
- Update `CLAUDE.md`'s "Patterns & Conventions" entry on stream detach: workflow streams are Redis-backed and durable by default; the 4.5min detach is informational, not load-bearing for reconnect.
- Update `docs/solutions/logic-errors/transcript-capture-and-streaming-fixes.md` after U3 lands: add a section on the per-line POST forwarding rules (preserves the existing event-type matrix; rules now applied inside `streamFromHook` step rather than in `captureTranscript`).
- Update `docs/webhook-triggers.md` after U8 lands: document namespaced idempotency key shape `(tenantId, sourceId, deliveryId)`.

### Operational runbook (new)

**File:** `docs/runbooks/workflow-dispatch-incident.md`

Sections:
1. **Triage a stuck workflow.** Read `workflow_run_id` from the session row → inspect step states via WDK runtime read API → if stuck, signal `getRun(runId).cancel(reason)` → cleanup cron will finalize within one tick.
2. **Disable workflow for a problematic tenant.** Update `tenants.workflow_dispatch_overrides` JSONB to `{"<trigger>": false}` for the affected tenant. Cache invalidates within 60s. No redeploy needed.
3. **Disable workflow globally.** Flip the relevant `WORKFLOW_DISPATCH_*` env var to `off` and redeploy. New sessions take legacy; in-flight workflow sessions complete on workflow per by-row rule.
4. **Force a workflow-backed row back to legacy (Phases 2–3 only).** This is unsafe in general but supported during coexistence: clear `workflow_run_id` from the session row → cleanup cron's expires_at sweep terminates via legacy salvage path on the next tick. Document that the workflow run becomes orphaned (it will eventually expire on its own; logs show the abandonment).
5. **Deploy rollback during migration.** Rollback during Phases 2–4 strands sessions whose runId points at a runtime version no longer present. The `wdk_v1_` prefix lets rollback code detect format-incompatible runIds and route them to the legacy salvage path. Document that a rollback during workflow migration may produce a 4h hang on stranded rows (waiting for `expires_at` sweep) — accept this cost, or run the runbook step 4 to drain explicitly.
6. **Glass-break revert post-U10a.** Set `LEGACY_DISPATCH_GLASS_BREAK=on` and redeploy. New dispatches use the glass-break legacy path. By-row rule still applies; existing workflow rows finish on workflow until their natural lifecycle ends.

### Env var lifecycle

- After U10a: `WORKFLOW_DISPATCH_*` env vars deprecated (still parsed, coerced to `on`). `LEGACY_DISPATCH_GLASS_BREAK` added.
- After one additional release cycle (~2 weeks post-U10a): follow-up cleanup PR removes both deprecated vars and the glass-break wrapper. Schedule explicitly.

---

## Phased Delivery

### Phase 0 — Spike (U0)

**Single-unit phase.** Verify the WDK primitives this plan depends on against the pinned package version, deployed to a Vercel preview. No production traffic, no toggles, no schema changes — just a yes/no on whether Pattern A is viable.

**Exit criteria:** All 8 spike scenarios in `docs/research/wdk-spike-results.md` are `verified` OR every `unverified` / `failed` item has a documented mitigation incorporated back into the plan. If items 1, 2, 5, or 7 fail, the plan returns to brainstorm to re-evaluate Pattern A vs Pattern B (see Alternatives Considered).

### Phase 1 — Foundation (U1, U2, U3, U4)

Lands the workflow primitive end-to-end without any production traffic on it. All toggles default `off`. CI runs the new test suites. No user-visible change. Characterization tests land BEFORE workflow code so the parity bar is immutable.

**Exit criteria:** Workflow runs end-to-end against a test agent in staging; characterization tests pass against legacy; render shims produce byte-identical output for fixed fixtures.

### Phase 2 — REST + Cleanup + Admin (U5, U5b, U6)

The two most-patched entry points (REST + cleanup) plus the previously-missed admin entry points (playground, chat) migrate first. Cleanup cron's workflow branch handles workflow-backed sessions; legacy branch unchanged.

Each toggle is flipped on individually with **48 hours of single-toggle observation** before the next is enabled — so a regression on one toggle doesn't get conflated with another. Per-tenant deny-list is the emergency disable lever.

**Phase 2 also runs the staging-soak**: deliberately inject the failure scenarios from the 5 recent dispatcher/schedule commits against the workflow path under load, before flipping the matching toggle in production.

**Exit criteria:** `WORKFLOW_DISPATCH_{API,ADMIN,CLEANUP}=on` in production. 7 days clean operation per toggle. New dispatcher-shaped commits trend toward zero.

### Phase 3 — Schedule, Webhook, A2A (U7, U8, U9)

The remaining three entry points migrate. Order by historical pain (schedule cron's drain-loop has been the loudest, then webhook, then A2A which has been quieter).

**Same 48h-per-toggle observation cadence** plus per-toggle staging-soak.

**Exit criteria:** All six toggles (`API`, `ADMIN`, `CLEANUP`, `SCHEDULE`, `WEBHOOK`, `A2A`) `on` in production. 7 days clean operation across all entry points.

### Phase 4 — Retirement (U10a)

Delete `dispatcher.ts` body; preserve glass-break path. Convert characterization tests to workflow-only.

**Exit criteria:** **14 days** of all-toggles-on production traffic without dispatcher-shaped regressions, including at least one Vercel deploy roll-forward during a workflow run, AND zero new commits to `src/lib/workflows/` for 7 days. `git grep dispatchSessionMessage src/app` returns nothing. Glass-break env var verified to switch paths in staging.

### Phase 5 — Admin UI Workflow Surface (U10b)

Ships separately from retirement so WDK read-API immaturity can't block legacy delete. Includes graceful degradation if the read API is unavailable.

**Exit criteria:** Admin UI shows workflow run id and step list for at least one workflow-backed message in production.

---

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-05-workflow-sdk-dispatch.md](../brainstorms/2026-05-05-workflow-sdk-dispatch.md)
- **Current dispatcher:** `src/lib/dispatcher.ts` (~1100 lines, the chokepoint being replaced)
- **Recent commit history showing dispatcher pain:** `git log --oneline -- src/lib/dispatcher.ts src/app/api/cron/cleanup-sessions src/app/api/cron/scheduled-runs | head -20`
- **Institutional learning on streaming/transcript rules:** `docs/solutions/logic-errors/transcript-capture-and-streaming-fixes.md`
- **WDK overview blog:** https://vercel.com/blog/introducing-workflow
- **WDK docs (foundations):** https://workflow-sdk.dev/docs/foundations/
- **WDK source:** https://github.com/vercel/workflow
- **Reference implementation:** https://github.com/vercel-labs/open-agents (the inspiration cited in the brainstorm)
- **Vercel function duration limits:** https://vercel.com/docs/functions/configuring-functions/duration
