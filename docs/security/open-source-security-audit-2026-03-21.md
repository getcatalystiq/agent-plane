# Security Audit Report -- Open Source Readiness

**Date:** 2026-03-21
**Scope:** Full repository at `/Users/marmarko/code/agent-plane`
**Purpose:** Pre-open-source security review

---

## Executive Summary

The codebase demonstrates strong security practices overall. No hardcoded secrets or leaked credentials were found. Authentication is properly implemented with timing-safe comparisons, parameterized SQL queries, SSRF protection on OAuth flows, and solid error sanitization. There are **7 vulnerabilities in dependencies** that need updating, plus a few medium-severity issues to address before open source release.

**Overall risk: LOW-MEDIUM** -- The architecture is well-defended. Findings below are prioritized by severity.

---

## 1. Leaked Secrets and Credentials

### Status: PASS

- **No hardcoded API keys, tokens, passwords, or secrets** found in source code.
- `.env.local` is present locally but properly gitignored.
- `.env.example` contains only placeholder values (e.g., `"your-ai-gateway-api-key"`).
- `.gitignore` covers `.env`, `.env.local`, `.env.production`, `.env*.local`, `*.pem`.
- Test fixtures use obviously fake keys like `ap_live_test1234567890abcdef12345678` -- acceptable.
- `sdk/tests/resources/connectors.test.ts` uses `api_key: "ghp_abc123"` -- fake, acceptable.

### Recommendation
- Add `*.key`, `*.p12`, `*.pfx`, `credentials.json` to `.gitignore` for defense-in-depth.

---

## 2. Authentication and Authorization

### Status: PASS (with notes)

**API Key Authentication (`src/lib/auth.ts`)**
- Uses SHA-256 hashing of API keys, looked up via parameterized query. Good.
- Timing-safe comparison for admin key. Good.
- Revocation and expiry checks in place. Good.
- A2A auth uses single-query JOIN (slug + key hash) to prevent tenant enumeration via timing. Good.

**Admin Authentication (`src/lib/admin-auth.ts`)**
- HMAC-SHA256 signed session tokens with expiry. Good.
- Cookies are `httpOnly`, `secure` in production, `sameSite: lax`. Good.
- Session key derived from `ADMIN_API_KEY` via SHA-256 -- acceptable but means rotating the admin key invalidates all sessions (which is arguably correct behavior).

**Middleware (`src/middleware.ts`)**
- Properly gates all routes. Public paths are explicitly listed.
- O(1) prefix validation before DB lookup. Good.

**MEDIUM -- `ap_admin_` prefix accepted in middleware but not in `authenticateApiKey()`**
- `src/middleware.ts` line 98 allows `ap_admin_` prefix tokens through middleware, but `authenticateApiKey()` in `auth.ts` line 28 only accepts `ap_live_` and `ap_test_`. This means `ap_admin_` tokens pass middleware but fail at the route handler. This is a dead code path but should be cleaned up to avoid confusion.

**Unauthenticated Endpoints Review:**
- `/api/health` -- intentionally public. OK.
- `/api/cron/*` -- protected by `CRON_SECRET` verification via `verifyCronSecret()`. Good.
- `/api/internal/*` -- uses HMAC-based run tokens (`verifyRunToken`). Good.
- A2A Agent Cards (`/.well-known/agent-card.json`) -- intentionally public, rate-limited. OK.
- OAuth callbacks -- intentionally unauthenticated (external redirects). State tokens are HMAC-signed with expiry. Good.

---

## 3. SQL Injection

### Status: PASS

**Parameterized queries throughout.** All `query()`, `queryOne()`, and `execute()` calls use `$1, $2, ...` placeholders.

**Neon tagged template queries** in `src/lib/a2a.ts` and A2A routes use the Neon HTTP driver's tagged template syntax which auto-parameterizes. This is safe.

**Dynamic column names** in `transitionRunStatus()` and `transitionSessionStatus()` use `ALLOWED_COLUMNS` allowlists to prevent injection via column names. Good.

