---
title: "feat: Rich searchable model selector for agent create/edit"
type: feat
status: completed
date: 2026-03-19
origin: docs/brainstorms/2026-03-19-multi-model-support-requirements.md
---

# Rich Searchable Model Selector for Agent Create/Edit

## Enhancement Summary

**Deepened on:** 2026-03-19
**Agents used:** TypeScript reviewer, Performance oracle, Architecture strategist, Pattern recognition, Security sentinel, Simplicity reviewer, Frontend races reviewer, Agent-native reviewer, Combobox best practices researcher, AI Gateway docs researcher

### Key Improvements from Deepening
1. **Pricing fields changed to `number | null`** (not string) — enables sorting/comparison without runtime parsing
2. **Model ID validation added** — regex allowlist prevents injection into sandbox runner scripts (security finding)
3. **cmdk + Radix Popover** recommended as the combobox library (industry standard, handles ARIA/keyboard/portals correctly)
4. **No `useEffect` for derived state** — permission mode and runner must be computed synchronously in `onChange` to prevent render-gap race conditions
5. **Data fetching uses `useEffect` + `fetch`** (not SWR) to match existing admin UI patterns
6. **Lazy fetch on popover open** with AbortController cleanup
7. **Gateway returns 248 models** (no pagination, no query params) — all filtering must be client-side

### Conflicts Resolved
| Topic | Agent A says | Agent B says | Resolution |
|---|---|---|---|
| SWR vs useEffect | TS reviewer: use SWR | Pattern specialist: useEffect (existing pattern) | **useEffect+fetch** — consistency with 6 other admin components |
| types.ts vs model-catalog.ts | Pattern specialist: types.ts | Architecture: model-catalog.ts (Composio pattern) | **model-catalog.ts** — type travels with fetch/cache logic |
| Portal vs absolute | Pattern: ToolkitMultiselect style | Combobox research: cmdk + Radix | **cmdk + Radix Popover** — handles click-through bugs, ARIA, keyboard nav correctly |

---

## Overview

Replace the hardcoded native `<select>` dropdown in the agent create/edit forms with a rich, searchable model selector inspired by the Vercel AI Gateway model catalog. The new selector fetches live model data from the AI Gateway API (already partially implemented), displays model metadata (context window, pricing, capabilities), and supports search + provider filtering.

## Problem Statement

The current model selection UX has significant limitations:

1. **Hardcoded model list** — `MODEL_GROUPS` is duplicated identically in `add-agent-form.tsx` and `edit-form.tsx` (~12 models). Adding a new model requires code changes in two places.
2. **No search** — Users must scroll through a flat `<select>` dropdown to find models.
3. **No metadata** — Users can't see context window, pricing, or capabilities when choosing a model, forcing them to reference external docs.
4. **Stale data** — New models added to Vercel AI Gateway don't appear until someone updates the hardcoded list. Gateway currently serves **248 models**.
5. **No filtering** — Can't filter by provider or capability (e.g., "show me models with tool-use support").

The API route `/api/models/route.ts` already fetches from `https://ai-gateway.vercel.sh/v1/models` but discards most metadata (only keeps `id` and `provider`).

## Proposed Solution

### Phase 1: Enrich the API (Backend)

Enhance `fetchGatewayModels()` in `src/app/api/models/route.ts` to preserve the full metadata from the AI Gateway response.

**Fields to extract per model:**

| Field | Source | Type | Purpose |
|---|---|---|---|
| `id` | `m.id` | `string` | Model identifier (e.g., `openai/gpt-4o`) |
| `name` | `m.name` | `string` | Human-readable label |
| `provider` | Derived from `id` or `owned_by` | `string` | Grouping + filtering |
| `context_window` | `m.context_window` | `number \| null` | Display in selector |
| `max_tokens` | `m.max_tokens` | `number \| null` | Display in selector |
| `type` | `m.type` | `string` | Filter (language/embedding/image) |
| `tags` | `m.tags` | `ModelTag[]` | Capability badges |
| `pricing.inputPerMillionTokens` | `m.pricing.input` (parsed) | `number \| null` | Cost display + sorting |
| `pricing.outputPerMillionTokens` | `m.pricing.output` (parsed) | `number \| null` | Cost display + sorting |
| `default_runner` | Computed | `RunnerType` | Runner auto-selection |
| `supports_claude_runner` | Computed | `boolean` | Runner toggle visibility |

