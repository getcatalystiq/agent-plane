import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { query, queryOne } from "@/db";
import {
  PaginationSchema,
  SessionStatusSchema,
  AgentRowInternal,
} from "@/lib/validation";
import { withErrorHandler } from "@/lib/api";
import { createSession } from "@/lib/sessions";
import { dispatchSessionMessage } from "@/lib/dispatcher";
import { deriveTriggeredBy } from "@/lib/trigger";
import { NotFoundError } from "@/lib/errors";
import type { AgentId, TenantId } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const SessionWithContext = z.object({
  id: z.string(),
  agent_id: z.string(),
  agent_name: z.string(),
  tenant_id: z.string(),
  tenant_name: z.string(),
  status: z.string(),
  message_count: z.coerce.number(),
  sandbox_id: z.string().nullable(),
  ephemeral: z.boolean(),
  idle_since: z.coerce.string().nullable(),
  created_at: z.coerce.string(),
  updated_at: z.coerce.string(),
});

export const GET = withErrorHandler(async (request: NextRequest) => {
  const url = new URL(request.url);
  const { limit, offset } = PaginationSchema.parse({
    limit: url.searchParams.get("limit") ?? "50",
    offset: url.searchParams.get("offset") ?? "0",
  });
  const statusParam = url.searchParams.get("status");
  const status = statusParam ? SessionStatusSchema.parse(statusParam) : undefined;
  const tenantId = url.searchParams.get("tenant_id");
  const agentId = url.searchParams.get("agent_id");

  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (status) {
    conditions.push(`s.status = $${idx++}`);
    params.push(status);
  }
  if (tenantId) {
    conditions.push(`s.tenant_id = $${idx++}`);
    params.push(tenantId);
  }
  if (agentId) {
    conditions.push(`s.agent_id = $${idx++}`);
    params.push(agentId);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  params.push(limit, offset);

  const sessions = await query(
    SessionWithContext,
    `SELECT s.id, s.agent_id, a.name AS agent_name, s.tenant_id, t.name AS tenant_name,
       s.status, s.message_count, s.sandbox_id, s.ephemeral, s.idle_since,
       s.created_at, s.updated_at
     FROM sessions s
     JOIN agents a ON a.id = s.agent_id
     JOIN tenants t ON t.id = s.tenant_id
     ${where}
     ORDER BY s.created_at DESC
     LIMIT $${idx++} OFFSET $${idx}`,
    params,
  );

  return NextResponse.json({ data: sessions, limit, offset });
});

const AdminCreateSessionSchema = z.object({
  agent_id: z.string().min(1),
  prompt: z.string().min(1).max(100_000).optional(),
  ephemeral: z.boolean().optional(),
  idempotency_key: z.string().min(1).max(200).optional(),
});

export const POST = withErrorHandler(async (request: NextRequest) => {
  const body = await request.json();
  const input = AdminCreateSessionSchema.parse(body);

  // Admin path: look up agent without RLS so we can derive tenant_id.
  const agent = await queryOne(
    AgentRowInternal,
    "SELECT * FROM agents WHERE id = $1",
    [input.agent_id],
  );
  if (!agent) throw new NotFoundError("Agent not found");

  const tenantId = agent.tenant_id as TenantId;

  // First message via admin → playground (per the trigger derivation rule).
  const triggeredBy = deriveTriggeredBy({
    authSource: "admin",
    isFirstMessage: true,
  });

  if (!input.prompt) {
    const ephemeral = input.ephemeral ?? false;
    const { session } = await createSession(
      tenantId,
      input.agent_id as AgentId,
      { ephemeral, triggeredBy },
    );
    return NextResponse.json(session, { status: 201 });
  }

  const ephemeral = input.ephemeral ?? false;
  const result = await dispatchSessionMessage({
    tenantId,
    agentId: input.agent_id as AgentId,
    prompt: input.prompt,
    triggeredBy,
    ephemeral,
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
});
