import { NextRequest, NextResponse } from "next/server";
import { queryOne, execute } from "@/db";
import { TenantRow, AgentRow, RunRow } from "@/lib/validation";
import { z } from "zod";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ tenantId: string }> };

export async function GET(_request: NextRequest, context: RouteContext) {
  const { tenantId } = await context.params;

  const tenant = await queryOne(TenantRow, "SELECT * FROM tenants WHERE id = $1", [tenantId]);
  if (!tenant) {
    return NextResponse.json({ error: "Tenant not found" }, { status: 404 });
  }

  const agents = await import("@/db").then(({ query }) =>
    query(AgentRow, "SELECT * FROM agents WHERE tenant_id = $1 ORDER BY created_at DESC", [tenantId]),
  );

  const recentRuns = await import("@/db").then(({ query }) =>
    query(RunRow, "SELECT * FROM runs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 20", [tenantId]),
  );

  return NextResponse.json({ tenant, agents, recent_runs: recentRuns });
}

const UpdateTenantSchema = z.object({
  status: z.enum(["active", "suspended"]).optional(),
  monthly_budget_usd: z.number().min(0).optional(),
  name: z.string().min(1).max(255).optional(),
});

export async function PATCH(request: NextRequest, context: RouteContext) {
  const { tenantId } = await context.params;
  const body = await request.json();
  const input = UpdateTenantSchema.parse(body);

  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  if (input.status !== undefined) {
    sets.push(`status = $${idx++}`);
    params.push(input.status);
  }
  if (input.monthly_budget_usd !== undefined) {
    sets.push(`monthly_budget_usd = $${idx++}`);
    params.push(input.monthly_budget_usd);
  }
  if (input.name !== undefined) {
    sets.push(`name = $${idx++}`);
    params.push(input.name);
  }

  if (sets.length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  params.push(tenantId);
  await execute(`UPDATE tenants SET ${sets.join(", ")} WHERE id = $${idx}`, params);

  const tenant = await queryOne(TenantRow, "SELECT * FROM tenants WHERE id = $1", [tenantId]);
  return NextResponse.json(tenant);
}
