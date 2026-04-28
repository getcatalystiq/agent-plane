import { NextRequest } from "next/server";
import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { getMessage } from "@/lib/session-messages";
import { NotFoundError } from "@/lib/errors";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (request: NextRequest, context) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const { sessionId, messageId } = await context!.params;

  const message = await getMessage(messageId, auth.tenantId);
  if (!message || message.session_id !== sessionId) {
    throw new NotFoundError("Message not found");
  }

  return jsonResponse(message);
});
