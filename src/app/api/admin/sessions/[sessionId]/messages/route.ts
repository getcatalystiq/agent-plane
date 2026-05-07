import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { query, queryOne } from "@/db";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { SessionRow, SessionMessageRow, PaginationSchema, SessionMessageStatusSchema } from "@/lib/validation";
import { dispatchOrWorkflowDispatch } from "@/lib/workflows/dispatch-shim";
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
    const result = await dispatchOrWorkflowDispatch({
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

  // SEC: explicit column list omits injection_detected, injection_confidence,
  // injection_patterns. The admin route uses ADMIN_API_KEY which bypasses RLS,
  // so a misuse of the admin API would otherwise return flagged content
  // across tenants. The columns still exist on the row and are populated by
  // the dispatch shim — they're just not exposed to the admin GET in v1.
  // The admin-UI cross-tenant audit pass will decide whether to surface them
  // via a deliberate, rights-checked endpoint.
  const messages = await query(
    SessionMessageRow,
    `SELECT m.id, m.session_id, m.tenant_id, m.prompt, m.status, m.triggered_by,
            m.runner, m.cost_usd, m.total_input_tokens, m.total_output_tokens,
            m.cache_read_tokens, m.cache_creation_tokens, m.num_turns,
            m.duration_ms, m.duration_api_ms, m.model_usage,
            m.transcript_blob_url, m.result_summary, m.error_type,
            m.error_messages, m.webhook_source_id, m.created_by_key_id,
            m.runner_started_at, m.started_at, m.completed_at, m.created_at,
            a.name AS agent_name, a.model AS agent_model, s.agent_id
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
