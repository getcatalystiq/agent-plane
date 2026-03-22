# Sharing TypeScript Types Between SDK and Next.js App in a Single Repo

Research completed 2026-03-22. Based on analysis of Vercel AI SDK monorepo, tsup docs, and your current codebase.

---

## Current State

- **App types**: `src/lib/types.ts` — branded types (`TenantId`, `AgentId`), state machines, internal interfaces
- **SDK types**: `sdk/src/types.ts` — wire-format interfaces (`Run`, `Agent`, `StreamEvent`), plain `string` IDs
- **Overlap**: `RunStatus`, `RunTriggeredBy`, `SessionStatus`, `RunnerType`, `AgentPlugin` duplicated in both files
- **SDK build**: tsup (ESM + CJS + DTS), `rootDir: "src"`, publishes `dist/` only
- **App build**: Next.js 16, `noEmit: true`, path alias `@/*` -> `./src/*`
- **Root tsconfig** excludes `sdk/` from app compilation

## Recommended Pattern: Shared Types Package (Internal)

This is the pattern used by Vercel AI SDK (`@ai-sdk/provider` contains shared types consumed by `ai` and all `@ai-sdk/*` packages). tRPC does the same with `@trpc/core`.

### Option A: `shared/` Internal Package (Recommended)

Create a lightweight internal package that both `sdk/` and `src/` import from. No npm publish needed.

```
shared/
  package.json        # { "name": "@agent-plane/shared", "private": true }
  tsconfig.json
  src/
    index.ts          # Re-exports all shared types
    run-status.ts     # RunStatus, RunTriggeredBy, etc.
    session-status.ts # SessionStatus, session transitions
    agent.ts          # AgentPlugin, PermissionMode, RunnerType
    stream-events.ts  # StreamEvent union (if SDK and app both need it)
```

#### shared/package.json

```json
{
  "name": "@agent-plane/shared",
  "private": true,
  "version": "0.0.0",
  "type": "module",
  "exports": {
    ".": {
      "types": "./src/index.ts",
      "default": "./src/index.ts"
    }
  },
  "types": "./src/index.ts"
}
```

Key: `exports` points directly at `.ts` source files. This works because:
- Next.js (via webpack/turbopack) resolves `.ts` natively
- tsup resolves `.ts` imports and bundles them into the SDK output
- No separate build step for shared types

#### shared/tsconfig.json

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "declaration": true,
    "isolatedModules": true,
    "noEmit": true
  },
  "include": ["src"]
}
```

#### Root package.json — add workspaces

```json
{
  "workspaces": ["shared", "sdk"]
}
```

Then `npm install` creates symlinks so both `sdk/` and `src/` can import `@agent-plane/shared`.

#### SDK package.json — add dependency

```json
{
  "dependencies": {
    "@agent-plane/shared": "workspace:*"
  }
}
```

#### SDK tsup.config.ts — inline the shared types

```typescript
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm", "cjs"],
  dts: true,
  clean: true,
  splitting: false,
  sourcemap: true,
  // Critical: bundle @agent-plane/shared INTO the SDK output
  // so npm consumers don't need to install it
  noExternal: ["@agent-plane/shared"],
});
```

The `noExternal` key tells tsup to inline the shared package. The published SDK `.d.ts` files will contain the resolved types — npm consumers see no trace of `@agent-plane/shared`.

#### App usage — direct import

```typescript
// src/lib/types.ts
import type { RunStatus, SessionStatus } from "@agent-plane/shared";

// Keep branded types here (app-only concern)
export type TenantId = string & { readonly __brand: "TenantId" };
```

#### App tsconfig.json — include shared

Remove `"sdk"` from excludes (already done), and add shared to include:

```json
{
  "include": [
    "next-env.d.ts",
    "**/*.ts",
    "**/*.tsx",
    ".next/types/**/*.ts",
    ".next/dev/types/**/*.ts",
    "**/*.mts",
    "shared/src/**/*.ts"
  ],
  "exclude": ["node_modules", "sdk"]
}
```

Or rely on workspace resolution (the symlink in `node_modules/@agent-plane/shared` will resolve).

### Option B: Direct tsconfig Path Alias (Simpler, More Fragile)

No extra package. Both `sdk/` and `src/` import from a shared file via path alias.

#### Root tsconfig.json

```json
{
  "compilerOptions": {
    "paths": {
      "@/*": ["./src/*"],
      "@shared/*": ["./shared/*"]
    }
  }
}
```

#### SDK tsconfig.json

```json
{
  "compilerOptions": {
    "paths": {
      "@shared/*": ["../shared/*"]
    }
  }
}
```

**Problem**: tsup does NOT resolve tsconfig `paths` by default. You need `tsup-plugin-tsconfig-paths` or configure esbuild aliases manually. This makes the SDK build fragile.

**Verdict**: Path aliases work for the Next.js app but break SDK builds. Not recommended.

### Option C: SDK Imports from `../src/lib/` (Worst)

Having the SDK import `../src/lib/types.ts` directly:
- Breaks `rootDir: "src"` in SDK tsconfig
- tsup won't bundle files outside entry's root by default
- Published `.d.ts` files may reference paths that don't exist for npm consumers

**Verdict**: Do not do this.

---

## What to Put in Shared vs. Keep Separate

### Move to `@agent-plane/shared`

These are duplicated today and used by both SDK and app:

| Type | Currently in |
|------|-------------|
| `RunStatus` | Both `sdk/src/types.ts` and `src/lib/types.ts` |
| `RunTriggeredBy` | Both |
| `SessionStatus` | Both |
| `RunnerType` | `sdk/src/types.ts` + `src/lib/models.ts` |
| `PermissionMode` | `sdk/src/types.ts` (app uses string literal) |
| `AgentPlugin` | Both (SDK uses `string`, app uses branded `PluginMarketplaceId`) |

For `AgentPlugin`, the shared version should use `string` (wire format). The app can narrow:

```typescript
// @agent-plane/shared
export interface AgentPlugin {
  marketplace_id: string;
  plugin_name: string;
}

