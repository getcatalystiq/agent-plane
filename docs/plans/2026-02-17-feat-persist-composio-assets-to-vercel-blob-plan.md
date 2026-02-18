---
title: "feat: Persist Composio assets to Vercel Blob"
type: feat
status: active
date: 2026-02-17
---

# Persist Composio Assets to Vercel Blob

## Overview

Composio MCP tools (browser automation, file tools, etc.) return binary assets — images, PDFs, documents — in tool result content blocks. These assets are ephemeral: base64-encoded data bloats the event stream and transcript, while any Composio-hosted URLs expire. We need to intercept binary content in the runner script during execution, upload it to Vercel Blob, and replace inline data with permanent URLs.

## Problem Statement

Today, binary content from Composio tools is **silently discarded**:

1. The runner script (`sandbox.ts:buildRunnerScript`) emits raw SDK messages via `emit()` — including multi-megabyte base64 image blocks
2. The `StreamEvent` type defines `tool_result.output` as `string`, losing structured content
3. The transcript viewer (`transcript-viewer.tsx:80-84`) filters content blocks to `type === "text"` only
4. The playground (`playground/page.tsx:64-73`) renders tool results as truncated text
5. After the sandbox stops, all files created during execution are lost

Net result: screenshots, generated images, and downloaded files from Composio tools vanish.

## Proposed Solution

Intercept binary content **inside the runner script** during execution. For each binary content block in a tool result, upload it to a new internal API endpoint that stores it in Vercel Blob. Replace the base64 data with the permanent Blob URL before emitting the event. Update the UI to render images.

### Architecture

```
┌─────────────────────────────────────────────────────┐
│  Vercel Sandbox (runner.mjs)                        │
│                                                     │
│  Claude Agent SDK ─► query() yields messages        │
│       │                                             │
│       ▼                                             │
│  processMessage()                                   │
│    ├─ text block → pass through                     │
│    └─ image block (base64) ──► POST /api/internal/  │
│         │                       runs/{id}/assets    │
│         ◄─── { url: "https://...blob..." } ────┘   │
│         │                                           │
│         ▼                                           │
│    replace base64 with url, emit()                  │
└─────────────────────────────────────────────────────┘
         │
         ▼  (NDJSON stdout)
┌─────────────────────────────────────────────────────┐
│  Platform API                                       │
│                                                     │
│  POST /api/internal/runs/{id}/assets                │
│    ├─ verify run token                              │
│    ├─ validate content type + size                  │
│    ├─ put() to Vercel Blob (addRandomSuffix: true)  │
│    └─ return { url }                                │
│                                                     │
│  SSE stream ─► client (tool_result has Blob URLs)   │
│  Transcript ─► Vercel Blob (contains Blob URLs)     │
└─────────────────────────────────────────────────────┘
```

## Technical Considerations

### Prerequisite: Run Token Infrastructure

The runner script references `AGENTPLANE_RUN_TOKEN` but it is **never populated**. The `/api/internal/` route prefix does not exist. The middleware (`middleware.ts`) rejects tokens without `ap_` prefixes. This must be built first.

**Approach:**
- Generate a cryptographically random token during `createRun()`, store its SHA-256 hash in a new `runs.run_token_hash` column
- Pass the raw token to the sandbox via `AGENTPLANE_RUN_TOKEN` env var
- Exempt `/api/internal/` paths from middleware token-prefix validation (route handler does its own auth)
- Verify the token in the internal endpoint by hashing and comparing to DB

### Body Size Limits

Vercel serverless functions default to 4.5MB body limit. A single browser screenshot as base64 can be 2-6MB. Use Next.js route segment config to increase the limit.

### Blob Path Convention

```
assets/{tenantId}/{runId}/{uuid}.{ext}
```

With `addRandomSuffix: true`, each asset gets a unique, unguessable URL. The `{tenantId}/{runId}` prefix enables prefix-based listing for cleanup.

### Content Block Detection

The Anthropic API's image content block format:
```json
{
  "type": "image",
  "source": {
    "type": "base64",
    "media_type": "image/png",
    "data": "iVBOR..."
  }
}
```

The runner scans `message.message.content` arrays for blocks matching this shape. On successful upload, replaces with:
```json
{
  "type": "image",
  "source": {
    "type": "url",
    "url": "https://....blob.vercel-storage.com/assets/..."
  }
}
```

### Error Handling

If the asset upload fails, **keep the original base64 data** in the event. This prevents data loss at the cost of a larger event. Log the error.

### Backward Compatibility

The `tool_result` StreamEvent keeps `output: string` for text. Add an optional `content` field (array of content blocks) alongside `output` for structured content including images. Existing API consumers continue to work — they just ignore the new field.

## Acceptance Criteria

### Phase 1: Run Token + Internal Endpoint

