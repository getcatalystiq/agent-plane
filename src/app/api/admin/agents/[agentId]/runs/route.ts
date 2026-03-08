import { NextRequest } from "next/server";
import { queryOne } from "@/db";
import { AgentRowInternal } from "@/lib/validation";
import { createRun, transitionRunStatus } from "@/lib/runs";
import { logger } from "@/lib/logger";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { z } from "zod";
import type { AgentId, RunId, TenantId } from "@/lib/types";
import { ndjsonHeaders } from "@/lib/streaming";
import { prepareRunExecution, finalizeRun } from "@/lib/run-executor";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PlaygroundRunSchema = z.object({
  prompt: z.string().min(1).max(100_000),
});

type RouteContext = { params: Promise<{ agentId: string }> };

export const POST = withErrorHandler(async (request: NextRequest, context) => {
  const { agentId } = await (context as RouteContext).params;

  const agent = await queryOne(AgentRowInternal, "SELECT * FROM agents WHERE id = $1", [agentId]);
  if (!agent) {
    return jsonResponse({ error: { code: "not_found", message: "Agent not found" } }, 404);
  }

  const body = await request.json();
  const { prompt } = PlaygroundRunSchema.parse(body);

  const tenantId = agent.tenant_id as TenantId;
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  const emit = (event: Record<string, unknown>) =>
    writer.write(encoder.encode(JSON.stringify(event) + "\n"));

  (async () => {
    let runId: RunId | null = null;
    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
    // Detach before Vercel's maxDuration kills the function
    const DETACH_MS = (maxDuration - 15) * 1000;
    let detachTimer: ReturnType<typeof setTimeout> | null = null;
    let detached = false;

    const cleanup = () => {
      if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
      if (detachTimer) { clearTimeout(detachTimer); detachTimer = null; }
    };

    try {
      // Send heartbeats every 15s so the client knows we're alive
      heartbeatTimer = setInterval(async () => {
        try {
          await emit({ type: "heartbeat", timestamp: new Date().toISOString() });
        } catch { /* writer closed */ }
      }, 15_000);

      await emit({ type: "queued", timestamp: new Date().toISOString() });

      const { run, agent: agentInternal, remainingBudget } = await createRun(tenantId, agentId as AgentId, prompt, { triggeredBy: "playground" });
      runId = run.id as RunId;

      const effectiveBudget = Math.min(agentInternal.max_budget_usd, remainingBudget);

      await emit({ type: "sandbox_starting", run_id: runId, timestamp: new Date().toISOString() });

      const { sandbox, logIterator, transcriptChunks } = await prepareRunExecution({
        agent: agentInternal,
        tenantId,
        runId,
        prompt,
        platformApiUrl: new URL(request.url).origin,
        effectiveBudget,
        effectiveMaxTurns: agentInternal.max_turns,
        maxRuntimeSeconds: agentInternal.max_runtime_seconds,
      });

      // Set up stream detach before function timeout
      detachTimer = setTimeout(async () => {
        detached = true;
        cleanup();
        try {
          await emit({
            type: "stream_detached",
            run_id: runId,
            poll_url: `/api/admin/runs/${runId}`,
            timestamp: new Date().toISOString(),
          });
        } catch { /* writer closed */ }
        await writer.close().catch(() => {});
      }, DETACH_MS);

      try {
        for await (const line of logIterator) {
          if (detached) break;
          const trimmed = line.trim();
          if (trimmed) {
            let parsed: Record<string, unknown>;
            try {
              parsed = JSON.parse(trimmed);
            } catch {
              logger.debug("Non-JSON sandbox output", { run_id: runId, line: trimmed.slice(0, 200) });
              continue;
            }
            await emit(parsed);
          }
        }
      } finally {
        if (!detached) {
          await finalizeRun(runId, tenantId, transcriptChunks, sandbox, effectiveBudget);
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error("Playground run failed", { run_id: runId, error: msg });
      try {
        await emit({ type: "error", error: msg, timestamp: new Date().toISOString() });
        if (runId) {
          await transitionRunStatus(runId, tenantId, "pending", "failed", {
            completed_at: new Date().toISOString(),
            error_type: "sandbox_creation_error",
            error_messages: [msg],
          });
        }
      } catch { /* writer may already be closed */ }
    } finally {
      cleanup();
      if (!detached) {
        await writer.close().catch(() => {});
      }
    }
  })();

  return new Response(readable, { status: 200, headers: ndjsonHeaders() });
});
