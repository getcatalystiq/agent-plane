import { NextRequest } from "next/server";
import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { NotFoundError } from "@/lib/errors";
import { getWebhookSource, rotateSecret } from "@/lib/webhooks";
import type { WebhookSourceId } from "@/lib/types";

export const dynamic = "force-dynamic";

export const POST = withErrorHandler(async (request: NextRequest, context) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const { sourceId } = await context!.params;

  const existing = await getWebhookSource(auth.tenantId, sourceId as WebhookSourceId);
  if (!existing) throw new NotFoundError("Webhook source not found");

  const { secret, previousExpiresAt } = await rotateSecret({
    tenantId: auth.tenantId,
    sourceId: sourceId as WebhookSourceId,
  });

  return jsonResponse({
    secret,
    previous_secret_expires_at: previousExpiresAt.toISOString(),
  });
});
