import { NextRequest } from "next/server";
import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { getRun, transitionRunStatus } from "@/lib/runs";
import { reconnectSandbox } from "@/lib/sandbox";
import { logger } from "@/lib/logger";
import type { RunId } from "@/lib/types";

export const dynamic = "force-dynamic";

export const POST = withErrorHandler(async (request: NextRequest, context) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const { runId } = await context!.params;

  const run = await getRun(runId, auth.tenantId);

  if (run.status !== "running" && run.status !== "pending") {
    return jsonResponse(
      { error: { code: "invalid_state", message: `Run is ${run.status}, cannot cancel` } },
      409,
    );
  }

  // Try to stop the sandbox
  if (run.sandbox_id) {
    const sandbox = await reconnectSandbox(run.sandbox_id);
    if (sandbox) {
      await sandbox.stop();
      logger.info("Sandbox stopped for cancellation", {
        run_id: runId,
        sandbox_id: run.sandbox_id,
      });
    }
  }

  const transitioned = await transitionRunStatus(
    runId as RunId,
    auth.tenantId,
    run.status,
    "cancelled",
    { completed_at: new Date().toISOString() },
  );

  if (!transitioned) {
    return jsonResponse(
      { error: { code: "conflict", message: "Run status changed during cancellation" } },
      409,
    );
  }

  logger.info("Run cancelled", { run_id: runId, tenant_id: auth.tenantId });
  return jsonResponse({ cancelled: true });
});
