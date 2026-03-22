---
title: "Pattern Review of Refactoring Plan 001"
type: review
status: complete
date: 2026-03-22
reviews: 2026-03-22-001-refactor-dry-up-sdk-admin-ui-overlap-plan.md
---

# Pattern Review: DRY Up SDK / Admin UI Overlap

## 1. Naming Convention Inconsistencies (snake_case vs camelCase)

The plan proposes shared types but does not address the **mixed casing convention**
that already exists in the codebase and will propagate further:

- **Wire types are snake_case**: `tenant_id`, `max_budget_usd`, `triggered_by`,
  `created_at`, `cost_usd`, `transcript_blob_url` (SDK `types.ts`, DB rows, API JSON).
- **Server-internal types use camelCase**: `TokenExchangeResult` has `accessToken`,
  `refreshToken`, `expiresAt`. `ScheduleConfig` uses `dayOfWeek`.
- **Zod schemas mirror DB columns** (snake_case) but some validation schemas mix:
  `CreateAgentSchema` fields are snake_case, yet `ScheduleConfig.dayOfWeek` is camelCase.

**Recommendation**: The shared-types file should explicitly document the convention:
wire-format types are **always snake_case** (matching JSON and DB). Add a comment
header to `shared-types.ts` stating this. `ScheduleConfig.dayOfWeek` should become
`day_of_week` for consistency -- or keep it camelCase with an explicit "client-only
types use camelCase" rule. Pick one and enforce it. Currently the plan silently
inherits the inconsistency.

## 2. Route Handler Merge: Abstraction Level Concerns

The plan's Phase 3 proposes `createAgentHandler(authStrategy: 'api-key' | 'admin')`.
This is **too coarse**. The actual divergence between admin and tenant routes goes
beyond auth:

- **Admin GET /agents** joins `tenants` table, adds `tenant_name`, `run_count`,
  `last_run_at` (aggregate query). Tenant GET /agents does a simple `SELECT *`
  with RLS.
- **Admin POST /agents** accepts `tenant_id` in body, validates tenant exists,
  returns 409 on slug conflict. Tenant POST /agents gets `tenantId` from auth,
  has no slug conflict response, logs via `logger.info`.
- **Admin uses `NextResponse.json()`** directly; tenant routes use the `jsonResponse()`
  helper from `src/lib/api.ts`.

**Recommendation**: Instead of a strategy parameter, use a **shared core function**
pattern:

```typescript
// src/lib/route-handlers/agents.ts
export async function createAgent(tenantId: TenantId, input: CreateAgentInput): Promise<Agent> {
  // shared: id generation, slugify, INSERT, retry loop
}

export async function listAgents(tenantId: TenantId, pagination: Pagination): Promise<Agent[]> {
  // shared: basic SELECT with pagination
}
```

Each route file remains thin (5-10 lines) -- does its own auth, calls the shared
function, formats the response its own way. The admin route can add the JOIN for
`tenant_name`/`run_count` as a separate enrichment step. This avoids a God Function
that tries to handle both cases via branching.

## 3. Zod Schemas as Single Source of Truth

The plan proposes TypeScript interfaces in `shared-types.ts` as the canonical types,
but the codebase **already derives types from Zod schemas** in `validation.ts`:

```typescript
export type PluginMarketplace = z.infer<typeof PluginMarketplaceRow>;
```

The `AgentRow` Zod schema is used for runtime DB row validation in `query()` calls.
Creating parallel TypeScript interfaces in `shared-types.ts` reintroduces the
duplication problem the plan aims to solve -- now between Zod schemas and TS interfaces.

**Recommendation**: Make Zod schemas the single source of truth. Define response
schemas in `shared-types.ts` as Zod objects and export inferred types:

```typescript
export const AgentSchema = z.object({ id: z.string(), name: z.string(), ... });
export type Agent = z.infer<typeof AgentSchema>;
```

The SDK can re-export the inferred types (without the Zod dependency) via a
`types-only` export. This gives you runtime validation AND compile-time types
from one definition. The current `AgentRow` in `validation.ts` already does this
for server-side; extend the pattern to wire types.

## 4. Pattern Duplication the Plan Missed

### 4a. `slugifyName()` duplicated verbatim (caught by plan)
Located in both `/Users/marmarko/code/agent-plane/src/app/api/agents/route.ts` (line 11)
and `/Users/marmarko/code/agent-plane/src/app/api/admin/agents/route.ts` (line 10).
The plan correctly identifies this. Extract to `src/lib/utils.ts`.

