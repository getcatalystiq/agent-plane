---
date: 2026-03-25
topic: soulspec-v05-alignment
---

# SoulSpec v0.5 Full Alignment

## Problem Frame

AgentPlane's agent identity system was built before SoulSpec stabilized. The current implementation uses custom sections (Voice & Tone, Values, Stance, Essence) in SOUL.md and behavioral parameters (communication_verbosity, decision_autonomy, etc.) in IDENTITY.md — none of which match the actual SoulSpec v0.5 spec. This divergence means agents can't import souls from the ClawSouls registry, can't export/publish their identity, and claim "SoulSpec alignment" that doesn't hold up.

The goal is full SoulSpec v0.5 compliance: adopt the spec's file structure, sections, and fields exactly; support the registry for import, export, and publishing; and present the identity system through a dedicated Admin UI tab.

## Requirements

### R1. SoulSpec-compliant DB schema

Store all SoulSpec markdown files as columns on the `agents` table:

- `soul_md` — SOUL.md (already exists, sections change)
- `identity_md` — IDENTITY.md (already exists, content changes)
- `style_md` — STYLE.md (new)
- `agents_md` — AGENTS.md (new, SoulSpec workflow — not to be confused with the agents table)
- `heartbeat_md` — HEARTBEAT.md (new)
- `user_template_md` — USER_TEMPLATE.md (new)
- `examples_good_md` — examples/good-outputs.md (new)
- `examples_bad_md` — examples/bad-outputs.md (new)

Keep the derived `identity` JSONB column, but re-derive it from the new spec-aligned sections.

### R2. SOUL.md adopts spec sections

SOUL.md required sections become: `## Personality`, `## Tone`, `## Principles`.

Recommended sections: `## Worldview`, `## Expertise`, `## Opinions`, `## Boundaries`.

Parser warnings update accordingly. Old sections (Voice & Tone, Values, Stance, Essence) are no longer expected.

### R3. IDENTITY.md adopts spec fields

IDENTITY.md becomes lightweight persona metadata per spec:

- **Name** — display name
- **Role** — what the agent does
- **Creature** — creature type (required in v0.4+)
- **Emoji** — representative emoji
- **Vibe** — one-line personality summary
- **Avatar** — path/URL to avatar image

Current behavioral parameters (communication_verbosity, decision_autonomy, risk_tolerance, collaboration_mode, escalation_preferences) are dropped entirely.

### R4. Derived identity JSONB reflects spec structure

The `identity` JSONB column is auto-derived on save from all markdown files. New shape:

```
{
  soul: { personality, tone, principles, worldview, expertise, opinions, boundaries },
  identity: { name, role, creature, emoji, vibe, avatar },
  style: { sentence_structure, vocabulary, tone, formatting, rhythm, anti_patterns },
  has_agents_md: boolean,
  has_heartbeat_md: boolean,
  has_user_template_md: boolean,
  has_examples: boolean,
  disclosure_summary: string | null    // auto-generated from first line of SOUL.md or explicit
}
```

### R5. Prompt injection updated

`buildIdentityPrefix()` and `prependIdentity()` updated to include all relevant SoulSpec files in the prompt prefix. Order: IDENTITY.md, SOUL.md, STYLE.md, AGENTS.md. (HEARTBEAT.md, USER_TEMPLATE.md, and examples are not injected into every prompt — they serve other purposes.)

### R6. soul.json import

Import a soul from:
- A soul.json URL or file upload
- The ClawSouls registry by name (fetches from `clawsouls.ai/souls/{owner}/{name}`)

On import:
- Parse soul.json manifest
- Fetch referenced markdown files
- Populate the agent's DB columns
- Derive identity JSONB
- Return warnings for any missing recommended files

### R7. soul.json export

Export an agent's identity as a downloadable soul package (zip):
- Generate `soul.json` manifest from DB columns + agent metadata
- Include all non-null markdown files
- Include avatar if agent has a logo

### R8. Publish to ClawSouls registry

Publish an agent's soul directly from the Admin UI:
- Requires a ClawSouls registry token (stored per-tenant, encrypted)
- Runs local validation (structure, required fields) before publish
- Calls the ClawSouls publish API
- Displays SoulScan score if returned

