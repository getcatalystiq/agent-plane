## Repository Research Summary — SoulSpec v0.5 Refactor

### 1. DB Migrations

**Pattern:** Sequential numbered SQL files in `src/db/migrations/` (currently 001-025+). Naming: `NNN-description.sql` or `NNN_description.sql` (both exist). Runner in `src/db/migrate.ts` reads all `.sql` files, sorts by filename, tracks applied migrations in a `_migrations` table (hash-based idempotency). Runs automatically on deploy via `vercel.json` buildCommand.

**Current identity migration** (`025_agent_identity.sql`):
```sql
ALTER TABLE agents ADD COLUMN IF NOT EXISTS soul_md TEXT DEFAULT NULL;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS identity_md TEXT DEFAULT NULL;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS identity JSONB DEFAULT NULL;
```

**Next migration** for your 6 new columns would be `026-soulspec-v05-columns.sql`. Use `ADD COLUMN IF NOT EXISTS` pattern. The derived `identity` JSONB column already exists and will need its derivation logic updated.

---

### 2. Identity Parser (`src/lib/identity.ts`)

**Current structure:**
- `buildIdentityPrefix(agent)` — concatenates `soul_md` + `identity_md` as plain text
- `prependIdentity(prompt, agent)` — prepends identity prefix to user prompt
- `parseSoulMd(content)` — parses `## Voice & Tone`, `## Values`, `## Stance`, `## Boundaries`, `## Essence` sections
- `parseIdentityMd(content)` — parses `- **Key:** value` KV pairs for enums (communication_verbosity, communication_tone, decision_autonomy, risk_tolerance, collaboration_mode) + `## Escalation Preferences` section
- `deriveIdentity(soulMd, identityMd)` — combines both parsers into `AgentIdentity` JSONB with `Soul` sub-object (voice, values, stance, essence) + enum fields + boundaries + escalation_preferences

**Callers:**
- `src/app/api/admin/agents/[agentId]/route.ts` (PATCH) — calls `deriveIdentity()` when soul_md or identity_md changes, stores result as `identity` JSONB
- `src/lib/sandbox.ts` (lines 703, 1061) — calls `prependIdentity()` to prepend to Claude SDK prompts
- `src/lib/runners/vercel-ai-runner.ts` (line 112) — calls `buildIdentityPrefix()` for Vercel AI SDK system prompt
- `src/lib/a2a.ts` (line 262) — reads `identity` JSONB for Agent Card metadata

**Your refactor** must update: the `AgentIdentity` type, `parseSoulMd` (new sections: Personality, Tone, Principles), expected fields, `deriveIdentity`, and `buildIdentityPrefix`/`prependIdentity` to also include the 6 new markdown files.

---

### 3. Sandbox File Injection

**Pattern** in `src/lib/sandbox.ts`:
- Files are written via `sandbox.writeFiles(Array<{ path: string; content: Buffer }>)`
- Skill files go to `.claude/skills/<folder>/<path>` under `/vercel/sandbox/workspace/`
- Plugin files go to `.claude/skills/` and `.claude/agents/` under `/vercel/sandbox/`
- Bridge files go to `/vercel/sandbox/agentco-bridge.mjs`
- Path traversal prevention: `path.resolve()` + `startsWith()` check
- All files written in a single `writeFiles()` batch call before runner execution

**For `.soul/` injection**, follow the same pattern:
```ts
const soulFiles: Array<{ path: string; content: Buffer }> = [];
if (agent.soul_md) soulFiles.push({ path: "/vercel/sandbox/workspace/.soul/SOUL.md", content: Buffer.from(agent.soul_md) });
// ... same for style_md, agents_md, heartbeat_md, etc.
```
Add to the `allFiles` array alongside skills/plugins/bridge files.

---

### 4. FileTreeEditor Component (`src/components/file-tree-editor.tsx`)

**FlatFile type:** `{ path: string; content: string }` (path includes folder prefix, e.g. `my-skill/SKILL.md`)

**Props interface:**
```ts
interface FileTreeEditorProps {
  initialFiles: FlatFile[];
  onChange?: (files: FlatFile[]) => void;
  onSave: (files: FlatFile[]) => Promise<void>;
  readOnly?: boolean;
  hideSave?: boolean;
  title?: string;
  saveLabel?: string;
  addFolderLabel?: string;
  newFileTemplate?: { filename: string; content: string };
  savedVersion?: number;  // increment to reset dirty state
}
```

**Usage pattern** (from `plugin-editor-client.tsx`):
- Uses `onChange` callback + `hideSave` for controlled mode (parent manages save)
- Uses `savedVersion` counter to reset dirty state after parent-initiated save
- Each tab gets its own `FileTreeEditor` instance with different `initialFiles`

**For the Identity tab**, you can use this same component with SoulSpec files as `FlatFile[]`:
```ts
const soulFiles: FlatFile[] = [
  { path: "SOUL.md", content: agent.soul_md ?? "" },
  { path: "IDENTITY.md", content: agent.identity_md ?? "" },
  { path: "STYLE.md", content: agent.style_md ?? "" },
  // ... etc
];
```

---

### 5. Admin Agent Edit Form

**Location:** `src/app/admin/(dashboard)/agents/[agentId]/edit-form.tsx`

**Current identity UI:** Two side-by-side `<Textarea>` fields (SOUL.md and IDENTITY.md) inside the "Identity" `<SectionHeader>` card on the General tab. Each has a word counter. Both are plain textareas, not CodeMirror.

**Save flow:** `handleSave()` calls `adminFetch(`/agents/${agent.id}`, { method: "PATCH", body })`. The PATCH body includes `soul_md` and `identity_md` as nullable strings.

