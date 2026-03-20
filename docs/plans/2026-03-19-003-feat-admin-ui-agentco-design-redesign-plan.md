---
title: "feat: Admin UI Redesign — AgentCo Design System"
type: feat
status: active
date: 2026-03-19
---

# feat: Admin UI Redesign — AgentCo Design System

## Enhancement Summary

**Deepened on:** 2026-03-19
**Sections enhanced:** All 4 phases + system-wide impact
**Review agents used:** Frontend design reviewer, Architecture strategist, AgentCo component analyzer, Agent-native reviewer

### Key Improvements
1. **Cookie-based tenant context** — localStorage replaced with cookie for SSR compatibility in Next.js server components; `getActiveTenantId()` server utility
2. **Complete OKLCH token set** — Added 12 missing tokens (popover, foreground variants, all 8 sidebar tokens, radius sub-tokens, `@theme inline` Tailwind v4 bridge)
3. **Tenant creation preserved** — "Create Tenant" action added to switcher dropdown (was silently removed)
4. **Collapsed sidebar UX** — Avatar-only trigger, nav tooltips, mobile drawer behavior, collapse toggle button
5. **Settings page detail** — Field-level specs, save button UX, API key one-time-display modal, confirmation dialogs
6. **Exact component specs** — Full CVA variant definitions from AgentCo for button, badge, card, input (copy-paste ready)
7. **Accessibility** — ARIA roles, keyboard navigation, loading skeletons, AbortController cleanup

### New Considerations Discovered
- Landing page (`/`) must be excluded from theme system (keep hardcoded dark)
- 4+ pages have hardcoded `/admin/tenants/` links that need updating (agents list, agent detail, runs list)
- `matchMedia` listener needed for live system theme changes
- Slug field should be read-only on Settings page (used in A2A URLs)
- AgentCo uses CVA (class-variance-authority) + Radix Slot for all variant components

---

## Overview

Redesign the AgentPlane admin UI to match AgentCo's design system exactly. This includes adopting AgentCo's OKLCH color tokens, light/dark theme support, tenant switcher in the sidebar header, collapsible sidebar, and replacing the Tenants page with a Settings page.

## Problem Statement

The current admin UI uses a custom dark-mode-only design with HSL colors that doesn't match AgentCo's polished visual language. The tenant management UX requires navigating to a separate Tenants list page, whereas AgentCo uses a compact company switcher dropdown in the sidebar header. The inconsistency between the two products creates a fragmented experience for users managing agents across both platforms.

## Proposed Solution

Adopt AgentCo's design system wholesale: OKLCH color tokens, light/dark/system theme support, collapsible sidebar with tenant switcher, and a new Settings page that consolidates tenant details + API keys. Remove the standalone Tenants list page.

## Technical Approach

### Architecture

```
Current Layout:
+-------------+--------------------------+
|  Sidebar    |  Main Content            |
|  (w-56)     |  (p-8)                   |
|             |                          |
|  Dashboard  |                          |
|  Tenants    |                          |
|  Agents     |                          |
|  Connectors |                          |
|  Plugins    |                          |
|  Runs       |                          |
+-------------+--------------------------+

Target Layout (matching AgentCo):
+-------------+--------------------------+
| [Tenant v]  |  Main Content            |
|-------------|  (p-6)                   |
|  Dashboard  |                          |
|  Agents     |                          |
|  Connectors |                          |
|  Plugins    |                          |
|  Runs       |                          |
|             |                          |
|-------------|                          |
|  Settings   |                          |
|  [User v]   |                          |
+-------------+--------------------------+
```

### Implementation Phases

#### Phase 1: Design Tokens — OKLCH Color System

**Goal:** Replace HSL color tokens with AgentCo's exact OKLCH values. Add light mode + system theme support.

**Files:**

