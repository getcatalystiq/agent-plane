import { NextRequest, NextResponse } from "next/server";
import { queryOne } from "@/db";
import { withErrorHandler } from "@/lib/api";
import { SessionMessageRow } from "@/lib/validation";
import { NotFoundError } from "@/lib/errors";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (request: NextRequest, context) => {
  const { sessionId, messageId } = await context!.params;

  const message = await queryOne(
    SessionMessageRow,
    `SELECT m.*, a.name AS agent_name, a.model AS agent_model, s.agent_id
     FROM session_messages m
     LEFT JOIN sessions s ON m.session_id = s.id
     LEFT JOIN agents a ON s.agent_id = a.id
     WHERE m.id = $1 AND m.session_id = $2`,
    [messageId, sessionId],
  );
  if (!message) throw new NotFoundError("Message not found");

  return NextResponse.json(message);
});