**Agent detail page:** `src/app/admin/(dashboard)/agents/[agentId]/page.tsx` — tabbed interface. The edit form is embedded in the General tab.

**For the new Identity tab:** You would add a new tab alongside General/Connectors/Skills/Plugins/Schedules/Runs, using the existing `Tabs` component from `src/components/ui/tabs.tsx`. The tab content would use `FileTreeEditor` with the 8 SoulSpec files (SOUL.md, IDENTITY.md, STYLE.md, AGENTS.md, HEARTBEAT.md, USER_TEMPLATE.md, + good/bad examples). Remove the textarea fields from edit-form.tsx.

---

### 6. Validation Schemas (`src/lib/validation.ts`)

**Current identity validation:**
- `UpdateAgentSchema`: `soul_md: z.string().max(50_000).nullable().optional()`, `identity_md: z.string().max(50_000).nullable().optional()`
- `AgentRow`: `soul_md: z.string().max(50_000).nullable()`, `identity_md: z.string().max(50_000).nullable()`
- `CreateAgentSchema`: `soul_md: z.string().nullable().default(null)`
- `identityJsonbSchema`: transforms unknown to `Record<string, unknown> | null`

**For new columns**, add to all three schemas:
```ts
style_md: z.string().max(50_000).nullable().optional(),
agents_md: z.string().max(50_000).nullable().optional(),
heartbeat_md: z.string().max(50_000).nullable().optional(),
user_template_md: z.string().max(50_000).nullable().optional(),
examples_good_md: z.string().max(50_000).nullable().optional(),
examples_bad_md: z.string().max(50_000).nullable().optional(),
```

---

### 7. A2A Agent Card (`src/lib/a2a.ts`)

**Identity usage:** The `buildAgentCard()` function queries `identity` JSONB from the agents table and attaches it to the Agent Card as metadata:
```ts
...(agent.identity ? { metadata: { [IDENTITY_METADATA_KEY]: agent.identity } } : {}),
```
Where `IDENTITY_METADATA_KEY = 'soulspec:identity'`.

**Impact:** When you update the `AgentIdentity` type shape (new SoulSpec v0.5 fields like Personality, Tone, Principles), the A2A card metadata will automatically reflect the new structure since it passes the JSONB through. The Agent Card cache (60s TTL, process-level Map) means changes propagate within a minute.

---

### 8. Zip/Download Patterns

**No existing zip/export patterns found** in the codebase. You will need to add a new dependency (e.g., `jszip` or `archiver`) for the export-as-zip feature. The import-from-registry and publish-to-registry features will need new API routes.

---

### 9. AI Gateway Calls (for LLM Generation)

**Pattern:** The AI Gateway is used via two mechanisms:
1. **Claude Agent SDK** — `@anthropic-ai/claude-agent-sdk` `query()` with `ANTHROPIC_BASE_URL=https://ai-gateway.vercel.sh` (inside sandbox)
2. **Vercel AI SDK** — `createGateway({ apiKey })` from `ai` package with `AI_GATEWAY_API_KEY` env var (inside sandbox)
3. **Model catalog** — direct `fetch("https://ai-gateway.vercel.sh/v1/models")` with bearer auth (server-side, in `src/lib/model-catalog.ts`)

**For "Generate Soul" button**, you would make a server-side API route that calls AI Gateway directly (similar to model-catalog pattern):
```ts
const res = await fetch("https://ai-gateway.vercel.sh/v1/chat/completions", {
  method: "POST",
  headers: {
    "Authorization": `Bearer ${getEnv().AI_GATEWAY_API_KEY}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({
    model: "claude-sonnet-4-20250514",
    messages: [{ role: "user", content: generationPrompt }],
  }),
});
```
This keeps generation server-side (no sandbox needed) and uses the existing `AI_GATEWAY_API_KEY`.

---

### Key File Paths

| Area | Path |
|------|------|
| Identity parser | `/Users/marmarko/code/agent-plane/src/lib/identity.ts` |
| Sandbox injection | `/Users/marmarko/code/agent-plane/src/lib/sandbox.ts` |
| Vercel AI runner | `/Users/marmarko/code/agent-plane/src/lib/runners/vercel-ai-runner.ts` |
| Validation schemas | `/Users/marmarko/code/agent-plane/src/lib/validation.ts` |
| A2A card builder | `/Users/marmarko/code/agent-plane/src/lib/a2a.ts` |
| Admin PATCH route | `/Users/marmarko/code/agent-plane/src/app/api/admin/agents/[agentId]/route.ts` |
| Agent edit form | `/Users/marmarko/code/agent-plane/src/app/admin/(dashboard)/agents/[agentId]/edit-form.tsx` |
| Agent detail page | `/Users/marmarko/code/agent-plane/src/app/admin/(dashboard)/agents/[agentId]/page.tsx` |
| FileTreeEditor | `/Users/marmarko/code/agent-plane/src/components/file-tree-editor.tsx` |
| Plugin editor (reference) | `/Users/marmarko/code/agent-plane/src/app/admin/(dashboard)/plugin-marketplaces/[marketplaceId]/plugins/[...pluginName]/plugin-editor-client.tsx` |
| DB migrations dir | `/Users/marmarko/code/agent-plane/src/db/migrations/` |
| Migration runner | `/Users/marmarko/code/agent-plane/src/db/migrate.ts` |
| Model catalog | `/Users/marmarko/code/agent-plane/src/lib/model-catalog.ts` |
| Agent loader | `/Users/marmarko/code/agent-plane/src/lib/agents.ts` |
