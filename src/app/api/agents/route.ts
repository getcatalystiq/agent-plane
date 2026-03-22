import { NextRequest } from "next/server";
import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { CreateAgentSchema, AgentRow, PaginationSchema } from "@/lib/validation";
import { query } from "@/db";
import { createAgentRecord } from "@/lib/agents";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export const POST = withErrorHandler(async (request: NextRequest) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const body = await request.json();
  const input = CreateAgentSchema.parse(body);

  const id = await createAgentRecord(auth.tenantId, input);

  const agent = await query(
    AgentRow,
    "SELECT * FROM agents WHERE id = $1 AND tenant_id = $2",
    [id, auth.tenantId],
  );

  logger.info("Agent created", { tenant_id: auth.tenantId, agent_id: id, name: input.name });

  return jsonResponse(agent[0], 201);
});

export const GET = withErrorHandler(async (request: NextRequest) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const url = new URL(request.url);
  const pagination = PaginationSchema.parse({
    limit: url.searchParams.get("limit"),
    offset: url.searchParams.get("offset"),
  });

  const agents = await query(
    AgentRow,
    `SELECT * FROM agents WHERE tenant_id = $1
     ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
    [auth.tenantId, pagination.limit, pagination.offset],
  );

  return jsonResponse({ data: agents, limit: pagination.limit, offset: pagination.offset });
});
