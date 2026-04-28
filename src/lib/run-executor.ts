import { createSandbox, type SandboxInstance } from "@/lib/sandbox";
import { buildMcpConfig, type CallbackData } from "@/lib/mcp";
import { fetchPluginContent } from "@/lib/plugins";
import { resolveSandboxAuth } from "@/lib/tenant-auth";
import { resolveEffectiveRunner } from "@/lib/models";
import { transitionRunStatus } from "@/lib/runs";
import { uploadTranscript } from "@/lib/transcripts";
import { generateRunToken } from "@/lib/crypto";
import { parseResultEvent, captureTranscript, NO_TERMINAL_EVENT_FALLBACK } from "@/lib/transcript-utils";
import { logger } from "@/lib/logger";
import { getEnv } from "@/lib/env";
import type { AgentInternal } from "@/lib/validation";
import type { RunId, TenantId } from "@/lib/types";

export interface RunExecutionParams {
  agent: AgentInternal;
  tenantId: TenantId;
  runId: RunId;
  prompt: string;
  platformApiUrl: string;
  effectiveBudget: number;
  effectiveMaxTurns: number;
  maxRuntimeSeconds: number;
  /** Additional hostnames to allow in the sandbox network policy (e.g. A2A callback URLs). */
  extraAllowedHostnames?: string[];
  /** AgentCo callback data for MCP bridge injection. */
  callbackData?: CallbackData;
}

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
  const { agent, tenantId, runId, prompt, platformApiUrl, effectiveBudget, effectiveMaxTurns, maxRuntimeSeconds, extraAllowedHostnames, callbackData } = params;

  const effectiveRunner = resolveEffectiveRunner(agent.model, agent.runner);
  const [mcpResult, pluginResult, auth] = await Promise.all([
    buildMcpConfig(agent, tenantId),
    fetchPluginContent(agent.plugins ?? []),
    resolveSandboxAuth(tenantId as TenantId, effectiveRunner),
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
    auth,
    mcpServers: mcpResult.servers,
    mcpErrors: mcpResult.errors,
    pluginFiles: [...pluginResult.skillFiles, ...pluginResult.agentFiles],
    extraAllowedHostnames: [...(extraAllowedHostnames ?? []), ...auth.extraAllowedHostnames],
    callbackData,
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
      const resultData = (await parseResultEvent(lastLine)) ?? NO_TERMINAL_EVENT_FALLBACK;

      await transitionRunStatus(
        runId,
        tenantId,
        "running",
        resultData.status,
        {
          completed_at: new Date().toISOString(),
          transcript_blob_url: blobUrl,
          ...resultData.updates,
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

// captureTranscript and parseResultEvent are imported from @/lib/transcript-utils
