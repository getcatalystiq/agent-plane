# Subscription Token Authentication -- Flow Analysis

## User Flow Overview

### Flow 1: Token Configuration (Admin UI)
1. Admin navigates to `/admin/settings`
2. Admin enters subscription token (`sk-ant-oat01-*`) and optional base URL
3. Token is encrypted (AES-256-GCM) and stored in `tenants` table
4. Confirmation shown; all subsequent Anthropic-model runs use the token

### Flow 2: One-Shot Run with Token
1. Client POSTs to `/api/agents/:id/runs`
2. `prepareRunExecution()` loads tenant record (needs token + base URL)
3. `createSandbox()` receives token instead of `aiGatewayApiKey`
4. Sandbox env: `ANTHROPIC_AUTH_TOKEN=<decrypted_token>`, `ANTHROPIC_BASE_URL=<custom_or_default>`
5. Network allowlist includes custom base URL hostname (parsed dynamically)
6. Claude Agent SDK uses token directly against Anthropic API

### Flow 3: Session Run with Token
1. Same as Flow 2, but via `prepareSessionSandbox()` and `reconnectSessionSandbox()`
2. Three env-setting sites in `sandbox.ts` (lines ~320, ~868, ~1091) all need updating

### Flow 4: A2A Run with Token
1. `SandboxAgentExecutor` calls `prepareRunExecution()` -- same path as Flow 2
2. No additional changes needed if `prepareRunExecution` handles token injection

### Flow 5: Scheduled Run with Token
1. Cron dispatcher calls run executor -- same path as Flow 2

### Flow 6: Vercel AI SDK Run (Non-Anthropic) -- No Change
1. Token is ignored; `AI_GATEWAY_API_KEY` used as before (R7)

### Flow 7: Token Deletion / Rollback
1. Admin clears token field in settings
2. Tenant record updated (token columns set to NULL)
3. Subsequent runs revert to AI Gateway

---

## Flow Permutations Matrix

| Scenario | Runner | Token Present | Auth Used | Base URL | Network Allow |
|---|---|---|---|---|---|
| Anthropic model, token set | Claude SDK | Yes | Subscription token | Custom or api.claude.ai | Custom host added |
| Anthropic model, no token | Claude SDK | No | AI Gateway key | ai-gateway.vercel.sh | Unchanged |
| Non-Anthropic model, token set | Vercel AI SDK | Ignored | AI Gateway key | ai-gateway.vercel.sh | Unchanged |
| Non-Anthropic model, no token | Vercel AI SDK | No | AI Gateway key | ai-gateway.vercel.sh | Unchanged |
| Session reconnect, token set | Claude SDK | Yes | Subscription token | Custom host | Custom host added |
| Session cold start, token set | Claude SDK | Yes | Subscription token | Custom host | Custom host added |

---

## Missing Elements and Gaps

### 1. Token Lifecycle Management

**Gap: Token expiry detection and notification.**
The spec says tokens have ~1yr validity but does not specify:
- How to detect an expired token (Anthropic returns 401)
- Whether to notify the tenant admin when a token is nearing expiry
- Whether to auto-fallback to AI Gateway on auth failure or fail the run
- Impact: Runs will fail silently or with opaque sandbox errors if the token expires

**Gap: Token rotation flow.**
- Can the tenant update the token while runs are in-flight?
- In-flight runs have already received the old token as a sandbox env var -- they are unaffected
- But what about active sessions? The sandbox env was set at session creation time
- Impact: Session sandboxes may use stale tokens until recreated (up to 10 min idle timeout)

**Gap: Token format validation.**
- Should the API validate the `sk-ant-oat01-*` prefix on save?
- Should it attempt a lightweight auth check (e.g., GET /v1/models) to verify the token works?
- Impact: Invalid tokens stored silently, discovered only at run time

### 2. Sandbox Environment Injection (Three Sites)

**Gap: Tenant record not currently loaded in sandbox creation path.**
Currently `createSandbox()` receives `aiGatewayApiKey` as a string parameter. The function does not have access to the tenant record. The spec needs to clarify:
- Does the caller (`prepareRunExecution` / `prepareSessionSandbox`) decrypt the token and pass it down?
- Or does `createSandbox` receive a new `subscriptionToken?: string` + `customBaseUrl?: string` parameter?
- Recommendation: Caller decrypts and passes; `createSandbox` stays encryption-unaware

**Gap: The three env-setting sites are:**
1. `sandbox.ts` line ~320 (one-shot `createSandbox`)
2. `sandbox.ts` line ~868 (session `createSessionSandbox`)
3. `sandbox.ts` line ~1091 (session `reconnectSessionSandbox` / `updateMcpConfig`)

All three must apply identical conditional logic. Risk of divergence is high.
- Recommendation: Extract a helper `resolveSandboxAuthEnv(aiGatewayKey, subscriptionToken?, customBaseUrl?)` that returns the env vars dict

### 3. Network Allowlist

