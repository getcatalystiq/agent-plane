# AgentPlane Code Pattern Analysis Report

**Date:** 2026-03-21
**Scope:** Full codebase (`src/`, `sdk/`, `ui/`)

---

## 1. Naming Conventions

### Verdict: MOSTLY CONSISTENT with notable exceptions

**Consistent:**
- File names: All kebab-case (`run-executor.ts`, `session-files.ts`, `mcp-oauth-state.ts`) -- no violations found
- Database columns: All snake_case (`tenant_id`, `created_at`, `max_runtime_seconds`) -- fully consistent across 22 migrations
- TypeScript types: All PascalCase (`TenantId`, `RunStatus`, `AgentPlugin`, `StreamEvent`)
- Branded types: Uniformly applied for domain IDs (`TenantId`, `AgentId`, `RunId`, `McpServerId`, etc.)
- API routes: Kebab-case URLs (`/api/mcp-servers`, `/api/plugin-marketplaces`)
- Functions: camelCase (`authenticateApiKey`, `withErrorHandler`, `generateId`)

**Inconsistencies found:**

1. **SDK types use `snake_case` properties while internal types use `camelCase`** -- This is INTENTIONAL per CLAUDE.md ("snake_case, matches wire format") but undocumented SDK contributors may find this confusing. Consider adding a JSDoc note in `sdk/src/types.ts`.

2. **`ConnectorOauthResult.redirect_url` (snake_case) vs `CustomConnectorOauthResult.redirectUrl` (camelCase)** in `sdk/src/types.ts` -- The SDK already documents this divergence in comments, but it reflects different upstream API conventions leaking into the public SDK surface. This is a real paper-cut for SDK consumers.

3. **Pagination result variable naming:** Admin routes destructure as `{ limit, offset }` while tenant routes assign to `pagination` variable. Minor but inconsistent.

---

## 2. Design Patterns

### Patterns in Use

| Pattern | Location | Assessment |
|---------|----------|------------|
| **Branded Types** | `src/lib/types.ts` | Excellent -- prevents ID parameter swaps at compile time |
| **Wrapper/Decorator** | `withErrorHandler()` in `src/lib/api.ts` | Good -- consistent error boundary for routes |
| **Builder** | `buildAgentCard()`, `buildMcpConfig()`, `buildBridgeScript()` | Good -- complex construction logic encapsulated |
| **Strategy** | Dual runner (`claude-agent-sdk` vs `vercel-ai-sdk`) selected by model | Well-implemented via `resolveEffectiveRunner()` |
| **Process-level Cache with TTL** | Snapshot cache, MCP server cache, plugin tree cache, Agent Card cache | Consistent pattern across the codebase |
| **State Machine** | Session lifecycle (`creating -> active -> idle -> stopped`) | Well-defined transitions in `src/lib/sessions.ts` |
| **Signed State Token** | `oauth-state.ts`, `mcp-oauth-state.ts`, shared via `hmac-state.ts` | Good refactoring -- shared HMAC base |
| **NDJSON Streaming** | `src/lib/streaming.ts`, `sdk/src/streaming.ts` | Clean async iterable pattern |

### Anti-Patterns Found

#### HIGH SEVERITY

1. **God Object: `sandbox.ts` (1,108 lines)**
   - Handles: sandbox creation, SDK snapshot management, dual runner code generation, session sandbox lifecycle, AgentCo bridge MCP server (inline JS as template strings), network allowlist configuration, file injection
   - Contains ~200 lines of inline JavaScript as template strings (`buildBridgeScript()`, runner scripts)
   - **Recommendation:** Extract into `sandbox/create.ts`, `sandbox/runners.ts`, `sandbox/bridge.ts`, `sandbox/snapshots.ts`

2. **`a2a.ts` (732 lines) mixes too many responsibilities**
   - Agent Card building + caching, RunBackedTaskStore (DB persistence), SandboxAgentExecutor (run execution), input validation, status mapping, SSE streaming
   - **Recommendation:** Split into `a2a/agent-card.ts`, `a2a/task-store.ts`, `a2a/executor.ts`, `a2a/validation.ts`

#### MEDIUM SEVERITY

