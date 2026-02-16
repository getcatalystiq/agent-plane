import { NextRequest, NextResponse } from "next/server";
import { query, execute } from "@/db";
import { ApiKeyRow, CreateApiKeySchema } from "@/lib/validation";
import { generateApiKey, hashApiKey, generateId } from "@/lib/crypto";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ tenantId: string }> };

export async function GET(_request: NextRequest, context: RouteContext) {
  const { tenantId } = await context.params;

  const keys = await query(
    ApiKeyRow.omit({ key_hash: true }),
    `SELECT id, tenant_id, name, key_prefix, scopes, last_used_at, expires_at, revoked_at, created_at
     FROM api_keys
     WHERE tenant_id = $1
     ORDER BY created_at DESC`,
    [tenantId],
  );

  return NextResponse.json({ data: keys });
}

export async function POST(request: NextRequest, context: RouteContext) {
  const { tenantId } = await context.params;
  const body = await request.json();
  const input = CreateApiKeySchema.parse(body);

  const { raw, prefix } = generateApiKey();
  const keyHash = await hashApiKey(raw);
  const id = generateId();

  await execute(
    `INSERT INTO api_keys (id, tenant_id, name, key_prefix, key_hash, scopes, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [id, tenantId, input.name, prefix, keyHash, input.scopes, input.expires_at ?? null],
  );

  return NextResponse.json({ id, name: input.name, key: raw, key_prefix: prefix }, { status: 201 });
}
