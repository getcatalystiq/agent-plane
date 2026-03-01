import { NextRequest } from "next/server";
import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { execute } from "@/db";
import { NotFoundError } from "@/lib/errors";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export const DELETE = withErrorHandler(async (request: NextRequest, context) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const { keyId } = await context!.params;

  const result = await execute(
    `UPDATE api_keys SET revoked_at = NOW()
     WHERE id = $1 AND tenant_id = $2 AND revoked_at IS NULL`,
    [keyId, auth.tenantId],
  );

  if (result.rowCount === 0) {
    throw new NotFoundError("API key not found or already revoked");
  }

  logger.info("API key revoked", { tenant_id: auth.tenantId, api_key_id: keyId });
  return jsonResponse({ revoked: true });
});
