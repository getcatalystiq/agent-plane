---
title: "feat: Cloudflare Agent Infrastructure for Multi-Tenant Agent Hosting"
type: feat
date: 2026-02-01
status: draft
priority: high
estimated_tenants: 10-50
---

# Cloudflare Agent Infrastructure

## Design Principles

**Build for 10-50 tenants. Add complexity when real problems emerge.**

### Security (Critical Priority)
- **P0**: Plugin code injection risk - pin to commit SHAs, implement allowlisting
- **P0**: MCP domains - simple allowlist per tenant (no DNS rebinding protection needed at this scale)
- **P0**: Tenant isolation - verify Sandbox SDK isolation

### Simplicity Decisions
- **No warm pool** - keep all active tenant sandboxes warm, revisit at 100+ tenants
- **No distributed locking** - KV eventual consistency is fine for 10-50 tenants
- **No GitHub webhooks** - 5-min TTL cache is sufficient
- **No platform MCP tools** - add when tenants request agent introspection
- **No mTLS** - service tokens are sufficient until enterprise requests it
- **API keys only** - defer OAuth token management until tenants need HubSpot/Slack

### SDK Documentation Findings
- Claude Agent SDK v0.1.27: Use `setting_sources` to load skills, `systemPrompt.append` for tenant instructions
- Cloudflare Sandbox: R2 mounting is read-write, multiple processes supported, ~200ms cold starts achievable

---

## Overview

Build production-ready infrastructure on Cloudflare to host Claude Agent SDK instances for a multi-tenant SaaS platform. Each tenant gets an isolated Sandbox container running Claude agents with injected skills and MCP connectors, authenticated via OAuth2 client credentials.

**Scope Exclusions:** Browser Rendering, Admin/Control UI (API-only)

## Problem Statement

We need a scalable, secure way to run AI agents for multiple customers without managing traditional infrastructure. Each tenant requires:

- Isolated execution environment for their agents
- Ability to inject custom skills and MCP connectors
- OAuth2-based programmatic access for their systems
- Persistent storage for session state and configuration
- Cost tracking and usage visibility per tenant

Cloudflare's edge infrastructure provides the primitives (Workers, Sandbox, R2, AI Gateway) but we need to compose them into a coherent multi-tenant platform.

## Proposed Solution

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────┐
│                    Cloudflare Zero Trust                         │
│         (Service Tokens, Access Policies, JWT Validation)        │
└─────────────────────────┬───────────────────────────────────────┘
                          │
                    ┌─────▼─────┐
                    │  Dispatch │
                    │  Worker   │
                    └─────┬─────┘
                          │
    ┌─────────────────────┼─────────────────────┐
    │                     │                     │
┌───▼───────┐      ┌──────▼──────┐       ┌──────▼──────┐
│ Sandbox A │      │  Sandbox B  │       │  Sandbox N  │
│ (Claude   │      │  (Claude    │       │  (Claude    │
│ Agent SDK)│      │  Agent SDK) │       │  Agent SDK) │
├───────────┤      ├─────────────┤       ├─────────────┤
│ MCP local │      │  MCP local  │       │  MCP local  │
│ R2 mount  │      │  R2 mount   │       │  R2 mount   │
└─────┬─────┘      └──────┬──────┘       └──────┬──────┘
      │                   │                     │
      ├───────────────────┼─────────────────────┤
      │                   │                     │
      ▼                   ▼                     ▼
┌───────────┐      ┌─────────────┐       ┌───────────┐
│ AI Gateway│      │ HTTP MCP    │       │ R2 Bucket │
│ →Anthropic│      │ Servers     │       │ (per-tenant)│
└───────────┘      └─────────────┘       └───────────┘
```

### Component Responsibilities

| Component | Purpose | Cloudflare Service |
|-----------|---------|-------------------|
| Zero Trust | Auth, service tokens, JWT validation | Zero Trust + Access |
| Dispatch Worker | Validate tenant, route to sandbox | Workers |
| Sandbox | Isolated Claude Agent SDK + MCP execution | Sandbox SDK |
| Tenant Storage | Session state, conversation history, assets | R2 (per-tenant bucket) |
| AI Gateway | Proxy to Anthropic/Bedrock (manages credentials), analytics | AI Gateway |

## Technical Approach

### Phase 1: Foundation (Core Infrastructure)

#### 1.1 Project Setup

```
agentplane/
├── wrangler.toml                 # Main deployment config
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                  # Dispatch Worker (main entry)
│   └── lib/
│       ├── auth.ts               # Zero Trust JWT validation
│       ├── sandbox.ts            # Sandbox lifecycle + SDK injection
│       ├── plugins.ts            # Plugin extraction from GitHub
│       ├── github.ts             # GitHub API helpers
│       ├── config.ts             # Tenant config loading
│       └── types.ts
├── config/
│   └── tenants/                  # Per-tenant config files
│       ├── acme-corp.yaml
│       └── other-tenant.yaml
├── container/                    # Sandbox container definition
│   ├── Dockerfile
│   └── entrypoint.sh
└── scripts/
    ├── provision-tenant.ts       # Tenant provisioning
    └── deploy.ts                 # Deployment automation
