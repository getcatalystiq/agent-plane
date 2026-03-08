import { NextRequest } from "next/server";
import { after } from "next/server";
import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { CreateRunSchema, PaginationSchema, RunStatusSchema } from "@/lib/validation";
import { createRun, transitionRunStatus, listRuns } from "@/lib/runs";
import { createNdjsonStream, ndjsonHeaders } from "@/lib/streaming";
import { logger } from "@/lib/logger";
import { prepareRunExecution, finalizeRun } from "@/lib/run-executor";
import type { AgentId, RunId } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 min max for Vercel Pro

export const POST = withErrorHandler(async (request: NextRequest) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const body = await request.json();
  const input = CreateRunSchema.parse(body);

  // Create run record (with budget + concurrency checks)
  const { run, agent, remainingBudget } = await createRun(
    auth.tenantId,
    input.agent_id as AgentId,
    input.prompt,
    { triggeredBy: "api" },
  );

  // Apply per-run overrides capped to agent config and remaining tenant budget
  const effectiveBudget = Math.min(
    input.max_budget_usd ?? agent.max_budget_usd,
    agent.max_budget_usd,
    remainingBudget,
  );
  const effectiveMaxTurns = Math.min(
    input.max_turns ?? agent.max_turns,
    agent.max_turns,
  );

  const runId = run.id as RunId;

  try {
    const { sandbox, logIterator, transcriptChunks } = await prepareRunExecution({
      agent,
      tenantId: auth.tenantId,
      runId,
      prompt: input.prompt,
      platformApiUrl: new URL(request.url).origin,
      effectiveBudget,
      effectiveMaxTurns,
      maxRuntimeSeconds: agent.max_runtime_seconds,
    });

    // Track whether the stream detached (long-running run)
    let detached = false;

    // Create pull-based NDJSON stream
    const stream = createNdjsonStream({
      runId,
      logIterator,
      onDetach: () => {
        detached = true;
        logger.info("Stream detached for long-running run", { run_id: runId });
      },
    });

    // Use after() to persist transcript after response closes.
    // If the stream detached, the sandbox is still running and will
    // self-finalize via /api/internal/runs/:id/transcript when done.
    after(async () => {
      if (!detached) {
        await finalizeRun(runId, auth.tenantId, transcriptChunks, sandbox, effectiveBudget);
      }
    });

    return new Response(stream, {
      status: 200,
      headers: ndjsonHeaders(),
    });
  } catch (err) {
    // Sandbox creation failed
    await transitionRunStatus(runId, auth.tenantId, "pending", "failed", {
      completed_at: new Date().toISOString(),
      error_type: "sandbox_creation_error",
      error_messages: [err instanceof Error ? err.message : String(err)],
    });
    throw err;
  }
});

export const GET = withErrorHandler(async (request: NextRequest) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const url = new URL(request.url);
  const pagination = PaginationSchema.parse({
    limit: url.searchParams.get("limit"),
    offset: url.searchParams.get("offset"),
  });
  const agentId = url.searchParams.get("agent_id") ?? undefined;
  const statusParam = url.searchParams.get("status");
  const status = statusParam ? RunStatusSchema.parse(statusParam) : undefined;

  const runs = await listRuns(auth.tenantId, {
    agentId,
    status,
    ...pagination,
  });

  return jsonResponse({ data: runs, limit: pagination.limit, offset: pagination.offset });
});
