import { NextRequest, NextResponse } from "next/server";
import { query } from "@/db";
import { z } from "zod";

export const dynamic = "force-dynamic";

const RunWithContext = z.object({
  id: z.string(),
  agent_id: z.string(),
  agent_name: z.string(),
  tenant_id: z.string(),
  tenant_name: z.string(),
  status: z.string(),
  prompt: z.string(),
  cost_usd: z.coerce.number(),
  num_turns: z.coerce.number(),
  duration_ms: z.coerce.number(),
  total_input_tokens: z.coerce.number(),
  total_output_tokens: z.coerce.number(),
  error_type: z.string().nullable(),
  started_at: z.coerce.string().nullable(),
  completed_at: z.coerce.string().nullable(),
  created_at: z.coerce.string(),
});

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get("limit") || "50"), 100);
  const offset = parseInt(url.searchParams.get("offset") || "0");
  const status = url.searchParams.get("status");
  const tenantId = url.searchParams.get("tenant_id");
  const agentId = url.searchParams.get("agent_id");

  const conditions: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (status) {
    conditions.push(`r.status = $${idx++}`);
    params.push(status);
  }
  if (tenantId) {
    conditions.push(`r.tenant_id = $${idx++}`);
    params.push(tenantId);
  }
  if (agentId) {
    conditions.push(`r.agent_id = $${idx++}`);
    params.push(agentId);
  }

  const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";

  params.push(limit, offset);

  const runs = await query(
    RunWithContext,
    `SELECT r.id, r.agent_id, a.name AS agent_name, r.tenant_id, t.name AS tenant_name,
       r.status, r.prompt, r.cost_usd, r.num_turns, r.duration_ms,
       r.total_input_tokens, r.total_output_tokens, r.error_type,
       r.started_at, r.completed_at, r.created_at
     FROM runs r
     JOIN agents a ON a.id = r.agent_id
     JOIN tenants t ON t.id = r.tenant_id
     ${where}
     ORDER BY r.created_at DESC
     LIMIT $${idx++} OFFSET $${idx}`,
    params,
  );

  return NextResponse.json({ data: runs, limit, offset });
}
