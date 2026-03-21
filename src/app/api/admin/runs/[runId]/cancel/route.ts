import { NextRequest, NextResponse } from "next/server";
import { queryOne } from "@/db";
import { RunRow } from "@/lib/validation";
import { withErrorHandler } from "@/lib/api";
import { transitionRunStatus } from "@/lib/runs";
import { reconnectSandbox } from "@/lib/sandbox";
import { logger } from "@/lib/logger";
import type { RunId, TenantId } from "@/lib/types";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ runId: string }> };

export const POST = withErrorHandler(async (_request: NextRequest, context) => {
  const { runId } = await (context as RouteContext).params;

  const run = await queryOne(RunRow, "SELECT * FROM runs WHERE id = $1", [runId]);
  if (!run) {
    return NextResponse.json({ error: { code: "not_found", message: "Run not found" } }, { status: 404 });
  }

  if (run.status !== "running" && run.status !== "pending") {
    return NextResponse.json(
      { error: { code: "conflict", message: `Run is ${run.status}, cannot cancel` } },
      { status: 409 },
    );
  }

  // Stop the sandbox
  if (run.sandbox_id) {
    try {
      const sandbox = await reconnectSandbox(run.sandbox_id);
      if (sandbox) {
        await sandbox.stop();
        logger.info("Sandbox stopped for admin cancellation", {
          run_id: runId,
          sandbox_id: run.sandbox_id,
        });
      }
    } catch (err) {
      logger.warn("Failed to stop sandbox during admin cancellation", {
        run_id: runId,
        sandbox_id: run.sandbox_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  const transitioned = await transitionRunStatus(
    runId as RunId,
    run.tenant_id as TenantId,
    run.status,
    "cancelled",
    { completed_at: new Date().toISOString() },
  );

  if (!transitioned) {
    return NextResponse.json(
      { error: { code: "conflict", message: "Run status changed during cancellation" } },
      { status: 409 },
    );
  }

  logger.info("Run cancelled by admin", { run_id: runId });
  return NextResponse.json({ cancelled: true });
});
