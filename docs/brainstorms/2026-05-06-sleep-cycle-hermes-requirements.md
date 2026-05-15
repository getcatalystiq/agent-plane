---
date: 2026-05-06
topic: sleep-cycle-hermes
---

# Sleep Cycle: Hermes-style learning layer above Mem0

## Summary

Per-agent learning layer above the Mem0 memory primitive: after each session and again on a daily schedule, a Hermes-style reflection prompt reads the agent's transcripts plus existing Mem0 entries and writes back two artifacts — refined memories (consolidated and retired in Mem0 via `MemoryAdapter`) and named procedural skills (added to `agents.skills` under `folder: 'learned'`). Per-agent only for v1; opted in via a separate `learning_enabled` flag distinct from Mem0's `memory_enabled`.

---

## Problem Frame

The Mem0 plan (`docs/plans/2026-05-06-003-feat-mem0-memory-primitive-plan.md`) gives an agent per-message memory: facts, preferences, and task state extracted automatically as the conversation proceeds. It explicitly does not cover skills (the third Hermes bucket — reusable procedural approaches), cross-session consolidation (Anthropic-Dreaming-style merging of duplicates and retirement of stale entries), or any across-session learning trigger.

As a result, an agent that runs many sessions accumulates Mem0 entries linearly, never noticing that two different sessions taught it the same thing twice, never distilling repeated procedural exploration into a named skill, and never benefiting from a quiet moment to reflect on its accumulated experience. A coding agent re-explores the same files on every cold start despite Mem0 happily extracting "uses Postgres" facts. A triage agent learns the same workflow shape three times without ever crystallizing it into something callable. A scheduled ops agent's runs get noisier over time as Mem0 entries multiply without consolidation.

The pain is not that memory is missing — it is that the memory layer cannot promote experience into reusable form, and has no scheduled cycle to clean up after itself. Anthropic's Managed Agents shipped "Dreaming" (April 2026 public-beta research preview) for exactly this; agent-co's `lib/execution/reflection.ts` does it in their orchestrator. AgentPlane has no equivalent today.

---

## Actors

- A1. **Agent author** — tenant user who flips `learning_enabled` per agent in the admin UI, reviews learned skills via the existing skill editor, and can soft-delete a learned memory via Mem0's admin endpoints.
- A2. **Agent (runtime)** — has no awareness of Sleep Cycle. Consumes consolidated memories via the existing memory recall path and learned skills via the existing skill-injection path. Does not call Sleep Cycle tools.
- A3. **Platform dispatcher** — `dispatchOrWorkflowDispatch` (recall, unchanged from Mem0); `finalizeMessage` and the detached-stream transcript route (where afterthought wires).
- A4. **Sleep Cycle** — the new learning subsystem. Two firing modes: afterthought (per-session, post-finalize) and deep sleep (cron, per-agent, scheduled). Reads transcripts + Mem0 entries; writes skills + Mem0 mutations; emits structured audit events.
- A5. **Memory backend** — Mem0 OSS via the `MemoryAdapter` interface from the Mem0 plan. Sleep Cycle writes through this interface, not directly to `agent_memories`.

---

## Key Flows

