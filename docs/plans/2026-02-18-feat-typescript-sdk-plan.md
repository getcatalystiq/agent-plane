---
title: "feat: TypeScript SDK for AgentPlane"
type: feat
status: active
date: 2026-02-18
deepened: 2026-02-18
brainstorm: docs/brainstorms/2026-02-18-typescript-sdk-brainstorm.md
---

# feat: TypeScript SDK for AgentPlane

## Enhancement Summary

**Deepened on:** 2026-02-18
**Agents used:** kieran-typescript-reviewer, architecture-strategist, performance-oracle, security-sentinel, code-simplicity-reviewer

### Key Improvements
1. **Simplified RunStream** — dropped `PromiseLike` dual interface; `RunStream` is `AsyncIterable` only, `createAndWait()` is the explicit await path
2. **Simplified error handling** — single `AgentPlaneError` class with `code`/`status` fields instead of 9 subclasses
3. **Simplified stream detach** — RunStream yields `stream_detached` event and stops; `createAndWait()` handles detach→poll→resume internally
4. **Security hardening** — HTTPS enforcement, bounded NDJSON buffer, API key protection, error response size limits
5. **Scoped v1 surface** — ships with `runs` + `agents` only; `keys` + `tenants` added later if requested

### New Considerations Discovered
- `text_delta` events exist in live stream but NOT in transcript — event counting for dedup is broken; use timestamp-based approach
- `TextDecoder` `stream` option goes on `.decode()` call, not the constructor
- Circular dependency risk between `streaming.ts` and `resources/runs.ts` — solved via dependency injection
- Browser environments have 6-connection-per-host limit affecting concurrent streams

---

## Overview

Ship `agentplane` — a zero-dependency TypeScript SDK that wraps the AgentPlane REST API. The primary focus is run execution with async-iterable NDJSON streaming. The SDK lives in `sdk/` within this monorepo, published independently to npm.

## Problem Statement

There's no client library for the AgentPlane API. Developers must hand-roll `fetch` calls, parse NDJSON line-by-line, handle the 4.5-minute stream-detach-to-polling transition, and map error codes to exceptions. This is tedious and error-prone — especially the streaming contract.

## Proposed Solution

A thin, typed SDK that handles:
1. Authentication (Bearer token from constructor or `AGENTPLANE_API_KEY` env var)
2. NDJSON stream parsing with proper UTF-8/chunk boundary handling
3. Stream-detach → polling transition (transparent in `createAndWait`, explicit in `create`)
4. Typed errors with `status` and `code` fields matching the API's `{ error: { code, message } }` shape
5. Pagination helpers with `hasMore` computed field
6. `AbortController` cleanup on early iterator break

## Technical Approach

### Architecture

```
sdk/
├── package.json           # "agentplane", exports ESM + CJS
├── tsconfig.json          # strict, declaration: true, exactOptionalPropertyTypes
├── tsup.config.ts         # dual ESM/CJS build
├── src/
│   ├── index.ts           # explicit named re-exports
│   ├── client.ts          # AgentPlane class (constructor, HTTP helpers)
│   ├── types.ts           # Agent, Run, StreamEvent, Pagination, etc.
│   ├── errors.ts          # AgentPlaneError + StreamDisconnectedError
│   ├── streaming.ts       # NDJSON parser + RunStream (AsyncIterable only)
│   └── resources/
│       ├── runs.ts        # create, createAndWait, get, list, cancel, transcript
│       └── agents.ts      # create, get, list, update, delete
├── tests/
│   ├── client.test.ts
│   ├── streaming.test.ts
│   └── resources/
│       ├── runs.test.ts
│       └── agents.test.ts
├── vitest.config.ts
└── README.md
```

### Research Insights: Architecture

**Dependency injection for RunStream** (architecture review): RunStream needs to poll runs and fetch transcripts after stream detach. To avoid a circular dependency between `streaming.ts` and `resources/runs.ts`, pass these as constructor callbacks:

```typescript
// resources/runs.ts creates RunStream with injected deps
new RunStream(
  response,
  (id) => this.get(id),             // pollRun
  (id) => this._fetchTranscript(id), // fetchTranscript
  signal,
);
```

