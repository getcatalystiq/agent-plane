---
date: 2026-05-06
topic: mem0-memory-primitive
---

# Mem0-shaped persistent agent memory

**Status:** Brainstorm complete, ready for planning
**Scope:** Standard

## Summary

Add a per-agent persistent memory primitive to AgentPlane so agents can remember facts, preferences, and task state across sessions. v1 ships one backend (self-hosted Mem0 OSS) behind a thin adapter shape that leaves room to swap in alternatives later. Memory recall and extraction are platform-managed and transparent to the agent — runners do not see memory tools.

---

## Problem Frame

Today an AgentPlane agent has two kinds of context: SoulSpec (static identity injected as `.soul/*.md` files) and per-session conversation history (`session_messages` rows + `session-history.json` for AI SDK runs). Across sessions, the agent forgets everything. A scheduled "ops copilot" agent re-learns the customer's stack on every run; an internal "PR triage" agent re-asks the same questions; a coding agent re-explores the repo every cold start. Tenants have no built-in way to make an agent accumulate knowledge over time.

The natural fix is a persistent memory layer with three concurrent uses: facts learned on prior runs, preferences/style the agent should adapt to, and ongoing task state across sessions. Mem0-shaped systems (LLM-extracted, self-updating, retrieval-keyed) are the closest match because they handle all three with one mechanism. Without something in this shape, every tenant who needs cross-session memory either rolls their own (skills as workaround, manual SoulSpec edits) or self-limits the agent's usefulness.

---

## Actors

- A1. **Agent author** — tenant user who builds an agent in the admin UI. Decides whether memory is on, picks the backend (today: only Mem0 self-hosted), and may inspect/clear memories from the admin UI.
- A2. **Agent (runtime)** — the SDK runner inside the sandbox. Has no awareness of memory; consumes a system prompt that already includes recalled memories.
- A3. **Platform dispatcher** — `dispatchSessionMessage()` and `finalizeMessage()`. Owns the recall call before runner spawn and the extraction call after the response stream closes.
- A4. **Memory backend** — the self-hosted Mem0 OSS service. Today this is one process; the adapter shape leaves room for a second implementation later.

---

## Requirements

**Configuration**
- R1. Each agent has a boolean `memory_enabled` config flag, default `false`. Existing agents are unaffected unless explicitly enabled.
- R2. When memory is enabled, the agent has an associated memory namespace keyed `(tenant_id, agent_id)`. Two agents within the same tenant do not share memory; the same agent across all its sessions does.
- R3. Memory is opt-in but does not require a backend selector in the agent config v1 — the platform has one configured backend (self-hosted Mem0). The adapter shape exists in code; the picker UI does not.

**Recall (read path)**
- R4. Before each user message is dispatched to the runner, the platform calls `memoryAdapter.recall(agentId, query)` with the new prompt as the query. Top-K results are returned within a bounded latency budget.
- R5. Recalled memories are injected into the system prompt as a structured block alongside SoulSpec content. The block is clearly delimited so the model can attribute information to "what I remember" vs "who I am."
- R6. Recall failures (timeout, backend unreachable) degrade gracefully: the message proceeds with no memory block, with a `memory_recall_failed` event recorded for observability. Memory failures must not fail the message.
- R7. Recall has a hard latency budget per message. If the budget elapses, the in-flight recall is abandoned (R6 path).

**Extraction (write path)**
- R8. After the response stream closes for a message, the platform invokes `memoryAdapter.extract(agentId, messageContext)` asynchronously. Extraction does not block message finalization or the user-visible response.
- R9. Extraction passes the user prompt + final assistant response (and prior in-session turns where relevant) to the backend, which is responsible for LLM-driven memory extraction and conflict resolution against existing memories.
- R10. Extraction failures are non-fatal: logged with backend-side error context, do not affect the message's billing/status, do not retry by default in v1 (revisit if extraction-loss rates are observable in practice).
- R11. Cancelled and timed-out messages do not trigger extraction. Failed messages do not trigger extraction.

**Adapter shape**
- R12. A `MemoryAdapter` interface defines `recall(agentId, query) → Memory[]` and `extract(agentId, messageContext) → void`. Optional methods (`forget`, `list`, `get`) may be added when admin UI or maintenance flows need them.
- R13. v1 ships exactly one implementation against self-hosted Mem0 OSS. The interface is the swap point; no provider registry, no multi-backend toggle, no second implementation on day one.
- R14. The interface is validated by writing a stub/test double for unit tests — not by shipping a second production backend.

**Cross-runner uniformity**
- R15. Both runners (Claude Agent SDK and Vercel AI SDK / ToolLoopAgent) receive memory in exactly the same shape — recalled memories arrive in the system prompt; neither runner sees memory tools or makes memory calls.
- R16. No memory traffic crosses the sandbox boundary. The sandbox network allowlist is unchanged. All Mem0 traffic flows platform → Mem0.

