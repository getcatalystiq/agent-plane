---
title: "feat: Plugin Management Interface"
type: feat
status: active
date: 2026-02-18
brainstorm: docs/brainstorms/2026-02-18-plugin-management-brainstorm.md
---

# feat: Plugin Management Interface

## Enhancement Summary

**Deepened on:** 2026-02-18
**Review agents used:** Security Sentinel, Performance Oracle, Architecture Strategist, TypeScript Reviewer, Data Integrity Guardian

### Key Improvements
1. Added explicit TypeScript types for `pushFiles()` and `checkWriteAccess()` with `GitHubResult<T>` pattern
2. Added `conflict` error variant to `GitHubResult` union for 409 handling
3. Specified token encryption key rotation support via `ENCRYPTION_KEY_PREVIOUS`
4. Added edge cases: token expiration detection, stale editor content, file deletion handling
5. Specified PATCH response must strip `github_token_enc` from returned row

## Overview

Add a management interface for plugin marketplaces that lets admins browse plugins, edit skills/commands/connectors on owned marketplaces, and push changes directly to GitHub. Ownership is determined by whether a GitHub token is configured on the marketplace.

## Problem Statement / Motivation

Currently, plugin marketplaces are registered in the admin UI but there's no way to browse or edit the plugins they contain. Admins who own a marketplace repo must edit plugin files directly in GitHub, then wait for cache invalidation. This creates a disconnected workflow — the platform knows about plugins but can't manage them.

## Proposed Solution

Three-level navigation extending the existing marketplace pages:

1. **Marketplace list** (`/admin/plugin-marketplaces`) — Add "Owned" badge, make names clickable
2. **Marketplace detail** (`/admin/plugin-marketplaces/[id]`) — List plugins with metadata
3. **Plugin editor** (`/admin/plugin-marketplaces/[id]/plugins/[name]`) — Edit skills, commands, `.mcp.json`

Reuse the existing `SkillsEditor` component by extracting a generic `FileTreeEditor` that accepts an `onSave` callback and `readOnly` flag. The save action on plugin pages pushes to GitHub via the Git Trees + Commits API (atomic multi-file commits).

## Technical Approach

### Database

**Migration `009_add_marketplace_github_token.sql`:**

```sql
ALTER TABLE plugin_marketplaces
  ADD COLUMN IF NOT EXISTS github_token_enc TEXT;
```

- Nullable — `NULL` means non-owned (read-only)
- Encrypted with existing `ENCRYPTION_KEY` using `encrypt()`/`decrypt()` from `src/lib/crypto.ts`
- Same pattern as Composio MCP API key encryption on the `agents` table

**Update `PluginMarketplaceRow`** in `src/lib/validation.ts`:

```typescript
// Add to the row schema
github_token_enc: z.string().nullable(),
```

### GitHub Write API

**New functions in `src/lib/github.ts`:**

Extend the existing `GitHubResult<T>` union with a `conflict` error variant:

```typescript
export type GitHubResult<T> =
  | { ok: true; data: T }
  | { ok: false; error: "not_found" | "rate_limited" | "server_error" | "parse_error" | "conflict"; message: string };
```

**`pushFiles()`:**

```typescript
export async function pushFiles(
  owner: string,
  repo: string,
  token: string,
  branch: string,
  files: Array<{ path: string; content: string }>,
  message: string,
): Promise<GitHubResult<{ commitSha: string }>>
```

Implements the Git Trees + Commits API flow:
1. `GET /repos/{owner}/{repo}/git/ref/heads/{branch}` — get current commit SHA
2. `POST /repos/{owner}/{repo}/git/trees` — create new tree with base tree + changed files
3. `POST /repos/{owner}/{repo}/git/commits` — create commit pointing to new tree
4. `PATCH /repos/{owner}/{repo}/git/refs/heads/{branch}` — update ref (non-force, rejects on conflict)

Returns `GitHubResult<{ commitSha: string }>`. On 409 conflict from `updateRef`, returns `{ ok: false, error: "conflict", message: "..." }`.

Uses `buildHeaders(token)` (existing helper) for all requests. Each step validates the response and returns early on failure — no partial commits possible since the ref update is the final atomic step.

