import { NextRequest } from "next/server";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { NotFoundError, ValidationError } from "@/lib/errors";
import {
  UpdateWebhookSourceSchema,
  deleteWebhookSource,
  getWebhookSource,
  updateWebhookSource,
} from "@/lib/webhooks";
import type { TenantId, WebhookSourceId } from "@/lib/types";

export const dynamic = "force-dynamic";

function tenantIdFrom(request: NextRequest): TenantId {
  const t = new URL(request.url).searchParams.get("tenant_id");
  if (!t) throw new ValidationError("tenant_id query param is required");
  return t as TenantId;
}

export const GET = withErrorHandler(async (request: NextRequest, context) => {
  const { id } = await context!.params;
  const source = await getWebhookSource(tenantIdFrom(request), id as WebhookSourceId);
  if (!source) throw new NotFoundError("Webhook source not found");
  return jsonResponse(source);
});

export const PATCH = withErrorHandler(async (request: NextRequest, context) => {
  const { id } = await context!.params;
  const body = await request.json();
  const tenantId = body?.tenant_id ?? new URL(request.url).searchParams.get("tenant_id");
  if (!tenantId) throw new ValidationError("tenant_id is required");
  const patch = UpdateWebhookSourceSchema.parse(body);
  const source = await updateWebhookSource(tenantId as TenantId, id as WebhookSourceId, patch);
  if (!source) throw new NotFoundError("Webhook source not found");
  return jsonResponse(source);
});

export const DELETE = withErrorHandler(async (request: NextRequest, context) => {
  const { id } = await context!.params;
  const removed = await deleteWebhookSource(tenantIdFrom(request), id as WebhookSourceId);
  if (!removed) throw new NotFoundError("Webhook source not found");
  return jsonResponse({ deleted: true });
});
