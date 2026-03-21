import { NextRequest, NextResponse } from "next/server";
import { queryOne, execute } from "@/db";
import { ScheduleRow, ScheduleInputSchema, TenantRow } from "@/lib/validation";
import { withErrorHandler } from "@/lib/api";
import { computeNextRunAt, buildScheduleConfig } from "@/lib/schedule";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ agentId: string; scheduleId: string }> };

// GET /api/admin/agents/:agentId/schedules/:scheduleId
export const GET = withErrorHandler(async (_request: NextRequest, context) => {
  const { agentId, scheduleId } = await (context as RouteContext).params;

  const schedule = await queryOne(
    ScheduleRow,
    "SELECT * FROM schedules WHERE id = $1 AND agent_id = $2",
    [scheduleId, agentId],
  );

  if (!schedule) {
    return NextResponse.json({ error: { code: "not_found", message: "Schedule not found" } }, { status: 404 });
  }

  return NextResponse.json(schedule);
});

// PATCH /api/admin/agents/:agentId/schedules/:scheduleId
export const PATCH = withErrorHandler(async (request: NextRequest, context) => {
  const { agentId, scheduleId } = await (context as RouteContext).params;
  const body = await request.json();
  const input = ScheduleInputSchema.parse(body);

  // Verify schedule exists and get tenant_id for timezone lookup
  const existing = await queryOne(
    ScheduleRow,
    "SELECT * FROM schedules WHERE id = $1 AND agent_id = $2",
    [scheduleId, agentId],
  );
  if (!existing) {
    return NextResponse.json({ error: { code: "not_found", message: "Schedule not found" } }, { status: 404 });
  }

  // Recompute next_run_at
  let nextRunAt: Date | null = null;
  if (input.enabled && input.frequency !== "manual") {
    const tenant = await queryOne(TenantRow, "SELECT * FROM tenants WHERE id = $1", [existing.tenant_id]);
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

  const updatedSchedule = await queryOne(
    ScheduleRow,
    `UPDATE schedules
     SET name = $1, frequency = $2, time = $3, day_of_week = $4,
         prompt = $5, enabled = $6, next_run_at = $7
     WHERE id = $8 AND agent_id = $9
     RETURNING *`,
    [input.name ?? null, input.frequency, input.time, input.day_of_week,
     input.prompt, input.enabled, nextRunAt?.toISOString() ?? null,
     scheduleId, agentId],
  );

  if (!updatedSchedule) {
    return NextResponse.json({ error: { code: "not_found", message: "Schedule not found" } }, { status: 404 });
  }

  return NextResponse.json(updatedSchedule);
});

// DELETE /api/admin/agents/:agentId/schedules/:scheduleId
export const DELETE = withErrorHandler(async (_request: NextRequest, context) => {
  const { agentId, scheduleId } = await (context as RouteContext).params;

  const result = await execute(
    "DELETE FROM schedules WHERE id = $1 AND agent_id = $2",
    [scheduleId, agentId],
  );

  if (result.rowCount === 0) {
    return NextResponse.json({ error: { code: "not_found", message: "Schedule not found" } }, { status: 404 });
  }

  return NextResponse.json({ deleted: true });
});
