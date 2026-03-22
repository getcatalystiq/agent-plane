---
title: "refactor: DRY up SDK / Admin UI overlap"
type: refactor
status: active
date: 2026-03-22
deepened: 2026-03-22
---

# refactor: DRY up SDK / Admin UI overlap

## Enhancement Summary

**Deepened on:** 2026-03-22
**Agents used:** kieran-typescript-reviewer, pattern-recognition-specialist, architecture-strategist, code-simplicity-reviewer, best-practices-researcher

### Key Changes From Original Plan
1. **Phase 1 (shared types) redesigned** — original approach (SDK imports from `src/lib/`) is architecturally unsound because SDK publishes only `dist/`. Replaced with workspace package pattern OR lightweight Zod-first approach.
2. **Phase 2 (admin client) simplified** — class-based `AdminApi` replaced with a single `adminFetch<T>` helper function (~15 lines). No abstraction surface to maintain.
3. **Phase 3 (merge routes) downgraded** — all 4 reviewers recommend AGAINST merging route handlers. Admin and tenant routes have different queries, response shapes, and security boundaries. Replaced with shared service-layer function extraction.
4. **Phase 4 (streaming) absorbed** — merged into Phase 2 as a natural extension.
5. **Bug discovered** — `RESERVED_SLUGS` only enforced in admin route, not tenant route.

### New Considerations Discovered
- SDK build boundary (tsup `rootDir: "src"`, ships `dist/` only) prevents naive cross-directory imports
- Branded types (`TenantId`) vs plain `string` IDs make "shared types" harder than it appears
- Admin routes return enriched responses (JOINs, aggregates) that differ from tenant routes — not just auth differences
- Zod schemas in `src/lib/validation.ts` already serve as a partial SSOT via `z.infer<>`
- Vercel AI SDK pattern: `noExternal` in tsup inlines workspace package types into published SDK

---

## Overview

The Admin UI (`src/app/admin/`), TypeScript SDK (`sdk/`), and server-side API routes have significant type and logic duplication. The Admin UI makes 50+ raw `fetch()` calls with inline type definitions that mirror SDK types, while admin API routes share business logic (INSERT, slugify, retry) with tenant routes. This plan consolidates maximally **without introducing leaky abstractions**.

## Problem Statement

Three duplication axes exist today:

1. **Types defined 3 times** — SDK (`sdk/src/types.ts`), server (`src/lib/types.ts`), and Admin UI (inline per-component). At least 12 interfaces are redefined in admin components: `Agent`, `AgentSkill`, `AgentPlugin`, `Tenant`/`Company`, `ApiKey`, `McpServer`, `McpConnection`, `DailyAgentStat`, `PlaygroundEvent`, `TranscriptEvent`, `Tool`, etc.

2. **50+ raw `fetch()` calls in admin UI** — no shared client, no shared error handling, no shared types. Each component handles URL construction and error parsing independently.

3. **Shared business logic duplicated across route handlers** — e.g. `slugifyName()` duplicated verbatim, INSERT-with-retry logic ~95% identical between admin and tenant agent creation.

4. **Bug: `RESERVED_SLUGS` only enforced in admin route** (`src/app/api/admin/agents/route.ts:8`), not in the tenant route (`src/app/api/agents/route.ts`). Tenants can create agents with slugs like "api" or "admin", causing routing conflicts.

## Proposed Solution

Three phases (reduced from original four), each independently shippable:

### Phase 1: Shared type enums + Admin UI type imports

**Goal:** Eliminate the 12+ inline type definitions in admin components and share simple type aliases between SDK and server.

#### Research Insight: Why NOT a full shared types file

All 4 reviewers flagged issues with the original plan of `src/lib/shared-types.ts`:

- **Build boundary:** SDK has `rootDir: "src"` (meaning `sdk/src/`) and ships only `dist/`. It cannot reference `../../src/lib/shared-types.ts` — that path doesn't exist for npm consumers.
- **Branded vs plain types:** Server uses `TenantId = string & { __brand: "TenantId" }`, SDK uses plain `string`. These are structurally incompatible — forcing a shared source would either pollute the SDK with branded types or strip the server of compile-time safety.
- **Response shape divergence:** Admin routes return enriched objects (`AgentWithTenant` with `tenant_name`, `run_count`). SDK types don't model these.