- **`src/app/globals.css`** — Replace all CSS custom properties with AgentCo's OKLCH tokens:

  Light mode (`:root`):
  - `--background: oklch(1 0 0)` / `--foreground: oklch(0.145 0 0)`
  - `--card: oklch(1 0 0)` / `--card-foreground: oklch(0.145 0 0)`
  - `--primary: oklch(0.205 0 0)` / `--primary-foreground: oklch(0.985 0 0)`
  - `--secondary: oklch(0.97 0 0)` / `--muted: oklch(0.97 0 0)`
  - `--muted-foreground: oklch(0.556 0 0)` / `--accent: oklch(0.97 0 0)`
  - `--destructive: oklch(0.577 0.245 27.325)`
  - `--border: oklch(0.922 0 0)` / `--input: oklch(0.922 0 0)` / `--ring: oklch(0.708 0 0)`
  - `--radius: 0.625rem`
  - Sidebar tokens: `--sidebar: oklch(0.985 0 0)` / `--sidebar-border: oklch(0.922 0 0)`

  Dark mode (`.dark`):
  - `--background: oklch(0.145 0 0)` / `--foreground: oklch(0.922 0 0)`
  - `--card: oklch(0.205 0 0)` / `--card-foreground: oklch(0.922 0 0)`
  - `--primary: oklch(0.922 0 0)` / `--primary-foreground: oklch(0.145 0 0)`
  - `--secondary: oklch(0.269 0 0)` / `--muted: oklch(0.269 0 0)`
  - `--muted-foreground: oklch(0.556 0 0)` / `--accent: oklch(0.269 0 0)`
  - `--border: oklch(0.35 0 0)` / `--input: oklch(0.35 0 0)` / `--ring: oklch(0.556 0 0)`
  - Sidebar: `--sidebar: oklch(0.175 0 0)` / `--sidebar-border: oklch(0.35 0 0)`

  Chart tokens (both modes): `--chart-1` through `--chart-5` with OKLCH values.

  Update Tailwind dark variant: `@custom-variant dark (&:is(.dark *));`

- **`src/app/globals.css`** — Also add the Tailwind v4 `@theme inline` bridge block (required for utility classes like `bg-sidebar-accent` to resolve):
  ```css
  @theme inline {
    --color-background: var(--background);
    --color-foreground: var(--foreground);
    --color-card: var(--card);
    --color-card-foreground: var(--card-foreground);
    --color-popover: var(--popover);
    --color-popover-foreground: var(--popover-foreground);
    --color-primary: var(--primary);
    --color-primary-foreground: var(--primary-foreground);
    --color-secondary: var(--secondary);
    --color-secondary-foreground: var(--secondary-foreground);
    --color-muted: var(--muted);
    --color-muted-foreground: var(--muted-foreground);
    --color-accent: var(--accent);
    --color-accent-foreground: var(--accent-foreground);
    --color-destructive: var(--destructive);
    --color-destructive-foreground: var(--destructive-foreground);
    --color-border: var(--border);
    --color-input: var(--input);
    --color-ring: var(--ring);
    --color-sidebar: var(--sidebar);
    --color-sidebar-foreground: var(--sidebar-foreground);
    --color-sidebar-primary: var(--sidebar-primary);
    --color-sidebar-primary-foreground: var(--sidebar-primary-foreground);
    --color-sidebar-accent: var(--sidebar-accent);
    --color-sidebar-accent-foreground: var(--sidebar-accent-foreground);
    --color-sidebar-border: var(--sidebar-border);
    --color-sidebar-ring: var(--sidebar-ring);
    --color-chart-1: var(--chart-1);
    --color-chart-2: var(--chart-2);
    --color-chart-3: var(--chart-3);
    --color-chart-4: var(--chart-4);
    --color-chart-5: var(--chart-5);
    --radius-sm: calc(var(--radius) - 4px);
    --radius-md: calc(var(--radius) - 2px);
    --radius-lg: var(--radius);
    --radius-xl: calc(var(--radius) + 4px);
  }
  ```

- **Missing tokens to add** (discovered in review — AgentCo defines these, plan originally omitted):
  - `:root`: `--popover: oklch(1 0 0)`, `--popover-foreground: oklch(0.145 0 0)`, `--secondary-foreground: oklch(0.205 0 0)`, `--accent-foreground: oklch(0.205 0 0)`, `--destructive-foreground: oklch(0.577 0.245 27.325)`
  - `.dark`: `--popover: oklch(0.205 0 0)`, `--popover-foreground: oklch(0.922 0 0)`, `--secondary-foreground: oklch(0.922 0 0)`, `--accent-foreground: oklch(0.922 0 0)`, `--destructive-foreground: oklch(0.577 0.245 27.325)`
  - All 8 sidebar tokens in both modes (see `~/code/agent-co/components/styles/theme-vars.css` for exact values)
  - `--sidebar-ring`: `oklch(0.708 0 0)` (light) / `oklch(0.556 0 0)` (dark)