**Branch resolution:** Use the repo's default branch via `GET /repos/{owner}/{repo}` (returns `default_branch`). Cache this per marketplace to avoid repeated lookups.

**`checkWriteAccess()`:**

```typescript
export async function checkWriteAccess(
  owner: string,
  repo: string,
  token: string,
): Promise<GitHubResult<{ defaultBranch: string }>>
```

Calls `GET /repos/{owner}/{repo}` and checks `permissions.push === true`. Returns the `default_branch` on success (useful for caching). Used when saving a GitHub token to validate it before storing. On 401, return a clear error message indicating token is invalid or expired.

### API Routes

#### `PATCH /api/admin/plugin-marketplaces/[id]`
**File:** `src/app/api/admin/plugin-marketplaces/[marketplaceId]/route.ts`

Update marketplace settings. Primary use: set/update/remove GitHub token.

- Input: `{ github_token?: string | null }` validated via `UpdateMarketplaceSchema`
- If `github_token` is a string:
  1. Parse `github_repo` into `owner/repo`
  2. Call `checkWriteAccess(owner, repo, token)` — reject with 422 if token lacks push permission or returns 401 (expired/invalid)
  3. Encrypt via `encrypt(token, env.ENCRYPTION_KEY)` and `JSON.stringify()` the result
  4. Store encrypted string in `github_token_enc`
- If `github_token` is `null`: clear the token (`SET github_token_enc = NULL`)
- Returns updated marketplace row — **strip `github_token_enc` from response** (return `is_owned: boolean` instead)
- Supports key rotation: decryption uses `ENCRYPTION_KEY_PREVIOUS` fallback via existing `decrypt()` pattern

```typescript
export const UpdateMarketplaceSchema = z.object({
  github_token: z.string().min(1).nullable().optional(),
});
```

#### `GET /api/admin/plugin-marketplaces/[id]/plugins/[name]`
**File:** `src/app/api/admin/plugin-marketplaces/[marketplaceId]/plugins/[pluginName]/route.ts`

Fetch full plugin content for the editor.

- Uses `fetchRepoTree()` to find files, then `fetchRawContent()` for each
- Returns: `{ skills: PluginFile[], commands: PluginFile[], mcpJson: string | null, manifest: PluginManifest }`
- Where `PluginFile = { path: string, content: string }`
- Uses marketplace's GitHub token if available (for private repos)

#### `PUT /api/admin/plugin-marketplaces/[id]/plugins/[name]`
**File:** same as above

Save edited plugin files back to GitHub.

- Input: `{ skills: PluginFile[], commands: PluginFile[], mcpJson: string | null }`
- Validates: marketplace must have `github_token_enc` (403 `ForbiddenError` if not)
- Validates: `.mcp.json` against `PluginMcpJsonSchema` if provided
- Validates: all filenames against `SafePluginFilename` regex — reject entire request if any filename is invalid
- Validates: total file count (skills + commands) does not exceed 50 files per plugin
- Decrypts token via `decrypt(JSON.parse(github_token_enc), env.ENCRYPTION_KEY, env.ENCRYPTION_KEY_PREVIOUS)`
- Resolves default branch via `checkWriteAccess()` or cached value
- Constructs file paths: `{pluginName}/skills/{folder}/{file}` and `{pluginName}/commands/{file}`
- Calls `pushFiles()` with commit message `"Update {pluginName} via AgentPlane"`
- On success: calls `clearPluginCache()` for the marketplace repo
- On conflict (409): returns 409 with `"Plugin was modified externally. Please refresh and re-apply your changes."`
- On 401 from GitHub: returns 401 with `"GitHub token expired or revoked. Please reconfigure the token."`
- Returns: `{ commitSha: string }`

### UI Components

#### 1. Extract `FileTreeEditor` from `SkillsEditor`

**File:** `src/components/file-tree-editor.tsx`

Extract the generic file tree + CodeMirror editor from `src/app/admin/(dashboard)/agents/[agentId]/skills-editor.tsx`.

Props:
```typescript
interface FileTreeEditorProps {
  initialFiles: FileTreeFolder[];    // same shape as AgentSkill[]
  onSave?: (files: FileTreeFolder[]) => Promise<void>;  // undefined = read-only
  readOnly?: boolean;
  addFolderLabel?: string;           // e.g. "Add Skill" vs "Add Command"
  newFolderTemplate?: FileTreeFile;  // default file for new folders
}
```