3. **No circular dependencies detected** -- dependency flow is clean: `a2a -> run-executor -> sandbox`, `session-executor -> sandbox`. No cycles.

4. **Routes without `withErrorHandler`:**
   - `/api/a2a/[slug]/.well-known/agent-card.json/route.ts` -- has duplicate legacy route that DOES use it
   - `/api/a2a/[slug]/jsonrpc/route.ts` -- has duplicate legacy route
   - `/api/health/route.ts` -- acceptable (simple endpoint)
   - `/api/agents/[agentId]/connectors/[toolkit]/callback/route.ts` -- OAuth callback, acceptable

   The A2A routes at `/api/a2a/[slug]/` appear to be LEGACY duplicates of the newer `/api/a2a/[slug]/[agentSlug]/` routes. Both sets exist simultaneously.

---

## 3. Code Duplication

### HIGH PRIORITY

1. **Delete Button Components (5 copies)**
   Files:
   - `src/app/admin/(dashboard)/agents/delete-agent-button.tsx`
   - `src/app/admin/(dashboard)/mcp-servers/delete-server-button.tsx`
   - `src/app/admin/(dashboard)/plugin-marketplaces/delete-marketplace-button.tsx`
   - `src/app/admin/(dashboard)/settings/delete-company-button.tsx`
   - `src/app/admin/(dashboard)/tenants/[tenantId]/delete-tenant-button.tsx`

   All 5 share identical structure: `useState` for open/deleting/error, `handleDelete` with fetch+error handling, `Button` + `ConfirmDialog` rendering. Only differ in: endpoint URL, entity name, confirmation message.

   **Recommendation:** Extract a generic `DeleteEntityButton` component:
   ```tsx
   <DeleteEntityButton endpoint={`/api/admin/agents/${id}`} entityName={name} title="Delete Agent" message="..." />
   ```

2. **Admin vs Tenant Route Duplication**
   These route pairs contain near-identical logic with only auth differences:
   - `src/app/api/admin/agents/route.ts` vs `src/app/api/agents/route.ts` (agent CRUD)
   - `src/app/api/admin/agents/[agentId]/connectors/route.ts` vs `src/app/api/agents/[agentId]/connectors/route.ts`
   - `src/app/api/admin/runs/route.ts` vs `src/app/api/runs/route.ts`
   - `src/app/api/admin/sessions/route.ts` vs `src/app/api/sessions/route.ts`

   The admin routes use `authenticateAdmin` (or skip auth via middleware), tenant routes use `authenticateApiKey`. The actual DB queries and response shaping are duplicated.

   **Recommendation:** Extract shared query/response logic into `src/lib/` service functions (e.g., `listAgents(tenantId, pagination)`) called by both route layers.

3. **A2A Route Duplication**
   Two complete sets of A2A routes exist:
   - `/api/a2a/[slug]/.well-known/agent-card.json/` (legacy, tenant-slug only)
   - `/api/a2a/[slug]/[agentSlug]/.well-known/agent-card.json/` (newer, tenant+agent slug)
   - Same for `jsonrpc/` and `agents.json`

   **Recommendation:** Remove legacy routes or redirect them.

### MEDIUM PRIORITY

4. **StreamEvent type definitions duplicated** between `src/lib/types.ts` and `sdk/src/types.ts`. The SDK defines its own `RunStatus`, `SessionStatus`, `StreamEvent` union, etc. These MUST stay in sync manually. No shared package or codegen ensures they match.

5. **`SaveKeySchema` defined twice** -- once in admin connectors route, once in tenant connectors route. Identical `z.object({ toolkit: z.string(), api_key: z.string().min(1) })`.

6. **Pagination parsing** is repeated in 9 route files with the same 3-line pattern. Could be a utility: `parsePagination(request)`.

---

## 4. Convention Violations

### Documented patterns NOT consistently followed:

1. **`withErrorHandler()` on every API route** (CLAUDE.md says: "Use `withErrorHandler()` wrapper on every API route handler")
   - 4 routes lack it. The A2A legacy routes and health are understandable exceptions, but the pattern is documented as universal.

