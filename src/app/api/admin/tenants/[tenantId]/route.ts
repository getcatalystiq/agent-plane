import { NextRequest, NextResponse } from "next/server";
import { queryOne, query, execute } from "@/db";
import { TenantRow, AgentRow, SessionMessageRow, TimezoneSchema } from "@/lib/validation";
import { withErrorHandler } from "@/lib/api";
import { encrypt } from "@/lib/crypto";
import { getEnv } from "@/lib/env";
import { invalidateAuthCache } from "@/lib/tenant-auth";
import { z } from "zod";
import { removeToolkitConnections } from "@/lib/composio";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ tenantId: string }> };

const TenantWithTokenFlag = TenantRow.extend({ has_subscription_token: z.boolean() });
const TENANT_SELECT = `SELECT id, name, slug, settings, monthly_budget_usd, status, current_month_spend,
       timezone, logo_url, subscription_base_url, subscription_token_expires_at,
       spend_period_start, created_at,
       subscription_token_enc IS NOT NULL AS has_subscription_token
FROM tenants WHERE id = $1`;

export const GET = withErrorHandler(async (_request: NextRequest, context) => {
  const { tenantId } = await (context as RouteContext).params;

  const tenant = await queryOne(TenantWithTokenFlag, TENANT_SELECT, [tenantId]);
  if (!tenant) {
    return NextResponse.json({ error: { code: "not_found", message: "Tenant not found" } }, { status: 404 });
  }

  const agents = await query(
    AgentRow,
    "SELECT * FROM agents WHERE tenant_id = $1 ORDER BY created_at DESC",
    [tenantId],
  );

  const recentMessages = await query(
    SessionMessageRow,
    `SELECT m.*, a.name AS agent_name, a.model AS agent_model, s.agent_id
     FROM session_messages m
     JOIN sessions s ON s.id = m.session_id
     JOIN agents a ON a.id = s.agent_id
     WHERE m.tenant_id = $1
     ORDER BY m.created_at DESC
     LIMIT 20`,
    [tenantId],
  );

  return NextResponse.json({ tenant, agents, recent_messages: recentMessages });
});

const UpdateTenantSchema = z.object({
  status: z.enum(["active", "suspended"]).optional(),
  monthly_budget_usd: z.number().min(0).optional(),
  name: z.string().min(1).max(255).optional(),
  timezone: TimezoneSchema.optional(),
  logo_url: z.string().max(500_000).nullable().optional(),
  subscription_token: z.string().trim().optional(),
  subscription_base_url: z.string().url().refine((url) => url.startsWith("https://"), "Must be HTTPS").nullable().optional(),
  subscription_token_expires_at: z.string().datetime().nullable().optional(),
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
  if (input.subscription_token !== undefined) {
    if (input.subscription_token === "") {
      // Clear token and related fields
      sets.push(`subscription_token_enc = $${idx++}`);
      params.push(null);
      sets.push(`subscription_base_url = $${idx++}`);
      params.push(null);
      sets.push(`subscription_token_expires_at = $${idx++}`);
      params.push(null);
    } else {
      const env = getEnv();
      const encrypted = await encrypt(input.subscription_token, env.ENCRYPTION_KEY);
      sets.push(`subscription_token_enc = $${idx++}`);
      params.push(JSON.stringify(encrypted));
    }
  }
  if (input.subscription_base_url !== undefined) {
    sets.push(`subscription_base_url = $${idx++}`);
    params.push(input.subscription_base_url);
  }
  if (input.subscription_token_expires_at !== undefined) {
    sets.push(`subscription_token_expires_at = $${idx++}`);
    params.push(input.subscription_token_expires_at);
  }

  if (sets.length === 0) {
    return NextResponse.json({ error: { code: "validation_error", message: "No fields to update" } }, { status: 400 });
  }

  params.push(tenantId);
  await execute(`UPDATE tenants SET ${sets.join(", ")} WHERE id = $${idx}`, params);

  // Invalidate auth cache if subscription token changed
  if (input.subscription_token !== undefined || input.subscription_base_url !== undefined) {
    invalidateAuthCache(tenantId);
  }

  const updated = await queryOne(TenantWithTokenFlag, TENANT_SELECT, [tenantId]);
  return NextResponse.json(updated);
});

export const DELETE = withErrorHandler(async (_request: NextRequest, context) => {
  const { tenantId } = await (context as RouteContext).params;

  const tenant = await queryOne(TenantRow, "SELECT * FROM tenants WHERE id = $1", [tenantId]);
  if (!tenant) {
    return NextResponse.json({ error: { code: "not_found", message: "Tenant not found" } }, { status: 404 });
  }

  // Clean up Composio connections for all agents
  const agents = await query(AgentRow, "SELECT * FROM agents WHERE tenant_id = $1", [tenantId]);
  for (const agent of agents) {
    if (agent.composio_toolkits.length > 0) {
      removeToolkitConnections(agent.id, agent.composio_toolkits).catch(() => {});
    }
  }

  // Cascade delete in FK-safe order. session_messages cascade from sessions.
  await execute("DELETE FROM mcp_connections WHERE agent_id IN (SELECT id FROM agents WHERE tenant_id = $1)", [tenantId]);
  await execute("DELETE FROM sessions WHERE tenant_id = $1", [tenantId]);
  await execute("DELETE FROM plugin_marketplaces WHERE tenant_id = $1", [tenantId]);
  await execute("DELETE FROM mcp_servers WHERE tenant_id = $1", [tenantId]);
  await execute("DELETE FROM agents WHERE tenant_id = $1", [tenantId]);
  await execute("DELETE FROM api_keys WHERE tenant_id = $1", [tenantId]);
  await execute("DELETE FROM tenants WHERE id = $1", [tenantId]);

  return NextResponse.json({ deleted: true });
});
