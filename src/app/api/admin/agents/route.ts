import { NextRequest, NextResponse } from "next/server";
import { query, queryOne } from "@/db";
import { PaginationSchema, CreateAgentSchema, AgentRow, TenantRow } from "@/lib/validation";
import { withErrorHandler } from "@/lib/api";
import { createAgentRecord } from "@/lib/agents";
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
  message_count: z.coerce.number(),
  last_message_at: z.coerce.string().nullable(),
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
       (SELECT COUNT(*)::int FROM session_messages m WHERE m.session_id IN (SELECT id FROM sessions WHERE agent_id = a.id)) AS message_count,
       (SELECT MAX(m.created_at) FROM session_messages m WHERE m.session_id IN (SELECT id FROM sessions WHERE agent_id = a.id)) AS last_message_at
     FROM agents a
     JOIN tenants t ON t.id = a.tenant_id
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
    return NextResponse.json({ error: { code: "not_found", message: "Tenant not found" } }, { status: 404 });
  }

  const result = await createAgentRecord(input.tenant_id, input, {
    slug: (input as { slug?: string }).slug,
  });

  const agent = await queryOne(AgentRow, "SELECT * FROM agents WHERE id = $1", [result.id]);
  return NextResponse.json(agent, { status: 201 });
});
