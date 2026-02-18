---
title: "feat: Add superadmin interface for tenants, agents, and runs"
type: feat
status: active
date: 2026-02-15
---

# Superadmin Interface

## Overview

Add a basic internal admin UI at `/admin` that allows superadmins to manage tenants, view/edit agents across all tenants, and inspect agent runs. Protected by the existing `ADMIN_API_KEY` env var.

## Problem Statement

Currently, all management is done via raw SQL or API calls with tenant-scoped API keys. There's no way to get a cross-tenant view of the platform, inspect runs, or manage tenants without direct DB access.

## Proposed Solution

Server-rendered Next.js pages under `/admin/*` with Tailwind CSS for styling. Admin auth via a login page that sets an httpOnly cookie, verified by Next.js middleware. Admin API routes under `/api/admin/*` bypass RLS to query across all tenants.

## Technical Approach

### Auth Flow

1. `/admin/login` — form with single password field
2. On submit, POST to `/api/admin/login` which validates against `ADMIN_API_KEY` and sets an httpOnly cookie (`admin_token`)
3. Next.js middleware on `/admin/*` (except `/admin/login`) checks the cookie — redirects to login if missing/invalid
4. `/api/admin/*` routes verify the cookie via a shared `authenticateAdminFromCookie()` helper
5. Logout clears the cookie

### Data Access

Admin API routes query the DB directly without tenant scoping (no RLS `set_config` call). Use the existing `query()`, `queryOne()`, `execute()` helpers from `src/db/index.ts`.

### UI Structure

Minimal, functional UI. Server Components for data fetching, Client Components only where interactivity is needed (forms, modals). No UI component library — just Tailwind utility classes.

## Implementation Phases

### Phase 1: Foundation

**Install Tailwind CSS + set up admin auth**

- [ ] Install `tailwindcss`, `@tailwindcss/postcss`, configure `postcss.config.mjs` and update `globals.css`
- [ ] Add `src/lib/admin-auth.ts` — `authenticateAdminFromCookie(request)` helper, `setAdminCookie()`, `clearAdminCookie()`
- [ ] Add `src/middleware.ts` — protect `/admin/*` routes (except `/admin/login`), redirect to login if no valid cookie
- [ ] Add `src/app/admin/login/page.tsx` — login form (Client Component)
- [ ] Add `src/app/api/admin/login/route.ts` — POST validates key, sets cookie; DELETE clears cookie

**Files:**
- `postcss.config.mjs` (new)
- `src/app/globals.css` (edit — add `@import "tailwindcss"`)
- `src/lib/admin-auth.ts` (new)
- `src/middleware.ts` (new)
- `src/app/admin/login/page.tsx` (new)
- `src/app/api/admin/login/route.ts` (new)

### Phase 2: Admin Layout + Tenants

**Admin shell layout and tenant management**

- [ ] Add `src/app/admin/layout.tsx` — sidebar nav (Tenants, Agents, Runs), logout button, dark themed
- [ ] Add `src/app/api/admin/tenants/route.ts` — GET list all tenants (with agent count, run count, spend)
- [ ] Add `src/app/admin/tenants/page.tsx` — table: name, slug, status, monthly budget, current spend, agent count
- [ ] Add `src/app/api/admin/tenants/[tenantId]/route.ts` — GET detail, PATCH update (status, budget)
- [ ] Add `src/app/admin/tenants/[tenantId]/page.tsx` — detail view with edit form, list of agents

**Files:**
- `src/app/admin/layout.tsx` (new)
- `src/app/api/admin/tenants/route.ts` (new)
- `src/app/api/admin/tenants/[tenantId]/route.ts` (new)
- `src/app/admin/tenants/page.tsx` (new)
- `src/app/admin/tenants/[tenantId]/page.tsx` (new)

### Phase 3: Agents + Runs

**Cross-tenant agent listing and run inspection**

- [ ] Add `src/app/api/admin/agents/route.ts` — GET list all agents across tenants (with tenant name, run count)
- [ ] Add `src/app/admin/agents/page.tsx` — table: name, tenant, model, permission mode, run count, last run
- [ ] Add `src/app/api/admin/runs/route.ts` — GET list all runs (filterable by tenant, agent, status)
- [ ] Add `src/app/admin/runs/page.tsx` — table: agent name, tenant, status, cost, duration, turns, timestamps
- [ ] Add `src/app/api/admin/runs/[runId]/route.ts` — GET run detail with transcript
- [ ] Add `src/app/admin/runs/[runId]/page.tsx` — run detail: metadata, transcript viewer (NDJSON rendered as timeline)

**Files:**
- `src/app/api/admin/agents/route.ts` (new)
- `src/app/admin/agents/page.tsx` (new)
- `src/app/api/admin/runs/route.ts` (new)
- `src/app/api/admin/runs/[runId]/route.ts` (new)
- `src/app/admin/runs/page.tsx` (new)
- `src/app/admin/runs/[runId]/page.tsx` (new)

### Phase 4: Dashboard

**Admin home with platform overview**

- [ ] Add `src/app/admin/page.tsx` — dashboard: total tenants, total agents, active runs, total spend, recent runs list

## Acceptance Criteria

### Functional
- [ ] Admin can log in with `ADMIN_API_KEY` at `/admin/login`
- [ ] Unauthenticated requests to `/admin/*` redirect to login
- [ ] Tenants page lists all tenants with key metrics
- [ ] Tenant detail page shows agents and allows editing status/budget
- [ ] Agents page lists all agents across tenants
- [ ] Runs page lists all runs with status filtering
- [ ] Run detail page shows full metadata and transcript
- [ ] Dashboard shows platform overview stats

### Non-Functional
- [ ] All pages server-rendered (no loading spinners for initial data)
- [ ] `npx next build` passes
- [ ] No new dependencies beyond Tailwind CSS

## References

- `src/lib/auth.ts:68` — existing `authenticateAdmin()` function
- `src/lib/api.ts` — `withErrorHandler`, `jsonResponse` patterns
- `src/db/index.ts` — `query`, `queryOne`, `execute` helpers
- `src/lib/validation.ts` — `TenantRow`, `AgentRow`, `RunRow` Zod schemas
