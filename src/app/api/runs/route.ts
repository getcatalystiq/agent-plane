import { NextRequest } from "next/server";
import { after } from "next/server";
import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { CreateRunSchema, PaginationSchema, RunRow } from "@/lib/validation";
import { createRun, transitionRunStatus, listRuns } from "@/lib/runs";
import { createSandbox } from "@/lib/sandbox";
import { buildMcpConfig } from "@/lib/mcp";
import { createNdjsonStream, ndjsonHeaders } from "@/lib/streaming";
import { uploadTranscript } from "@/lib/transcripts";
import { logger } from "@/lib/logger";
import type { AgentId, RunId, RunStatus } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300; // 5 min max for Vercel Pro

export const POST = withErrorHandler(async (request: NextRequest) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const body = await request.json();
  const input = CreateRunSchema.parse(body);

  // Create run record (with budget + concurrency checks)
  const { run, agent } = await createRun(
    auth.tenantId,
    input.agent_id as AgentId,
    input.prompt,
  );

  const runId = run.id as RunId;
  let transcriptChunks: string[] = [];

  try {
    // Build MCP config for Composio toolkits
    const mcpResult = await buildMcpConfig(agent, auth.tenantId);
    if (mcpResult.errors.length > 0) {
      logger.warn("MCP config errors", { run_id: runId, errors: mcpResult.errors });
    }

    // Create and start sandbox
    const sandbox = await createSandbox({
      agent,
      tenantId: auth.tenantId,
      runId,
      prompt: input.prompt,
      platformApiUrl: new URL(request.url).origin,
      aiGatewayApiKey: process.env.AI_GATEWAY_API_KEY!,
      ...(mcpResult.servers.composio ? { composioMcpUrl: mcpResult.servers.composio.url } : {}),
      mcpErrors: mcpResult.errors,
    });

    // Transition to running
    await transitionRunStatus(runId, auth.tenantId, "pending", "running", {
      sandbox_id: sandbox.id,
      started_at: new Date().toISOString(),
    });

    // Wrap sandbox logs to capture transcript
    const logIterator = captureTranscript(sandbox.logs(), transcriptChunks);

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
  const status = (url.searchParams.get("status") as RunStatus) ?? undefined;

  const runs = await listRuns(auth.tenantId, {
    agentId,
    status,
    ...pagination,
  });

  return jsonResponse({ data: runs, limit: pagination.limit, offset: pagination.offset });
});

// Capture transcript while iterating logs
async function* captureTranscript(
  source: AsyncIterable<string>,
  chunks: string[],
): AsyncIterable<string> {
  for await (const line of source) {
    const trimmed = line.trim();
    if (trimmed) {
      chunks.push(trimmed);
    }
    yield line;
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
    // Not valid JSON, ignore
  }
  return null;
}