- **`src/app/admin/(dashboard)/layout.tsx`** — Remove hardcoded `dark` class. Add inline theme script placed BEFORE any visible content to prevent FOUC. The script reads `localStorage('ap-theme')`, falls back to `matchMedia('(prefers-color-scheme:dark)')`.

- **`src/components/ui/theme-toggle.tsx`** (new) — System/Light/Dark toggle for sidebar footer. Stores preference in `localStorage('ap-theme')`. Also registers a `matchMedia` change listener so "System" mode reacts to live OS theme changes.

### Research Insights (Phase 1)

**Landing page exclusion:** The landing page (`/`) is a hardcoded dark marketing page. The theme system must NOT affect it. Apply theme classes only to the admin layout (`/admin/*`), not the root layout.

**Audit existing components:** Several components may have hardcoded dark-mode colors (e.g., `bg-zinc-700`, `bg-zinc-900`) instead of using CSS custom properties. Phase 1 must audit all `src/components/ui/*.tsx` files and replace hardcoded colors with token-based classes.

**Acceptance Criteria:**
- [ ] Light mode renders correctly with AgentCo's exact light tokens
- [ ] Dark mode renders correctly with AgentCo's exact dark tokens
- [ ] System preference detection works (no FOUC)
- [ ] Theme persists across page reloads
- [ ] Live system theme changes reflected when "System" is selected
- [ ] All existing components render correctly in both modes (no hardcoded dark colors)
- [ ] `--radius: 0.625rem` matches AgentCo's border-radius
- [ ] `@theme inline` bridge block enables all Tailwind utility classes
- [ ] Landing page (`/`) remains dark regardless of theme setting
- [ ] All popover, foreground variant, and sidebar tokens present

#### Phase 2: Sidebar Redesign — Tenant Switcher + Collapsible

**Goal:** Replace flat sidebar with AgentCo-style sidebar: tenant switcher at top, collapsible to icon-only mode, user menu at bottom.

**Files:**

- **`src/app/admin/(dashboard)/sidebar-nav.tsx`** -> **`src/components/layout/sidebar.tsx`** (rewrite) — New sidebar component matching AgentCo:
  - Tenant switcher at top (`TenantSwitcher` component)
  - Nav items: Dashboard, Agents, Connectors, Plugins, Runs
  - Settings link near bottom
  - User menu at bottom with theme toggle + logout
  - Collapsible: 16rem expanded -> 3rem icon-only (state in cookie)

- **`src/components/layout/tenant-switcher.tsx`** (new) — Port of AgentCo's `CompanySwitcher`:
  - Dropdown with search, color avatars (same 8-color palette: `#635bff`, `#171717`, `#5e6ad2`, `#0ea5e9`, `#f97316`, `#10b981`, `#ec4899`, `#8b5cf6`)
  - Loads tenants from `/api/admin/tenants` (with `AbortController` cleanup on unmount)
  - **Selected tenant stored in cookie** (`ap-active-tenant`, HttpOnly=false, SameSite=Lax) — NOT localStorage, because server components need to read it via `cookies()` from `next/headers`
  - Check icon on active tenant
  - Trigger: colored avatar + tenant name + chevrons icon
  - **Collapsed mode:** Shows only colored avatar square (no name/chevron)
  - **Loading state:** Pulsing skeleton placeholder while tenants fetch
  - **"Create Tenant" action:** "+" button at bottom of dropdown list opens a create dialog (preserves tenant creation capability removed from Tenants page)
  - Dropdown: search input, scrollable list (max 240px), Esc to close
  - Calls `router.refresh()` after switching to re-run server components with new tenant context
  - **ARIA:** `role="listbox"`, `role="option"`, `aria-selected`, `aria-expanded`, `aria-haspopup="listbox"`, `aria-label`

- **`src/lib/active-tenant.ts`** (new) — Server-side tenant context utility:
  ```typescript
  import { cookies } from 'next/headers';
  export function getActiveTenantId(): string | null {
    return cookies().get('ap-active-tenant')?.value ?? null;
  }
  ```
  Server components call this to filter data by active tenant. When null, show all data (super admin view).