**Gap: Dynamic hostname parsing from custom base URL.**
- If `customBaseUrl` is `https://api.claude.ai`, hostname is `api.claude.ai`
- If tenant sets a proxy URL like `https://proxy.corp.example.com`, that hostname must be allowed
- What if the URL is malformed? Validation needed at save time
- What about wildcard subdomains? The current allowlist uses `*.composio.dev` patterns -- subscription base URLs should be exact hostnames only
- Impact: Sandbox network errors if hostname not allowlisted; potential security issue if wildcards allowed

**Gap: AI Gateway still needed in allowlist?**
Even with a subscription token, the Vercel AI SDK runner (for non-Anthropic models on the same tenant) still needs `ai-gateway.vercel.sh`. The AI Gateway hostname must remain in the allowlist regardless.

### 4. Security Concerns

**Gap: Token exposure in logs.**
- `sandbox.ts` sets env vars that are visible in sandbox metadata. Are sandbox env vars logged anywhere?
- The `logger.info`/`logger.warn` calls in run-executor and session-executor should never log the token
- Sandbox process environment is accessible inside the sandbox -- the agent code itself can read `process.env.ANTHROPIC_AUTH_TOKEN`. This is inherent to the architecture and acceptable, but worth noting
- Impact: Token leak via structured logs or error stack traces

**Gap: Token exposure in error responses.**
- If sandbox creation fails, the error message should not contain the decrypted token
- `claudeSdkErrorAndCleanup()` may capture stderr that includes the token in error context
- Impact: Token leaked to API consumer via error event in NDJSON stream

**Gap: Admin audit trail.**
- Who changed the token? The current admin auth is a single shared JWT. No per-user audit
- When was it changed? Need `subscription_token_updated_at` column
- Impact: No accountability for token changes in multi-admin setups

**Gap: Token visibility in Admin UI.**
- After saving, should the UI show the full token or a masked version (e.g., `sk-ant-oat01-****...****`)?
- On the API side, `GET /api/admin/tenants/:id` must NOT return the decrypted token
- Should return a boolean `has_subscription_token: true` or a masked prefix
- Impact: Token exposure to any admin who can call the tenant API

### 5. Error Handling

**Gap: Subscription quota exceeded (429 from Anthropic).**
- Claude Agent SDK inside the sandbox handles retries internally, but what if the quota is fully exhausted?
- The run will fail with an error event. Is the error message from Anthropic's API informative enough?
- Should the platform detect 429/quota errors and surface a specific `subscription_quota_exceeded` event type?
- Impact: Opaque "run failed" errors; tenant cannot distinguish quota issues from other failures

**Gap: Auth failure (401) at runtime.**
- Invalid or revoked token causes immediate 401 from Anthropic
- The sandbox runner script will get an SDK error -- this surfaces as a `run_error` event
- Should the platform interpret this and suggest "check your subscription token"?
- Impact: Confusing errors; user thinks the platform is broken rather than their token

**Gap: Partial failure in sessions.**
- Session message 1-5 succeed; message 6 fails because token was revoked between messages
- Session is now in `active` state with a failed run. Does it transition to `idle` or `stopped`?
- The existing `finalizeSessionMessage` should handle this, but confirm error path
- Impact: Stuck sessions if error handling doesn't trigger proper state transition

**Gap: Mixed-model agents.**
- An agent configured with an Anthropic model gets the subscription token
- If the agent uses MCP tools that themselves call AI models (via Composio), those still use their own auth
- But what if someone changes the agent's model from Anthropic to non-Anthropic while a session is active?
- Impact: Session sandbox has wrong auth env until recreated

### 6. Race Conditions

**Gap: Token update during concurrent runs.**
- Tenant admin updates token while 5 runs are in-flight
- In-flight runs: Already have old token in sandbox env. They continue using it. This is safe
- New runs: Will pick up the new token. This is correct
- No race condition here -- env vars are set at sandbox creation time (point-in-time snapshot)

**Gap: Token update during session reconnect.**
- Session is idle. Admin updates token. User sends message
- `prepareSessionSandbox` reconnects to existing sandbox
- `reconnectSessionSandbox` calls `updateMcpConfig()` which can update env vars
- But does it also update `ANTHROPIC_AUTH_TOKEN`? Currently `updateMcpConfig` only updates MCP-related vars
- Impact: Session uses stale token until sandbox dies and cold-starts. Up to 10 min window
- Recommendation: `updateMcpConfig` (or a new `updateSandboxEnv`) should also refresh auth env vars on reconnect

**Gap: Concurrent token save and run creation.**
- Admin saves token at T=0. Run created at T=0+50ms
- If the DB write hasn't committed, the run may or may not see the new token
- This is a standard read-after-write consistency issue. Neon pooled connections may serve stale reads
- Impact: Low probability, self-resolving on next run. Acceptable

### 7. Migration and Rollout