```

**Plugin flow:**
```
GitHub Repos → Worker extracts via API → R2 cache → Inject into Sandbox → Claude Agent SDK
```

#### 1.2 Zero Trust Configuration

**Service Token per Tenant:**

Each tenant gets a Cloudflare Access Service Token. This replaces custom OAuth2 implementation.

```bash
# Create service token for a tenant via API
curl -X POST "https://api.cloudflare.com/client/v4/accounts/${CF_ACCOUNT_ID}/access/service_tokens" \
  -H "Authorization: Bearer ${CF_API_TOKEN}" \
  -H "Content-Type: application/json" \
  --data '{
    "name": "tenant-acme-corp",
    "duration": "8760h"
  }'

# Response includes client_id and client_secret (shown only once)
```

**Access Application Configuration:**

```typescript
// scripts/setup-zero-trust.ts
interface AccessApplication {
  name: string;
  domain: string;
  type: 'self_hosted';
  session_duration: string;
  policies: AccessPolicy[];
}

interface AccessPolicy {
  name: string;
  decision: 'allow';
  include: PolicyRule[];
}

// Create Access Application for the API
const application: AccessApplication = {
  name: 'AgentPlane API',
  domain: 'api.agentplane.io',
  type: 'self_hosted',
  session_duration: '24h',
  policies: [
    {
      name: 'Service Token Access',
      decision: 'allow',
      include: [
        { service_token: {} }  // Allow any valid service token
      ]
    }
  ]
};
```

**JWT Validation in Workers:**

```typescript
// src/shared/auth.ts
import { jwtVerify, createRemoteJWKSet } from 'jose';

interface Env {
  CF_TEAM_DOMAIN: string;    // e.g., "myteam.cloudflareaccess.com"
  CF_POLICY_AUD: string;     // Access Application AUD tag
  TENANT_TOKENS: KVNamespace; // Maps service token client_id -> tenant_id
}

interface AccessJWTPayload {
  email?: string;
  sub: string;           // Service token client_id
  aud: string[];
  iat: number;
  exp: number;
  iss: string;
  custom?: {
    tenant_id?: string;
  };
}

// Code Quality: Use discriminated union for explicit error handling
type AuthResult =
  | { success: true; tenantId: string }
  | { success: false; reason: 'missing_token' | 'invalid_token' | 'expired' | 'unknown_service_token' };

// Performance: Cache JWKS at module level (don't fetch on every request)
let cachedJWKS: ReturnType<typeof createRemoteJWKSet> | null = null;

function getJWKS(teamDomain: string): ReturnType<typeof createRemoteJWKSet> {
  if (!cachedJWKS) {
    cachedJWKS = createRemoteJWKSet(
      new URL(`${teamDomain}/cdn-cgi/access/certs`)
    );
  }
  return cachedJWKS;
}

export async function validateRequestAndGetTenant(
  request: Request,
  env: Env
): Promise<AuthResult> {
  // Get JWT from header (set by Zero Trust)
  const token = request.headers.get('cf-access-jwt-assertion');
  if (!token) {
    return { success: false, reason: 'missing_token' };
  }

  try {
    // Verify against Cloudflare's JWKS (cached)
    const JWKS = getJWKS(env.CF_TEAM_DOMAIN);

    const { payload } = await jwtVerify(token, JWKS, {
      issuer: env.CF_TEAM_DOMAIN,
      audience: env.CF_POLICY_AUD,
    }) as { payload: AccessJWTPayload };

    // Map service token (sub) to tenant_id
    const tenantId = await env.TENANT_TOKENS.get(payload.sub);
    if (!tenantId) {
      console.error(`Unknown service token: ${payload.sub}`);
      return { success: false, reason: 'unknown_service_token' };
    }

    return { success: true, tenantId };
  } catch (error) {
    console.error('JWT validation failed:', error instanceof Error ? error.message : 'Unknown');
    return { success: false, reason: 'invalid_token' };
  }
}
```

**Client Usage (Tenant's Code):**

```typescript
// How tenants authenticate to the API
const response = await fetch('https://api.agentplane.io/v1/agent/query', {
  method: 'POST',
  headers: {
    'CF-Access-Client-Id': process.env.AGENTPLANE_CLIENT_ID,
    'CF-Access-Client-Secret': process.env.AGENTPLANE_CLIENT_SECRET,
    'Content-Type': 'application/json',
  },
  body: JSON.stringify({
    prompt: 'Analyze this codebase',
    skills: ['code-review'],
  }),
});