// src/lib/types.ts (app-only)
import type { AgentPlugin as WireAgentPlugin } from "@agent-plane/shared";
export interface AgentPlugin extends Omit<WireAgentPlugin, 'marketplace_id'> {
  marketplace_id: PluginMarketplaceId;
}
```

### Keep in SDK only

- `AgentPlaneOptions`, `CreateRunParams`, `ListRunsParams`, `PaginatedResponse`
- `narrowStreamEvent()`, `KNOWN_EVENT_TYPES` (runtime code)
- All resource-specific request/response types

### Keep in App only

- Branded types (`TenantId`, `AgentId`, etc.)
- `VALID_TRANSITIONS`, `SESSION_VALID_TRANSITIONS` (runtime state machines)
- `OAuthMetadata`, `TokenExchangeResult` (internal OAuth flow)
- `ScheduleConfig`, `ScheduleFrequency` (internal scheduling)

---

## How Vercel AI SDK Does It

From the CLAUDE.md of the `vercel/ai` repo:

1. **pnpm workspaces + Turborepo** orchestrate the monorepo
2. **`@ai-sdk/provider`** is a shared types/interfaces package — defines `LanguageModel`, `EmbeddingModel`, provider specs
3. **`@ai-sdk/provider-utils`** depends on `@ai-sdk/provider` — shared runtime utilities
4. **`ai`** (the main SDK) depends on both
5. Each provider package (`@ai-sdk/openai`, etc.) depends on `@ai-sdk/provider` + `@ai-sdk/provider-utils`
6. Every package uses **tsup** with `dts: true`
7. Shared packages are published to npm (they're public). For a private monorepo, `"private": true` + `noExternal` in tsup achieves the same result without publishing.

---

## Migration Plan for agent-plane

### Step 1: Create shared/ directory

```bash
mkdir -p shared/src
```

### Step 2: Extract shared types

Move the overlapping types into `shared/src/index.ts`:

```typescript
// shared/src/index.ts
export type RunStatus = "pending" | "running" | "completed" | "failed" | "cancelled" | "timed_out";
export type RunTriggeredBy = "api" | "schedule" | "playground" | "chat" | "a2a";
export type SessionStatus = "creating" | "active" | "idle" | "stopped";
export type RunnerType = "claude-agent-sdk" | "vercel-ai-sdk";
export type PermissionMode = "default" | "acceptEdits" | "bypassPermissions" | "plan";
```

### Step 3: Add workspace config

Root `package.json`: add `"workspaces": ["shared", "sdk"]`

### Step 4: Update SDK imports

```typescript
// sdk/src/types.ts
export type { RunStatus, RunTriggeredBy, SessionStatus, RunnerType, PermissionMode } from "@agent-plane/shared";
// ... keep SDK-specific types here
```

### Step 5: Update app imports

```typescript
// src/lib/types.ts
export type { RunStatus, RunTriggeredBy, SessionStatus, RunnerType } from "@agent-plane/shared";
// ... keep branded types and app-specific types here
```

### Step 6: Update SDK tsup config

Add `noExternal: ["@agent-plane/shared"]` so shared types are inlined into the published package.

### Step 7: Verify

```bash
npm install                # creates workspace symlinks
npm run sdk:build          # shared types inlined into dist/
npm run sdk:typecheck      # SDK sees shared types
npm run build              # Next.js resolves shared types
```

---

## Next.js 16 Gotchas

1. **Turbopack** (default in dev for Next 16) resolves workspace packages via `exports` field. Make sure `shared/package.json` has `"exports"` pointing to `.ts` source.

2. **Server Components** — type-only imports (`import type`) have zero runtime cost and work everywhere. If you ever export runtime values from shared, ensure they're compatible with both server and client contexts.

3. **`transpilePackages`** — Not needed if shared/package.json exports `.ts` directly. Turbopack and webpack both handle `.ts` in workspace packages. If you hit issues, add to `next.config.ts`:
   ```typescript
   transpilePackages: ["@agent-plane/shared"]
   ```

4. **Module resolution** — Both Next.js 16 and your SDK use `"moduleResolution": "bundler"`. This is ideal for workspace packages with `"exports"` maps.

---

## Summary

| Approach | SDK Build | Next.js | npm Consumers | Complexity |
|----------|-----------|---------|---------------|------------|
| **Workspace package (Option A)** | Works (noExternal) | Works (symlink) | Clean (inlined) | Low |
| Path aliases (Option B) | Fragile (needs plugin) | Works | Clean | Medium |
| Cross-directory import (Option C) | Breaks | N/A | Breaks | N/A |

**Recommendation**: Option A (workspace package) is the industry standard pattern used by Vercel AI SDK, tRPC, and Prisma. It adds one `package.json` and one `tsconfig.json` but eliminates type duplication cleanly.