**Dynamic WHERE clauses** in admin routes (`src/app/api/admin/runs/route.ts`, `src/app/api/admin/sessions/route.ts`) build conditions with parameterized `$N` indices. Values from user input (query params) are always passed as parameters, never interpolated. Safe.

---

## 4. XSS Vulnerabilities

### Status: PASS (with one note)

**Static inline script** is used once in `src/app/admin/(dashboard)/layout.tsx` for a hardcoded theme-init script. The content is a static string literal with no user input. Safe.

**ReactMarkdown** is used in transcript viewer and playground. `react-markdown` by default does NOT render raw HTML -- it escapes it. No `rehype-raw` plugin is configured, so HTML in markdown is stripped. Safe.

**LOW -- DOMPurify is listed as a dependency but not imported anywhere in `src/`.** It is declared in `package.json` but appears unused in the actual application code. This is a dead dependency that should be removed (and it has a known moderate XSS vulnerability per `npm audit`).

---

## 5. Command Injection

### Status: PASS

Sandbox execution uses the Vercel Sandbox API (`sandbox.runCommand`) with structured `cmd` and `args` arrays -- no shell interpolation. Runner scripts are generated via `JSON.stringify()` for all dynamic values (prompts, config), which prevents injection through template literals. The `execSync` calls in runner code are inside the sandbox (isolated environment), not on the host.

---

## 6. Path Traversal

### Status: PASS

**Plugin filenames** are validated via `SafePluginFilename` Zod schema: `^[a-zA-Z0-9_-]+\.[a-zA-Z0-9]+$` -- no dots, slashes, or path separators allowed. Plugin files are written to fixed paths inside the sandbox (`.claude/skills/`, `.claude/agents/`). No user-controlled path construction on the host filesystem.

---

## 7. Cryptography

### Status: PASS

- **AES-256-GCM** with random 12-byte IVs for encryption at rest. Good.
- **HMAC-SHA256** for session tokens, run tokens, and OAuth state. Good.
- **SHA-256** for API key hashing. Good.
- **Timing-safe comparison** implemented correctly with length-independent XOR. Good.
- **PKCE** with S256 challenge method for OAuth 2.1 flows. Good.
- **Base62 encoding** with rejection sampling to avoid modular bias. Good.
- Key rotation supported via `ENCRYPTION_KEY_PREVIOUS` fallback in decryption. Good.

---

## 8. SSRF Protection

### Status: PASS

`src/lib/mcp-oauth.ts` implements `safeFetch()` with DNS resolution and private IP range blocking (loopback, RFC 1918, link-local, IPv6 ULA/loopback). All outbound MCP OAuth calls go through `safeFetch()`. Origin validation ensures OAuth metadata URLs share the same base domain as the MCP server URL.

---

## 9. Error Handling and Data Exposure

### Status: PASS

- `withErrorHandler()` catches all errors; unhandled errors return generic `"Internal server error"` without leaking stack traces or SQL details.
- `AppError` subclasses expose only `code` and `message`.
- A2A `RunBackedTaskStore.save()` explicitly catches errors and throws sanitized `A2AError.internalError()`.
- Logger outputs to structured JSON; no credentials logged (confirmed by reviewing log call sites).
- `sanitizeComposioError()` strips internal details from Composio API errors.

---

## 10. Security Headers

### Status: PASS (with one recommendation)

Configured in `next.config.ts`:
- `Strict-Transport-Security: max-age=63072000; includeSubDomains; preload` -- Good.
- `X-Content-Type-Options: nosniff` -- Good.
- `X-Frame-Options: DENY` -- Good.
- `Referrer-Policy: strict-origin-when-cross-origin` -- Good.

**LOW -- Missing `Content-Security-Policy` header.** While the admin UI is internal-facing and React-based (inherently resistant to XSS), adding a CSP would provide defense-in-depth.

**LOW -- Missing `Permissions-Policy` header.** Consider adding `Permissions-Policy: camera=(), microphone=(), geolocation=()` to restrict browser APIs.

