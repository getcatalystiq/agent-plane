import { decrypt } from "@/lib/crypto";
import { getEnv } from "@/lib/env";
import { queryOne } from "@/db";
import type { TenantId } from "@/lib/types";
import type { RunnerType } from "@/lib/models";
import { z } from "zod";

// --- Process-level cache (5-min TTL, matching MCP server cache pattern) ---
const authCache = new Map<string, { auth: SandboxAuth; expiresAt: number }>();
const AUTH_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

export interface SandboxAuth {
  anthropicAuthToken: string;
  anthropicBaseUrl: string;
  isSubscription: boolean;
  extraAllowedHostnames: string[];
}

const SubscriptionRow = z.object({
  subscription_token_enc: z.string().nullable().default(null),
  subscription_base_url: z.string().nullable().default(null),
  subscription_token_expires_at: z.coerce.string().nullable().default(null),
});

function gatewayAuth(): SandboxAuth {
  return {
    anthropicAuthToken: getEnv().AI_GATEWAY_API_KEY,
    anthropicBaseUrl: "https://ai-gateway.vercel.sh",
    isSubscription: false,
    extraAllowedHostnames: [],
  };
}

// Allowed hostnames for subscription base URL (SSRF mitigation)
const ALLOWED_BASE_HOSTNAMES = new Set([
  "api.claude.ai",
  "api.anthropic.com",
  "ai-gateway.vercel.sh",
]);

/**
 * Resolve sandbox auth credentials for a tenant.
 * Subscription tokens are ONLY used for Claude models (claude-agent-sdk runner).
 * Non-Anthropic models always use the global AI Gateway key.
 */
export async function resolveSandboxAuth(
  tenantId: TenantId,
  runnerType: RunnerType,
): Promise<SandboxAuth> {
  const env = getEnv();

  // Non-Claude models always use AI Gateway — subscription token is Claude-only
  if (runnerType !== "claude-agent-sdk") {
    return gatewayAuth();
  }

  // Check cache (keyed by tenantId, only for Claude runner)
  const cached = authCache.get(tenantId);
  if (cached && cached.expiresAt > Date.now()) {
    return cached.auth;
  }

  const row = await queryOne(
    SubscriptionRow,
    `SELECT subscription_token_enc, subscription_base_url, subscription_token_expires_at FROM tenants WHERE id = $1`,
    [tenantId],
  );

  let auth: SandboxAuth;

  if (row?.subscription_token_enc) {
    // Enforce token expiry — fall back to AI Gateway if expired
    if (row.subscription_token_expires_at) {
      const expiresAt = new Date(row.subscription_token_expires_at);
      if (expiresAt.getTime() < Date.now()) {
        auth = gatewayAuth();
        authCache.set(tenantId, { auth, expiresAt: Date.now() + AUTH_CACHE_TTL });
        return auth;
      }
    }
    let token: string;
    try {
      token = await decrypt(
        JSON.parse(row.subscription_token_enc),
        env.ENCRYPTION_KEY,
        env.ENCRYPTION_KEY_PREVIOUS,
      );
    } catch (err) {
      throw new Error(
        `Failed to decrypt Claude subscription token for tenant ${tenantId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }

    const baseUrl = row.subscription_base_url || "https://api.claude.ai";
    let hostname: string;
    try {
      const parsed = new URL(baseUrl);
      hostname = parsed.hostname;
      // SSRF mitigation: only allow known Anthropic API hostnames
      if (!ALLOWED_BASE_HOSTNAMES.has(hostname)) {
        throw new Error(`Hostname ${hostname} not in allowed list`);
      }
    } catch (urlErr) {
      throw new Error(`Invalid Claude subscription base URL for tenant ${tenantId}: ${baseUrl} (${urlErr instanceof Error ? urlErr.message : String(urlErr)})`);
    }

    auth = {
      anthropicAuthToken: token.trim(),
      anthropicBaseUrl: baseUrl,
      isSubscription: true,
      extraAllowedHostnames: hostname === "ai-gateway.vercel.sh" ? [] : [hostname],
    };
  } else {
    auth = gatewayAuth();
  }

  authCache.set(tenantId, { auth, expiresAt: Date.now() + AUTH_CACHE_TTL });
  return auth;
}

/** Invalidate cached auth for a tenant (call on token update). */
export function invalidateAuthCache(tenantId: string): void {
  authCache.delete(tenantId);
}

/** Build the auth-related env vars for sandbox injection. */
export function buildSandboxAuthEnv(auth: SandboxAuth): Record<string, string> {
  const env: Record<string, string> = {
    ANTHROPIC_BASE_URL: auth.anthropicBaseUrl,
    ANTHROPIC_AUTH_TOKEN: auth.anthropicAuthToken,
    ANTHROPIC_API_KEY: "",
    // Always set AI_GATEWAY_API_KEY — needed for Vercel AI SDK (non-Anthropic models on same tenant)
    AI_GATEWAY_API_KEY: getEnv().AI_GATEWAY_API_KEY,
  };
  if (auth.isSubscription) {
    env.AGENT_PLANE_BILLING_SOURCE = "subscription";
  }
  return env;
}
