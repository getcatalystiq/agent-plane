import { NextRequest, NextResponse } from "next/server";
import { queryOne, query, execute, getPool } from "@/db";
import { AgentRow, RunRow, UpdateAgentSchema } from "@/lib/validation";
import { removeToolkitConnections } from "@/lib/composio";
import { withErrorHandler } from "@/lib/api";
import { z } from "zod";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ agentId: string }> };

export const GET = withErrorHandler(async (_request: NextRequest, context) => {
  const { agentId } = await (context as RouteContext).params;

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
});

export const PATCH = withErrorHandler(async (request: NextRequest, context) => {
  const { agentId } = await (context as RouteContext).params;
  const body = await request.json();
  const input = UpdateAgentSchema.parse(body);

  // Fetch current agent to detect removed toolkits before applying the update.
  const current = await queryOne(AgentRow, "SELECT * FROM agents WHERE id = $1", [agentId]);
  if (!current) {
    return NextResponse.json({ error: "Agent not found" }, { status: 404 });
  }

  // Validate marketplace_id references exist before writing
  if (input.plugins !== undefined && input.plugins.length > 0) {
    const marketplaceIds = [...new Set(input.plugins.map(p => p.marketplace_id))];
    const existing = await query(
      z.object({ id: z.string() }),
      "SELECT id FROM plugin_marketplaces WHERE id = ANY($1)",
      [marketplaceIds],
    );
    const existingIds = new Set(existing.map(r => r.id));
    const missing = marketplaceIds.filter(id => !existingIds.has(id));
    if (missing.length > 0) {
      return NextResponse.json(
        { error: { message: `Unknown marketplace_id(s): ${missing.join(", ")}` } },
        { status: 422 },
      );
    }
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
    ["max_runtime_seconds", "max_runtime_seconds"],
    ["composio_toolkits", "composio_toolkits"],
    ["composio_allowed_tools", "composio_allowed_tools"],
    ["skills", "skills", (v) => JSON.stringify(v)],
    ["plugins", "plugins", (v) => JSON.stringify(v)],
    ["a2a_enabled", "a2a_enabled"],
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

  // Use SELECT FOR UPDATE to prevent race with cron dispatcher claiming this agent
  sets.push(`updated_at = NOW()`);
  params.push(agentId);
  const pool = getPool();
  const client = await pool.connect();
  let updatedAgent;
  try {
    await client.query("BEGIN");
    await client.query("SELECT id FROM agents WHERE id = $1 FOR UPDATE", [agentId]);
    const result = await client.query(`UPDATE agents SET ${sets.join(", ")} WHERE id = $${idx} RETURNING *`, params);
    await client.query("COMMIT");
    updatedAgent = AgentRow.parse(result.rows[0]);
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  // Fire-and-forget: clean up Composio resources for removed toolkits.
  if (input.composio_toolkits !== undefined) {
    const newSet = new Set(input.composio_toolkits.map((t) => t.toLowerCase()));
    const removed = current.composio_toolkits.filter((t) => !newSet.has(t.toLowerCase()));
    if (removed.length > 0) {
      removeToolkitConnections(current.tenant_id, removed).catch(() => {});
    }
  }

  return NextResponse.json(updatedAgent);
});

export const DELETE = withErrorHandler(async (_request: NextRequest, context) => {
  const { agentId } = await (context as RouteContext).params;

  const agent = await queryOne(AgentRow, "SELECT * FROM agents WHERE id = $1", [agentId]);
  if (!agent) {
    return NextResponse.json({ error: { message: "Agent not found" } }, { status: 404 });
  }

  const runCount = await queryOne(
    z.object({ count: z.coerce.number() }),
    "SELECT COUNT(*)::int AS count FROM runs WHERE agent_id = $1 AND status IN ('pending', 'running')",
    [agentId],
  );

  if (runCount && runCount.count > 0) {
    return NextResponse.json(
      { error: { message: "Cannot delete agent with active runs" } },
      { status: 409 },
    );
  }

  // Clean up Composio connections
  if (agent.composio_toolkits.length > 0) {
    removeToolkitConnections(agent.tenant_id, agent.composio_toolkits).catch(() => {});
  }

  // Delete related data then the agent
  await execute("DELETE FROM mcp_connections WHERE agent_id = $1", [agentId]);
  await execute("DELETE FROM runs WHERE agent_id = $1", [agentId]);
  await execute("DELETE FROM agents WHERE id = $1", [agentId]);

  return NextResponse.json({ deleted: true });
});
