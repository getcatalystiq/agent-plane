# Plugin Model Redesign: Commands → Skills Merge + Plugin Agents

**Date:** 2026-03-16
**Status:** Draft

## What We're Building

Anthropic merged slash commands into skills in Claude Code 2.1.3 (Jan 2026). The core concepts for Claude Code plugins are now **Agents, Skills, and Connectors** (plus Hooks and MCP servers). We need to update AgentPlane to reflect this:

1. **Eliminate the "commands" concept** — all command files become skills
2. **Restructure plugins** to contain **Agents + Skills + Connectors** (instead of Skills + Commands + Connectors)
3. **Add sub-agent definitions** to plugins — markdown files with YAML frontmatter that a parent agent can spawn during execution

## Why This Approach

- Anthropic is the upstream — their plugin structure no longer has a `commands/` directory
- Skills now do everything commands did, plus: spawn subagents, fork context, dynamically load files, accept arguments via `$ARGUMENTS`
- The commands concept was always thin (`.md` files in a flat directory) — skills are strictly more powerful
- Adding sub-agent definitions enables richer plugin ecosystems (e.g., a "code review" plugin with a reviewer agent + linter skill + GitHub connector)

## Research Findings

### Anthropic's Current Plugin Structure (2026)

```
plugin-name/
├── .claude-plugin/
│   └── plugin.json       # name, description, version, author
├── agents/               # Subagent markdown files (YAML frontmatter)
├── skills/               # Skills (SKILL.md per folder, YAML frontmatter)
├── hooks/                # Event handlers
├── .mcp.json             # MCP server configuration
├── .lsp.json             # LSP server configuration (new)
├── settings.json         # Default settings (can set main agent)
└── README.md
```

No `commands/` directory — it's gone.

### Skill Format (`SKILL.md`)

```markdown
---
name: my-skill
description: What this skill does and when to use it
disable-model-invocation: true   # user-only invocation
allowed-tools: Read, Grep, Bash  # tool restrictions
model: sonnet                    # model override
context: fork                    # run in subagent context
---

Your skill instructions here. Use $ARGUMENTS for user input.
```

Skills live at:
- Enterprise: managed settings
- Personal: `~/.claude/skills/<skill-name>/SKILL.md`
- Project: `.claude/skills/<skill-name>/SKILL.md`
- Plugin: `<plugin>/skills/<skill-name>/SKILL.md` (namespaced as `plugin-name:skill-name`)

Skills can include supporting files in the same directory (reference docs, scripts, examples).

### Subagent Format (Markdown with YAML frontmatter)

```markdown
---
name: code-reviewer
description: Reviews code for quality. Use proactively after code changes.
tools:
  - Read
  - Grep
  - Glob
  - Bash
model: sonnet
permissionMode: bypassPermissions
skills:
  - my-skill
maxTurns: 10
memory: true
---

You are a senior code reviewer. Focus on code quality, security, and best practices.
```

Subagents live at:
- Project: `.claude/agents/<name>.md`
- User: `~/.claude/agents/<name>.md`
- Plugin: `<plugin>/agents/<name>.md`
- CLI: `--agents '{JSON}'`

Frontmatter fields: `name`, `description`, `tools`, `disallowedTools`, `model`, `permissionMode`, `mcpServers`, `hooks`, `maxTurns`, `skills`, `memory`.

### Plugin settings.json

Plugins can set a default agent as the "main thread":
```json
{ "agent": "my-agent-name" }
```

## Key Decisions

1. **Full merge, not deprecation** — commands disappear entirely, no backward compatibility shim
2. **Plugins = Agents + Skills + Connectors** — admin UI tabs change from "Skills | Commands | Connectors" to "Agents | Skills | Connectors"
3. **Plugin agents are sub-agent definitions** — markdown files with YAML frontmatter, injected into sandbox at `.claude/agents/`; they don't become top-level tenant agents
4. **Connectors untouched** — current Composio + MCP server dual system stays as-is
5. **Phased in one release** — both the commands→skills merge and plugin agents ship together

## Affected Areas

### 1. Commands → Skills Merge

**`src/lib/plugins.ts`**
- `PluginFileSet` interface: remove `commandFiles` array, only `skillFiles` + new `agentFiles` remains
- `fetchPluginContent()`: remove commands directory logic; stop looking for `pluginName/commands/`
- `writePluginFiles()` / GitHub tree parsing: remove command-specific write paths
- Add `agentFiles` discovery from `pluginName/agents/` directory

**`src/lib/sandbox.ts`**
- Remove `.claude/commands/` injection path entirely
- All skill files go to `.claude/skills/<plugin-name>-<subfolder>/<filename>` (unchanged)
- Add `.claude/agents/<plugin-name>-<agent-name>.md` injection for plugin agents

**`src/lib/run-executor.ts` + `src/lib/session-executor.ts`**
- Remove `pluginResult.commandFiles` references
- Add `pluginResult.agentFiles` to merged plugin files

**Admin UI — Plugin Editor**
- `plugin-editor-client.tsx`: Replace "Commands" tab with "Agents" tab
- Tabs become: "Agents | Skills | Connectors"
- Remove `initialCommands`, `handleCommandsChange` state
- Add `initialAgents`, `handleAgentsChange` state
- Agent files are `.md` with YAML frontmatter (single files, not folders)

**Admin UI — Plugin Editor API routes**
- Remove command-specific file CRUD paths
- Add agent file CRUD paths (read/write to `pluginName/agents/` in GitHub)

**`CLAUDE.md`**
- Update all references to `.claude/commands/` and command injection
- Document new agent injection paths

### 2. Plugin Sub-Agent Definitions

**Discovery & Injection**
- Plugin agents stored in `pluginName/agents/` directory in marketplace repos
- Each agent is a single `.md` file with YAML frontmatter (name, description, tools, model, skills, etc.)
- Body of the markdown is the system prompt
- Injected into sandbox at `.claude/agents/<plugin-name>-<agent-name>.md`

**Admin UI**
- New "Agents" tab in plugin editor (first tab)
- Shows list of agent `.md` files
- Editable via CodeMirror (markdown mode) if marketplace has write access
- Preview of frontmatter fields (name, description, model, tools)

**`PluginFileSet` interface update**
```typescript
export interface PluginFileSet {
  skillFiles: Array<{ path: string; content: string }>;
  agentFiles: Array<{ path: string; content: string }>;
  warnings: string[];
}
```

## Resolved Questions

1. **Marketplace repo migration** — Auto-migrate in discovery. When `fetchPluginContent()` scans a plugin directory, treat files found in `commands/` as if they were in `skills/` (flat → skill folder conversion). This provides backward compatibility while repos transition. Log a warning when commands/ is detected.

2. **Agent file naming in sandbox** — Flat naming: `.claude/agents/<plugin-name>-<agent-name>.md`. Matches the existing skill convention (`<plugin-name>-<subfolder>`) for consistency.

## Open Questions

1. **Agent-level skill references** — subagent frontmatter supports a `skills` field. Should plugin agents reference skills from their own plugin? If so, we need to ensure skill injection happens before agent injection in the sandbox.

## Out of Scope

- Connector unification (Composio + MCP servers remain separate)
- Changes to top-level Agent model (tenant agents stay as-is)
- A2A protocol changes
- Hooks or LSP server support in plugins (future work)
- `settings.json` support for plugins (future work)
- SDK (`@getcatalystiq/agent-plane`) changes beyond removing command references