// Zero Trust validates credentials and injects JWT automatically
// Worker receives cf-access-jwt-assertion header
```

### Phase 2: Sandbox Integration (Agent Runtime)

#### 2.1 Container Dockerfile

```dockerfile
# container/Dockerfile
FROM node:20-slim

# Install Python for MCP servers
RUN apt-get update && apt-get install -y python3 python3-pip git && \
    rm -rf /var/lib/apt/lists/*

# Install Claude Agent SDK
RUN npm install -g @anthropic-ai/claude-code

# Install MCP SDK
RUN pip3 install mcp

# Create workspace
WORKDIR /workspace

# Copy entrypoint
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh

ENTRYPOINT ["/entrypoint.sh"]
```

#### 2.2 Dispatch Worker with Sandbox Management

```typescript
// src/index.ts - Main entry point (replaces separate dispatch + tenant workers)
import { getSandbox } from '@cloudflare/sandbox';
import { validateRequestAndGetTenant } from './lib/auth';
import { loadTenantConfig, loadGlobalConfig } from './lib/config';
import { configureMCPServers } from './lib/sandbox';

interface Env {
  Sandbox: DurableObjectNamespace;
  TENANT_KV: KVNamespace;
  TENANT_TOKENS: KVNamespace;
  CF_TEAM_DOMAIN: string;
  CF_POLICY_AUD: string;
  AI_GATEWAY_URL: string;  // Gateway handles API key
}

interface AgentRequest {
  prompt: string;
  sessionId?: string;
  skills?: string[];
  mcpServers?: Record<string, MCPServerConfig>;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const tenantId = request.headers.get('X-Tenant-ID')!;
    const url = new URL(request.url);

    // Route by endpoint
    switch (url.pathname) {
      case '/v1/agent/query':
        return handleAgentQuery(request, env, tenantId);
      case '/v1/agent/stream':
        return handleAgentStream(request, env, tenantId);
      case '/v1/sessions':
        return handleSessions(request, env, tenantId);
      default:
        return new Response('Not found', { status: 404 });
    }
  }
};

async function handleAgentQuery(
  request: Request,
  env: Env,
  tenantId: string
): Promise<Response> {
  const body: AgentRequest = await request.json();

  // Get or create sandbox for this tenant
  const sandbox = getSandbox(env.Sandbox, `tenant-${tenantId}`, {
    sleepAfter: '15m',
  });

  // Mount tenant's R2 bucket for persistence
  await sandbox.mountBucket(env.TENANT_BUCKET, '/workspace/data');

  // Point Claude SDK to AI Gateway (not api.anthropic.com)
  // AI Gateway handles: API key, billing, logging, caching
  await sandbox.setEnvVars({
    ANTHROPIC_BASE_URL: env.AI_GATEWAY_URL,  // SDK var name, but points to AI Gateway
    TENANT_ID: tenantId,
  });

  // Load tenant skills
  const skillsPath = '/workspace/skills';
  await loadTenantSkills(sandbox, tenantId, body.skills || []);

  // Run agent query
  const result = await runAgentInSandbox(sandbox, body);

  return Response.json(result);
}

async function runAgentInSandbox(sandbox: Sandbox, request: AgentRequest) {
  // Prepare MCP server configs
  const mcpConfig = request.mcpServers ?
    JSON.stringify(request.mcpServers) : '{}';

  // Execute claude-code in sandbox
  const result = await sandbox.exec('claude', [
    '--print',
    '--output-format', 'json',
    '--mcp-config', mcpConfig,
    request.prompt,
  ], {
    cwd: '/workspace',
    timeout: 300000, // 5 minutes max
  });

  return {
    output: result.stdout,
    exitCode: result.exitCode,
    sessionId: request.sessionId,
  };
}
```

### Phase 3: Plugin Extraction & SDK Injection

Tenants configure GitHub repos as plugin sources. The Worker extracts skills, commands, and MCP configs, then injects them into Claude Agent SDK.

> **⚠️ Security Note (P0)**: Dynamic plugin loading creates supply chain attack surface. Implement:
> 1. Pin plugins to specific commit SHAs, not branches
> 2. Code signing with trusted keys
> 3. Static analysis before deployment (Semgrep/CodeQL)
> 4. Plugin allowlisting per tenant

#### 3.1 Plugin Structure (Claude Cowork format)

```
plugin-repo/
├── .claude-plugin/
│   └── plugin.json           # Plugin manifest
├── .mcp.json                 # MCP server connections
├── commands/                 # Slash commands (user-invoked)
│   ├── call-prep.md
│   └── write-query.md
└── skills/                   # Skills (auto-triggered by context)
    ├── financial-reconciliation.md
    └── contract-review.md
```

#### 3.2 Plugin Extraction (in Worker, before sandbox)

Extract plugin contents from GitHub and cache in R2:

```typescript
// src/lib/plugins.ts
interface ExtractedPlugin {
  name: string;
  skills: Array<{ name: string; content: string }>;
  commands: Array<{ name: string; content: string }>;
  mcpServers: Record<string, MCPServerConfig>;
}

interface PluginBundle {
  skills: Array<{ name: string; content: string }>;
  commands: Array<{ name: string; content: string }>;
  mcpServers: Record<string, MCPServerConfig>;
}

async function extractPluginsFromGitHub(
  plugins: PluginSource[],
  cache: R2Bucket,
  secrets: KVNamespace,
  tenantId: string
): Promise<PluginBundle> {
  const bundle: PluginBundle = {
    skills: [],
    commands: [],
    mcpServers: {},
  };

  for (const plugin of plugins) {
    const extracted = await extractSinglePlugin(plugin, cache, secrets, tenantId);

    // Merge into bundle
    bundle.skills.push(...extracted.skills);
    bundle.commands.push(...extracted.commands);
    Object.assign(bundle.mcpServers, extracted.mcpServers);
  }

  return bundle;
}

async function extractSinglePlugin(
  plugin: PluginSource,
  cache: R2Bucket,
  secrets: KVNamespace,
  tenantId: string
): Promise<ExtractedPlugin> {
  const cacheKey = `plugins/${tenantId}/${hash(plugin)}.json`;

  // Check cache
  const cached = await cache.get(cacheKey);
  if (cached && !isStale(cached, 300)) { // 5 min TTL
    return JSON.parse(await cached.text());
  }

  // Fetch from GitHub API (no git clone needed)
  const token = plugin.github_token
    ? await secrets.get(plugin.github_token.replace('secret:', ''))
    : null;

  const basePath = plugin.path || '';
  const ref = plugin.ref || 'main';

  // Fetch plugin manifest
  const manifest = await fetchGitHubFile(plugin.repo, `${basePath}/.claude-plugin/plugin.json`, ref, token);

  // Fetch skills
  const skillFiles = await listGitHubDir(plugin.repo, `${basePath}/skills`, ref, token);
  const skills = await Promise.all(
    skillFiles
      .filter(f => f.endsWith('.md'))
      .map(async (file) => ({
        name: file.replace('.md', ''),
        content: await fetchGitHubFile(plugin.repo, `${basePath}/skills/${file}`, ref, token),
      }))
  );

  // Fetch commands
  const commandFiles = await listGitHubDir(plugin.repo, `${basePath}/commands`, ref, token);
  const commands = await Promise.all(
    commandFiles
      .filter(f => f.endsWith('.md'))
      .map(async (file) => ({
        name: file.replace('.md', ''),
        content: await fetchGitHubFile(plugin.repo, `${basePath}/commands/${file}`, ref, token),
      }))
  );

  // Fetch and resolve MCP config
  const mcpRaw = await fetchGitHubFile(plugin.repo, `${basePath}/.mcp.json`, ref, token);
  const mcpResolved = await resolveMcpSecrets(mcpRaw, plugin.env || {}, secrets);

  const extracted: ExtractedPlugin = {
    name: JSON.parse(manifest).name,
    skills,
    commands,
    mcpServers: JSON.parse(mcpResolved).mcpServers || {},
  };

  // Simple 5-min TTL cache - sufficient for 10-50 tenants
  await cache.put(cacheKey, JSON.stringify(extracted), {
    customMetadata: { extracted_at: Date.now().toString() },
  });

  return extracted;
}
```

#### 3.3 GitHub API Helpers

```typescript
// src/lib/github.ts
async function fetchGitHubFile(
  repo: string,
  path: string,
  ref: string,
  token: string | null
): Promise<string> {
  // repo: "https://github.com/owner/repo" -> "owner/repo"
  const repoPath = repo.replace('https://github.com/', '');

  const response = await fetch(
    `https://api.github.com/repos/${repoPath}/contents/${path}?ref=${ref}`,
    {
      headers: {
        'Accept': 'application/vnd.github.v3.raw',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
      },
    }
  );

  if (!response.ok) {
    if (response.status === 404) return '{}'; // Optional files
    throw new Error(`GitHub fetch failed: ${response.status}`);
  }

  return response.text();
}

async function listGitHubDir(
  repo: string,
  path: string,
  ref: string,
  token: string | null
): Promise<string[]> {
  const repoPath = repo.replace('https://github.com/', '');

  const response = await fetch(
    `https://api.github.com/repos/${repoPath}/contents/${path}?ref=${ref}`,
    {
      headers: {
        'Accept': 'application/vnd.github.v3+json',
        ...(token ? { 'Authorization': `Bearer ${token}` } : {}),
      },
    }
  );

  if (!response.ok) {
    if (response.status === 404) return [];
    throw new Error(`GitHub list failed: ${response.status}`);
  }

  const items = await response.json() as Array<{ name: string; type: string }>;
  return items.filter(i => i.type === 'file').map(i => i.name);
}
```

#### 3.4 Inject into Claude Agent SDK

Pass extracted bundle to the sandbox and configure the SDK:

```typescript
// src/lib/sandbox.ts
async function runAgentWithPlugins(
  sandbox: Sandbox,
  prompt: string,
  bundle: PluginBundle,
  env: Env
): Promise<AgentResult> {
  // 1. Write skills to sandbox filesystem
  await sandbox.mkdir('/workspace/.claude/skills', { recursive: true });
  for (const skill of bundle.skills) {
    const skillDir = `/workspace/.claude/skills/${skill.name}`;
    await sandbox.mkdir(skillDir, { recursive: true });
    await sandbox.writeFile(`${skillDir}/SKILL.md`, skill.content);
  }

  // 2. Write commands to sandbox filesystem
  await sandbox.mkdir('/workspace/.claude/commands', { recursive: true });
  for (const command of bundle.commands) {
    await sandbox.writeFile(
      `/workspace/.claude/commands/${command.name}.md`,
      command.content
    );
  }

  // 3. Write MCP config
  await sandbox.writeFile(
    '/workspace/.claude/mcp.json',
    JSON.stringify({ mcpServers: bundle.mcpServers }, null, 2)
  );

  // 4. Point Claude SDK to AI Gateway (handles API key + billing)
  await sandbox.setEnvVars({
    ANTHROPIC_BASE_URL: env.AI_GATEWAY_URL,  // SDK expects this var name
  });

  // 5. Run Claude Agent SDK with the config
  const result = await sandbox.exec('claude', [
    '--print',
    '--output-format', 'json',
    '--mcp-config', '/workspace/.claude/mcp.json',
    '--allowedTools', 'mcp__*,Read,Write,Bash,Glob,Grep',
    prompt,
  ], {
    cwd: '/workspace',
    timeout: 300000,
  });

  return {
    output: result.stdout,
    exitCode: result.exitCode,
  };
}
```

#### 3.5 MCP Server Security

```typescript
// Simple domain allowlist - sufficient for 10-50 tenants
function validateMCPServerUrl(url: string, allowedDomains: string[]): boolean {
  const parsed = new URL(url);

  // Block private IPs with simple check
  if (/^(localhost|127\.|10\.|172\.(1[6-9]|2|3[01])\.|192\.168\.)/.test(parsed.hostname)) {
    throw new Error(`MCP server cannot use private IP: ${parsed.hostname}`);
  }

  // Check domain allowlist from tenant config
  if (!allowedDomains.some(d => parsed.hostname.endsWith(d))) {
    throw new Error(`MCP server domain not allowed: ${parsed.hostname}`);
  }

  return true;
}
```

#### 3.6 Credentials Management

MCP servers need different credential types (all stored in KV, encrypted):

| Type | Example | KV Key Pattern | Refresh |
|------|---------|----------------|---------|
| API Key | `OPENAI_API_KEY` | `secret:{tenant}/{name}` | Manual |
| OAuth2 | HubSpot, Slack | `oauth:{tenant}:{provider}` | Auto |
| Service Account | Google, AWS | `secret:{tenant}/{name}` | Manual |

**OAuth credentials in KV (encrypted JSON):**

```typescript
// src/lib/credentials.ts
interface OAuthCredential {
  access_token: string;
  refresh_token: string | null;
  expires_at: number;
  token_type: string;
  scopes: string[];
}

// KV key format: oauth:{tenant_id}:{provider}
function oauthKey(tenantId: string, provider: string): string {
  return `oauth:${tenantId}:${provider}`;
}

async function getOAuthToken(
  tenantId: string,
  provider: string,
  kv: KVNamespace,
  env: Env
): Promise<string> {
  const key = oauthKey(tenantId, provider);
  const encrypted = await kv.get(key);

  if (!encrypted) {
    throw new Error(`No ${provider} credentials for tenant ${tenantId}`);
  }

  const cred: OAuthCredential = JSON.parse(decrypt(encrypted, env.ENCRYPTION_KEY));

  // Check if token needs refresh (5 min buffer)
  const now = Math.floor(Date.now() / 1000);
  if (cred.expires_at && cred.expires_at < now + 300) {
    return await refreshOAuthToken(tenantId, provider, cred, kv, env);
  }

  return cred.access_token;
}

// Simple token refresh - no distributed locking needed for 10-50 tenants
// Occasional duplicate refreshes are acceptable at this scale

async function refreshOAuthToken(
  tenantId: string,
  provider: string,
  cred: OAuthCredential,
  kv: KVNamespace,
  env: Env
): Promise<string> {
  const config = OAUTH_PROVIDERS[provider];

  const response = await fetch(config.tokenUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'refresh_token',
      refresh_token: cred.refresh_token!,
      client_id: env[`${provider.toUpperCase()}_CLIENT_ID`],
      client_secret: env[`${provider.toUpperCase()}_CLIENT_SECRET`],
    }),
  });

  if (!response.ok) {
    throw new Error(`Token refresh failed for ${provider}: ${response.status}`);
  }

  const tokens = await response.json() as {
    access_token: string;
    refresh_token?: string;
    expires_in: number;
  };

  const updated: OAuthCredential = {
    ...cred,
    access_token: tokens.access_token,
    refresh_token: tokens.refresh_token || cred.refresh_token,
    expires_at: Math.floor(Date.now() / 1000) + tokens.expires_in,
  };

  await kv.put(
    oauthKey(tenantId, provider),
    encrypt(JSON.stringify(updated), env.ENCRYPTION_KEY)
  );

  return tokens.access_token;
}
```

**Resolve MCP secrets (API keys + OAuth):**

```typescript
// src/lib/plugins.ts
async function resolveMcpSecrets(
  mcpRaw: string,
  pluginEnv: Record<string, string>,
  tenantId: string,
  kv: KVNamespace,
  env: Env
): Promise<string> {
  let resolved = mcpRaw;

  for (const [key, value] of Object.entries(pluginEnv)) {
    let secretValue: string;

    if (value.startsWith('oauth:')) {
      // OAuth token (auto-refresh) - e.g., "oauth:hubspot"
      const provider = value.replace('oauth:', '');
      secretValue = await getOAuthToken(tenantId, provider, kv, env);
    } else if (value.startsWith('secret:')) {
      // Static secret - e.g., "secret:acme/api_key"
      const secretPath = value.replace('secret:', '');
      const encrypted = await kv.get(`secret:${secretPath}`);
      secretValue = encrypted ? decrypt(encrypted, env.ENCRYPTION_KEY) : '';
    } else {
      secretValue = value;
    }

    resolved = resolved.replace(new RegExp(`\\$\\{${key}\\}`, 'g'), secretValue);
  }

  return resolved;
}
```

**Tenant config with mixed credential types:**

```yaml
# config/tenants/acme-corp.yaml
plugins:
  - repo: https://github.com/anthropics/knowledge-work-plugins
    path: sales
    env:
      # OAuth tokens (auto-refresh)
      HUBSPOT_TOKEN: oauth:hubspot
      SLACK_TOKEN: oauth:slack

      # Static API keys
      OPENAI_API_KEY: secret:acme/openai

  - repo: https://github.com/acme-corp/internal-plugin
    github_token: secret:acme/github_token
    env:
      # Service account (static)
      GOOGLE_SERVICE_ACCOUNT: secret:acme/google_sa
```

**OAuth setup flow (tenant onboarding):**

```typescript
// scripts/oauth-connect.ts
// Tenant initiates OAuth connection via API

// 1. Generate auth URL
GET /v1/oauth/connect?provider=hubspot
→ Redirect to HubSpot OAuth consent screen

// 2. Callback receives code
GET /v1/oauth/callback?provider=hubspot&code=xxx
→ Exchange code for tokens
→ Store encrypted in D1
→ Redirect to success page

// 3. Tokens automatically refreshed when used
```

### Phase 4: Configuration Management

#### 4.1 Tenant Configuration Schema

```yaml
# config/tenants/acme-corp.yaml
tenant:
  id: acme-corp
  name: Acme Corporation
  created_at: 2026-02-01T00:00:00Z

zero_trust:
  service_tokens:
    - client_id: "abc123.access"
      name: acme-prod
      permissions: [agent:query, agent:stream, sessions:read, sessions:write]
    - client_id: "def456.access"
      name: acme-dev
      permissions: [agent:query]
  require_mtls: false

resources:
  sandbox:
    sleep_after: 15m
    max_concurrent_sessions: 10
  storage:
    bucket: acme-corp-data
    quota_gb: 50

# Plugins from GitHub repos (Claude Cowork format)
plugins:
  # Anthropic's standard plugins
  - repo: https://github.com/anthropics/knowledge-work-plugins
    path: sales                    # Subpath in monorepo
    ref: main
    env:
      HUBSPOT_TOKEN: secret:acme/hubspot
      SLACK_TOKEN: secret:acme/slack

  - repo: https://github.com/anthropics/knowledge-work-plugins
    path: data
    env:
      SNOWFLAKE_ACCOUNT: secret:acme/snowflake_account
      SNOWFLAKE_TOKEN: secret:acme/snowflake_token

  # Acme's private plugin repo
  - repo: https://github.com/acme-corp/claude-plugins
    ref: v2.1.0                    # Pin to specific version
    env:
      ACME_CRM_TOKEN: secret:acme/crm
      INTERNAL_API_KEY: secret:acme/internal_api

  # Third-party plugin
  - repo: https://github.com/example/legal-plugin
    env:
      DOCUSIGN_TOKEN: secret:acme/docusign

rate_limits:
  requests_per_minute: 100
  tokens_per_day: 1000000
```

#### 4.2 Configuration Loading

```typescript
// src/shared/config.ts
import * as yaml from 'yaml';
import * as fs from 'fs';
import * as path from 'path';

interface TenantConfig {
  tenant: {
    id: string;
    name: string;
    created_at: string;
  };
  oauth: {
    clients: Array<{
      client_id: string;
      scopes: string[];
    }>;
  };
  resources: {
    sandbox: {
      sleep_after: string;
      max_concurrent_sessions: number;
    };
    storage: {
      bucket: string;
      quota_gb: number;
    };
  };
  skills: {
    enabled: string[];
    custom: Array<{
      name: string;
      path: string;
    }>;
  };
  mcp_servers: {
    enabled: string[];
    custom: Array<MCPServerConfig>;
  };
  rate_limits: {
    requests_per_minute: number;
    tokens_per_day: number;
  };
}

function loadTenantConfigs(configDir: string): Map<string, TenantConfig> {
  const configs = new Map<string, TenantConfig>();
  const tenantDir = path.join(configDir, 'tenants');

  for (const file of fs.readdirSync(tenantDir)) {
    if (file.endsWith('.yaml') || file.endsWith('.yml')) {
      const content = fs.readFileSync(path.join(tenantDir, file), 'utf-8');
      const config = yaml.parse(content) as TenantConfig;
      configs.set(config.tenant.id, config);
    }
  }

  return configs;
}
```

### Phase 5: AI Gateway Integration

#### 5.1 AI Gateway Setup (Anthropic + Bedrock)

```typescript
// src/lib/ai-gateway.ts
type AIProvider = 'anthropic' | 'bedrock';

interface AIGatewayConfig {
  accountId: string;
  gatewayId: string;
  provider: AIProvider;
}

function getAIGatewayUrl(accountId: string, gatewayId: string, provider: AIProvider): string {
  // AI Gateway supports multiple providers
  // https://developers.cloudflare.com/ai-gateway/providers/
  return `https://gateway.ai.cloudflare.com/v1/${accountId}/${gatewayId}/${provider}`;
}

// Determine provider from tenant config (default: anthropic)
const provider = tenantConfig.ai?.provider ?? 'anthropic';
const aiGatewayUrl = getAIGatewayUrl(env.CF_ACCOUNT_ID, env.AI_GATEWAY_ID, provider);

// Claude SDK uses ANTHROPIC_BASE_URL for both Anthropic and Bedrock
// AI Gateway translates the request format automatically
await sandbox.setEnvVars({
  ANTHROPIC_BASE_URL: aiGatewayUrl,
});
```

**How it works:**
```
Claude Agent SDK (in sandbox)
    ↓ ANTHROPIC_BASE_URL
AI Gateway (gateway.ai.cloudflare.com/v1/{account}/{gateway}/{provider})
    │
    ├── /anthropic → Anthropic API (api.anthropic.com)
    │                 Uses: ANTHROPIC_API_KEY
    │
    └── /bedrock   → AWS Bedrock (bedrock-runtime.{region}.amazonaws.com)
                     Uses: AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
                     Model: anthropic.claude-3-5-sonnet-20241022-v2:0
```

**Tenant config for provider selection:**
```yaml
# config/tenants/acme-corp.yaml
ai:
  provider: anthropic  # or 'bedrock'
  # Bedrock-specific (if provider: bedrock)
  bedrock_region: us-east-1
  bedrock_model: anthropic.claude-3-5-sonnet-20241022-v2:0
```

**AI Gateway handles (configured in Cloudflare Dashboard):**
- API key/credential storage (never exposed to sandbox)
- Unified billing across all tenants
- Request logging and analytics
- Response caching
- Rate limiting
- Provider failover (Anthropic → Bedrock or vice versa)

#### 5.2 Per-Tenant Metadata

```typescript
// Track usage per tenant via AI Gateway metadata
const headers = {
  'cf-aig-metadata': JSON.stringify({
    tenant_id: tenantId,
    session_id: sessionId,
    client_id: clientId,
  }),
};
```

## Production Readiness Checklist

### Security Hardening (Pre-Launch)

```
[ ] Tenant isolation verification tests
[ ] MCP domain allowlist per tenant
[ ] Encryption at rest for all KV and R2 data
[ ] Pin plugins to commit SHAs
[ ] Basic rate limiting
```

### Observability (Minimal)

```typescript
// Simple health endpoint - add complexity when load balancer needs it
export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (new URL(request.url).pathname === '/health') {
      const kvOk = await env.CONFIG_KV.get('health:ping').then(() => true).catch(() => false);
      return Response.json({ ok: kvOk });
    }
    // ... rest of routing
  }
};
```

## Acceptance Criteria

### Functional Requirements

- [ ] Dispatch Worker correctly routes requests to tenant-specific sandboxes
- [ ] Zero Trust service tokens authenticate tenants
- [ ] Each tenant has isolated Sandbox container
- [ ] Claude Agent SDK runs inside Sandbox with skills loaded
- [ ] MCP servers are accessible from within Sandbox (domain allowlist enforced)
- [ ] R2 bucket prefix per tenant for persistent storage
- [ ] AI Gateway proxies all Claude requests (Anthropic or Bedrock per tenant config)
- [ ] Configuration loads from local YAML files

### Non-Functional Requirements

- [ ] Sandbox cold start < 5 seconds
- [ ] Request latency < 500ms for routing (excluding agent execution)
- [ ] Support 10-50 concurrent tenants
- [ ] Zero cross-tenant data leakage

### Quality Gates

- [ ] Unit tests for auth, routing, and config loading
- [ ] Integration tests with real Cloudflare services
- [ ] Security review of tenant isolation

## Dependencies & Prerequisites

| Dependency | Purpose | Required By |
|------------|---------|-------------|
| Cloudflare Workers Paid | Sandbox SDK access | Phase 1 |
| Cloudflare Zero Trust | Service tokens, Access policies, JWT validation | Phase 1 |
| R2 Bucket | Per-tenant storage + plugin cache | Phase 1 |
| KV Namespace | Secrets (encrypted), OAuth tokens, tenant config | Phase 1 |
| AI Gateway | Anthropic/Bedrock proxy (manages credentials) | Phase 1 |
| Claude Agent SDK | Agent runtime | Phase 2 |
| GitHub repos | Plugin sources (skills, commands, MCP) | Phase 3 |

## Risk Analysis & Mitigation

| Risk | Likelihood | Impact | Mitigation |
|------|------------|--------|------------|
| Sandbox cold start latency | Medium | High | Keep active tenant sandboxes warm |
| Cross-tenant data leakage | Low | Critical | R2 prefix isolation, security audit |
| AI Gateway rate limits | Medium | Medium | Per-tenant rate limiting |
| Service token compromise | Low | High | Token rotation, Zero Trust audit logs |
| MCP server failures | Medium | Medium | Domain allowlist, timeout handling |

## File Structure Summary

```
agentplane/
├── docs/plans/
│   └── 2026-02-01-feat-cloudflare-agent-infrastructure-plan.md
├── wrangler.toml
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts                  # Dispatch Worker (single entry point)
│   └── lib/
│       ├── auth.ts               # Zero Trust JWT validation (with JWKS caching)
│       ├── sandbox.ts            # Sandbox lifecycle + SDK injection
│       ├── plugins.ts            # Plugin extraction from GitHub (5-min TTL cache)
│       ├── github.ts             # GitHub API helpers
│       ├── credentials.ts        # API key storage (OAuth deferred until needed)
│       ├── config.ts             # Tenant config loading
│       └── types.ts
├── config/
│   └── tenants/*.yaml            # Per-tenant config (includes plugin sources)
├── container/
│   ├── Dockerfile                # Sandbox container image
│   └── entrypoint.sh
└── scripts/
    ├── provision-tenant.ts       # Creates tenant + Zero Trust service token
    ├── setup-zero-trust.ts       # Configures Access application
    └── deploy.ts
```

**Plugin extraction flow:**
```
1. Worker receives request
2. Load tenant config (plugins list)
3. For each plugin:
   - Check R2 cache (5min TTL)
   - If miss: fetch from GitHub API (skills/*.md, commands/*.md, .mcp.json)
   - Resolve secrets in MCP config
   - Cache in R2
4. Merge all plugins into bundle
5. Write to sandbox filesystem:
   - /workspace/.claude/skills/{name}/SKILL.md
   - /workspace/.claude/commands/{name}.md
   - /workspace/.claude/mcp.json
6. Run Claude Agent SDK with --mcp-config flag
```

## References

### Internal References
- MoltWorker blog post: https://blog.cloudflare.com/moltworker-self-hosted-ai-agent/
- MoltWorker repo: https://github.com/cloudflare/moltworker

### External References
- Cloudflare Sandbox SDK: https://developers.cloudflare.com/sandbox/
- Cloudflare Workers for Platforms: https://developers.cloudflare.com/cloudflare-for-platforms/workers-for-platforms/
- Cloudflare Zero Trust: https://developers.cloudflare.com/cloudflare-one/
- Cloudflare Access Service Tokens: https://developers.cloudflare.com/cloudflare-one/identity/service-tokens/
- Cloudflare AI Gateway: https://developers.cloudflare.com/ai-gateway/
- Claude Agent SDK: https://docs.anthropic.com/en/docs/agents-and-tools/claude-code/sdk
- Claude Cowork Plugins: https://github.com/anthropics/knowledge-work-plugins
- MCP Specification: https://modelcontextprotocol.io/specification/2025-11-25