**Observability**
- R17. Recall and extract calls are logged with: agent_id, message_id, duration_ms, result count (for recall), and outcome (success/timeout/error).
- R18. The number of memories recalled per message and the recall latency are queryable per agent for the agent author. Specific shape (admin UI vs. structured logs only) is a planning decision.

---

## Acceptance Examples

- AE1. **Covers R1, R6.** Given an agent with `memory_enabled = false`, when a message is dispatched, the dispatcher does not call the memory backend and the system prompt contains no memory block.
- AE2. **Covers R5.** Given an agent with `memory_enabled = true` and three recalled memories, when a message is dispatched, the system prompt contains a delimited memory block holding those three items, separate from the SoulSpec block.
- AE3. **Covers R6, R7.** Given an agent with `memory_enabled = true` and the Mem0 backend timing out beyond the recall budget, when a message is dispatched, the runner spawns with no memory block and a `memory_recall_failed` event is logged. The message completes normally.
- AE4. **Covers R8, R10, R11.** Given a message that is cancelled mid-flight, when the cancellation is finalized, no extraction call is made.
- AE5. **Covers R8.** Given a message that completes successfully, when the response stream closes, message finalization writes billing and returns to the caller before extraction begins. Extraction failure does not affect the already-finalized message.
- AE6. **Covers R2.** Given two agents A1 and A2 in the same tenant, when A1 stores memories, A2's recalls do not return A1's memories.

---

## Success Criteria

- An agent author can flip `memory_enabled` on for a single agent, run it across several sessions, and observably benefit from prior context — quantifiable as: prompts shrink, repeat-questions drop, the agent references prior runs without being prompted to.
- Agents with memory disabled are bit-identical to today's behavior — same prompt shape, same latency, same billing.
- The handoff to ce-plan does not require inventing memory subject scoping (it is per-agent), the read/write mechanism (auto-recall + auto-extract, no agent tools), the runner contract (uniform across both runners), or the v1 backend (self-hosted Mem0 OSS).
- A second backend can be added later by writing a new `MemoryAdapter` implementation and switching one wiring point — no schema migration, no per-call branching across the codebase.

---

## Scope Boundaries

