# Architecture Review for Open Source Release

**Reviewed:** 2026-03-21
**Scope:** Full codebase - API routes, lib/, SDK, UI components, DB layer

---

## 1. Error Response Shape Inconsistency (HIGH)

The most significant issue for open source consumers. There are **three different error response shapes** used across the codebase:

### Shape A: `{ error: { code, message } }` (canonical, from `AppError.toJSON()`)
Used by `errorResponse()` in `src/lib/api.ts` and some admin routes:
```
src/app/api/admin/agents/route.ts:72  -> { error: { message: "Tenant not found" } }
src/app/api/admin/agents/[agentId]/schedules/*.ts -> { error: { message: "..." } }
```

### Shape B: `{ error: "string" }` (flat string, no code)
Used inconsistently in many admin routes and some tenant routes:
```
src/app/api/admin/agents/[agentId]/route.ts:18  -> { error: "Agent not found" }
src/app/api/admin/runs/[runId]/route.ts:15       -> { error: "Run not found" }
src/app/api/admin/tenants/[tenantId]/route.ts:17 -> { error: "Tenant not found" }
src/app/api/mcp-servers/[mcpServerId]/route.ts:51 -> { error: "No fields to update" }
src/app/api/runs/[runId]/stream/route.ts:43       -> { error: "No sandbox for this run" }
src/app/api/admin/composio/tools/route.ts:10      -> { error: "toolkit query..." }
```

### Shape C: `{ error: "interpolated string" }` (dynamic messages)
```
src/app/api/plugin-marketplaces/.../route.ts -> { error: `Failed to fetch...` }
src/app/api/admin/runs/[runId]/cancel/route.ts:24 -> { error: `Run is ${status}...` }
```

### Impact
The SDK `AgentPlaneError.fromResponse()` expects Shape A (`body.error.code` + `body.error.message`). When it receives Shape B, it falls through to `new AgentPlaneError("unknown", status, "HTTP {status}")`, losing the actual error message. This is a **runtime bug** that silently degrades error reporting for SDK users.

### Recommendation
Standardize ALL error responses to Shape A. Use `NotFoundError`, `ValidationError`, etc. from `src/lib/errors.ts` instead of manual `NextResponse.json()`. Admin routes should use `jsonResponse()` from `src/lib/api.ts` consistently.

**Files to fix (Shape B -> Shape A):**
- `src/app/api/admin/agents/[agentId]/route.ts` (lines 18, 38, 112)
- `src/app/api/admin/runs/[runId]/route.ts` (line 15)
- `src/app/api/admin/runs/[runId]/cancel/route.ts` (lines 19, 59)
- `src/app/api/admin/runs/[runId]/stream/route.ts` (lines 33, 52)
- `src/app/api/admin/tenants/[tenantId]/route.ts` (lines 17, 74)
- `src/app/api/admin/tenants/[tenantId]/keys/[keyId]/route.ts` (line 18)
- `src/app/api/admin/mcp-servers/[mcpServerId]/route.ts` (line 78)
- `src/app/api/admin/composio/tools/route.ts` (line 10)
- `src/app/api/admin/agents/[agentId]/connectors/route.ts` (lines 15, 29)
- `src/app/api/admin/agents/[agentId]/connectors/[toolkit]/route.ts` (lines 17, 29)
- `src/app/api/admin/agents/[agentId]/connectors/[toolkit]/initiate-oauth/route.ts` (lines 18, 31)
- `src/app/api/mcp-servers/[mcpServerId]/route.ts` (line 51)
- `src/app/api/runs/[runId]/stream/route.ts` (line 43)
- `src/app/api/internal/runs/[runId]/transcript/route.ts` (lines 35, 41, 53, 67, 104)

---

## 2. HTTP Method Inconsistency: PUT vs PATCH (HIGH)

The tenant API and admin API use **different HTTP methods** for the same operation:

| Operation | Tenant API | Admin API |
|---|---|---|
| Update agent | `PUT` (`src/app/api/agents/[agentId]/route.ts`) | `PATCH` (`src/app/api/admin/agents/[agentId]/route.ts`) |

Both accept partial updates (the body is parsed with `UpdateAgentSchema.partial()`), so `PATCH` is the correct semantic. The tenant API's `PUT` is misleading since it does NOT require a full replacement.

The SDK uses `PUT` for `agents.update()`:
```ts
// sdk/src/resources/agents.ts:61
async update(agentId: string, params: UpdateAgentParams): Promise<Agent> {
  return this._client._request<Agent>("PUT", `/api/agents/${agentId}`, { body: params });
}
```

### Recommendation
Change tenant agent update from `PUT` to `PATCH` for semantic correctness, or document the deviation. Update SDK accordingly.

---

## 3. SDK `Agent` Type Missing `runner` Field (HIGH)