- F1. **Afterthought (per-session, post-finalize)**
  - **Trigger:** a `session_messages` row reaches `status='completed'` for an agent with `learning_enabled = true`. Wires from both `finalizeMessage` and the detached-stream `/api/internal/messages/[messageId]/transcript/route.ts`.
  - **Actors:** A3, A4, A5
  - **Steps:**
    1. Mem0's `triggerExtract` runs first.
    2. Sleep Cycle's `triggerSleepAfterthought` runs second within the same `after()` execution. Status check, `learning_enabled` check, time-remaining guard (≥30s).
    3. Atomic claim CAS on `session_messages.learning_afterthought_claimed_at`. Loser returns silently.
    4. Builds the Hermes prompt (two buckets — personal memory + skills) using the just-finalized session's bounded-buffer-filtered transcript plus the agent's current Mem0 entries via `MemoryAdapter.list`.
    5. Calls the adaptive afterthought model (Haiku-class for simple successes, agent's main model for complex/failed).
    6. Writes new Mem0 entries via `MemoryAdapter.extract`; soft-deletes identified duplicates via `MemoryAdapter.delete` with `caller: { type: 'sleep-cycle', cycle_id }`; appends/updates learned skills in `agents.skills` JSONB under `folder: 'learned'`.
    7. Sets `learning_afterthought_completed_at`. On failure, leaves it NULL; emits `learning_afterthought_failed`.
  - **Outcome:** agent's accumulated memory shrinks or stays flat over time (vs. linear growth without Sleep Cycle); new skills appear in `agents.skills`; audit events emitted.
  - **Failure paths:** time-remaining <30s → skip + `learning_afterthought_skipped_no_time_budget`; adapter throws → `learning_afterthought_failed`, message billing/status untouched.
  - **Covered by:** R1, R4, R5, R6, R7, R8, R9, R10, R17, R22

- F2. **Deep sleep (scheduled, cross-session)**
  - **Trigger:** per-minute cron tick at `/api/cron/sleep-cycle` (cron-secret auth) finds agents whose `next_sleep_at <= now() AND learning_enabled = true`.
  - **Actors:** A4, A5
  - **Steps:**
    1. Claim a batch of due agents with `FOR UPDATE SKIP LOCKED`.
    2. For each: read transcripts since `last_sleep_at` (bounded-buffer allowlist) plus current Mem0 entries via `MemoryAdapter.list`.
    3. Call the deep-sleep model (agent's main model) with a heavier consolidation prompt.
    4. Write new Mem0 entries via `extract`; soft-delete superseded entries via `delete` with caller-tagged audit.
    5. Update learned skills: add new ones; consolidate or retire existing ones if at the soft cap (~50 per agent); preserve stable slugs.
    6. Update `last_sleep_at`; compute `next_sleep_at` from the per-agent schedule (default daily at tenant-local 3am).
  - **Outcome:** agent's memory store and learned-skill set converge over time toward a tight, useful core. Audit trail covers every mutation.
  - **Failure paths:** cycle exceeds budget → emit `deep_sleep_budget_exceeded` and stop early; adapter throws → `deep_sleep_failed`, `next_sleep_at` rolls forward.
  - **Covered by:** R1, R3, R11, R12, R13, R14, R17, R22

- F3. **Agent run consumes the layered output**
  - **Trigger:** any user message dispatched to a `learning_enabled` agent.
  - **Actors:** A2, A3, A5
  - **Steps:**
    1. `dispatchOrWorkflowDispatch` calls `MemoryAdapter.recall` (unchanged from Mem0). Recalled memories may include consolidated entries written by Sleep Cycle. Recall is filtered by `deleted_at IS NULL` so soft-deleted Mem0 entries do not surface.
    2. The system prompt receives the memory block (existing Mem0 path). The agent's `agents.skills` JSONB is materialized into the sandbox VM (existing skill-injection path), including any `folder: 'learned'` files Sleep Cycle wrote.
    3. Both runners (Claude SDK + AI SDK) see the same content shape. The agent uses recalled memories as context and `load_skill` (or file reads) to consult learned skills exactly as it would manual ones.
  - **Outcome:** the agent benefits from prior reflection without seeing or calling Sleep Cycle directly.
  - **Covered by:** R6, R18, R19

---

## Requirements

**Configuration**
- R1. Each agent has a boolean `learning_enabled` config flag, default `false`. Existing agents are unaffected unless explicitly enabled. The flag is independent from Mem0's `memory_enabled`, but Sleep Cycle does nothing useful unless `memory_enabled` is also true on the same agent.
- R2. Learning is opt-in but does not require backend selection in v1 — the platform has one Sleep Cycle implementation (the AgentPlane-native afterthought + deep-sleep pair).
- R3. Each agent has a per-agent deep-sleep schedule with a default of daily at 3am tenant-local time (using `tenants.timezone`). v1 exposes the column on `agents`; tenants override the schedule per-agent in v1 only via direct config edit. An admin UI surface is fast-follow.

**Afterthought (per-session, post-finalize)**
- R4. After Mem0's `triggerExtract` completes for a `status='completed'` message of a `learning_enabled` agent, Sleep Cycle's `triggerSleepAfterthought` runs in the same `after()` execution within the route's `maxDuration` budget.
- R5. The afterthought call is idempotent across the two call sites (`finalizeMessage` + detached-stream transcript route) using a claim/complete CAS pair on `session_messages` (`learning_afterthought_claimed_at`, `learning_afterthought_completed_at`). The losing caller returns silently; no double-extract.
- R6. The afterthought reads (a) the just-finalized session's transcript filtered by the bounded-buffer allowlist (include `result`/`error`, exclude `text_delta`) and (b) the agent's current Mem0 entries via `MemoryAdapter.list`.
- R7. The afterthought writes (a) new memories via `MemoryAdapter.extract`, (b) soft-deletes identified duplicates via `MemoryAdapter.delete` with `caller: { type: 'sleep-cycle', cycle_id }`, and (c) new or updated skill entries on `agents.skills` JSONB under `folder: 'learned'`, identified by stable slugs.
- R8. The afterthought time-remaining guard skips the run when fewer than 30 seconds remain on the route's `maxDuration`; emits `learning_afterthought_skipped_no_time_budget`.
- R9. Cancelled, failed, and timed-out messages do not trigger afterthought (positive `=== 'completed'` gate).
- R10. Afterthought failures are non-fatal: logged with structured event, do not affect the message's billing/status, do not retry by default in v1. `claimed_at` is append-only; any future v2 retry mechanism uses a separate `learning_afterthought_attempt_id` column rather than mutating `claimed_at`.

**Deep sleep (scheduled, cross-session)**
- R11. A per-minute cron at `/api/cron/sleep-cycle` (cron-secret auth, mirroring the Mem0 plan's `purge-memories` pattern) claims due agents using `FOR UPDATE SKIP LOCKED` over `WHERE learning_enabled = true AND next_sleep_at <= now()`.
- R12. For each claimed agent, deep sleep reads transcripts since `last_sleep_at` (bounded-buffer allowlist) plus current Mem0 entries via `MemoryAdapter.list`, runs the deep-sleep prompt, and writes the same two artifacts as afterthought (Mem0 mutations + learned-skill updates).
- R13. Deep sleep enforces a soft cap on learned skills per agent (default 50). When at or above cap, deep sleep is responsible for consolidating or retiring existing learned skills before adding new ones.
- R14. Deep sleep failures are non-fatal: `next_sleep_at` rolls forward, the cycle is logged with `deep_sleep_failed`, and the next tick is unaffected. Per-cycle budget overrun emits `deep_sleep_budget_exceeded` and stops the cycle early without rolling back partial writes.

**Reflection prompt and model selection**
- R15. The Hermes-shaped prompt has two buckets: personal memory (writes back to Mem0) and skills (writes to `agents.skills.learned`). The "shared memory" bucket from agent-co's literal prompt is dropped because cross-agent memory sharing is out of scope (matches Mem0 plan).
- R16. Model selection is adaptive. Afterthought uses a Haiku-class model for simple successful runs and the agent's main model for complex (≥10 tool calls) or failed runs. Deep sleep always uses the agent's main model. Models are configurable platform-wide via `LEARNING_AFTERTHOUGHT_MODEL` and `LEARNING_DEEP_SLEEP_MODEL` env vars.
- R17. Reflection transcripts are injection-scanned at the per-message level before reaching the reflection LLM, mirroring the prompt-injection-scanner integration the Mem0 plan also depends on. No transcript content reaches the prompt without scanning.

**Sandbox / runner contract**
- R18. Both runners (Claude Agent SDK and Vercel AI SDK / ToolLoopAgent) consume Sleep Cycle output uniformly through existing primitives — recalled memories via the existing memory recall path, learned skills via the existing skill-injection path. Neither runner sees Sleep Cycle tools or makes Sleep Cycle calls.
- R19. No memory or skill traffic crosses the sandbox boundary as a result of Sleep Cycle. The sandbox network allowlist is unchanged. All Sleep Cycle traffic flows platform → Mem0/AI Gateway/Postgres.

**Cost and budget**
- R20. Sleep Cycle LLM calls are counted against the agent's monthly budget like a regular run. The platform does not absorb Sleep Cycle cost.
- R21. Per-cycle budget caps: afterthought cap = `max($0.001, min($0.25, originating_session_cost × 10%))`; deep sleep cap = a flat per-agent default (~$1.00) configurable per-agent.

**Audit and observability**
- R22. All `MemoryAdapter` calls from Sleep Cycle pass `caller: { type: 'sleep-cycle', cycle_id }` so audit events fire automatically inside the adapter (matches the Mem0 plan's audit-via-adapter pattern). Operators can trace any Mem0 mutation back to its originating Sleep Cycle cycle.
- R23. Sleep Cycle emits structured events for both firing modes: `learning_afterthought_started/completed/failed/skipped_no_time_budget/lost`, `deep_sleep_started/completed/failed/budget_exceeded`. Per-message latency, model used, and per-cycle counts (memories added/retired, skills added/updated/retired) are queryable from logs in v1; admin UI surface is fast-follow.

---

## Acceptance Examples

- AE1. **Covers R1, R18.** Given an agent with `learning_enabled = false`, when a session-end fires, Sleep Cycle does not run and `agents.skills` is unchanged. The system prompt for the next message is bit-identical to today's `learning_enabled=false` baseline.
- AE2. **Covers R4, R5, R6, R7.** Given an agent with `learning_enabled = true` and `memory_enabled = true` and a freshly-finalized message with a non-trivial transcript, the afterthought claims via CAS, runs in `after()`, and writes both new Mem0 entries (visible via the admin GET memories endpoint) and at least one new learned skill (visible at `agents.skills` with `folder: 'learned'`).
- AE3. **Covers R5.** Given two concurrent calls to `triggerSleepAfterthought` for the same message (one from `finalizeMessage`, one from the detached-stream upload route), the afterthought runs exactly once. The second caller's CAS returns 0 rows; no double extract; no duplicate skill writes.
- AE4. **Covers R7, R22.** Given a deep-sleep cycle that retires a duplicate Mem0 entry, the entry is soft-deleted (sets `deleted_at`) with a caller-tagged audit event indicating Sleep Cycle as the actor. The Mem0 plan's hard-purge cron eventually removes it after 30 days.
- AE5. **Covers R8.** Given a long-running session that finalizes with <30s remaining on the route's `maxDuration`, afterthought is skipped. A `learning_afterthought_skipped_no_time_budget` event is emitted. No `claimed_at` is set; the next call site, if it has more budget, can still claim.
- AE6. **Covers R9.** Given a message that is cancelled mid-flight, when the cancellation is finalized, no afterthought runs. Same for `failed` and `timed_out`.
- AE7. **Covers R13.** Given an agent already at the 50-skill soft cap when deep sleep would add a new skill, deep sleep first consolidates or retires existing learned skills before adding the new one. Total post-cycle skill count never exceeds the cap by more than the cycle's net adds.
- AE8. **Covers R10, R14.** Given an afterthought or deep-sleep call that throws, the originating message billing/status is unchanged, the cron `next_sleep_at` rolls forward, structured events are logged, and the next message dispatches normally.
- AE9. **Covers R3, R11.** Given a tenant with `timezone='America/Los_Angeles'` and a `learning_enabled` agent at default schedule, the deep-sleep cron picks up the agent within one minute of 3am Pacific time on each calendar day. Two ticks in the same window do not double-claim because of `FOR UPDATE SKIP LOCKED`.
- AE10. **Covers R18, R19.** Given a `learning_enabled` agent on either runner (Claude SDK or Vercel AI SDK), the sandbox sees no Sleep Cycle MCP tool, no new network endpoint, and no new file injection beyond the existing `agents.skills` materialization path.

---

## Success Criteria

- An agent author can flip `learning_enabled` on for a single agent that already has `memory_enabled` on, run it across several sessions, and observably benefit from prior reflection: at least one named learned skill emerges in `agents.skills`, the agent stops re-exploring identifiable patterns it has seen, and Mem0 entry count stays bounded over time rather than growing linearly with sessions.
- Agents with `learning_enabled = false` are bit-identical to today's behavior — same prompt shape, same latency, same billing.
- Sleep Cycle never blocks message finalization or user-visible response latency. Sleep Cycle never breaks an agent message: recall, extract, afterthought, and deep sleep all degrade gracefully on failure.
- Operators can trace any consolidated Mem0 entry or learned skill back to a specific Sleep Cycle cycle via the audit events fired inside `MemoryAdapter`.
- The handoff to ce-plan does not require inventing trigger timing (afterthought + scheduled cron), output shape (Mem0 mutations + `agents.skills.learned`), the runner contract (uniform via existing primitives), or the reflection prompt's bucket structure (two buckets: personal memory + skills).

---

## Scope Boundaries

### Deferred for later

- Tenant-shared learned skills (any agent in the tenant can read another agent's learned skills). Same constraint as Mem0 plan; revisit when cross-agent memory sharing becomes a v2 question.
- Promoting afterthought / deep sleep to Workflow DevKit steps for crash-durable retries. v1 uses `after()` and a per-minute cron; matches the Mem0 plan's deferral.
- Extending `MemoryAdapter` with `update` / `merge`. Sleep Cycle uses delete-N-then-extract-1 + soft-delete contract; revisit if proven expensive in practice.
- Sleep Cycle afterthought retry mechanism. `claimed_at` is append-only; any v2 retry needs a separate `learning_afterthought_attempt_id` column.
- Encryption at rest for skill bodies in `agents.skills` JSONB. Mem0 encrypts `agent_memories` content; learned skills land in plaintext like manual skills do today. Revisit if a tenant flags it.
- Soft-delete + 30-day undo for learned skills. Skills mutate `agents.skills` JSONB in place; no per-skill undo window in v1.
- Admin UI for browsing / pinning / forgetting learned skills. The existing skill editor will show the `learned/` folder; richer UX is fast-follow.
- Per-skill confidence scoring or decay-on-disuse.
- Manual "trigger sleep cycle now" admin button.
- Per-skill cost passthrough in billing UI.
- Mid-session skill availability (writes during message N visible to message N+1 of same session).
- Sleep Cycle effectiveness measurement scaffolding ("did learnings actually help"). A ce-optimize loop, separate work.

### Outside this product's identity

- Anthropic Managed Agents "Dreaming" feature as the substrate. AgentPlane owns its own learning cycle regardless of which harness backend runs the agent; if Managed Agents' Dreaming graduates from research preview, AgentPlane integrates it as another learning backend rather than retiring its own.
- Outcomes-style rubric grading from Managed Agents. Orthogonal feature; not folded in here.
- Cross-tenant skill marketplace (publishing learned skills publicly). AgentPlane's product identity is per-tenant isolated by default; cross-tenant content sharing is a different product.
- "Shared memory" bucket from agent-co's literal Hermes prompt. AgentPlane's Mem0 namespace is per-agent by design; we do not introduce cross-agent memory primitives to satisfy a prompt shape.

---

## Key Decisions

- **Layer above Mem0, not replace.** Mem0 keeps per-message extract unchanged. Sleep Cycle is additive — it reads Mem0 entries and transcripts, writes Mem0 mutations and skills. Mem0 plan is ready for planning; Sleep Cycle solves a different problem (skills + cross-session consolidation) and shouldn't fork the memory primitive.
- **Two firing modes — afterthought + deep sleep — not one.** Afterthought catches per-session signal Mem0 misses (skill shape). Deep sleep handles cross-session consolidation Mem0 cannot do per-message. Each is necessary; together they match the compound "sleep + Hermes" framing.
- **Read transcripts AND Mem0 entries.** Mem0's already-extracted entries are lossy (filtered through Mem0's prompt); raw transcripts hold procedural sequences (tool-call chains, mistakes-then-corrections) that skill extraction needs. Sleep Cycle reads both.
- **Per-agent skill files (JSONB), reused primitive.** Learned skills land on `agents.skills` JSONB under `folder: 'learned'`. The existing skill-injection path materializes them in the sandbox; both runners' `load_skill` mechanism picks them up. No new primitive; no new write path in the runner contract.
- **Mem0 mutations via delete-N-then-extract-1 + soft-delete contract.** No new `MemoryAdapter` methods. Sleep Cycle deletes (soft) duplicates with caller-tagged audit, then `extract`s a consolidated entry. The Mem0 plan's hard-purge cron handles eventual cleanup.
- **Same claim/complete CAS as Mem0 extract.** Two new columns on `session_messages` (`learning_afterthought_claimed_at`, `learning_afterthought_completed_at`). Atomic claim guards against double-fire across the two call sites. Lost attempts (claimed but not completed past 5 min) emit `learning_afterthought_lost`.
- **Audit-via-adapter, not audit-via-route.** All `MemoryAdapter` calls pass a structured `caller` parameter; audit events fire inside the adapter. Sleep Cycle gets free audit coverage matching the Mem0 plan.
- **Separate `learning_enabled` flag, distinct from `memory_enabled`.** Different cost profiles, different value props. Tenants can run Mem0 alone (cheap, automatic) without paying the heavier Sleep Cycle prompts. Sleep Cycle is a no-op when `memory_enabled = false` since it has nothing to consolidate.
- **Cost is tenant-billed, not platform-eaten.** Sleep Cycle calls count against the agent's monthly budget. Mem0 chose platform-absorption for its (cheap, frequent) extract; Sleep Cycle is heavier and visible to the tenant.
- **Adaptive model selection (Hermes-style).** Haiku-class for simple successful afterthoughts; agent's main model for complex/failed afterthoughts and all deep-sleep cycles. Configurable via env vars matching the Mem0 plan's precedent.
- **Default daily 3am tenant-local schedule.** Reuses `tenants.timezone` + `croner`. Mirrors the existing per-agent schedule infrastructure rather than introducing a parallel scheduler.
- **Deep sleep is a cron route, not a piggyback on the message path.** Independent budget, independent scheduling, independent failure surface. Modeled on the existing `scheduled-runs` cron + the Mem0 plan's `purge-memories` cron.
- **Soft cap on learned skills (~50 per agent).** Deep sleep is responsible for consolidating/retiring before adding new skills when at cap. Prevents skill-registry bloat from poisoning the next-run skill prompt.
- **Sleep Cycle ships AFTER Mem0 plan U6 + U7 are live in production.** Code paths assume `MemoryAdapter` (with soft-delete + caller-required) is real and verified. Mem0 risk inherits to Sleep Cycle's launch.

---

## Dependencies / Assumptions

- Mem0 plan (`docs/plans/2026-05-06-003-feat-mem0-memory-primitive-plan.md`) ships first — including U0 spike, U1 migration, U3 adapter with soft-delete + caller-required parameter, U6 admin endpoints, U7 hard-purge cron. If Mem0 plan switches to its "port extraction prompts" fallback (U0 spike fail), Sleep Cycle is unchanged because it talks to `MemoryAdapter`, not Mem0 directly.
- Prompt-injection scanner plan (`docs/plans/2026-05-06-002-feat-prompt-injection-scanner-plan.md`) ships either first or in parallel. Sleep Cycle's transcript-injection scanning depends on the same primitive Mem0 extract uses; deploy-coordinate or document the gap window like the Mem0 plan does.
- The existing skill-injection path (`src/lib/sandbox.ts` materialization + `src/lib/runners/vercel-ai-runner.ts` skill registry / `load_skill` tool) handles a `folder: 'learned'` entry on `agents.skills` JSONB without changes. Verify in planning.
- The existing per-agent schedule infrastructure (`tenants.timezone`, `croner`, `scheduled-runs` cron pattern) supports a per-agent `next_sleep_at` cadence without contention against the existing schedule fields. Verify in planning.
- AI Gateway exposes Haiku-class models suitable for the cheaper afterthought path. Final model id deferred to planning.
- The existing transcript blob storage (`session_messages.transcript_blob_url`) is readable by Sleep Cycle within the time-remaining budget. Verify size + read-latency assumptions in planning.

---

## Outstanding Questions

### Resolve Before Planning

*(none — product decisions are settled; planning can proceed.)*

### Deferred to Planning

- [Affects R5][Technical] Exact column names + index strategy for `learning_afterthought_claimed_at` / `learning_afterthought_completed_at` on `session_messages`. The Mem0 plan's pattern is the precedent; mirror unless Sleep Cycle's cardinality differs.
- [Affects R7][Technical] How does Sleep Cycle distinguish "duplicate to retire" from "still useful but redundant"? Per-cycle prompt rule, similarity-score threshold, or LLM-mediated decision. Resolve during planning + first-week observability.
- [Affects R12][Needs research] Deep-sleep transcript-window size: how many sessions does deep sleep read per cycle? All since `last_sleep_at`? Cap at N? Token-budget the input? Pick during planning with a real measured baseline.
- [Affects R16][Technical] Final model ids for `LEARNING_AFTERTHOUGHT_MODEL` and `LEARNING_DEEP_SLEEP_MODEL` defaults. Pick from AI Gateway catalog at planning time; revisit if quality is poor.
- [Affects R7][Technical] Skill-content sanitization rules (length cap, structure stripping, role-prefix stripping, `<`/`>` escaping). Mem0 plan's `sanitize.ts` is the precedent; Sleep Cycle needs a larger length cap because skills are longer-form than memories.
- [Affects R23][Technical] Where Sleep Cycle observability surfaces — admin UI metrics card, structured logs only, or both. The Mem0 plan deferred the same call; coordinate.
- [Affects R3][User decision] Tenant-configurable deep-sleep schedule per agent — admin UI surface vs. config-only in v1. Default to the column without a UI; revisit fast-follow.
- [Affects R7][Technical] Skill slug derivation rule. Stable slugs let Sleep Cycle update in place; bad slugs cause duplicates. Pick a deterministic rule (e.g., kebab-case-of-LLM-named-title) at planning.
- [Affects R21][Technical] How "originating session cost" is computed for the afterthought budget formula when a session has many messages. Sum since session start? Latest message only? Pick at planning.
- [Affects R6, R12][Technical] How `MemoryAdapter.list` paging interacts with deep sleep's "all current Mem0 entries for this agent" need. v1 may need a non-paged variant or a paginated walk.
- [Affects R23][Technical] Lost-attempt sweep query for `learning_afterthought_lost` events: piggyback on the Mem0 plan's deferred lost-extract sweep, or run independently.
