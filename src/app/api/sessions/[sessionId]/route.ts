import { NextRequest } from "next/server";
import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { SessionResponseRow } from "@/lib/validation";
import { getSession } from "@/lib/sessions";
import { listMessages } from "@/lib/session-messages";
import { cancelSession } from "@/lib/dispatcher";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (request: NextRequest, context) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const { sessionId } = await context!.params;

  const session = await getSession(sessionId, auth.tenantId);
  const responseSession = SessionResponseRow.parse(session);

  // Return recent messages alongside the session row.
  const messages = await listMessages(auth.tenantId, {
    sessionId,
    limit: 100,
    offset: 0,
  });

  return jsonResponse({ ...responseSession, messages });
});

export const DELETE = withErrorHandler(async (request: NextRequest, context) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const { sessionId } = await context!.params;

  await cancelSession(sessionId, auth.tenantId);
  return new Response(null, { status: 204 });
});