#### Approach: Two-tier sharing

**Tier 1 — Simple type aliases (SDK ↔ Server):**

Only share the handful of pure string-union types that are duplicated verbatim:

```typescript
// Option A: Workspace package (if type drift becomes a real problem)
// shared/src/index.ts
export type RunStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "timed_out";
export type RunTriggeredBy = "api" | "schedule" | "playground" | "chat" | "a2a";
export type SessionStatus = "creating" | "active" | "idle" | "stopped";
export type RunnerType = "claude-agent-sdk" | "vercel-ai-sdk";
export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan";
```

With `noExternal: ["@agent-plane/shared"]` in tsup config, these get inlined into the published SDK — npm consumers see no trace of the shared package.

```typescript
// Option B: CI drift check (if current duplication is tolerable)
// No code changes. Add a test that validates SDK types against Zod schemas.
```

**Recommendation:** Start with **Option B** (CI drift check). The duplicated type aliases are stable (they match the API wire format). Add a workspace package later only if drift becomes a recurring problem.

**Tier 2 — Admin UI imports from SDK types (eliminate inline interfaces):**

The admin UI redefines ~12 interfaces that exactly match SDK wire-format types. These can import directly from the SDK types **without using the SDK client**:

```typescript
// src/app/admin/(dashboard)/agents/[agentId]/edit-form.tsx
// BEFORE: interface Agent { id: string; name: string; ... } (20+ fields redefined)
// AFTER:
import type { Agent } from "@getcatalystiq/agent-plane";
```

This works because:
- The SDK is already in the monorepo as a workspace — add it as a dev dependency
- `import type` has zero runtime cost (erased at compile time)
- SDK types represent the wire format, which is exactly what admin components consume

**Admin UI components to update:**

| Component | Remove | Import from SDK |
|---|---|---|
| `agents/[agentId]/edit-form.tsx` | `interface Agent` | `Agent` |
| `agents/[agentId]/skills-editor.tsx` | `interface AgentSkill` | `AgentSkill` |
| `agents/[agentId]/plugins-manager.tsx` | `interface AgentPlugin` | `AgentPlugin` |
| `agents/[agentId]/connectors-manager.tsx` | `McpServer`, `McpConnection` | `CustomConnectorServer`, `CustomConnectorConnection` |
| `agents/[agentId]/tools-modal.tsx` | `interface Tool` | `ComposioTool` |
| `agents/[agentId]/mcp-tools-modal.tsx` | `interface Tool` | `CustomConnectorTool` |
| `settings/company-form.tsx` | `interface Company` | `Tenant` |
| `settings/api-keys-section.tsx` | `interface ApiKey` | (new shared type or keep) |
| `tenants/[tenantId]/api-keys.tsx` | `interface ApiKey` | (share with above) |
| `tenants/[tenantId]/edit-form.tsx` | `interface Tenant` | `Tenant` |
| `run-charts.tsx` | `interface DailyAgentStat` | `DailyAgentStat` |
| `runs/[runId]/transcript-viewer.tsx` | inline interfaces | `StreamEvent` union |
| `agents/[agentId]/playground/page.tsx` | `PlaygroundEvent` | `StreamEvent` |

**Edge cases:** Some admin components use enriched types (e.g., agent list page with `tenant_name`, `run_count`). For these, extend the SDK type:

```typescript
import type { Agent } from "@getcatalystiq/agent-plane";
interface AgentWithTenant extends Agent {
  tenant_name: string;
  run_count: number;
  last_run_at: string | null;
}
```

### Phase 2: Admin fetch helper + streaming convergence

**Goal:** Replace 50+ raw `fetch()` calls with a single typed helper. Share NDJSON parsing.

#### Research Insight: Why a helper function, not a class

All reviewers recommended against a class:
- Admin UI calls are always same-origin, always use cookie auth (no configurable state)
- A class with per-resource methods creates a parallel type surface that must be maintained
- Simple exported function is easier to tree-shake and test

```typescript
// src/app/admin/lib/api.ts (~20 lines)

export class AdminApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "AdminApiError";
  }
}

export async function adminFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/admin${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const err = body?.error;
    throw new AdminApiError(res.status, err?.message ?? res.statusText, err?.code);
  }
  return res.json();
}
```