- **Per-end-user memory keying** — out. v1 is per-agent. The SaaS-of-SaaS shape (a tenant's agent serving its own end-users with separate memories) is real but not v1.
- **Explicit memory tools** — out. No `memory_search` / `memory_add` / `memory_forget` exposed to the agent. Auto-recall + auto-extract only.
- **Cross-agent memory sharing within a tenant** — out. Agents cannot read each other's memories.
- **Cross-tenant isolation work** — covered by existing RLS and `(tenant_id, agent_id)` namespacing; no new isolation primitives.
- **Admin UI for browsing / editing / forgetting memories** — out for v1. Likely a fast-follow once data starts accumulating; may need it sooner if extraction quality is poor and operators need to surgically clean memory state.
- **Composing memory with SoulSpec into a unified `<agent-state>` block** — out. v1 keeps memory and SoulSpec as separate, clearly-delimited blocks.
- **Second backend implementation** — out. Mem0 self-hosted only.
- **Cost passthrough / per-tenant billing for Mem0 LLM extraction calls** — out for v1. Extraction LLM cost is a platform-side cost; revisit if it becomes material.
- **Mid-session memory mutations visible to later turns of the same session** — out. A memory written during message N is not guaranteed visible to recall on message N+1 of the same session beyond what in-session conversation history already provides. (This is a direct consequence of the platform-managed mechanism; runner-side libraries would unlock it but were rejected.)

---

## Key Decisions

- **Mechanism: pure platform plumbing (Approach A).** Recall is done by the dispatcher pre-spawn; extraction by `finalizeMessage` post-stream. Runners are memory-unaware. Rationale: identical behavior across both runners with zero duplicated logic, no sandbox network changes, clean cost attribution.
- **Memory subject: per-agent (single shared store).** Rationale: simplest viable shape; matches the agent-as-notebook pattern of internal copilots and scheduled jobs. Per-end-user can layer on later without changing the per-agent default.
- **Backend: self-hosted Mem0 OSS only for v1.** Rationale: keeps tenant data on our infrastructure, no per-call API spend to Mem0, no third-party data residency surface. Trade-off: we operate the storage ourselves.
- **Hosting topology: `mem0ai` JS SDK embedded in Next.js API routes.** Mem0 runs as a library inside the existing AgentPlane Vercel deployment — no separate service. Vector store is Neon + pgvector (extension added to the existing database). Embeddings and extraction LLM both go through the Vercel AI Gateway. Rationale: zero new infra, reuses Neon and AI Gateway already in the stack, single deploy unit. Fallback path if the JS SDK is materially incomplete: deploy Mem0's Python FastAPI as a Vercel Python Function in the same project — `MemoryAdapter` insulates the rest of the platform from this swap.
- **Adapter shape over adapter framework.** A clean `MemoryAdapter` interface defines the swap point. No provider registry, picker UI, or second backend on day one. Swappability is validated by stubbing an in-memory test adapter.
- **Extraction is async and non-blocking.** Message finalization and user-visible latency are not held by extraction.
- **Memory failures degrade gracefully.** A failing memory backend never breaks an agent message.

---

## Dependencies / Assumptions

- **Operational footprint of self-hosting Mem0.** Bound to the chosen topology: `mem0ai` JS SDK as a library inside the existing AgentPlane Next.js deployment, backed by Neon + pgvector. No separate service to operate. The pgvector extension must be enabled on the Neon database (via migration) and a memories table provisioned. Connection pooling reuses the existing pool. Fallback only: deploy Mem0's Python FastAPI as a Vercel Python Function in the same project if the JS SDK proves materially incomplete.
- **JS SDK feature parity.** Assumes the current `mem0ai` JS package supports self-hosted mode (custom vector store + embedder + LLM) with the operations the adapter needs: extract from messages, store with embedding, recall top-K by similarity, reconcile conflicts on update. Planning must verify this against the package's current state. If parity is incomplete, options are (in order): patch the SDK, drop the SDK and call its primitives directly, fall back to the Python Function path.
- **Extraction LLM model.** Mem0's extraction uses an LLM call per session/message; the model is configurable. Default likely an inexpensive Haiku-class model via AI Gateway; final choice deferred to planning.
- **Embeddings model.** Vector store entries need embeddings; the model is configurable per Mem0 OSS. Default candidate is a small embedding model exposed via AI Gateway. Final choice deferred to planning; must be picked with the pgvector index dimensionality.
- **Latency budget for recall.** Assumed bounded (target <300ms p95). With the JS-SDK-in-process topology, recall is one Neon query (vector ANN search) plus one embedding call to AI Gateway — both inside the same Vercel function. No cross-service hop. Validate against real prompts during planning.
- **Extraction quality unknown until measured.** Mem0's defaults work well in their hosted demos; we have no signal yet on quality against AgentPlane's transcript shapes (long bash outputs, MCP tool results, A2A multi-turn). May need prompt tuning or per-agent extraction config later.
- **Tenant data residency.** Self-hosted means memory data lives on AgentPlane infrastructure, not Mem0's. No new third-party data-sharing surface beyond the LLM provider used for extraction (which is the same gateway already used for agent runs).
- **Existing infrastructure assumptions to verify in planning:** `dispatchSessionMessage()` has a clean injection point for system-prompt prefix construction; `finalizeMessage()` can spawn async post-finalization work without holding the response; per-agent boolean config columns are easy to add (precedent: many existing flags on `agents`).

---

## Outstanding Questions

### Resolve Before Planning

- *(none — product decisions are settled; planning can proceed.)*

### Deferred to Planning

- **[Affects R12, R13][Needs research]** Verify current `mem0ai` JS SDK self-hosted support against the operations the adapter needs (extract, store, recall, reconcile). If gaps exist, decide: patch the SDK, call primitives directly, or fall back to the Python Function topology. Should be the first planning task — invalidates downstream decisions if the SDK can't carry the load.
- **[Affects R8][Technical]** Async extraction implementation: Vercel Workflow DevKit step, a queue, or `after()` in the response handler? Choice depends on how strict we want the "extraction always runs eventually" guarantee to be.
- **[Affects R9][Needs research]** Which extraction LLM and embeddings model are the right v1 defaults via AI Gateway? Are they per-tenant configurable from agent config, or platform-wide settings?
- **[Affects R4][Technical]** pgvector schema: table name, column types, embedding dimensions, ANN index choice (HNSW vs IVFFlat), and migration ordering relative to existing migrations (currently at 033).
- **[Affects R5][Technical]** Exact shape of the memory block injected into the system prompt — section heading, ordering relative to SoulSpec blocks, max token budget per block, truncation rules when recall returns more than fits.
- **[Affects R7][Technical]** Concrete recall latency budget (200ms? 300ms?) and how to enforce it (Promise.race with timer, or AbortController on the HTTP call).
- **[Affects R17, R18][Technical]** Where memory observability surfaces — admin UI metrics card, structured logs only, or both. If UI: which page (agent detail, dashboard, neither).
- **[Affects R12, R13][Technical]** Concrete `MemoryAdapter` interface signature. What does `messageContext` actually carry — full transcript, last N turns, just user prompt + final response? Affects extraction quality vs payload size trade-off.
- **[Affects R2][Needs research]** Do we need a maintenance path to clear memory for an agent (e.g. when an agent is deleted, when a tenant requests reset)? GDPR/right-to-erasure shape if any tenant operates in EU.
