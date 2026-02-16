import { NextRequest, NextResponse } from "next/server";
import { execute } from "@/db";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ tenantId: string; keyId: string }> };

export async function DELETE(_request: NextRequest, context: RouteContext) {
  const { tenantId, keyId } = await context.params;

  const { rowCount } = await execute(
    `UPDATE api_keys SET revoked_at = NOW() WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL`,
    [keyId, tenantId],
  );

  if (rowCount === 0) {
    return NextResponse.json({ error: "Key not found or already revoked" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
