import { NextRequest } from "next/server";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { UpdateDedupeRuleSchema } from "@/lib/validation";
import {
  deleteTenantRule,
  updateTenantRule,
} from "@/lib/webhook-dedupe";
import type { TenantId } from "@/lib/types";

export const dynamic = "force-dynamic";

function tenantIdFromQuery(request: NextRequest): TenantId {
  const t = new URL(request.url).searchParams.get("tenant_id");
  if (!t) throw new ValidationError("tenant_id query param is required");
  return t as TenantId;
}

export const PATCH = withErrorHandler(async (request: NextRequest, context) => {
  const { id } = await context!.params;
  const body = await request.json();
  const tenantId =
    (typeof body?.tenant_id === "string" ? body.tenant_id : null) ??
    new URL(request.url).searchParams.get("tenant_id");
  if (!tenantId) throw new ValidationError("tenant_id is required");

  const patch = UpdateDedupeRuleSchema.parse(body);
  const row = await updateTenantRule(tenantId as TenantId, id as string, {
    keyPath: patch.key_path,
    windowSeconds: patch.window_seconds,
    enabled: patch.enabled,
  });
  if (!row) throw new NotFoundError("Dedupe rule not found");
  return jsonResponse(row);
});

export const DELETE = withErrorHandler(
  async (request: NextRequest, context) => {
    const { id } = await context!.params;
    const removed = await deleteTenantRule(
      tenantIdFromQuery(request),
      id as string,
    );
    if (!removed) throw new NotFoundError("Dedupe rule not found");
    return jsonResponse({ deleted: true });
  },
);
