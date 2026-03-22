---
title: "feat: Add per-tenant subscription token authentication"
type: feat
status: active
date: 2026-03-21
origin: docs/brainstorms/2026-03-21-subscription-token-auth-requirements.md
deepened: 2026-03-21
---

# feat: Add Per-Tenant Subscription Token Authentication

## Enhancement Summary

**Deepened on:** 2026-03-21
**Review agents used:** Security Sentinel, Architecture Strategist, TypeScript Reviewer, Data Integrity Guardian, Performance Oracle, Code Simplicity Reviewer, Pattern Recognition Specialist, Deployment Verification

### Key Improvements from Deepening

1. **New module `src/lib/tenant-auth.ts`** — extract auth resolution + env builder out of `sandbox.ts` (architecture, separation of concerns)
2. **Process-level cache with 5-min TTL** — avoid DB query + decryption on every run (performance)
3. **Token scrubbing utility** — `scrubSecrets()` applied to transcript capture to prevent token leaks (security)
4. **Claude-only model scoping** — subscription token only used when effective runner is `claude-agent-sdk`; non-Anthropic models always use AI Gateway
5. **SSRF mitigation** — validate custom base URL at both PATCH time and sandbox creation time (security)
6. **Slimmed `SandboxAuth` interface** — removed `aiGatewayApiKey` (always global), callers use `getEnv()` directly (simplicity)

### Additional Changes (User Feedback)

7. **Claude-specific naming** — UI labeled "Claude Subscription" with helper text clarifying it's Anthropic-only
8. **Token validation on save** — test API call verifies token works before storing
9. **Expiry date tracking** — optional `subscription_token_expires_at` with UI warnings at 30 days
10. **Cost tracking (Phase 7)** — subscription runs record $0 cost, usage still tracked

### New Risks Discovered

- **SSRF via DNS rebinding** on custom base URL (MEDIUM — mitigated with HTTPS-only + validation)
- **`SELECT *` in GET handler** may leak encrypted blob when column is added (MEDIUM — use explicit column list)
- **No transcript scrubbing infrastructure** exists in the codebase (MEDIUM — must add before shipping)

---

## Overview

Allow tenants to use their Claude Pro/Max subscription tokens (`sk-ant-oat01-*`) instead of the shared Vercel AI Gateway key for Claude Agent SDK runs. The Agent SDK already supports `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL` — this feature adds per-tenant token storage and routing.

## Problem Statement

All Claude Agent SDK sandbox runs currently share a single `AI_GATEWAY_API_KEY`, billed per-token via the Anthropic API. Tenants with Claude Max subscriptions want to use their subscription quota instead, reducing costs and leveraging their existing plan. (see origin: `docs/brainstorms/2026-03-21-subscription-token-auth-requirements.md`)

## Proposed Solution

1. Store an encrypted subscription token + optional custom base URL per tenant
2. At sandbox creation time, resolve auth: tenant subscription token → fallback to global AI Gateway key
3. Route Claude SDK calls to `api.claude.ai` (or custom URL) when subscription token is present
4. Expose configuration in Admin UI settings page

## Technical Approach

### Architecture

**Auth resolution flow:**

```
resolveSandboxAuth(tenantId, runnerType)  [in src/lib/tenant-auth.ts]
  ├─ runnerType !== "claude-agent-sdk"?
  │   └─ YES → return global AI Gateway auth (subscription token is Claude-only)
  ├─ check process-level cache (5-min TTL)
  │   ├─ HIT → return cached auth
  │   └─ MISS ↓
  ├─ query tenant for subscription_token_enc, subscription_base_url, subscription_token_expires_at
  ├─ tenant has subscription_token_enc?
  │   ├─ YES → decrypt token, use tenant's base URL (default: api.claude.ai)
  │   └─ NO  → use global AI_GATEWAY_API_KEY + ai-gateway.vercel.sh
  ├─ cache result with 5-min TTL
  └─ return { authToken, baseUrl, isSubscription, extraAllowedHostnames }
```

