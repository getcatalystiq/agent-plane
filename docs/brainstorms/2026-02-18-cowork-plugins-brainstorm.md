# Brainstorm: Cowork Plugin Integration

**Date:** 2026-02-18
**Status:** Draft
**Related:** Agent skills system, Composio toolkits, MCP connections

## What We're Building

Integrate Claude Cowork plugins into AgentPlane so agents can use community-built skills, commands, and connector recommendations from plugin marketplaces (GitHub repos like `anthropics/knowledge-work-plugins`).

**Core capability:** Admin registers plugin marketplace repos globally. When configuring an agent, you select which plugins from those marketplaces to enable. At run time, plugin skills and commands are fetched from GitHub and injected into the sandbox alongside existing agent-level skills.

**Connector suggestions:** Plugins include `.mcp.json` files with recommended MCP connectors. These are parsed and shown as informational suggestions on the agent detail page under Connectors — only those not already connected. Suggestions are mapped to Composio toolkits via name-based fuzzy matching.

## Why This Approach

- **Minimal storage** — Plugin content is fetched at runtime from GitHub; only marketplace URLs and per-agent plugin selections are stored in the DB
- **Leverages existing skill injection** — Plugin skills/commands use the same file-injection mechanism as agent skills, just from a different source
- **Non-disruptive** — Agent-level skills remain unchanged; plugins are additive
- **Composio reuse** — Connector suggestions map to existing Composio toolkit integration, avoiding a new integration layer

## Key Decisions

### 1. Global marketplaces, per-agent plugin selection
- Admin registers marketplace GitHub repos in a global registry
- Per-agent: select which plugins from those marketplaces to enable
- No tenant-level plugin config (keep it simple)

### 2. Runtime fetch from GitHub with short TTL cache
- Plugin file contents (skills/*.md, commands/*.md, .mcp.json) are fetched from GitHub API when a run starts
- **5-minute in-memory cache** on fetched content to avoid redundant GitHub API calls for back-to-back runs
- Trade-off: adds GitHub API latency on cache miss; gains simplicity and near-fresh content
- GitHub API rate limit: 60 req/hr unauthenticated (cache makes this comfortable)

### 3. Injection into existing directories with prefix naming
- Plugin skills → `.claude/skills/<plugin-name>-<skill-filename>.md` (flat, prefixed)
- Plugin commands → `.claude/commands/<plugin-name>-<command-filename>.md` (flat, prefixed)
- Prefix avoids collisions between plugins while keeping a flat directory structure
- Coexists with agent-level skills in `.claude/skills/`

### 4. Minimal data model
- **`plugin_marketplaces` table:** `id`, `name`, `github_repo` (e.g., `anthropics/knowledge-work-plugins`), `created_at`, `updated_at`
- **Agent `plugins` JSON column:** `[{marketplace_id, plugin_name}]` — list of selected plugins per agent
- Plugin list (names, descriptions) fetched live from GitHub API on admin page load

### 5. Connector suggestions via name matching
- Parse `.mcp.json` from each enabled plugin
- Extract connector names (e.g., "slack", "hubspot", "linear")
- Fuzzy-match against Composio toolkit slugs
- Display as "Suggested by [plugin-name]" in the Connectors section
- Only show connectors not already connected
- Informational only — no auto-connect

### 6. Public repos only
- Only support public GitHub repos for marketplaces (no auth token needed)
- Can add optional per-marketplace GitHub token later for private repos

## Cowork Plugin Format Reference

```
plugin-name/
├── .claude-plugin/
│   └── plugin.json          # Manifest (name, description, version)
├── .mcp.json                # Recommended MCP connectors
├── commands/                # Slash commands (user-invoked)
│   └── *.md
└── skills/                  # Domain knowledge (auto-triggered)
    └── *.md
```

Plugins are entirely file-based (markdown + JSON). No code, no build steps.

Example marketplace: `anthropics/knowledge-work-plugins` contains 11 plugins (sales, finance, legal, data, marketing, etc.).

## Implementation Sketch

### Database Changes
```sql
-- New table: plugin_marketplaces (global, no RLS)
CREATE TABLE plugin_marketplaces (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  github_repo TEXT NOT NULL UNIQUE,  -- e.g. 'anthropics/knowledge-work-plugins'
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- New column on agents table
ALTER TABLE agents ADD COLUMN plugins JSONB DEFAULT '[]';
-- Format: [{marketplace_id: "uuid", plugin_name: "sales"}, ...]
```

### Runtime Flow
1. Run starts → load agent's `plugins` list
2. For each plugin, fetch from GitHub API:
   - `GET /repos/{owner}/{repo}/contents/{plugin_name}/skills/` → list skill files
   - `GET /repos/{owner}/{repo}/contents/{plugin_name}/commands/` → list command files
   - Fetch each file's content (base64 decode from GitHub API response)
3. Inject skill files into `.claude/skills/` and command files into `.claude/commands/`
4. Existing agent skills are injected as before (no change)
5. Build MCP config as before (Composio + custom MCP servers)

### Admin UI Changes
- **New page:** Plugin Marketplaces management (list, add, remove repos)
- **Agent detail page:** New "Plugins" section showing available plugins from registered marketplaces with toggle/checkbox to enable per agent
- **Connectors section:** Add "Suggested by plugins" subsection showing recommended connectors from enabled plugins' `.mcp.json` files, filtered to exclude already-connected toolkits

### GitHub API Usage
- List repo contents: `GET /repos/{owner}/{repo}/contents/{path}`
- Unauthenticated rate limit: 60 requests/hour
- Each plugin discovery: ~1 request (list top-level dirs)
- Each plugin file fetch: 1 request per file
- Typical plugin: 3-8 files → ~10 requests per full plugin fetch

### 7. Default branch only (no version pinning)
- Always fetch from the repo's default branch
- Keeps it simple; pinning to commits/tags can be added later if needed

## Resolved Questions

1. **Rate limiting strategy:** 5-minute in-memory TTL cache on GitHub API responses. Avoids redundant fetches for back-to-back runs while keeping content fresh.

2. **Plugin file naming conflicts:** Prefix filenames with plugin name (e.g., `sales-call-prep.md`). Flat structure, simple collision avoidance.

3. **Plugin versioning:** Default branch only for now. No pinning to commits/tags — add later if reproducibility becomes a concern.
