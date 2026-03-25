---
title: "feat: Full SoulSpec v0.5 Alignment with Registry Integration"
type: feat
status: active
date: 2026-03-25
origin: docs/brainstorms/2026-03-25-soulspec-alignment-requirements.md
deepened: 2026-03-25
---

# feat: Full SoulSpec v0.5 Alignment with Registry Integration

## Overview

Redesign AgentPlane's agent identity system to fully comply with SoulSpec v0.5. Replace our custom SOUL.md sections and IDENTITY.md behavioral parameters with the spec's actual structure, add storage for all SoulSpec files, integrate with the ClawSouls registry (import, export, publish, validate), add an LLM-powered "Generate Soul" feature, and present everything through a dedicated Identity tab with CodeMirror editing.

## Problem Frame

AgentPlane claims SoulSpec alignment but actually diverges significantly. Our SOUL.md uses custom sections (Voice & Tone, Values, Stance, Essence) instead of the spec's required sections (Personality, Tone, Principles). Our IDENTITY.md stores behavioral parameters (communication_verbosity, decision_autonomy) that don't exist in the spec at all — SoulSpec's IDENTITY.md is just Name/Role/Creature/Emoji/Vibe. We also lack storage for STYLE.md, AGENTS.md, HEARTBEAT.md, USER_TEMPLATE.md, and examples. No registry integration exists.

(see origin: docs/brainstorms/2026-03-25-soulspec-alignment-requirements.md)

## Requirements Trace

- R1. SoulSpec-compliant DB schema (8 markdown columns + derived JSONB)
- R2. SOUL.md adopts spec sections (Personality, Tone, Principles + recommended)
- R3. IDENTITY.md adopts spec fields (Name, Role, Creature, Emoji, Vibe, Avatar)
- R4. Derived identity JSONB reflects spec structure
- R5. Prompt injection includes IDENTITY.md, SOUL.md, STYLE.md, AGENTS.md
- R6. soul.json import from registry or file upload
- R7. soul.json export as downloadable zip
- R8. Publish to ClawSouls registry
- R9. Admin UI: dedicated Identity tab with CodeMirror file-tree editor
- R10. A2A Agent Card uses spec-aligned identity metadata
- R11. Migration clears old-format identity content (clean break)
- R12. Progressive disclosure (Level 1/2/3)
- R13. Sandbox file injection to `.soul/` directory
- R14. LLM-powered "Generate Soul" from agent config
- R15. Spec validation via ClawSouls `POST /api/v1/validate`
- R16. Agent-plane-ui: Identity tab exported as embeddable page component
- R17. Agent-co: import Identity tab component and update identity parsing for new JSONB shape

## Scope Boundaries

- No embodied agent support (v0.5 robotics: environment, hardwareConstraints, safety, sensors, actuators)
- No full SoulScan pipeline locally — we use the registry's validate endpoint
- No USER_TEMPLATE.md runtime behavior (store only, no "copy to USER.md" install logic)
- No deprecated features: interpolation strategy, modes
- No `clawsouls` CLI integration — we use the REST API directly

## Context & Research

### ClawSouls REST API

Base URL: `https://clawsouls.ai/api/v1`
Auth: `Authorization: Bearer cs_xxxxx` (token from dashboard or CLI)

| Endpoint | Method | Auth | Description |
|---|---|---|---|
| `/souls` | GET | No | List/search with pagination (`q`, `category`, `tag`, `sort`, `page`, `limit`) |
| `/search?q=` | GET | No | Dedicated search endpoint |
| `/souls/{owner}/{name}` | GET | No | Full details + file contents + SoulScan results |
| `/souls/{owner}/{name}/download` | GET | Yes | Download as ZIP |
| `/souls/{owner}/{name}/publish` | PUT | Yes | Publish (JSON: `{ manifest, files }`) |
| `/validate` | POST | No | Validate without publishing (JSON: `{ manifest, files }`) |
| `/scan-rules` | GET | No | Current SoulScan rule set |
| `/categories` | GET | No | List categories with counts |
| `/souls/{owner}/{name}/scan` | GET | No | SoulScan results |

Publish body: `{ manifest: { specVersion, name, displayName, ... }, files: { "SOUL.md": "...", "IDENTITY.md": "..." } }`
Validate body: same shape as publish.
Validate response: `{ valid: boolean, checks: [{ type: "pass"|"fail"|"warn", message }] }`

### Relevant Code and Patterns

- **DB migrations**: `src/db/migrations/NNN-description.sql`, use `ADD COLUMN IF NOT EXISTS`. Next: 026.
- **Identity parser**: `src/lib/identity.ts` — 4 call sites: admin PATCH route (derivation on save), `sandbox.ts` (Claude SDK prompt prefix), `vercel-ai-runner.ts` (AI SDK system prompt), `a2a.ts` (card metadata)
- **Sandbox file injection**: `sandbox.writeFiles([{ path, content: Buffer }])`. Skills go to `.claude/skills/`, plugins to `.claude/agents/`. Same pattern for `.soul/` files.
- **FileTreeEditor**: `src/components/file-tree-editor.tsx` — accepts `FlatFile[]` (`{ path, content }`), controlled mode via `onChange` + `savedVersion`. Used by plugin editor and skills editor.
- **Admin PATCH route**: `src/app/api/admin/agents/[agentId]/route.ts` — fetches current values for fields not in the update, then calls `deriveIdentity()`. Must extend to all 8 markdown columns.
- **AI Gateway calls**: Direct `fetch` to `ai-gateway.vercel.sh/v1/chat/completions` (see `model-catalog.ts` pattern for `/v1/models`).
- **No zip generation exists** — need a lightweight approach (JSZip or manual ZIP construction).

