import { NextRequest } from "next/server";
import { after } from "next/server";
import { queryOne } from "@/db";
import { AgentRowInternal } from "@/lib/validation";
import { createRun, transitionRunStatus } from "@/lib/runs";
import { createSandbox } from "@/lib/sandbox";
import { buildMcpConfig } from "@/lib/mcp";
import { createNdjsonStream, ndjsonHeaders } from "@/lib/streaming";
import { uploadTranscript } from "@/lib/transcripts";
import { logger } from "@/lib/logger";
import { z } from "zod";
import type { AgentId, RunId, RunStatus, TenantId } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const PlaygroundRunSchema = z.object({
  prompt: z.string().min(1).max(100_000),
});

type RouteContext = { params: Promise<{ agentId: string }> };

export async function POST(request: NextRequest, context: RouteContext) {
  const { agentId } = await context.params;

  const agent = await queryOne(AgentRowInternal, "SELECT * FROM agents WHERE id = $1", [agentId]);
  if (!agent) {
    return new Response(JSON.stringify({ error: "Agent not found" }), { status: 404 });
  }

  const body = await request.json();
  const { prompt } = PlaygroundRunSchema.parse(body);

  const tenantId = agent.tenant_id as TenantId;
  const { run, agent: agentInternal } = await createRun(tenantId, agentId as AgentId, prompt);

  const runId = run.id as RunId;
  const transcriptChunks: string[] = [];

  try {
    const mcpResult = await buildMcpConfig(agentInternal, tenantId);
    if (mcpResult.errors.length > 0) {
      logger.warn("MCP config errors", { run_id: runId, errors: mcpResult.errors });
    }

    const sandbox = await createSandbox({
      agent: agentInternal,
      tenantId,
      runId,
      prompt,
      platformApiUrl: new URL(request.url).origin,
      aiGatewayApiKey: process.env.AI_GATEWAY_API_KEY!,
      ...(mcpResult.servers.composio ? { composioMcpUrl: mcpResult.servers.composio.url } : {}),
      mcpErrors: mcpResult.errors,
    });

    await transitionRunStatus(runId, tenantId, "pending", "running", {
      sandbox_id: sandbox.id,
      started_at: new Date().toISOString(),
    });

    const logIterator = captureTranscript(sandbox.logs(), transcriptChunks);
    const stream = createNdjsonStream({ runId, logIterator });

    after(async () => {
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
          });
        }
      } catch (err) {
        logger.error("Failed to persist playground run results", {
          run_id: runId,
          error: err instanceof Error ? err.message : String(err),
        });
        await transitionRunStatus(runId, tenantId, "running", "failed", {
          completed_at: new Date().toISOString(),
          error_type: "transcript_persist_error",
          error_messages: [err instanceof Error ? err.message : String(err)],
        });
      } finally {
        await sandbox.stop();
      }
    });

    return new Response(stream, { status: 200, headers: ndjsonHeaders() });
  } catch (err) {
    await transitionRunStatus(runId, tenantId, "pending", "failed", {
      completed_at: new Date().toISOString(),
      error_type: "sandbox_creation_error",
      error_messages: [err instanceof Error ? err.message : String(err)],
    });
    throw err;
  }
}

async function* captureTranscript(
  source: AsyncIterable<string>,
  chunks: string[],
): AsyncIterable<string> {
  for await (const line of source) {
    const trimmed = line.trim();
    if (trimmed) chunks.push(trimmed);
    yield line;
  }
}

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
          cost_usd: event.cost_usd,
          num_turns: event.num_turns,
          duration_ms: event.duration_ms,
          duration_api_ms: event.duration_api_ms,
          total_input_tokens: event.usage?.input_tokens,
          total_output_tokens: event.usage?.output_tokens,
          cache_read_tokens: event.usage?.cache_read_tokens,
          cache_creation_tokens: event.usage?.cache_creation_tokens,
          model_usage: event.model_usage,
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
