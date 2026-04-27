import {
  createSessionSandbox,
  reconnectSessionSandbox,
  type SessionSandboxInstance,
  type SessionSandboxConfig,
} from "@/lib/sandbox";
import { buildMcpConfig, type McpBuildResult } from "@/lib/mcp";
import { fetchPluginContent, type PluginFileSet } from "@/lib/plugins";
import { resolveSandboxAuth } from "@/lib/tenant-auth";
import { resolveEffectiveRunner } from "@/lib/models";
import { createRun, transitionRunStatus } from "@/lib/runs";
import {
  transitionSessionStatus,
  incrementMessageCount,
  updateSessionSandbox,
  updateSessionMcpRefreshedAt,
  type Session,
} from "@/lib/sessions";
import { uploadTranscript } from "@/lib/transcripts";
import { backupSessionFile, restoreSessionFile } from "@/lib/session-files";
import { generateRunToken } from "@/lib/crypto";
import { parseResultEvent, captureTranscript } from "@/lib/transcript-utils";
import { createNdjsonStream, ndjsonHeaders } from "@/lib/streaming";
import { logger } from "@/lib/logger";
import { getEnv } from "@/lib/env";
import type { AgentInternal } from "@/lib/validation";
import type { RunId, RunStatus, TenantId, AgentId } from "@/lib/types";

export interface SessionExecutionParams {
  sessionId: string;
  tenantId: TenantId;
  agent: AgentInternal;
  prompt: string;
  platformApiUrl: string;
  effectiveBudget: number;
  effectiveMaxTurns: number;
  /** AgentCo callback data for MCP bridge injection (A2A only). */
  callbackData?: import("./mcp").CallbackData;
  /** Additional hostnames to allow in sandbox network policy (e.g. AgentCo callback URLs). */
  extraAllowedHostnames?: string[];
}

export interface SessionMessageResult {
  runId: RunId;
  sandbox: SessionSandboxInstance;
  logIterator: AsyncGenerator<string>;
  transcriptChunks: string[];
  sdkSessionIdRef: { value: string | null };
}

const DEFAULT_SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const MCP_REFRESH_TTL_MS = 30 * 60 * 1000; // skip MCP refresh if tokens are still fresh

const EMPTY_MCP: McpBuildResult = { servers: {}, errors: [] };
const EMPTY_PLUGINS: PluginFileSet = { skillFiles: [], agentFiles: [], warnings: [] };

function isMcpFresh(session: Session): boolean {
  if (!session.mcp_refreshed_at) return false;
  return Date.now() - new Date(session.mcp_refreshed_at).getTime() < MCP_REFRESH_TTL_MS;
}

function recordMcpRefresh(sessionId: string, tenantId: TenantId): void {
  updateSessionMcpRefreshedAt(sessionId, tenantId).catch((err) => {
    logger.warn("Failed to update mcp_refreshed_at", {
      session_id: sessionId,
      error: err instanceof Error ? err.message : String(err),
    });
  });
}

/**
 * Prepare a session sandbox (create or reconnect).
 * Returns the sandbox instance ready for runMessage().
 *
 * When MCP tokens are fresh (< 30 min), skips MCP/plugin refresh
 * for faster reconnect. Sandbox keeps its existing MCP config.
 */