### Institutional Learnings

- The derive-on-save pattern must scale to 8 columns — a helper that loads all current identity columns in one query.

## Key Technical Decisions

- **Progressive disclosure level matrix (authoritative)**:

  | Level | Files Injected | Use Case |
  |---|---|---|
  | Level 1 | `disclosure_summary` only | Agent listings, A2A card description |
  | Level 2 | IDENTITY.md + SOUL.md + STYLE.md + AGENTS.md | Standard runs (both Claude SDK and Vercel AI SDK) |
  | Level 3 | Level 2 + HEARTBEAT.md + examples/ | Full persona (reserved for future use; currently no caller uses Level 3) |

  STYLE.md and AGENTS.md are included at Level 2 because token cost is low (typically short files) and they directly affect output quality. HEARTBEAT.md, USER_TEMPLATE.md, and examples are Level 3 only.

- **Sandbox injection uses `.soul/` directory**: Claude Code reads `CLAUDE.md` from root, not SOUL.md. The `.soul/` directory is our convention for making SoulSpec files discoverable by the Claude Agent SDK runner. The prompt prefix (R5) is the primary injection path; `.soul/` files are supplementary for tools that scan the filesystem.
- **A2A identity metadata key versioned**: The JSONB shape change is breaking for external A2A clients. Use a new metadata key `soulspec:identity:v2` for the new shape. Keep the old `soulspec:identity` key populated with a backward-compatible subset during a transition period, then deprecate.
- **STYLE.md sub-sections stored as raw text in JSONB**: Don't parse into structured fields — the sections (Sentence structure, Vocabulary, etc.) are free-form prose, not enums. Store as `style: { raw: string }` or just `has_style_md: boolean` plus the full text in the column.
- **Generation uses agent's own model with fallback**: Try the agent's configured model via AI Gateway. If it fails or the model isn't capable enough, fall back to `anthropic/claude-sonnet-4-5-20250514`. Single structured prompt requesting all 8 files in one response.
- **Validation on save uses registry API**: Call `POST /validate` on every save (debounced in UI). No embedded rules — the registry is the source of truth. Cache validation results with 30s TTL to avoid hammering during rapid edits.
- **ClawSouls API token stored per-tenant**: New `clawsouls_api_token` column on `tenants` table, encrypted with `ENCRYPTION_KEY`. Entered in Settings page.
- **soul_spec_version column added**: Track which spec version the agent targets (default `"0.5"`). Used in manifest generation and validation.
- **JSZip for export**: Lightweight, browser-compatible for potential client-side generation. Server-side for API export endpoint.

## Open Questions

### Resolved During Planning

- **Should STYLE.md always be in prompt prefix?** Yes — it's typically short and directly affects output quality. Include at Level 2+.
- **`.soul/` vs workspace root for sandbox?** `.soul/` — keeps identity files namespaced, avoids conflicts with user files.
- **Embedded vs registry validation?** Registry API (`POST /validate`) — it runs SoulScan and stays current. Debounce in UI.
- **What model for generation?** Agent's own model with fallback to claude-sonnet.
- **Cache TTL for validation?** 30s — fast enough for interactive editing, doesn't hammer the API.
- **Does ClawSouls have a validation endpoint?** Yes — `POST /api/v1/validate` accepts `{ manifest, files }` and returns checks array.

### Deferred to Implementation

- Exact debounce timing for validation calls during editing (start at 2s, adjust if needed)
- Whether `GET /souls/{owner}/{name}` returns file contents inline or requires separate download — verify during import implementation
- Error handling for ClawSouls API rate limits (429) — implement exponential backoff

## High-Level Technical Design

> *This illustrates the intended approach and is directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
┌─────────────────────────────────────────────────────────┐
│                    Admin UI                               │
│  ┌─────────────────────────────────────────────────────┐ │
│  │  Identity Tab                                        │ │
│  │  ┌──────────┐  ┌────────────────────────────────┐   │ │
│  │  │ File Tree │  │  CodeMirror Editor              │   │ │
│  │  │ SOUL.md   │  │  (selected file content)        │   │ │
│  │  │ IDENTITY  │  │                                  │   │ │
│  │  │ STYLE.md  │  │  ┌─────────────────────────┐    │   │ │
│  │  │ AGENTS.md │  │  │ Validation warnings      │    │   │ │
│  │  │ HEARTBEAT │  │  └─────────────────────────┘    │   │ │
│  │  │ ...       │  └────────────────────────────────┘   │ │
│  │  └──────────┘                                        │ │
│  │  [Generate Soul] [Import] [Export ZIP] [Publish]     │ │
│  └─────────────────────────────────────────────────────┘ │
└────────────┬────────────────────────────────────────────┘
             │ PATCH /admin/agents/:id
             ▼
┌─────────────────────────────────────────────────────────┐
│  Admin API Route                                         │
│  1. Accept all 8 markdown columns                        │
│  2. deriveIdentity() → identity JSONB                    │
│  3. Store all columns atomically                         │
│  4. Return identity_warnings + validation_checks         │
└────────────┬────────────────────────────────────────────┘
             │
     ┌───────┴───────┐
     ▼               ▼
