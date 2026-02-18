import { NextRequest, NextResponse } from "next/server";
import { queryOne, query, execute } from "@/db";
import { AgentRow, RunRow, UpdateAgentSchema } from "@/lib/validation";
import { removeToolkitConnections } from "@/lib/composio";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ agentId: string }> };

export async function GET(_request: NextRequest, context: RouteContext) {
  const { agentId } = await context.params;

  const agent = await queryOne(AgentRow, "SELECT * FROM agents WHERE id = $1", [agentId]);
  if (!agent) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  const recentRuns = await query(
    RunRow,
    "SELECT * FROM runs WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 20",
    [agentId],
  );

  return NextResponse.json({ agent, recent_runs: recentRuns });
}

export async function PATCH(request: NextRequest, context: RouteContext) {
  const { agentId } = await context.params;
  const body = await request.json();
  const input = UpdateAgentSchema.parse(body);

  // Fetch current agent to detect removed toolkits before applying the update.
  const current = await queryOne(AgentRow, "SELECT * FROM agents WHERE id = $1", [agentId]);
  if (!current) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  const sets: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  const fieldMap: Array<[keyof typeof input, string, ((v: unknown) => unknown)?]> = [
    ["name", "name"],
    ["description", "description"],
    ["model", "model"],
    ["permission_mode", "permission_mode"],
    ["max_turns", "max_turns"],
    ["max_budget_usd", "max_budget_usd"],
    ["composio_toolkits", "composio_toolkits", (v) => {
      // Clear MCP cache when toolkits change
      sets.push(`composio_mcp_server_id = NULL`);
      sets.push(`composio_mcp_server_name = NULL`);
      sets.push(`composio_mcp_url = NULL`);
      sets.push(`composio_mcp_api_key_enc = NULL`);
      return v;
    }],
    ["skills", "skills", (v) => JSON.stringify(v)],
  ];

  for (const [field, col, transform] of fieldMap) {
    if (input[field] !== undefined) {
      const val = transform ? transform(input[field]) : input[field];
      sets.push(`${col} = $${idx++}`);
      params.push(val);
    }
  }

  if (sets.length === 0) {
    return NextResponse.json({ error: "No fields to update" }, { status: 400 });
  }

  sets.push(`updated_at = NOW()`);
  params.push(agentId);
  await execute(`UPDATE agents SET ${sets.join(", ")} WHERE id = $${idx}`, params);

  // Fire-and-forget: clean up Composio resources for removed toolkits.
  if (input.composio_toolkits !== undefined) {
    const newSet = new Set(input.composio_toolkits.map((t) => t.toLowerCase()));
    const removed = current.composio_toolkits.filter((t) => !newSet.has(t.toLowerCase()));
    if (removed.length > 0) {
      removeToolkitConnections(current.tenant_id, removed).catch(() => {});
    }
  }

  const agent = await queryOne(AgentRow, "SELECT * FROM agents WHERE id = $1", [agentId]);
  return NextResponse.json(agent);
}