The API returns a `runner` field on agents (from `AgentRow` in `validation.ts`), but the SDK `Agent` interface in `sdk/src/types.ts` does NOT include it:

```ts
// sdk/src/types.ts - Agent interface is missing:
//   runner: "claude-agent-sdk" | "vercel-ai-sdk" | null;
//   a2a_tags: string[];
//   slug: string;
```

The `CreateAgentParams` also does not include `runner`, so SDK users cannot specify or inspect which runner an agent uses. This is a significant gap for open source users who need to understand the dual-runner architecture.

**Missing fields in SDK `Agent` type:**
- `runner` (nullable, returned by API)
- `slug` (returned by API)
- `a2a_tags` (returned by API)

**Missing fields in SDK `Run` type:**
- `runner` (returned by API via `RunRow`)
- `schedule_id` (returned by API)
- `created_by_key_id` (returned by API)
- `agent_name` (returned by API, optional)
- `agent_model` (returned by API, optional)

---

## 4. `has_more` Pagination Computed Client-Side in SDK (MEDIUM)

The server never returns `has_more` in paginated responses. The SDK computes it heuristically:

```ts
// sdk/src/resources/runs.ts:125
has_more: response.data.length === response.limit,
```

This is duplicated in `runs.ts`, `agents.ts`, and `sessions.ts`. The heuristic is also subtly wrong: if there are exactly `limit` items remaining, `has_more` will be `true` but a subsequent request will return 0 results.

### Recommendation
Add `has_more` to the server response (use `COUNT(*) OVER()` or fetch `limit + 1` rows). Remove SDK-side computation.

---

## 5. Admin Routes vs Tenant Routes: Structural Divergence (MEDIUM)

### 5a. Response shape differences

| Endpoint | Tenant API response | Admin API response |
|---|---|---|
| GET agent | `{ ...agent }` (flat) | `{ agent, recent_runs }` (nested) |
| GET run | `{ ...run }` (flat) | `{ run, transcript }` (nested) |
| List agents | `{ data, limit, offset }` | `{ data, limit, offset }` (but different fields per item) |

The admin agent GET includes `recent_runs` and the admin run GET fetches the transcript inline. These are different contracts that can confuse consumers.

### 5b. Admin routes bypass `getAgentForTenant()` and `getRun()`
Admin routes query the DB directly without tenant scoping, which is correct for cross-tenant admin access, but they also skip the shared error handling and use raw `NextResponse.json()` instead of `jsonResponse()`.

### 5c. Admin routes don't use `authenticateAdmin()` from auth.ts
Authentication is handled entirely in middleware. The admin routes trust the middleware and don't perform any auth checks themselves. While functional, this means admin routes cannot distinguish between cookie auth and API key auth if they ever need to.

---

## 6. Duplicated Agent Update Logic (MEDIUM - DRY)

The update logic for agents is duplicated between:
- `src/app/api/agents/[agentId]/route.ts` (tenant PUT, ~70 lines)
- `src/app/api/admin/agents/[agentId]/route.ts` (admin PATCH, ~100 lines)

Both build dynamic SET clauses, validate permission modes, and handle slug conflicts, but with subtle differences:
- Admin uses `SELECT FOR UPDATE` locking; tenant does not
- Admin has `fieldMap` array approach; tenant uses `fields` object approach
- Admin validates marketplace references; tenant does not
- Admin blocks slug changes when A2A is enabled; tenant does not (tenant cannot set slug)

### Recommendation
Extract shared update logic into `src/lib/agents.ts` (e.g., `updateAgent(agentId, tenantId, input, options)`) that both routes call.

---

## 7. Duplicated Cancel Logic (MEDIUM - DRY)

`src/app/api/runs/[runId]/cancel/route.ts` and `src/app/api/admin/runs/[runId]/cancel/route.ts` are nearly identical (~50 lines each) with these differences:
- Tenant route wraps sandbox stop in the happy path; admin wraps it in try/catch
- Different error response shapes (tenant uses Shape A, admin uses Shape B)
- Admin does not scope by tenant_id

### Recommendation
Extract a shared `cancelRun(runId, tenantId?)` function into `src/lib/runs.ts`.

---

## 8. Duplicated Plugin File Routes (MEDIUM - DRY)

`src/app/api/plugin-marketplaces/[marketplaceId]/plugins/[...pluginName]/route.ts` and
`src/app/api/admin/plugin-marketplaces/[marketplaceId]/plugins/[...pluginName]/route.ts`

These are large, complex routes that share substantial logic for GitHub tree fetching, file parsing, and save operations. The duplication is risky because bug fixes need to be applied in both places.

---

## 9. OAuth Redirect Response Inconsistency (MEDIUM)