- [ ] **DB migration** — add `run_token_hash TEXT` column to `runs` table
- [ ] **Token generation** — `createRun()` generates a random token, hashes it, stores the hash, returns the raw token
- [ ] **Middleware exemption** — `/api/internal/` paths skip the token-prefix check in `middleware.ts`
- [ ] **Internal asset endpoint** — `POST /api/internal/runs/{runId}/assets` accepts JSON body `{ data: string, mediaType: string, filename?: string }`, verifies the run token, uploads to Vercel Blob at `assets/{tenantId}/{runId}/{uuid}.{ext}` with `addRandomSuffix: true`, returns `{ url: string }`
- [ ] **Content validation** — accept only `image/png`, `image/jpeg`, `image/gif`, `image/webp`, `application/pdf`; reject others with 400. Max 10MB per asset.
- [ ] **Pass run token to sandbox** — both `src/app/api/runs/route.ts` and `src/app/api/admin/agents/[agentId]/runs/route.ts` (playground) pass the token to `createSandbox()`

### Phase 2: Runner Script Asset Interception

- [ ] **`processMessage()` function** in the generated runner script — walks content blocks in `user` messages (tool_result blocks), detects `type: "image"` with `source.type: "base64"`, uploads via the internal endpoint, replaces base64 with Blob URL
- [ ] **Synchronous rewrite before emit** — the modified message is emitted only after all uploads complete (so the SSE stream and transcript never contain raw base64)
- [ ] **Fallback on failure** — if upload fails, emit the original message with base64 intact and log an error
- [ ] **Sequential uploads** — process image blocks one at a time to avoid overwhelming the endpoint

### Phase 3: UI Rendering

- [ ] **Transcript viewer** — `buildConversation()` in `transcript-viewer.tsx` extracts `type: "image"` blocks with `source.type: "url"` and renders them as `<img>` tags in the tool output section
- [ ] **Playground** — tool_result rendering detects image URLs in the event's content blocks and displays inline images
- [ ] **Image styling** — `max-width: 100%; max-height: 400px; object-fit: contain`. Clicking opens full URL in new tab.

### Phase 4: Cleanup

- [ ] **Extend cleanup cron** — when deleting a run's transcript, also delete assets by listing Vercel Blob with prefix `assets/{tenantId}/{runId}/` and deleting all matches
- [ ] **Same retention** — 30-day TTL matching transcripts

## Dependencies & Risks

| Risk | Mitigation |
|---|---|
| Run token infrastructure doesn't exist yet | Build it first as Phase 1; blocks everything else |
| Vercel body size limit (4.5MB) may truncate large images | Use `export const config = { api: { bodyParser: { sizeLimit: '10mb' } } }` on the endpoint |
| Sandbox network policy doesn't include Blob storage | Asset endpoint proxies the upload — sandbox only talks to platform API, which is already allowed |
| Composio may return ephemeral URLs (not just base64) | v1 handles base64 content blocks only. Ephemeral URL handling is a future iteration. |
| Runner script complexity increases | Keep `processMessage()` simple with clear fallback behavior |
| Multiple assets per tool result under sandbox timeout pressure | Sequential uploads; 10-min sandbox timeout is generous |

## References & Research

### Internal References

- Existing Blob usage: `src/lib/transcripts.ts:11` — `put()` with path convention
- Runner script generation: `src/lib/sandbox.ts:168-285` — `buildRunnerScript()`
- Sandbox config and network policy: `src/lib/sandbox.ts:52-67`
- Transcript viewer (discards images): `src/app/admin/(dashboard)/runs/[runId]/transcript-viewer.tsx:80-84`
- Playground rendering (text only): `src/app/admin/(dashboard)/agents/[agentId]/playground/page.tsx:64-73`
- StreamEvent types: `src/lib/types.ts:112-166`
- Run creation flow: `src/app/api/runs/route.ts:17-119`
- Cleanup cron: `src/app/api/cron/cleanup-transcripts/route.ts`
- Middleware auth: `src/middleware.ts`
- Composio integration: `src/lib/composio.ts`, `src/lib/mcp.ts`

### Key Files to Create/Modify

| File | Action |
|---|---|
| `src/db/migrations/NNN_add_run_token_hash.sql` | New — add `run_token_hash` column |
| `src/lib/runs.ts` | Modify — generate + store run token during `createRun()` |
| `src/lib/crypto.ts` | Modify — add token generation helper |
| `src/middleware.ts` | Modify — exempt `/api/internal/` from token-prefix check |
| `src/app/api/internal/runs/[runId]/assets/route.ts` | New — asset upload endpoint |
| `src/lib/sandbox.ts` | Modify — pass `runToken` to sandbox, add `processMessage()` to runner script |
| `src/app/api/runs/route.ts` | Modify — pass run token to `createSandbox()` |
| `src/app/api/admin/agents/[agentId]/runs/route.ts` | Modify — pass run token to `createSandbox()` |
| `src/lib/types.ts` | Modify — add `content` field to `tool_result` StreamEvent |
| `src/app/admin/(dashboard)/runs/[runId]/transcript-viewer.tsx` | Modify — render image blocks |
| `src/app/admin/(dashboard)/agents/[agentId]/playground/page.tsx` | Modify — render image blocks |
| `src/app/api/cron/cleanup-transcripts/route.ts` | Modify — delete assets by prefix |
