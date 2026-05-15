---
title: "feat: Sleep Cycle — Hermes-style learning layer above Mem0"
type: feat
status: active
date: 2026-05-06
origin: docs/brainstorms/2026-05-06-sleep-cycle-hermes-requirements.md
---

# feat: Sleep Cycle — Hermes-style learning layer above Mem0

## Summary

Implement the per-agent learning layer the origin doc spec'd: a new `src/lib/learning/` module providing two firing modes (`triggerSleepAfterthought` wired alongside Mem0's `triggerExtract` in `finalizeMessage` + the detached-stream transcript route, and a new `/api/cron/sleep-cycle` per-minute cron) that read transcripts + Mem0 entries via a new `transcript-fetch` helper, run platform-side Hermes prompts (Vercel AI SDK `generateObject`), and write back two artifacts — Mem0 mutations through `MemoryAdapter` and learned skills atomically appended to `agents.skills` JSONB under a `folder: 'learned'` entry.

---

## Problem Frame

The origin doc establishes the WHAT — agents accumulate Mem0 entries linearly with no mechanism to consolidate duplicates, retire stale facts, or distill repeated procedural exploration into named skills (see origin: `docs/brainstorms/2026-05-06-sleep-cycle-hermes-requirements.md`).

This plan defines the HOW: where in the post-finalize path the second hook fires (after Mem0's own `triggerExtract`, sharing the same 600s `maxDuration` budget); how the cron claims due agents (mirror `scheduled-runs` cron's `FOR UPDATE SKIP LOCKED` pattern); how the Hermes prompt is shaped for platform-side execution (no MCP tools available, so output is a structured `generateObject` response the platform applies); how learned skills land in `agents.skills` JSONB without racing the existing skill editor (atomic SQL operators, single `folder: 'learned'` entry holding files keyed by stable slug); and how the `AuditCaller` union in the Mem0 plan needs a coordinated `'sleep-cycle'` extension so audit events fire automatically inside `MemoryAdapter`.

---

## Requirements

Carried forward from origin (see origin: `docs/brainstorms/2026-05-06-sleep-cycle-hermes-requirements.md`). R-IDs unchanged.

- R1. Per-agent boolean `learning_enabled`, default false; independent from Mem0's `memory_enabled` but does nothing useful unless that is also true.
- R2. v1 ships exactly one Sleep Cycle implementation; no backend selector.
- R3. Per-agent deep-sleep schedule with default daily 3am tenant-local; v1 exposes the column without admin-UI override.
- R4. Afterthought runs after `triggerExtract` for `status='completed'` messages of `learning_enabled` agents within the route's `maxDuration`.
- R5. Afterthought is idempotent across the two call sites via claim/complete CAS on `session_messages.learning_afterthought_claimed_at` + `learning_afterthought_completed_at`.
- R6. Afterthought reads bounded-buffer-filtered transcript + agent's current Mem0 entries via `MemoryAdapter.list`.
- R7. Afterthought writes new memories via `MemoryAdapter.extract`, soft-deletes duplicates via `MemoryAdapter.delete` with caller-tagged audit, and appends/updates skill entries on `agents.skills` JSONB under `folder: 'learned'` with stable slugs.
- R8. Time-remaining guard skips when <30s remaining; emits `learning_afterthought_skipped_no_time_budget`.
- R9. Cancelled, failed, timed-out messages do not trigger afterthought.
- R10. Afterthought failures are non-fatal; no v1 retry; `claimed_at` is append-only.
- R11. Per-minute cron at `/api/cron/sleep-cycle` claims due agents using `FOR UPDATE SKIP LOCKED`.
- R12. Deep sleep reads transcripts since `last_sleep_at` plus current Mem0 entries; writes the same two artifacts as afterthought.
- R13. Soft cap of 50 learned skills per agent; deep sleep consolidates/retires before adding when at cap.
- R14. Deep-sleep failures roll `next_sleep_at` forward; partial writes survive.
- R15. Two-bucket Hermes prompt (personal memory + skills); no shared bucket.
- R16. Adaptive model selection — Haiku-class for simple successful afterthoughts, agent's main model for complex/failed afterthoughts and all deep-sleep cycles; configurable via `LEARNING_AFTERTHOUGHT_MODEL` and `LEARNING_DEEP_SLEEP_MODEL`.
- R17. Reflection transcripts injection-scanned per-message before reaching the reflection LLM.
- R18. Both runners consume Sleep Cycle output through existing primitives (memory recall path, skill-injection path); neither sees Sleep Cycle tools.
- R19. No sandbox network or skill-injection changes.
- R20. Sleep Cycle LLM cost counted against agent's monthly budget like a regular run.
- R21. Per-cycle budget caps: afterthought = `max($0.001, min($0.25, message_cost × 10%))`; deep sleep = flat per-agent default ($1.00) configurable per-agent via `agents.deep_sleep_cap_usd`.
- R22. All `MemoryAdapter` calls from Sleep Cycle pass `caller: { type: 'sleep-cycle', cycle_id }` so audit events fire automatically inside the adapter.
- R23. Sleep Cycle emits structured events for both firing modes; per-cycle counts queryable from logs.

**Origin actors:** A1 (Agent author), A2 (Agent runtime), A3 (Platform dispatcher), A4 (Sleep Cycle), A5 (Memory backend / `MemoryAdapter`)
**Origin flows:** F1 (Afterthought, post-finalize), F2 (Deep sleep, scheduled), F3 (Agent run consumes layered output)
**Origin acceptance examples:** AE1 (R1, R18), AE2 (R4, R5, R6, R7), AE3 (R5), AE4 (R7, R22), AE5 (R8), AE6 (R9), AE7 (R13), AE8 (R10, R14), AE9 (R3, R11), AE10 (R18, R19)

---

## Scope Boundaries

### Deferred for later

Carried verbatim from origin (`Deferred for later` subsection):

- Tenant-shared learned skills (cross-agent).
- Promoting afterthought / deep sleep to Workflow DevKit steps for crash-durable retries.
- Extending `MemoryAdapter` with `update` / `merge`.
- Sleep Cycle afterthought retry mechanism; v2 needs a separate `learning_afterthought_attempt_id` column.
- Encryption at rest for skill bodies in `agents.skills` JSONB.
- Soft-delete + 30-day undo for learned skills.
- Admin UI for browsing / pinning / forgetting learned skills (richer surface beyond the existing skill editor showing the `learned/` folder).
- Per-skill confidence scoring or decay-on-disuse.
- Manual "trigger sleep cycle now" admin button.
- Per-skill cost passthrough in billing UI.
- Mid-session skill availability.
- Sleep Cycle effectiveness measurement scaffolding.

### Outside this product's identity

Carried verbatim from origin (`Outside this product's identity` subsection):

- Anthropic Managed Agents "Dreaming" feature as the substrate.
- Outcomes-style rubric grading.
- Cross-tenant skill marketplace.
- "Shared memory" bucket from agent-co's literal Hermes prompt.

### Deferred to Follow-Up Work

Plan-local — work this plan does not implement but expects to ship in a separate PR or as a fast-follow:

- **Read-only `learned/` folder in the skill editor** — `FileTreeEditor` is read-write today; surfacing `learned/` would let operators edit the LLM-generated skill bodies. v1 leaves the existing read-write behavior; revisit if operators report accidental edits.
- **Lost-attempt sweep query** — the `learning_afterthought_lost` event needs a periodic sweep to fire (Mem0 plan deferred its lost-extract sweep similarly). Add as a single combined sweep alongside Mem0's once both ship.
- **Admin UI per-agent deep-sleep schedule editor** — v1 exposes `agents.deep_sleep_cron` as a column without UI; add a schedule picker in the General tab once cadence options stabilize.
- **`LEARNING_FEATURE_ENABLED` removal** — gate flag for incremental rollout; remove once Sleep Cycle has run cleanly in production for ~2 weeks.

---

## Context & Research

### Relevant Code and Patterns

