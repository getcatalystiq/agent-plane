# Composio Auth Method Picker — Requirements

**Date:** 2026-04-26
**Status:** Brainstorm complete; ready for `/ce-plan`
**Scope:** Standard

## Problem

Today the connector card auto-picks a single auth scheme per Composio toolkit using a fixed priority (`no_auth → OAUTH2 → OAUTH1 → API_KEY → OTHER`) and renders one of two UIs: an OAuth Connect button or an API-key field. There is no way for the user to choose a different scheme even when the toolkit supports it, and several modes Composio supports — bring-your-own-app OAuth, bearer/custom tokens with non-API-key shapes, BASIC, JWT variants — aren't wired in at all.

This blocks three concrete integrations the team needs:

- **Slack** — bot app + `xoxb-` token → Composio custom-auth connection → capture `bot_user_id`
- **Notion** — internal integration + `secret_…` token → grant connections on parent + KB scope → Composio custom-auth connection → capture `bot_user_id`
- **Linear** — OAuth app with `actor=app` → workspace install → Composio bring-your-own-app (BYOA) OAuth connection → capture `bot_user_id`

All three are needed in the first cut — the target use case is one agent posting to Slack, reading Notion, and filing Linear tickets, all acting as the same identity.

## Goals

1. When a Composio toolkit exposes more than one auth scheme, the user picks which one to use on the connector card.
2. Support these auth modes end-to-end:
   - Composio-managed OAuth (current behavior)
   - Bring-your-own-app OAuth (user supplies client ID + secret; Composio runs the redirect)
   - Custom-auth token (long-lived bearer-style tokens: `xoxb-`, `secret_…`, plain API keys)
3. After a connection is established, capture and persist a connection-identity value (`bot_user_id` — the integration's own identity in the target system) so agents can be aware of who they are.
4. Generic enough that adding a new Composio toolkit with multiple schemes does not require special-casing.

## Non-goals

- Auth schemes Composio supports but no current user needs (Composio Link, Google service account, billcom/calcom-specific) — leave fall-through behavior unchanged. The picker should be data-driven, so adding them later is a wiring task not a redesign.
- Tenant-level credential sharing. Credentials are per-agent (matches the existing per-agent toolkits model). Out of scope to centralize at the company level.
- Multi-account support per toolkit per agent (e.g., Workspace-A + Workspace-B Slack on the same agent). One connection per agent per toolkit.
- Auto-detecting which scheme a token belongs to. The user picks the scheme; the form matches.

## Users and primary flow

**Primary user:** AgentPlane admin configuring an agent's connectors.

**Flow:**
1. Admin adds a Composio toolkit (e.g. Linear) to the agent.
2. The connector card shows the toolkit's available auth schemes pulled from Composio's `auth_schemes` field. If only one is available, the card behaves as today. If multiple, a scheme selector appears.
3. Admin picks a scheme. The card swaps in the matching credential form:
   - **Composio OAuth**: Connect button → redirect → callback.
   - **BYOA OAuth**: Client ID + Client Secret fields + Connect button → redirect using user-supplied app → callback.
   - **Custom token**: Single token field (label and placeholder vary by toolkit) → Save.
4. After the connection becomes ACTIVE, the platform makes a per-toolkit "whoami" call to capture `bot_user_id` and stores it on the connection record.
5. Agent runs see the connection plus its captured identity (so the agent can know its own ID in the target system).

## Scope boundaries

**In scope:**
- Connector card UI: scheme selector + credential forms per scheme.
- Backend wiring: extend `saveApiKeyConnector` to accept arbitrary auth schemes via Composio's `use_custom_auth` mode; new BYOA OAuth flow that creates a per-tenant auth config with user-supplied `client_id`/`client_secret`.
- Post-connect identity capture, dispatched per toolkit (Slack `auth.test`, Notion `users/me`, Linear `viewer { id }`).
- Storing `bot_user_id` (or whatever the toolkit's identity field is called internally — column name TBD in plan).
- Scheme switching: changing scheme cleanly removes the prior connected account + auth config and creates a fresh one.

**Outside this scope:**
- Tenant-level credential vault (Phase 2 if needed).
- A "test connection" button beyond what Composio status already exposes.
- Surfacing `bot_user_id` to the model via tool args or system prompt — that's a follow-up consumer story; this brainstorm only captures and stores it.

## Success criteria

- An admin can add Slack to an agent, paste an `xoxb-` token, and the agent can call Slack tools using that token. The connection record stores the bot user ID returned by `auth.test`.
- An admin can add Notion to an agent, paste a `secret_…` integration token, and the agent can call Notion tools. The connection record stores the integration's user ID returned by `users/me`.
- An admin can add Linear to an agent, paste their own OAuth app's client ID + secret, complete the install redirect, and the agent can call Linear tools acting as the app. The connection record stores the app's user ID from the `viewer` query.
- For toolkits with only one scheme, the UI is unchanged from today.
- Removing a toolkit cleans up auth configs and connected accounts as it does today.

## Open questions for `/ce-plan`

- **Schema:** new column on agent connector record for `bot_user_id`, or a generic `connection_metadata JSONB`? The latter is more future-proof but requires picking a key naming convention.
- **Whoami dispatch:** per-toolkit functions in `src/lib/composio.ts`, or a small registry keyed by slug? Plan should pick.
- **Scheme switching:** if user picks BYOA OAuth, completes connect, then switches to custom-token, do we delete the prior auth config or keep it for later? Default to delete (cleanest), but confirm in plan.
- **`auth_schemes` data shape:** the existing `getConnectorStatuses` already inspects `tk.auth_schemes`; verify what string values Composio actually returns for BYOA OAuth vs Composio-managed OAuth — they may share `OAUTH2` and require an `is_managed` flag inferred from `tk.no_auth`/auth-config defaults.
- **Migration:** existing rows have one connection per toolkit on a single auth config. Does anything need to be backfilled? Likely no, since the picker default for existing toolkits is the currently-detected scheme.

## Dependencies / assumptions

- Composio's API exposes `auth_schemes` per toolkit (already used in `getConnectorStatuses`); we assume it's stable enough to drive UI off.
- Composio supports `use_custom_auth` with `authScheme: "OAUTH2"` + `oauth_app_credentials: { client_id, client_secret }` for BYOA. To verify in plan against current SDK.
- Per-toolkit "whoami" endpoints are reachable via the Composio MCP tools we already invoke (so identity capture can ride on existing tool plumbing) or via direct HTTPS to the provider with the token. Plan to decide whether the runner does this on first run or the platform does it at connect-time.

## Files likely touched

- `src/lib/composio.ts` — extend auth-scheme detection (return list, not single), generalize `saveApiKeyConnector` to `saveCustomAuthConnector`, add BYOA OAuth flow, add per-toolkit identity-capture dispatch.
- `src/lib/types.ts` — `AuthScheme` enum widening, connector-status shape changes.
- `src/app/admin/(dashboard)/agents/[agentId]/connectors-manager.tsx` — scheme selector + per-scheme forms.
- `src/app/api/admin/agents/[agentId]/connectors/...` — new endpoint(s) for BYOA OAuth init + custom-token save.
- `src/db/migrations/` — new migration for connection metadata column on the agent or a connector-metadata table.
- `src/lib/validation.ts` — request schemas for new auth-method payloads.