export async function prepareSessionSandbox(
  params: SessionExecutionParams,
  session: Session,
): Promise<SessionSandboxInstance> {
  const env = getEnv();
  const effectiveRunner = resolveEffectiveRunner(params.agent.model, params.agent.runner);

  // MCP config must be rebuilt on every message: reconnectSessionSandbox
  // rebuilds the sandbox baseEnv from config.mcpServers, so skipping the
  // build leaves the sandbox without MCP_SERVERS_JSON for follow-up turns
  // (Composio tools disappear between messages in the same session). The
  // build is one Composio API call — cheap enough to do unconditionally.
  // Plugin content can still be cached by the freshness window since it's
  // file content rather than a token-bearing URL.
  const skipPluginRefresh = !!session.sandbox_id && isMcpFresh(session);
  const mcpPromise = buildMcpConfig(params.agent, params.tenantId);
  const pluginPromise = skipPluginRefresh
    ? Promise.resolve(EMPTY_PLUGINS)
    : fetchPluginContent(params.agent.plugins ?? []);
  const authPromise = resolveSandboxAuth(params.tenantId as TenantId, effectiveRunner);

  if (session.sandbox_id) {
    // Resolve auth first (usually cached, sub-ms), then race reconnect against MCP/plugin fetch
    const auth = await authPromise;
    const [reconnectResult, mcpResult, pluginResult] = await Promise.all([
      reconnectSessionSandbox(session.sandbox_id, {
        agent: {
          ...params.agent,
          max_budget_usd: params.effectiveBudget,
          max_turns: params.effectiveMaxTurns,
        },
        tenantId: params.tenantId,
        sessionId: params.sessionId,
        platformApiUrl: params.platformApiUrl,
        aiGatewayApiKey: env.AI_GATEWAY_API_KEY,
        auth,
        // MCP config will be applied after reconnect
        mcpServers: undefined,
        mcpErrors: [],
        pluginFiles: [],
        maxIdleTimeoutMs: DEFAULT_SESSION_TIMEOUT_MS,
        callbackData: params.callbackData,
      }),
      mcpPromise,
      pluginPromise,
    ]);

    if (reconnectResult) {
      // Inject fresh MCP server config into the reconnected sandbox's base env
      // so subsequent runMessage() calls have up-to-date tokens.
      if (Object.keys(mcpResult.servers).length > 0) {
        reconnectResult.updateMcpConfig(mcpResult.servers, mcpResult.errors);
      }

      // Skip extendTimeout if session was active recently (< 5 min idle)
      const idleSinceMs = session.idle_since ? Date.now() - new Date(session.idle_since).getTime() : Infinity;
      if (idleSinceMs > 5 * 60 * 1000) {
        await reconnectResult.extendTimeout(DEFAULT_SESSION_TIMEOUT_MS);
      }
      recordMcpRefresh(params.sessionId, params.tenantId);

      logger.info("Session sandbox reconnected", {
        session_id: params.sessionId,
        sandbox_id: session.sandbox_id,
        plugin_fast_path: skipPluginRefresh,
        skipped_extend_timeout: idleSinceMs <= 5 * 60 * 1000,
      });
      return reconnectResult;
    }

    logger.info("Session sandbox gone, creating new (cold path)", {
      session_id: params.sessionId,
      old_sandbox_id: session.sandbox_id,
    });

    // MCP + plugin results already resolved from Promise.all above
    if (mcpResult.errors.length > 0) {
      logger.warn("MCP config errors for session", {
        session_id: params.sessionId,
        errors: mcpResult.errors,
      });
    }

    const sandboxConfig: SessionSandboxConfig = {
      agent: {
        ...params.agent,
        max_budget_usd: params.effectiveBudget,
        max_turns: params.effectiveMaxTurns,
      },
      tenantId: params.tenantId,
      sessionId: params.sessionId,
      platformApiUrl: params.platformApiUrl,
      aiGatewayApiKey: env.AI_GATEWAY_API_KEY,
      auth,
      mcpServers: mcpResult.servers,
      mcpErrors: mcpResult.errors,
      pluginFiles: [...pluginResult.skillFiles, ...pluginResult.agentFiles],
      maxIdleTimeoutMs: DEFAULT_SESSION_TIMEOUT_MS,
      callbackData: params.callbackData,
    };

    const sandbox = await createSessionSandbox(sandboxConfig);
    await updateSessionSandbox(params.sessionId, params.tenantId, sandbox.id);
    recordMcpRefresh(params.sessionId, params.tenantId);

    if (session.sdk_session_id && session.session_blob_url) {
      await restoreSessionFile(sandbox, session.session_blob_url, session.sdk_session_id);
    }

    return sandbox;
  }

  // No existing sandbox — pure cold path
  const [mcpResult, pluginResult, auth] = await Promise.all([mcpPromise, pluginPromise, authPromise]);

  if (mcpResult.errors.length > 0) {
    logger.warn("MCP config errors for session", {
      session_id: params.sessionId,
      errors: mcpResult.errors,
    });
  }

  const sandboxConfig: SessionSandboxConfig = {
    agent: {
      ...params.agent,
      max_budget_usd: params.effectiveBudget,
      max_turns: params.effectiveMaxTurns,
    },
    tenantId: params.tenantId,
    sessionId: params.sessionId,
    platformApiUrl: params.platformApiUrl,
    aiGatewayApiKey: env.AI_GATEWAY_API_KEY,
    auth,
    mcpServers: mcpResult.servers,
    mcpErrors: mcpResult.errors,
    pluginFiles: [...pluginResult.skillFiles, ...pluginResult.agentFiles],
    maxIdleTimeoutMs: DEFAULT_SESSION_TIMEOUT_MS,
    callbackData: params.callbackData,
  };

  const sandbox = await createSessionSandbox(sandboxConfig);
  await updateSessionSandbox(params.sessionId, params.tenantId, sandbox.id);
  recordMcpRefresh(params.sessionId, params.tenantId);

  if (session.sdk_session_id && session.session_blob_url) {
    await restoreSessionFile(sandbox, session.session_blob_url, session.sdk_session_id);
  }

  return sandbox;
}

