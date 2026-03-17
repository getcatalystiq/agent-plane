# AG-UI Protocol Integration

**Date:** 2026-03-10
**Status:** Brainstorm complete

## What We're Building

Integrate the [AG-UI protocol](https://docs.ag-ui.com/) into AgentPlane so that any AG-UI-compatible frontend (CopilotKit, custom React apps, CLI clients) can connect to AgentPlane agents natively, while preserving full backwards compatibility with the existing NDJSON streaming SDK.

### Goals

1. **Ecosystem interoperability** — AG-UI-compatible clients connect out of the box
2. **Richer streaming** — state sync, frontend tools, activity indicators, reasoning events
3. **Industry standardization** — adopt an emerging open protocol alongside MCP and A2A
4. **Zero breaking changes** — existing `@getcatalystiq/agent-plane` SDK consumers unaffected

## Why This Approach

**Protocol Adapter Layer with Content Negotiation**

A thin adapter translates AgentPlane's internal event stream to AG-UI format based on the client's `Accept` header. This was chosen over:

- **Native AG-UI Runner** — would require a runner rewrite and maintaining two runner scripts; too invasive for the value
- **AG-UI Proxy Service** — adds deployment complexity, latency, and makes frontend tools harder to wire back

The adapter approach keeps a single execution path (sandbox → Claude Agent SDK → NDJSON events) and adds a format translation layer at the HTTP response boundary.

## Key Decisions

### 1. Dual Protocol via Content Negotiation

Existing endpoints (`/api/runs`, `/api/sessions/.../messages`) serve both formats:

- `Accept: text/event-stream` → AG-UI SSE (via `@ag-ui/encoder`)
- `Accept: application/x-ndjson` (or default) → current NDJSON

No new endpoints needed. The streaming layer detects the desired format and wraps the internal event iterator with the appropriate encoder.

### 2. Event Mapping

| AgentPlane Event | AG-UI Event(s) |
|---|---|
| `run_started` | `RUN_STARTED` |
| `text_delta` | `TEXT_MESSAGE_CONTENT` (with `TEXT_MESSAGE_START`/`END` lifecycle) |
| `assistant` | `TEXT_MESSAGE_START` + `TEXT_MESSAGE_END` (complete message) |
| `tool_use` | `TOOL_CALL_START` + `TOOL_CALL_ARGS` + `TOOL_CALL_END` |
| `tool_result` | `TOOL_CALL_RESULT` |
| `result` | `RUN_FINISHED` |
| `error` | `RUN_ERROR` |
| `stream_detached` | `CUSTOM { name: "stream_detached", value: { poll_url } }` |
| `session_created` | `CUSTOM { name: "session_created", value: { session_id } }` |
| `heartbeat` | SSE comment (`:heartbeat`) — standard SSE keepalive |

### 3. Frontend Tools — Full Support

- Clients pass `tools` array in the request body (alongside `prompt`)
- Tools are injected into the Claude Agent SDK `query()` call
- When Claude invokes a frontend tool, the `TOOL_CALL_START/ARGS/END` events stream to the client
- Client executes the tool locally and POSTs the result back
- Result is relayed to the running sandbox to continue execution

**Implementation detail:** Frontend tool results require a callback mechanism. Options:
- **SSE + POST back** — client receives tool call via SSE, POSTs result to `/api/runs/:id/tool-results`
- **WebSocket upgrade** — bidirectional channel (more complex, deferred)

Start with SSE + POST back pattern.

### 4. State Sync — Agent-to-Client Only

- Agents can emit `STATE_SNAPSHOT` and `STATE_DELTA` events to push structured state to clients
- Clients consume state reactively but don't send state back
- Use cases: progress indicators, structured intermediate outputs, live dashboards
- Full bidirectional state can be added later without breaking changes

### 5. AG-UI RunAgentInput Compatibility

AG-UI clients send `RunAgentInput` with `{ threadId, runId, messages, tools, state, context }`. Map to AgentPlane's model:

- `threadId` → `session_id` (for sessions) or ignored (for one-shot runs)
- `runId` → auto-generated (AgentPlane controls run IDs)
- `messages` → conversation history (sessions already handle this via `resume: sessionId`)
- `tools` → frontend tool definitions (new)
- `state` → ignored initially (agent-to-client only)
- `context` → appended to prompt or passed as system context

### 6. Stream Detach Handling

AG-UI has no built-in equivalent to AgentPlane's `stream_detached` + polling pattern. Use `CUSTOM` event type:

```
event: custom
data: {"type":"CUSTOM","name":"stream_detached","value":{"poll_url":"/api/runs/run_xxx"}}
```

AG-UI clients that don't understand this event can safely ignore it (graceful degradation). AgentPlane-aware clients handle reconnection.

### 7. Dependencies

- `@ag-ui/core` — event types and interfaces
- `@ag-ui/encoder` — SSE event encoding

No dependency on `@ag-ui/client` (that's for consumers, not servers).

## Architecture

```
Client Request
    │
    ├─ Accept: application/x-ndjson ──→ Current NDJSON stream (unchanged)
    │
    └─ Accept: text/event-stream ────→ AG-UI Adapter
                                           │
                                           ├─ Event Mapper (NDJSON → AG-UI events)
                                           ├─ SSE Encoder (@ag-ui/encoder)
                                           ├─ Heartbeat (SSE comments)
                                           └─ Frontend Tool Relay (POST back endpoint)

Internal Pipeline (unchanged):
    Sandbox → Claude Agent SDK → transcript.ndjson → log iterator
```

## Scope

### In Scope
- Content negotiation on run + session message endpoints
- Event mapper (AgentPlane events → AG-UI events)
- SSE streaming via `@ag-ui/encoder`
- Frontend tool definitions in request body
- Frontend tool result POST-back endpoint (`/api/runs/:id/tool-results`)
- `STATE_SNAPSHOT` / `STATE_DELTA` event forwarding (agent → client)
- `CUSTOM` events for AgentPlane-specific concepts
- SDK updates to document AG-UI compatibility

### Out of Scope (Future)
- Bidirectional state sync (client → agent)
- WebSocket transport
- Protobuf binary encoding
- Sub-agent composition (`parentRunId`)
- Reasoning events (depends on Claude Agent SDK exposing chain-of-thought)
- `ACTIVITY_SNAPSHOT` / `ACTIVITY_DELTA` (needs runner instrumentation)
- AG-UI client SDK wrapper (consumers use `@ag-ui/client` directly)

## Resolved Questions

1. **Text message lifecycle tracking** — Generate UUIDs in the adapter. When the adapter sees the first `text_delta` for a new assistant turn, it generates a `messageId` UUID and emits `TEXT_MESSAGE_START`. Subsequent deltas reference the same ID. Simple, no SDK coupling.

2. **Frontend tool timeout** — 30 seconds. Frontend tools should be fast (UI actions, confirmations). If no result is POSTed back within 30s, the tool call errors and the agent continues.

3. **Stream reconnection for AG-UI** — Polling fallback only. AG-UI clients receive a `CUSTOM` `stream_detached` event and poll `/api/runs/:id`. No SSE `Last-Event-ID` support — keeps implementation simple and reuses existing infrastructure.

4. **AG-UI endpoint discovery** — Yes, add `/ag-ui/agents/:id` as a dedicated AG-UI-native endpoint. Accepts `RunAgentInput`, streams AG-UI SSE events. CopilotKit users just point `HttpAgent` at this URL. Internally routes through the same execution pipeline.