**Usage in components:**

```typescript
// BEFORE (edit-form.tsx)
const res = await fetch(`/api/admin/agents/${agent.id}`, {
  method: "PUT",
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify(body),
});
if (!res.ok) { /* inline error handling */ }
const data = await res.json();

// AFTER
import { adminFetch } from "@/app/admin/lib/api";
const data = await adminFetch<Agent>(`/agents/${agent.id}`, {
  method: "PUT",
  body: JSON.stringify(body),
});
```

**Streaming helper** (for playground NDJSON):

```typescript
// src/app/admin/lib/api.ts (add to same file)
export async function adminStream(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`/api/admin${path}`, init);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new AdminApiError(res.status, body?.error?.message ?? res.statusText);
  }
  return res;
}
```

The playground can then use `parseNdjsonStream` from the SDK (imported as workspace dependency) or keep its own inline parser if the SDK import proves problematic.

**Impact:** ~50 fetch calls replaced, centralized error handling, ~100 LOC saved across admin components.

### Phase 3: Extract shared service functions

**Goal:** DRY the duplicated business logic between admin and tenant route handlers WITHOUT merging the route files themselves.

#### Research Insight: Why NOT merge route handlers

All 4 reviewers independently recommended against merging:

| Concern | Tenant Route | Admin Route |
|---|---|---|
| Auth | `authenticateApiKey()` + RLS | JWT cookie, no RLS |
| Query scope | `WHERE tenant_id = $1` | `JOIN tenants t ON t.id = a.tenant_id` |
| Response shape | `AgentRow` | `AgentWithTenant` (includes `tenant_name`, `run_count`) |
| Input schema | `CreateAgentSchema` | `AdminCreateAgentSchema` (adds `tenant_id`) |
| Error handling | Standard | Includes tenant existence check |

> "The duplication here is the RIGHT kind of duplication. Each route file is under 200 lines, easy to understand in isolation, and has clear security boundaries." — TypeScript Reviewer

**Instead, extract the genuinely shared business logic into service functions:**

```typescript
// src/lib/agents.ts (add to existing file)

/** Slugify a name for URL-safe usage. */
export function slugifyName(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
}

const RESERVED_SLUGS = new Set(["well-known", "api", "admin", "health", "jsonrpc"]);

/** Check if a slug is reserved. */
export function isReservedSlug(slug: string): boolean {
  return RESERVED_SLUGS.has(slug);
}

/** Insert agent with retry on duplicate name/slug. */
export async function createAgentRecord(
  tenantId: string,
  input: CreateAgentInput,
): Promise<string> {
  const id = generateId();
  const rawSlug = input.slug ?? (slugifyName(input.name) || `agent-${id.slice(0, 8)}`);

  let name = input.name;
  let slug = rawSlug;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      await execute(/* INSERT SQL */, [id, tenantId, name, slug, ...]);
      return id;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "";
      if (msg.includes("agents_tenant_id_name_key") && attempt < 4) {
        name = `${input.name}-${attempt + 2}`;
        slug = `${rawSlug}-${attempt + 2}`;
        continue;
      }
      throw err;
    }
  }
  return id; // unreachable but satisfies TS
}
```

```typescript
// src/lib/sql-helpers.ts (new — extracted dynamic SET builder)
export function buildDynamicUpdate(
  fields: Record<string, unknown>,
  jsonbFields?: Set<string>,
): { setClauses: string[]; params: unknown[]; nextIdx: number } {
  // ... shared SET clause builder used by both admin and tenant PATCH routes
}
```

**Functions to extract:**

| Function | Source (duplicated in) | Target |
|---|---|---|
| `slugifyName()` | admin agents route, tenant agents route | `src/lib/agents.ts` |
| `RESERVED_SLUGS` + validation | admin agents route ONLY (bug: missing from tenant) | `src/lib/agents.ts` (fix bug: apply to both) |
| INSERT-with-retry | admin agents route, tenant agents route | `src/lib/agents.ts` |
| Dynamic SET builder | admin agent PATCH, tenant agent PUT | `src/lib/sql-helpers.ts` |

**Bug fix:** Add `isReservedSlug()` check to tenant `POST /api/agents` route.