Key insights:
- `AI_GATEWAY_API_KEY` must ALWAYS be set (for Vercel AI SDK / non-Anthropic models). Callers get it from `getEnv()` directly.
- **Subscription token is Claude-only.** When the agent's effective runner is `vercel-ai-sdk` (non-Anthropic models), the subscription token is never used — always falls back to AI Gateway. The `runnerType` parameter gates this explicitly.
- `isSubscription` flag in the return enables downstream cost tracking (Phase 7).

### Implementation Phases

#### Phase 1: Database + Encryption (Migration 023)

**File:** `src/db/migrations/023_add_subscription_token.sql`

```sql
ALTER TABLE tenants
  ADD COLUMN IF NOT EXISTS subscription_token_enc TEXT,
  ADD COLUMN IF NOT EXISTS subscription_base_url TEXT,
  ADD COLUMN IF NOT EXISTS subscription_token_expires_at TIMESTAMPTZ;
```

- `subscription_token_enc` — AES-256-GCM encrypted JSON (`{version, iv, ciphertext}`), same pattern as `mcp_servers.client_secret_enc` and `plugin_marketplaces.github_token_enc`
- `subscription_base_url` — plaintext URL, nullable. When NULL and token is present, defaults to `https://api.claude.ai`
- `subscription_token_expires_at` — optional expiry timestamp set by tenant. Used for proactive UI warnings.

**File:** `src/lib/validation.ts`

Add to `TenantRow` schema (matching existing nullable column pattern like `logo_url`):
- `subscription_token_enc: z.string().nullable().default(null)`
- `subscription_base_url: z.string().nullable().default(null)`
- `subscription_token_expires_at: z.string().nullable().default(null)`

> **Research insight (data integrity):** No CHECK constraint needed pairing the two columns — consistent with existing `composio_mcp_url` / `composio_api_key_enc` pattern which also omits constraints. Enforce the invariant in application code.

> **Research insight (deployment):** Migration is safe for zero-downtime deploy — adding nullable columns with no default is metadata-only (no table rewrite, no ACCESS EXCLUSIVE lock). `IF NOT EXISTS` ensures idempotency. Migrations run before new code via `npm run migrate && next build`.

#### Phase 2: Auth Resolution Module

**File:** `src/lib/tenant-auth.ts` — **NEW MODULE**

> **Research insight (architecture):** Extract to a dedicated module rather than adding to `sandbox.ts` (already 1100+ lines). Auth resolution is a tenant-level concern, not a sandbox lifecycle concern. Follows the pattern of `mcp-connections.ts` handling MCP OAuth tokens separately from sandbox code.

