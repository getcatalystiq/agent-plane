---
title: "feat: Per-agent persistent memory (Mem0-shaped)"
type: feat
status: active
date: 2026-05-06
deepened: 2026-05-06
origin: docs/brainstorms/2026-05-06-mem0-memory-primitive-requirements.md
---

# feat: Per-agent persistent memory (Mem0-shaped)

## Summary

Implement per-agent persistent memory as a platform-managed primitive. A new `MemoryAdapter` interface (one v1 implementation: a thin wrapper around `mem0ai@3.0.2` configured to use AgentPlane's existing Neon `Pool` and AI Gateway) sits behind a single dispatcher injection point and a single async post-finalization hook with claim/complete idempotency. Both runners receive recalled memory uniformly via the existing identity-prefix path; neither runner makes memory calls or sees memory tools. Memory content is encrypted at rest via the codebase's existing `JSON.stringify(encrypt(...))` blob pattern; the embedding column is raw to preserve pgvector ANN search. Soft-delete by default with a 30-day hard-purge cron. Audit logging is emitted by `MemoryAdapter` itself so all callers (HTTP and CLI) leave a forensic trail.

---

## Problem Frame

The brainstorm at the origin doc establishes the WHAT — agents lose all cross-session context today, and the per-agent / auto-recall / auto-extract / Mem0-shaped shape is settled. This plan defines the HOW: where in the dispatcher and finalize paths memory hooks land, what the wrapper around `mem0ai` looks like, how the new `agent_memories` table is provisioned and tenant-scoped with soft-delete + dual-cascade, and how the system-prompt composition is extended without breaking cross-runner uniformity.

---

## Requirements

Carried forward from origin (see origin: docs/brainstorms/2026-05-06-mem0-memory-primitive-requirements.md). Origin uses R-IDs R1–R18; this plan keeps origin's IDs unchanged.

- R1. Per-agent boolean `memory_enabled` flag, default false. Gates both runtime memory behavior and the admin-API memory endpoints.
- R2. Memory namespace keyed `(tenant_id, agent_id)`; no cross-agent sharing within a tenant.
- R3. One configured backend in v1; adapter shape exists, picker UI does not.
- R4. Recall called per message before runner spawn; bounded latency.
- R5. Recall results injected into the system prompt as a delimited block alongside SoulSpec.
- R6. Recall failures degrade gracefully — message proceeds with no memory block.
- R7. Hard recall latency budget enforced via abort.
- R8. Extraction async post stream-close; never blocks message finalization.
- R9. Extraction operates on the user prompt + final assistant response (and prior in-session turns where relevant).
- R10. Extraction failures logged, non-fatal, no v1 retry.
- R11. Cancelled/timed-out/failed messages do not trigger extraction.
- R12. `MemoryAdapter` interface defines `recall` + `extract` + `list` + `delete`; all calls accept `tenantId` and a `caller` audit context as required arguments.
- R13. v1 ships exactly one impl. No registry, no picker.
- R14. Interface validated by an in-memory test double.
- R15. Both runners receive memory uniformly via system-prompt injection.
- R16. No sandbox network changes; memory traffic is platform → Mem0/Neon/AI Gateway only.
- R17. Recall and extract calls logged with structured event names. Adapter-level audit events fire on every list/delete invocation (HTTP and any future caller).
- R18. Per-message recall counts and latencies queryable via structured logs in v1; admin observability endpoint deferred until usage patterns clarify the right shape.

**Origin acceptance examples:** AE1–AE6, all carried forward.

---

## Scope Boundaries

Carried verbatim from origin's Scope Boundaries:

- Per-end-user memory keying — out (schema reserves nullable `user_id` slot).
- Explicit memory tools — out.
- Cross-agent memory sharing within a tenant — out.
- Cross-tenant isolation work beyond existing RLS — out.
- Admin UI for browsing / editing / forgetting memories — out (admin HTTP API in v1; UI is fast-follow).
- Composing memory with SoulSpec into a unified `<agent-state>` block — out.
- Second backend implementation — out.
- Cost passthrough / per-tenant billing for extraction LLM — out.
- Mid-session memory mutations visible to later turns of the same session — out.
- Re-encryption migration for `ENCRYPTION_KEY` rotation — out (acknowledged residual; see Risks).

### Deferred to Follow-Up Work

- **Promote extraction to a Workflow DevKit step** — v1 uses `after()`. v2 should move extraction inside the workflow path.
- **Admin "memories list" UI** — v1 ships HTTP API only.
- **`/memory-health` endpoint** — operator observability beyond structured logs (R18 fast-follow). v1's `/extraction-status` early design proved over-scoped; the right shape (counts + recall ratios + extracted-vs-skipped breakdown) needs usage data to settle.
- **Admin CLI scripts** (`scripts/list-agent-memories.ts`, `scripts/delete-agent-memory.ts`) — redundant in v1 since HTTP endpoints suffice; promote alongside the admin UI when operators ask for a non-curl workflow.
- **Lint rule enforcing `agent_memories` table name appears only in `src/lib/memory/` + migrations** — RLS + non-exported SQL helper provide the v1 backstop.
- **Lost-extract sweep query** — `claimed_at IS NOT NULL AND completed_at IS NULL AND claimed_at < now() - interval '5 minutes'` emits `memory_extract_lost` events. Operator visibility only; v1 does not retry. Deferred until operators report needing it.

---

## Context & Research

### Relevant Code and Patterns

- **Dispatcher chokepoint:** `dispatchOrWorkflowDispatch` at `src/lib/workflows/dispatch-shim.ts:43`. Recall hooks here.
- **Encryption primitives (verified):** `src/lib/crypto.ts` exposes `encrypt(plaintext, key, version=1) → { version, iv, ciphertext }` (no `tag` field). Existing callers store `JSON.stringify(encrypt(...))` in a single text column. Memory follows the same blob pattern.
- **System-prompt composition has TWO distinct shapes:** Claude SDK runners use `prependIdentity(prompt, agent)` (string transform) at `src/lib/sandbox.ts:908` and `1359`. Vercel AI runners use `buildIdentityPrefix(config.agent)` and `systemPromptParts[]` array at `src/lib/runners/vercel-ai-runner.ts:113` and `vercel-ai-session-runner.ts:37`. v1 keeps both shapes.
- **Sandbox config:** `SandboxConfig` / `SessionSandboxConfig` in `src/lib/sandbox.ts:941`.
- **Finalize hook:** `src/lib/dispatcher.ts:1008` `finalizeMessage()` (legacy + workflow paths converge here).
- **Detached-stream finalize (separate path):** `src/app/api/internal/messages/[messageId]/transcript/route.ts` does NOT call `finalizeMessage`. Extract hook is a *second* explicit call site.
- **`maxDuration > 300s` precedent:** `src/app/api/internal/wdk-spike/[scenario]/route.ts:460` declares `maxDuration = 800`; 600s bump in U5 is platform-supported.
- **AI Gateway side-call:** `src/lib/soul-generation.ts:193` `callGateway()`. `resolveGatewayCost()` precedent for `AbortController` + bounded timeout.
- **DB pool + RLS:** `src/db/index.ts:7` `getPool()`; `src/db/index.ts:61` `withTenantTransaction(tenantId, fn)` — transaction-local `app.current_tenant_id`.
- **Migration precedent:** `src/db/migrations/034_workflow_dispatch_columns.sql`. `tenants.id uuid` shape verified at `001_initial.sql:20`.
- **Boolean toggle UI precedent:** `src/app/admin/(dashboard)/agents/[agentId]/a2a-info-section.tsx:44`.
- **Structured event logging:** `src/lib/logger.ts`. `event:` field convention.

### Institutional Learnings

- `docs/solutions/logic-errors/transcript-capture-and-streaming-fixes.md` — bounded buffers need an allowlist.
- `docs/research/wdk-spike-results.md` — WDK is canonical for durable steps; v1 uses `after()`.
- `docs/plans/2026-05-05-001-refactor-workflow-sdk-dispatch-plan.md` — chokepoint moved.
- `docs/plans/2026-03-25-001-feat-soulspec-v05-alignment-plan.md` — cross-runner uniformity invariant.
- `docs/plans/2026-03-19-002-feat-multi-model-agent-support-plan.md` — AI-Gateway side-call discipline.

### External References

- `mem0ai` npm package, current version `3.0.2` (2026-04-25). Cosine #4944 fixed; #4994/#5027/#5034 + SQL injection #4875/#4878 still open. U0 verifies substitution mechanism.
- Neon pgvector — HNSW + `vector_cosine_ops` + `<=>`.
- Vercel `after()` — shares route's `maxDuration`, no crash safety, no retry.

---

## Alternatives Considered

- **Wrap and pin `mem0ai@3.0.2` (chosen).** Get Mem0's tuned extraction without inheriting its Vercel-incompatible connection model.
- **Port Mem0's extraction prompts into `src/lib/memory/extraction/`.** Activated as a fallback path if U0 spike reveals Mem0's `Memory` constructor cannot be configured to skip `_doInitialize()` or accept custom adapters cleanly. **Owning extraction quality is a product-direction decision, not just technical** — if U0 fails, halt and escalate to user before activating port path.
- **DIY adapter on Neon pgvector with no Mem0 inheritance.** Rejected during brainstorm.
- **Mem0 Python SDK in a Vercel Python Function.** Rejected. Tertiary fallback only.

---

## Key Technical Decisions

- **Backend impl: thin wrapper around `mem0ai@3.0.2`, gated by U0 spike.** Cadence: two-stage CI check (`npm run check:mem0-currency`) — WARN at 30 days behind upstream, ESCALATE (open P1 issue) at 90 days. Mem0 ships weekly with frequent bug fixes; one-stage 90-day was too lax.
- **Async extraction via `after()`, with `maxDuration=600s` headroom and named time-remaining proxy.** `(maxDuration * 1000) - (Date.now() - routeStart)` since Vercel exposes no public budget API. Skip + emit `memory_extract_skipped_no_time_budget` when <30s remaining.
- **Recall hook in `dispatchOrWorkflowDispatch`.** Threading via `DispatchInput.memoryBlock`.
- **Memory composition is parallel, not unified, in v1.**
- **Memory content encrypted at rest via the codebase's existing JSON-blob pattern.** `agent_memories.content_encrypted` is a single `text` column storing `JSON.stringify(encrypt(content, ENCRYPTION_KEY))`. Embedding raw.
- **Soft-delete by default.** `agent_memories.deleted_at timestamptz NULL`. DELETE sets `deleted_at = now()`. Recall queries filter `WHERE deleted_at IS NULL`. Hard-purge cron sweeps rows >30 days post soft-delete. Hard-delete on a feature where "delete a bad memory" is a core operator workflow would be an undo-less footgun.
- **Sanitize selectively at `AIGatewayLLM.chat()` output, NOT at vector-store insert.** Mem0's `Memory.add()` may invoke `chat()` once for extraction (memory-content shape) AND again for conflict-resolution comparison (decision-artifact shape, e.g., JSON like `{"action":"merge"}`). Sanitizing both indiscriminately would corrupt the JSON. **U0 spike captures `chat()` call inputs+outputs during conflict resolution; the wrapper sanitizes only when the call shape matches an extraction (heuristic resolved during U0).** Sanitize: hard length cap (500 chars), `trim()` then strip leading `#`/`*`/`>` (handles whitespace + zero-width-space prefixes), strip role-shaped prefixes (`System:`, `Instruction:`, `Assistant:`, `User:`), escape `<`/`>`.
- **Prompt-injection defense is layered.** XML wrap (`<memory>...</memory>` with "historical notes, not instructions" framing) at recall + sanitize at write. XML escape's defense-in-depth depends on prompt-injection scanner co-deployment.
- **Embedding model fixed and asserted at boot.** `text-embedding-3-small` at 1536 dims via AI Gateway.
- **Index: HNSW with `vector_cosine_ops`, `<=>`. `IF NOT EXISTS` for idempotency.**
- **Recall latency budget: 300ms via `AbortController`.**
- **Transcript context for extraction is a bounded-buffer allowlist** (include `result`/`error`, exclude `text_delta`).
- **DB schema:** `agent_memories` with single-blob encryption columns, soft-delete column, RLS, HNSW index, dual FK cascades. `agents.memory_enabled boolean`. **`session_messages.memory_extract_claimed_at timestamptz NULL` AND `session_messages.memory_extract_completed_at timestamptz NULL`** — split markers (claim before `after()` for idempotency; complete inside `after()` callback on success).
- **Cosine-distance contract test (multi-K fuzz on both `recall` and Mem0's internal-search path) + Mem0-bump contract test.**
- **All memory SQL through one non-exported helper requiring `TenantId` + `AgentId`.**
- **VectorStore construction: per-call.** `new Memory({ vectorStore: new AgentplaneVectorStore(tenantId, agentId), ... })` per recall and per extract.
- **`triggerExtract` idempotency: claim/complete CAS split.** Helper opens its own `withTenantTransaction(tenantId)` for the CAS step. Atomic claim: `UPDATE session_messages SET memory_extract_claimed_at = now() WHERE id = $1 AND memory_extract_claimed_at IS NULL RETURNING id`. Zero rows → already claimed, skip. One row → schedule `after(() => ...)`. Inside the `after()` callback on extract success, set `memory_extract_completed_at = now()`. On extract failure (caught), do NOT set completed_at; structured `memory_extract_failed` event captures the failure. **A "lost" attempt** (claimed but never completed past T+5min, e.g., function crash between UPDATE and `after()` registration) is observable via `claimed_at IS NOT NULL AND completed_at IS NULL AND claimed_at < now() - interval '5 minutes'` — surfaced via structured `memory_extract_lost` log event from a maintenance query (deferred — operator visibility only). v1 does not retry; the brainstorm's R10 "no retry in v1" is preserved.
- **Audit logging emitted by `MemoryAdapter` itself, not by HTTP route handlers.** `list()` and `delete()` accept a required `caller: { type: 'http' | 'cli' | 'system'; identity?: string }` parameter. Adapter emits `admin_memory_list_accessed` / `admin_memory_deleted` structured events with `tenant_id`, `agent_id`, and `caller` context. Closes the round-2 audit gap where CLI scripts (had they shipped) would have bypassed audit. Architecturally cleaner: any future adapter caller (admin UI in fast-follow, scheduled jobs, operator scripts) inherits the audit trail without re-implementation.

---

## Open Questions

### Resolved During Planning

- JS SDK feature parity vs DIY vs Python sidecar — wrap+pin (subject to U0 spike); port fallback documented with explicit user-escalation gate.
- Async extraction mechanism — `after()` for v1 with named time-remaining proxy.
- Recall hook location — `dispatchOrWorkflowDispatch`.
- Embedding model + dimensions — `text-embedding-3-small`, 1536 dims, asserted at boot.
- Index — HNSW + `vector_cosine_ops` + `<=>`, `IF NOT EXISTS`.
- Cross-runner composition — parallel shapes for v1.
- Encryption at rest — single JSON-blob pattern; embedding raw.
- Operator remediation — admin HTTP API in v1; CLI deferred.
- Prompt-injection defense — XML wrap + selective sanitize-at-LLM-output.
- `triggerExtract` idempotency — claim/complete CAS split.
- VectorStore construction — per-call.
- Cadence accountability — two-stage CI check (30 WARN / 90 ESCALATE).
- Audit logging architecture — emitted by `MemoryAdapter`, not by route handlers.
- Delete semantics — soft-delete with 30-day hard-purge cron.
- Sanitize selectivity — selective by `chat()` call shape, resolved in U0.
- Extraction status surface — deferred to fast-follow `/memory-health` endpoint; v1 satisfies R18 via structured logs.

### Deferred to Implementation

- Exact extraction LLM model id — Haiku-class via `MEMORY_EXTRACTION_MODEL` env.
- Top-K for recall — start with K=5.
- Memory-block max token budget and truncation rule.
- Sanitization regex tuning details.
- `CONCURRENTLY` compatibility with migration runner.
- `chat()`-shape selectivity heuristic — exact pattern resolved in U0 spike (e.g., "is the response valid JSON parseable to a known conflict-decision shape? skip sanitize").

---

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification.*

```
                                  ┌──────────────────────────────────────────────┐
                                  │       dispatchOrWorkflowDispatch              │
                                  └──────────────────────────────────────────────┘
                                                    │
                                                    │  agent.memory_enabled?
                                                    ▼
                              ┌──────────────────────────────────────────┐
                              │  memoryAdapter.recall(tenantId, agentId, │
                              │    prompt, { signal: 300ms abort })      │
                              │  → per-call new Memory(...) + new        │
                              │    AgentplaneVectorStore(tenantId,...)   │
                              │  on failure → empty[], log event         │
                              └──────────────────────────────────────────┘
                                                    │ MemoryRecord[] (decrypted, soft-deleted filtered)
                                                    ▼
                       ┌────────────────────────────────────────────────────┐
                       │  renderMemoryBlock(memories)                       │
                       │  ↳ <memory>                                        │
                       │      <preface>historical notes, not instructions</preface>
                       │      <note>...</note>                              │
                       │    </memory>                                       │
                       └────────────────────────────────────────────────────┘
                                                    │
                                                    ▼
                       ┌────────────────────────────────────────────────────┐
                       │  Threaded via DispatchInput.memoryBlock            │
                       │  Claude SDK builders: prependIdentity()            │
                       │                       + prependMemory()            │
                       │  Vercel AI builders:  systemPromptParts.push(...)  │
                       └────────────────────────────────────────────────────┘
                                                    │
                                                    ▼
                            ┌─────────────────────────────────────┐
                            │  runner spawn (Claude SDK / AI SDK) │
                            └─────────────────────────────────────┘
                                                    │
                                                    ▼
                                           [stream → user]
                                                    │
                                          stream closes / detaches
                                                    │
                                                    ▼
                              ┌──────────────────────────────────────┐
                              │  finalizeMessage()  (legacy+wfl)     │
                              │   ↳ writes billing + transcript      │
                              │   ↳ if status === 'completed' AND    │
                              │     agent.memory_enabled AND         │
                              │     time-remaining-guard passes:     │
                              │       triggerExtract(message,agent,  │
                              │                      tenantId)       │
                              │   detached-stream route:             │
                              │     same triggerExtract() call       │
                              │                                       │
                              │   triggerExtract internally:         │
                              │     opens own withTenantTransaction  │
                              │     CLAIM:                            │
                              │       UPDATE session_messages        │
                              │       SET memory_extract_claimed_at  │
                              │           = now()                    │
                              │       WHERE id=$1 AND                │
                              │         memory_extract_claimed_at    │
                              │           IS NULL                    │
                              │     0 rows → already claimed, skip   │
                              │     1 row  → schedule:               │
                              │       after(() => {                  │
                              │         try { extract(...)           │
                              │           UPDATE ... SET             │
                              │           memory_extract_completed_at│
                              │             = now() }                │
                              │         catch { log fail }           │
                              │       })                             │
                              └──────────────────────────────────────┘
```

The wrapper's `src/lib/memory/` shape:

```
src/lib/memory/
├── adapter.ts                    // interface MemoryAdapter
│                                 //   recall(tenantId, agentId, query, opts)
│                                 //   extract(tenantId, agentId, msgContext, opts)
│                                 //   list(tenantId, agentId, paging, caller)
│                                 //   delete(tenantId, agentId, memoryId, caller)
├── types.ts                      // MemoryRecord, AuditCaller types
├── mem0-adapter.ts               // implements MemoryAdapter; per-call Memory(...)
│                                 //   list/delete emit audit events on every invocation
├── ai-gateway-adapters.ts        // AIGatewayLLM (selectively sanitizes its
│                                 //   OUTPUT based on call shape) + AIGatewayEmbedder
├── agentplane-vector-store.ts    // implements Mem0's VectorStore (full surface);
│                                 //   constructor takes (tenantId, agentId);
│                                 //   single non-exported memorySql() helper;
│                                 //   recall filters WHERE deleted_at IS NULL
├── transforms.ts                 // encryptMemoryContent / decryptMemoryContent /
│                                 //   sanitizeMemoryContent / renderMemoryBlock
├── triggerExtract.ts             // shared helper; opens own withTenantTransaction;
│                                 //   claim/complete CAS split; bounded-buffer
│                                 //   transcript filter; time-remaining guard;
│                                 //   after() wrapping
└── in-memory-adapter.ts          // test double satisfying MemoryAdapter
```

---

## Implementation Units

### U0. Spike: verify mem0ai@3.0.2 substitution viability + chat() call shape

**Goal:** Before U3 commits: verify `mem0ai` exposes named exports; verify `Memory` constructor accepts custom `VectorStore`/`LLM`/`Embedder`; verify substitution holds across `add`/`search`/`update`; **record exact `chat()` inputs+outputs across the full `Memory.add()` lifecycle so sanitize selectivity heuristic can be designed**.

**Requirements:** Gates U3.

**Dependencies:** None.

**Files:**
- Create: `tmp/mem0-spike/index.ts` (throwaway).
- Modify: this plan document.

**Approach:**
- `npm install mem0ai@3.0.2` in scratch project.
- **Named-export check:** `import { Memory, VectorStore, LLM, Embedder } from 'mem0ai'` resolves cleanly.
- Construct `new Memory({ vectorStore: customInstance, llm: customInstance, embedder: customInstance, historyStore: 'memory' })` with three minimal mock adapters that record every method call AND every `chat()` input+output verbatim.
- Exercise:
  - `add(messages, { userId })` — fresh state.
  - `add(messages, { userId })` — second call with similar content (triggers conflict resolver; multiple `chat()` calls expected).
  - `search(query, { userId })`.
- Microbenchmark: 100x `new Memory(...)` construction; record p50/p95 to confirm "per-call construction cost is acceptable" claim.
- Observe and record:
  - Method-call sequence on `vectorStore`.
  - DDL emission (must be zero).
  - **Every `chat()` call: prompt content, response shape (free text vs JSON), how Mem0 consumes the response.** This dictates the sanitize-selectivity heuristic for `AIGatewayLLM`.

**Decision tree (four branches):**
- **Pass:** all checks succeed + `chat()` shapes are recordable. Proceed with U3 and pin the sanitize heuristic.
- **Partial pass:** custom adapter invoked with caveats (e.g., DDL on a separate path). Document additional skip mechanism; proceed.
- **Ambiguous on conflict path:** custom adapter invoked for `add()`/`search()` but ambiguous on `update()`. Run explicit conflict-path probe before commit.
- **Fail:** Mem0 instantiates its own pgvector regardless of config. **Halt. Escalate to user before activating port path** (product-direction commitment to own extraction quality).

**Test scenarios:**
- *Outcome capture:* `Memory.add()` invokes expected methods on custom adapters; no DDL.
- *Conflict path:* `Memory.add()` with seeded conflict invokes `update`/`delete` on custom adapter.
- *`chat()` shape:* every `chat()` call is recorded; the spike output documents how to distinguish extraction-call response (memory-content shape) from conflict-resolution-call response (decision-artifact shape).
- *Named exports + construction microbenchmark.*

**Verification:** Outcome documented in this plan; one of four decision-tree branches selected; user sign-off if port path activates.

---

### U1. Database migration

**Goal:** Provision storage + idempotency markers + soft-delete column.

**Requirements:** R1, R2, R16

**Dependencies:** None.

**Files:**
- Create: `src/db/migrations/035_agent_memory.sql`

**Approach:**
- `CREATE EXTENSION IF NOT EXISTS vector;`
- `ALTER TABLE agents ADD COLUMN IF NOT EXISTS memory_enabled boolean NOT NULL DEFAULT false;`
- `ALTER TABLE session_messages ADD COLUMN IF NOT EXISTS memory_extract_claimed_at timestamptz NULL;` — **append-only in v1: once set, never cleared.** Any future v2 retry mechanism MUST use a separate `extract_attempt_id` column rather than mutating `claimed_at`. Prevents a race between a retry-clearing sweep and a slow `after()` that finally writes `completed_at` (which would produce internally inconsistent state of `completed_at NOT NULL AND claimed_at NULL`).
- `ALTER TABLE session_messages ADD COLUMN IF NOT EXISTS memory_extract_completed_at timestamptz NULL;`
- `CREATE TABLE IF NOT EXISTS agent_memories (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE, agent_id uuid NOT NULL REFERENCES agents(id) ON DELETE CASCADE, user_id text NULL, content_encrypted text NOT NULL, embedding vector(1536), metadata_encrypted text NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), deleted_at timestamptz NULL)`. Single-text-column encryption blob pattern matches `src/lib/crypto.ts`. `deleted_at NULL` = active; non-NULL = soft-deleted.
- `CREATE INDEX IF NOT EXISTS agent_memories_tenant_agent_created_idx ON agent_memories (tenant_id, agent_id, created_at DESC) WHERE deleted_at IS NULL;` — partial index excludes soft-deleted rows.
- `CREATE INDEX IF NOT EXISTS agent_memories_embedding_idx ON agent_memories USING hnsw (embedding vector_cosine_ops);` — `IF NOT EXISTS` for idempotency. `CONCURRENTLY` deferred to U1 implementation.
- `CREATE INDEX IF NOT EXISTS agent_memories_purge_idx ON agent_memories (deleted_at) WHERE deleted_at IS NOT NULL;` — supports the hard-purge cron's "deleted >30 days ago" sweep.
- RLS: `ENABLE ROW LEVEL SECURITY`; policy `tenant_isolation`.

**Patterns to follow:**
- `034_workflow_dispatch_columns.sql` for `ADD COLUMN IF NOT EXISTS`.
- `033_runs_sessions_unify.sql:174-188` for composite indexes.
- Existing soft-delete patterns in adjacent tables (if present; otherwise establish here).

**Test scenarios:**
- *Integration:* Migration succeeds against fresh test DB and DB at migration 034.
- *Integration:* Schema shows single-blob encryption columns; `deleted_at` present; both extract markers on session_messages.
- *Integration:* RLS fails closed without tenant context; succeeds with.
- *Integration:* Both FK cascades work (agent + tenant delete).
- *Edge case:* Migration is idempotent.

**Verification:** `npm run migrate` green; pgvector + RLS + dual extract markers + soft-delete column present.

---

### U2. AI Gateway embeddings client

(Unchanged from prior round.)

**Goal:** Thin embeddings client; boot-time dim assertion.
**Requirements:** R4, R8
**Dependencies:** None.
**Files:** `src/lib/embeddings.ts` + `tests/unit/embeddings.test.ts`.
**Approach:** Mirror `callGateway()`. `embed(input, opts) → number[][]`. Default `text-embedding-3-small`, 1536 dims. Boot-time `assertEmbeddingDims()` fails closed.
**Test scenarios:** Happy path single + array; boot assertion; 401 error; AbortSignal cancellation.

---

### U3. MemoryAdapter + Mem0 wrapper + transforms + audit logging + soft-delete

**Goal:** Define `MemoryAdapter` (with `caller` audit context); implement via per-call Mem0 construction; transforms in single `transforms.ts`; selective sanitize at `AIGatewayLLM.chat()` output by call shape; soft-delete in `delete()`; audit emission at adapter level.

**Requirements:** R2, R3, R9, R10, R12, R13, R14, R17

**Dependencies:** U0 (spike must pass), U1, U2.

**Files:**
- Create: `src/lib/memory/adapter.ts`, `types.ts`, `mem0-adapter.ts`, `agentplane-vector-store.ts`, `ai-gateway-adapters.ts`, `transforms.ts`, `in-memory-adapter.ts`.
- Create: `tests/unit/memory/agentplane-vector-store.test.ts`, `mem0-adapter.test.ts`, `transforms.test.ts`.
- Create: `tests/integration/memory/cross-tenant.test.ts`.
- Modify: `package.json` — add `mem0ai@3.0.2` (exact pin).

**Approach:**
- **`MemoryAdapter` interface:**
  ```
  recall(tenantId, agentId, query, opts) → Promise<MemoryRecord[]>
  extract(tenantId, agentId, messageContext, opts) → Promise<void>
  list(tenantId, agentId, paging, caller: AuditCaller) → Promise<MemoryRecord[]>
  delete(tenantId, agentId, memoryId, caller: AuditCaller) → Promise<void>
  ```
  `AuditCaller = { type: 'http' | 'cli' | 'system'; identity?: string }`. `tenantId` and `caller` required on all admin operations. Audit emission lives in the adapter (not in HTTP route handlers); any caller of `list`/`delete` emits the audit event automatically.
- **VectorStore construction is per-call.** Each `recall`/`extract`/`list`/`delete` invocation: `new Memory({ vectorStore: new AgentplaneVectorStore(tenantId, agentId), llm: aiGatewayLLM, embedder: aiGatewayEmbedder, historyStore: 'memory' })`.
- **Single non-exported `memorySql(tenantId, fn)` helper** wrapping `withTenantTransaction(tenantId, fn)`. Pool unexported.
- **Insert path:** `JSON.stringify(encrypt(content))` → `INSERT INTO agent_memories (... content_encrypted ...) VALUES (...)`.
- **Search path (over-fetch + post-filter to handle soft-deleted top-K crowding):** HNSW vector index has no `WHERE deleted_at IS NULL` partial-index predicate, so ANN candidates include soft-deleted rows. To prevent recall returning empty when soft-deleted memories crowd the K-nearest, over-fetch by 3x and post-filter to K. Query: `SELECT id, content_encrypted, metadata_encrypted, 1 - (embedding <=> $1) AS score FROM agent_memories WHERE tenant_id = current_setting(...)::uuid AND agent_id = $2 AND deleted_at IS NULL ORDER BY embedding <=> $1 LIMIT $3 * 3`, then caller trims to K in-process. Returns scores. Decrypt in-process. Over-fetch factor (3x) is a starting heuristic; tune if soft-delete volumes push it higher.
- **Soft-delete path** (`delete()`): `UPDATE agent_memories SET deleted_at = now() WHERE id = $1 AND tenant_id = ... AND agent_id = ... AND deleted_at IS NULL`. Emit `admin_memory_deleted` audit event with `caller` context. Soft-deleted rows never surface from `recall` or `list`.
- **Sanitize selectively at `AIGatewayLLM.chat()` output.** The adapter intercepts `chat()` responses. For each call, apply the selectivity heuristic resolved in U0 (likely: "is the response valid JSON parseable to `{action, ...}` or known conflict-decision shape? skip sanitize. Otherwise treat as memory-content text and sanitize.") `sanitizeMemoryContent()`: 500-char cap; `trim()` then strip leading `#`/`*`/`>` (handles whitespace + zero-width prefixes); strip role-shaped prefixes; escape `<`/`>`.
- **`transforms.ts`** — four pure string functions: `encryptMemoryContent`, `decryptMemoryContent`, `sanitizeMemoryContent`, `renderMemoryBlock`.
- **Audit emission:** `mem0-adapter.list()` and `delete()` emit structured events (`admin_memory_list_accessed` / `admin_memory_deleted`) including `tenant_id`, `agent_id`, page/memoryId, and `caller.type`+`caller.identity`. Required by interface contract.
- **`in-memory-adapter.ts`** test double for U5's tests (R14).

**Patterns to follow:**
- Mem0's `mem0-ts/src/oss/src/utils/factory.ts` and `vector_stores/base.ts`.
- `src/db/index.ts` `withTenantTransaction`.
- `src/lib/crypto.ts` `encrypt`/`decrypt` shape.
- `src/lib/soul-generation.ts:193` for AI Gateway.

**Test scenarios:**
- *Happy path recall:* Seeded memory returned at top.
- *Happy path extract:* Encrypted rows appear; recall decrypts and returns.
- *Cosine multi-K fuzz:* K=1/5/20/100 ranking consistent on both `recall` and Mem0's internal-search path (via `Memory.add()` with seeded conflict).
- *Mem0-bump contract:* Spy on adapter; every `add`/`search`/`update` corresponds to spied calls.
- *RLS / cross-tenant integration (AE6):* Tenant A vs B with similar content; recall in A's context returns only A's. Bare-pool query without `withTenantTransaction` returns zero rows.
- *Tenant cascade.* *Agent cascade.*
- *No DDL on init:* `pg.Client` constructor never invoked.
- *Encryption shape:* `content_encrypted` is JSON parseable to `{ version, iv, ciphertext }`; round-trip preserves.
- *Sanitize whitespace + zero-width-space bypass:* All variants stripped.
- *Sanitize selectivity:* Mock Mem0 calling `chat()` once with extraction prompt and once with conflict-decision prompt; assert sanitize runs on extraction output but NOT on the JSON-shaped conflict-decision response.
- *Soft-delete behavior:* `delete(memoryId)` sets `deleted_at`; subsequent `recall` does not return; `list` does not return.
- *Audit emission:* `list({...}, { type: 'http', identity: 'admin@…'})` emits `admin_memory_list_accessed` event with all expected fields. Same for `delete`.
- *Audit required:* Calling `list`/`delete` without `caller` argument is a TypeScript error and a runtime throw.
- *Per-call construction:* Concurrent `recall(tenantA, ...)` and `recall(tenantB, ...)` don't share VectorStore state.

**Verification:** All scenarios pass.

---

### U4. System-prompt composition

(Unchanged from prior round.)

**Goal:** Add `prependMemory` helper; thread `memoryBlock`; integrate at all four runner-side prefix sites.
**Requirements:** R5, R15
**Dependencies:** None for helper; U3 for end-to-end.
**Files:** Modify `src/lib/identity.ts`, `src/lib/sandbox.ts`, both Vercel AI runner files. Create `tests/unit/identity-memory.test.ts`.
**Approach:** `prependMemory(prompt, memoryBlock)` returns `prompt` unchanged when memoryBlock empty; otherwise `${memoryBlock}\n\n${prompt}`. Identity → memory → user-prompt ordering.
**Test scenarios:** Happy path; bit-identical disabled (AE1); cross-runner content match snapshot; AE2 partial.

---

### U5. Dispatcher recall hook + finalize extract hook with claim/complete CAS + maxDuration

**Goal:** Wire recall before runner spawn; wire extract via `triggerExtract` at both call sites with **claim/complete split for true idempotency**; bump `maxDuration`; named time-remaining proxy.

**Requirements:** R4, R6, R7, R8, R10, R11, R15, R16, R17

**Dependencies:** U2, U3, U4.

**Files:**
- Modify: `src/lib/workflows/dispatch-shim.ts` — recall hook in `dispatchOrWorkflowDispatch`.
- Modify: `src/lib/dispatcher.ts` — `DispatchInput.memoryBlock`; `runMessageStream` consumes; `finalizeMessage` calls `triggerExtract`.
- Modify: `src/app/api/internal/messages/[messageId]/transcript/route.ts` — explicit second `triggerExtract` call site.
- Modify: `src/app/api/sessions/[sessionId]/messages/route.ts` — bump `maxDuration` to 600.
- Modify: `src/app/api/internal/messages/[messageId]/transcript/route.ts` — declare `maxDuration = 600`.
- Create: `src/lib/memory/triggerExtract.ts`.
- Create: `tests/unit/dispatcher-memory.test.ts`, `tests/integration/dispatcher-memory.test.ts`.

**Approach:**
- **Recall hook:** as before — `dispatchOrWorkflowDispatch`, `AbortSignal.timeout(300)`, `memoryBlock` to `DispatchInput`.
- **`triggerExtract` shape (claim/complete CAS split):**
  ```
  triggerExtract(message, agent, tenantId, routeStart):
    if message.status !== 'completed' || !agent.memory_enabled: return
    if remainingMs(routeStart, maxDuration) < 30_000:
      log('memory_extract_skipped_no_time_budget', {...})
      return
    // CAS — opens its OWN withTenantTransaction; not nested
    const claimed = await withTenantTransaction(tenantId, tx =>
      tx.query(
        "UPDATE session_messages SET memory_extract_claimed_at = now() " +
        "WHERE id = $1 AND memory_extract_claimed_at IS NULL RETURNING id",
        [message.id]))
    if claimed.rowCount === 0: return  // already claimed by another caller
    // Schedule async work
    after(async () => {
      try {
        await memoryAdapter.extract(tenantId, agent.id, buildBoundedMessageContext(message, transcript))
        await withTenantTransaction(tenantId, tx =>
          tx.query(
            "UPDATE session_messages SET memory_extract_completed_at = now() WHERE id = $1",
            [message.id]))
      } catch (err) {
        log('memory_extract_failed', { message_id: message.id, error: err })
        // Do NOT set memory_extract_completed_at — claimed_at remains as evidence of attempt
      }
    })
  ```
- **Time-remaining proxy:** capture `routeStart = Date.now()` at handler entry; pass to `triggerExtract`. `remainingMs = (maxDuration_seconds * 1000) - (Date.now() - routeStart)`.
- **`maxDuration` bump:** session-message + internal transcript-upload routes 300→600s.
- **Skip on cancel/timeout/fail:** positive `=== 'completed'` check.
- **Bounded buffer for messageContext:** allowlist `result`/`error`, exclude `text_delta`.
- **"Lost extract" observability** (operator visibility, no v1 retry): rows where `claimed_at IS NOT NULL AND completed_at IS NULL AND claimed_at < now() - interval '5 minutes'` represent claimed-but-never-completed attempts. A maintenance query (deferred) emits `memory_extract_lost` events on a periodic sweep so operators can see how often `after()` is being dropped on long sessions. v1 ships without the sweep; the columns enable it.

**Patterns to follow:**
- `resolveGatewayCost()` for AbortController + bounded latency.
- `src/app/api/webhooks/[sourceId]/route.ts:450` for `after()`.
- `2026-05-06-002-feat-prompt-injection-scanner-plan.md` for DispatchInput threading.

**Test scenarios:**
- *Happy path (AE2):* 3 seeded memories → 3-memory block in system prompt.
- *Disabled state (AE1):* `memory_enabled=false` → adapter never called; bit-identical to today.
- *Recall timeout (AE3):* 300ms abort; `memory_recall_failed` logged; message proceeds.
- *Extract on success:* `status=completed` → claim CAS succeeds → `after()` fires once → on success, `completed_at` is set.
- *Extract claim race (idempotency):* Concurrently invoke `triggerExtract` from both call sites for same message; assert exactly one `after(extract)` fires; `claimed_at` set once. The losing call sees 0 rows from CAS and returns.
- *Extract claim survives crash (semantic check):* Mock the path where claim succeeds but `after()` registration throws; assert `claimed_at` is set but `completed_at` remains NULL — operator-visible "lost" state.
- *Extract success sets completed_at:* After successful extract, `completed_at` non-NULL.
- *Extract failure leaves completed_at NULL:* Adapter throws; `claimed_at` set; `completed_at` NULL; `memory_extract_failed` event logged.
- *Extract skipped on cancel (AE4) / timeout / failed:* Positive `=== 'completed'` check.
- *Time-remaining guard:* Mock `routeStart` to leave <30s; extract skipped; `memory_extract_skipped_no_time_budget` event.
- *Detached-stream parity:* Internal transcript-upload route also calls `triggerExtract`.
- *Workflow path parity (integration).*
- *Tenant isolation at recall (integration, AE6).*
- *Bounded-buffer allowlist.*

**Execution note:** *Test-first for the claim/complete CAS, the cross-call-site idempotency, and the claim-survives-failure observability case.*

**Verification:** All scenarios pass; existing dispatcher tests do not regress; disabled agents bit-identical.

---

### U6. Admin UI toggle + admin HTTP endpoints

**Goal:** Toggle on edit form; admin HTTP API endpoints (read paginated list, soft-delete one) routed through `MemoryAdapter` (which emits audit events). No CLI scripts in v1; no `/extraction-status` endpoint; no agent-list badge.

**Requirements:** R1, R3, R12, R17

**Dependencies:** U1, U3.

**Files:**
- Modify: `src/app/admin/(dashboard)/agents/[agentId]/edit-form.tsx` — `memoryEnabled` toggle.
- Modify: `src/app/api/admin/agents/[agentId]/route.ts` — extend `fieldMap` with `["memory_enabled", "memory_enabled"]`.
- Create: `src/app/api/admin/agents/[agentId]/memories/route.ts` — `GET` paginated. Calls `memoryAdapter.list(tenantId, agentId, paging, { type: 'http', identity: adminIdentity })`. Audit event fires inside the adapter.
- Create: `src/app/api/admin/agents/[agentId]/memories/[memoryId]/route.ts` — `DELETE`. Calls `memoryAdapter.delete(tenantId, agentId, memoryId, { type: 'http', identity: adminIdentity })`. Soft-delete; audit event fires inside the adapter.
- Modify: `src/lib/types.ts` — add `memory_enabled: boolean`.
- Modify: `src/lib/validation.ts` — extend agent Zod schema.
- Create: `tests/integration/admin-memories-route.test.ts`.

**Approach:**
- Toggle is the only UI surface in v1.
- Admin endpoints scope explicitly: `WHERE agent_id = $1 AND tenant_id = $currentTenantId AND deleted_at IS NULL`. Do not rely solely on RLS — admin auth may bypass it.
- Audit logging fires automatically because it's emitted inside the adapter, not by route handlers.
- Pagination: default page size 50; mirror other admin list endpoints.

**Patterns to follow:**
- A2A toggle precedent.
- `src/app/api/admin/agents/[agentId]/route.ts:104-118` `fieldMap`.

**Test scenarios:**
- *Toggle:* PATCHes `{ memory_enabled: true }`; reload persists.
- *Default state:* New agents `memory_enabled=false`.
- *Admin GET:* Returns decrypted, paginated; audit event fires.
- *Admin DELETE:* Soft-deletes (sets `deleted_at`); subsequent GET no longer surfaces; audit event fires; recall does not surface.
- *Cross-tenant isolation:* Admin endpoint scoped to tenant A cannot list/delete tenant B's memories. Explicit query filter, not RLS-only.
- *Admin auth required:* 401 without auth.
- *Audit-via-adapter coverage:* Manually invoking `memoryAdapter.list/delete` in a test (without a route) still emits the audit events.

**Verification:** Manual smoke + integration tests pass; audit events appear in logs for both HTTP-driven and direct-adapter paths.

---

### U7. Hard-purge cron for soft-deleted memories

**Goal:** Make the soft-delete contract honest. Without this cron, soft-deleted rows accumulate forever — "30-day restore window" becomes "delete-but-keep-encrypted-forever," contradicting the documented behavior. Round 4 product-lens flagged this as the one v1 ship-faster-vs-correct gap left.

**Requirements:** Supports R12 (delete semantics) + completes the soft-delete contract surfaced in Risks.

**Dependencies:** U1.

**Files:**
- Create: `src/app/api/cron/purge-memories/route.ts` — hard-deletes rows where `deleted_at IS NOT NULL AND deleted_at < now() - interval '30 days'`. Cron-secret auth.
- Modify: `vercel.json` — add daily cron entry pointing at `/api/cron/purge-memories`.
- Create: `tests/integration/cron-purge-memories.test.ts`.

**Approach:**
- Endpoint runs `DELETE FROM agent_memories WHERE deleted_at IS NOT NULL AND deleted_at < now() - interval '30 days'` inside a tenant-agnostic transaction (cron operates platform-wide; the partial index `agent_memories_purge_idx` from U1 makes the sweep cheap regardless of table size).
- Emits structured `memory_purge_completed` event with row count.
- Cron-secret auth via existing `cron-auth.ts` pattern.
- Rate-limit not needed (one daily call).
- 30-day window is the documented operator-undo window; bumping requires updating both the cron and Risks table together.

**Patterns to follow:**
- `src/app/api/cron/cleanup-sessions/route.ts` — cron auth + structured logging shape.
- `src/lib/cron-auth.ts` — secret verification.
- `vercel.json` cron entries.

**Test scenarios:**
- *Happy path:* Seed N rows with `deleted_at` >30 days ago + M rows with `deleted_at` <30 days ago + K rows with `deleted_at IS NULL`. Cron purges exactly N; M and K untouched.
- *Cron auth:* Request without cron secret returns 401.
- *Empty case:* No rows past the 30-day window → cron returns success with zero count.
- *Idempotency:* Second run after first leaves the same state.

**Verification:** Cron runs cleanly in test DB; `memory_purge_completed` events appear in logs.

---

## Land Order

1. **U0** — spike. Block downstream commits.
2. **U1, U2** — independent foundations.
3. **U3** — adapter implementation. Lands after U1 + U2.
4. **U4** — composer changes. Alongside or after U3.
5. **U5** — dispatcher integration.
6. **U6** — admin UI toggle + admin HTTP API. Lands last among user-facing units; if must ship earlier, gate toggle behind `MEMORY_FEATURE_ENABLED` env flag.
7. **U7** — hard-purge cron. Can land alongside U6 or earlier (requires only U1). Should be live before any tenant uses soft-delete in anger so the 30-day contract is honored from day one.

**Velocity vs hardening trade-off (explicit acknowledgement):** harden-first path adds units before user-visible value. Justified by the irreversibility of skipping encryption-at-rest or sanitization at v1 (can't be retrofitted onto populated rows). Round 3 cut `/extraction-status` and admin CLI scripts from v1 since structured logs and HTTP endpoints respectively cover the same need; that scope reduction was the correct over-correction adjustment.

---

## System-Wide Impact

- **Interaction graph:** disabled agents unchanged. Memory-enabled agents get one bounded recall (≤300ms) per message. Finalize path adds `triggerExtract` (claim CAS + `after()` schedule) gated on success, time-remaining, and uniqueness.
- **Function `maxDuration`:** session-message + internal transcript-upload routes 300→600s.
- **Active CPU billing:** `after(extract)` runs LLM calls during `after()`. Active CPU billed against originating route. Surfaced in Risks; v2 WDK promotion mitigates.
- **Error propagation:** memory failures never affect message outcomes.
- **State lifecycle:** rows owned by both agent and tenant; cascades on either delete. Soft-delete via `deleted_at`; hard-purge cron deferred. `memory_extract_claimed_at`/`completed_at` markers prevent double-fire and provide lost-extract observability.
- **API surface parity:** no public REST changes. Two new admin HTTP endpoints under `/api/admin/agents/:id/memories`.
- **Encryption-at-rest:** memory content + metadata under AES-256-GCM via existing JSON-blob pattern. Embedding raw.
- **Audit trail:** all memory list/delete operations emit structured events from inside `MemoryAdapter`. Any future caller (UI fast-follow, CLI scripts, scheduled jobs) inherits the audit by interface contract.

---

## Risks & Dependencies

(Round 3: merged 18→15 rows. Pairs collapsed: cosine bugs + future bumps → "Mem0 package reliability"; connection-model + SQL injection → "Mem0 pgvector substitution correctness"; embedding inversion + key rotation → "asymmetric encryption residuals.")

| Risk | Mitigation |
|---|---|
| Mem0 package reliability (cosine #4944, #4994/#5027/#5034; future bumps changing the wrapper interface) | Wrapper returns scores. Multi-K fuzz on both `recall` and Mem0's internal-search path. Mem0-bump contract test asserts every `add`/`search`/`update` reaches the custom adapter. Two-stage CI cadence (30d WARN / 90d ESCALATE). Port fallback documented if churn becomes unsustainable. |
| Mem0 init-skip mechanism unverified | U0 spike resolves before U3 commits. Four-branch decision tree including ambiguous-conflict-path probe and explicit user-escalation gate before activating port fallback. |
| Mem0 pgvector substitution correctness (connection model wrong for our stack; SQL injection in upstream pgvector #4875/#4878) | Custom `agentplane-vector-store.ts` substitutes Mem0's pgvector entirely. Test asserts `pg.Client` constructor never invoked — covers both the connection-model and the SQL-injection vectors with one verifier. |
| pgvector extension unavailable on Neon | Verified on every compute; `IF NOT EXISTS` surfaces issue at deploy. |
| Recall latency exceeds 300ms p95 | `AbortController` + 300ms budget. Observability via structured logs. |
| `after()` extract dropped when route's `maxDuration` trips | `maxDuration` bumped to 600. Time-remaining guard skips when <30s remaining and emits `memory_extract_skipped_no_time_budget`. |
| `after()` extract is lost on function crash | Origin's R10 accepts no retry. Claim/complete CAS provides observability via `memory_extract_lost` (claimed but never completed past 5min). WDK promotion deferred. |
| `triggerExtract` race between two call sites | Atomic claim CAS (`UPDATE ... WHERE memory_extract_claimed_at IS NULL RETURNING id`). Loser sees 0 rows. |
| Bad extraction quality pollutes the prompt | Recall failures degrade gracefully. Admin HTTP API ships in v1 for soft-delete remediation. Hard-purge cron after 30 days; restore window of 30 days for fat-fingers. |
| RLS bypass via wrapper or future caller | Single non-exported tenant-required SQL helper. Pool unexported. Cross-tenant integration test exercises full paths. Admin route filters by `tenant_id` explicitly (not RLS-only). |
| Prompt injection via attacker-controlled tool output | Selective sanitize at `AIGatewayLLM.chat()` output by call shape (extraction vs conflict-decision; resolved in U0). XML wrap at recall. Defense-in-depth depends on prompt-injection scanner co-deployment (`2026-05-06-002`); deploy sequence ships scanner before memory or documents the gap window. |
| Asymmetric encryption residuals (embedding inversion via raw vectors; ENCRYPTION_KEY_PREVIOUS retirement blocked) | Embeddings stored raw because pgvector requires it. Inversion attacks require read-only DB access; documented residual. Rotation works for new writes; retiring `ENCRYPTION_KEY_PREVIOUS` requires a future re-encryption job (deferred). |
| Sensitive data in extracted memory content | AES-256-GCM via JSON-blob pattern. Tenant-cascade delete. Soft-delete with hard-purge for deletion remediation. |
| Audit-trail gap (compromised admin credential) | Audit events emitted inside `MemoryAdapter.list/delete` so all callers — HTTP, future CLI, future UI, scheduled jobs — inherit the trail. Required `caller` parameter at the type level. |
| `DispatchInput` shape coordination with `2026-05-06-002` | First plan to ship establishes the shape; second mirrors. Joint envelope `dispatchHooks: { ... }` if both ship in parallel. |
| Active CPU billing under `after()` extract | Active CPU during `after()` billed to originating route, invisible to per-tenant accounting. v1 observability via Vercel function metrics only. WDK promotion (deferred) moves billing to a separate function. |

---

## Documentation / Operational Notes

- `CLAUDE.md` agent-table column list needs `memory_enabled`. `session_messages` needs `memory_extract_claimed_at` + `memory_extract_completed_at`. `agent_memories` is a new table.
- `src/lib/types.ts` `Agent` type adds one field.
- **`mem0ai` currency CI check (two-stage):** ship `npm run check:mem0-currency` script. Wire to a daily/weekly GitHub Action: WARN-level issue when locked version >30 days behind upstream's latest; P1 ESCALATE issue when >90 days. Mem0 ships weekly; one-stage 90d was too lax.
- **Operator-facing release note:** memory is fully opt-in per agent. Disabled agents see no change in latency, prompt content, or cost.
- Env vars: `MEMORY_EMBEDDING_MODEL` (default `text-embedding-3-small`; boot-asserted 1536 dims). `MEMORY_EXTRACTION_MODEL` (default Haiku-class). `MEMORY_FEATURE_ENABLED` (admin UI gate if U6 ships before U5 verified).
- **`maxDuration` bump:** session-message + internal transcript-upload routes 300→600s.
- **Deploy-coordination with `2026-05-06-002`:** sequence so scanner is live before memory ships, OR document the gap window.
- **Hard-purge cron** is now in v1 as U7 — `/api/cron/purge-memories` sweeps `WHERE deleted_at IS NOT NULL AND deleted_at < now() - interval '30 days'` daily. Honors the documented 30-day operator-undo window.
- **Lost-extract sweep query** — deferred but plan: periodic query for `claimed_at IS NOT NULL AND completed_at IS NULL AND claimed_at < now() - interval '5 minutes'` emits `memory_extract_lost` events for operator visibility.
- **`claimed_at` is append-only in v1.** Any future v2 retry mechanism must use a separate `extract_attempt_id` column rather than mutating `claimed_at`. Locks out a race between a retry-clearing sweep and a slow `after()` that finally writes `completed_at`.

---

## Sources & References

- **Origin document:** [docs/brainstorms/2026-05-06-mem0-memory-primitive-requirements.md](docs/brainstorms/2026-05-06-mem0-memory-primitive-requirements.md)
- Adjacent in-flight plan: [docs/plans/2026-05-05-001-refactor-workflow-sdk-dispatch-plan.md](docs/plans/2026-05-05-001-refactor-workflow-sdk-dispatch-plan.md)
- Concurrent plan: [docs/plans/2026-05-06-002-feat-prompt-injection-scanner-plan.md](docs/plans/2026-05-06-002-feat-prompt-injection-scanner-plan.md)
- SoulSpec composer precedent: [docs/plans/2026-03-25-001-feat-soulspec-v05-alignment-plan.md](docs/plans/2026-03-25-001-feat-soulspec-v05-alignment-plan.md)
- AI Gateway side-call precedent: [docs/plans/2026-03-19-002-feat-multi-model-agent-support-plan.md](docs/plans/2026-03-19-002-feat-multi-model-agent-support-plan.md)
- Bounded-buffer allowlist learning: [docs/solutions/logic-errors/transcript-capture-and-streaming-fixes.md](docs/solutions/logic-errors/transcript-capture-and-streaming-fixes.md)
- WDK spike: [docs/research/wdk-spike-results.md](docs/research/wdk-spike-results.md)
- Encryption shape: `src/lib/crypto.ts` — `{ version, iv, ciphertext }` JSON blob (NOT iv/tag triple)
- `maxDuration > 300` precedent: `src/app/api/internal/wdk-spike/[scenario]/route.ts:460`
- `tenants.id uuid` shape: `src/db/migrations/001_initial.sql:20`
- mem0ai npm: https://github.com/mem0ai/mem0 (current `3.0.2`, 2026-04-25)
