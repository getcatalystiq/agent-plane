# Plugin Management Interface

**Date:** 2026-02-18
**Status:** Brainstorm

## What We're Building

A management interface for plugin marketplaces that lets admins:

1. **See ownership status** — Marketplaces with a configured GitHub token show an "Owned" badge on the marketplace list page
2. **Browse plugins** — Click any marketplace to see its plugins (read-only for non-owned, editable for owned)
3. **Edit owned plugins** — For owned marketplaces, click a plugin to open editors for:
   - **Skills** (`.md`, `.json`, `.js`, `.ts` files in `/skills/`)
   - **Commands** (`.md` files in `/commands/`)
   - **Connectors** (`.mcp.json` at plugin root — suggested MCP server connections)
4. **Push changes to GitHub** — Edits are committed and pushed directly to the main branch using the marketplace's configured token (via GitHub Git Trees + Commits API for atomic multi-file commits)

## Why This Approach

- **Builds on existing infrastructure** — Reuses the marketplace table, plugin discovery from GitHub, skills editor CodeMirror pattern, and AES-256-GCM encryption for token storage
- **Simple ownership model** — Repo-level ownership via GitHub token presence. No complex per-plugin permissions needed.
- **Direct push to main** — Keeps the workflow simple. No PR/branch complexity for plugin edits.
- **Consistent navigation** — All marketplaces are clickable (owned and non-owned), providing a uniform browsing experience with the editing capability gated by token presence.

## Key Decisions

1. **Ownership = GitHub token on marketplace** — A marketplace is "owned" if it has a `github_token` configured. All plugins in an owned marketplace are editable.
2. **Token stored per-marketplace** — Added via add/edit marketplace form, stored encrypted (`github_token_enc`) in the `plugin_marketplaces` table using the existing `ENCRYPTION_KEY`.
3. **Direct push to main** — No PR workflow. Save in UI = commit + push to main branch immediately.
4. **Three-level navigation** — Marketplace list → Plugin list → Plugin editor (skills + commands + connectors).
5. **Read-only for non-owned** — Clicking a non-owned marketplace shows plugins in read-only view mode (can see skills/commands/connectors but not edit).
6. **Reuse existing SkillsEditor component** — The plugin editor reuses the same `SkillsEditor` component (CodeMirror folder/file tree) from the agent detail page for both skills and commands. The component's save action changes from agent PATCH to GitHub push. Connectors are edited via an `.mcp.json` JSON editor.

## Scope

### In scope
- GitHub token configuration on marketplace (add/edit form, encrypted storage)
- "Owned" badge on marketplace list
- Marketplace detail page listing plugins
- Plugin detail page with skill editor, command editor, connector editor
- GitHub Contents API integration to push changes to main
- Read-only view for non-owned marketplace plugins

### Out of scope
- PR/branch workflow for changes
- Plugin creation (new plugins added directly in the GitHub repo)
- Plugin deletion
- Version history / rollback in the UI
- Per-plugin ownership overrides

## New Pages

| Route | Description |
|---|---|
| `/admin/plugin-marketplaces` | Existing — add "Owned" badge, make names clickable |
| `/admin/plugin-marketplaces/[id]` | NEW — Plugin list for a marketplace |
| `/admin/plugin-marketplaces/[id]/plugins/[name]` | NEW — Plugin editor (skills, commands, connectors) |

## Database Changes

- Add `github_token_enc BYTEA` column to `plugin_marketplaces` table (nullable, encrypted with existing ENCRYPTION_KEY)

## API Changes

- `GET /api/admin/plugin-marketplaces/[id]/plugins` — List plugins in a marketplace (reuse existing `listPlugins`)
- `GET /api/admin/plugin-marketplaces/[id]/plugins/[name]` — Fetch full plugin content (skills, commands, .mcp.json)
- `PUT /api/admin/plugin-marketplaces/[id]/plugins/[name]` — Save plugin changes, push to GitHub via Git Trees + Commits API (atomic multi-file commit)
- `PATCH /api/admin/plugin-marketplaces/[id]` — Update marketplace (e.g., add/change GitHub token)

## Open Questions

None — all key questions resolved during brainstorm.
