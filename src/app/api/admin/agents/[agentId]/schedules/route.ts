import { NextRequest, NextResponse } from "next/server";
import { query, queryOne } from "@/db";
import { ScheduleRow, ScheduleInputSchema, TenantRow, AgentRow } from "@/lib/validation";
import { z } from "zod";
import { withErrorHandler } from "@/lib/api";
import { generateId } from "@/lib/crypto";
import { computeNextRunAt, buildScheduleConfig } from "@/lib/schedule";

export const dynamic = "force-dynamic";

const MAX_SCHEDULES_PER_AGENT = 20;

type RouteContext = { params: Promise<{ agentId: string }> };

// GET /api/admin/agents/:agentId/schedules — list schedules for an agent
export const GET = withErrorHandler(async (_request: NextRequest, context) => {
  const { agentId } = await (context as RouteContext).params;

  // Verify agent exists (consistent with POST handler)
  const agent = await queryOne(z.object({ id: z.string() }), "SELECT id FROM agents WHERE id = $1", [agentId]);
  if (!agent) {
    return NextResponse.json({ error: { code: "not_found", message: "Agent not found" } }, { status: 404 });
  }

  const schedules = await query(
    ScheduleRow,
    "SELECT * FROM schedules WHERE agent_id = $1 ORDER BY created_at ASC",
    [agentId],
  );

  return NextResponse.json(schedules);
});

// POST /api/admin/agents/:agentId/schedules — create a new schedule
export const POST = withErrorHandler(async (request: NextRequest, context) => {
  const { agentId } = await (context as RouteContext).params;
  const body = await request.json();
  const input = ScheduleInputSchema.parse(body);

  // Verify agent exists and get tenant_id
  const agent = await queryOne(AgentRow, "SELECT * FROM agents WHERE id = $1", [agentId]);
  if (!agent) {
    return NextResponse.json({ error: { code: "not_found", message: "Agent not found" } }, { status: 404 });
  }

  // Compute next_run_at if enabled
  let nextRunAt: Date | null = null;
  if (input.enabled && input.frequency !== "manual") {
    const tenant = await queryOne(TenantRow, "SELECT * FROM tenants WHERE id = $1", [agent.tenant_id]);
    const timezone = tenant?.timezone ?? "UTC";
    try {
      const config = buildScheduleConfig(input.frequency, input.time, input.day_of_week);
      nextRunAt = computeNextRunAt(config, timezone);
    } catch (err) {
      return NextResponse.json(
        { error: { code: "validation_error", message: `Invalid schedule configuration: ${err instanceof Error ? err.message : String(err)}` } },
        { status: 422 },
      );
    }
  }

  // Atomic insert with schedule count guard (prevents TOCTOU race)
  const id = generateId();
  const schedule = await queryOne(
    ScheduleRow,
    `INSERT INTO schedules (id, tenant_id, agent_id, name, frequency, time, day_of_week, prompt, enabled, next_run_at)
     SELECT $1, $2, $3, $4, $5, $6, $7, $8, $9, $10
     WHERE (SELECT COUNT(*) FROM schedules WHERE agent_id = $3) < $11
     RETURNING *`,
    [id, agent.tenant_id, agentId, input.name ?? null, input.frequency, input.time, input.day_of_week, input.prompt, input.enabled, nextRunAt?.toISOString() ?? null, MAX_SCHEDULES_PER_AGENT],
  );

  if (!schedule) {
    return NextResponse.json(
      { error: { code: "validation_error", message: `Maximum ${MAX_SCHEDULES_PER_AGENT} schedules per agent` } },
      { status: 422 },
    );
  }

  return NextResponse.json(schedule, { status: 201 });
});