### 4b. NDJSON parsing duplicated in playground (caught by plan, underscoped)
The playground at `src/app/admin/(dashboard)/agents/[agentId]/playground/page.tsx`
has TWO separate `getReader()` + buffer-split loops (lines 252 and 372) -- one for
session streaming, one for one-shot runs. The plan proposes sharing with the SDK
parser but does not note this intra-file duplication. Both loops should call a
single shared `parseNdjsonStream()`.

### 4c. RESERVED_SLUGS not shared
`RESERVED_SLUGS` is defined only in the admin route
(`/Users/marmarko/code/agent-plane/src/app/api/admin/agents/route.ts`, line 8)
but NOT in the tenant route. This means the tenant API will happily create an agent
with slug "api" or "admin", which could cause routing conflicts. This is a **bug**,
not just duplication. Extract to a shared constant and enforce in both routes.

### 4d. Error response format inconsistency
Admin routes return `{ error: { code: "...", message: "..." } }` structure (e.g.,
the admin POST agents route). Tenant routes throw or use `jsonResponse()`. The plan
does not propose a shared error envelope type. Add an `ApiErrorResponse` type to
shared-types and use it consistently in the admin API client's error handling.

### 4e. Inline `PlaygroundEvent` is a weak type
The playground defines `interface PlaygroundEvent { type: string; [key: string]: unknown; }`
-- this is effectively `Record<string, unknown>` and provides no type safety. The SDK
already has a proper `StreamEvent` discriminated union with 10+ event types. Phase 1
should replace `PlaygroundEvent` with the SDK's `StreamEvent` type, and Phase 4's
NDJSON sharing then becomes almost free.

### 4f. `interface Agent` redefined with subset fields in edit-form.tsx
The admin edit form defines its own `Agent` interface with ~20 fields that is a near
but not exact copy of the SDK's `Agent`. Missing fields or mismatched optionality
will silently cause bugs. This is the strongest argument for shared types.

### 4g. Admin UI `ApiKey` defined in two places
Both `settings/api-keys-section.tsx` and `tenants/[tenantId]/api-keys.tsx` define
their own `ApiKey` interface. These will drift independently.

## 5. Additional Recommendations

### 5a. Phase ordering adjustment
The plan recommends Phase 1 -> 2 -> 4 -> 3. This is correct. However, Phase 1
should be split into two sub-phases:
- **1a**: Create `shared-types.ts` with Zod schemas + inferred types, update SDK exports
- **1b**: Update admin UI components to import from shared-types

This lets you validate the SDK re-export approach before touching 15 UI files.

### 5b. Admin API client should handle streaming
Phase 2's `AdminApi` class only shows JSON request/response methods. It needs a
`stream()` method that returns `AsyncIterable<StreamEvent>` for the playground
and run detail pages. Otherwise those components stay on raw fetch.

### 5c. Consider React Query / SWR integration
The admin API client is a good opportunity to add cache invalidation. Currently,
each component manages its own loading state and refetch logic. A `useAdminQuery`
hook wrapping the client would reduce boilerplate further.

### 5d. SDK path alias risk
Phase 1 Option A proposes SDK importing from `../../src/lib/shared-types.ts` via
tsconfig path alias. This creates a build-time coupling: the SDK's `tsconfig.json`
must understand the app's path aliases. Since the SDK has its own `tsconfig.json`
and build pipeline (`npm run sdk:build` produces ESM+CJS+DTS), a relative import
into `src/` may break the DTS generation. Test this carefully or use Option B
(workspace package) despite the extra setup cost.

## Summary

| Finding | Severity | Plan Addresses? |
|---------|----------|-----------------|
| snake_case/camelCase inconsistency in shared types | Medium | No |
| Route merge abstraction too coarse | Medium | Partially |
| Zod schemas should be SSOT, not parallel interfaces | High | No |
| `RESERVED_SLUGS` missing from tenant route (bug) | High | No |
| Two NDJSON parsers within playground file | Low | Partially |
| Error response envelope not standardized | Medium | No |
| `PlaygroundEvent` is untyped | Low | Yes (Phase 4) |
| SDK path alias may break DTS generation | Medium | No |
| Admin API client needs streaming support | Medium | No |