- **Mem0 parent plan:** `docs/plans/2026-05-06-003-feat-mem0-memory-primitive-plan.md` — Sleep Cycle's direct parent. Inherits `triggerExtract`'s claim/complete CAS shape, the bounded-buffer transcript allowlist discipline, the `MemoryAdapter` interface, the `AuditCaller` shape, the `maxDuration` 600s bump, and the soft-delete + hard-purge contract. **Sleep Cycle ships AFTER Mem0 plan U6 + U7 are live.**
- **Prompt-injection-scanner plan:** `docs/plans/2026-05-06-002-feat-prompt-injection-scanner-plan.md` — Sleep Cycle's transcript injection scanning depends on the same primitive Mem0 extract uses; deploy-coordinate, and document the gap window matching Mem0 plan's posture.
- **Schedule cron precedent:** `src/app/api/cron/scheduled-runs/route.ts:71-110` — two-step CTE (`candidates` → `locked`) with `FOR UPDATE OF s SKIP LOCKED LIMIT $1`, claim + advance `next_run_at` atomically inside one transaction. Sleep Cycle's deep-sleep cron mirrors this exactly for `next_sleep_at`.
- **`schedules` table cutover:** Migration `013_schedules_table.sql` moved schedule data off `agents` into a dedicated table. **For Sleep Cycle, `next_sleep_at` / `last_sleep_at` belong on `agents` directly** (one cycle per agent — simpler than re-using the multi-schedule shape).
- **Skill JSONB schema:** `src/db/migrations/004_add_agent_skills.sql` — `agents.skills` is `JSONB NOT NULL DEFAULT '[]'`; runtime type `Array<{ folder: string; files: Array<{ path: string; content: string }> }>` (`src/lib/sandbox.ts:139`). `SkillsSchema` enforces folder uniqueness — Sleep Cycle uses ONE `{folder: 'learned', files: [...]}` entry holding all learned skills, keyed by slug-named filenames.
- **Sandbox skill materialization:** `src/lib/sandbox.ts:300-311` (Claude SDK initial), `src/lib/sandbox.ts:1071-1078` (session reconnect). No code branches on folder name — `learned/` flows through unchanged.
- **AI SDK skill registry:** `src/lib/runners/vercel-ai-runner.ts:29-110` (`buildSkillsPrompt`, `buildSkillRegistry`); `src/lib/runners/vercel-ai-shared.ts:81-110` (`load_skill` tool body) — looks up by `skill.folder`, case-insensitive. A `learned` skill loads identically to a manual one.
- **Skill editor:** `src/app/admin/(dashboard)/agents/[agentId]/skills-editor.tsx` uses `FileTreeEditor` and reconstructs the grouped `{folder, files}[]` shape on save. The `learned/` folder appears automatically in the tree once entries exist; no editor code change required for v1.
- **Post-finalize hook surfaces (two call sites):** `src/lib/dispatcher.ts:1008` `finalizeMessage`; `src/app/api/internal/messages/[messageId]/transcript/route.ts:80-254` (legacy POST handler — does NOT call `finalizeMessage`). Mem0 plan U5 wires `triggerExtract` at both. Sleep Cycle's `triggerSleepAfterthought` wires at the same two sites, sequenced AFTER Mem0's call.
- **`after()` precedent:** `import { after } from "next/server"`; only existing caller is `src/app/api/webhooks/[sourceId]/route.ts` (line 1 import; lines 42, 374, 403, 409 usages). Sleep Cycle mirrors that shape.
- **Bounded-buffer write side:** `src/lib/transcript-utils.ts:121-190` `captureTranscript` — `MAX_TRANSCRIPT_EVENTS = 10_000`, `result`/`error` always preserved past the cap (lines 145-152, 178-184), `text_delta` excluded from chunks (lines 160-166). **No read-side helper exists today** — three inline `fetch(message.transcript_blob_url)` callers (`src/app/admin/(dashboard)/sessions/[sessionId]/live-session-detail.tsx:100`, `src/app/api/admin/sessions/[sessionId]/messages/[messageId]/stream/route.ts:33`, `src/app/api/sessions/[sessionId]/messages/[messageId]/stream/route.ts:46`). Sleep Cycle adds the first reusable read-side helper at `src/lib/transcript-fetch.ts`.
- **Cron registration:** `vercel.json:3-9`. Per-minute slot pattern (`* * * * *`) used by `scheduled-runs`. Sleep Cycle adds an entry at the same cadence.
- **Per-agent flag precedent (a2a_enabled):** boolean default false; partial index `(tenant_id) WHERE a2a_enabled = true`. Sleep Cycle mirrors with `learning_enabled boolean NOT NULL DEFAULT false` and a partial index `(next_sleep_at) WHERE learning_enabled = true`.
- **Zod schema double-add discipline:** `src/lib/types.ts` (`Agent` type), `src/lib/validation.ts` (`AgentRowInternal` AND `AgentRow` schemas) — both must add `learning_enabled` or `queryOne` silently strips the field.
- **Admin UI toggle precedent:** `src/app/admin/(dashboard)/agents/[agentId]/edit-form.tsx` (form control) + `src/app/api/admin/agents/[agentId]/route.ts:104-129` (`fieldMap`).
- **AI Gateway side-call shape:** `src/lib/soul-generation.ts:193` `callGateway()` — model + AbortController + bounded timeout. Sleep Cycle mirrors for the platform-side reflection LLM call (Vercel AI SDK `generateObject` with Zod schema is the cleaner alternative; both paths should support an abort signal).
- **Reference prompt shape:** `~/code/agent-co/lib/execution/reflection.ts` — agent-co's Hermes pattern. Sleep Cycle ports the structure but adapts for platform-side execution (LLM has no tool access; output is structured JSON the platform applies, not tool calls the LLM makes inline).

### Institutional Learnings

- `docs/solutions/logic-errors/transcript-capture-and-streaming-fixes.md` — bounded-buffer rules: include `result`/`error` past truncation, exclude `text_delta`. The afterthought prompt builder must tolerate truncated transcripts where only `result`/`error` survive past `MAX_TRANSCRIPT_EVENTS`.
- **Schedule-cron `FOR UPDATE SKIP LOCKED` discipline** (`docs/plans/2026-03-07-feat-scheduled-agent-runs-plan.md`): claim and advance `next_at` inside the same transaction; do not split across two statements. Post-claim work failure leaves the schedule advanced — accept "missed cycle" semantics rather than reverting the claim. Use `unnest()` for batch advances if a reaper ever advances multiple agents at once.
- **JSONB array mutation safety** (`docs/plans/2026-03-01-feat-sdk-full-resource-management-plan.md`): use atomic SQL operators (`skills || $1::jsonb` with `NOT EXISTS` for append-or-skip; `jsonb_agg(CASE WHEN ...)` for in-place update; `jsonb_array_length(skills) < N` for cap enforcement). NEVER read-then-write in JS — Sleep Cycle's writes race the admin skill editor and themselves across concurrent afterthought + cron paths.
- **Per-agent flag rollout silent-failure mode** (`docs/plans/2026-03-10-001-feat-a2a-protocol-integration-plan.md`, lines 158, 201): adding the column to the migration but forgetting `AgentRowInternal` AND `AgentRow` Zod schemas reads as NULL/undefined client-side despite the DB row being correct. Both schemas must be updated in the same PR as the migration.
- **`after()` semantics + claim/complete CAS** (Mem0 parent plan, lines 449-513): `claimed_at` is append-only; pair with `completed_at`; never mutate the claim column. v2 retries use a separate `attempt_id` column. Time-remaining guard uses a named proxy `(maxDuration*1000) - (Date.now() - routeStart)` and skips at <30s with a structured event.

### External References

