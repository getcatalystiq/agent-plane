import { NextRequest } from "next/server";
import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { queryOne } from "@/db";
import { TenantRow } from "@/lib/validation";
import { NotFoundError } from "@/lib/errors";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (request: NextRequest) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));

  const tenant = await queryOne(
    TenantRow,
    "SELECT * FROM tenants WHERE id = $1",
    [auth.tenantId],
  );

  if (!tenant) throw new NotFoundError("Tenant not found");

  return jsonResponse(tenant);
});
