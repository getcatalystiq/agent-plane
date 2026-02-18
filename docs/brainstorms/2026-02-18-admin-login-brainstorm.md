# Admin Login System

**Date:** 2026-02-18
**Status:** Brainstorm

## What We're Building

Replace the current admin login (entering the raw `ADMIN_API_KEY` as a password) with a proper email/password authentication system with individual admin user accounts.

**Current state:** A single shared API key is used as the admin password. The login page says "Admin API key." There's no individual accountability, it's hard to share/revoke access, and it looks unprofessional.

**Target state:** Each admin has their own email + password. Existing admins can create new admin accounts from the UI. Admins can change their own password. Designed for a small team (2-5 people).

## Why This Approach

- **Individual accounts** solve accountability — know who did what, revoke one person without affecting others
- **DB-backed users** scale with the team without redeploying (no env var changes)
- **Admin-creates-admin** keeps it simple — no email service, no invite links, credentials shared directly
- **Self-service password change** reduces admin burden
- **Reuse existing HMAC session cookies** — the session mechanism is already solid, just swap the credential verification

## Key Decisions

1. **Auth method:** Email + password (no OAuth, no magic links)
2. **User storage:** New `admin_users` table in existing Neon Postgres DB
3. **Permission model:** All admins have full access (no roles for now)
4. **User creation:** Existing admins create new admins via the admin UI (set email + initial password)
5. **Bootstrapping:** First admin created via CLI script (`npm run create-admin` or similar)
6. **Password management:** Admins can change their own password from the UI
7. **No invite emails:** Credentials are shared directly between admins (out-of-band)
8. **Session mechanism:** Keep existing HMAC-signed cookie approach (7-day sessions), derive signing key from `ENCRYPTION_KEY`
9. **Remove `ADMIN_API_KEY`:** No longer needed — sessions signed with `ENCRYPTION_KEY`, login verified against per-user password hash
10. **Admin API auth:** Cookie-only (no Bearer token support for admin routes)

## Scope

### In scope
- `admin_users` DB table + migration
- Password hashing (bcrypt)
- Updated login page (email + password fields)
- Admin user management page in the UI (list, create, delete admins — cannot delete the last admin)
- Self-service password change page/modal
- CLI script to bootstrap the first admin
- Session cookie now tied to individual user (include user ID in token payload)
- Update middleware to work with new auth

### Out of scope (for now)
- Role-based permissions / granular access control
- Email invite flow
- Password reset via email
- OAuth / SSO
- Audit logging of who did what
- Two-factor authentication

## Migration Strategy

Removing `ADMIN_API_KEY` is a breaking change. The rollout needs to handle:

1. **Bootstrapping:** The migration or deploy process must create the first admin user — otherwise no one can log in after the switch. The CLI script (`npm run create-admin`) runs as part of the deploy, or the first deploy keeps `ADMIN_API_KEY` as a fallback.
2. **Env var removal:** `ADMIN_API_KEY` is currently required in the Zod env schema. Make it optional first, then remove it once the new auth is stable.
3. **Session continuity:** Existing sessions are signed with a key derived from `ADMIN_API_KEY`. Switching to `ENCRYPTION_KEY` as the signing key will invalidate all current sessions — admins will need to log in again. This is acceptable for a small team.

**Simplest path:** Deploy the new code with `ADMIN_API_KEY` made optional. Run `npm run create-admin` to create the first admin. Remove `ADMIN_API_KEY` from the environment once confirmed working.

## Resolved Questions

1. **What happens to `ADMIN_API_KEY`?** Remove it entirely. Derive session signing key from `ENCRYPTION_KEY` instead — one less env var to manage.
2. **Should admin API routes (`/api/admin/*`) also accept Bearer token auth?** No. Cookie-based UI auth only — no programmatic access needed for admin routes.