**Single types.ts is correct** for this API surface (~15-20 interfaces). Split into per-resource type files only if MCP servers, connections, or plugins are added later.

**Resource namespace pattern** (`client.runs`, `client.agents`) is the right abstraction — matches Stripe/OpenAI conventions. Use `client.runs.list({ agent_id })` as the single path for listing runs (don't also wrap the agent-scoped `/api/agents/:id/runs` endpoint).

---

### Implementation Phases

#### Phase 1: Foundation (`sdk/` scaffold + client + errors + types)

Set up the package, define all TypeScript types mirroring the API, implement the HTTP client core, and error handling.

**Tasks:**

- [ ] `sdk/package.json`:
  ```json
  {
    "name": "agentplane",
    "type": "module",
    "exports": {
      ".": {
        "import": { "types": "./dist/index.d.ts", "default": "./dist/index.js" },
        "require": { "types": "./dist/index.d.cts", "default": "./dist/index.cjs" }
      }
    },
    "main": "./dist/index.cjs",
    "module": "./dist/index.js",
    "types": "./dist/index.d.ts",
    "files": ["dist"],
    "sideEffects": false,
    "engines": { "node": ">=18" }
  }
  ```
  Note: `types` condition MUST come first in each export branch — TypeScript resolves the first matching condition. `sideEffects: false` enables tree-shaking. `files: ["dist"]` prevents publishing source/tests/env files.

- [ ] `sdk/tsconfig.json`:
  ```json
  {
    "compilerOptions": {
      "target": "ES2022",
      "module": "ESNext",
      "moduleResolution": "bundler",
      "strict": true,
      "exactOptionalPropertyTypes": true,
      "noUncheckedIndexedAccess": true,
      "declaration": true,
      "declarationMap": true,
      "isolatedModules": true,
      "esModuleInterop": true,
      "skipLibCheck": true,
      "outDir": "dist",
      "rootDir": "src"
    },
    "include": ["src"]
  }
  ```
  `exactOptionalPropertyTypes` prevents `undefined` on optional properties. `noUncheckedIndexedAccess` adds `| undefined` to index access — catches real bugs in NDJSON parsing.

- [ ] `sdk/tsup.config.ts`:
  ```typescript
  import { defineConfig } from "tsup";
  export default defineConfig({
    entry: ["src/index.ts"],
    format: ["esm", "cjs"],
    dts: true,
    clean: true,
    splitting: false,  // single output file per format
    sourcemap: true,
  });
  ```

- [ ] `sdk/src/types.ts` — TypeScript interfaces using **snake_case matching the API wire format**:
  - `AgentPlaneOptions` — `{ apiKey?: string, baseUrl?: string, fetch?: typeof globalThis.fetch }`
  - `Agent` — mirrors `AgentRow` from server's `validation.ts:231-251`
  - `CreateAgentParams` / `UpdateAgentParams`
  - `Run` — mirrors `RunRow` from server's `validation.ts:368-391`
  - `CreateRunParams` — `{ agent_id, prompt, max_turns?, max_budget_usd? }`
  - `StreamEvent` — discriminated union (see below)
  - `PaginatedResponse<T>` — `{ data: T[], limit: number, offset: number, has_more: boolean }`
  - `PaginationParams` — `{ limit?: number, offset?: number }`
  - `ListRunsParams` — extends `PaginationParams` with `agent_id?`, `status?`
  - `RunStatus` — `"pending" | "running" | "completed" | "failed" | "cancelled" | "timed_out"`

  **StreamEvent discriminated union** with forward-compatible `UnknownEvent`:
  ```typescript
  type StreamEvent =
    | RunStartedEvent
    | TextDeltaEvent
    | AssistantEvent
    | ToolUseEvent
    | ToolResultEvent
    | ResultEvent
    | ErrorEvent
    | StreamDetachedEvent  // yielded to user (not hidden)
    | UnknownEvent;        // forward compatibility

  interface UnknownEvent {
    type: string;
    [key: string]: unknown;
  }
  ```

  **Research insight (TypeScript review):** Define separate internal `RawStreamEvent` type (includes `heartbeat`) and public `StreamEvent` (excludes it). The NDJSON parser yields `unknown`, then a separate layer narrows to `StreamEvent`. This keeps the parser pure and testable.

- [ ] `sdk/src/errors.ts` — **single `AgentPlaneError` + `StreamDisconnectedError`**:
  ```typescript
  class AgentPlaneError extends Error {
    readonly code: string;
    readonly status: number;

    constructor(code: string, status: number, message: string) {
      super(message);
      this.name = "AgentPlaneError";
      this.code = code;
      this.status = status;
    }

    static fromResponse(status: number, body: { error: { code: string; message: string } }): AgentPlaneError {
      return new AgentPlaneError(body.error.code, status, body.error.message);
    }
  }

  class StreamDisconnectedError extends AgentPlaneError {
    readonly run_id: string;
    constructor(run_id: string) {
      super("stream_disconnected", 0, `Stream disconnected for run ${run_id}`);
      this.run_id = run_id;
    }
  }
  ```

  Users discriminate by `code` field: `if (err.code === "budget_exceeded")`. No need for 9 subclasses — the server's class hierarchy is a server-side dispatch concern.

- [ ] `sdk/src/client.ts` — `AgentPlane` class:
  - Constructor: `new AgentPlane({ apiKey?, baseUrl?, fetch? })`
    - Reads `AGENTPLANE_API_KEY` env if no `apiKey`
    - **HTTPS enforcement** (security): reject non-HTTPS URLs unless `localhost`/`127.0.0.1`
    - Strip trailing slashes from `baseUrl`
    - Store auth header in closure (not class property) to prevent leaking in `JSON.stringify`/`console.log`
    - Custom `[Symbol.for('nodejs.util.inspect.custom')]` and `toJSON()` to hide credentials
  - **User-Agent header**: set `User-Agent: agentplane-sdk/X.Y.Z` on all requests
  - Internal `_request<T>(method, path, opts?)`: sets `Authorization`, handles JSON, checks `response.ok`, throws `AgentPlaneError` on non-2xx
    - **Bounded error body** (security): read at most 64KB for error responses to prevent memory exhaustion from malicious servers
  - Internal `_requestStream(method, path, opts?)`: returns raw `Response` for streaming
  - Exposes `this.runs` and `this.agents` as resource namespaces
  - `AbortSignal` support on `runs.create()` and `runs.createAndWait()` only (not CRUD methods — they're sub-second)

- [ ] `sdk/src/index.ts` — **explicit named exports** (not `export *`):
  ```typescript
  export { AgentPlane } from "./client";
  export type { AgentPlaneOptions } from "./types";
  export type { Agent, Run, RunStatus, StreamEvent, /* ... */ } from "./types";
  export { AgentPlaneError, StreamDisconnectedError } from "./errors";
  export type { RunStream } from "./streaming";
  ```

**Files:** `sdk/package.json`, `sdk/tsconfig.json`, `sdk/tsup.config.ts`, `sdk/src/index.ts`, `sdk/src/client.ts`, `sdk/src/types.ts`, `sdk/src/errors.ts`

#### Phase 2: NDJSON Streaming Core (`sdk/src/streaming.ts`)

The hardest part. Implement the NDJSON parser and the async-iterable `RunStream` class.

**Tasks:**

- [ ] NDJSON parser as a standalone async generator:
  ```typescript
  async function* parseNdjsonStream(
    body: ReadableStream<Uint8Array>,
    signal?: AbortSignal,
  ): AsyncGenerator<unknown> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        if (signal?.aborted) break;
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true }); // stream option on decode(), NOT constructor

        // SECURITY: prevent unbounded buffer from server that never sends newlines
        if (!buffer.includes("\n") && buffer.length > 1_048_576) {
          throw new Error("NDJSON line exceeded 1MB limit");
        }

        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try { yield JSON.parse(trimmed); } catch { /* skip malformed lines */ }
        }
      }
      // Flush decoder and remaining buffer
      buffer += decoder.decode();
      const remaining = buffer.trim();
      if (remaining) {
        try { yield JSON.parse(remaining); } catch { /* skip */ }
      }
    } finally {
      reader.releaseLock();
    }
  }
  ```
  Returns `unknown` — type narrowing happens in RunStream.

- [ ] `RunStream` class — **`AsyncIterable<StreamEvent>` only** (no `PromiseLike`):
  - Constructor takes `Response`, injected `pollRun` and `fetchTranscript` callbacks, and optional `AbortSignal`
  - Creates internal `AbortController` linked to external signal
  - Filters `heartbeat` events (never yielded)
  - Extracts `run_id` from first `run_started` event, exposes as `stream.run_id`
  - **Yields `stream_detached` event to the user** and stops iteration (user can poll and fetch transcript manually)
  - `return()` on the async iterator aborts the underlying fetch via `AbortController`
  - Implements `[Symbol.asyncDispose]` for `using` syntax support
  - Network drops throw `StreamDisconnectedError` with `run_id`
  - `consumed` flag — throw if someone tries to iterate twice

- [ ] Tests for streaming:
  - Happy path: mock fetch returns NDJSON lines → events yielded in order
  - Heartbeat filtering: heartbeat lines not yielded
  - `stream_detached` yielded to user, iteration stops
  - Partial chunk handling: chunks split mid-line and mid-UTF8 character
  - Bounded buffer: line > 1MB throws
  - Early break: iterator `return()` triggers abort
  - Network drop: response body throws → `StreamDisconnectedError`
  - Double iteration: throws "already consumed"
  - Malformed JSON line: skipped, not crashed

**Files:** `sdk/src/streaming.ts`, `sdk/tests/streaming.test.ts`

#### Phase 3: Resource Methods (runs, agents)

Wire up the typed resource methods that call the HTTP client.

**Tasks:**

- [ ] `sdk/src/resources/runs.ts`:
  - `create(params: CreateRunParams, opts?)` → `RunStream`
    - Sends `POST /api/runs` with `{ agent_id, prompt, max_turns?, max_budget_usd? }`
    - Checks `response.ok` before passing to RunStream (throw on non-200)
    - Passes response to RunStream with injected polling deps
  - `createAndWait(params: CreateRunParams, opts?)` → `Promise<Run>`
    - **Handles detach→poll→resume internally**:
      1. Iterates the stream
      2. If `stream_detached` event received, polls `GET /api/runs/:id` every 3s with exponential backoff (3s, 6s, 10s cap) using **timestamp-based** approach
      3. Once terminal, returns `runs.get(runId)` result
    - Discards events as they arrive — only retains last `result` event (no memory accumulation)
    - Uses `AbortSignal.timeout(timeoutMs)` (default 10 min — matches sandbox limit)
  - `get(runId: string)` → `Promise<Run>`
  - `list(params?: ListRunsParams)` → `Promise<PaginatedResponse<Run>>`
    - Computes `has_more` from `data.length === limit`
  - `cancel(runId: string)` → `Promise<{ cancelled: boolean }>`
    - Returns `{ cancelled: true }` on 200
    - Returns `{ cancelled: false }` on 409 — does NOT throw
  - `transcript(runId: string)` → `AsyncIterable<StreamEvent>`

- [ ] `sdk/src/resources/agents.ts`:
  - `create(params: CreateAgentParams)` → `Promise<Agent>`
  - `get(agentId: string)` → `Promise<Agent>`
  - `list(params?: PaginationParams)` → `Promise<PaginatedResponse<Agent>>`
  - `update(agentId: string, params: UpdateAgentParams)` → `Promise<Agent>`
  - `delete(agentId: string)` → `Promise<void>`

- [ ] Tests: mock `_request` / `_requestStream` at the client level, verify correct paths, query params, body shapes, and response mapping

**Files:** `sdk/src/resources/runs.ts`, `sdk/src/resources/agents.ts`, `sdk/tests/resources/runs.test.ts`, `sdk/tests/resources/agents.test.ts`

#### Phase 4: Build, Test, README

**Tasks:**

- [ ] `sdk/vitest.config.ts` — configure for `sdk/tests/`
- [ ] Verify `tsup` build produces valid ESM + CJS + `.d.ts` + `.d.cts` output
- [ ] `sdk/README.md` — concise docs covering:
  - Installation (`npm install agentplane`)
  - Quick start (create client → create run → stream events)
  - `createAndWait()` convenience method
  - Error handling (single class, `code` field discrimination)
  - Stream detach behavior (yielded as event; `createAndWait` handles automatically)
  - `runs.transcript()` for post-run retrieval
  - `text_delta` availability (live stream only, not in transcript)
  - Environment variable support (`AGENTPLANE_API_KEY`)
- [ ] Run full test suite
- [ ] Add build/test scripts to root `package.json` (`npm run sdk:build`, `npm run sdk:test`)

**Files:** `sdk/vitest.config.ts`, `sdk/README.md`

---

## Key Design Decisions

| Decision | Choice | Rationale |
|---|---|---|
| Streaming DX | Async iterator only | Idiomatic TS/JS, natural backpressure. Dropped `PromiseLike` — `createAndWait()` is the explicit await path. Dual interface is a footgun (confuses `await` vs `for await`). |
| Stream detach | Yielded to user in `create()`; hidden in `createAndWait()` | Gives advanced users explicit control. `createAndWait()` handles it automatically for simple use cases. Avoids fragile event-counting dedup. |
| Dependencies | Zero runtime deps | Native `fetch` (Node 18+), minimizes bundle size |
| Property casing | snake_case matching API wire format | Eliminates transform layer (~80 LOC), removes bug surface, keeps types derivable from server schemas, avoids API docs ↔ SDK type confusion |
| Error handling | Single `AgentPlaneError` with `code`/`status` + `StreamDisconnectedError` | SDK receives JSON, not exceptions. Users discriminate by `code` field. No need to mirror server's class hierarchy. |
| Cancel on terminal run | Return `{ cancelled: false }` | 409 is expected, not exceptional |
| API key protection | Closure storage, custom inspect/toJSON | Prevents leaking in `console.log`, `JSON.stringify`, heap dumps |
| HTTPS enforcement | Reject non-HTTPS except localhost | Prevents credential theft over plaintext HTTP |
| Module format | ESM + CJS dual | Maximum compatibility. `types` first in exports, `sideEffects: false` |
| Response validation | TypeScript types only, no runtime Zod | Keeps bundle tiny. Lightweight assertions on critical fields (id, status). |
| Polling interval | 3s with exponential backoff (3s, 6s, 10s cap) | 2s too aggressive for runs that already exceeded 4.5 min. 3s start reduces API calls ~40%. |
| NDJSON buffer | Bounded at 1MB per line | Prevents memory exhaustion from malicious server that never sends newlines |
| v1 scope | `runs` + `agents` only | Keys and tenants are admin-time concerns, not runtime SDK workflows. Add later if requested. |
| `AbortSignal` | On `create()` and `createAndWait()` only | Sub-second CRUD methods don't need cancellation. |
| `UnknownEvent` fallback | Included in `StreamEvent` union | Forward-compatible: unknown event types from future API versions don't crash old SDK versions |

---

## Target DX

```typescript
import { AgentPlane, AgentPlaneError } from "agentplane";

const client = new AgentPlane({ apiKey: "ap_live_..." });
// or: new AgentPlane() reads AGENTPLANE_API_KEY from env

// Stream events
const stream = client.runs.create({
  agent_id: "ag_...",
  prompt: "Refactor the auth module",
});

for await (const event of stream) {
  switch (event.type) {
    case "assistant":
      console.log(event.message);
      break;
    case "tool_use":
      console.log(`Using tool: ${event.name}`);
      break;
    case "result":
      console.log(`Done! Cost: $${event.total_cost_usd}`);
      break;
    case "stream_detached":
      // Long-running run — poll for completion
      let run = await client.runs.get(stream.run_id!);
      while (run.status === "running" || run.status === "pending") {
        await new Promise((r) => setTimeout(r, 5000));
        run = await client.runs.get(stream.run_id!);
      }
      // Fetch remaining events from transcript
      for await (const evt of client.runs.transcript(stream.run_id!)) {
        console.log(evt);
      }
      break;
  }
}

// Or just wait for the result (handles detach automatically)
const run = await client.runs.createAndWait({
  agent_id: "ag_...",
  prompt: "Fix the typo in README",
});
console.log(run.status);         // "completed"
console.log(run.result_summary); // "Fixed typo..."

// Error handling
try {
  await client.runs.createAndWait({ agent_id: "ag_...", prompt: "..." });
} catch (err) {
  if (err instanceof AgentPlaneError) {
    console.log(err.code);    // "budget_exceeded"
    console.log(err.status);  // 403
    console.log(err.message); // "Monthly budget exceeded"
  }
}
```

---

## Security Considerations

| Priority | Finding | Mitigation |
|---|---|---|
| Critical | No HTTPS enforcement on base URL | Reject non-HTTPS except localhost/127.0.0.1 |
| Critical | Unbounded NDJSON buffer | 1MB max line length guard in parser |
| High | API key as plaintext class property | Store in closure; custom inspect/toJSON hide credentials |
| High | Error response body unbounded | Read at most 64KB for non-streaming responses |
| Medium | Custom fetch intercepts credentials | Document security implications |
| Low | JSON.parse crash kills stream | try/catch per line, skip malformed |
| Low | npm supply chain | 2FA, `npm publish --provenance`, `files` whitelist |

---

## Acceptance Criteria

### Functional Requirements

- [ ] `new AgentPlane({ apiKey })` initializes with API key (or env var fallback)
- [ ] HTTPS enforced on base URL (localhost exempt)
- [ ] `client.runs.create()` returns `RunStream` (async iterable of `StreamEvent`)
- [ ] Heartbeats filtered, never yielded
- [ ] `stream_detached` yielded as an event in `create()`; handled automatically in `createAndWait()`
- [ ] `client.runs.createAndWait()` blocks until run completes and returns `Run`
- [ ] All CRUD methods for agents and runs work correctly
- [ ] `client.runs.cancel()` returns `{ cancelled: false }` on 409 (not throw)
- [ ] API errors throw `AgentPlaneError` with `status`, `code`, `message`
- [ ] Early `break` from `for await` cleans up the stream via `AbortController`
- [ ] Pagination responses include computed `has_more` field
- [ ] NDJSON buffer bounded at 1MB per line
- [ ] Error response body bounded at 64KB
- [ ] API key not visible via console.log/JSON.stringify on client instance

### Non-Functional Requirements

- [ ] Zero runtime dependencies
- [ ] Works in Node 18+, Deno, Bun
- [ ] Dual ESM + CJS output with TypeScript declarations
- [ ] Package size < 15KB minified (reduced from 20KB after simplifications)
- [ ] `User-Agent: agentplane-sdk/X.Y.Z` header on all requests

### Quality Gates

- [ ] Unit tests for streaming (happy path, detach, partial chunks, bounded buffer, early break, network drop, double iteration, malformed JSON)
- [ ] Unit tests for each resource method
- [ ] `tsup` build succeeds with no errors
- [ ] TypeScript strict mode + `exactOptionalPropertyTypes` + `noUncheckedIndexedAccess`
- [ ] No `any` types in public API
- [ ] No credentials in error messages (redact to prefix only)

---

## References

### Internal

- Brainstorm: `docs/brainstorms/2026-02-18-typescript-sdk-brainstorm.md`
- Server streaming: `src/lib/streaming.ts`
- Stream events: `src/lib/sandbox.ts:189-295`
- Validation schemas: `src/lib/validation.ts`
- Error types: `src/lib/errors.ts`
- Run routes: `src/app/api/runs/route.ts`
- Auth middleware: `src/middleware.ts:76-84`

### Known Server-Side Issues (not blocking SDK, but worth noting)

- `retryAfter` on `RateLimitError` is not serialized to JSON response (`src/lib/errors.ts:67`)
- No `total` count in paginated responses
- No idempotency key support on `POST /api/runs` (module exists at `src/lib/idempotency.ts` but unused)
- `text_delta` events excluded from transcript (`src/lib/sandbox.ts:256`) — documented in SDK README
- Auth module (`src/lib/auth.ts:23`) throws plain `Error` instead of `AuthError`, causing 500s instead of 401s in some paths
