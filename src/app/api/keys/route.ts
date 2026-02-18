import { NextRequest } from "next/server";
import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { CreateApiKeySchema, ApiKeyRow, PaginationSchema } from "@/lib/validation";
import { query, execute } from "@/db";
import { generateApiKey, hashApiKey, generateId } from "@/lib/crypto";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export const POST = withErrorHandler(async (request: NextRequest) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const body = await request.json();
  const input = CreateApiKeySchema.parse(body);

  const { raw, prefix } = generateApiKey();
  const keyHash = await hashApiKey(raw);
  const id = generateId();

  await execute(
    `INSERT INTO api_keys (id, tenant_id, name, key_prefix, key_hash, scopes, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [
      id,
      auth.tenantId,
      input.name,
      prefix,
      keyHash,
      input.scopes,
      input.expires_at ?? null,
    ],
  );

  logger.info("API key created", { tenant_id: auth.tenantId, api_key_id: id, name: input.name });

  // Return the raw key only once
  return jsonResponse(
    {
      id,
      name: input.name,
      key: raw,
      key_prefix: prefix,
      created_at: new Date().toISOString(),
    },
    201,
  );
});

export const GET = withErrorHandler(async (request: NextRequest) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const url = new URL(request.url);
  const pagination = PaginationSchema.parse({
    limit: url.searchParams.get("limit"),
    offset: url.searchParams.get("offset"),
  });

  const keys = await query(
    ApiKeyRow.omit({ key_hash: true }),
    `SELECT id, tenant_id, name, key_prefix, scopes, last_used_at, expires_at, revoked_at, created_at
     FROM api_keys
     WHERE tenant_id = $1 AND revoked_at IS NULL
     ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [auth.tenantId, pagination.limit, pagination.offset],
  );

  return jsonResponse({ data: keys, limit: pagination.limit, offset: pagination.offset });
});
