---
date: 2026-03-21
topic: subscription-token-auth
---

# Subscription Token Authentication for Agents

## Problem Frame

AgentPlane currently routes all Claude Agent SDK calls through Vercel AI Gateway using a shared `AI_GATEWAY_API_KEY`. Tenants who have Claude Pro/Max subscriptions want to use their subscription quota instead of per-token API billing. Claude Code supports long-lived OAuth tokens (`sk-ant-oat01-*`, ~1yr validity) via `setup-token`, which authenticate against `api.claude.ai` using `Authorization: Bearer` headers. The Agent SDK already respects `ANTHROPIC_AUTH_TOKEN` + `ANTHROPIC_BASE_URL` (this is how AI Gateway routing works today), so subscription tokens can be used by swapping these values.

## Requirements

- R1. Tenants can optionally store a subscription token (encrypted at rest using existing AES-256-GCM infrastructure)
- R2. Tenants can optionally store a custom base URL (defaults to `https://api.claude.ai` when a subscription token is present)
- R3. When a tenant has a subscription token configured, all Claude Agent SDK sandbox runs for that tenant use the subscription token + base URL instead of the AI Gateway key
- R4. When no subscription token is configured, behavior is unchanged (AI Gateway key used)
- R5. Subscription token is used for both one-shot runs and session runs
- R6. Admin UI settings page exposes fields for subscription token and base URL
- R7. Vercel AI SDK runner (non-Anthropic models) continues using AI Gateway regardless of subscription token

## Success Criteria

- A tenant with a valid `sk-ant-oat01-*` token can run Claude agents billed against their subscription
- Existing tenants without subscription tokens are unaffected
- Token is never exposed in plaintext after storage (encrypted at rest, masked in UI)

## Scope Boundaries

- Token acquisition is out of scope — tenants obtain their own tokens externally
- Token refresh/rotation is out of scope — tokens are long-lived (~1yr); tenants update manually
- Per-agent token override is out of scope — token is tenant-level only
- ToS compliance is the tenant's responsibility
- Vercel AI SDK runner routing is unaffected (always uses AI Gateway)

## Key Decisions

- **Per-tenant, not per-agent**: Simpler, matches existing AI Gateway key pattern. Can extend later if needed.
- **Reuse existing encryption**: Same `ENCRYPTION_KEY` / AES-256-GCM used for API keys and MCP tokens.
- **Defaults to api.claude.ai**: When subscription token is set but base URL is not, defaults to `https://api.claude.ai`. Configurable base URL supports proxies or future endpoint changes.

## Outstanding Questions

### Deferred to Planning

- [Affects R3][Technical] Should the sandbox network allowlist be updated to include `api.claude.ai` when subscription token is active?
- [Affects R3][Technical] How should `ANTHROPIC_API_KEY` be handled — keep empty string, or set to the subscription token as well for SDK compatibility?
- [Affects R6][Technical] What's the best UI pattern for the token field — password input with reveal toggle, or just masked display after save?

## Next Steps

→ `/ce:plan` for structured implementation planning