2. **Error response shape inconsistency**
   - Tenant routes use `{ error: { code, message } }` (via `withErrorHandler` + typed errors)
   - Admin routes mix `{ error: "string" }` (flat string) and `{ error: { message: "string" } }` (object)
   - Examples: `/api/admin/agents/[agentId]/connectors/route.ts` returns `{ error: "Agent not found" }` (flat string)
   - But `/api/admin/agents/[agentId]/schedules/route.ts` returns `{ error: { message: "..." } }` (object)
   - **Recommendation:** Standardize on `{ error: { code, message } }` everywhere. Document in CLAUDE.md.

3. **`NextResponse.json()` vs `jsonResponse()`**
   - CLAUDE.md documents `jsonResponse()` helper, but admin routes predominantly use raw `NextResponse.json()`
   - Tenant routes consistently use `jsonResponse()`
   - **Recommendation:** Migrate admin routes to `jsonResponse()` for consistency

### Undocumented patterns that SHOULD be in CLAUDE.md:

1. **Legacy A2A routes** -- The dual route structure (`[slug]` vs `[slug]/[agentSlug]`) is not documented
2. **Delete button pattern** -- The admin UI delete button pattern is repeated 5 times but not documented as a component convention
3. **Admin routes skip auth via middleware** -- CLAUDE.md says admin uses `ADMIN_API_KEY` or JWT, but doesn't explain the middleware bypass mechanism explicitly

---

## 5. Open Source Readiness

### GOOD

- **No secrets in code** -- All sensitive values come from env vars
- **No TODO/FIXME/HACK comments found** -- Zero technical debt markers, which is unusually clean
- **CLAUDE.md is comprehensive** -- Excellent onboarding document covering architecture, commands, project structure, patterns
- **Branded types** make the domain model self-documenting
- **Well-structured `src/lib/`** -- Clear separation of concerns (auth, crypto, streaming, errors, etc.)

### NEEDS ATTENTION

1. **Internal branding references:**
   - `getcatalystiq` appears in GitHub URLs on the landing page (`src/app/page.tsx` lines 15, 82, 329, 353)
   - `agentco-bridge` naming throughout `src/lib/sandbox.ts` (lines 299, 300, 328, 331, 333, 381, 387, 395, 550, 842, 843, 875) -- "AgentCo" appears to be an internal/partner product name
   - `@getcatalystiq/agent-plane` is the npm package name in `sdk/`
   - **Recommendation:** Decide on public-facing naming before open-sourcing. Replace or document AgentCo references.

2. **`src/app/page.tsx` is a marketing page** with specific branding ("Claude Agents as an API"). For open source, this should either be made generic or clearly marked as the hosted version's landing page.

3. **No CONTRIBUTING.md, LICENSE, or CODE_OF_CONDUCT.md** found -- standard open source files are missing.

4. **No JSDoc on public SDK methods** -- `sdk/src/resources/*.ts` methods have minimal documentation. Open source contributors will need these.

5. **`delete-tenant-button.tsx` exists alongside `delete-company-button.tsx`** -- The "tenant" vs "company" naming split (API=tenant, UI=company) could confuse contributors. The `delete-tenant-button.tsx` appears to be a legacy file.

---

## Summary of Recommendations (Priority Order)

| # | Issue | Severity | Effort |
|---|-------|----------|--------|
| 1 | Standardize error response shape (`{ error: { code, message } }`) | High | Medium |
| 2 | Extract `DeleteEntityButton` generic component | Medium | Low |
| 3 | Split `sandbox.ts` (1,108 lines) into modules | High | High |
| 4 | Remove or redirect legacy A2A routes | Medium | Low |
| 5 | Migrate admin routes from `NextResponse.json()` to `jsonResponse()` | Medium | Low |
| 6 | Extract shared admin/tenant query logic into service layer | Medium | High |
| 7 | Add CONTRIBUTING.md, LICENSE, CODE_OF_CONDUCT.md | High (for OSS) | Low |
| 8 | Audit and document AgentCo/getcatalystiq references | High (for OSS) | Low |
| 9 | Split `a2a.ts` (732 lines) into modules | Medium | Medium |
| 10 | Add JSDoc to SDK public methods | Medium | Medium |
| 11 | Extract `parsePagination(request)` utility | Low | Low |
| 12 | Document the `ConnectorOauthResult` vs `CustomConnectorOauthResult` casing divergence more prominently | Low | Low |