```typescript
import { TenantId } from "./types";
import { RunnerType } from "./models";
import { decrypt } from "./crypto";
import { getEnv } from "./env";
import { query } from "../db";

// --- Process-level cache (5-min TTL, matching MCP server cache pattern) ---
const authCache = new Map<string, { auth: SandboxAuth; expiresAt: number }>();
const AUTH_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

interface SandboxAuth {
  anthropicAuthToken: string;
  anthropicBaseUrl: string;
  isSubscription: boolean;
  extraAllowedHostnames: string[];
}

const DEFAULT_AUTH: Omit<SandboxAuth, "anthropicAuthToken"> & { anthropicAuthToken?: string } = {
  anthropicBaseUrl: "https://ai-gateway.vercel.sh",
  isSubscription: false,
  extraAllowedHostnames: [],
};

/**
 * Resolve sandbox auth credentials for a tenant.
 * Subscription tokens are ONLY used for Claude models (claude-agent-sdk runner).
 * Non-Anthropic models always use the global AI Gateway key.
 */
export async function resolveSandboxAuth(
  tenantId: TenantId,
  runnerType: RunnerType
): Promise<SandboxAuth> {
  const env = getEnv();

  // Non-Claude models always use AI Gateway — subscription token is Claude-only
  if (runnerType !== "claude-agent-sdk") {
    return {
      anthropicAuthToken: env.AI_GATEWAY_API_KEY,
      anthropicBaseUrl: "https://ai-gateway.vercel.sh",
      isSubscription: false,
      extraAllowedHostnames: [],
    };
  }

  // Check cache (keyed by tenantId, only for Claude runner)
  const cached = authCache.get(tenantId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.auth;
  }

  const row = await query<{
    subscription_token_enc: string | null;
    subscription_base_url: string | null;
  }>(
    `SELECT subscription_token_enc, subscription_base_url FROM tenants WHERE id = $1`,
    [tenantId]
  );

  let auth: SandboxAuth;

  if (row?.subscription_token_enc) {
    const token = await decrypt(
      JSON.parse(row.subscription_token_enc),
      env.ENCRYPTION_KEY,
      env.ENCRYPTION_KEY_PREVIOUS
    ).catch((err) => {
      throw new Error(`Failed to decrypt Claude subscription token for tenant ${tenantId}: ${err.message}`);
    });

    const baseUrl = row.subscription_base_url || "https://api.claude.ai";
    let hostname: string;
    try {
      hostname = new URL(baseUrl).hostname;
    } catch {
      throw new Error(`Invalid Claude subscription base URL for tenant ${tenantId}: ${baseUrl}`);
    }

    auth = {
      anthropicAuthToken: token.trim(),
      anthropicBaseUrl: baseUrl,
      isSubscription: true,
      extraAllowedHostnames: hostname === "ai-gateway.vercel.sh" ? [] : [hostname],
    };
  } else {
    auth = {
      anthropicAuthToken: env.AI_GATEWAY_API_KEY,
      anthropicBaseUrl: "https://ai-gateway.vercel.sh",
      isSubscription: false,
      extraAllowedHostnames: [],
    };
  }

  authCache.set(tenantId, { auth, expiresAt: Date.now() + AUTH_CACHE_TTL });
  return auth;
}

/** Invalidate cached auth for a tenant (call on token update) */
export function invalidateAuthCache(tenantId: TenantId): void {
  authCache.delete(tenantId);
}

/** Build the auth-related env vars for sandbox injection */
export function buildSandboxAuthEnv(auth: SandboxAuth): Record<string, string> {
  return {
    ANTHROPIC_BASE_URL: auth.anthropicBaseUrl,
    ANTHROPIC_AUTH_TOKEN: auth.anthropicAuthToken,
    ANTHROPIC_API_KEY: "",
    AI_GATEWAY_API_KEY: getEnv().AI_GATEWAY_API_KEY,
  };
}
```

> **Research insight (TypeScript):** Added null guard on query result, try-catch on `JSON.parse`/`decrypt` with descriptive errors, defensive URL parsing, and `.trim()` on token to prevent whitespace auth failures.

> **Research insight (performance):** Process-level cache with 5-min TTL follows the established pattern (MCP servers 5 min, plugin trees 5 min, snapshots 25 hr). Eliminates DB query + decryption on subsequent runs. Token rotation has acceptable 5-min staleness window.

> **Research insight (pattern):** `JSON.stringify(await encrypt(...))` must be used before DB storage, matching `mcp-connections.ts` line 323.

#### Phase 3: Sandbox Environment Injection (3 sites)

Replace hardcoded auth env vars at all three sandbox creation sites with `buildSandboxAuthEnv()`:

**File:** `src/lib/sandbox.ts` — one-shot runs (~line 320)

```typescript
// Before (4 hardcoded lines):
env.ANTHROPIC_BASE_URL = "https://ai-gateway.vercel.sh";
env.ANTHROPIC_AUTH_TOKEN = config.aiGatewayApiKey;
env.ANTHROPIC_API_KEY = "";
env.AI_GATEWAY_API_KEY = config.aiGatewayApiKey;

// After (1 line via spread):
Object.assign(env, buildSandboxAuthEnv(config.auth));
```

Same change at:
- `src/lib/sandbox.ts` ~line 868 (session sandbox creation)
- `src/lib/sandbox.ts` ~line 1091 (session reconnect)

> **Research insight (architecture):** Extract `buildSandboxAuthEnv()` eliminates the repeated 4-line block at all 3 sites, fixing a pre-existing DRY violation.

**File:** `src/lib/sandbox.ts` — `SandboxConfig` and `SessionSandboxConfig` interfaces

Replace `aiGatewayApiKey: string` with `auth: SandboxAuth` in both interfaces. This is a field replacement (not addition), keeping interface size stable.

**File:** `src/lib/run-executor.ts` (~line 66)

