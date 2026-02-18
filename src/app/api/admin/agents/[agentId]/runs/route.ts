import { NextRequest } from "next/server";
import { queryOne } from "@/db";
import { AgentRowInternal } from "@/lib/validation";
import { createRun, transitionRunStatus } from "@/lib/runs";
import { createSandbox } from "@/lib/sandbox";
import { buildMcpConfig } from "@/lib/mcp";
import { uploadTranscript } from "@/lib/transcripts";
import { processLineAssets } from "@/lib/assets";
import { logger } from "@/lib/logger";
import { getEnv } from "@/lib/env";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { z } from "zod";
import type { AgentId, RunId, RunStatus, TenantId } from "@/lib/types";
import { ndjsonHeaders } from "@/lib/streaming";

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

  // Run all async work in the background — response starts streaming immediately
  (async () => {
    const transcriptChunks: string[] = [];
    let runId: RunId | null = null;

    try {
      await emit({ type: "queued", timestamp: new Date().toISOString() });

      const { run, agent: agentInternal, remainingBudget } = await createRun(tenantId, agentId as AgentId, prompt);
      runId = run.id as RunId;

      // Cap per-run budget to remaining tenant budget
      const effectiveBudget = Math.min(agentInternal.max_budget_usd, remainingBudget);

      await emit({ type: "sandbox_starting", run_id: runId, timestamp: new Date().toISOString() });

      const mcpResult = await buildMcpConfig(agentInternal, tenantId);

      const sandbox = await createSandbox({
        agent: { ...agentInternal, max_budget_usd: effectiveBudget },
        tenantId,
        runId,
        prompt,
        platformApiUrl: new URL(request.url).origin,
        aiGatewayApiKey: getEnv().AI_GATEWAY_API_KEY,
        mcpServers: mcpResult.servers,
        mcpErrors: mcpResult.errors,
      });

      await transitionRunStatus(runId, tenantId, "pending", "running", {
        sandbox_id: sandbox.id,
        started_at: new Date().toISOString(),
      });

      try {
        for await (const line of sandbox.logs()) {
          const trimmed = line.trim();
          if (trimmed) {
            // Persist ephemeral asset URLs to Blob before processing
            const processed = await processLineAssets(trimmed, tenantId, runId!);
            let parsed: Record<string, unknown>;
            try {
              parsed = JSON.parse(processed);
            } catch {
              // Non-JSON output from sandbox (stderr, install noise, etc.) — skip
              logger.debug("Non-JSON sandbox output", { run_id: runId, line: processed.slice(0, 200) });
              continue;
            }
            // text_delta events are streaming-only — not stored in transcript
            if (parsed.type !== "text_delta") transcriptChunks.push(processed);
            await emit(parsed);
          }
        }
      } finally {
        // Persist transcript and finalize run status
        try {
          if (transcriptChunks.length > 0) {
            const transcript = transcriptChunks.join("\n") + "\n";
            const blobUrl = await uploadTranscript(tenantId, runId, transcript);
            const lastLine = transcriptChunks[transcriptChunks.length - 1];
            const resultData = parseResultEvent(lastLine);

            await transitionRunStatus(runId, tenantId, "running", resultData?.status ?? "completed", {
              completed_at: new Date().toISOString(),
              transcript_blob_url: blobUrl,
              ...resultData?.updates,
            }, { expectedMaxBudgetUsd: effectiveBudget });
          }
        } catch (persistErr) {
          logger.error("Failed to persist playground run results", {
            run_id: runId,
            error: persistErr instanceof Error ? persistErr.message : String(persistErr),
          });
          await transitionRunStatus(runId, tenantId, "running", "failed", {
            completed_at: new Date().toISOString(),
            error_type: "transcript_persist_error",
            error_messages: [persistErr instanceof Error ? persistErr.message : String(persistErr)],
          });
        } finally {
          await sandbox.stop();
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
      await writer.close().catch(() => {});
    }
  })();

  return new Response(readable, { status: 200, headers: ndjsonHeaders() });
});

function parseResultEvent(line: string): {
  status: RunStatus;
  updates: Record<string, unknown>;
} | null {
  try {
    const event = JSON.parse(line);
    if (event.type === "result") {
      return {
        status: event.subtype === "success" ? "completed" : "failed",
        updates: {
          result_summary: event.subtype,
          cost_usd: event.total_cost_usd,
          num_turns: event.num_turns,
          duration_ms: event.duration_ms,
          duration_api_ms: event.duration_api_ms,
          total_input_tokens: event.usage?.input_tokens,
          total_output_tokens: event.usage?.output_tokens,
          cache_read_tokens: event.usage?.cache_read_input_tokens,
          cache_creation_tokens: event.usage?.cache_creation_input_tokens,
          model_usage: event.modelUsage,
        },
      };
    }
    if (event.type === "error") {
      return {
        status: "failed",
        updates: {
          error_type: event.code || "execution_error",
          error_messages: [event.error],
        },
      };
    }
  } catch {
    // Not valid JSON
  }
  return null;
}