- **`src/components/layout/tenant-context.tsx`** (new) — Lightweight React context for client components. Reads cookie on mount, provides `activeTenantId` and `setActiveTenant()` (updates cookie + context + calls `router.refresh()`).

- **`src/app/admin/(dashboard)/layout.tsx`** — Update to use new sidebar component, update main content padding from `p-8` to `p-6`.

**Key design specs (matching AgentCo exactly):**
- Trigger height: `h-12`, padding: `px-4`
- Avatar: `w-5 h-5 rounded`, `text-[9px] font-bold text-white`
- Name: `text-[13px] font-semibold tracking-[-0.01em] truncate`
- Chevron: `ChevronsUpDownIcon`, `size-3.5`, `text-muted-foreground`
- Dropdown: `w-[240px]`, `rounded-lg`, `border border-border`, `shadow-lg`
- Search input: `text-[13px]`, with `SearchIcon` and `Esc` kbd hint
- List items: `px-3 py-2`, `text-[13px] font-medium`, `hover:bg-accent`

### Research Insights (Phase 2)

**Sidebar collapse specs (from AgentCo):**
- Expanded: `SIDEBAR_WIDTH = 16rem` (256px)
- Collapsed: `SIDEBAR_WIDTH_ICON = 3rem` (48px)
- Mobile: `SIDEBAR_WIDTH_MOBILE = 18rem` (288px, overlay/drawer)
- Cookie: `sidebar_state` (AgentCo name — use `ap-sidebar-state` for AgentPlane)
- Keyboard shortcut: `b` to toggle
- **Read cookie server-side** in `layout.tsx` to set initial width class — avoids layout shift on load
- **Main content `margin-left`** must transition smoothly alongside sidebar width change (200ms)

**Collapsed nav UX:**
- Nav items show only icons (no labels) with tooltips on hover
- User menu shows only avatar circle
- Collapse toggle: chevron button at bottom of sidebar or on sidebar border

**Mobile behavior:**
- Below `md` breakpoint, sidebar becomes an overlay drawer with backdrop
- Hamburger menu button in top bar to open/close

**Acceptance Criteria:**
- [ ] Tenant switcher shows all tenants with colored avatars
- [ ] Search filters tenants in real-time
- [ ] "Create Tenant" action at bottom of dropdown
- [ ] Selected tenant stored in cookie (readable by server components)
- [ ] `router.refresh()` called on tenant switch
- [ ] Loading skeleton shown while tenants fetch
- [ ] Sidebar collapses to icon-only mode (3rem)
- [ ] Collapse state persists in cookie, read server-side (no layout shift)
- [ ] Nav tooltips visible in collapsed mode
- [ ] Keyboard shortcut `b` toggles sidebar
- [ ] Mobile: sidebar is overlay drawer with backdrop
- [ ] ARIA attributes on tenant switcher (listbox, option, aria-selected)
- [ ] Nav items match AgentCo icon style (Lucide, `size-4`)
- [ ] Active nav item has `bg-sidebar-accent text-sidebar-accent-foreground`

#### Phase 3: Settings Page — Replace Tenants

**Goal:** Remove standalone Tenants list page. Add Settings page with tenant details, API keys.

**Files:**

- **`src/app/admin/(dashboard)/settings/page.tsx`** (new) — Settings page (server component, reads `getActiveTenantId()`):
  - **Tenant Details section:** Single-column card layout matching AgentCo's settings pattern
    - Name: text input (editable)
    - Slug: text input (**read-only** — used in A2A URLs, changing breaks permanent links)
    - Timezone: dropdown of IANA timezone names (reuse existing `TimezoneSchema` validation)
    - Monthly Budget: currency input with `$` prefix
    - Status: badge (read-only)
    - **Save button** at bottom of section (not auto-save — explicit save with loading state)
  - **API Keys section:** Table with columns: Name, Prefix, Created, Last Used, Actions
    - Create: button opens dialog, shows one-time-visible key value with copy button
    - Revoke: uses existing `confirm-dialog.tsx` for destructive action confirmation
  - **Danger Zone section:** Delete tenant button with confirmation dialog
  - Subscribes to tenant context — reactively updates when tenant is switched

- **`src/app/admin/(dashboard)/tenants/`** — Delete entire directory (list page + detail page + add form)

- **`next.config.ts`** — Add redirect: `/admin/tenants/:path*` -> `/admin/settings`

