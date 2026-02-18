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

export function authenticateAdmin(authHeader: string | null): boolean {
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return false;
  }

  const token = authHeader.slice(7);
  const adminKey = process.env.ADMIN_API_KEY;

  if (!adminKey) return false;

  return timingSafeEqual(token, adminKey);
}
