import { z } from "zod";
import { hashApiKey, timingSafeEqual } from "./crypto";
import { queryOne } from "@/db";
import { logger } from "./logger";
import type { TenantId } from "./types";

const ApiKeyRow = z.object({
  id: z.string(),
  tenant_id: z.string(),
  name: z.string(),
});

export interface AuthContext {
  tenantId: TenantId;
  apiKeyId: string;
  apiKeyName: string;
}

export async function authenticateApiKey(
  authHeader: string | null,
): Promise<AuthContext> {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new Error("Missing or invalid Authorization header");
  }

  const token = authHeader.slice(7);

  if (!token.startsWith("ap_live_") && !token.startsWith("ap_test_")) {
    throw new Error("Invalid API key format");
  }

  const keyHash = await hashApiKey(token);

  const row = await queryOne(
    ApiKeyRow,
    `SELECT id, tenant_id, name
     FROM api_keys
     WHERE key_hash = $1
       AND revoked_at IS NULL
       AND (expires_at IS NULL OR expires_at > NOW())`,
    [keyHash],
  );

  if (!row) {
    throw new Error("Invalid or revoked API key");
  }

  // Update last_used_at (fire and forget)
  import("@/db").then(({ execute }) =>
    execute("UPDATE api_keys SET last_used_at = NOW() WHERE id = $1", [row.id]).catch(() => {}),
  );

  logger.debug("API key authenticated", {
    tenant_id: row.tenant_id,
    api_key_id: row.id,
  });

  return {
    tenantId: row.tenant_id as TenantId,
    apiKeyId: row.id,
    apiKeyName: row.name,
  };
}

/**
 * Authenticate an A2A request by validating both the tenant slug and API key.
 * Single-query auth via JOIN prevents timing attacks from two-step resolution.
 * Returns AuthContext with keyId for cross-key run scoping.
 */
export async function authenticateA2aRequest(
  authHeader: string | null,
  tenantSlug: string,
): Promise<AuthContext> {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    throw new Error("Missing or invalid Authorization header");
  }

  const token = authHeader.slice(7);

  // MUST validate prefix before hashing — A2A routes may bypass middleware prefix check
  if (!token.startsWith("ap_live_") && !token.startsWith("ap_test_")) {
    throw new Error("Invalid API key format");
  }

  const keyHash = await hashApiKey(token);

  // Single query combining slug + key validation (constant-time regardless of slug validity)
  const row = await queryOne(
    ApiKeyRow,
    `SELECT ak.id, ak.tenant_id, ak.name
     FROM api_keys ak
     JOIN tenants t ON ak.tenant_id = t.id
     WHERE ak.key_hash = $1
       AND t.slug = $2
       AND ak.revoked_at IS NULL
       AND (ak.expires_at IS NULL OR ak.expires_at > NOW())`,
    [keyHash, tenantSlug],
  );

  if (!row) {
    throw new Error("Invalid or revoked API key");
  }

  // Update last_used_at (fire and forget — match existing authenticateApiKey pattern)
  import("@/db").then(({ execute }) =>
    execute("UPDATE api_keys SET last_used_at = NOW() WHERE id = $1", [row.id]).catch(() => {}),
  );

  logger.debug("A2A request authenticated", {
    tenant_id: row.tenant_id,
    api_key_id: row.id,
    tenant_slug: tenantSlug,
  });

  return {
    tenantId: row.tenant_id as TenantId,
    apiKeyId: row.id,
    apiKeyName: row.name,
  };
}

export function authenticateAdmin(authHeader: string | null): boolean {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return false;
  }

  const token = authHeader.slice(7);
  const adminKey = process.env.ADMIN_API_KEY;

  if (!adminKey) return false;

  return timingSafeEqual(token, adminKey);
}