#### Research Insights

**Pricing must be numeric, not string.** Storing pricing as `string | null` would force `parseFloat` calls across the UI for any sorting or comparison. Parse once on the server, store as `number | null` in cost-per-million-tokens units. Format to display strings only at the render boundary. *(TypeScript reviewer)*

**Tags should use a constrained union type.** The AI Gateway returns tags like `reasoning`, `tool-use`, `vision`, `file-input`, `implicit-caching`, `image-generation`. Define a `ModelTag` union and export a `MODEL_TAGS` const array for runtime validation:
```ts
export const MODEL_TAGS = ['reasoning', 'tool-use', 'vision', 'file-input', 'implicit-caching', 'image-generation'] as const;
export type ModelTag = typeof MODEL_TAGS[number];
```
*(TypeScript reviewer)*

**`default_runner` should use the existing `RunnerType` union**, not bare `string`. The codebase already has `RunnerType = 'claude-agent-sdk' | 'vercel-ai-sdk'` in `src/lib/models.ts`. *(TypeScript reviewer)*

**Derive `providers` client-side.** Do not include a separate `providers: string[]` in the API response — it creates a synchronization risk. Derive from `models.map(m => m.provider)` with deduplication on the client. *(TypeScript reviewer)*

**Filter server-side:** Only return `type: "language"` models (agents don't use embedding/image model types). This reduces 248 models to a more manageable set.

**Validate AI Gateway response with Zod before caching.** If the upstream returns unexpected data, reject it and serve fallback models rather than caching potentially malicious data. *(Security sentinel — MEDIUM risk)*

**Increase server cache TTL to 15 minutes.** Model lists change on the order of days/weeks. 5 minutes is unnecessarily aggressive and creates more upstream calls than needed. *(Performance oracle)*

**Add stale-on-error fallback.** Keep a secondary "last known good" cache entry. If the upstream fetch fails, return the stale data rather than an error. *(Performance oracle)*

**Update the response shape:**

```ts
// Before
{ models: Record<string, Array<{ id, default_runner, supports_claude_runner }>> }

// After
{
  models: Array<CatalogModel>
}
```

**Update fallback models** to include the same metadata shape (with `null` for unknown fields).

**Extract shared fetch/cache logic to `src/lib/model-catalog.ts`.** Both `/api/admin/models` and `/api/models` should call the same `listCatalogModels()` function. Routes are thin auth wrappers only — no duplicated catalog-building logic. *(Architecture strategist — mirrors Composio `listComposioToolkits` pattern)*

**Files to modify:**
- `src/app/api/models/route.ts` — thin wrapper calling shared function, enrich tenant response too

**Files to create:**
- `src/lib/model-catalog.ts` — `CatalogModel` type, `ModelTag` union, `listCatalogModels()` fetch/cache function, `DEFAULT_MODEL` constant
- `src/app/api/admin/models/route.ts` — admin-authed route calling shared function

### Phase 2: Model Selector Component

Build a new `<ModelSelector>` combobox component using **cmdk + Radix Popover**.

#### Library Choice: cmdk + Radix Popover

**Why cmdk:** Industry standard for searchable command palettes in React (2024-2026). Provides search, keyboard navigation, grouping, and ARIA compliance out of the box. Used by shadcn/ui, Vercel dashboard, and Linear. *(Combobox research)*

**Why Radix Popover:** Portal rendering with collision-aware positioning, focus management, and correct outside-click handling (avoids the click-through bug that manual portals suffer from). *(Combobox research, Frontend races reviewer)*

**Why NOT extend ToolkitMultiselect:** It lacks keyboard navigation, ARIA roles, and uses absolute positioning which may clip in constrained containers (`max-w-md` dialog). Build fresh with cmdk, consider migrating ToolkitMultiselect to the same pattern later. *(Combobox research)*

**New dependencies:** `cmdk` (lightweight, ~5KB), `@radix-ui/react-popover`

**UI design (inspired by Vercel AI Gateway screenshot):**

```
+----------------------------------------------------------+
| Search model...                                     [v]  |
+----------------------------------------------------------+
| [All Providers v]                                        |
|----------------------------------------------------------|
| Model                    Context   Input    Output  Tags |
|----------------------------------------------------------|
|  Anthropic                                               |
|  > claude-opus-4-6       1M      $5/M     $25/M   T B Q |
|  > claude-sonnet-4-6     1M      $3/M     $15/M   T B   |
|  > claude-haiku-4.5      200K    $0.25/M  $1.25/M T     |
|                                                          |
|  OpenAI                                                  |
|  > gpt-4o                128K    $2.50/M  $10/M   T B Q |
|  > gpt-4o-mini           128K    $0.15/M  $0.60/M T     |
|  ...                                                     |
|----------------------------------------------------------|
| Or type a custom model ID...                             |
+----------------------------------------------------------+
```

**Component props (controlled):**
```ts
interface ModelSelectorProps {
  value: string;
  onChange: (modelId: string) => void;
  disabled?: boolean;
}
```
Keep the component controlled — the parent form owns selected state. *(TypeScript reviewer)*

**Component behavior:**
- **Trigger:** Shows current model name + provider in a button. Clicking opens the Radix Popover.
- **Search:** cmdk `<Command.Input>` filters models by `id`, `name`, and `provider` (case-insensitive). Sort once when data arrives; filter the sorted list per keystroke. *(Performance oracle)*
- **Provider filter:** Dropdown/chips to filter by provider (All, Anthropic, OpenAI, Google, etc.).
- **Model list:** `<Command.Group>` per provider. Each `<Command.Item>` shows: name, context window (formatted: "1M", "128K"), input/output pricing (formatted: "$5/M"), capability tags as small badges.
- **Selection:** Clicking a `<Command.Item>` selects it, closes the popover, and calls `onChange(modelId)`.
- **Custom entry:** When search string matches no catalog model, render a "Use custom model: {search}" `<Command.Item>` at the bottom. *(Combobox research)*
- **Unknown models:** If the current `value` doesn't match any catalog model, the trigger displays the raw ID with a subtle "custom" badge. No silent replacement. *(Spec flow analysis)*
- **Soft validation:** Show a yellow warning indicator if the entered model ID is not in the catalog, but do not block save. *(Architecture strategist)*
- **Dark mode:** Use cmdk's `data-[highlighted]` and `data-[selected]` attribute selectors. *(Combobox research)*

**Data fetching:**
- Use `useEffect` + `fetch` (NOT SWR) to match the existing admin UI pattern. 6 other admin components use this pattern; introducing SWR for one component breaks consistency. *(Pattern recognition specialist)*
- **Lazy fetch on first popover open**, not on page load. Use conditional fetching (`if (!models && isOpen)`) to defer until needed. *(Performance oracle)*
- **AbortController cleanup:** When the popover closes before fetch completes, abort the in-flight request to prevent setState on unmounted component. *(Frontend races reviewer)*

```ts
const controller = useRef<AbortController | null>(null);
function onOpenChange(open: boolean) {
  if (open && !models) {
    controller.current = new AbortController();
    fetchModels(controller.current.signal);
  }
  if (!open && controller.current) {
    controller.current.abort();
    controller.current = null;
  }
}
```

- **Loading state:** Show skeleton rows while fetching.
- **Error state:** If API fails, show fallback models with a subtle warning banner.

**Performance notes:**
- 248 total models, ~100-150 after `type: "language"` filter — **no virtualization needed**. Virtualization (react-window) only worthwhile at 500+ rows. *(Performance oracle)*
- Client-side filtering uses simple `string.includes()` — O(n) on ~100-150 items is <1ms per keystroke. *(Performance oracle)*
- Portal-based rendering has zero impact on React reconciliation. *(Performance oracle)*

**Auth consideration:** Create `/api/admin/models/route.ts` — mirrors the same logic but uses admin auth. Follows the existing pattern where admin routes live under `/api/admin/`. *(Architecture strategist — confirmed this follows Composio dual-route pattern)*

**Files to create:**
- `src/components/model-selector.tsx` — the combobox component

### Phase 3: Integrate into Forms

Replace the native `<select>` in both forms with `<ModelSelector>`.

**`add-agent-form.tsx` changes:**
- Remove `MODEL_GROUPS` constant
- Replace `<Select>` with `<ModelSelector value={model} onChange={handleModelChange} />`
- Runner auto-selection logic stays (already reacts to model value)

**`edit-form.tsx` changes:**
- Remove `MODEL_GROUPS` constant
- Replace `<Select>` with `<ModelSelector value={model} onChange={handleModelChange} />`
- **Bug fix:** Reset `permissionMode` to `""` when switching to a non-Claude model

#### Critical: No `useEffect` for Derived State

**Do NOT implement permission mode reset or runner auto-selection as a `useEffect` watching `model`.** This creates a render gap where the form briefly shows an invalid model/runner combination. If the user clicks "Save" in that 16ms window, they persist an incompatible state. *(Frontend races reviewer)*

**Instead, compute everything synchronously in the `onChange` handler:**

```ts
function handleModelChange(modelId: string) {
  const claudeRunner = supportsClaudeRunner(modelId);
  const newRunner = claudeRunner ? runner : 'vercel-ai-sdk';
  const newPermMode = claudeRunner ? permissionMode : '';

  setModel(modelId);
  setRunner(newRunner);
  setPermissionMode(newPermMode);
}
```

This is exactly what the current add-agent-form already does — do not regress it. *(Frontend races reviewer)*

#### Existing Bug Fix: Disable Form While Saving

The edit form allows mutations while a PATCH is in flight. The save reads state at call time, fires the fetch, then the user can change fields — creating silent divergence between form state and server state. **Disable the entire form while `saving` is true.** *(Frontend races reviewer)*

**Files to modify:**
- `src/app/admin/(dashboard)/agents/add-agent-form.tsx` — replace select, remove MODEL_GROUPS
- `src/app/admin/(dashboard)/agents/[agentId]/edit-form.tsx` — replace select, remove MODEL_GROUPS, fix permission mode bug, disable form while saving

## Security Considerations

### Model ID Validation — HIGH PRIORITY

The model ID is a free-form string that eventually gets interpolated into sandbox runner scripts. Without validation, a crafted ID could be dangerous. *(Security sentinel — HIGH risk)*

**Add Zod validation on the `model` field:**

```ts
model: z.string()
  .min(1)
  .max(255)
  .regex(/^[a-zA-Z0-9._:/-]+$/, "Model ID must contain only alphanumeric characters, dots, colons, slashes, and hyphens")
```

Apply this validation:
- Server-side in `CreateAgentSchema` and `UpdateAgentSchema` (source of truth)
- Client-side as advisory-only soft validation in the `<ModelSelector>`

### Cache Poisoning — MEDIUM PRIORITY

Validate AI Gateway response shape with Zod before caching. Reject unexpected data and serve fallback models. *(Security sentinel)*

### XSS from External Data — MEDIUM PRIORITY

Model names, descriptions, and tags come from an external API. **Never use unsafe HTML rendering** for any external model data. React's JSX auto-escaping handles this by default, but add max-length constraints on cached string fields as defense-in-depth. *(Security sentinel)*

## Technical Considerations

### Performance
- Models cached server-side (15-min TTL). *(Performance oracle)*
- Client-side: fetch once lazily on popover open, cache in component state. No refetching on focus/navigation.
- Filter/search is client-side on the cached model list (no API calls per keystroke).
- No virtualization needed at current scale (~100-150 language models). Revisit at 500+.

### Unknown Models
- If an agent has a model ID not in the catalog (e.g., set via API with a custom ID), the selector trigger displays the raw ID with a "custom" badge.
- The model remains selectable and editable — no silent replacement.
- Soft warning shown, but save is not blocked.

### Accessibility
- cmdk provides ARIA combobox pattern: `role="combobox"`, `aria-expanded`, `aria-activedescendant`.
- Keyboard: Up/Down arrows, Enter, Escape, Home/End — all handled by cmdk.
- Screen reader: cmdk announces result count, group names, selected item.
- Dark mode: `data-[highlighted]` and `data-[selected]` attribute selectors.

### AI Gateway API Facts
- **Endpoint:** `GET https://ai-gateway.vercel.sh/v1/models` (no auth required)
- **Response:** 248 models, all returned in one response (no pagination, no query params)
- **Fields per model:** `id`, `name`, `description`, `context_window`, `max_tokens`, `type`, `tags`, `pricing`, `owned_by`, `created`, `released`
- **Tags values:** `reasoning`, `tool-use`, `vision`, `file-input`, `implicit-caching`, `image-generation`
- **Pricing:** String values like `"5.00"` per million tokens — parse to number server-side
- **Cache headers:** `max-age=0, must-revalidate` — confirms server-side caching is needed

## Agent-Native Parity

- **Enrich tenant `/api/models` too.** An API-consuming agent should see the same metadata (pricing, context window, tags) that the admin UI shows. Both routes call the same `listCatalogModels()` function. *(Agent-native reviewer)*
- **Future:** Add `client.models.list()` to the TypeScript SDK (`@getcatalystiq/agent-plane`) for programmatic model discovery. *(Agent-native reviewer — deferred to SDK update cycle)*
- **Validation is server-side truth.** UI validation is advisory only. The API accepts any valid model ID string. *(Agent-native reviewer)*

## Acceptance Criteria

- [x] `src/lib/model-catalog.ts` exports `CatalogModel` type, `ModelTag` union, `listCatalogModels()` function
- [x] `/api/admin/models` returns enriched model metadata (context window, numeric pricing, typed tags, provider)
- [x] `/api/models` (tenant) returns the same enriched metadata
- [x] AI Gateway response validated with Zod before caching
- [x] Model ID field validated with regex allowlist (pre-existing in `CreateAgentSchema`/`UpdateAgentSchema`)
- [x] Model selector shows searchable list grouped by provider (using cmdk)
- [x] Search filters models by name/ID (case-insensitive)
- [x] Provider filter narrows results to selected provider
- [x] Each model row shows context window, input/output pricing, and capability tag badges
- [x] Selecting a model updates the form and triggers runner auto-selection (synchronous, no useEffect)
- [x] Custom model ID can be entered for models not in the catalog
- [x] Soft warning displayed for custom/unknown model IDs
- [x] Keyboard navigation works (arrows, enter, escape — handled by cmdk)
- [x] Unknown/custom models display gracefully (no silent replacement)
- [x] `MODEL_GROUPS` duplication eliminated from both form files
- [x] Permission mode resets when switching to non-Claude model (synchronous in onChange)
- [x] Edit form disabled while save is in progress (existing bug fix)
- [x] Fallback models display when AI Gateway is unreachable (stale-on-error)
- [x] Works in both add dialog and inline edit form contexts
- [x] No unsafe HTML rendering for external model data

## System-Wide Impact

- **Runner auto-selection:** Unchanged — still triggers based on model prefix via `supportsClaudeRunner()`. Computed server-side and included in `CatalogModel`.
- **API surface:** New admin endpoint `/api/admin/models`. Existing tenant endpoint `/api/models` enriched with same metadata. Both call shared `listCatalogModels()`.
- **New dependencies:** `cmdk`, `@radix-ui/react-popover`
- **No DB changes** — model is still stored as a free-form string in the `agents` table.
- **No breaking changes** — the model value format is identical (`claude-sonnet-4-6`, `openai/gpt-4o`, etc.).
- **Validation tightened** — model ID regex added to Zod schemas (may reject previously-accepted malformed IDs, but these would have failed at runtime anyway).

## Sources & References

- **Origin document:** [docs/brainstorms/2026-03-19-multi-model-support-requirements.md](docs/brainstorms/2026-03-19-multi-model-support-requirements.md) — R10 (Admin UI model selection)
- **Vercel AI Gateway API:** `GET https://ai-gateway.vercel.sh/v1/models` — 248 models, 12 fields each, no pagination
- **Existing API route:** `src/app/api/models/route.ts` — already fetches from gateway, needs metadata enrichment
- **Existing pattern:** `src/components/toolkit-multiselect.tsx` — reference for dropdown patterns (but not extended)
- **Composio dual-route pattern:** `src/lib/composio.ts` + `/api/admin/composio/` + `/api/composio/` — shared function, thin route wrappers
- **Current forms:** `src/app/admin/(dashboard)/agents/add-agent-form.tsx`, `src/app/admin/(dashboard)/agents/[agentId]/edit-form.tsx`
- **Model utilities:** `src/lib/models.ts` — `supportsClaudeRunner()`, `defaultRunnerForModel()`, `RunnerType`
- **cmdk library:** Lightweight command palette component (~5KB), provides search, keyboard nav, grouping, ARIA
- **Radix Popover:** Portal-based popover with collision-aware positioning, focus management, correct outside-click handling