Call `resolveSandboxAuth(tenantId)` and pass into config. Add to existing `Promise.all()` with `buildMcpConfig` + `fetchPluginContent`:

```typescript
const effectiveRunner = resolveEffectiveRunner(agent.model, agent.runner);
const [mcpConfig, pluginContent, auth] = await Promise.all([
  buildMcpConfig(...),
  fetchPluginContent(...),
  resolveSandboxAuth(tenantId, effectiveRunner),  // cached: usually sub-ms; skips decrypt for non-Claude
]);
// config.auth = auth
// config.extraAllowedHostnames = [...existing, ...auth.extraAllowedHostnames]
```

**File:** `src/lib/session-executor.ts` (lines 75, 128, 164)

Same pattern — add `resolveSandboxAuth(tenantId)` to existing `Promise.all()` batches at all three session code paths.

**Network allowlist:** Custom base URL hostname added dynamically via `config.extraAllowedHostnames` (existing mechanism). `ai-gateway.vercel.sh` stays (always needed for Vercel AI SDK).

#### Phase 4: Token Scrubbing (Security — NEW)

> **Research insight (security):** The codebase has ZERO scrubbing/redacting infrastructure. Transcript capture passes every NDJSON line from the sandbox to Vercel Blob verbatim. If agent code prints or leaks `ANTHROPIC_AUTH_TOKEN`, the token is persisted.

**File:** `src/lib/transcript-utils.ts` — add scrubbing utility

```typescript
const SECRET_PATTERNS = [
  /sk-ant-oat01-[A-Za-z0-9_-]+/g,   // subscription tokens
  /sk-ant-api03-[A-Za-z0-9_-]+/g,    // API keys
];

export function scrubSecrets(text: string): string {
  let result = text;
  for (const pattern of SECRET_PATTERNS) {
    result = result.replace(pattern, "[REDACTED]");
  }
  return result;
}
```

Apply `scrubSecrets()` in `captureTranscript()` before both `chunks.push()` and `yield`.

#### Phase 5: Admin API

**File:** `src/app/api/admin/tenants/[tenantId]/route.ts`

Update `UpdateTenantSchema`:
```typescript
subscription_token: z.string().trim().optional(),  // .trim() prevents whitespace auth failures
subscription_base_url: z.string().url().nullable().optional(),
subscription_token_expires_at: z.string().datetime().nullable().optional(),  // ISO 8601
```

PATCH handler changes:
- When `subscription_token` is provided and non-empty:
  1. **Validate token**: make a lightweight test request to the base URL (e.g., `GET /v1/models` or similar health endpoint) using the token as Bearer auth. If it fails, return 400 with "Invalid Claude subscription token" error.
  2. Encrypt: `JSON.stringify(await encrypt(token, env.ENCRYPTION_KEY))` → store as `subscription_token_enc`
- When `subscription_token` is empty string: set `subscription_token_enc = NULL`, `subscription_base_url = NULL`, `subscription_token_expires_at = NULL` (clear all)
- When `subscription_base_url` is provided: validate HTTPS scheme, store directly
- When `subscription_token_expires_at` is provided: store directly
- Invalidate auth cache entry: `invalidateAuthCache(tenantId)` (imported from `tenant-auth.ts`)

> **Research insight (security):** Validate custom base URL with HTTPS-only check at PATCH time to mitigate SSRF. Re-validate hostname at sandbox creation time (already handled by `new URL()` in `resolveSandboxAuth`).

GET response changes:
- Use explicit `SELECT id, name, slug, ...` column list instead of `SELECT *` to prevent `subscription_token_enc` from leaking
- Return computed `has_subscription_token: boolean` and `subscription_base_url` only

> **Research insight (security):** `SELECT *` in the current GET handler would include the new encrypted column. Even though Zod strips unknown fields by default, this is fragile — use explicit column list.

#### Phase 6: Admin UI

**File:** `src/app/admin/(dashboard)/settings/company-form.tsx`

Add a **"Claude Subscription"** section after the Monthly Budget field with three fields:

> **Important:** Label this section clearly as "Claude Subscription" — not generic "Subscription Token". This token is specific to Anthropic's Claude subscription (Pro/Max) and only applies to Claude models. Other model providers use the AI Gateway.