┌──────────┐  ┌──────────────┐
│ Sandbox  │  │ A2A Card     │
│ .soul/*  │  │ soulspec:    │
│ + prompt │  │ identity     │
│ prefix   │  │ metadata     │
└──────────┘  └──────────────┘

Registry Integration:
┌──────────┐     ┌─────────────────────────┐
│ Import   │────▶│ GET /souls/{o}/{n}       │
│ Export   │────▶│ Generate ZIP locally     │
│ Publish  │────▶│ PUT /souls/{o}/{n}/pub   │
│ Validate │────▶│ POST /validate           │
└──────────┘     └─────────────────────────┘
```

## Implementation Units

### Phase 1: Foundation (DB + Parser)

- [ ] **Unit 1: Database migration — new columns**

**Goal:** Add all SoulSpec markdown columns and supporting fields to the agents and tenants tables.

**Requirements:** R1, R11

**Dependencies:** None

**Files:**
- Create: `src/db/migrations/026_soulspec_v05_columns.sql`
- Modify: `src/lib/validation.ts`

**Approach:**
- Add to `agents`: `style_md TEXT`, `agents_md TEXT`, `heartbeat_md TEXT`, `user_template_md TEXT`, `examples_good_md TEXT`, `examples_bad_md TEXT`, `soul_spec_version TEXT DEFAULT '0.5'`
- Add to `tenants`: `clawsouls_api_token TEXT` (encrypted, for publish)
- **Clear old-format content:** `UPDATE agents SET soul_md = NULL, identity_md = NULL, identity = NULL WHERE soul_md IS NOT NULL OR identity_md IS NOT NULL` — clean break, old custom-format content is wiped
- All new columns default NULL
- Update `UpdateAgentSchema` in validation.ts to include all new nullable string columns + `soul_spec_version`
- Update `UpdateTenantSchema` to include `clawsouls_api_token`

**Patterns to follow:**
- Existing migrations in `src/db/migrations/` use `ADD COLUMN IF NOT EXISTS`
- Encryption pattern from `api_keys` table for the token column

**Test scenarios:**
- Migration runs cleanly on a DB with existing agents (no data loss)
- New columns are NULL by default
- Existing identity JSONB is unchanged

**Verification:**
- `npm run migrate` succeeds
- Existing agents queryable with new columns returning NULL

---

- [ ] **Unit 2: Rewrite identity parser for SoulSpec v0.5**

**Goal:** Replace the custom parser with one that understands SoulSpec v0.5 sections and fields. Drop behavioral parameters.

**Requirements:** R2, R3, R4

**Dependencies:** Unit 1

**Files:**
- Modify: `src/lib/identity.ts`
- Create: `tests/unit/identity-v05.test.ts`

**Approach:**
- SOUL.md parser: **strictly** expect `## Personality`, `## Tone`, `## Principles` (required), plus `## Worldview`, `## Expertise`, `## Opinions`, `## Boundaries` (recommended). Error on missing required sections. Only parse recognized spec sections — unrecognized headers are ignored with a warning.
- IDENTITY.md parser: parse `- **Name:** ...`, `- **Role:** ...`, `- **Creature:** ...`, `- **Emoji:** ...`, `- **Vibe:** ...`, `- **Avatar:** ...` format. Error on missing Creature (required in v0.4+). No behavioral parameter parsing at all — old format is not supported.
- STYLE.md parser: parse `## Sentence Structure`, `## Vocabulary`, `## Tone`, `## Formatting`, `## Rhythm`, `## Anti-patterns` sections. Store as raw text per section.
- New `deriveIdentity()` signature: accept all 8 markdown columns, return spec-aligned JSONB shape.
- New `AgentIdentity` type: `{ soul, identity, style, has_agents_md, has_heartbeat_md, has_user_template_md, has_examples, disclosure_summary }`
- Remove old types entirely: `Soul`, `CommunicationVerbosity`, `CommunicationTone`, `DecisionAutonomy`, `RiskTolerance`, `CollaborationMode`, `EscalationAction`, `EscalationPreference`
- Keep `buildIdentityPrefix()` and `prependIdentity()` signatures but update internal logic (Unit 3)

**Patterns to follow:**
- Existing `parseSoulMd()` section-parsing pattern (normalize headers, collect lines)
- Prototype pollution prevention with `Object.create(null)` and `DANGEROUS_KEYS`
- Size limit enforcement (25KB)

**Test scenarios:**
- SOUL.md with Personality/Tone/Principles parses correctly into soul JSONB
- SOUL.md missing required section (e.g., no ## Principles) returns error
- SOUL.md with unrecognized headers (e.g., ## Voice & Tone) warns and ignores them
- IDENTITY.md with Name/Role/Creature/Emoji/Vibe parses correctly
- IDENTITY.md missing Creature returns error
- STYLE.md sections parsed into keyed object
- NULL inputs return null identity (no-op)
- Oversized payloads rejected
- disclosure_summary auto-generated from first paragraph of SOUL.md

**Verification:**
- Old test file (`tests/unit/identity.test.ts`) deleted or replaced entirely
- `npm run test` passes

---

### Phase 2: Core Integration

- [ ] **Unit 3: Update prompt injection and progressive disclosure**

**Goal:** Update `buildIdentityPrefix()` to include all relevant SoulSpec files in order, respecting disclosure levels.

**Requirements:** R5, R12

**Dependencies:** Unit 2

**Files:**
- Modify: `src/lib/identity.ts`
- Modify: `src/lib/sandbox.ts` (one-shot runner at ~line 703 AND session runner at ~line 1061)
- Modify: `src/lib/runners/vercel-ai-runner.ts`
- Modify: `src/lib/runners/vercel-ai-session-runner.ts` (currently has NO identity injection — pre-existing gap)
- Test: `tests/unit/identity-v05.test.ts`

**Approach:**
- `buildIdentityPrefix()` accepts a disclosure level parameter (default Level 2).
  - Level 1: return `disclosure_summary` only (for agent listings, A2A cards)
  - Level 2: IDENTITY.md + SOUL.md + STYLE.md + AGENTS.md (standard runs — see authoritative matrix in Key Technical Decisions)
  - Level 3: Level 2 + HEARTBEAT.md + examples (reserved for future use)
- Order: IDENTITY.md first (who), then SOUL.md (personality), STYLE.md (how to communicate), AGENTS.md (workflow)
- Update ALL 4 injection call sites:
  1. `sandbox.ts` ~line 703 — Claude SDK one-shot runner
  2. `sandbox.ts` ~line 1061 — Claude SDK session runner
  3. `vercel-ai-runner.ts` ~line 112 — Vercel AI SDK one-shot runner
  4. `vercel-ai-session-runner.ts` — **FIX: add identity injection** (currently missing entirely; non-Anthropic sessions have no identity context)
- All runners use Level 2 by default

**Patterns to follow:**
- Current `prependIdentity()` join-and-filter pattern

**Test scenarios:**
- Level 1 returns only disclosure_summary
- Level 2 returns IDENTITY.md + SOUL.md content
- Level 3 returns all 4 files in correct order
- NULL files are skipped (no empty lines)

**Verification:**
- Prompt prefix for a fully-configured agent includes all expected files

---

- [ ] **Unit 4: Sandbox file injection**

**Goal:** Inject SoulSpec files into the sandbox filesystem at `.soul/` directory.

**Requirements:** R13

**Dependencies:** Unit 2

**Files:**
- Modify: `src/lib/sandbox.ts`
- Modify: `src/lib/runners/vercel-ai-runner.ts` (if AI SDK runner needs files too)

**Approach:**
- After skill and plugin file injection, inject SoulSpec files: `.soul/SOUL.md`, `.soul/IDENTITY.md`, `.soul/STYLE.md`, `.soul/AGENTS.md`, `.soul/HEARTBEAT.md`
- Only inject non-null columns
- Use the existing `sandbox.writeFiles()` pattern
- Add `.soul/` to sandbox network allowlist if needed (shouldn't be — these are local files)

**Patterns to follow:**
- Skill injection in `sandbox.ts`: `sandbox.writeFiles([{ path: '.claude/skills/...', content: Buffer.from(...) }])`

**Test scenarios:**
- Agent with all SoulSpec files → all injected to `.soul/`
- Agent with only SOUL.md → only `.soul/SOUL.md` injected
- Agent with no identity → no `.soul/` files

**Verification:**
- A run with SoulSpec files configured shows them accessible in sandbox

---

- [ ] **Unit 5: Update A2A Agent Card metadata**

**Goal:** A2A Agent Card uses spec-aligned identity JSONB shape.

**Requirements:** R10

**Dependencies:** Unit 2

**Files:**
- Modify: `src/lib/a2a.ts`

**Approach:**
- Introduce versioned metadata key: `soulspec:identity:v2` for the new JSONB shape
- Keep old `soulspec:identity` key populated with a backward-compatible subset (`{ name, role, description }`) during transition
- Add `disclosure_summary` to the Agent Card description field when available
- Verify the query includes all needed columns (identity JSONB must be re-derived before card build)

**Patterns to follow:**
- Existing `buildAgentCard()` function

**Test scenarios:**
- Agent Card metadata includes both `soulspec:identity` (compat) and `soulspec:identity:v2` (full spec shape)
- New shape includes soul.personality, identity.name, identity.creature, etc.
- Agent with no identity still produces valid card (both keys absent)
- Old `soulspec:identity` key contains minimal subset that won't break existing A2A consumers

**Verification:**
- `GET /api/a2a/{slug}/.well-known/agent-card.json` returns spec-aligned metadata

---

### Phase 3: Admin API + Validation

- [ ] **Unit 6: Update admin PATCH route for all SoulSpec columns**

**Goal:** Admin API accepts all 8 markdown columns, derives identity JSONB from all of them.

**Requirements:** R1, R4

**Dependencies:** Unit 1, Unit 2

**Files:**
- Modify: `src/app/api/admin/agents/[agentId]/route.ts`

**Approach:**
- Extend `fieldMap` to include `style_md`, `agents_md`, `heartbeat_md`, `user_template_md`, `examples_good_md`, `examples_bad_md`, `soul_spec_version`
- When ANY identity column changes, fetch all current values and re-derive
- Helper function: `loadCurrentIdentityColumns(agentId)` — single query for all 8 columns
- Return `identity_warnings` as before, plus `validation_checks` from registry validation (Unit 10)

**Patterns to follow:**
- Current pattern: lines 115-122 in route.ts fetch current soul_md/identity_md for derivation

**Test scenarios:**
- Updating only `style_md` triggers re-derivation with all existing columns
- Updating multiple columns atomically works
- NULL columns don't break derivation

**Verification:**
- PATCH with new columns persists and returns updated identity JSONB

---

- [ ] **Unit 7: ClawSouls API client**

**Goal:** Create a typed client for the ClawSouls REST API.

**Requirements:** R6, R7, R8, R15

**Dependencies:** None (can be built in parallel with Phase 1)

**Files:**
- Create: `src/lib/clawsouls.ts`
- Create: `tests/unit/clawsouls.test.ts`

**Approach:**
- Typed client wrapping `fetch` calls to `https://clawsouls.ai/api/v1`
- Methods: `listSouls(params)`, `searchSouls(query)`, `getSoul(owner, name)`, `downloadSoul(owner, name, token)`, `publishSoul(owner, name, manifest, files, token)`, `validateSoul(manifest, files)`, `listCategories()`, `getScanRules()`
- Zod schemas for response validation
- Process-level cache for categories (5 min TTL) and scan-rules (15 min TTL)
- Error handling: map HTTP status to typed errors
- No auth required for read endpoints; bearer token for download/publish

**Patterns to follow:**
- `src/lib/model-catalog.ts` — process-level cache with TTL, Zod validation, stale-on-error fallback
- `src/lib/composio.ts` — external API client pattern

**Test scenarios:**
- List souls with pagination params
- Get soul details returns parsed metadata + file contents
- Validate returns checks array
- Publish returns URL on success
- 401/403/429 errors mapped correctly
- Cache TTL honored for categories

**Verification:**
- All ClawSouls API methods callable with typed inputs/outputs

---

- [ ] **Unit 8: Registry validation on save**

**Goal:** Validate SoulSpec content against the ClawSouls registry on every save.

**Requirements:** R15

**Dependencies:** Unit 6, Unit 7

**Files:**
- Create: `src/app/api/admin/agents/[agentId]/validate-soul/route.ts`
- Modify: `src/app/api/admin/agents/[agentId]/route.ts`

**Approach:**
- New endpoint `POST /admin/agents/:agentId/validate-soul` — builds manifest + files from current DB state, calls ClawSouls `POST /validate`, returns checks
- Admin PATCH route: after save, fire-and-forget validation call (don't block save on external API)
- Alternatively: UI calls validate endpoint separately after save completes (debounced)
- Validation response cached per-agent with 30s TTL

**Patterns to follow:**
- Existing admin route patterns with `withErrorHandler()`

**Test scenarios:**
- Valid SoulSpec content returns passing checks
- Missing required sections returns warnings
- ClawSouls API unavailable → graceful degradation (return cached or empty)

**Verification:**
- Save triggers validation, warnings displayed in UI

---

### Phase 4: Import / Export / Publish

- [ ] **Unit 9: Import from registry**

**Goal:** Import a published soul from the ClawSouls registry into an agent.

**Requirements:** R6

**Dependencies:** Unit 6, Unit 7

**Files:**
- Create: `src/app/api/admin/agents/[agentId]/import-soul/route.ts`

**Approach:**
- `POST /admin/agents/:agentId/import-soul` with body `{ owner, name }` (registry) or `{ manifest, files }` (direct upload)
- Registry import: call `getSoul(owner, name)` to get file contents, then populate all DB columns
- Direct import: parse soul.json manifest, map `files` keys to DB columns
- Trigger `deriveIdentity()` after import
- Return imported file list + any warnings

**Patterns to follow:**
- Plugin marketplace import pattern (fetch from GitHub, populate DB)

**Test scenarios:**
- Import from registry populates all columns correctly
- Import with missing optional files leaves those columns NULL
- Import overwrites existing identity content (with confirmation in UI)
- Invalid soul.json returns validation errors

**Verification:**
- Import a known soul (e.g., `clawsouls/surgical-coder`), verify all files populated

---

- [ ] **Unit 10: Export as ZIP**

**Goal:** Export an agent's identity as a downloadable SoulSpec package (ZIP).

**Requirements:** R7

**Dependencies:** Unit 6

**Files:**
- Create: `src/app/api/admin/agents/[agentId]/export-soul/route.ts`

**Approach:**
- `GET /admin/agents/:agentId/export-soul` returns a ZIP file
- Generate `soul.json` manifest from agent metadata (name, description, model → compatibility, tools → allowedTools, skills → recommendedSkills)
- Include all non-null markdown files under their SoulSpec names
- Include agent logo as `avatar/avatar.png` if present
- Use `JSZip` (or manual ZIP buffer construction) — add as dependency
- Response: `Content-Type: application/zip`, `Content-Disposition: attachment; filename="{agent-name}-soul.zip"`

**Patterns to follow:**
- Vercel Blob download pattern for binary responses

**Test scenarios:**
- Export includes soul.json + all non-null markdown files
- Export with only SOUL.md produces minimal valid package
- soul.json manifest has correct specVersion, name, files mapping
- ZIP is downloadable and valid

**Verification:**
- Downloaded ZIP passes `clawsouls validate` (via API)

---

- [ ] **Unit 11: Publish to ClawSouls registry**

**Goal:** Publish an agent's soul to the ClawSouls registry.

**Requirements:** R8

**Dependencies:** Unit 7, Unit 8, Unit 10

**Files:**
- Create: `src/app/api/admin/agents/[agentId]/publish-soul/route.ts`

**Approach:**
- `POST /admin/agents/:agentId/publish-soul` with body `{ owner }` (user's ClawSouls namespace)
- Requires tenant's `clawsouls_api_token` (401 if missing)
- Build manifest + files (same as export)
- Call `validateSoul()` first — block on errors
- Call `publishSoul()` — return published URL + SoulScan score
- Store published URL on agent (optional `soul_published_url` field, or just return it)

**Patterns to follow:**
- Composio OAuth pattern for tenant-scoped external credentials

**Test scenarios:**
- Publish succeeds with valid content + token → returns URL
- Publish fails validation → returns checks without publishing
- Missing token → 401
- ClawSouls API error → mapped to user-friendly message

**Verification:**
- Published soul visible at returned URL on clawsouls.ai

---

### Phase 5: LLM Generation

- [ ] **Unit 12: "Generate Soul" API endpoint**

**Goal:** Server-side endpoint that generates all SoulSpec files from agent configuration using AI Gateway.

**Requirements:** R14

**Dependencies:** Unit 2 (needs to know the expected file structure)

**Files:**
- Create: `src/app/api/admin/agents/[agentId]/generate-soul/route.ts`
- Create: `src/lib/soul-generation.ts`

**Approach:**
- `POST /admin/agents/:agentId/generate-soul` — loads agent config, calls AI Gateway, returns generated files
- `soul-generation.ts`: builds a structured prompt with SoulSpec v0.5 section requirements, agent context (name, description, model, tools, skills, plugins), and any existing SoulSpec content (for refinement)
- Prompt requests JSON response with all 8 file contents keyed by filename
- Call AI Gateway: `POST https://ai-gateway.vercel.sh/v1/chat/completions` with agent's model (fallback to `anthropic/claude-sonnet-4-5-20250514`)
- Parse response, validate structure, return files map
- Return type: `{ files: Record<string, string>, model_used: string }`

**Patterns to follow:**
- `src/lib/model-catalog.ts` for AI Gateway fetch pattern (headers, error handling)
- Agent loading from `src/lib/agents.ts`

**Test scenarios:**
- Generation with complete agent config produces all 8 files
- Generation with minimal agent (name only) produces reasonable defaults
- AI Gateway error returns user-friendly failure
- Model fallback works when agent model doesn't support structured output

**Verification:**
- Generated files pass `POST /validate` on ClawSouls API

---

### Phase 6: Admin UI

- [ ] **Unit 13: Identity tab with CodeMirror file-tree editor**

**Goal:** Dedicated Identity tab on agent detail page with file-tree sidebar and CodeMirror editor.

**Requirements:** R9

**Dependencies:** Unit 6

**Files:**
- Create: `src/app/admin/(dashboard)/agents/[agentId]/identity-tab.tsx`
- Modify: `src/app/admin/(dashboard)/agents/[agentId]/page.tsx` (add tab)
- Modify: `src/app/admin/(dashboard)/agents/[agentId]/edit-form.tsx` (remove old identity textareas)

**Approach:**
- New `identity-tab.tsx` component using `FileTreeEditor` with a fixed file tree:
  - SOUL.md, IDENTITY.md, STYLE.md, AGENTS.md, HEARTBEAT.md, USER_TEMPLATE.md, examples/good-outputs.md, examples/bad-outputs.md
- Map DB columns to `FlatFile[]` format: `{ path: "SOUL.md", content: agent.soul_md ?? "" }`
- Controlled mode: track dirty state per file, save all changed files on submit
- Show validation warnings below the editor (from Unit 8)
- Remove the old two-textarea identity section from `edit-form.tsx`
- Tab added between "General" and "Connectors" in the agent detail tabs

**Patterns to follow:**
- `src/app/admin/(dashboard)/plugin-marketplaces/[marketplaceId]/plugins/[...pluginName]/plugin-editor-client.tsx` — FileTreeEditor usage
- `src/app/admin/(dashboard)/agents/[agentId]/skills-editor.tsx` — another FileTreeEditor consumer

**Test scenarios:**
- All 8 files visible in file tree
- Editing a file marks it dirty
- Save persists changes via PATCH
- Empty files show placeholder hint text
- Switching between files preserves unsaved edits

**Verification:**
- Identity tab renders, files editable, saves persist to DB

---

- [ ] **Unit 14: Import / Export / Publish / Generate controls**

**Goal:** Add action buttons to the Identity tab for registry operations and generation.

**Requirements:** R6, R7, R8, R9, R14

**Dependencies:** Unit 9, Unit 10, Unit 11, Unit 12, Unit 13

**Files:**
- Modify: `src/app/admin/(dashboard)/agents/[agentId]/identity-tab.tsx`
- Create: `src/app/admin/(dashboard)/agents/[agentId]/import-soul-dialog.tsx`

**Approach:**
- Button bar below file tree: [Generate Soul] [Import] [Export ZIP] [Publish]
- **Generate Soul**: calls `POST /admin/agents/:id/generate-soul`, fills all files in editor (unsaved — user reviews before saving)
- **Import**: opens dialog with two options — (a) search registry (text input, calls list/search endpoint, shows results), (b) paste soul.json URL. On select, calls import endpoint, refreshes editor.
- **Export ZIP**: triggers `GET /admin/agents/:id/export-soul`, browser downloads ZIP
- **Publish**: calls publish endpoint. Shows validation results first. If valid, confirms and publishes. Shows success URL or error.
- Publish button disabled if tenant has no `clawsouls_api_token` (link to Settings)

**Patterns to follow:**
- `src/components/ui/confirm-dialog.tsx` for publish confirmation
- Existing dialog patterns in admin UI

**Test scenarios:**
- Generate fills editor with draft content, unsaved state
- Import from registry populates files and triggers save
- Export downloads a valid ZIP
- Publish blocked without API token
- Publish shows SoulScan score on success

**Verification:**
- Full round-trip: generate → edit → save → validate → publish

---

- [ ] **Unit 15: Settings page — ClawSouls API token**

**Goal:** Add ClawSouls API token management to the tenant Settings page.

**Requirements:** R8

**Dependencies:** Unit 1

**Files:**
- Modify: `src/app/admin/(dashboard)/settings/page.tsx`
- Modify: `src/app/api/admin/tenants/[tenantId]/route.ts`

**Approach:**
- New section in Settings page: "ClawSouls Registry" with a masked token input and save button
- Token stored encrypted in `tenants.clawsouls_api_token`
- PATCH endpoint accepts `clawsouls_api_token`, encrypts with existing AES-256-GCM pattern
- Display "Connected" badge if token is set, link to ClawSouls dashboard for token creation

**Patterns to follow:**
- API key management in Settings page
- `src/lib/crypto.ts` encryption helpers

**Test scenarios:**
- Token saved and encrypted in DB
- Token retrieved and decrypted for publish operations
- Token removal (set to null) works

**Verification:**
- Settings page shows ClawSouls section, token persistable

---

### Phase 7: SDK & Tenant API

- [ ] **Unit 16: Update SDK and tenant API**

**Goal:** Expose new SoulSpec columns in the SDK and tenant-facing API.

**Requirements:** R1, R9

**Dependencies:** Unit 6

**Files:**
- Modify: `sdk/src/types.ts`
- Modify: `sdk/src/resources/agents.ts`
- Modify: `src/app/api/agents/[agentId]/route.ts` (tenant GET)

**Approach:**
- Add new fields to SDK `Agent` type: `style_md`, `agents_md`, `heartbeat_md`, `user_template_md`, `examples_good_md`, `examples_bad_md`, `soul_spec_version`
- Tenant GET endpoint includes new columns in response
- Tenant PATCH endpoint (if writable) accepts new columns
- Update `identityJsonbSchema` in validation.ts for new shape

**Patterns to follow:**
- Existing SDK agent type definitions

**Test scenarios:**
- SDK agent type includes all new fields
- Tenant GET returns new columns
- SDK typecheck passes

**Verification:**
- `npm run sdk:typecheck` passes
- `npm run sdk:test` passes

### Phase 8: UI Library & Agent-Co Integration

- [ ] **Unit 17: Add Identity tab to agent-plane-ui library**

**Goal:** Export the Identity tab as an embeddable page component in `@getcatalystiq/agent-plane-ui` so agent-co can consume it.

**Requirements:** R16

**Dependencies:** Unit 13 (Identity tab must exist in admin UI first)

**Files:**
- Create: `ui/src/components/pages/agent-identity-tab.tsx`
- Modify: `ui/src/index.ts` (add export) or `ui/src/editor.ts` (if CodeMirror-based, export from `/editor` entry point)
- Modify: `ui/package.json` (version bump)

**Approach:**
- Extract the Identity tab component from `src/app/admin/(dashboard)/agents/[agentId]/identity-tab.tsx` into a reusable version in the UI library
- The UI library version uses the `useApi()` hook and `AgentPlaneProvider` context (same pattern as other page components like `AgentDetailPage`)
- Since this uses CodeMirror (FileTreeEditor), export from the `./editor` entry point to keep CodeMirror out of the core bundle (same pattern as PluginEditorPage)
- Include all controls: Generate Soul, Import, Export ZIP, Publish, validation warnings
- Props: `agentId`, optional callbacks for save/import/export/publish events

**Patterns to follow:**
- `ui/src/components/pages/agent-edit-form.tsx` — page component pattern
- `ui/src/editor.ts` — CodeMirror-based export entry point
- Existing page components that use `useApi()` for data fetching

**Test scenarios:**
- Component renders with agent identity data
- FileTreeEditor shows all 8 SoulSpec files
- Save, generate, import, export, publish actions call correct API endpoints
- `npm run sdk:build` in `ui/` produces valid bundle

**Verification:**
- `AgentIdentityTab` exported from `@getcatalystiq/agent-plane-ui/editor`
- UI library builds cleanly

---

- [ ] **Unit 18: Integrate Identity tab in agent-co**

**Goal:** Import the new Identity tab component into agent-co and update identity parsing for the new JSONB shape.

**Requirements:** R17

**Dependencies:** Unit 17

**Files:**
- Create: `~/code/agent-co/app/(dashboard)/agentplane/agents/[agentId]/identity/page.tsx` (or integrate into existing agent detail)
- Modify: `~/code/agent-co/lib/identity/parse-identity.ts` (update for new JSONB shape)
- Modify: `~/code/agent-co/app/api/agents/[id]/identity/route.ts` (handle new metadata keys)
- Modify: `~/code/agent-co/package.json` (bump `@getcatalystiq/agent-plane-ui` version)

**Approach:**
- Install updated `@getcatalystiq/agent-plane-ui` in agent-co
- Add Identity tab page at the appropriate route (matching existing `/agentplane/*` pattern)
- Update `parse-identity.ts` to handle the new JSONB shape: `{ soul: { personality, tone, principles, ... }, identity: { name, role, creature, ... }, style: { ... } }` instead of old `{ soul: { voice, values, stance, essence }, communication_verbosity, ... }`
- Update identity route to read from `soulspec:identity:v2` metadata key (with fallback to `soulspec:identity` for transition)
- Remove old-format field handling (voice, values, stance, essence, behavioral params)

**Patterns to follow:**
- Existing agent-co agentplane page integrations at `app/(dashboard)/agentplane/`
- Existing `parse-identity.ts` sanitization pattern

**Test scenarios:**
- Identity tab renders in agent-co dashboard
- New JSONB shape parsed correctly
- Old `soulspec:identity` key still works during transition
- Identity refresh from A2A card picks up new shape

**Verification:**
- Agent-co builds cleanly with updated dependency
- Identity tab functional in agent-co dashboard

## System-Wide Impact

- **Interaction graph — 7 non-test consumers** (not 4 as originally listed):
  1. `src/app/api/admin/agents/[agentId]/route.ts` — WRITES identity (derive-on-save)
  2. `src/lib/sandbox.ts` ~line 703 — Claude SDK one-shot prompt prefix
  3. `src/lib/sandbox.ts` ~line 1061 — Claude SDK session prompt prefix
  4. `src/lib/runners/vercel-ai-runner.ts` — Vercel AI SDK one-shot system prompt
  5. `src/lib/runners/vercel-ai-session-runner.ts` — **Currently has NO identity injection** (pre-existing gap, fix in Unit 3)
  6. `src/lib/a2a.ts` — A2A Agent Card metadata (passes raw JSONB to external clients)
  7. `src/app/admin/(dashboard)/agents/[agentId]/edit-form.tsx` — UI reads/writes `soul_md` and `identity_md` (being replaced by Identity tab in Unit 13)
  Additionally: `src/lib/validation.ts` defines permissive `identityJsonbSchema` used by a2a.ts; `tests/unit/session-executor.test.ts` mocks agent with identity fields.
  8. `ui/src/components/pages/agent-identity-tab.tsx` — UI library embeddable component (new, Unit 17)
  9. `~/code/agent-co/lib/identity/parse-identity.ts` — **External consumer** of identity JSONB via A2A cards (must update for new shape, Unit 18)
- **A2A external contract risk:** The `identity` JSONB is exposed raw to external A2A clients via `soulspec:identity` metadata key. The shape change is a **breaking change**. Mitigated by versioned key (`soulspec:identity:v2`) with backward-compat subset on old key (see Unit 5).
- **Error propagation:** ClawSouls API failures should never block agent saves or runs. Validation and publish are best-effort features — degrade gracefully to warnings.
- **State lifecycle risks:** The derive-on-save trigger condition must check ALL 8 markdown columns (`soul_md`, `identity_md`, `style_md`, `agents_md`, `heartbeat_md`, `user_template_md`, `examples_good_md`, `examples_bad_md`). The existing `SELECT *` fetch at line 37 of the PATCH route already provides all column values as fallbacks. Missing even one column from the trigger condition means edits to that column silently skip re-derivation.
- **API surface parity:** Tenant API must expose the same SoulSpec columns as admin API. SDK types must match.
- **Integration coverage:** End-to-end test: create agent → generate soul → edit → save → validate → export ZIP → import into different agent → publish. Also test: session with identity (both Claude SDK and Vercel AI SDK paths).

## Risks & Dependencies

- **ClawSouls API availability:** External dependency for validation and publish. Mitigation: validation endpoint failures return empty checks array (not errors). Publish failures show user-friendly error with "try again later". Import falls back to direct file upload. No agent save or run ever blocks on ClawSouls.
- **ClawSouls API stability:** API is at v1, may change. Mitigation: Zod validation on all responses catches breaking changes. On parse failure, degrade to raw response or cached result. Log schema mismatches for monitoring.
- **A2A breaking change:** Identity JSONB shape change propagates to external A2A clients. Mitigation: versioned metadata keys (see Key Technical Decisions). Old key provides compat subset. Document the migration in release notes.
- **Migration safety:** Adding 7 columns to a potentially large agents table. Use `IF NOT EXISTS` guards. No data transformation needed — all new columns are NULL. No index changes.
- **Clean break for existing agents:** Migration wipes old-format `soul_md`, `identity_md`, and `identity` JSONB. Agents that had custom-format identity content will need to re-author using the new spec-compliant format (or use "Generate Soul" to bootstrap). This is intentional — no backward compat cruft.
- **Vercel AI SDK session runner gap:** Pre-existing defect — sessions using non-Anthropic models have no identity context today. Fixing this in Unit 3 changes session behavior for existing agents (they'll now get identity injected). Low risk since it's additive, but worth noting in release notes.
- **JSZip dependency:** New dependency for ZIP generation. Use server-side only (Node.js API route) to avoid bundle size impact on the client. Alternative: `archiver` package or manual ZIP with Node's `zlib`.

## Sources & References

- **Origin document:** [docs/brainstorms/2026-03-25-soulspec-alignment-requirements.md](docs/brainstorms/2026-03-25-soulspec-alignment-requirements.md)
- **SoulSpec v0.5:** https://clawsouls.ai/spec
- **ClawSouls REST API:** https://docs.clawsouls.ai/docs/api/rest-api
- **SoulSpec MCP:** https://www.npmjs.com/package/soul-spec-mcp
- **ClawSouls GitHub:** https://github.com/clawsouls/clawsouls
- **Research file:** docs/research/soulspec-v05-refactor-research.md
- Related code: `src/lib/identity.ts`, `src/lib/sandbox.ts`, `src/lib/a2a.ts`, `src/components/file-tree-editor.tsx`
- Related PR: #19 (original identity implementation)
