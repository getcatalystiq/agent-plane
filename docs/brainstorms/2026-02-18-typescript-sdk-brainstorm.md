# AgentPlane TypeScript SDK

**Date:** 2026-02-18
**Status:** Brainstorm

## What We're Building

A TypeScript SDK (`agentplane` on npm) that makes it easy for developers to programmatically trigger and consume agent runs against the AgentPlane API. The primary focus is **run execution** — creating runs, streaming events via async iteration, and retrieving results. Agent CRUD and other API coverage is secondary (developers manage agents in the admin UI).

The SDK lives in `sdk/` within this monorepo, with its own `package.json`, build pipeline, and independent versioning.

## Why This Approach

- **Run-focused API** — most SDK consumers already have agents configured via the admin UI. They just need to trigger runs from their code and process results.
- **Async iterator streaming** — idiomatic modern TS/JS (`for await...of`), works everywhere (Node, Deno, Bun, edge runtimes with `fetch`), natural backpressure.
- **Transparent stream-detach handling** — the API's 4.5-minute stream detach + polling handoff is an infrastructure concern, not a developer concern. The SDK hides it completely.
- **Monorepo co-location** — keeps SDK types in sync with the API. Easier to update both together. Published independently to npm.

## Key Decisions

1. **Package name:** `agentplane`
2. **Language:** TypeScript, compiled to ESM + CJS
3. **Location:** `sdk/` directory in this repo
4. **Primary API surface:** Run creation + streaming. Agent CRUD included but secondary.
5. **Streaming DX:** Async iterator pattern (`for await...of`)
6. **Stream detach:** Handled transparently — iterator seamlessly switches from NDJSON stream to polling when `stream_detached` fires
7. **No external dependencies:** Use native `fetch` (Node 18+). Zero runtime deps.
8. **Base URL default:** `https://agentplane.vercel.app` (overridable)

## Target DX

```typescript
import { AgentPlane } from 'agentplane';

const client = new AgentPlane({ apiKey: 'ap_live_...' });

// Create and stream a run
const run = await client.runs.create({
  agentId: 'ag_...',
  prompt: 'Refactor the auth module',
});

for await (const event of run) {
  switch (event.type) {
    case 'assistant':
      console.log(event.message);
      break;
    case 'tool_use':
      console.log(`Using tool: ${event.name}`);
      break;
    case 'result':
      console.log(`Done! Cost: $${event.total_cost_usd}`);
      break;
  }
}

// Access final state
console.log(run.status);       // "completed"
console.log(run.resultSummary); // "Refactored auth module..."

// Non-streaming: just get the result
const result = await client.runs.createAndWait({
  agentId: 'ag_...',
  prompt: 'Fix the typo in README',
});
console.log(result.status); // "completed"
```

## API Surface

### Client

```typescript
new AgentPlane({
  apiKey: string;          // required
  baseUrl?: string;        // default: https://agentplane.vercel.app
  fetch?: typeof fetch;    // custom fetch implementation
})
```

### Runs (primary)

- `client.runs.create({ agentId, prompt, maxTurns?, maxBudgetUsd? })` → `Run` (async iterable + final state)
- `client.runs.createAndWait({ ... })` → `RunResult` (blocks until complete, no streaming)
- `client.runs.get(runId)` → `RunResult`
- `client.runs.list({ agentId?, status?, limit?, offset? })` → `{ data, limit, offset }`
- `client.runs.cancel(runId)` → `void`
- `client.runs.transcript(runId)` → `AsyncIterable<TranscriptEvent>`

### Agents (secondary)

- `client.agents.create({ ... })` → `Agent`
- `client.agents.get(agentId)` → `Agent`
- `client.agents.list({ limit?, offset? })` → `{ data, limit, offset }`
- `client.agents.update(agentId, { ... })` → `Agent`
- `client.agents.delete(agentId)` → `void`

### Event Types

The `Run` async iterable yields discriminated union events matching the API:

- `run_started` — includes `run_id`, `agent_id`, `model`
- `text_delta` — partial text streaming
- `assistant` — full assistant message
- `tool_use` — tool invocation
- `tool_result` — tool result
- `result` — final success/error
- `error` — error event

Internal events (`heartbeat`, `stream_detached`) are consumed by the SDK, never yielded to the developer.

## Error Handling

```typescript
import { AgentPlane, AgentPlaneError } from 'agentplane';

try {
  const run = await client.runs.create({ ... });
} catch (err) {
  if (err instanceof AgentPlaneError) {
    console.log(err.code);    // "budget_exceeded"
    console.log(err.status);  // 403
    console.log(err.message); // "Monthly budget exceeded"
  }
}
```

## Open Questions

_(None — all key decisions resolved during brainstorm)_