/**
 * Execute a single message within a session.
 * Creates a run, starts the runner, and returns an iterator for streaming.
 */
export async function executeSessionMessage(
  params: SessionExecutionParams,
  sandbox: SessionSandboxInstance,
  session: Session,
): Promise<SessionMessageResult> {
  const env = getEnv();

  // Create run record with session_id and triggered_by: "chat"
  const { run } = await createRun(
    params.tenantId,
    params.agent.id as AgentId,
    params.prompt,
    { triggeredBy: "chat", sessionId: params.sessionId },
  );
  const runId = run.id as RunId;

  const runToken = await generateRunToken(runId, env.ENCRYPTION_KEY);

  // NOTE: session must already be in "active" state — the route handler
  // claims the lock atomically (WHERE status = fromStatus) before calling
  // this function, preventing concurrent message races.

  // Start the runner in the sandbox
  let logs: () => AsyncIterable<string>;
  try {
    const result = await sandbox.runMessage({
      prompt: params.prompt,
      sdkSessionId: session.sdk_session_id,
      runId,
      runToken,
      maxTurns: params.effectiveMaxTurns,
      maxBudgetUsd: params.effectiveBudget,
    });
    logs = result.logs;
  } catch (err) {
    // Rollback session to idle so user can retry immediately
    await transitionSessionStatus(
      params.sessionId,
      params.tenantId,
      "active",
      "idle",
      { idle_since: new Date().toISOString() },
    ).catch((rollbackErr) => {
      logger.error("Failed to rollback session to idle after runMessage failure", {
        session_id: params.sessionId,
        error: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
      });
    });
    throw err;
  }

  // Transition run to running
  await transitionRunStatus(runId, params.tenantId, "pending", "running", {
    sandbox_id: sandbox.id,
    started_at: new Date().toISOString(),
  });

  // Capture transcript and session_info events
  const transcriptChunks: string[] = [];
  const sdkSessionIdRef = { value: session.sdk_session_id };
  const logIterator = captureTranscript(
    logs(),
    transcriptChunks,
    params.tenantId,
    runId,
    (event) => {
      if (event.type === "session_info" && event.sdk_session_id) {
        sdkSessionIdRef.value = event.sdk_session_id as string;
        logger.info("Captured SDK session ID", {
          run_id: runId,
          sdk_session_id: event.sdk_session_id,
        });
      }
    },
  );

  return { runId, sandbox, logIterator, transcriptChunks, sdkSessionIdRef };
}

/**
 * Finalize a session message: persist transcript, update run, backup session file.
 * Does NOT stop sandbox. Session transitions to idle.
 * CRITICAL: This must complete BEFORE the response stream closes.
 */
