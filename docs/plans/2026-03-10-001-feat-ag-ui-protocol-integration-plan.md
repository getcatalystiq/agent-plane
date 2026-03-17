---
title: "feat: AG-UI Protocol Integration"
type: feat
status: active
date: 2026-03-10
origin: docs/brainstorms/2026-03-10-ag-ui-integration-brainstorm.md
---

# feat: AG-UI Protocol Integration

## Overview

Integrate the [AG-UI protocol](https://docs.ag-ui.com/) into AgentPlane so that any AG-UI-compatible frontend (CopilotKit, custom React apps, CLI clients) can connect to AgentPlane agents natively via SSE streaming, while preserving full backwards compatibility with the existing NDJSON streaming SDK.

The integration uses a **Protocol Adapter Layer** — a thin translation layer at the HTTP response boundary that converts internal NDJSON events to AG-UI SSE events based on content negotiation. The internal execution pipeline (sandbox → Claude Agent SDK → NDJSON) remains unchanged.

## Problem Statement

AgentPlane currently uses a custom NDJSON streaming protocol with 7 event types. This is a proprietary format that requires clients to use the `@getcatalystiq/agent-plane` SDK. There is no interoperability with the growing AG-UI ecosystem (CopilotKit, LangGraph, CrewAI frontends, Microsoft Agent Framework).

AG-UI is becoming the standard protocol for agent-to-frontend communication (analogous to MCP for agent-to-tools). Without AG-UI support, AgentPlane agents are invisible to this ecosystem.

## Proposed Solution

Add dual-protocol support via content negotiation on existing streaming endpoints, plus a dedicated `/ag-ui/agents/:id` endpoint for native CopilotKit integration. The adapter translates internal events to AG-UI format at the response boundary.

**Key architectural insight:** AG-UI's frontend tool pattern uses `RUN_FINISHED { outcome: "interrupt" }` to pause, then the client sends a NEW request with the tool result in the `messages` array. This eliminates the need for a sandbox inbound communication channel — the tool result is simply part of the next request's conversation history. For sessions, this maps to sending another message with the tool result included.

(see brainstorm: docs/brainstorms/2026-03-10-ag-ui-integration-brainstorm.md — "Why This Approach")

## Technical Approach

### Architecture

```
AG-UI Client (CopilotKit, HttpAgent)
    │
    POST /ag-ui/agents/:id (RunAgentInput)
    │
    ├─ Auth (API key via Authorization header)
    ├─ Input mapping (RunAgentInput → internal params)
    ├─ Route to one-shot or session based on threadId
    │
    ▼
┌─────────────────────────────────────────┐
│ Existing Execution Pipeline (unchanged) │
│                                         │
│ prepareRunExecution() / executeSession  │
│     → Sandbox → Claude Agent SDK       │
│     → transcript.ndjson log iterator   │
└──────────────┬──────────────────────────┘
               │
               ▼
┌─────────────────────────────────────────┐
│ AG-UI Adapter Layer (new)               │
│                                         │
│ createAgUiStream(logIterator, options)   │
│     → Parse NDJSON lines               │
│     → Map to AG-UI event types         │
│     → Track message lifecycle (UUIDs)  │
│     → Encode via @ag-ui/encoder        │
│     → SSE heartbeats (:heartbeat)      │
│     → Stream detach (CUSTOM event)     │
└──────────────┬──────────────────────────┘
               │
               ▼
    SSE Response (text/event-stream)
```

Content negotiation on existing endpoints:
```
POST /api/runs          + Accept: text/event-stream  → AG-UI SSE
POST /api/runs          + Accept: application/x-ndjson (or default) → NDJSON
POST /api/sessions/:id/messages + Accept: text/event-stream → AG-UI SSE
```

### Implementation Phases

#### Phase 1: Core Adapter Layer

**Goal:** AG-UI SSE streaming for one-shot runs via content negotiation on `/api/runs`.

**Files to create/modify:**

1. **`src/lib/ag-ui-adapter.ts`** (new) — Core event mapper and SSE stream creator

   ```typescript
   import { EventEncoder, EventType } from "@ag-ui/core";

   interface AgUiStreamOptions {
     runId: RunId;
     agentId: AgentId;
     threadId?: string;
     logIterator: AsyncIterable<string>;
     onDetach?: () => void;
   }

   // State machine for tracking text message lifecycle
   interface AdapterState {
     currentMessageId: string | null;    // Active text message UUID
     currentToolCallId: string | null;   // Active tool call
     eventSequence: number;              // For ordering
   }

   export function createAgUiStream(options: AgUiStreamOptions): ReadableStream<Uint8Array>
   ```

   **Event mapping rules:**

   | Internal NDJSON Event | AG-UI Events | Notes |
   |---|---|---|
   | `run_started` | `RUN_STARTED { threadId, runId }` | First event |
   | `text_delta` | `TEXT_MESSAGE_START` (on first delta) + `TEXT_MESSAGE_CONTENT { delta }` | Generate messageId UUID on start |
   | `assistant` | **Suppressed** | Duplicates text_delta content (see brainstorm resolved Q1) |
   | `tool_use` | `TEXT_MESSAGE_END` (close open text) + `TOOL_CALL_START` + `TOOL_CALL_ARGS` + `TOOL_CALL_END` | Single TOOL_CALL_ARGS with full args JSON |
   | `tool_result` | `TOOL_CALL_RESULT { toolCallId, content }` | Server-side tool results only |
   | `result` | `TEXT_MESSAGE_END` (if text open) + `RUN_FINISHED { threadId, runId }` | Terminal |
   | `error` | `RUN_ERROR { message, code }` | Terminal |
   | `stream_detached` | `CUSTOM { name: "stream_detached", value: { poll_url } }` | AgentPlane-specific |
   | `heartbeat` | SSE comment `: heartbeat\n\n` | Standard SSE keepalive |
   | `session_created` | `CUSTOM { name: "session_created", value: { session_id } }` | Session-specific |
   | `session_info` | **Suppressed** | Internal only |
   | `system` | **Suppressed** | Internal only |

   **Event type matrix** (yield/store/asset-process per institutional learnings):

   | Event Type | Yield to SSE | Store in Transcript | Asset Process |
   |---|---|---|---|
   | `text_delta` | Yes (as TEXT_MESSAGE_CONTENT) | No (existing behavior) | No |
   | `assistant` | No (suppressed) | Yes (existing behavior) | Yes |
   | `tool_use` | Yes (as TOOL_CALL_*) | Yes | Yes |
   | `tool_result` | Yes (as TOOL_CALL_RESULT) | Yes | Yes |
   | `result` | Yes (as RUN_FINISHED) | Yes | No |
   | `error` | Yes (as RUN_ERROR) | Yes | No |

   **Message lifecycle tracking:**
   - Generate UUID when first `text_delta` arrives → emit `TEXT_MESSAGE_START { messageId, role: "assistant" }`
   - Subsequent `text_delta` → emit `TEXT_MESSAGE_CONTENT { messageId, delta }`
   - On `tool_use` or `result` → emit `TEXT_MESSAGE_END { messageId }` if text message is open, then reset

2. **`src/lib/streaming.ts`** — Add `sseHeaders()` helper and `createAgUiStream` export

   ```typescript
   export function sseHeaders(): HeadersInit {
     return {
       "Content-Type": "text/event-stream",
       "Cache-Control": "no-cache, no-transform",
       "X-Accel-Buffering": "no",
       "Connection": "keep-alive",
     };
   }
   ```

3. **`src/app/api/runs/route.ts`** — Add Accept header check in POST handler

   ```typescript
   const acceptHeader = request.headers.get("accept") ?? "";
   const useAgUi = acceptHeader.includes("text/event-stream");

   // ... existing prepareRunExecution() ...

   if (useAgUi) {
     const stream = createAgUiStream({ runId, agentId, logIterator, onDetach });
     return new Response(stream, { status: 200, headers: sseHeaders() });
   } else {
     const stream = createNdjsonStream({ runId, logIterator, onDetach });
     return new Response(stream, { status: 200, headers: ndjsonHeaders() });
   }
   ```

4. **`package.json`** — Add dependencies

   ```
   @ag-ui/core
   @ag-ui/encoder
   ```

**Acceptance criteria:**
- [ ] `POST /api/runs` with `Accept: text/event-stream` returns AG-UI SSE events
- [ ] `POST /api/runs` with `Accept: application/x-ndjson` (or no Accept) returns NDJSON (unchanged)
- [ ] SSE stream emits correct event lifecycle: `RUN_STARTED` → `TEXT_MESSAGE_*` → `TOOL_CALL_*` → `RUN_FINISHED`
- [ ] Heartbeats sent as SSE comments every 15s
- [ ] Stream detach after 4.5min emits `CUSTOM { name: "stream_detached" }`
- [ ] `assistant` events suppressed to avoid double-rendering
- [ ] Transcripts stored identically regardless of output protocol

#### Phase 2: Dedicated AG-UI Endpoint

**Goal:** `/ag-ui/agents/:id` endpoint that accepts `RunAgentInput` for CopilotKit compatibility.

**Files to create/modify:**

1. **`src/lib/ag-ui-validation.ts`** (new) — Zod schema for RunAgentInput

   ```typescript
   import { z } from "zod";

   const AgUiToolSchema = z.object({
     name: z.string().min(1).max(200),
     description: z.string().max(2000),
     parameters: z.object({
       type: z.literal("object"),
       properties: z.record(z.unknown()),
       required: z.array(z.string()).default([]),
     }),
   });

   const AgUiContextSchema = z.object({
     description: z.string(),
     value: z.string(),
   });

   export const RunAgentInputSchema = z.object({
     threadId: z.string().optional(),
     runId: z.string().optional(),        // Ignored (AgentPlane generates)
     messages: z.array(z.unknown()).default([]),
     tools: z.array(AgUiToolSchema).max(50).default([]),
     state: z.unknown().default({}),      // Ignored (agent-to-client only)
     context: z.array(AgUiContextSchema).default([]),
     forwardedProps: z.unknown().default({}),
   });
   ```

2. **`src/app/ag-ui/agents/[agentId]/route.ts`** (new) — AG-UI endpoint

   **Routing logic:**
   - No `threadId` → one-shot run (like `POST /api/runs`)
   - `threadId` present → lookup session by threadId; create if not found; send message

   **Input mapping:**
   - `messages` → extract last user message content as `prompt`; for sessions, ignored after first message (SDK manages context via `resume: sessionId`)
   - `tools` → stored on the run for frontend tool detection (Phase 3)
   - `context` → appended to prompt as `\n\n---\nContext:\n{context entries}`
   - `forwardedProps` → ignored

   **threadId → session mapping:**
   - Query `sessions` table for matching `threadId` (new column or use session ID as threadId)
   - If found and status is `idle` → send message to existing session
   - If found and status is `active` → reject with 409 (concurrent message)
   - If found and status is `stopped` → reject with 410
   - If not found → create new session with `threadId` as the AG-UI thread identifier

3. **`src/middleware.ts`** — Extend matcher to include `/ag-ui/`

   ```typescript
   export const config = {
     matcher: ["/api/:path*", "/admin/:path*", "/ag-ui/:path*"],
   };
   ```

4. **`src/db/migrations/016-ag-ui-thread-id.sql`** (new) — Add `ag_ui_thread_id` to sessions

   ```sql
   ALTER TABLE sessions ADD COLUMN ag_ui_thread_id TEXT;
   CREATE UNIQUE INDEX idx_sessions_ag_ui_thread_id
     ON sessions (tenant_id, ag_ui_thread_id)
     WHERE ag_ui_thread_id IS NOT NULL;
   ```

**Acceptance criteria:**
- [ ] `POST /ag-ui/agents/:id` with `RunAgentInput` creates one-shot run and streams AG-UI SSE
- [ ] `POST /ag-ui/agents/:id` with `threadId` creates/reuses session
- [ ] Subsequent requests with same `threadId` route to same session
- [ ] Authentication via `Authorization: Bearer <api_key>` (standard)
- [ ] Middleware covers `/ag-ui/` paths
- [ ] Invalid `RunAgentInput` returns 400 with error details

#### Phase 3: Frontend Tools

**Goal:** AG-UI clients can define tools that the agent invokes, pausing for client-side execution.

**Key insight from AG-UI protocol:** Frontend tool results do NOT require a POST-back endpoint. Instead:

1. Agent invokes a frontend tool → adapter streams `TOOL_CALL_START/ARGS/END`
2. Adapter emits `RUN_FINISHED { outcome: "interrupt" }` — the run pauses
3. Client executes tool locally, then sends a NEW request with the tool result in the `messages` array
4. Server resumes (new run for one-shot, new message for sessions)

This is fundamentally simpler than the brainstorm assumed. No sandbox inbound communication needed.

**Files to create/modify:**

1. **`src/lib/ag-ui-adapter.ts`** — Add frontend tool detection

   The adapter needs to know which tool names are "frontend" (defined by the client) vs "server-side" (MCP, allowed_tools). When a `tool_use` event references a frontend tool:
   - Emit `TOOL_CALL_START/ARGS/END` as usual
   - Do NOT emit `TOOL_CALL_RESULT` (client will provide it)
   - Emit `RUN_FINISHED { outcome: "interrupt", interrupt: { toolCallId, toolCallName } }`

   ```typescript
   interface AgUiStreamOptions {
     // ... existing fields ...
     frontendToolNames?: Set<string>;  // Tool names defined by client
   }
   ```

   **Detection logic:** When parsing a `tool_use` event, check if `tool_name` is in `frontendToolNames`. If yes, this is a frontend tool call — the run should interrupt after emitting the tool call events.

   **Challenge:** The sandbox will emit a `tool_result` for ALL tool calls (because Claude Agent SDK handles all tools server-side). For frontend tools, the adapter should suppress the server-side `tool_result` and instead let the client provide it. But this requires the runner to NOT execute frontend tools.

   **Runner modification:** The runner script must be told which tools are "frontend" so it can register them as tools that return a special "interrupt" signal. This requires modifying `src/lib/sandbox.ts` to pass frontend tool names to the runner, and the runner to register stub tools that signal an interrupt.

2. **`src/lib/sandbox.ts`** — Pass frontend tool names to runner

   When creating the runner script, if `frontendTools` are provided:
   - Register each frontend tool with the Claude Agent SDK as a tool definition
   - The tool handler returns a special marker (e.g., `{ __frontend_interrupt: true, toolCallId }`)
   - The runner detects this marker and emits a `frontend_interrupt` event, then exits

3. **`src/app/ag-ui/agents/[agentId]/route.ts`** — Handle tool results in messages

   When a request contains tool results in the `messages` array (identified by `role: "tool"` messages):
   - For one-shot runs: include tool results in the prompt context
   - For sessions: the Claude Agent SDK's `resume: sessionId` handles conversation continuity; the tool result message is passed as part of the conversation

**Acceptance criteria:**
- [ ] Client-defined tools in `RunAgentInput.tools` are passed to the agent
- [ ] Frontend tool calls emit `TOOL_CALL_*` events + `RUN_FINISHED { outcome: "interrupt" }`
- [ ] Server-side tool calls emit `TOOL_CALL_*` + `TOOL_CALL_RESULT` + continue
- [ ] Client can send tool results in subsequent request's `messages` array
- [ ] Agent resumes with tool result context
- [ ] Frontend tools do NOT execute server-side

#### Phase 4: Session Content Negotiation + State Sync

**Goal:** AG-UI SSE on session message endpoints + agent-to-client state events.

**Files to create/modify:**

1. **`src/app/api/sessions/[sessionId]/messages/route.ts`** — Content negotiation

   Same pattern as Phase 1: check `Accept` header, use `createAgUiStream` or `createNdjsonStream`.

2. **`src/lib/ag-ui-adapter.ts`** — STATE_SNAPSHOT/STATE_DELTA forwarding

   If the runner emits state events (future capability), the adapter forwards them as:
   - `STATE_SNAPSHOT { snapshot }` — complete state replacement
   - `STATE_DELTA { delta: JSONPatchOperation[] }` — incremental updates

   Initially, state events can be emitted by the adapter itself for structured metadata:
   - On `run_started`: emit `STATE_SNAPSHOT` with `{ agentId, model, mcpServerCount }`
   - On `result`: emit `STATE_DELTA` with `{ cost_usd, num_turns, duration_ms }`

3. **`src/app/api/sessions/route.ts`** — Content negotiation for session creation with prompt

**Acceptance criteria:**
- [ ] `POST /api/sessions/:id/messages` with `Accept: text/event-stream` returns AG-UI SSE
- [ ] State events emitted with run metadata
- [ ] Session prelude events (session_created) translated to CUSTOM AG-UI events

#### Phase 5: CORS + Polish

**Goal:** Browser-based AG-UI clients (CopilotKit) can connect cross-origin.

**Files to create/modify:**

1. **`src/middleware.ts`** or **`next.config.ts`** — CORS headers for `/ag-ui/` paths

   ```typescript
   // In middleware, for /ag-ui/ paths:
   if (pathname.startsWith("/ag-ui/")) {
     response.headers.set("Access-Control-Allow-Origin", "*");
     response.headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
     response.headers.set("Access-Control-Allow-Headers", "Content-Type, Authorization, Accept");
   }
   ```

   Handle OPTIONS preflight requests returning 204 with CORS headers.

2. **`src/app/ag-ui/agents/[agentId]/route.ts`** — OPTIONS handler for preflight

3. **SDK documentation** — Document AG-UI compatibility

   Update SDK README with:
   - How to use `@ag-ui/client`'s `HttpAgent` with AgentPlane
   - CopilotKit integration example
   - Event mapping reference

**Acceptance criteria:**
- [ ] Browser-based AG-UI clients can connect without CORS errors
- [ ] OPTIONS preflight returns 204 with correct headers
- [ ] SDK docs include AG-UI integration guide

## Alternative Approaches Considered

(see brainstorm: docs/brainstorms/2026-03-10-ag-ui-integration-brainstorm.md — "Why This Approach")

1. **Native AG-UI Runner** — Runner emits AG-UI events directly. Rejected: requires runner rewrite, two runner scripts to maintain, too invasive.
2. **AG-UI Proxy Service** — Standalone proxy translating NDJSON→SSE. Rejected: extra deployment, latency, frontend tools harder to wire.
3. **AG-UI only (replace NDJSON)** — Breaking change for existing SDK consumers. Rejected: backwards compatibility is essential.

## System-Wide Impact

### Interaction Graph

1. Client request → middleware (auth) → AG-UI route handler → `prepareRunExecution()` → sandbox creation → `captureTranscript()` → `createAgUiStream()` → SSE response
2. `createAgUiStream()` reads from same `logIterator` as `createNdjsonStream()` — the adapter sits between `captureTranscript()` output and the response encoder
3. `after()` / `finalizeRun()` / `finalizeSessionMessage()` remain unchanged — they operate on `transcriptChunks[]` which are populated by `captureTranscript()` before the adapter
4. Frontend tool interrupt: run finalizes normally (status "completed" with interrupt metadata), client sends new request to continue

### Error Propagation

- Sandbox creation failure → JSON error response (not SSE) with 500 status
- Mid-stream errors → `RUN_ERROR` SSE event, stream closes
- `captureTranscript()` errors → same as today, wrapped in adapter
- AG-UI encoder errors → caught in adapter, emitted as `RUN_ERROR`

### State Lifecycle Risks

- **Transcript integrity:** The adapter does NOT modify transcript storage. `captureTranscript()` runs before the adapter and populates `transcriptChunks[]` identically regardless of output format. No risk of transcript corruption.
- **Frontend tool interrupt:** The run completes normally (SDK finishes when it hits the interrupt stub tool). No orphaned state.
- **Session threadId mapping:** New `ag_ui_thread_id` column with unique index prevents duplicate sessions for the same thread.

### API Surface Parity

- `/api/runs` POST — gains content negotiation (both formats)
- `/api/sessions/:id/messages` POST — gains content negotiation
- `/ag-ui/agents/:id` POST — new endpoint (AG-UI native)
- All other endpoints unchanged
- SDK `RunStream` unchanged (NDJSON path untouched)

### Integration Test Scenarios

1. **Full lifecycle:** POST to `/ag-ui/agents/:id` → receive `RUN_STARTED` → `TEXT_MESSAGE_START` → N × `TEXT_MESSAGE_CONTENT` → `TEXT_MESSAGE_END` → `RUN_FINISHED`
2. **Tool call lifecycle:** Agent uses MCP tool → `TOOL_CALL_START` → `TOOL_CALL_ARGS` → `TOOL_CALL_END` → `TOOL_CALL_RESULT` → `TEXT_MESSAGE_*` → `RUN_FINISHED`
3. **Frontend tool interrupt:** Client defines tool → agent invokes it → `TOOL_CALL_*` → `RUN_FINISHED { outcome: "interrupt" }` → client sends new request with tool result in messages → agent continues
4. **Stream detach:** Long-running run → 4.5min → `CUSTOM stream_detached` → client polls `/api/runs/:id` → gets completed status
5. **NDJSON backward compat:** POST to `/api/runs` with no Accept header → receives NDJSON stream (identical to today)
6. **Session multi-turn:** POST to `/ag-ui/agents/:id` with threadId → creates session → subsequent request same threadId → routes to existing session

## Acceptance Criteria

### Functional Requirements

- [ ] AG-UI SSE streaming on `/api/runs` via `Accept: text/event-stream`
- [ ] AG-UI SSE streaming on `/api/sessions/:id/messages` via `Accept: text/event-stream`
- [ ] Dedicated `/ag-ui/agents/:id` endpoint accepting `RunAgentInput`
- [ ] `threadId`-based session creation and routing
- [ ] Frontend tool definitions passed to agent
- [ ] Frontend tool interrupt pattern (`RUN_FINISHED { outcome: "interrupt" }`)
- [ ] NDJSON streaming completely unchanged (backward compatible)
- [ ] CORS support for browser-based AG-UI clients
- [ ] All AG-UI event types correctly emitted (RUN_STARTED, TEXT_MESSAGE_*, TOOL_CALL_*, RUN_FINISHED, RUN_ERROR, CUSTOM, STATE_SNAPSHOT)

### Non-Functional Requirements

- [ ] No performance regression on NDJSON path
- [ ] SSE heartbeats every 15s
- [ ] Stream detach after 4.5min (same as NDJSON)
- [ ] Transcript storage identical regardless of protocol
- [ ] Authentication required on all `/ag-ui/` endpoints

### Quality Gates

- [ ] Unit tests for event mapper (all event type mappings)
- [ ] Unit tests for message lifecycle tracking (multi-turn text blocks)
- [ ] Integration test for full SSE stream lifecycle
- [ ] Integration test for frontend tool interrupt + resume
- [ ] Existing NDJSON tests continue to pass
- [ ] No TypeScript errors (`npm run build`)

## Dependencies & Prerequisites

- `@ag-ui/core` npm package (types, EventType enum)
- `@ag-ui/encoder` npm package (SSE encoding)
- Claude Agent SDK support for custom tool definitions (for frontend tools — needs verification)
- DB migration for `ag_ui_thread_id` column on sessions table

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|---|---|---|---|
| Claude Agent SDK doesn't support custom tool definitions for frontend tools | Medium | High (blocks Phase 3) | Verify SDK API before Phase 3; fallback: prompt-inject tool definitions |
| `@ag-ui/encoder` SSE format incompatible with Next.js streaming | Low | Medium | Test early in Phase 1; fallback: manual SSE encoding |
| `assistant` event suppression causes missing content | Low | High | Verify text_delta covers all text content; add logging for suppressed events |
| AG-UI protocol breaking changes | Low | Medium | Pin `@ag-ui/core` version; monitor releases |
| CORS misconfiguration exposes endpoints | Medium | High | Restrict origins in production; test with CopilotKit client |

## Future Considerations

(see brainstorm: docs/brainstorms/2026-03-10-ag-ui-integration-brainstorm.md — "Out of Scope")

- **Bidirectional state sync** — client sends state updates back to agent
- **WebSocket transport** — for lower-latency bidirectional communication
- **Protobuf binary encoding** — `@ag-ui/encoder` supports it; add when performance matters
- **Sub-agent composition** — `parentRunId` for agent delegation chains
- **Reasoning events** — `REASONING_*` events when Claude Agent SDK exposes chain-of-thought
- **Activity events** — `ACTIVITY_SNAPSHOT/DELTA` for progress indicators (needs runner instrumentation)
- **Streaming tool call arguments** — modify runner to emit `input_json_delta` for incremental `TOOL_CALL_ARGS` (currently emits full args in one event)

## Sources & References

### Origin

- **Brainstorm document:** [docs/brainstorms/2026-03-10-ag-ui-integration-brainstorm.md](docs/brainstorms/2026-03-10-ag-ui-integration-brainstorm.md) — Key decisions carried forward: dual protocol via content negotiation, protocol adapter layer approach, frontend tools with 30s timeout, agent-to-client state only, dedicated `/ag-ui/agents/:id` endpoint

### Internal References

- Streaming infrastructure: `src/lib/streaming.ts` (createNdjsonStream, ndjsonHeaders)
- Event types: `sdk/src/types.ts:352-362` (StreamEvent union)
- Run API: `src/app/api/runs/route.ts` (POST handler pattern)
- Session messages: `src/app/api/sessions/[sessionId]/messages/route.ts`
- Run executor: `src/lib/run-executor.ts` (prepareRunExecution, finalizeRun)
- Session executor: `src/lib/session-executor.ts` (prepareSessionSandbox, executeSessionMessage)
- Transcript utils: `src/lib/transcript-utils.ts` (captureTranscript, parseResultEvent)
- Middleware: `src/middleware.ts:93-95` (matcher config)
- Validation: `src/lib/validation.ts` (CreateRunSchema, SendMessageSchema)
- Institutional learning: `docs/solutions/logic-errors/transcript-capture-and-streaming-fixes.md` (event type matrix pattern)

### External References

- [AG-UI Documentation](https://docs.ag-ui.com/)
- [AG-UI GitHub](https://github.com/ag-ui-protocol/ag-ui)
- [@ag-ui/core npm](https://www.npmjs.com/package/@ag-ui/core)
- [@ag-ui/encoder npm](https://www.npmjs.com/package/@ag-ui/encoder)
- [CopilotKit AG-UI Integration](https://www.copilotkit.ai/ag-ui)
