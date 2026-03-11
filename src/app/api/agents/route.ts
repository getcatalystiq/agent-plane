import { NextRequest } from "next/server";
import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { CreateAgentSchema, AgentRow, PaginationSchema } from "@/lib/validation";
import { query, execute } from "@/db";
import { generateId } from "@/lib/crypto";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

export const POST = withErrorHandler(async (request: NextRequest) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const body = await request.json();
  const input = CreateAgentSchema.parse(body);
  const id = generateId();

  await execute(
    `INSERT INTO agents (id, tenant_id, name, description, git_repo_url, git_branch,
      composio_toolkits, skills, model, allowed_tools, permission_mode, max_turns, max_budget_usd, max_runtime_seconds, a2a_enabled)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15)`,
    [
      id,
      auth.tenantId,
      input.name,
      input.description ?? null,
      input.git_repo_url ?? null,
      input.git_branch,
      input.composio_toolkits,
      JSON.stringify(input.skills),
      input.model,
      input.allowed_tools,
      input.permission_mode,
      input.max_turns,
      input.max_budget_usd,
      input.max_runtime_seconds,
      input.a2a_enabled,
    ],
  );

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