For Composio OAuth:
- Tenant route: Returns `{ redirect_url: "..." }` (snake_case) - correct for SDK
- Admin route `[toolkit]/route.ts`: Does `NextResponse.redirect(...)` (HTTP 302 redirect)
- Admin route `[toolkit]/initiate-oauth/route.ts`: Returns `{ redirect_url: "..." }` (JSON)

For MCP OAuth:
- Returns `{ redirectUrl: "..." }` (camelCase)

The SDK documents this mismatch:
```ts
// ConnectorOauthResult uses redirect_url (snake_case)
// CustomConnectorOauthResult uses redirectUrl (camelCase)
```

This is a wire format inconsistency. Both should use the same casing convention (snake_case, matching the rest of the API).

---

## 10. `NextResponse.json()` vs `jsonResponse()` Inconsistency (LOW)

Tenant routes consistently use `jsonResponse()` from `src/lib/api.ts`. Admin routes use `NextResponse.json()` directly. This means:
- Admin routes import both `NextResponse` and sometimes `withErrorHandler` but not `jsonResponse`
- No centralized response formatting for admin responses

This is cosmetic but makes the codebase harder to search/refactor.

---

## 11. Inconsistent Param Context Access Pattern (LOW)

Two patterns for accessing route params:

**Pattern A (tenant routes):** `const { agentId } = await context!.params;`
**Pattern B (admin routes):** Type-cast with local type: `const { agentId } = await (context as RouteContext).params;`

Pattern B is safer (explicit typing), but the inconsistency is confusing.

### Recommendation
Pick one pattern and apply consistently. Pattern B is preferable for type safety.

---

## 12. `auth.ts` Throws Plain Errors, Not AppErrors (LOW)

`authenticateApiKey()` and `authenticateA2aRequest()` throw `new Error("Missing or invalid Authorization header")` instead of `new AuthError()`. This means `withErrorHandler()` catches them as unhandled errors and returns a 500 instead of 401.

However, middleware handles the 401 before the route handler runs, so this is masked in practice. For open source consumers who might bypass middleware, this would surface as 500s.

### Files
- `src/lib/auth.ts` lines 22-29, 78-82

---

## 13. Tenant Delete Agent: No Cascade Safety (LOW)

The tenant DELETE agent route (`src/app/api/agents/[agentId]/route.ts`) simply deletes the agent without checking for active runs or cleaning up related data:
```ts
await execute("DELETE FROM agents WHERE id = $1 AND tenant_id = $2", [agentId, auth.tenantId]);
```

The admin DELETE route properly checks for active runs and cascades deletes to `mcp_connections` and `runs`. If there are foreign key constraints, the tenant route will fail with a raw Postgres error instead of a clean message.

---

## 14. `as any` Usage (LOW)

Only 3 instances in `src/lib/composio.ts` (line 217, 253, 271). These appear to be for Composio SDK compatibility. Acceptable but should have a comment explaining why.

---

## 15. Missing `active-tenant.ts` in CLAUDE.md (LOW)

`src/lib/active-tenant.ts` exists but is not documented in the project structure section of CLAUDE.md. Minor documentation gap.

---

## 16. SDK List Methods Unwrap `{ data }` Inconsistently (LOW)

Some SDK list methods unwrap the response:
```ts
// connectors.ts - unwraps
async list(agentId: string): Promise<ConnectorInfo[]> {
  const resp = await this._client._request<{ data: ConnectorInfo[] }>(...);
  return resp.data;
}
```

Others return the paginated envelope:
```ts
// runs.ts - returns envelope
async list(params?): Promise<PaginatedResponse<Run>> {
  const response = await this._client._request<{ data: Run[]; limit; offset }>(...);
  return { ...response, has_more: ... };
}
```

The distinction is intentional (paginated vs non-paginated), but the inconsistency in return types can confuse SDK users. Consider making all list methods return `PaginatedResponse<T>` even for small collections, or clearly documenting which are paginated.

---

## Summary: Priority Actions for Open Source Release

| Priority | Issue | Effort |
|---|---|---|
| **P0** | Fix error response shapes (all routes -> Shape A) | Medium |
| **P0** | Add missing fields to SDK types (runner, slug, a2a_tags) | Small |
| **P1** | Standardize HTTP methods (PUT -> PATCH for partial updates) | Small |
| **P1** | Fix `auth.ts` to throw `AuthError` instead of plain `Error` | Small |
| **P1** | Fix tenant DELETE agent to check active runs + cascade | Small |
| **P2** | Extract shared `updateAgent()` helper (DRY) | Medium |
| **P2** | Extract shared `cancelRun()` helper (DRY) | Small |
| **P2** | Standardize OAuth redirect response casing | Small |
| **P2** | Move `has_more` computation to server | Medium |
| **P3** | Consolidate plugin file routes | Large |
| **P3** | Standardize route param access pattern | Small |
| **P3** | Standardize `jsonResponse()` usage in admin routes | Small |
