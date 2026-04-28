import { NextRequest, NextResponse } from "next/server";
import { query, queryOne } from "@/db";
import { withErrorHandler } from "@/lib/api";
import { SessionRow, SessionMessageRow } from "@/lib/validation";
import { cancelSession } from "@/lib/dispatcher";
import { NotFoundError } from "@/lib/errors";
import type { TenantId } from "@/lib/types";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (request: NextRequest, context) => {
  const { sessionId } = await context!.params;

  // Admin: no RLS — query directly.
  const session = await queryOne(
    SessionRow,
    "SELECT * FROM sessions WHERE id = $1",
    [sessionId],
  );
  if (!session) throw new NotFoundError("Session not found");

  const messages = await query(
    SessionMessageRow,
    `SELECT m.*, a.name AS agent_name, a.model AS agent_model, s.agent_id
     FROM session_messages m
     LEFT JOIN sessions s ON m.session_id = s.id
     LEFT JOIN agents a ON s.agent_id = a.id
     WHERE m.session_id = $1
     ORDER BY m.created_at ASC`,
    [sessionId],
  );

  return NextResponse.json({ ...session, messages });
});

export const DELETE = withErrorHandler(async (request: NextRequest, context) => {
  const { sessionId } = await context!.params;

  const session = await queryOne(
    SessionRow,
    "SELECT * FROM sessions WHERE id = $1",
    [sessionId],
  );
  if (!session) throw new NotFoundError("Session not found");

  await cancelSession(sessionId, session.tenant_id as TenantId);
  return new Response(null, { status: 204 });
});