---

## 11. Dependencies

### Status: ACTION REQUIRED

`npm audit` reports **7 vulnerabilities (3 moderate, 4 high)**:

| Package | Severity | Issue | Fix |
|---------|----------|-------|-----|
| **dompurify** | Moderate | XSS vulnerability (GHSA-v2wj-7wpq-c8vv) | Remove (unused) or update |
| **ajv** | Moderate | ReDoS with `$data` option (GHSA-2g4f-4pwh-qvx6) | `npm audit fix` |
| **rollup** | High | Arbitrary file write via path traversal (GHSA-mw96-cpmx-2vgc) | `npm audit fix` |
| **undici** (x4) | High | HTTP smuggling, WebSocket DoS, CRLF injection, memory exhaustion | `npm audit fix` |

**Priority:** Run `npm audit fix` before release. Remove `dompurify` and `@types/dompurify` from `package.json` since they are unused.

---

## 12. Open Source Readiness

### Status: PASS (with cleanup items)

**No internal URLs or company secrets in source code.** The following references exist only in docs (not source):
- `hello@catalystiq.com` in `CODE_OF_CONDUCT.md` -- intentional contact email for CoC reports. OK.
- `agentplane.com` / `agentco.com` references in `docs/research/oauth-popup-best-practices.md` -- research doc with example domains. Consider replacing with `example.com` for clarity.
- `agent-plane.vercel.app` in `docs/plans/` -- planning docs with example URLs. Acceptable.
- `your-deployment.vercel.app` in SDK/UI README -- parameterized examples. Good.

**`@getcatalystiq/agent-plane`** npm package name in SDK -- this is the public package name, intentional.

**No test fixtures with real data.** Test keys are obviously fake.

---

## Risk Matrix

| # | Finding | Severity | Category | Status |
|---|---------|----------|----------|--------|
| 1 | Vulnerable dependencies (undici, rollup) | **HIGH** | Dependencies | Fix with `npm audit fix` |
| 2 | Unused `dompurify` dep with known XSS vuln | **MEDIUM** | Dependencies | Remove from package.json |
| 3 | `ap_admin_` prefix dead code in middleware | **LOW** | Auth | Clean up |
| 4 | Missing Content-Security-Policy header | **LOW** | Headers | Add CSP |
| 5 | Missing Permissions-Policy header | **LOW** | Headers | Add header |
| 6 | Docs contain example domain references | **INFO** | Open Source | Optional cleanup |
| 7 | `localhost:3000` fallback in mcp-connections.ts | **INFO** | Config | Expected for dev |

---

## Remediation Roadmap

### Before Open Source Release (Required)

1. **Run `npm audit fix`** to resolve undici and rollup vulnerabilities.
2. **Remove `dompurify`** from `package.json` (unused dependency with known vuln):
   ```
   npm uninstall dompurify @types/dompurify
   ```
3. **Remove `ap_admin_` prefix** from middleware line 98 (dead code).

### Recommended Improvements

4. Add `Content-Security-Policy` and `Permissions-Policy` headers in `next.config.ts`.
5. Add `*.key`, `*.p12`, `*.pfx`, `credentials.json` to `.gitignore`.
6. Replace domain-specific references in research docs with `example.com`.

---

## Security Requirements Checklist

- [x] All inputs validated and sanitized (Zod schemas throughout)
- [x] No hardcoded secrets or credentials
- [x] Proper authentication on all endpoints
- [x] SQL queries use parameterization
- [x] XSS protection implemented (React escaping, no rehype-raw)
- [x] HTTPS enforced (HSTS header, OAuth URL validation)
- [x] CSRF protection (SameSite cookies, Bearer token auth)
- [x] Security headers configured (HSTS, X-Content-Type-Options, X-Frame-Options, Referrer-Policy)
- [x] Error messages don't leak sensitive information
- [ ] Dependencies up-to-date and vulnerability-free (7 vulns to fix)
- [ ] Content-Security-Policy header (missing)