### R9. Admin UI: dedicated Identity tab with CodeMirror

Add an "Identity" tab to the agent detail page (alongside General, Connectors, Skills, Plugins, Schedules, Runs):
- File-tree sidebar listing all SoulSpec files (SOUL.md, IDENTITY.md, STYLE.md, AGENTS.md, HEARTBEAT.md, USER_TEMPLATE.md, examples/good-outputs.md, examples/bad-outputs.md)
- CodeMirror editor for the selected file (reuse existing `file-tree-editor.tsx` pattern from plugin editor)
- Import button (from registry or file upload)
- Export button (download as zip)
- Publish button (to ClawSouls registry)
- Validation warnings displayed inline

### R10. A2A Agent Card metadata

The A2A Agent Card continues to include identity under the `soulspec:identity` metadata key, but now uses the spec-aligned JSONB shape from R4.

### R11. Backward compatibility migration

Migration that handles existing agents:
- Existing `soul_md` content with old sections (Voice & Tone, Values, Stance, Essence) is preserved as-is in the column — no automatic rewriting of user content
- Existing `identity_md` content with behavioral params is preserved as-is
- The `identity` JSONB is re-derived using the new parser, which will produce warnings for old-format sections but still parse what it can
- New columns (`style_md`, `agents_md`, etc.) default to NULL

### R12. Progressive disclosure support

When building identity for different contexts, respect SoulSpec's disclosure levels:
- **Level 1 (discovery):** `disclosure_summary` from identity JSONB — used in agent listings, A2A cards
- **Level 2 (active use):** SOUL.md + IDENTITY.md — injected into prompts for standard runs
- **Level 3 (deep behavior):** All files — used when full persona fidelity is needed

### R13. Sandbox file injection

In addition to prompt prefix injection (R5), inject SoulSpec files into the sandbox filesystem:
- `.soul/SOUL.md`, `.soul/IDENTITY.md`, `.soul/STYLE.md`, `.soul/AGENTS.md`, `.soul/HEARTBEAT.md`
- This allows Claude Agent SDK runners to discover identity files natively (matching how Claude Code reads SOUL.md from the workspace)

### R14. LLM-powered "Generate Soul" assistant

A single "Generate Soul" button in the Identity tab that drafts ALL SoulSpec files at once from the agent's existing configuration:

**Inputs (context for generation):**
- Agent name, description, model
- Configured tools (Composio toolkits, MCP servers)
- Installed skills and plugins
- Any existing SoulSpec content (for regeneration/refinement)

**Output:** Draft content for all SoulSpec files (SOUL.md, IDENTITY.md, STYLE.md, AGENTS.md, HEARTBEAT.md, USER_TEMPLATE.md, examples/good-outputs.md, examples/bad-outputs.md). User reviews in CodeMirror, edits what they want, then saves.

**Execution:** Server-side call to AI Gateway (using the agent's model or a default capable model). Structured prompt that understands SoulSpec sections and generates spec-compliant content.

### R15. Spec validation from registry

Validate agent SoulSpec content against the spec fetched from the ClawSouls registry:

**When it runs:**
- On every save — warnings displayed inline in the Identity tab editor
- On publish — full validation gate; block publish if errors exist

**What it checks:**
- Required sections present in SOUL.md (## Personality, ## Tone, ## Principles)
- Required fields in IDENTITY.md (Name, Role, Creature)
- soul.json manifest completeness (for export/publish)
- Field format and size constraints per spec version
- Consistency across files (e.g., name in IDENTITY.md matches soul.json)

**Spec source:** Fetch validation rules from ClawSouls registry API (machine-readable schema or spec definition). Cache with TTL to avoid hitting the API on every save.

## Success Criteria

- An agent with no identity configured works exactly as before (all columns NULL)
- Importing a soul from the ClawSouls registry populates all relevant DB columns and the derived JSONB
- Exporting an agent's identity produces a valid soul package that passes `clawsouls validate`
- Publishing to the registry succeeds for agents with complete required fields
- The Admin UI Identity tab allows editing all SoulSpec files with CodeMirror
- Existing agents with old-format SOUL.md/IDENTITY.md content are not broken by the migration
- A2A Agent Cards expose spec-aligned identity metadata
- "Generate Soul" produces spec-compliant drafts that pass validation
- Spec validation catches missing required sections on save and blocks publish on errors

## Scope Boundaries

- **No embodied agent support (v0.5 robotics fields)** — skip `environment`, `hardwareConstraints`, `safety.physical`, `sensors`, `actuators`, ROS2 mapping
- **No SoulScan integration** — we fetch spec rules for structural validation but don't run the full SoulScan pipeline (persona consistency, prompt injection detection — only the registry's publish endpoint does that)
- **No USER_TEMPLATE.md runtime behavior** — we store it but don't implement the "copy to USER.md if missing" install behavior (that's a framework-level concern)
- **No interpolation strategy** — deprecated in v0.4, skip entirely
- **No `modes` support** — deprecated in v0.4