**Gap: Database migration.**
- Need new columns on `tenants`: `subscription_token_encrypted` (JSONB, matches existing encrypted data pattern), `subscription_base_url` (TEXT, nullable)
- Migration 023 -- straightforward ALTER TABLE ADD COLUMN
- No backfill needed (all NULLs = AI Gateway behavior)

**Gap: Backward compatibility.**
- Existing tenants with no token: behavior unchanged (R4). Verified by code path analysis
- API response schema: new optional fields in tenant GET responses
- SDK: Does the TypeScript SDK expose tenant settings? If so, needs type update

### 8. Observability

**Gap: Distinguishing token-authed runs from gateway-authed runs.**
- Should `runs` table record which auth method was used?
- Useful for debugging and cost attribution (subscription vs. gateway billing)
- Could be a simple `auth_method` column: `'gateway'` | `'subscription'`
- Impact: Without this, diagnosing auth-related failures requires checking tenant config at the time of the run

**Gap: Cost tracking divergence.**
- AI Gateway runs: cost computed from model catalog pricing via `parseResultEvent`
- Subscription token runs: same model, but billed via Anthropic subscription, not AI Gateway
- Should the platform still record computed cost? It would be inaccurate (tenant pays Anthropic directly)
- Should cost be recorded as $0 for subscription runs? Or still tracked as "estimated cost"?
- Impact: Dashboard cost charts become misleading if subscription runs are costed the same as gateway runs

---

## Critical Questions Requiring Clarification

### Critical (blocks implementation or creates security/data risks)

**Q1: Should the platform fall back to AI Gateway if the subscription token fails (401/403)?**
Why it matters: Determines error handling strategy and whether runs can silently switch auth methods.
Default assumption: No fallback -- fail the run and surface the auth error. Silent fallback hides token problems.

**Q2: Must `GET /api/admin/tenants/:id` and `GET /api/tenants/me` never return the decrypted token?**
Why it matters: Token exposure to any authenticated caller.
Default assumption: Return `has_subscription_token: boolean` and masked prefix only. Never return plaintext.

**Q3: How should session reconnects handle a changed token?**
Why it matters: Sessions can run for up to 10 minutes on a stale token after admin updates it.
Default assumption: Refresh auth env vars on every session reconnect (alongside MCP config refresh).

### Important (significantly affects UX or maintainability)

**Q4: Should the API validate the token format (`sk-ant-oat01-*`) on save, or accept any string?**
Why it matters: Prevents saving typos or wrong credential types.
Default assumption: Validate prefix format; do not probe Anthropic API.

**Q5: Should subscription-token runs record cost as $0 or as estimated cost?**
Why it matters: Dashboard accuracy; tenant may be confused seeing costs for subscription-billed runs.
Default assumption: Record estimated cost with a flag `billing_source: 'subscription' | 'gateway'`.

**Q6: Should the custom base URL field validate that the URL is well-formed and HTTPS?**
Why it matters: Malformed URLs cause sandbox network errors; HTTP would be a security issue.
Default assumption: Validate URL format and require HTTPS scheme.

**Q7: Should there be a `subscription_token_updated_at` timestamp for audit purposes?**
Why it matters: Debugging token issues requires knowing when the token was last changed.
Default assumption: Yes, add the column.

### Nice-to-have (improves clarity but has reasonable defaults)

**Q8: Should the platform proactively test the token on save (e.g., call Anthropic's /v1/models)?**
Why it matters: Catches invalid tokens immediately rather than at first run.
Default assumption: No -- adds latency and external dependency to the settings save flow.

**Q9: Should there be a per-run indicator in the API/UI showing which auth method was used?**
Why it matters: Observability and debugging.
Default assumption: Defer to a follow-up iteration.

**Q10: Should token expiry warnings be implemented (e.g., 30 days before ~1yr expiry)?**
Why it matters: Prevents surprise failures.
Default assumption: Defer -- requires knowing the token's creation date, which Anthropic may not expose.

---

## Recommended Next Steps

1. **Extract `resolveSandboxAuthEnv()` helper** to eliminate the three-site divergence risk in `sandbox.ts`
2. **Add `subscription_token_encrypted` (JSONB) and `subscription_base_url` (TEXT)** columns to `tenants` via migration 023
3. **Update `prepareRunExecution` and `prepareSessionSandbox`** to load and decrypt the tenant token, passing it to sandbox creation
4. **Update `reconnectSessionSandbox` path** to refresh auth env vars (not just MCP config) on reconnect
5. **Add token masking** to all tenant API responses (`has_subscription_token` + masked prefix)
6. **Add input validation** for token format and base URL (HTTPS, well-formed) on the settings save endpoint
7. **Add `api.claude.ai` to the static allowlist** (it is the default and most common case) and parse custom hostnames dynamically
8. **Audit all logger calls** in sandbox.ts, run-executor.ts, and session-executor.ts to ensure tokens are never logged
9. **Update Admin UI settings page** with token field (password input type), base URL field, and "connected" indicator
10. **Decide on cost tracking strategy** for subscription-authed runs before implementation
