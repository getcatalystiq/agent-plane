import { NextRequest, NextResponse } from "next/server";
import { query } from "@/db";
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

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 100);
  const offset = parseInt(url.searchParams.get("offset") || "0");

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
}