## Key Decisions

- **Drop behavioral params:** communication_verbosity, decision_autonomy, risk_tolerance, collaboration_mode, escalation_preferences are removed. SoulSpec's prose-based Personality/Tone/Principles sections cover agent behavior more naturally.
- **soul.json is import/export only:** DB remains source of truth. soul.json is generated on export and parsed on import — never stored.
- **Keep identity JSONB:** Auto-derived on every save for fast queries, A2A cards, and API responses without re-parsing markdown.
- **Dedicated Identity tab with CodeMirror:** Matches the plugin file editor pattern. File-tree sidebar + editor + import/export/publish controls.
- **Full registry support:** Import, export (zip), and publish to ClawSouls registry.
- **Sandbox file injection:** SoulSpec files written to `.soul/` directory in sandbox, enabling native discovery by Claude Agent SDK.
- **Graceful backward compat:** Old content preserved, new parser warns but doesn't reject old-format sections.
- **Generate all at once:** Single "Generate Soul" button drafts all SoulSpec files from agent config (name, description, tools, skills). User reviews before saving.
- **Spec validation from registry:** Fetch spec rules from ClawSouls API, validate on save (warnings) and publish (blocking). Cached with TTL.

## Dependencies / Assumptions

- ClawSouls registry has a public API for browsing/searching souls and a publish endpoint that accepts soul packages
- The registry API authentication uses bearer tokens (per their CLI: `clawsouls login <token>`)
- `clawsouls validate` expectations match the spec as documented — if they diverge, our export validation may need adjustment
- ClawSouls registry exposes a machine-readable spec/schema endpoint for validation rules (if not, we fall back to embedded rules)
- AI Gateway is available for "Generate Soul" calls; generation uses a capable model (e.g., claude-sonnet or the agent's own model)

## Outstanding Questions

### Deferred to Planning

- [Affects R6][Needs research] What is the exact ClawSouls registry API? Endpoints, auth, response format for browse/search/download/publish
- [Affects R8][Needs research] What does the publish API expect? Multipart upload? JSON? What does SoulScan return?
- [Affects R5][Technical] Should STYLE.md and AGENTS.md always be injected into the prompt prefix, or only at Level 3? Need to evaluate token cost vs. behavior fidelity
- [Affects R13][Technical] Should sandbox file injection use `.soul/` or follow SoulSpec's flat layout (files in workspace root)? Need to check what Claude Code expects
- [Affects R4][Technical] Exact JSONB schema — which STYLE.md sub-sections to parse into structured fields vs. store as raw text
- [Affects R11][Technical] Should migration add a `soul_spec_version` column to track which spec version the agent's content conforms to?
- [Affects R14][Technical] What model to use for generation? Agent's own model, or a fixed default (e.g., claude-sonnet)? How to structure the generation prompt for all 8 files in one call?
- [Affects R15][Needs research] Does ClawSouls expose a machine-readable validation schema endpoint? If not, what's the fallback — embed rules from the spec docs?
- [Affects R15][Technical] How to cache fetched spec rules — process-level cache with TTL? What TTL is appropriate?

## Next Steps

→ `/ce:plan` for structured implementation planning
