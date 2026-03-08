import { createSandbox, type SandboxInstance } from "@/lib/sandbox";
import { buildMcpConfig } from "@/lib/mcp";
import { fetchPluginContent } from "@/lib/plugins";
import { transitionRunStatus } from "@/lib/runs";
import { uploadTranscript } from "@/lib/transcripts";
import { processLineAssets } from "@/lib/assets";
import { generateRunToken } from "@/lib/crypto";
import { logger } from "@/lib/logger";
import { getEnv } from "@/lib/env";
import type { AgentInternal } from "@/lib/validation";
import type { RunId, RunStatus, TenantId } from "@/lib/types";

export interface RunExecutionParams {
  agent: AgentInternal;
  tenantId: TenantId;
  runId: RunId;
  prompt: string;
  platformApiUrl: string;
  effectiveBudget: number;
  effectiveMaxTurns: number;
  maxRuntimeSeconds: number;
}

const MAX_TRANSCRIPT_EVENTS = 10_000;

export interface RunExecutionResult {
  sandbox: SandboxInstance;
  logIterator: AsyncGenerator<string>;
  transcriptChunks: string[];
}

/**
 * Prepare a run for execution: build MCP config, create sandbox, transition to running.
 * Returns the sandbox and a log iterator that captures transcript chunks.
 * The caller is responsible for streaming/consuming the logs and calling finalizeRun.
 */
export async function prepareRunExecution(
  params: RunExecutionParams,
): Promise<RunExecutionResult> {
  const { agent, tenantId, runId, prompt, platformApiUrl, effectiveBudget, effectiveMaxTurns, maxRuntimeSeconds } = params;

  const [mcpResult, pluginResult] = await Promise.all([
    buildMcpConfig(agent, tenantId),
    fetchPluginContent(agent.plugins ?? []),
  ]);
  if (mcpResult.errors.length > 0) {
    logger.warn("MCP config errors", { run_id: runId, errors: mcpResult.errors });
  }
  if (pluginResult.warnings.length > 0) {
    logger.warn("Plugin fetch warnings", { run_id: runId, warnings: pluginResult.warnings });
  }

  const env = getEnv();
  const runToken = await generateRunToken(runId, env.ENCRYPTION_KEY);

  const sandbox = await createSandbox({
    agent: { ...agent, max_budget_usd: effectiveBudget, max_turns: effectiveMaxTurns },
    tenantId,
    runId,
    prompt,
    platformApiUrl,
    runToken,
    maxRuntimeSeconds,
    aiGatewayApiKey: env.AI_GATEWAY_API_KEY,
    mcpServers: mcpResult.servers,
    mcpErrors: mcpResult.errors,
    pluginFiles: [...pluginResult.skillFiles, ...pluginResult.commandFiles],
  });

  await transitionRunStatus(runId, tenantId, "pending", "running", {
    sandbox_id: sandbox.id,
    started_at: new Date().toISOString(),
  });

  const transcriptChunks: string[] = [];
  const logIterator = captureTranscript(sandbox.logs(), transcriptChunks, tenantId, runId);

  return { sandbox, logIterator, transcriptChunks };
}

/**
 * Finalize a run: persist transcript, update run status, stop sandbox.
 * Call this after the log iterator is fully consumed.
 */
export async function finalizeRun(
  runId: RunId,
  tenantId: TenantId,
  transcriptChunks: string[],
  sandbox: SandboxInstance,
  effectiveBudget: number,
): Promise<void> {
  try {
    if (transcriptChunks.length > 0) {
      const transcript = transcriptChunks.join("\n") + "\n";
      const blobUrl = await uploadTranscript(tenantId, runId, transcript);
      const lastLine = transcriptChunks[transcriptChunks.length - 1];
      const resultData = parseResultEvent(lastLine);

      await transitionRunStatus(
        runId,
        tenantId,
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
    await transitionRunStatus(runId, tenantId, "running", "failed", {
      completed_at: new Date().toISOString(),
      error_type: "transcript_persist_error",
      error_messages: [err instanceof Error ? err.message : String(err)],
    });
  } finally {
    await sandbox.stop();
  }
}

/**
 * Execute a run completely in the background (fire-and-forget).
 * Used by the cron executor where no streaming response is needed.
 */
export async function executeRunInBackground(
  params: RunExecutionParams,
): Promise<void> {
  const { runId, tenantId, effectiveBudget } = params;

  const { sandbox, logIterator, transcriptChunks } = await prepareRunExecution(params);

  try {
    // Consume all log output (no streaming to client)
    for await (const line of logIterator) {
      // logs are captured into transcriptChunks by captureTranscript
      void line;
    }
  } catch (err) {
    logger.error("Run execution error", {
      run_id: runId,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  await finalizeRun(runId, tenantId, transcriptChunks, sandbox, effectiveBudget);
}

async function* captureTranscript(
  source: AsyncIterable<string>,
  chunks: string[],
  tenantId: TenantId,
  runId: RunId,
): AsyncGenerator<string> {
  let truncated = false;
  for await (const line of source) {
    const trimmed = line.trim();
    if (trimmed) {
      if (truncated) {
        // After truncation, skip asset processing — lines won't be stored.
        // But always capture result/error events so finalizeRun gets billing data.
        try {
          const parsed = JSON.parse(trimmed);
          if (parsed.type === "result" || parsed.type === "error") {
            const processed = await processLineAssets(trimmed, tenantId, runId);
            chunks.push(processed);
            yield processed;
            continue;
          }
        } catch {
          // Not JSON, skip
        }
        yield trimmed;
      } else {
        const processed = await processLineAssets(trimmed, tenantId, runId);
        // text_delta events are streaming-only — don't store in transcript
        const isTextDelta = (() => { try { return JSON.parse(processed).type === "text_delta"; } catch { return false; } })();
        if (isTextDelta) {
          yield processed;
          continue;
        }
        if (chunks.length < MAX_TRANSCRIPT_EVENTS) {
          chunks.push(processed);
        } else {
          truncated = true;
          chunks.push(JSON.stringify({ type: "system", message: `Transcript truncated at ${MAX_TRANSCRIPT_EVENTS} events` }));
          logger.warn("Transcript truncated", { run_id: runId, max: MAX_TRANSCRIPT_EVENTS });
        }
        yield processed;
      }
    } else {
      yield line;
    }
  }
}

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