- **Update hardcoded links** in these files:
  - `src/app/admin/(dashboard)/agents/page.tsx` line 90 — tenant name link
  - `src/app/admin/(dashboard)/agents/[agentId]/page.tsx` line 62 — "Tenant:" label link
  - `src/app/admin/(dashboard)/runs/page.tsx` line 114 — tenant name in runs list
  - Change all to use tenant switcher (set active tenant + navigate) instead of linking to tenant detail page

- **`src/components/layout/sidebar.tsx`** — Nav items:
  ```
  Dashboard    (LayoutDashboard)
  Agents       (Bot)
  Connectors   (Plug)
  Plugins      (Store)
  Runs         (Play)
  ─────────────
  Settings     (Settings)
  ```

**Acceptance Criteria:**
- [ ] Settings page shows current tenant details (from switcher cookie, server-side)
- [ ] Tenant details are editable (name, timezone, budget) with explicit Save button
- [ ] Slug field is read-only (displayed but not editable)
- [ ] API keys section shows all keys with create/revoke
- [ ] New API key shown one-time in modal with copy button
- [ ] Revoke key uses confirmation dialog
- [ ] Delete tenant uses confirmation dialog (danger zone)
- [ ] Settings page reactively updates when tenant is switched
- [ ] Tenants page is removed — `/admin/tenants/*` redirects to `/admin/settings` via next.config.ts
- [ ] All hardcoded `/admin/tenants/` links updated (agents list, agent detail, runs list)
- [ ] Settings nav item is active when on `/admin/settings`

#### Phase 4: Component Polish — Match AgentCo Styling

**Goal:** Update UI primitives to match AgentCo's exact component styling.

**Files:**

- **`src/components/ui/button.tsx`** — Rewrite with CVA (class-variance-authority) matching AgentCo:
  - Base: `inline-flex shrink-0 items-center justify-center gap-2 rounded-md text-sm font-medium whitespace-nowrap transition-all outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50`
  - Variants: `default`, `destructive`, `destructive-outline`, `success`, `outline` (`border bg-background shadow-xs hover:bg-accent`), `secondary`, `ghost`, `link`
  - Sizes: default (`h-9 px-4 py-2`), xs (`h-6 gap-1 px-2 text-xs`), sm (`h-8 gap-1.5 px-3`), lg (`h-10 px-6`), icon (`size-9`), icon-xs (`size-6`), icon-sm (`size-8`), icon-lg (`size-10`)
  - Use Radix Slot (`asChild` pattern) for polymorphic rendering

- **`src/components/ui/badge.tsx`** — Rewrite with CVA matching AgentCo:
  - Base: `inline-flex items-center justify-center rounded-full border border-transparent px-2.5 py-0.5 text-xs font-medium w-fit whitespace-nowrap shrink-0 gap-1 [&>svg]:size-3`
  - Variants: `default` (gray), `secondary`, `destructive`, `outline`, `ghost`, `success` (green), `warning` (yellow), `danger` (red), `info` (blue), `purple`

- **`src/components/ui/card.tsx`** — Match AgentCo:
  - Card: `bg-card text-card-foreground flex flex-col gap-6 rounded-xl border py-6 shadow-sm`
  - CardHeader: `@container/card-header grid auto-rows-min items-start gap-2 px-6`
  - CardTitle: `leading-none font-semibold`
  - CardDescription: `text-muted-foreground text-sm`
  - CardContent: `px-6`
  - CardFooter: `flex items-center px-6`

- **`src/components/ui/input.tsx`** — Match AgentCo:
  - Base: `h-9 w-full min-w-0 rounded-md border border-input bg-transparent px-3 py-1 text-base shadow-xs transition-[color,box-shadow] outline-none`
  - Focus: `focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50`
  - Invalid: `aria-invalid:border-destructive aria-invalid:ring-destructive/20`
  - Dark: `dark:bg-input/30`
  - Responsive text: `text-base md:text-sm`

- **`src/components/ui/select.tsx`** — Same focus/invalid pattern as input

- **`src/components/ui/admin-table.tsx`** — Row hover: `hover:bg-accent` transition

### Research Insights (Phase 4)

**CVA dependency:** AgentCo uses `class-variance-authority` for all variant components. Add this as a dependency (`npm i class-variance-authority`). Also add `@radix-ui/react-slot` for the `asChild` pattern.

