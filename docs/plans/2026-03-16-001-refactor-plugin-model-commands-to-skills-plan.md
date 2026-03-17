---
title: "refactor: Plugin Model Redesign — Merge Commands into Skills + Add Plugin Agents"
type: refactor
status: active
date: 2026-03-16
deepened: 2026-03-16
origin: docs/brainstorms/2026-03-16-plugin-model-redesign-brainstorm.md
---

# Plugin Model Redesign — Merge Commands into Skills + Add Plugin Agents

## Enhancement Summary

**Deepened on:** 2026-03-16
**Research agents used:** 7 (TypeScript reviewer, Architecture strategist, Pattern recognition, Code simplicity, Performance oracle, Agent-native reviewer, Best practices researcher)

### Key Improvements from Review
1. **Drop auto-migration** — remove `commands/` support entirely instead of maintaining a permanent backward-compat code path (simplicity reviewer, 3 agents agreed)
2. **Critical fix: `settingSources`** — must explicitly handle agent-only plugins triggering `settingSources: ["project"]` (all reviewers flagged)
3. **Add tenant plugin detail API** — agent-native gap: no way for API consumers to inspect plugin agent definitions (agent-native reviewer)
4. **Extract shared file-fetch helper** — avoid tripling the fetch-validate-warn pattern (pattern reviewer)
5. **SDK major version bump** — property deletion is a breaking change by semver rules (TS reviewer)

### Risks Discovered
- ~~Auto-migrated `command.md` filename wouldn't be discovered by Claude Code SDK (expects `SKILL.md`)~~ — resolved by dropping auto-migration entirely
- Agent-only plugins (no skills) would silently fail to trigger `settingSources: ["project"]`
- No tenant API to read plugin agent metadata (only boolean `hasAgents` flag)

---

## Overview

Anthropic merged slash commands into skills in Claude Code 2.1.3 (Jan 2026). The official plugin structure no longer has a `commands/` directory — plugins now contain **Agents, Skills, and Connectors**. AgentPlane must align with this upstream change.

This plan covers two changes shipped together:
1. **Commands → Skills merge** — eliminate the `commandFiles` concept entirely
2. **Plugin agent definitions** — add support for sub-agent `.md` files in plugins

## Problem Statement

AgentPlane's plugin system still treats commands and skills as separate concepts across 8+ files. This diverges from Anthropic's current plugin spec and prevents us from supporting plugin agents (a new upstream capability).

The separation exists at every layer:
- `PluginFileSet` has separate `skillFiles` and `commandFiles` arrays
- `fetchPluginContent()` has separate discovery logic for `commands/` vs `skills/`
- Admin UI has a dedicated "Commands" tab
- API routes handle command file CRUD separately
- SDK types expose `hasCommands` boolean

## Proposed Solution

1. Remove `commandFiles` from `PluginFileSet`, add `agentFiles`
2. Drop `commands/` support entirely — no auto-migration, no backward compat (marketplace maintainers rename `commands/` → `skills/`)
3. Add agent file discovery from `pluginName/agents/` directory
4. Replace "Commands" tab with "Agents" tab in admin UI
5. Inject agent files into sandbox at `.claude/agents/<plugin>-<agent>.md`
6. Add read-only tenant API for plugin detail (agent metadata)

## Technical Approach

### Architecture

```
Plugin (GitHub repo)          Sandbox (.claude/)
├── agents/                   ├── agents/
│   └── reviewer.md    →      │   └── myplugin-reviewer.md
├── skills/                   ├── skills/
│   └── lint/SKILL.md  →      │   └── myplugin-lint/SKILL.md
└── .mcp.json                 └── (MCP config injected separately)
```

### Implementation Phases

#### Phase 1: Core Library + Sandbox (plugins.ts, sandbox.ts, executors)

**Files:** `src/lib/plugins.ts`, `src/lib/sandbox.ts`, `src/lib/run-executor.ts`, `src/lib/session-executor.ts`

**Tasks:**

- [ ] Extract shared `PluginFile` type and file-fetch helper:
  ```typescript
  interface PluginFile { path: string; content: string }

  export interface PluginFileSet {
    skillFiles: PluginFile[];
    agentFiles: PluginFile[];
    warnings: string[];
  }

  // Shared helper to avoid tripling the fetch-validate-warn pattern
  async function fetchPluginFiles(
    entries: TreeEntry[], owner: string, repo: string,
    token: string | null, mapPath: (entry: TreeEntry) => string
  ): Promise<{ files: PluginFile[]; warnings: string[] }>
  ```
