import { NextRequest } from "next/server";
import { z } from "zod";
import { queryOne } from "@/db";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { NotFoundError } from "@/lib/errors";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Minimal existence-check schema. The full SessionRow Zod schema requires
// many fields (status, ephemeral, expires_at, etc.) — using it here against
// `SELECT id` always threw ZodError → withErrorHandler → 400, which made
// the admin Run page's stream fetch see !res.ok and bail at the very start
// (Streaming pill flashed for ~50ms then "No transcript available" stuck).
// All we need from this row is "the session exists" — keep the projection
// and the validator aligned.
const SessionIdRow = z.object({ id: z.string() });
const InFlightRow = z.object({ id: z.string() });

export const GET = withErrorHandler(async (request: NextRequest, context) => {
  const { sessionId } = await context!.params;

  const session = await queryOne(
    SessionIdRow,
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