External research not run for this plan — local patterns are strong (Mem0 plan provides the immediate parent shape; agent-co's `reflection.ts` provides the prompt shape; `scheduled-runs` cron provides the claim shape; existing skill JSONB pattern provides the output shape).

---

## Key Technical Decisions

- **Platform-side reflection, not in-sandbox.** agent-co's Hermes runs inside the agent sandbox with MCP tool access. AgentPlane's Sleep Cycle runs on the platform — the LLM has no tool access. Output is a Zod-typed structured response (`memories_to_add`, `memories_to_retire_ids`, `skills_to_upsert`, `skills_to_retire_slugs`) which the platform applies in a single SQL transaction per agent. Vercel AI SDK `generateObject` is the natural shape; falls back to text + `JSON.parse` if needed.
- **Single `folder: 'learned'` JSONB entry holding all learned skills as files keyed by slug.** Matches `SkillsSchema`'s folder-uniqueness invariant. File names are `<slug>.md`; slug is kebab-case of an LLM-named title, validated against `^[a-z0-9][a-z0-9-]{0,63}$` and de-duplicated by collision check at write time. Updates target the file path, not the folder; appends extend the `files` array.
- **Sleep Cycle columns belong directly on `agents`, not in the `schedules` table.** One cycle per agent; using `schedules` would introduce `kind: 'sleep'` rows and a different retrieval path. Adding `next_sleep_at` / `last_sleep_at` / `deep_sleep_cap_usd` / `deep_sleep_cron` as columns on `agents` matches the per-agent cardinality and reuses the existing single-row read.
- **Append-only claim CAS, identical shape to Mem0's extract claim.** New columns `session_messages.learning_afterthought_claimed_at` + `learning_afterthought_completed_at`. Migration comment marks `claimed_at` append-only. v2 retry mechanism uses `learning_afterthought_attempt_id`, not `claimed_at` mutation.
- **Sequenced AFTER Mem0 extract within the same `after()` execution.** Both run on `status='completed'` of a `learning_enabled` agent; both must respect the same time-remaining budget. Sleep Cycle's `triggerSleepAfterthought` is invoked at the same two call sites (`finalizeMessage` + detached-stream upload route) right after `triggerExtract`. The two helpers do NOT share their `after()` callbacks — each registers its own; sequencing inside Sleep Cycle's callback awaits Mem0's extract being committed before reading.
- **Deep sleep is a separate per-minute cron, not a piggyback on the message path.** Independent budget, independent failure surface, independent claim semantics. Mirrors `scheduled-runs` cron structure exactly.
- **`AuditCaller` union extension is a coordinated change with the Mem0 plan.** Add a `'sleep-cycle'` variant with optional `cycle_id`. Coordinate via the shared `DispatchInput` envelope discipline already noted in both plans.
- **No new admin UI surfaces beyond the toggle.** The existing `FileTreeEditor` shows the `learned/` folder automatically once entries appear. v1 ships read-write (operators may want to edit learned skills); locking the folder read-only is fast-follow.
- **Budget formula uses message cost, not session cost.** Origin's R21 says `originating_session_cost × 10%`; concrete v1 implementation is `message.cost_usd × 10%` since the afterthought triggers per-message and using the cumulative session cost would require summing across messages and re-reading the session row. Capped between $0.001 and $0.25 inclusive (matches agent-co Hermes precedent).
- **Soft cap enforcement happens during deep sleep, not afterthought.** Afterthought may push the count temporarily over 50 (one per cycle). Deep sleep is responsible for consolidating/retiring before adding when the count is at or above cap. Hard cap at 60 (over-cap by 10 = afterthought is still allowed; over-cap by 11 = afterthought skips skill writes and emits `learning_skill_cap_exceeded`).
- **`LEARNING_FEATURE_ENABLED` env flag for incremental rollout.** Mirrors Mem0's `MEMORY_FEATURE_ENABLED`. Gates the admin UI toggle until end-to-end verified; removable post-rollout.

---

## Open Questions

### Resolved During Planning

- **Originating session cost formula?** Resolved: use the message's own `cost_usd × 10%`, capped $0.001-$0.25. Avoids a session-row re-read.
- **Where do `next_sleep_at` / `last_sleep_at` live?** Resolved: directly on `agents`; not in the `schedules` table.
- **Skill slug derivation rule?** Resolved: kebab-case of LLM-named title, validated `^[a-z0-9][a-z0-9-]{0,63}$`, collision-check at write time, suffix `-2`, `-3`, ... if collision (within the agent's own learned slugs).
- **`AuditCaller` extension?** Resolved: extend the Mem0 plan's union with a `'sleep-cycle'` variant carrying optional `cycle_id`. Coordinated change.
- **Single `folder: 'learned'` entry vs many `folder: 'learned-<slug>'` entries?** Resolved: single entry. Matches `SkillsSchema`'s folder-uniqueness invariant; one folder containing N files is the natural fit.
- **Read-only learned/ folder in the editor?** Resolved: deferred. v1 ships read-write; revisit if operators report accidental edits.
- **Sleep Cycle observability surface (admin UI vs structured logs)?** Resolved: structured logs only in v1; mirror Mem0 plan's same deferral.
- **`AbortController` budget on the reflection LLM call?** Resolved: yes. 60s budget for afterthought (matches agent-co's `reflection.ts` precedent); 120s budget per agent for deep sleep.

### Deferred to Implementation

- **Exact Zod schema for the structured-output reflection response.** Settle the field shapes when wiring Vercel AI SDK `generateObject`. Likely `{ memories_to_add: Array<{content: string}>, memories_to_retire_ids: string[], skills_to_upsert: Array<{slug: string, title: string, content: string}>, skills_to_retire_slugs: string[] }` — refine against the actual model response shape during implementation.
- **Concrete Haiku-class model id for `LEARNING_AFTERTHOUGHT_MODEL` default.** Pick from AI Gateway catalog at implementation time. Ship with a sensible default (e.g., `claude-haiku-4-5`); tenants override via env.
- **Transcript-window size for deep sleep.** "All transcripts since `last_sleep_at`" can blow the token budget on busy agents. Cap at N most-recent sessions OR token-budget the input. Default to top-20 most-recent sessions in v1; tune in code review against measured shapes.
- **Skill-content sanitization rules.** Hard length cap (2000 chars per skill is the starting point); strip role-shaped prefixes (`System:`, `Assistant:`); escape `<`/`>` to prevent prompt-shape subversion at injection time. Refine during implementation against real generated skills.
- **Deep-sleep cron Slack-emit budget.** When a cycle fails repeatedly, should an alert fire? v1: structured logs only; revisit when alerting infrastructure exists.
- **`MemoryAdapter.list` paging interaction with deep-sleep's "all current entries for this agent" need.** v1 calls `list` in a loop (paged walk) until exhausted, capped at e.g. 500 entries to bound cycle cost. If this is too slow, add a `listAll` variant in the adapter.

---

## Output Structure

```
src/lib/learning/                                # NEW directory
├── reflection.ts                                # Hermes-style prompt builders (afterthought + deep-sleep variants)
├── budget.ts                                    # computeAfterthoughtBudget, getDeepSleepCap
├── model.ts                                     # selectAfterthoughtModel (Haiku vs main)
├── learned-skills.ts                            # atomic JSONB SQL helpers (append/upsert/retire)
├── triggerSleepAfterthought.ts                  # claim CAS + after() wrap (afterthought entry point)
└── runDeepSleepCycle.ts                         # per-agent deep-sleep orchestrator

src/lib/transcript-fetch.ts                      # NEW (general-purpose, not learning-specific)

src/app/api/cron/sleep-cycle/route.ts            # NEW cron route

tests/unit/learning/
├── reflection.test.ts
├── budget.test.ts
├── model.test.ts
├── learned-skills.test.ts
└── triggerSleepAfterthought.test.ts

tests/unit/transcript-fetch.test.ts
tests/integration/learning/
├── learned-skills-jsonb.test.ts
├── afterthought-finalize.test.ts
└── deep-sleep-cron.test.ts

src/db/migrations/<NNN>_sleep_cycle.sql          # NEW migration (number assigned at impl, after Mem0's 035)
```

The per-unit `**Files:**` sections remain authoritative for what each unit creates or modifies.

---

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
                     finalizeMessage / detached-stream-transcript-route
                                          │
                                          │ (status === 'completed' && agent.memory_enabled)
                                          ▼
                          ┌────────────────────────────────┐
                          │  Mem0 triggerExtract           │
                          │  (claim CAS, after() schedule) │
                          └────────────────────────────────┘
                                          │
                                          │ (status === 'completed' && agent.learning_enabled)
                                          ▼
                          ┌────────────────────────────────┐
                          │  triggerSleepAfterthought      │
                          │  (claim CAS via                │
                          │   learning_afterthought_*      │
                          │   columns, time-remaining      │
                          │   guard ≥30s, after() schedule)│
                          └────────────────────────────────┘
                                          │
                                          │   inside after():
                                          ▼
   ┌───────────────────────────────────────────────────────────────────────┐
   │   1. fetch transcript blob → bounded-buffer filter                    │
   │      (transcript-fetch.ts: result/error in, text_delta out)          │
   │   2. await MemoryAdapter.list(tenantId, agentId, {…},                 │
   │        caller: { type: 'sleep-cycle', cycle_id })                    │
   │   3. injection-scan transcript per-message                            │
   │   4. selectAfterthoughtModel(toolCallCount, status, agent.model)     │
   │   5. computeAfterthoughtBudget(message.cost_usd)                     │
   │   6. AI SDK generateObject(reflectionPrompt, schema, abortSignal)     │
   │   7. Apply outputs in one transaction:                                │
   │        a. MemoryAdapter.extract(...)         ← memories_to_add        │
   │        b. MemoryAdapter.delete(id, caller)   ← memories_to_retire_ids │
   │        c. learned-skills.upsertSkill(...)    ← skills_to_upsert       │
   │        d. learned-skills.retireSkill(...)    ← skills_to_retire_slugs │
   │   8. UPDATE session_messages SET                                      │
   │        learning_afterthought_completed_at = now() WHERE id = $1       │
   │   On any error: leave completed_at NULL → operator-visible "lost"    │
   └───────────────────────────────────────────────────────────────────────┘


   /api/cron/sleep-cycle (per-minute, cron-secret auth)
                                          │
                                          ▼
                          ┌────────────────────────────────┐
                          │  Two-step CTE claim:            │
                          │  candidates (FOR UPDATE         │
                          │  SKIP LOCKED LIMIT N) → locked  │
                          │  → UPDATE agents SET            │
                          │      next_sleep_at = <next>,    │
                          │      last_sleep_at = now()      │
                          │    WHERE id = ANY(locked.ids)   │
                          │  All inside one txn.            │
                          └────────────────────────────────┘
                                          │
                                          │ for each claimed agent (sequenced):
                                          ▼
                          runDeepSleepCycle(agent):
                            steps 1-7 above (deeper prompt,
                            top-N transcripts since last_sleep_at,
                            agent's main model, larger budget cap,
                            soft-cap consolidation pass)
```

The reflection LLM output shape (directional, not final):

```typescript
// src/lib/learning/reflection.ts — Zod schema sketch
const ReflectionResponse = z.object({
  memories_to_add: z.array(z.object({ content: z.string().max(500) })).max(5),
  memories_to_retire_ids: z.array(z.string().uuid()).max(10),
  skills_to_upsert: z.array(z.object({
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    title: z.string().max(80),
    content: z.string().max(2000),
  })).max(2),
  skills_to_retire_slugs: z.array(z.string()).max(5),
});
```

---

## Implementation Units

### U1. Database migration: agents columns + session_messages CAS columns + indexes

**Goal:** Provision storage for Sleep Cycle in a single migration. Add per-agent columns to `agents`, add the claim/complete CAS pair to `session_messages`, build the partial index for the cron query.

**Requirements:** R1, R3, R5, R10, R11, R21

**Dependencies:** Mem0 plan U1 (`035_agent_memory.sql`) must already have landed — Sleep Cycle's migration number is the next available after Mem0's.

**Files:**
- Create: `src/db/migrations/<NNN>_sleep_cycle.sql` (number assigned at implementation, after Mem0's 035)

**Approach:**
- `ALTER TABLE agents ADD COLUMN IF NOT EXISTS learning_enabled boolean NOT NULL DEFAULT false;` (Postgres 11+ lazy default — no table rewrite).
- `ALTER TABLE agents ADD COLUMN IF NOT EXISTS next_sleep_at timestamptz NULL;` (NULL until first scheduled).
- `ALTER TABLE agents ADD COLUMN IF NOT EXISTS last_sleep_at timestamptz NULL;`
- `ALTER TABLE agents ADD COLUMN IF NOT EXISTS deep_sleep_cap_usd numeric(10,4) NULL;` (NULL = use platform default $1.00).
- `ALTER TABLE agents ADD COLUMN IF NOT EXISTS deep_sleep_cron text NULL;` (NULL = use default daily 3am tenant-local).
- `ALTER TABLE session_messages ADD COLUMN IF NOT EXISTS learning_afterthought_claimed_at timestamptz NULL;` (with COMMENT marking append-only).
- `ALTER TABLE session_messages ADD COLUMN IF NOT EXISTS learning_afterthought_completed_at timestamptz NULL;`
- Partial index for cron claim query: `CREATE INDEX IF NOT EXISTS idx_agents_due_sleep ON agents (next_sleep_at) WHERE learning_enabled = true;`
- Partial index for lost-attempt sweep (deferred): `CREATE INDEX IF NOT EXISTS idx_session_messages_learning_lost ON session_messages (learning_afterthought_claimed_at) WHERE learning_afterthought_claimed_at IS NOT NULL AND learning_afterthought_completed_at IS NULL;`
- `COMMENT ON COLUMN session_messages.learning_afterthought_claimed_at IS 'Append-only: never mutate after first set. v2 retries use a separate attempt_id column.';`

**Patterns to follow:**
- Mem0 plan U1 (`docs/plans/2026-05-06-003-feat-mem0-memory-primitive-plan.md`) — column additions + partial index shape.
- `ADD COLUMN IF NOT EXISTS` idiom (precedent in `034_workflow_dispatch_columns.sql`).
- Boolean default + partial index pattern from a2a_enabled (CLAUDE.md line 216).

**Test scenarios:**
- *Integration:* `npm run migrate` succeeds against a fresh DB.
- *Integration:* `npm run migrate` succeeds against a DB at the migration immediately preceding Sleep Cycle's.
- *Integration:* After migration, `\d agents` shows the five new columns with correct types and nullability.
- *Integration:* After migration, `\d session_messages` shows the two new CAS columns.
- *Integration:* `EXPLAIN SELECT id FROM agents WHERE learning_enabled = true AND next_sleep_at <= now()` uses the partial index (not a seq scan).
- *Edge case:* Migration is idempotent (run twice, no error).
- *Edge case:* Default value behavior — existing agents have `learning_enabled = false` after migration without table rewrite (verify via `pg_attribute.atthasdef`).

**Verification:**
- `npm run migrate` is green; partial indexes are present and used by the cron query plan; existing rows are unaffected.

---

### U2. Reflection engine module: prompt + model + budget

**Goal:** The pure module that builds Hermes-style reflection prompts, picks the model adaptively, and computes per-cycle budget caps. No DB, no Mem0, no `after()` — testable in isolation.

**Requirements:** R15, R16, R20, R21

**Dependencies:** None.

**Files:**
- Create: `src/lib/learning/reflection.ts`
- Create: `src/lib/learning/budget.ts`
- Create: `src/lib/learning/model.ts`
- Create: `tests/unit/learning/reflection.test.ts`
- Create: `tests/unit/learning/budget.test.ts`
- Create: `tests/unit/learning/model.test.ts`

**Approach:**
- `reflection.ts` exports two builders: `buildAfterthoughtPrompt(transcript, mem0Entries, agent)` and `buildDeepSleepPrompt(transcripts[], mem0Entries, agent, lastSleepAt)`. Both output the system + user message pair the AI SDK needs. The Zod schema for the structured response (`ReflectionResponse`) is co-located here.
- Two buckets only — personal memory (writes to Mem0) + skills (writes to `agents.skills.learned`). The "shared memory" bucket from agent-co's literal Hermes is dropped.
- `budget.ts` exports `computeAfterthoughtBudget(messageCostUsd: number): number` returning `Math.max(0.001, Math.min(0.25, (Number.isFinite(messageCostUsd) ? Math.max(0, messageCostUsd) : 0) * 0.10))` (the `Number.isFinite` guard prevents `NaN` / `undefined` from propagating through the formula and producing an unbounded cap; negatives are floored to 0 before the percentage step) and `getDeepSleepCap(agent: Agent): number` returning `agent.deep_sleep_cap_usd ?? 1.00`.
- `model.ts` exports `selectAfterthoughtModel(toolCallCount: number, runStatus: string, mainModel: string): string`. Failed/error always main; ≥10 tool calls always main; otherwise `LEARNING_AFTERTHOUGHT_MODEL` env (Haiku-class default). Deep sleep always returns `mainModel` directly.
- Use `getEnv()` from `src/lib/env.ts` for env access (Zod-validated).

**Execution note:** Test-first for the prompt builders' output shape and the model-selector branches — both are pure logic with multiple cases and benefit from failing tests first.

**Patterns to follow:**
- `~/code/agent-co/lib/execution/reflection.ts` (read-only reference) — `selectReflectionModel`, `computeReflectionBudget`, `buildBaseReflectionPrompt`.
- `src/lib/soul-generation.ts` for the AI SDK invocation shape (gateway model + abort signal pattern); reflection.ts itself is pure (no fetches).
- `src/lib/env.ts` `getEnv()` for env-var reads.

**Test scenarios:**
- *Happy path (reflection):* `buildAfterthoughtPrompt` with a 3-event transcript and 2 existing memories returns a prompt containing both buckets framed correctly, with the Zod schema describing the expected output shape.
- *Happy path (reflection):* `buildDeepSleepPrompt` with N session transcripts and M memories produces a heavier consolidation prompt distinguishable from the afterthought variant.
- *Edge case (reflection):* Empty transcript / empty memories produces a valid prompt that does not crash the LLM (instructs the model to return empty arrays rather than synthesize fake content).
- *Edge case (reflection):* Truncated transcript with only `result`/`error` events (no `text_delta`, no other event types) is handled — the prompt does not assume `text_delta` is present (institutional learning from `transcript-capture-and-streaming-fixes.md`).
- *Happy path (budget):* `computeAfterthoughtBudget(0.50) === 0.05`. `computeAfterthoughtBudget(0.001) === 0.001` (floor). `computeAfterthoughtBudget(10.0) === 0.25` (cap).
- *Edge case (budget):* `computeAfterthoughtBudget(0)` and `computeAfterthoughtBudget(NaN)` both return `0.001` (floor). Negative returns floor.
- *Happy path (budget):* `getDeepSleepCap(agent)` returns `agent.deep_sleep_cap_usd` when set, else `1.00`.
- *Happy path (model):* `selectAfterthoughtModel(2, 'completed', 'claude-sonnet-4-6')` returns the Haiku-class default (env-driven).
- *Happy path (model):* `selectAfterthoughtModel(15, 'completed', 'claude-sonnet-4-6')` returns `'claude-sonnet-4-6'` (≥10 tool calls).
- *Happy path (model):* `selectAfterthoughtModel(2, 'failed', 'claude-sonnet-4-6')` returns `'claude-sonnet-4-6'` (failed always main).
- *Edge case (model):* `LEARNING_AFTERTHOUGHT_MODEL` env override is respected.

**Verification:**
- All unit tests pass; the module exports are importable from outside `src/lib/learning/`; no DB or fetch dependencies.

---

### U3. Transcript-fetch helper with bounded-buffer allowlist (read-side)

**Goal:** Add a reusable read-side helper for fetching a message's transcript NDJSON from Vercel Blob and filtering it through the bounded-buffer allowlist. First reusable read-side helper — three existing inline callers can migrate later (out of scope for this plan).

**Requirements:** R6, R12, R17

**Dependencies:** None.

**Files:**
- Create: `src/lib/transcript-fetch.ts`
- Create: `tests/unit/transcript-fetch.test.ts`

**Approach:**
- Single exported `fetchMessageTranscript(blobUrl: string, opts?: { signal?: AbortSignal; maxEvents?: number })` returning `Promise<TranscriptEvent[]>`.
- Fetches the NDJSON blob; parses line-by-line; applies the WRITE-side allowlist mirrored from `src/lib/transcript-utils.ts:121-190`: include `result` and `error` events; exclude `text_delta` events from the returned array. Truncation is symmetric — keep first event + last `maxEvents - 1` events with `result`/`error` always preserved.
- Calls the prompt-injection scanner per-message if and when the scanner module is available (graceful import-or-skip — the scanner plan is parallel; Sleep Cycle does not block on it).
- Throws on fetch error; supports `AbortSignal` for the recall-style timeout discipline.

**Execution note:** Test-first for the allowlist filtering — load-bearing institutional learning from `transcript-capture-and-streaming-fixes.md`; benefits from a failing test before code.

**Patterns to follow:**
- `src/lib/transcript-utils.ts:121-190` `captureTranscript` — write-side allowlist (mirror the same rules read-side).
- Three existing inline callers as input shape reference: `src/app/admin/(dashboard)/sessions/[sessionId]/live-session-detail.tsx:100`, `src/app/api/admin/sessions/[sessionId]/messages/[messageId]/stream/route.ts:33`, `src/app/api/sessions/[sessionId]/messages/[messageId]/stream/route.ts:46`.
- `AbortController` + `fetch` with `signal` discipline.

**Test scenarios:**
- *Happy path:* NDJSON with 5 events including 1 `result` and 1 `error` returns all 5, in order. **Covers F1, F2 transcript-input contract.**
- *Edge case (allowlist):* NDJSON with 1000 events including 50 `text_delta`s returns 950 events (no `text_delta`). **Covers institutional learning.**
- *Edge case (allowlist):* NDJSON with 5000 events truncated to 1000 keeps all `result`/`error` events past the cap.
- *Edge case (empty):* Empty blob returns empty array.
- *Edge case (malformed):* Non-JSON line in the middle is skipped without throwing.
- *Error path:* 404 on fetch throws with a clear error.
- *Error path:* `AbortSignal` cancellation aborts the fetch and throws AbortError.
- *Integration with scanner (when available):* Each message body is passed to the scanner; redacted content has `_injection_flagged: true`.

**Verification:**
- Unit tests pass; the helper is callable from outside the learning module; existing inline callers can later migrate to it without behavior change.

---

### U4. Learned-skills JSONB helper (atomic SQL operations)

**Goal:** Provide atomic SQL helpers for mutating `agents.skills` JSONB under the `folder: 'learned'` entry. NEVER read-then-write in JS — every write is one SQL UPDATE inside `withTenantTransaction`.

**Requirements:** R7, R13

**Dependencies:** U1 (no schema dependency, but `learning_enabled` must exist for callers to gate on it).

**Files:**
- Create: `src/lib/learning/learned-skills.ts`
- Create: `tests/unit/learning/learned-skills.test.ts`
- Create: `tests/integration/learning/learned-skills-jsonb.test.ts`

**Approach:**
- Exported helpers, all required to take `TenantId` and `AgentId`:
  - `upsertLearnedSkill(tenantId, agentId, slug, title, content)` — single SQL UPDATE that either appends a new file under the `learned/` folder OR replaces an existing file by path. CTE structure: extract the `learned` folder entry; build the new files array via `jsonb_agg(CASE WHEN path = $1 THEN new_file ELSE existing END)` plus an `EXISTS` check to decide append vs upsert; reassemble the full skills array.
  - `retireLearnedSkills(tenantId, agentId, slugs[])` — single SQL UPDATE that removes files from the `learned/` folder entry where `path IN (slugs)` (with `<slug>.md` mapping); never touches the folder entry itself.
  - `consolidateLearnedSkills(tenantId, agentId, retire_slugs[], upsert_skills[])` — single combined UPDATE that retires and upserts atomically; used by deep sleep when at soft cap.
  - `countLearnedSkills(tenantId, agentId)` — read-only helper using `jsonb_array_length` on the `learned/` folder's files.
- Soft cap (50) is enforced at the SQL level via a precondition on the `learned/` folder's `files` array length specifically — NOT on the outer skills/folders array. Concretely: `WHERE jsonb_array_length(COALESCE((SELECT value->'files' FROM jsonb_array_elements(skills) WHERE value->>'folder' = 'learned' LIMIT 1), '[]'::jsonb)) < 60` (hard cap = soft cap + buffer of 10). When the precondition fails, the UPDATE returns 0 rows and the caller emits `learning_skill_cap_exceeded`. Manual user-authored skill folders are unaffected by the cap.
- File path shape: `<slug>.md`. Content stored as a single Markdown blob (the LLM's title + body).

**Execution note:** Test-first for the atomic upsert and the cap precondition — both are race-prone and benefit from failing tests before code.

**Patterns to follow:**
- `src/lib/connection-metadata.ts` — JSONB merge helpers (per CLAUDE.md line 158).
- CLAUDE.md line 308 — atomic JSONB SQL guards.
- `docs/plans/2026-03-01-feat-sdk-full-resource-management-plan.md` lines 117-156 — `skills || $1::jsonb` + `NOT EXISTS` + `jsonb_array_length` cap pattern.
- `src/db/index.ts` `withTenantTransaction` for all SQL.

**Test scenarios:**
- *Happy path (upsert append):* New slug `find-deals` produces a single new file under the `learned/` folder; the existing folders array is unchanged.
- *Happy path (upsert replace):* Existing slug `find-deals` updates the file's content in place; `files` array length unchanged.
- *Edge case (folder doesn't exist yet):* First upsert when no `learned/` folder exists creates it with the new file as its only entry.
- *Edge case (other folders preserved):* Upsert into `learned/` does not modify any other folder entry.
- *Happy path (retire):* `retireLearnedSkills(['find-deals'])` removes the file; folder entry persists (may be empty).
- *Edge case (retire missing):* Retiring a slug that doesn't exist is a no-op (no error).
- *Happy path (consolidate):* Combined retire + upsert in one call; both effects atomic — partial application not observable.
- *Cap precondition (hard cap):* Upsert when `learned/` already has 60 files returns 0 rows; caller observes failure; emits `learning_skill_cap_exceeded`.
- *Soft cap signal:* Upsert when `learned/` has 50-59 files succeeds; caller can observe count via `countLearnedSkills` and trigger consolidation in the next deep-sleep cycle.
- *Concurrent write race (integration):* Two concurrent `upsertLearnedSkill` calls for different slugs both succeed; final state has both files. Two concurrent calls for the same slug both succeed; final state has the later writer's content (last-write-wins is acceptable for v1; document).
- *Cross-tenant isolation (integration):* `upsertLearnedSkill` for tenant A does not touch tenant B's `learned/` folder; cross-tenant integration test exercises full path.
- *Slug validation:* Slug not matching `^[a-z0-9][a-z0-9-]{0,63}$` is rejected at the helper boundary; SQL is never called.

**Verification:**
- All scenarios pass; the integration test verifies real Postgres atomic behavior; no JSONB writes via JS read-modify-write anywhere in the module.

---

### U5. AuditCaller union extension (coordinated with Mem0 plan)

**Goal:** Extend the Mem0 plan's `AuditCaller` union with a `'sleep-cycle'` variant carrying optional `cycle_id`. Coordinated change documented in both plans.

**Requirements:** R22

**Dependencies:** Mem0 plan U3 (the `MemoryAdapter` interface and `AuditCaller` type must exist).

**Files:**
- Modify: `src/lib/memory/adapter.ts` (file created by Mem0 plan U3) — extend `AuditCaller` union.
- Modify: `src/lib/memory/types.ts` (file created by Mem0 plan U3) — re-export the extended type if applicable.
- Create: `tests/unit/memory/auditcaller-sleep-cycle.test.ts`

**Approach:**
- Existing union (per Mem0 plan): `type AuditCaller = { type: 'http' | 'cli' | 'system'; identity?: string }`.
- Extended: `type AuditCaller = { type: 'http' | 'cli' | 'system'; identity?: string } | { type: 'sleep-cycle'; cycle_id: string; identity?: string }`.
- Mem0 plan's audit-emission path inside `MemoryAdapter` already serializes the entire `caller` object; the variant's `cycle_id` field appears automatically in audit logs.
- No behavior change for non-sleep-cycle callers.

**Patterns to follow:**
- Mem0 plan U6 (admin endpoints) — example of the existing `caller: { type: 'http', identity: adminIdentity }` shape.

**Test scenarios:**
- *Happy path:* `MemoryAdapter.delete(tenantId, agentId, memoryId, { type: 'sleep-cycle', cycle_id: 'cyc-abc' })` succeeds; audit event payload contains `cycle_id`.
- *Type safety (compile-time):* Building a `caller` without required fields fails type-check (verified via test that does NOT compile).
- *Backward compat:* Existing `{ type: 'http', identity: ... }` callers continue to work unchanged.

**Verification:**
- Mem0 plan tests still pass; the new variant is callable; audit events include `cycle_id` when present.

---

### U6. Afterthought helper + dispatcher wiring + transcript-route wiring

**Goal:** Wire `triggerSleepAfterthought` at both post-finalize call sites, sequenced after Mem0's `triggerExtract`, with claim/complete CAS, time-remaining guard, and `after()` wrapping.

**Requirements:** R4, R5, R6, R7, R8, R9, R10, R17, R18, R19, R20, R22, R23

**Dependencies:** U1, U2, U3, U4, U5; Mem0 plan U5 (so `triggerExtract` exists at both call sites).

**Files:**
- Create: `src/lib/learning/triggerSleepAfterthought.ts`
- Modify: `src/lib/dispatcher.ts` — `finalizeMessage` calls `triggerSleepAfterthought` after `triggerExtract`.
- Modify: `src/app/api/internal/messages/[messageId]/transcript/route.ts` — second call site after `triggerExtract`.
- Modify: `src/app/api/sessions/[sessionId]/messages/route.ts` — confirm `maxDuration = 600` (Mem0 plan U5 already bumps; this unit verifies and adds a comment if missing).
- Create: `tests/unit/learning/triggerSleepAfterthought.test.ts`
- Create: `tests/integration/learning/afterthought-finalize.test.ts`

**Approach:**
- Helper signature: `triggerSleepAfterthought(message, agent, tenantId, routeStart)`. Pre-CAS gates evaluated in this order, ALL must pass before the claim CAS fires (no row consumed on a no-op): `getEnv().LEARNING_FEATURE_ENABLED === true`; `agent.learning_enabled === true`; `agent.memory_enabled === true` (Sleep Cycle is a no-op without memory; emit `learning_skipped_memory_disabled` when this gate fails); `message.status === 'completed'`; time-remaining guard via `(maxDuration*1000) - (Date.now() - routeStart) >= 30000`. Only after all five gates pass does the helper attempt the CAS.
- Atomic claim CAS: `UPDATE session_messages SET learning_afterthought_claimed_at = now() WHERE id = $1 AND learning_afterthought_claimed_at IS NULL RETURNING id`. Loser observes 0 rows and returns silently.
- Inside `after()`:
  1. Fetch transcript via `fetchMessageTranscript(message.transcript_blob_url, { signal })`.
  2. List Mem0 entries: `MemoryAdapter.list(tenantId, agent.id, { limit: 100, offset: 0 }, { type: 'sleep-cycle', cycle_id })`.
  3. Build prompt via `buildAfterthoughtPrompt(transcript, mem0Entries, agent)`.
  4. Pick model via `selectAfterthoughtModel(toolCallCount, message.status, agent.model)`.
  5. Compute budget cap via `computeAfterthoughtBudget(message.cost_usd)`.
  6. Call AI Gateway via `generateObject` with the Zod schema, `AbortSignal.timeout(60_000)`, max-cost enforced via cost-tracking on the response.
  7. Apply outputs: `MemoryAdapter.extract` for adds; `MemoryAdapter.delete` (with sleep-cycle caller) for retires; `upsertLearnedSkill` per upsert; `retireLearnedSkills` for retires.
  8. `UPDATE session_messages SET learning_afterthought_completed_at = now() WHERE id = $1`.
  9. On any error in steps 1-7: log `learning_afterthought_failed` with error context; do NOT set `completed_at` (operator-visible "lost" state via the partial index from U1).
- Sequencing relative to Mem0: each call site invokes `triggerExtract` first (existing), then `triggerSleepAfterthought` second. Each registers its own `after()` callback. Sleep Cycle's callback awaits Mem0's extract being committed by reading Mem0 entries fresh inside the callback (step 2 above).

**Execution note:** Test-first for the claim CAS, the cross-call-site idempotency, the time-remaining guard, and the cancel/timeout/fail skip — these are the load-bearing failure modes (mirrors Mem0 plan U5 execution note).

**Patterns to follow:**
- Mem0 plan U5 `triggerExtract` (`src/lib/memory/triggerExtract.ts`) — exact CAS + `after()` shape.
- `src/app/api/webhooks/[sourceId]/route.ts` — `import { after } from "next/server"` precedent.
- `src/lib/soul-generation.ts:193` `callGateway()` — abort + bounded timeout.

**Test scenarios:**
- *Happy path (AE2):* `learning_enabled = true`, `memory_enabled = true`, message `completed` — afterthought claims, runs in `after()`, writes new Mem0 entries (visible via `MemoryAdapter.list`) and at least one new learned skill (visible at `agents.skills.learned`). `learning_afterthought_completed_at` set. **Covers AE2.**
- *Disabled state (AE1):* `learning_enabled = false` — adapter/learning helpers never called; `learning_afterthought_claimed_at` is NULL after the message; `agents.skills` unchanged from baseline. **Covers AE1.**
- *Disabled state — bit-identical:* System prompt for the next message of a `learning_enabled = false` agent is bit-identical to today's baseline (snapshot test).
- *Claim CAS race (AE3):* Concurrent `triggerSleepAfterthought` calls from both call sites for the same message — exactly one `after()` callback fires; `learning_afterthought_claimed_at` set once; second call's CAS returns 0 rows. **Covers AE3.**
- *Claim survives crash (semantic):* After-claim crash leaves `claimed_at` set, `completed_at` NULL — operator-visible "lost" state observable via the partial index.
- *Time-remaining skip (AE5):* Mock <30s remaining — `triggerSleepAfterthought` returns without claiming; `learning_afterthought_skipped_no_time_budget` event logged; CAS columns untouched. **Covers AE5.**
- *Cancel/timeout/fail skip (AE6):* Status `cancelled` / `timed_out` / `failed` — `triggerSleepAfterthought` returns without claiming. **Covers AE6.**
- *Failure non-fatal (AE8):* Adapter or `generateObject` throws — `learning_afterthought_failed` logged; `completed_at` NULL; message billing/status unchanged; next message dispatches normally. **Covers AE8 partial.**
- *Sequencing with Mem0:* In a single message's `after()` execution, Mem0's `triggerExtract` commits memories before Sleep Cycle's `MemoryAdapter.list` reads them — verify via integration test that Sleep Cycle sees Mem0's just-extracted memories.
- *Detached-stream parity:* Internal transcript-upload route also calls `triggerSleepAfterthought` after `triggerExtract`; same CAS path; same sequencing.
- *Audit caller propagation:* Every `MemoryAdapter` call from the helper passes `{ type: 'sleep-cycle', cycle_id }`; audit event payloads include `cycle_id`. **Covers AE4 partial via audit emission.**
- *Bounded-buffer transcript:* `messageContext` passed to the prompt builder excludes `text_delta` events even when the transcript blob is large.
- *Skill cap exceeded:* When the agent already has 60 learned skills, `upsertLearnedSkill` returns 0 rows; helper logs `learning_skill_cap_exceeded`; afterthought continues without aborting (memories may still be written).
- *AE10 (no sandbox surface):* Verify the agent's runtime sandbox sees no new MCP tool, no new network endpoint, and no new file injection (snapshot diff of the runner's spawned config). **Covers AE10.**

**Verification:**
- All scenarios pass; existing dispatcher tests do not regress; `learning_enabled = false` agents produce a system prompt and `agents.skills` value bit-identical to pre-change.

---

### U7. Deep-sleep cron route + per-agent orchestrator

**Goal:** Per-minute cron at `/api/cron/sleep-cycle` that claims due agents (`FOR UPDATE SKIP LOCKED`), advances `next_sleep_at` inside the same transaction, and runs the deep-sleep prompt per agent. Independent of the message path's `after()` budget.

**Requirements:** R3, R11, R12, R13, R14, R16, R17, R20, R22, R23

**Dependencies:** U1, U2, U3, U4, U5; Mem0 plan U3 (so `MemoryAdapter` exists).

**Files:**
- Create: `src/app/api/cron/sleep-cycle/route.ts`
- Create: `src/lib/learning/runDeepSleepCycle.ts`
- Modify: `vercel.json` — add `{ "path": "/api/cron/sleep-cycle", "schedule": "* * * * *" }`.
- Create: `tests/integration/learning/deep-sleep-cron.test.ts`

**Approach:**
- Route handler in `route.ts`: cron-secret auth via existing `src/lib/cron-auth.ts`; checks `getEnv().LEARNING_FEATURE_ENABLED === true` immediately after auth and short-circuits with a `200` + `feature_disabled` log otherwise (defense in depth — the helper checks too, but the cron route gating prevents wasted DB claims when the platform flag is off); declares `export const maxDuration = 600;` for headroom; per-tick claim batch size = 50 agents.
- Two-step CTE claim mirroring `scheduled-runs`:
  1. `WITH candidates AS (SELECT id FROM agents WHERE learning_enabled = true AND next_sleep_at <= now() ORDER BY next_sleep_at ASC LIMIT 50 FOR UPDATE SKIP LOCKED)` — uses the partial index from U1.
  2. `UPDATE agents SET last_sleep_at = now(), next_sleep_at = <computed-next> WHERE id = ANY(SELECT id FROM candidates) RETURNING ...`.
- `next_sleep_at` computation: per-agent `deep_sleep_cron` (default daily at tenant-local 3am via `tenants.timezone` + `croner`).
- Per-claimed-agent processing (sequenced, not parallel — bounded blast radius):
  1. Generate `cycle_id` (uuid).
  2. Fetch top-N most-recent transcripts since `last_sleep_at` (default N=20, configurable).
  3. List Mem0 entries via paged walk capped at 500 entries.
  4. Build prompt via `buildDeepSleepPrompt`.
  5. Call AI Gateway with the agent's main model, `AbortSignal.timeout(120_000)`, budget cap from `getDeepSleepCap(agent)`.
  6. Apply outputs same as afterthought, in this order to prevent same-cycle retire-then-add inconsistency: (a) `MemoryAdapter.delete` for `memories_to_retire_ids`; (b) `MemoryAdapter.extract` for `memories_to_add`; (c) `retireLearnedSkills` for `skills_to_retire_slugs`; (d) `upsertLearnedSkill` per `skills_to_upsert`. Retires happen before adds so the LLM cannot retire a slug it just added in the same cycle.
  7. If at soft cap (≥50 skills) before applying, prompt instructs the LLM to consolidate before adding; helper enforces hard cap at 60.
  8. Emit `deep_sleep_completed` with per-cycle counts.
- Failure handling: per-agent try/catch; on error, emit `deep_sleep_failed` with cycle_id + error context; `next_sleep_at` already advanced (mirrors `scheduled-runs` "missed cycle" semantics); next tick is unaffected.
- Budget overrun: if per-agent cost-tracking exceeds the cap mid-cycle, emit `deep_sleep_budget_exceeded` and stop early without rolling back partial writes.

**Execution note:** Test-first for the claim semantics, the `next_sleep_at` advance, and the per-agent failure-isolation — these are the load-bearing cron behaviors (mirrors `scheduled-runs` precedent).

**Patterns to follow:**
- `src/app/api/cron/scheduled-runs/route.ts:71-110` — exact CTE claim shape.
- `src/lib/cron-auth.ts` — secret verification.
- Mem0 plan U7 (`/api/cron/purge-memories`) — cron-route structure including `vercel.json` registration.
- `src/lib/schedule.ts` — `croner` timezone-aware scheduling.

**Test scenarios:**
- *Happy path (AE9):* Tenant `timezone = 'America/Los_Angeles'`, agent at default schedule — cron picks up the agent within one minute of 3am Pacific on each calendar day; `next_sleep_at` advances to next day's 3am Pacific. **Covers AE9.**
- *Claim semantics:* Two parallel cron ticks claim non-overlapping batches via `SKIP LOCKED`; no agent claimed twice in the same window.
- *Empty case:* No due agents — cron returns success with zero claimed.
- *Cron auth:* Request without cron secret returns 401.
- *Soft-cap consolidation (AE7):* Agent with 50 learned skills before cycle — deep sleep retires/consolidates before adding; post-cycle count ≤ 50 + cycle's net adds. **Covers AE7.**
- *Hard-cap clamp:* Agent with 60 learned skills — `upsertLearnedSkill` cap precondition fires; new skills not added; `learning_skill_cap_exceeded` logged; cycle still completes (memories still written).
- *Per-agent failure isolation:* Agent A's cycle throws; Agent B's cycle (same tick) completes successfully.
- *Mem0 mutation audit (AE4):* Retired Mem0 entry has caller-tagged audit event with `cycle_id`. **Covers AE4.**
- *Budget overrun:* Mock per-agent cost exceeding cap mid-cycle — `deep_sleep_budget_exceeded` logged; partial writes preserved; `next_sleep_at` already advanced.
- *Failure non-fatal (AE8):* Cycle throws — `deep_sleep_failed` logged; `next_sleep_at` rolled forward; subsequent cron tick unaffected. **Covers AE8.**
- *Tenant-local 3am respect:* Tenants in different timezones get different `next_sleep_at` values for the same logical "next 3am".
- *Bounded transcript window:* Agent with 100 sessions since last cycle — only top-20 read (default cap); subsequent cycle picks up where this left off via `last_sleep_at`.

**Verification:**
- All scenarios pass; cron metrics show expected per-tick claim counts; `deep_sleep_*` events appear in logs with correct shape; `vercel.json` cron entry is present.

---

### U8. Admin UI toggle + types + Zod schema

**Goal:** Surface the `learning_enabled` toggle in the admin UI and update Zod schemas so the field actually round-trips. Lands LAST — does not expose the toggle until U6 + U7 are verified in production. Gated by `LEARNING_FEATURE_ENABLED` env if shipping before verification.

**Requirements:** R1, R3, R23

**Dependencies:** U1, U2, U3, U4, U5, U6, U7.

**Files:**
- Modify: `src/app/admin/(dashboard)/agents/[agentId]/edit-form.tsx` — add `learningEnabled` boolean control; styled like the existing `a2aEnabled` / `memoryEnabled` toggles.
- Modify: `src/app/api/admin/agents/[agentId]/route.ts` — extend `fieldMap` (line ~104-129) with `["learning_enabled", "learning_enabled"]`.
- Modify: `src/lib/types.ts` — add `learning_enabled: boolean`, `next_sleep_at: Date | null`, `last_sleep_at: Date | null`, `deep_sleep_cap_usd: number | null`, `deep_sleep_cron: string | null` to the `Agent` type.
- Modify: `src/lib/validation.ts` — extend BOTH `AgentRowInternal` AND `AgentRow` Zod schemas with the new fields (per institutional learning — both must be updated).
- Create: `tests/integration/admin-learning-toggle.test.ts`

**Approach:**
- Toggle is the only UI surface in v1. No agent-list badge. No deep-sleep schedule editor. No learned-skills observability widget.
- `LEARNING_FEATURE_ENABLED` env flag (default `false` in production until U6 + U7 verified) hides the toggle until the gate is opened.
- Skill editor (`FileTreeEditor`) shows `learned/` folder automatically once entries appear — no editor code change needed.
- Documentation note: edits to learned skills via the existing skill editor round-trip through `SkillsSchema` validation; deferred work to make `learned/` read-only.

**Patterns to follow:**
- `src/app/admin/(dashboard)/agents/[agentId]/a2a-info-section.tsx:44` — toggle PATCH precedent.
- Mem0 plan U6 — the `memory_enabled` toggle adjacent to this one in the edit form.
- `src/lib/validation.ts` existing `AgentRow*` schemas — both must be updated.

**Test scenarios:**
- *Happy path (toggle):* PATCH `{ learning_enabled: true }` to the admin agent route persists and reloads to `true`.
- *Default state:* New agents created with `learning_enabled = false`.
- *Zod round-trip:* `queryOne(...)` for an agent with `learning_enabled = true` returns the field as `true` (NOT undefined — verifies BOTH schemas were updated).
- *Field map admin coverage:* PATCH for any of `next_sleep_at` / `deep_sleep_cap_usd` / `deep_sleep_cron` is rejected (these are platform-managed, not editable via the agent admin route in v1).
- *Feature gate:* When `LEARNING_FEATURE_ENABLED = false`, the toggle is hidden in the UI; PATCH still works (no UI-only gate).
- *Cross-tenant isolation:* Admin endpoint scoped to tenant A cannot toggle tenant B's agent.
- *Admin auth required:* Unauthenticated request returns 401.

**Verification:**
- Manual smoke: toggle in UI; verify network call; reload; verify state persisted. `learned/` folder shows up in skill editor when learned skills exist.

---

## System-Wide Impact

- **Interaction graph:** post-finalize path gains a second `after()` registration (sequenced after Mem0's). New per-minute cron route. No changes to recall, runner spawn, or sandbox materialization. Agents with `learning_enabled = false` are bit-identical to today.
- **Function `maxDuration`:** session-message + internal transcript-upload routes already at 600s (Mem0 plan U5 bumped them); this plan does not bump further. New `/api/cron/sleep-cycle` route declares `maxDuration = 600`.
- **Active CPU billing:** Sleep Cycle's `after()` LLM calls are billed against the originating route's active CPU (matches Mem0's posture). Deep-sleep cron is its own route — billing is per-cron-invocation.
- **Error propagation:** Sleep Cycle failures never affect message outcomes. Recall + extract + afterthought + deep sleep all degrade gracefully.
- **State lifecycle:** new columns owned by both agent and tenant; `agents` cascades on tenant delete (existing behavior). `session_messages.learning_afterthought_*` columns cascade with the parent message. `agents.skills` mutations are atomic; concurrent writes serialize at the row.
- **API surface parity:** no public REST changes. Admin agent route gains `learning_enabled` field; new admin-internal route `/api/cron/sleep-cycle`.
- **Integration coverage:** the bounded-buffer transcript allowlist is exercised by U3's tests and U6's integration test. Cross-tenant isolation, cron claim semantics, and JSONB atomic writes are integration tests.
- **Unchanged invariants:** `dispatchOrWorkflowDispatch` is unchanged. `MemoryAdapter.recall` is unchanged. The existing skill-injection path is unchanged. The sandbox network allowlist is unchanged. Both runners' system-prompt composition is unchanged (Sleep Cycle's output flows through existing primitives). `prependIdentity` / `prependMemory` / skill registry behavior is unchanged.
- **Encryption-at-rest pattern:** Mem0's `agent_memories` content remains encrypted (Mem0 plan); learned skills land in plaintext `agents.skills` JSONB consistent with how manual skills land today. Documented as a deliberate v1 difference.

---

## Risks & Dependencies

| Risk | Mitigation |
|---|---|
| Mem0 plan not yet shipped — `MemoryAdapter` interface and migrations don't exist | U1 + U5 + U6 + U7 hard-block on Mem0 plan U6 + U7 being live in production. Plan documents the dependency at the unit level and in the Summary. |
| Mem0 plan switches to "port extraction prompts" fallback (U0 spike fail) | Sleep Cycle is unchanged because it talks to `MemoryAdapter`, not Mem0 directly. The interface is the swap point. |
| Prompt-injection scanner not yet shipped | U3 imports the scanner with graceful fallback (skip if module not present). Document the gap window per Mem0's posture; accept v1 ships with reduced scanning until scanner lands. |
| `AuditCaller` extension breaks Mem0 plan tests | U5 adds the variant additively; existing callers unchanged. Coordination via shared `DispatchInput` envelope discipline. |
| Sleep Cycle competes with Mem0 extract for `after()` budget on long sessions | Both share the route's 600s `maxDuration`. Each has its own time-remaining guard. Mem0 runs first (committed by Sleep Cycle's start); Sleep Cycle runs second with whatever budget remains. Worst case: Sleep Cycle skips with `learning_afterthought_skipped_no_time_budget` — observable, not silent. |
| Skill-content size bloat into `agents.skills` JSONB blowing row size | Soft cap (50 skills) + per-skill content cap (2000 chars) bounds total to ~100KB per agent. Postgres TOAST handles JSONB rows of this size cleanly. Monitor row-size distribution post-launch. |
| Atomic JSONB UPDATE conflicts with concurrent admin skill editor saves | Both paths run inside `withTenantTransaction`; row-level locks serialize the UPDATEs. Last-write-wins on concurrent slug updates is acceptable for v1 — document. |
| Cron tick claims an agent whose deep sleep has been running for ≥1 min | Per-agent processing is sequenced (not parallel); per-tick batch is 50; total tick budget is 600s. If an agent's cycle exceeds 12s average, the tick can hit the wall. Mitigation: per-agent `AbortSignal.timeout(120_000)`; cycles that hit the budget emit `deep_sleep_budget_exceeded` and stop. |
| Reflection LLM hallucinates retired memory IDs that don't exist | `MemoryAdapter.delete` for a non-existent ID is a no-op (per Mem0 plan); audit event still fires with `cycle_id`; no harm. Document. |
| Soft-cap consolidation prompt fails to actually retire skills | Hard cap at 60 prevents unbounded growth. If consolidation systematically fails, learned skills stop landing once cap is hit — observable via `learning_skill_cap_exceeded` events. Operators can manually retire via the existing skill editor. |
| Vercel function cold-start delays cron tick beyond 1 minute | `next_sleep_at <= now()` query naturally catches up — claimed agents at the next successful tick have `next_sleep_at` in the past. Mirrors `scheduled-runs` behavior. |
| Hidden coupling — `learning_enabled = true` on an agent with `memory_enabled = false` | Sleep Cycle no-ops gracefully (Mem0 reads return empty; mutations target a non-existent table or are filtered). Document the soft requirement; emit `learning_skipped_memory_disabled` event at the helper boundary so operators can detect the misconfiguration. |
| Active CPU billing visibility — Sleep Cycle costs hidden inside originating route | Same posture as Mem0 plan; v1 observability via Vercel function metrics only. WDK promotion (deferred) moves billing to a separate function. |

---

## Documentation / Operational Notes

- `CLAUDE.md` agent-table column list needs `learning_enabled`, `next_sleep_at`, `last_sleep_at`, `deep_sleep_cap_usd`, `deep_sleep_cron` added to the agents enumeration. `session_messages` enumeration needs `learning_afterthought_claimed_at` + `learning_afterthought_completed_at`.
- `CLAUDE.md` "Patterns & Conventions" section needs an entry for the Sleep Cycle layer: "Sleep Cycle (`src/lib/learning/`): per-agent learning layer above Mem0. Two firing modes — afterthought after `triggerExtract` in `finalizeMessage` + detached-stream upload route; deep sleep via `/api/cron/sleep-cycle` per-minute cron. Reads transcripts (via `transcript-fetch.ts`) + Mem0 entries; writes Mem0 mutations (via `MemoryAdapter`) + learned skills (`agents.skills` under `folder: 'learned'`). Per-agent flag `learning_enabled`, separate from `memory_enabled`."
- `CLAUDE.md` Environment Variables table needs `LEARNING_AFTERTHOUGHT_MODEL`, `LEARNING_DEEP_SLEEP_MODEL`, `LEARNING_FEATURE_ENABLED`.
- `CLAUDE.md` should NOTE that the schedules cutover (migration 013) was NOT applied to Sleep Cycle's `next_sleep_at` columns — they live directly on `agents` because Sleep Cycle is single-cadence per agent. This avoids future confusion.
- After Sleep Cycle has run cleanly in production for ~2 weeks, write an institutional learning to `docs/solutions/` capturing the layered-on-Mem0 + claim/complete CAS reuse + atomic JSONB mutation pattern for future per-agent learning additions.
- **Deploy-coordination with Mem0 plan:** Sleep Cycle merges to main only after Mem0 plan U6 + U7 are verified in production. The `LEARNING_FEATURE_ENABLED` env defaults to `false` until verification.
- **Operator-facing release note:** Sleep Cycle is fully opt-in per agent. Agents with `learning_enabled = false` see no change in latency, prompt content, cost, or skill set. Enabling Sleep Cycle on an agent without Mem0 enabled is a no-op (logged). Learned skills appear in the skill editor under a `learned/` folder; operators may edit or delete them.
- **Lost-attempt sweep:** the `learning_afterthought_lost` event is emitted by a deferred sweep query (mirrors Mem0's deferred lost-extract sweep). Both sweeps should ship as a single combined sweep job in a follow-up.

---

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-06-sleep-cycle-hermes-requirements.md](docs/brainstorms/2026-05-06-sleep-cycle-hermes-requirements.md)
- **Parent plan:** [docs/plans/2026-05-06-003-feat-mem0-memory-primitive-plan.md](docs/plans/2026-05-06-003-feat-mem0-memory-primitive-plan.md)
- **Concurrent plan (DispatchInput / scanner coordination):** [docs/plans/2026-05-06-002-feat-prompt-injection-scanner-plan.md](docs/plans/2026-05-06-002-feat-prompt-injection-scanner-plan.md)
- Schedule-cron precedent: [src/app/api/cron/scheduled-runs/route.ts](src/app/api/cron/scheduled-runs/route.ts)
- Bounded-buffer learning: [docs/solutions/logic-errors/transcript-capture-and-streaming-fixes.md](docs/solutions/logic-errors/transcript-capture-and-streaming-fixes.md)
- JSONB atomic mutation precedent: [docs/plans/2026-03-01-feat-sdk-full-resource-management-plan.md](docs/plans/2026-03-01-feat-sdk-full-resource-management-plan.md)
- Schedules cutover: [src/db/migrations/013_schedules_table.sql](src/db/migrations/013_schedules_table.sql)
- Skill JSONB shape: [src/db/migrations/004_add_agent_skills.sql](src/db/migrations/004_add_agent_skills.sql)
- Sandbox skill materialization: `src/lib/sandbox.ts:300-311`, `src/lib/sandbox.ts:1071-1078`
- AI SDK skill registry: `src/lib/runners/vercel-ai-runner.ts:29-110`, `src/lib/runners/vercel-ai-shared.ts:81-110`
- Reference prompt shape (read-only external repo): `~/code/agent-co/lib/execution/reflection.ts`
- A2A flag precedent (Zod schema discipline): [docs/plans/2026-03-10-001-feat-a2a-protocol-integration-plan.md](docs/plans/2026-03-10-001-feat-a2a-protocol-integration-plan.md)