- [ ] Update `PluginListItem` interface: remove `hasCommands`, add `hasAgents`
- [ ] Update `listPlugins()`: replace `commands/` detection with `agents/` detection
- [ ] Update `fetchPluginContent()`:
  - **Remove command discovery entirely** — no `commands/` scanning, no auto-migration
  - **Add agent discovery**: find `.md` files in `{plugin}/agents/`, map to `.claude/agents/{safeName}-{agentName}.md` (flat naming)
  - Use shared `fetchPluginFiles()` helper for both skills and agents
  - Include `agentEntries.length` in `MAX_FILES_PER_PLUGIN` count check
  - Ensure agent fetches are in the same `Promise.all` block as skill fetches (not sequential)
- [ ] Update `run-executor.ts` (line 65): replace `[...pluginResult.skillFiles, ...pluginResult.commandFiles]` with `[...pluginResult.skillFiles, ...pluginResult.agentFiles]`
- [ ] Update `session-executor.ts` (lines 131, 165): same merge change
- [ ] **Fix `settingSources` for agent-only plugins**: update `buildRunnerScript()` (line 361) and `buildSessionRunnerScript()` — `hasSkills || hasPluginContent` must also consider agent files. Change to check `config.pluginFiles.length > 0` which already covers both skill and agent files merged into the array. Add unit test confirming agent-only plugins trigger `settingSources: ["project"]`.
- [ ] Add unit test: `.claude/agents/` paths pass sandbox root guard in `createSandbox()` path validation

#### Phase 2: Validation + API Routes

**Files:** `src/lib/validation.ts`, `src/app/api/admin/plugin-marketplaces/[marketplaceId]/plugins/[...pluginName]/route.ts`, `src/app/api/admin/plugin-marketplaces/[marketplaceId]/plugins/route.ts`, `src/app/api/plugin-marketplaces/[marketplaceId]/plugins/route.ts`

**Validation tasks:**