**Typography conventions (from AgentCo):** `text-[13px]` for sidebar/dropdown items, `text-[11px]` for timestamps, `text-[9px]` for avatar initials, `tracking-[-0.01em]` for sidebar names.

**Transition convention:** `transition-colors` on all interactive elements, `transition-all` on buttons, `transition-[color,box-shadow]` on inputs.

**Acceptance Criteria:**
- [ ] Buttons use CVA with all AgentCo variants and sizes
- [ ] Badges are rounded-full with all color variants
- [ ] Cards use `rounded-xl`, `shadow-sm`, `gap-6` spacing
- [ ] Inputs have 3px focus ring, `aria-invalid` styling, `dark:bg-input/30`
- [ ] `class-variance-authority` and `@radix-ui/react-slot` installed
- [ ] Responsive text sizes (`text-base md:text-sm`) on inputs
- [ ] Overall visual feel matches AgentCo in both light and dark modes

## System-Wide Impact

### Interaction Graph
- Theme change affects every page and component simultaneously
- Tenant switcher selection changes the admin context — all data queries filter by active tenant
- Settings page replaces Tenants — all internal links to `/admin/tenants/` must redirect

### State Lifecycle Risks
- Theme flash (FOUC) if script doesn't run before paint — mitigated by inline script placed before visible content in layout body
- Tenant switcher + existing RLS: admin routes don't use tenant RLS (they use `ADMIN_API_KEY`), so switcher is UI-only filtering, not security boundary
- Cookie-based sidebar collapse state could desync if cookies are cleared — graceful fallback to expanded
- Hydration mismatch risk: theme and tenant cookie must be read consistently between server and client render — use cookies (not localStorage) as canonical source

### API Surface Parity
- No API changes — tenant switcher reads from existing `/api/admin/tenants` endpoint
- Settings page writes to existing `/api/admin/tenants/:id` PATCH endpoint
- API keys use existing `/api/admin/tenants/:id/keys` endpoints

## Acceptance Criteria

### Functional Requirements
- [ ] Light mode, dark mode, and system preference all work correctly
- [ ] Tenant switcher in sidebar shows all tenants with search
- [ ] Selected tenant context persists across navigation
- [ ] Settings page shows tenant details + API keys
- [ ] Tenants nav item removed, Settings added
- [ ] Sidebar collapses to icon-only mode
- [ ] All existing pages render correctly with new design tokens

### Non-Functional Requirements
- [ ] No FOUC on theme load
- [ ] Sidebar collapse animation is smooth (200ms transition)
- [ ] Dropdown opens in <100ms

### Quality Gates
- [ ] All pages tested in both light and dark mode
- [ ] Mobile/responsive behavior maintained
- [ ] No regressions in existing functionality

## Dependencies & Prerequisites

- AgentCo design tokens (captured from `~/code/agent-co/components/styles/theme-vars.css`)
- AgentCo CompanySwitcher pattern (captured from `~/code/agent-co/components/layout/CompanySwitcher.tsx`)
- Lucide React icons (already installed)
- `class-variance-authority` — npm package for variant component definitions (new dependency)
- `@radix-ui/react-slot` — npm package for polymorphic `asChild` pattern (new dependency)

## Risk Analysis & Mitigation

| Risk | Impact | Mitigation |
|---|---|---|
| FOUC on theme switch | Medium | Inline script in head, same pattern as AgentCo |
| Existing dark-mode-only assumptions in components | High | Phase 1 audits all components for hardcoded dark colors |
| Tenant switcher without RLS context | Low | Admin routes already use ADMIN_API_KEY, not tenant-scoped auth |
| Bookmark/link breakage for /admin/tenants/ | Medium | Add redirect from old URLs to /admin/settings |

## Sources & References

### Internal References
- AgentCo theme tokens: `~/code/agent-co/components/styles/theme-vars.css`
- AgentCo CompanySwitcher: `~/code/agent-co/components/layout/CompanySwitcher.tsx`
- AgentCo sidebar: `~/code/agent-co/app/(dashboard)/layout.tsx`
- Current admin layout: `src/app/admin/(dashboard)/layout.tsx`
- Current sidebar: `src/app/admin/(dashboard)/sidebar-nav.tsx`
- Current globals: `src/app/globals.css`
- Current tenants pages: `src/app/admin/(dashboard)/tenants/`
