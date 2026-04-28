import { NextRequest } from "next/server";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { getWebhookSource, rotateSecret } from "@/lib/webhooks";
import type { TenantId, WebhookSourceId } from "@/lib/types";

export const dynamic = "force-dynamic";

export const POST = withErrorHandler(async (request: NextRequest, context) => {
  const { id } = await context!.params;
  const body = await request.json().catch(() => ({}));
  const tenantId = body?.tenant_id ?? new URL(request.url).searchParams.get("tenant_id");
  if (!tenantId) throw new ValidationError("tenant_id is required");

  const existing = await getWebhookSource(tenantId as TenantId, id as WebhookSourceId);
  if (!existing) throw new NotFoundError("Webhook source not found");

  const { secret, previousExpiresAt } = await rotateSecret({
    tenantId: tenantId as TenantId,
    sourceId: id as WebhookSourceId,
  });
  return jsonResponse({
    secret,
    previous_secret_expires_at: previousExpiresAt.toISOString(),
  });
});
