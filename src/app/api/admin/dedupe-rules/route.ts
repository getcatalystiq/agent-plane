import { NextRequest } from "next/server";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { ConflictError, ValidationError } from "@/lib/errors";
import {
  CreateDedupeRuleSchema,
} from "@/lib/validation";
import {
  DEDUPE_DEFAULTS,
  createTenantRule,
  getEffectiveRulesForTenant,
  listTenantRules,
} from "@/lib/webhook-dedupe";
import type { TenantId } from "@/lib/types";

export const dynamic = "force-dynamic";

/**
 * GET /api/admin/dedupe-rules?tenant_id=…
 *
 * Returns the merged view: platform defaults, per-tenant overrides, and the
 * effective rule set the ingress route would resolve. Lets the Settings UI
 * render all three columns without composing them client-side.
 */
export const GET = withErrorHandler(async (request: NextRequest) => {
  const tenantId = new URL(request.url).searchParams.get("tenant_id");
  if (!tenantId) throw new ValidationError("tenant_id query param is required");

  const [overrides, effective] = await Promise.all([
    listTenantRules(tenantId as TenantId),
    getEffectiveRulesForTenant(tenantId),
  ]);

  return jsonResponse({
    defaults: DEDUPE_DEFAULTS,
    overrides,
    effective,
  });
});

/**
 * POST /api/admin/dedupe-rules
 *
 * Body: { tenant_id, provider, key_path, window_seconds, enabled? }
 * 409 on duplicate (tenant_id, provider).
 */
export const POST = withErrorHandler(async (request: NextRequest) => {
  const body = await request.json();
  const tenantId = body?.tenant_id;
  if (typeof tenantId !== "string") {
    throw new ValidationError("tenant_id is required");
  }
  const input = CreateDedupeRuleSchema.parse(body);
  try {
    const row = await createTenantRule(tenantId as TenantId, {
      provider: input.provider,
      keyPath: input.key_path,
      windowSeconds: input.window_seconds,
      enabled: input.enabled,
    });
    return jsonResponse(row, 201);
  } catch (err) {
    if (typeof err === "object" && err && "code" in err) {
      const code = (err as { code: string }).code;
      if (code === "23505") {
        throw new ConflictError(
          "A dedupe rule for this provider already exists for this tenant",
        );
      }
    }
    throw err;
  }
});