When `readOnly` is true:
- Hide "Add Folder", "Add File", "Remove" buttons
- Set CodeMirror `editable: false` and `readOnly: true` extensions
- Hide the "Save" button entirely
- Dirty tracking is skipped (no save snapshot needed)

The existing `SkillsEditor` becomes a thin wrapper:
```typescript
export function SkillsEditor({ agentId, initialSkills }) {
  const handleSave = async (skills) => {
    await fetch(`/api/admin/agents/${agentId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ skills }),
    });
  };
  return <FileTreeEditor initialFiles={initialSkills} onSave={handleSave} />;
}
```

Dirty state tracking uses the existing JSON snapshot pattern from `SkillsEditor`: `useRef` for saved snapshot, `useMemo` for `isDirty` comparison.

#### 2. Update marketplace list page

**File:** `src/app/admin/(dashboard)/plugin-marketplaces/page.tsx`

Changes:
- Query includes `github_token_enc IS NOT NULL AS is_owned`
- Marketplace name becomes a `<Link>` to `/admin/plugin-marketplaces/{id}`
- Show `<Badge>Owned</Badge>` next to owned marketplace names

#### 3. New marketplace detail page

**File:** `src/app/admin/(dashboard)/plugin-marketplaces/[id]/page.tsx`

- Server component that fetches marketplace + plugins via `listPlugins()`
- Shows marketplace name, repo link, owned badge
- If owned: shows a token configuration section (set/update/remove token via dialog)
- Lists plugins in a card grid or table: name, description, version, capability badges (Skills, Commands, MCP)
- Each plugin name links to `/admin/plugin-marketplaces/{id}/plugins/{name}`
- Back link to marketplace list

#### 4. New plugin editor page

**File:** `src/app/admin/(dashboard)/plugin-marketplaces/[id]/plugins/[name]/page.tsx`

- Server component fetches marketplace row (for `is_owned` check) + plugin content via `GET /api/admin/plugin-marketplaces/{id}/plugins/{name}`
- Client component receives data and renders editors
- Transforms GitHub files into `FileTreeFolder[]` format:
  - Skills: each subdirectory in `{pluginName}/skills/` becomes a folder with its files
  - Commands: flat `.md` files from `{pluginName}/commands/`
- Three sections:
  - **Skills** — `FileTreeEditor` (read-only if non-owned)
  - **Commands** — `FileTreeEditor` (read-only if non-owned)
  - **Connectors** — CodeMirror JSON editor for `.mcp.json` (read-only if non-owned)
- Single "Save All" button that pushes all changes in one atomic commit
- Save button shows loading state during the multi-step GitHub push (~1-2s)
- On 409 conflict: toast/alert with message, disable save until user refreshes
- On 401 token error: toast directing admin to reconfigure the token
- Back link to marketplace detail

#### 5. Token configuration UI

**File:** `src/app/admin/(dashboard)/plugin-marketplaces/[id]/token-config.tsx`

- Client component on the marketplace detail page
- Shows "Configure GitHub Token" button if no token, or "Token configured" with "Update"/"Remove" buttons
- Dialog with:
  - Token input (password field, `autocomplete="off"`)
  - Help text: "Requires a fine-grained token with Contents read/write permission on this repository"
  - Save validates write access before storing — shows inline error for:
    - Invalid token (401): "Token is invalid or expired"
    - Insufficient permissions (no push): "Token does not have write access to this repository"
    - Network error: "Could not reach GitHub. Please try again."
  - Remove button with confirmation dialog: "This will make the marketplace read-only. Agents using these plugins will not be affected."
- Uses `router.refresh()` after save/remove to update server component data (same pattern as `add-marketplace-form.tsx`)

## Acceptance Criteria

### Functional
- [ ] Marketplace list shows "Owned" badge when GitHub token is configured
- [ ] Marketplace names are clickable links to detail pages
- [ ] Marketplace detail page lists plugins with name, description, version, capability badges
- [ ] Owned marketplace detail page has token config UI (set/update/remove)
- [ ] Token is validated for write access before saving
- [ ] Plugin editor shows skills, commands, and `.mcp.json` sections
- [ ] Skills and commands use the same `FileTreeEditor` component as agent skills
- [ ] Owned plugins are editable; non-owned are read-only
- [ ] Save pushes all changes in a single atomic Git commit to the default branch
- [ ] Conflict detection via non-force ref update (409 shown to user)
- [ ] Plugin cache cleared after successful save
- [ ] `.mcp.json` validated against `PluginMcpJsonSchema` before save

### Security
- [ ] Token is encrypted at rest with AES-256-GCM (same pattern as Composio API key)
- [ ] Token decryption supports key rotation via `ENCRYPTION_KEY_PREVIOUS`
- [ ] `github_token_enc` is never returned in API responses
- [ ] All filenames validated against `SafePluginFilename` regex before constructing GitHub paths

### Non-regression
- [ ] Agent skills editing still works identically after `FileTreeEditor` extraction
- [ ] Existing marketplace list/add/delete functionality unchanged

## Implementation Phases

### Phase 1: Foundation

1. **Migration** — `009_add_marketplace_github_token.sql`
2. **GitHub write API** — `pushFiles()`, `checkWriteAccess()` in `github.ts`
3. **Marketplace PATCH endpoint** — token set/update/remove with validation
4. **Validation schemas** — update `PluginMarketplaceRow`, add `UpdateMarketplaceSchema`

### Phase 2: Component Extraction

5. **Extract `FileTreeEditor`** — generic component from `SkillsEditor`
6. **Update `SkillsEditor`** — thin wrapper around `FileTreeEditor`
7. **Verify** — agent skills editing still works identically

### Phase 3: Pages

8. **Update marketplace list** — owned badge, clickable names
9. **Marketplace detail page** — plugin list, token config UI
10. **Plugin content API** — GET endpoint for fetching all plugin files
11. **Plugin save API** — PUT endpoint that pushes to GitHub
12. **Plugin editor page** — skills + commands + connectors editors

## Dependencies & Risks

**Dependencies:**
- GitHub fine-grained tokens with Contents read/write permission
- Existing `ENCRYPTION_KEY` env var (already required)

**Risks:**
- **Concurrent editing** — Mitigated by non-force `updateRef` (409 on conflict). Acceptable for admin-only feature with low concurrency.
- **External repo changes** — If someone pushes to the repo outside AgentPlane, the next save from AgentPlane will detect the conflict via ref mismatch. User must refresh and re-apply.
- **Token expiration** — Fine-grained tokens can expire. Save will fail with 401 — the UI shows a clear "Token expired" error and prompts reconfiguration. `checkWriteAccess()` also catches this at token configuration time.
- **Rate limits** — Each save is ~4 API calls (get ref, create tree, create commit, update ref). Well within GitHub's 5000 req/hr for authenticated users. The GET plugin content endpoint uses 1 tree API call + N raw CDN fetches (not rate-limited).
- **Stale editor content** — Admin opens plugin editor, another admin pushes changes externally, first admin saves. The non-force `updateRef` catches this with a 409. UI should disable save and prompt refresh.

## Out of Scope

- Plugin creation (adding new plugin directories)
- Plugin deletion from marketplace
- PR/branch workflow for changes
- Version history / rollback UI
- Token expiration monitoring
- Commit message customization
- `plugin.json` manifest editing

## References

### Internal
- SkillsEditor: `src/app/admin/(dashboard)/agents/[agentId]/skills-editor.tsx`
- ConnectorsManager: `src/app/admin/(dashboard)/agents/[agentId]/connectors-manager.tsx`
- Plugin library: `src/lib/plugins.ts`
- GitHub client: `src/lib/github.ts`
- Crypto: `src/lib/crypto.ts`
- Migration 008: `src/db/migrations/008_add_plugin_marketplaces.sql`
- Marketplace pages: `src/app/admin/(dashboard)/plugin-marketplaces/`
- Brainstorm: `docs/brainstorms/2026-02-18-plugin-management-brainstorm.md`

### External
- [GitHub Git Trees API](https://docs.github.com/en/rest/git/trees)
- [GitHub Git Commits API](https://docs.github.com/en/rest/git/commits)
- [GitHub Git Refs API](https://docs.github.com/en/rest/git/refs)