- [ ] Reuse existing `validateFrontmatter()` for agent files — it already checks `name` + `description` required fields. No need for a separate `validateAgentFrontmatter()` function (AgentPlane doesn't interpret optional agent fields like `tools`, `model`, `maxTurns` — it just injects the file into the sandbox for Claude Code to parse).
- [ ] Add validation that agent file body (after frontmatter) is non-empty (system prompt required)

**Admin API route tasks:**

- [ ] **GET route** (plugin file listing):
  - Replace command file fetching with agent file fetching
  - Return `{ skills, agents, mcpJson, isOwned }` instead of `{ skills, commands, mcpJson, isOwned }`
  - Agent files: fetch from `{plugin}/agents/*.md` using `fetchFileContent()`
- [ ] **PUT route** (plugin file save):
  - Update `SavePluginSchema`: replace `commands` with `agents`
    ```typescript
    const SavePluginSchema = z.object({
      skills: z.array(z.object({ path: z.string(), content: z.string() })),
      agents: z.array(z.object({ path: z.string(), content: z.string() })),
      mcpJson: z.string().nullable(),
    });
    ```
  - Map agent files to GitHub paths: `{plugin}/agents/{path}`
  - Call `validateFrontmatter()` for agent `.md` files on save
  - Ensure `cacheRecentPush()` is called with agent file paths (match existing skill file pattern)
- [ ] **Admin plugin list route**: return `hasAgents` instead of `hasCommands`

**Tenant API route tasks:**

- [ ] **Tenant plugin list route** (`/api/plugin-marketplaces/[id]/plugins`): update to return `hasAgents` instead of `hasCommands` (uses shared `listPlugins()` so mostly automatic, but verify response shape)
- [ ] **New: Tenant plugin detail route** (`GET /api/plugin-marketplaces/[id]/plugins/[...pluginName]`): read-only endpoint returning plugin metadata (agent names + descriptions, skill names). No file content — just metadata extracted from frontmatter. This enables API consumers to discover what agents a plugin provides beyond a boolean flag.

#### Phase 3: Admin UI

**Files:** `src/app/admin/(dashboard)/plugin-marketplaces/[marketplaceId]/plugins/[...pluginName]/plugin-editor-client.tsx`

**Tasks:**

- [ ] Replace "Commands" tab with "Agents" tab (first position: Agents | Skills | Connectors)
- [ ] Update `activeTab` default from `"skills"` to `"agents"` (since Agents is now the first tab)
- [ ] Replace state: `commands`/`setCommands` → `agents`/`setAgents`
- [ ] Replace handler: `handleCommandsChange` → `handleAgentsChange`
- [ ] Replace props: `initialCommands` → `initialAgents`
- [ ] Update save handler: send `{ skills, agents, mcpJson }` instead of `{ skills, commands, mcpJson }`
- [ ] Update Agents tab `FileTreeEditor` config:
  - Agents are single `.md` files (not folders with SKILL.md). Determine if `FileTreeEditor` has a flat-file mode, or add one. The current "folder with entry file" mode is designed for skills — agents need direct file creation/editing.
  - `newFileTemplate={{ filename: "agent.md" }}`
- [ ] Update the parent page component that passes `initialCommands` → `initialAgents`
- [ ] Add `useEffect` fallback: if active tab disappears (e.g., plugin has no agents), fall back to first available tab

**Plugin list page:**
- [ ] Update `src/app/admin/(dashboard)/plugin-marketplaces/[marketplaceId]/page.tsx`: show "Agents" badge instead of "Commands" badge

#### Phase 4: SDK + Documentation + Tests

**Files:** `sdk/src/types.ts`, `sdk/src/resources/plugins.ts`, `CLAUDE.md`

**SDK tasks:**

- [ ] Update `PluginListItem` type: replace `hasCommands: boolean` with `hasAgents: boolean`
- [ ] **Bump SDK major version** (property deletion is a breaking change by semver rules, even for internal SDK — a published npm package should follow semver correctly)
- [ ] Add `getPlugin(marketplaceId, pluginName)` method to `PluginMarketplacesResource` (or a nested resource) for the new tenant detail endpoint
- [ ] Update SDK tests if any reference `hasCommands`

**Documentation tasks:**

- [ ] Update `CLAUDE.md`:
  - Remove all references to `.claude/commands/` injection path
  - Update plugin file injection: "Plugin skill files → `.claude/skills/...`; plugin agent files → `.claude/agents/...`"
  - Update `PluginFileSet` description
  - Update admin UI tab description: "Agents | Skills | Connectors"
  - Remove auto-migration references (no longer applicable)
  - Document that `commands/` directories in marketplace repos are ignored
- [ ] Clean up temp files: `rm docs/plugin-redesign-flow-analysis.md`, `rm docs/refactoring-best-practices.md`

**Test tasks:**

- [ ] Unit test: `fetchPluginContent()` with `agents/` directory discovery
- [ ] Unit test: `fetchPluginContent()` ignores `commands/` directory (no auto-migration)
- [ ] Unit test: `validateFrontmatter()` works for agent `.md` files (name + description required)
- [ ] Unit test: `.claude/agents/` paths pass sandbox root guard
- [ ] Unit test: agent-only plugins trigger `settingSources: ["project"]`
- [ ] Update `session-executor.test.ts` mock: `{ skillFiles: [], commandFiles: [] }` → `{ skillFiles: [], agentFiles: [] }`

## System-Wide Impact

### Interaction Graph

- `fetchPluginContent()` is called by `prepareRunExecution()` (run-executor), `prepareSessionSandbox()` (session-executor), and indirectly by `SandboxAgentExecutor` (A2A flow)
- Results flow into `createSandbox()` / `createSessionSandbox()` as flat `pluginFiles` array
- `listPlugins()` is called by admin plugin list route AND tenant plugin discovery route (shared function)
- Admin editor GET/PUT routes directly interact with GitHub API via `fetchFileContent()` / `pushFiles()`

### Error Propagation

- `fetchPluginContent()` failures are caught and returned as `warnings[]` — runs still execute without plugin content
- GitHub API failures in admin editor propagate as 500s to the admin UI
- Agent frontmatter validation failures should return 400 with specific field errors (same pattern as skill validation)

### State Lifecycle Risks

- **Orphaned command files in GitHub repos**: old `commands/` directories persist in marketplace repos but are now silently ignored. Marketplace maintainers must rename `commands/` → `skills/` manually. Document this in release notes.
- **No database migration needed**: plugin config is JSONB on agents table and doesn't store command/skill distinction

### API Surface Parity

- Tenant-facing API (`/api/plugin-marketplaces/*/plugins`): returns `PluginListItem[]` — updated to `hasAgents` instead of `hasCommands`
- **New**: Tenant plugin detail route for reading agent/skill metadata (read-only)
- Admin API: GET/PUT plugin files — schema changes from commands→agents
- SDK: `PluginListItem` type change (major version bump)

### Integration Test Scenarios

1. **Agent injection flow**: marketplace repo with `agents/reviewer.md` → `fetchPluginContent()` returns it in `agentFiles` → sandbox has `.claude/agents/{plugin}-reviewer.md`
2. **Commands ignored**: marketplace repo with `commands/check.md` → `fetchPluginContent()` ignores it → no files injected for commands
3. **Admin editor round-trip**: admin opens plugin with agents → sees Agents tab → edits agent frontmatter → saves → GitHub push succeeds → re-fetch shows updated content
4. **Agent-only plugin**: plugin with only `agents/` directory → `settingSources: ["project"]` still triggered → agent files discovered in sandbox
5. **Tenant plugin detail**: API consumer calls `GET /api/plugin-marketplaces/:id/plugins/:name` → receives agent names, descriptions, skill names

## Acceptance Criteria

### Functional Requirements

- [ ] `commands/` directories in marketplace repos are silently ignored (no auto-migration)
- [ ] Agent `.md` files are discovered from `pluginName/agents/` and injected into sandbox at `.claude/agents/`
- [ ] Admin UI plugin editor shows "Agents | Skills | Connectors" tabs
- [ ] Agent files can be created, edited, and saved via the admin editor
- [ ] Agent frontmatter is validated on save (name + description required, non-empty body)
- [ ] Plugin list shows `hasAgents` flag correctly on both admin and tenant APIs
- [ ] Existing plugins with only skills continue to work unchanged
- [ ] Tenant API can read plugin agent/skill metadata via detail endpoint
- [ ] Agent-only plugins correctly trigger `settingSources: ["project"]` in sandbox

### Non-Functional Requirements

- [ ] No database migration required
- [ ] No downtime — backward compatible deployment (except commands/ support removal)
- [ ] SDK major version bump with updated consumers

### Quality Gates

- [ ] Unit tests for agent discovery, commands ignored, validation, settingSources, sandbox paths
- [ ] Existing tests updated (session-executor mock)
- [ ] CLAUDE.md fully updated
- [ ] Manual testing: create a plugin with agents + skills in a test marketplace, verify sandbox injection

## Dependencies & Prerequisites

- None — all changes are internal to AgentPlane
- Marketplace repo maintainers must be notified to rename `commands/` → `skills/` (breaking — commands will be silently ignored after deploy)

## Risk Analysis & Mitigation

| Risk | Impact | Mitigation |
|------|--------|------------|
| Marketplace repos with `commands/` break silently | Medium — commands stop working | Notify maintainers before deploy; document in release notes |
| FileTreeEditor doesn't support flat files for agents | Medium — agents are single .md files, not folders | Check existing flat mode; add minimal flat-file support if needed |
| `settingSources` not triggered by agent-only plugins | High — agents won't be discovered | Explicit task + unit test in Phase 1 |
| SDK breaking change (hasCommands → hasAgents) | Low — SDK is internal | Major version bump; update all consumers in same release |

## Sources & References

### Origin

- **Brainstorm document:** [docs/brainstorms/2026-03-16-plugin-model-redesign-brainstorm.md](docs/brainstorms/2026-03-16-plugin-model-redesign-brainstorm.md) — Key decisions: full merge (no deprecation), plugins = Agents + Skills + Connectors, flat agent naming. Note: brainstorm chose auto-migration; deepening revealed this adds permanent complexity for a deprecated format, so we dropped it.

### Internal References

- Plugin file handling: `src/lib/plugins.ts:34-342`
- Sandbox injection: `src/lib/sandbox.ts:258-285, 549-572`
- Run executor merge point: `src/lib/run-executor.ts:65`
- Session executor merge points: `src/lib/session-executor.ts:131, 165`
- Admin editor: `src/app/admin/(dashboard)/plugin-marketplaces/[marketplaceId]/plugins/[...pluginName]/plugin-editor-client.tsx`
- Plugin API routes: `src/app/api/admin/plugin-marketplaces/[marketplaceId]/plugins/[...pluginName]/route.ts`
- SDK types: `sdk/src/types.ts:284-293`
- Validation: `src/lib/validation.ts:151`

### External References

- Anthropic Skills docs: https://code.claude.com/docs/en/skills
- Anthropic Subagents docs: https://docs.anthropic.com/en/docs/claude-code/sub-agents
- Anthropic Plugins docs: https://code.claude.com/docs/en/plugins

### Review Agents Consulted

- TypeScript reviewer: type safety, interface design, semver
- Architecture strategist: phasing, naming collisions, missing routes
- Pattern recognition: naming consistency, shared helpers, tab patterns
- Code simplicity: YAGNI violations, phase merging, dropped auto-migration
- Performance oracle: cache invalidation, Promise.all, file limits
- Agent-native reviewer: tenant API parity gap, plugin detail endpoint
- Best practices researcher: Zod schema evolution, tab state management
