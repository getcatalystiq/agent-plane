import { NextRequest, NextResponse } from "next/server";
import { queryOne, query, execute } from "@/db";
import { TenantRow, AgentRow, RunRow, TimezoneSchema } from "@/lib/validation";
import { withErrorHandler } from "@/lib/api";
import { z } from "zod";
import { removeToolkitConnections } from "@/lib/composio";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ tenantId: string }> };

export const GET = withErrorHandler(async (_request: NextRequest, context) => {
  const { tenantId } = await (context as RouteContext).params;

  const tenant = await queryOne(TenantRow, "SELECT * FROM tenants WHERE id = $1", [tenantId]);
  if (!tenant) {
    return NextResponse.json({ error: "Tenant not found" }, { status: 404 });
  }

  const agents = await query(
    AgentRow,
    "SELECT * FROM agents WHERE tenant_id = $1 ORDER BY created_at DESC",
    [tenantId],
  );

  const recentRuns = await query(
    RunRow,
    "SELECT * FROM runs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 20",
    [tenantId],
  );

  return NextResponse.json({ tenant, agents, recent_runs: recentRuns });
});

const UpdateTenantSchema = z.object({
  status: z.enum(["active", "suspended"]).optional(),
  monthly_budget_usd: z.number().min(0).optional(),
  name: z.string().min(1).max(255).optional(),
  timezone: TimezoneSchema.optional(),
  logo_url: z.string().max(500_000).nullable().optional(),
});

export const PATCH = withErrorHandler(async (request: NextRequest, context) => {
  const { tenantId } = await (context as RouteContext).params;
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
  if (input.timezone !== undefined) {
    sets.push(`timezone = $${idx++}`);
    params.push(input.timezone);
  }
  if (input.logo_url !== undefined) {
    sets.push(`logo_url = $${idx++}`);
    params.push(input.logo_url);
  }

  if (sets.length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  params.push(tenantId);
  await execute(`UPDATE tenants SET ${sets.join(", ")} WHERE id = $${idx}`, params);

  const tenant = await queryOne(TenantRow, "SELECT * FROM tenants WHERE id = $1", [tenantId]);
  return NextResponse.json(tenant);
});

export const DELETE = withErrorHandler(async (_request: NextRequest, context) => {
  const { tenantId } = await (context as RouteContext).params;

  const tenant = await queryOne(TenantRow, "SELECT * FROM tenants WHERE id = $1", [tenantId]);
  if (!tenant) {
    return NextResponse.json({ error: { message: "Tenant not found" } }, { status: 404 });
  }

  // Clean up Composio connections for all agents
  const agents = await query(AgentRow, "SELECT * FROM agents WHERE tenant_id = $1", [tenantId]);
  for (const agent of agents) {
    if (agent.composio_toolkits.length > 0) {
      removeToolkitConnections(tenantId, agent.composio_toolkits).catch(() => {});
    }
  }

  // Cascade delete in FK-safe order
  await execute("DELETE FROM mcp_connections WHERE agent_id IN (SELECT id FROM agents WHERE tenant_id = $1)", [tenantId]);
  await execute("DELETE FROM runs WHERE tenant_id = $1", [tenantId]);
  await execute("DELETE FROM sessions WHERE tenant_id = $1", [tenantId]);
  await execute("DELETE FROM agents WHERE tenant_id = $1", [tenantId]);
  await execute("DELETE FROM api_keys WHERE tenant_id = $1", [tenantId]);
  await execute("DELETE FROM tenants WHERE id = $1", [tenantId]);

  return NextResponse.json({ deleted: true });
});