1. **Claude Subscription Token** — password input (`type="password"`)
   - Section label: "Claude Subscription" with helper text: "Use your Claude Pro/Max subscription token instead of the AI Gateway for Claude models. Non-Claude models (OpenAI, Gemini, etc.) always use the AI Gateway."
   - Info tooltip (ℹ️ icon next to the label) with instructions on how to obtain the token:
     ```
     To get a long-lived token:
     1. Install Claude Code CLI (npm install -g @anthropic-ai/claude-code)
     2. Run: claude login
     3. Authenticate with your Claude Pro/Max account in the browser
     4. Run: claude setup-token
     5. Copy the generated sk-ant-oat01-... token
     The token is valid for approximately 1 year.
     ```
   - Placeholder: `sk-ant-oat01-...` when token exists, empty when not
   - Shows "Configured" `Badge` when `has_subscription_token` is true
   - Clear button to remove token (sends empty string to PATCH)
   - Only sends value when changed (avoids overwriting with masked value)
   - Uses existing `FormField` component pattern with `useState` + `isDirty` tracking
   - On save: if validation fails, show inline error "Invalid token — could not authenticate with Claude API"

2. **Base URL** — text input
   - Placeholder: `https://api.claude.ai (default)`
   - Only visible/enabled when subscription token is present
   - Validated as HTTPS URL on submit

3. **Token Expires** — date input (`type="date"`)
   - Optional — tenant sets this manually based on when they created the token
   - When set and within 30 days of expiry: show warning `Badge` "Expires soon" in amber
   - When set and expired: show error `Badge` "Expired" in red
   - Helper text: "Set the expiry date so you get warned before the token stops working"

> **Research insight (pattern):** This would be the first password-type input in the admin UI. Use `<Input type="password" />` — standard HTML, consistent with dark-mode theme.

#### Phase 7: Cost Tracking

**File:** `src/lib/run-executor.ts` or `src/lib/sandbox.ts`

When a subscription token is active (`auth.isSubscription === true`), set an env var in the sandbox:
```typescript
env.AGENT_PLANE_BILLING_SOURCE = auth.isSubscription ? "subscription" : "api";
```

**File:** `src/lib/transcript-utils.ts` / run finalization

When `billing_source === "subscription"`, record `cost_usd = 0` in the runs table (cost is absorbed by the Claude subscription, not the platform). Token usage is still recorded for analytics.

This prevents misleading cost figures in the Admin UI dashboard for runs billed through the Claude subscription.

## Acceptance Criteria

- [ ] **R1**: Tenant can store Claude subscription token via Admin API; token is encrypted at rest (AES-256-GCM)
- [ ] **R2**: Tenant can set custom base URL; defaults to `https://api.claude.ai` when omitted
- [ ] **R3**: One-shot Claude SDK runs use subscription token + base URL when configured
- [ ] **R4**: Tenants without subscription token continue using AI Gateway (no behavior change)
- [ ] **R5**: Session runs (create, reconnect, cold-start) use subscription token
- [ ] **R6**: Admin UI settings page has "Claude Subscription" section with token, base URL, and expiry fields
- [ ] **R7**: Vercel AI SDK runner (non-Claude models) always uses `AI_GATEWAY_API_KEY` regardless of subscription token
- [ ] **R8**: Subscription token is ONLY used when effective runner is `claude-agent-sdk` — non-Anthropic models never see it
- [ ] **R9**: Token validated on save via test API call; invalid tokens rejected with clear error
- [ ] **R10**: Optional expiry date with UI warnings (amber "Expires soon" at 30 days, red "Expired")
- [ ] **R11**: Cost recorded as $0 for subscription-token runs; token usage still tracked for analytics
- [ ] Token never appears in GET responses, logs, or transcripts (scrubbing applied)
- [ ] Network allowlist includes subscription base URL hostname dynamically
- [ ] Custom base URL validated as HTTPS-only at save time
- [ ] Auth resolution cached at process level (5-min TTL)

## Dependencies & Risks

**Dependencies:**
- Existing AES-256-GCM encryption infrastructure (`src/lib/crypto.ts`)
- `ENCRYPTION_KEY` env var must be set (already required)

