import { NextRequest } from "next/server";
import { z } from "zod";
import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { getSession } from "@/lib/sessions";
import { queryOne } from "@/db";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const InFlightRow = z.object({ id: z.string() });

/**
 * Sugar route: resolves the session's in-flight message and 307-redirects
 * to its stream endpoint. Returns 409 with a hint when no message is
 * currently running.
 */
export const GET = withErrorHandler(async (request: NextRequest, context) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const { sessionId } = await context!.params;

  await getSession(sessionId, auth.tenantId);

  const inFlight = await queryOne(
    InFlightRow,
    `SELECT id FROM session_messages
     WHERE session_id = $1 AND tenant_id = $2 AND status IN ('queued', 'running')
     ORDER BY created_at DESC
     LIMIT 1`,
    [sessionId, auth.tenantId],
  );

  if (!inFlight) {
    return jsonResponse(
      {
        error: {
          code: "no_in_flight_message",
          message: "Session has no in-flight message",
        },
        hint: "send a new message via POST /api/sessions/:sessionId/messages",
      },
      409,
    );
  }

  const offset = request.nextUrl.searchParams.get("offset");
  const target = new URL(
    `/api/sessions/${sessionId}/messages/${inFlight.id}/stream${offset ? `?offset=${encodeURIComponent(offset)}` : ""}`,
    request.url,
  );
  return Response.redirect(target, 307);
});
