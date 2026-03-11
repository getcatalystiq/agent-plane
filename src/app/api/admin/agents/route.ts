import { NextRequest, NextResponse } from "next/server";
import { query, queryOne, execute } from "@/db";
import { PaginationSchema, CreateAgentSchema, AgentRow, TenantRow } from "@/lib/validation";
import { withErrorHandler } from "@/lib/api";
import { generateId } from "@/lib/crypto";
import { z } from "zod";

export const dynamic = "force-dynamic";

const AgentWithTenant = z.object({
  id: z.string(),
  tenant_id: z.string(),
  tenant_name: z.string(),
  name: z.string(),
  model: z.string(),
  permission_mode: z.string(),
  composio_toolkits: z.array(z.string()),
  max_turns: z.coerce.number(),
  max_budget_usd: z.coerce.number(),
  created_at: z.coerce.string(),
  run_count: z.coerce.number(),
  last_run_at: z.coerce.string().nullable(),
});

export const GET = withErrorHandler(async (request: NextRequest) => {
  const url = new URL(request.url);
  const { limit, offset } = PaginationSchema.parse({
    limit: url.searchParams.get("limit") ?? "50",
    offset: url.searchParams.get("offset") ?? "0",
  });

  const agents = await query(
    AgentWithTenant,
    `SELECT a.id, a.tenant_id, t.name AS tenant_name, a.name, a.model,
       a.permission_mode, a.composio_toolkits, a.max_turns, a.max_budget_usd, a.created_at,
       COUNT(r.id)::int AS run_count,
       MAX(r.created_at) AS last_run_at
     FROM agents a
     JOIN tenants t ON t.id = a.tenant_id
     LEFT JOIN runs r ON r.agent_id = a.id
     GROUP BY a.id, t.name
     ORDER BY a.created_at DESC
     LIMIT $1 OFFSET $2`,
    [limit, offset],
  );

  return NextResponse.json({ data: agents, limit, offset });
});

const AdminCreateAgentSchema = CreateAgentSchema.extend({
  tenant_id: z.string().uuid(),
});

export const POST = withErrorHandler(async (request: NextRequest) => {
  const body = await request.json();
  const input = AdminCreateAgentSchema.parse(body);

  const tenant = await queryOne(TenantRow, "SELECT * FROM tenants WHERE id = $1", [input.tenant_id]);
  if (!tenant) {
    return NextResponse.json({ error: { message: "Tenant not found" } }, { status: 404 });
  }

  const id = generateId();

  await execute(
    `INSERT INTO agents (id, tenant_id, name, description, git_repo_url, git_branch,
      composio_toolkits, skills, model, allowed_tools, permission_mode, max_turns, max_budget_usd, max_runtime_seconds, a2a_enabled)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb, $9, $10, $11, $12, $13, $14, $15)`,
    [
      id,
      input.tenant_id,
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

  const agent = await queryOne(AgentRow, "SELECT * FROM agents WHERE id = $1", [id]);
  return NextResponse.json(agent, { status: 201 });
});