export async function finalizeSessionMessage(
  runId: RunId,
  tenantId: TenantId,
  sessionId: string,
  transcriptChunks: string[],
  effectiveBudget: number,
  sandbox: SessionSandboxInstance,
  sdkSessionId: string | null,
): Promise<void> {
  try {
    // 1. Persist transcript
    let resultData: { status: RunStatus; updates: Record<string, unknown> } | null = null;
    if (transcriptChunks.length > 0) {
      const transcript = transcriptChunks.join("\n") + "\n";
      const blobUrl = await uploadTranscript(tenantId, runId, transcript);
      const lastLine = transcriptChunks[transcriptChunks.length - 1];
      resultData = await parseResultEvent(lastLine);

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
    // 2. Increment message count
    await incrementMessageCount(sessionId, tenantId);

    // 3. Back up session file SYNCHRONOUSLY (before response ends)
    let sessionBlobUrl: string | null = null;
    if (sdkSessionId) {
      sessionBlobUrl = await backupSessionFile(
        sandbox,
        tenantId as TenantId,
        sessionId,
        sdkSessionId,
      );
      if (!sessionBlobUrl) {
        logger.error("Session file backup failed — cold start will lose context since last successful backup", {
          run_id: runId,
          session_id: sessionId,
          sdk_session_id: sdkSessionId,
        });
      }
    }

    // 4. Transition session to idle
    await transitionSessionStatus(
      sessionId,
      tenantId,
      "active",
      "idle",
      {
        idle_since: new Date().toISOString(),
        last_message_at: new Date().toISOString(),
        ...(sdkSessionId ? { sdk_session_id: sdkSessionId } : {}),
        ...(sessionBlobUrl ? { session_blob_url: sessionBlobUrl, last_backup_at: new Date().toISOString() } : {}),
      },
    );
  } catch (err) {
    logger.error("Failed to finalize session message", {
      run_id: runId,
      session_id: sessionId,
      error: err instanceof Error ? err.message : String(err),
    });

    // Best-effort: mark run as failed
    await transitionRunStatus(runId, tenantId, "running", "failed", {
      completed_at: new Date().toISOString(),
      error_type: "session_finalize_error",
      error_messages: [err instanceof Error ? err.message : String(err)],
    }).catch((inner) => {
      logger.error("Best-effort run status transition failed during finalize error recovery", {
        run_id: runId,
        session_id: sessionId,
        error: inner instanceof Error ? inner.message : String(inner),
      });
    });

    // Best-effort: transition session to idle even on error
    await transitionSessionStatus(
      sessionId,
      tenantId,
      "active",
      "idle",
      { idle_since: new Date().toISOString() },
    ).catch((inner) => {
      logger.error("Best-effort session status transition failed during finalize error recovery", {
        run_id: runId,
        session_id: sessionId,
        error: inner instanceof Error ? inner.message : String(inner),
      });
    });
  }
}

/**
 * Create a streaming Response for a session message.
 * Wraps the log iterator with finalization and detach handling.
 * Used by all 4 session route handlers (tenant/admin × create/message).
 */
export function createSessionStreamResponse(
  result: SessionMessageResult,
  tenantId: TenantId,
  sessionId: string,
  effectiveBudget: number,
  options?: {
    /** Extra events to yield before the log stream (e.g. session_created). */
    prelude?: string[];
  },
): Response {
  const { runId, sandbox, logIterator, transcriptChunks, sdkSessionIdRef } = result;
  let detached = false;

  async function* streamWithFinalize() {
    if (options?.prelude) {
      for (const line of options.prelude) {
        yield line;
      }
    }

    for await (const line of logIterator) {
      yield line;
    }

    if (!detached) {
      await finalizeSessionMessage(
        runId,
        tenantId,
        sessionId,
        transcriptChunks,
        effectiveBudget,
        sandbox,
        sdkSessionIdRef.value,
      );
    }
  }

  const stream = createNdjsonStream({
    runId,
    logIterator: streamWithFinalize(),
    onDetach: () => {
      detached = true;
      logger.info("Session stream detached", { session_id: sessionId, run_id: runId });
      finalizeSessionMessage(
        runId,
        tenantId,
        sessionId,
        transcriptChunks,
        effectiveBudget,
        sandbox,
        sdkSessionIdRef.value,
      ).catch((err) => {
        logger.error("Detached session finalization failed", {
          session_id: sessionId,
          run_id: runId,
          error: err instanceof Error ? err.message : String(err),
        });
      });
    },
  });

  return new Response(stream, { status: 200, headers: ndjsonHeaders() });
}
