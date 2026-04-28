import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { query, queryOne } from "@/db";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { SessionRow, SessionMessageRow, PaginationSchema, SessionMessageStatusSchema } from "@/lib/validation";
import { dispatchSessionMessage } from "@/lib/dispatcher";
import { deriveTriggeredBy } from "@/lib/trigger";
import { NotFoundError, SessionStoppedError } from "@/lib/errors";
import type { AgentId, TenantId } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const SendMessageRequestSchema = z.object({
  prompt: z.string().min(1).max(100_000),
  idempotency_key: z.string().min(1).max(200).optional(),
});

export const POST = withErrorHandler(async (request: NextRequest, context) => {
  const { sessionId } = await context!.params;
  const body = await request.json();
  const input = SendMessageRequestSchema.parse(body);

  // Admin: no RLS — query directly.
  const session = await queryOne(
    SessionRow,
    "SELECT * FROM sessions WHERE id = $1",
    [sessionId],
  );
  if (!session) throw new NotFoundError("Session not found");

  const tenantId = session.tenant_id as TenantId;
  const isFirstMessage = session.message_count === 0;
  const triggeredBy = deriveTriggeredBy({
    authSource: "admin",
    isFirstMessage,
  });

  try {
    const result = await dispatchSessionMessage({
      tenantId,
      agentId: session.agent_id as AgentId,
      sessionId,
      prompt: input.prompt,
      triggeredBy,
      idempotencyKey: input.idempotency_key,
      platformApiUrl: new URL(request.url).origin,
    });

    return new Response(result.stream, {
      status: 200,
      headers: {
        "Content-Type": "application/x-ndjson",
        "Cache-Control": "no-cache, no-transform",
        "X-Accel-Buffering": "no",
        "X-Session-Id": result.sessionId,
        "X-Message-Id": result.messageId,
      },
    });
  } catch (err) {
    if (err instanceof SessionStoppedError) {
      return jsonResponse(
        {
          error: { code: "session_stopped", message: err.message },
          hint: "create a new session via POST /api/admin/sessions",
        },
        410,
      );
    }
    throw err;
  }
});

export const GET = withErrorHandler(async (request: NextRequest, context) => {
  const { sessionId } = await context!.params;
  const url = new URL(request.url);
  const { limit, offset } = PaginationSchema.parse({
    limit: url.searchParams.get("limit") ?? "50",
    offset: url.searchParams.get("offset") ?? "0",
  });
  const statusParam = url.searchParams.get("status");
  const status = statusParam ? SessionMessageStatusSchema.parse(statusParam) : undefined;

  const session = await queryOne(
    SessionRow,
    "SELECT id FROM sessions WHERE id = $1",
    [sessionId],
  );
  if (!session) throw new NotFoundError("Session not found");

  const conditions: string[] = ["m.session_id = $1"];
  const params: unknown[] = [sessionId];
  let idx = 2;
  if (status) {
    conditions.push(`m.status = $${idx++}`);
    params.push(status);
  }
  params.push(limit, offset);

  const messages = await query(
    SessionMessageRow,
    `SELECT m.*, a.name AS agent_name, a.model AS agent_model, s.agent_id
     FROM session_messages m
     LEFT JOIN sessions s ON m.session_id = s.id
     LEFT JOIN agents a ON s.agent_id = a.id
     WHERE ${conditions.join(" AND ")}
     ORDER BY m.created_at DESC
     LIMIT $${idx++} OFFSET $${idx}`,
    params,
  );

  return NextResponse.json({ data: messages, limit, offset });
});