**Route files become thin wrappers:** authenticate → call shared function → format response. Each stays under 100 lines with explicit security boundaries.

## System-Wide Impact

- **No API wire format changes** — purely internal refactoring
- **No DB changes** — no migrations needed
- **Admin UI components become thinner** — shared types, centralized fetch
- **SDK stays backward-compatible** — public API unchanged
- **Bug fixed** — reserved slugs enforced on both admin and tenant routes
- **Route security boundaries preserved** — no merged handlers with implicit auth

## Acceptance Criteria

### Phase 1: Shared Types
- [ ] Admin UI components import types from SDK package (`import type` only)
- [ ] Zero inline interface definitions that duplicate SDK types
- [ ] Admin-specific enriched types extend SDK types (not redefine)
- [ ] `npm run build` passes
- [ ] `npm run sdk:typecheck` passes
- [ ] Optional: CI test validates SDK types match Zod schemas

### Phase 2: Admin Fetch Helper
- [ ] Create `src/app/admin/lib/api.ts` with `adminFetch<T>` + `AdminApiError`
- [ ] Replace all raw `fetch('/api/admin/...')` calls in admin components
- [ ] Centralized error handling via `AdminApiError`
- [ ] Zero `fetch('/api/admin/` strings remain in admin component files
- [ ] Playground NDJSON parsing uses shared `adminStream` helper

### Phase 3: Shared Service Functions
- [ ] `slugifyName()` extracted to `src/lib/agents.ts` — no duplicates
- [ ] `isReservedSlug()` enforced in BOTH admin and tenant agent creation routes
- [ ] `createAgentRecord()` shared between admin and tenant POST routes
- [ ] `buildDynamicUpdate()` extracted to `src/lib/sql-helpers.ts`
- [ ] All existing tests pass unchanged
- [ ] Route handler files < 100 lines each after extraction

## Dependencies & Risks

- **Phase 1 is low risk** — `import type` is compile-time only; requires SDK as workspace devDependency
- **Phase 2 is low risk** — swapping fetch calls one component at a time; easily testable visually
- **Phase 3 is medium risk** — extracting INSERT logic must preserve retry semantics and error handling exactly; the reserved-slugs bug fix changes tenant API behavior (could reject previously-valid slugs)

**Recommended order:** Phase 2 → Phase 1 → Phase 3

Phase 2 first because it gives immediate DX improvement (centralized errors, less boilerplate) with zero risk. Phase 1 next for type safety. Phase 3 last since it touches route handlers.

## Rejected Approaches

### Using SDK client directly in admin UI
Rejected by architecture reviewer. The SDK enforces HTTPS, uses Bearer auth (admin uses cookies), hardcodes `/api/` paths (admin needs `/api/admin/`), and doesn't model admin-enriched response types. Adapting the SDK would add complexity that serves only one consumer.

### Merging admin + tenant route handlers
Rejected by all 4 reviewers. Routes differ in auth, query scope, response shape, and input schema. A factory/strategy pattern would create a God Function with implicit security boundaries — worse than explicit duplication.

### Full shared types package (workspace)
Deferred. The 5 duplicated type aliases (`RunStatus`, `RunTriggeredBy`, etc.) are stable string unions. A workspace package adds overhead (package.json, tsconfig, tsup config change) for minimal value. If type drift becomes a recurring issue, follow the pattern in `docs/research-shared-types-monorepo.md`.

## Sources & References

- SDK types: `sdk/src/types.ts` (505 lines, 30+ interfaces)
- SDK build: `sdk/tsconfig.json` (`rootDir: "src"`), tsup builds ESM+CJS+DTS
- Server types: `src/lib/types.ts` (branded IDs + domain types)
- Admin agent route: `src/app/api/admin/agents/route.ts`
- Tenant agent route: `src/app/api/agents/route.ts` (missing RESERVED_SLUGS check)
- Validation schemas: `src/lib/validation.ts` (Zod schemas, `z.infer<>` types)
- Research: `docs/research-shared-types-monorepo.md` (workspace package patterns, Vercel AI SDK reference)
- Admin UI components with inline types: edit-form.tsx, skills-editor.tsx, plugins-manager.tsx, connectors-manager.tsx, company-form.tsx, api-keys-section.tsx, run-charts.tsx, transcript-viewer.tsx, playground/page.tsx