**Risks:**
- **Token reliability**: Community reports `sk-ant-oat01-*` tokens sometimes expire before 1 year. Mitigation: clear error messaging when auth fails, easy token rotation via UI.
- **ToS compliance**: Using subscription tokens programmatically may violate Anthropic's ToS. Mitigation: tenant's responsibility (documented in scope boundaries).
- **Stale token in active sessions**: Sessions created before a token update will use the old token until they go idle and get recreated. Acceptable — max 10 min stale window. Auth cache invalidated on PATCH, so new runs pick up changes within seconds.
- **Token exposure in error messages**: Anthropic API error responses might echo the token. Mitigation: `scrubSecrets()` applied to transcript capture.
- **SSRF via custom base URL**: DNS rebinding could resolve to internal IPs after validation. Mitigation: HTTPS-only validation at PATCH time; Vercel sandbox network policy provides additional layer.
- **`SELECT *` leak**: GET handler must use explicit column list to prevent encrypted blob in API responses.

## Deployment Checklist

- [ ] Migration 023 is additive-only (nullable TEXT columns, no DEFAULT) — zero-downtime safe
- [ ] `IF NOT EXISTS` ensures idempotent reruns
- [ ] `npm run migrate && next build` guarantees migration runs before new code
- [ ] Rollback: `DROP COLUMN IF EXISTS` on both columns (no data to lose at deploy time)
- [ ] Monitor: watch for Zod parse errors and 500s on tenant routes in the first hour

## Files to Modify

| File | Change |
|---|---|
| `src/db/migrations/023_add_subscription_token.sql` | **NEW** — add columns to tenants |
| `src/lib/tenant-auth.ts` | **NEW** — `resolveSandboxAuth()`, `buildSandboxAuthEnv()`, process-level cache |
| `src/lib/validation.ts` | Add fields to `TenantRow` |
| `src/lib/sandbox.ts` | Replace 3 hardcoded env blocks with `buildSandboxAuthEnv()`, update config interfaces (`aiGatewayApiKey` → `auth: SandboxAuth`) |
| `src/lib/run-executor.ts` | Call `resolveSandboxAuth()` in `Promise.all()`, pass auth to config |
| `src/lib/session-executor.ts` | Same — 3 call sites, add to `Promise.all()` batches |
| `src/lib/transcript-utils.ts` | Add `scrubSecrets()` utility, apply in `captureTranscript()` |
| `src/app/api/admin/tenants/[tenantId]/route.ts` | Accept token in PATCH (encrypt), explicit column list in GET, return `has_subscription_token` |
| `src/app/admin/(dashboard)/settings/company-form.tsx` | Add token + URL fields |
| `src/app/admin/(dashboard)/settings/page.tsx` | Pass new fields to CompanyForm |

## Sources & References

### Origin

- **Origin document:** [docs/brainstorms/2026-03-21-subscription-token-auth-requirements.md](../brainstorms/2026-03-21-subscription-token-auth-requirements.md) — Key decisions: per-tenant (not per-agent), reuse existing encryption, default to api.claude.ai

### Internal References

- Encryption pattern: `src/lib/crypto.ts:69-115`
- Existing encrypted column: `src/db/migrations/007_add_mcp_servers_and_connections.sql:30`
- Sandbox env setup: `src/lib/sandbox.ts:313-323`
- Run executor config: `src/lib/run-executor.ts:66`
- Session executor config: `src/lib/session-executor.ts:75,128,164`
- Admin settings form: `src/app/admin/(dashboard)/settings/company-form.tsx`
- Admin tenant API: `src/app/api/admin/tenants/[tenantId]/route.ts`
- Network allowlist: `src/lib/sandbox.ts:224-236`
- Process-level cache pattern: `src/lib/sandbox.ts:17-18` (snapshot cache)
- MCP token storage: `src/lib/mcp-connections.ts:323` (JSON.stringify encrypt pattern)

### External References

- Claude Code authentication docs: https://code.claude.com/docs/en/authentication
- Auth precedence: `ANTHROPIC_AUTH_TOKEN` > `ANTHROPIC_API_KEY` (Bearer vs X-Api-Key)
- Agent SDK quickstart: https://platform.claude.com/docs/en/agent-sdk/quickstart
