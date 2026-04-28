import { NextRequest } from "next/server";
import { z } from "zod";
import { queryOne } from "@/db";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { SessionRow } from "@/lib/validation";
import { NotFoundError } from "@/lib/errors";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const InFlightRow = z.object({ id: z.string() });

export const GET = withErrorHandler(async (request: NextRequest, context) => {
  const { sessionId } = await context!.params;

  const session = await queryOne(
    SessionRow,
    "SELECT id FROM sessions WHERE id = $1",
    [sessionId],
  );
  if (!session) throw new NotFoundError("Session not found");

  const inFlight = await queryOne(
    InFlightRow,
    `SELECT id FROM session_messages
     WHERE session_id = $1 AND status IN ('queued', 'running')
     ORDER BY created_at DESC
     LIMIT 1`,
    [sessionId],
  );

  if (!inFlight) {
    return jsonResponse(
      {
        error: {
          code: "no_in_flight_message",
          message: "Session has no in-flight message",
        },
        hint: "send a new message via POST /api/admin/sessions/:sessionId/messages",
      },
      409,
    );
  }

  const offset = request.nextUrl.searchParams.get("offset");
  const target = new URL(
    `/api/admin/sessions/${sessionId}/messages/${inFlight.id}/stream${offset ? `?offset=${encodeURIComponent(offset)}` : ""}`,
    request.url,
  );
  return Response.redirect(target, 307);
});
