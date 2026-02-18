import { NextRequest } from "next/server";
import { after } from "next/server";
import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { CreateRunSchema, PaginationSchema, RunStatusSchema } from "@/lib/validation";
import { createRun, transitionRunStatus, listRuns } from "@/lib/runs";
import { createSandbox } from "@/lib/sandbox";
import { buildMcpConfig } from "@/lib/mcp";
import { fetchPluginContent } from "@/lib/plugins";
import { createNdjsonStream, ndjsonHeaders } from "@/lib/streaming";
import { uploadTranscript } from "@/lib/transcripts";
import { processLineAssets } from "@/lib/assets";
import { logger } from "@/lib/logger";
import { getEnv } from "@/lib/env";
import type { AgentId, RunId, RunStatus } from "@/lib/types";

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
  const transcriptChunks: string[] = [];

  try {
    // Build MCP config and fetch plugin content in parallel
    const [mcpResult, pluginResult] = await Promise.all([
      buildMcpConfig(agent, auth.tenantId),
      fetchPluginContent(agent.plugins ?? []),
    ]);
    if (mcpResult.errors.length > 0) {
      logger.warn("MCP config errors", { run_id: runId, errors: mcpResult.errors });
    }
    if (pluginResult.warnings.length > 0) {
      logger.warn("Plugin fetch warnings", { run_id: runId, warnings: pluginResult.warnings });
    }

    // Create and start sandbox with effective budget/turns
    const sandbox = await createSandbox({
      agent: { ...agent, max_budget_usd: effectiveBudget, max_turns: effectiveMaxTurns },
      tenantId: auth.tenantId,
      runId,
      prompt: input.prompt,
      platformApiUrl: new URL(request.url).origin,
      aiGatewayApiKey: getEnv().AI_GATEWAY_API_KEY,
      mcpServers: mcpResult.servers,
      mcpErrors: mcpResult.errors,
      pluginFiles: [...pluginResult.skillFiles, ...pluginResult.commandFiles],
    });

    // Transition to running
    await transitionRunStatus(runId, auth.tenantId, "pending", "running", {
      sandbox_id: sandbox.id,
      started_at: new Date().toISOString(),
    });

    // Wrap sandbox logs to capture transcript (with asset URL persistence)
    const logIterator = captureTranscript(
      sandbox.logs(),
      transcriptChunks,
      auth.tenantId,
      runId,
    );

    // Create pull-based NDJSON stream
    const stream = createNdjsonStream({
      runId,
      logIterator,
      onDetach: () => {
        logger.info("Stream detached for long-running run", { run_id: runId });
      },
    });

    // Use after() to persist transcript after response closes
    after(async () => {
      try {
        if (transcriptChunks.length > 0) {
          const transcript = transcriptChunks.join("\n") + "\n";
          const blobUrl = await uploadTranscript(auth.tenantId, runId, transcript);

          // Parse the last line for result data
          const lastLine = transcriptChunks[transcriptChunks.length - 1];
          const resultData = parseResultEvent(lastLine);

          await transitionRunStatus(
            runId,
            auth.tenantId,
            "running",
            resultData?.status ?? "completed",
            {
              completed_at: new Date().toISOString(),
              transcript_blob_url: blobUrl,
              ...resultData?.updates,
            },
            { expectedMaxBudgetUsd: effectiveBudget },
          );
        }
      } catch (err) {
        logger.error("Failed to persist run results", {
          run_id: runId,
          error: err instanceof Error ? err.message : String(err),
        });
        await transitionRunStatus(runId, auth.tenantId, "running", "failed", {
          completed_at: new Date().toISOString(),
          error_type: "transcript_persist_error",
          error_messages: [err instanceof Error ? err.message : String(err)],
        });
      } finally {
        await sandbox.stop();
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

// Capture transcript while iterating logs, persisting ephemeral asset URLs to Blob
async function* captureTranscript(
  source: AsyncIterable<string>,
  chunks: string[],
  tenantId: string,
  runId: string,
): AsyncIterable<string> {
  for await (const line of source) {
    const trimmed = line.trim();
    if (trimmed) {
      const processed = await processLineAssets(trimmed, tenantId, runId);
      chunks.push(processed);
      yield processed;
    } else {
      yield line;
    }
  }
}

// Parse the result event from the last NDJSON line
function parseResultEvent(line: string): {
  status: RunStatus;
  updates: Record<string, unknown>;
} | null {
  try {
    const event = JSON.parse(line);
    if (event.type === "result") {
      const status: RunStatus =
        event.subtype === "success" ? "completed" : "failed";
      return {
        status,
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
    // Not valid JSON, ignore
  }
  return null;
}
