/**
 * dispatchWorkflow — the WDK workflow that replaces dispatcher.ts's ad-hoc
 * orchestration with a durable, replayable, observable spine.
 *
 * Plan reference: U2 in docs/plans/2026-05-05-001-refactor-workflow-sdk-dispatch-plan.md
 * Spike outcomes that shape this file: docs/research/wdk-spike-results.md
 *
 * Body shape (constraints derived from the U0 spike):
 *
 *   ┌────────────────── workflow body ("use workflow") ───────────────────┐
 *   │                                                                      │
 *   │   const runId = getWorkflowMetadata().workflowRunId                  │
 *   │   const prepared = await reserveStep(input, runId)        // STEP    │
 *   │   const hook = createHook<RunnerChunk>({ token: ... })    // body    │
 *   │   const sandbox = await ensureSandboxStep(...)            // STEP    │
 *   │   await launchRunnerStep(...)                             // STEP    │
 *   │                                                                      │
 *   │   try {                                                              │
 *   │     for await (const chunk of hook) {                     // body    │
 *   │       await writeChunkStep(tenantId, messageId, chunk)    // STEP    │
 *   │       if (chunk.kind === "terminal") break                           │
 *   │     }                                                                │
 *   │   } catch (err) { cancelled = true; ... }                            │
 *   │                                                                      │
 *   │   await finalizeStep(prepared, sandbox, { cancelled })    // STEP    │
 *   │   await tailStep(prepared, sandbox)                       // STEP    │
 *   │                                                                      │
 *   └──────────────────────────────────────────────────────────────────────┘
 *
 * WDK constraints baked into this shape:
 *   1. createHook() must live in workflow body (NOT a step)
 *   2. The Hook<T> object can't cross workflow→step boundary
 *   3. Stream writes (getWritable.write) must live IN a step
 *   4. → workflow body iterates; per-chunk writeChunkStep owns the write
 *   5. WorkflowReadableStream.cancel() cancels the run — never call it
 *   6. Reading getReadable on a terminal run requires getTailIndex bounds
 *
 * U2 scope: this file defines the workflow shape with steps that delegate
 * to the existing dispatcher's exported helpers. **No production traffic
 * runs through this workflow yet** — the per-trigger toggles in U4 are off
 * by default and the runner-side per-line POST integration lands in U3.
 * The workflow exists, compiles, and is unit-testable in isolation.
 */
import {
  createHook,
  getWorkflowMetadata,
  getWritable,
} from "workflow";
import { getRun } from "workflow/api";
import {
  reserveSessionAndMessage,
  coldStartSandbox,
  finalizeMessage,
  sessionTail,
  type DispatchInput,
  type DispatchResult,
  type PreparedExecution,
} from "@/lib/dispatcher";
import {
  setWorkflowRunId,
  type Session,
} from "@/lib/sessions";
import { markRunnerStarted } from "@/lib/session-messages";
import { resolveSandboxAuth } from "@/lib/tenant-auth";
import { resolveEffectiveRunner } from "@/lib/models";
import { buildMcpConfig, type McpBuildResult } from "@/lib/mcp";
import { fetchPluginContent, type PluginFileSet } from "@/lib/plugins";
import { withTenantTransaction } from "@/db";
import { getEnv } from "@/lib/env";
import { generateMessageToken } from "@/lib/crypto";
import { scrubSecrets } from "@/lib/transcript-utils";
import { processLineAssets } from "@/lib/assets";
import { logger } from "@/lib/logger";
import {
  reconnectSessionSandbox,
  type SessionSandboxConfig,
  type SessionSandboxInstance,
} from "@/lib/sandbox";
import type { TenantId } from "@/lib/types";

// --- Public types ---

/**
 * The shape the runner POSTs (one per NDJSON line) and the hook delivers
 * to the workflow body's `for await`. The internal endpoint (U3) parses
 * raw runner NDJSON, classifies it as `chunk` vs `terminal` based on the
 * event's `type` field, and `resumeHook`s the structured chunk.
 *
 * `terminal` is set for `result` and `error` event types — they're the
 * runner's natural break-out signals. Everything else is a `chunk`.
 */
export type RunnerChunk =
  | { kind: "chunk"; line: string; eventType: string }
  | { kind: "terminal"; line: string; eventType: "result" | "error" };

export interface DispatchWorkflowOutput {
  sessionId: string;
  messageId: string;
}

/**
 * Serializable POJO returned by `ensureSandboxStep` and consumed by every
 * subsequent step. The live `SessionSandboxInstance` (class instance with
 * EventEmitter, async-function methods, and a `Sandbox` SDK ref) is NOT
 * serializable, so it cannot cross WDK step boundaries — see U0 spike
 * trap docs/research/wdk-spike-results.md and runbook §7.
 *
 * Each step that needs to operate on the sandbox calls `reconnectInStep(ref)`,
 * which `Sandbox.get(sandboxId)` and rebuilds the wrapper locally. The
 * underlying sandbox process is unaffected — it keeps running between steps
 * regardless of which function instance executes which step.
 */
export interface SandboxRef {
  sandboxId: string;
  sandboxConfig: SessionSandboxConfig;
}

// --- Workflow ---

/**
 * The dispatch workflow itself. Caller (U5+ entry-point routes) invokes
 * via `start(dispatchWorkflow, [input])`. Returns `{ sessionId, messageId }`
 * after the workflow body completes (including finalize + tail).
 */
export async function dispatchWorkflow(
  input: DispatchInput,
): Promise<DispatchWorkflowOutput> {
  "use workflow";

  const runId = getWorkflowMetadata().workflowRunId;

  // Step 1 — reserve message + persist runId in same tx
  const prepared = await reserveStep(input, runId);

  // Hook MUST exist before launchRunner so the runner's first POST never
  // 404s — the U0 spike measured a 500ms–1.2s registration window absorbed
  // by U3's runner-side backoff (100ms→1.6s, 30s budget).
  // Token is deterministic (the internal endpoint reconstructs it from
  // messageId without needing additional state).
  const hook = createHook<RunnerChunk>({
    token: `transcript:${prepared.messageId}`,
  });

  // Step 2 — provision sandbox; returns POJO ref (NOT live wrapper — see SandboxRef)
  const sandboxRef = await ensureSandboxStep(input, prepared);

  // Step 3 — spawn runner inside sandbox; sets runner_started_at idempotently
  await launchRunnerStep(input, prepared, sandboxRef);

  // Workflow body — iterate hook, dispatch each chunk to writeChunkStep.
  // Cancellation propagates here as a thrown exception; the catch routes
  // through finalize with cancelled=true.
  let cancelled = false;
  let cancelReason: string | undefined;
  try {
    for await (const chunk of hook) {
      await writeChunkStep(prepared.session.tenant_id as TenantId, prepared.messageId, chunk);
      if (chunk.kind === "terminal") break;
    }
  } catch (err) {
    cancelled = true;
    cancelReason = err instanceof Error ? err.message : String(err);
    logger.warn("dispatchWorkflow: hook iterator threw — cancellation path", {
      run_id: runId,
      message_id: prepared.messageId,
      reason: cancelReason,
    });
  }

  // Step 4 — finalize: assemble transcript blob, billing, transition message
  await finalizeStep(prepared, sandboxRef, { cancelled, cancelReason });

  // Step 5 — tail: persistent backup or ephemeral stop
  await tailStep(prepared, sandboxRef);

  return { sessionId: prepared.session.id, messageId: prepared.messageId };
}

// --- Steps (exported for testability; not re-exported from workflows/index.ts
//     so callers don't accidentally invoke them outside the workflow body) ---

export async function reserveStep(
  input: DispatchInput,
  runId: string,
): Promise<PreparedExecution> {
  "use step";
  // Run the existing tx body unchanged — characterization tests pinned its
  // behavior in tests/unit/dispatcher-characterization.test.ts.
  const prepared = await reserveSessionAndMessage(input);
  // Persist `wdk_v1_<runId>` so cleanup/cancel can find this run by sessionId.
  // Stored AFTER reserve commits so a function-host crash mid-reserve doesn't
  // leave a row with a runId pointing at no actual workflow run.
  await setWorkflowRunId(prepared.session.id, input.tenantId, `wdk_v1_${runId}`);
  return prepared;
}

export async function ensureSandboxStep(
  input: DispatchInput,
  prepared: PreparedExecution,
): Promise<SandboxRef> {
  "use step";
  // U2 v1: cold-start path only. The legacy runMessageStream has extensive
  // warm-handle cache + parallel MCP/plugin/auth optimization that we'll
  // port in a follow-up. For now, every workflow run does a fresh
  // sandbox provision per-message.
  //
  // TODO(U2-followup): port the warm-cache + parallel-builds optimization
  // from legacy runMessageStream so workflow-backed sessions get the same
  // hot-path latency as legacy. Tracked separately to keep U2 reviewable.
  const env = getEnv();
  const { agent, session, effectiveBudget, effectiveMaxTurns } = prepared;
  const effectiveRunner = resolveEffectiveRunner(agent.model, agent.runner);

  const [mcpResult, pluginResult, auth] = await Promise.all([
    withTenantTransaction(input.tenantId, () => buildMcpConfig(agent, input.tenantId)) as Promise<McpBuildResult>,
    fetchPluginContent(agent.plugins ?? []) as Promise<PluginFileSet>,
    resolveSandboxAuth(input.tenantId, effectiveRunner),
  ]);

  const { sandbox, sandboxConfig } = await coldStartSandbox({
    agent,
    tenantId: input.tenantId,
    sessionId: session.id,
    sdkSessionId: session.sdk_session_id,
    sessionBlobUrl: session.session_blob_url,
    platformApiUrl: input.platformApiUrl,
    aiGatewayApiKey: env.AI_GATEWAY_API_KEY,
    auth,
    mcpResult,
    pluginResult,
    callbackData: input.callbackData,
    effectiveBudget,
    effectiveMaxTurns,
  });
  // Return a serializable ref (sandboxId + the POJO config used to provision
  // it). Subsequent steps reconnect via reconnectSessionSandbox(sandboxId, cfg)
  // — the sandbox process keeps running on its own host between steps.
  return { sandboxId: sandbox.id, sandboxConfig };
}

/**
 * Reconnect to a sandbox from a SandboxRef. Throws if the sandbox is gone —
 * a workflow path that loses its sandbox mid-flight cannot recover. (The
 * legacy reconnect path handles "sandbox went missing" by cold-starting a
 * new one, but that pre-launchRunner re-spawn doesn't apply to the
 * workflow's mid-stream context: the runner has already started inside
 * the original sandbox.)
 */
async function reconnectInStep(ref: SandboxRef): Promise<SessionSandboxInstance> {
  const wrapper = await reconnectSessionSandbox(ref.sandboxId, ref.sandboxConfig);
  if (!wrapper) {
    throw new Error(`workflow sandbox ${ref.sandboxId} no longer reachable`);
  }
  return wrapper;
}

export async function launchRunnerStep(
  input: DispatchInput,
  prepared: PreparedExecution,
  sandboxRef: SandboxRef,
): Promise<void> {
  "use step";

  // DB-backed spawn idempotency primitive (replaces sandbox-process inspection).
  // Replay finds runner_started_at non-null and skips the actual spawn.
  const fresh = await markRunnerStarted(prepared.messageId, input.tenantId);
  if (!fresh) {
    logger.info("dispatchWorkflow: launchRunner replay — skipping respawn", {
      message_id: prepared.messageId,
      session_id: prepared.session.id,
    });
    return;
  }

  // Pre-reissue gates would apply here on retry (state-tracked
  // reissueAttempts). U2 v1 ships without auto-reissue — the workflow
  // simply re-attempts launchRunner from scratch on workflow runtime
  // retry, and the runner_started_at idempotency CAS prevents
  // double-spawn. R6 hybrid auto-reissue (status check, stream-empty
  // check, attempt count) is a U2 follow-up.
  //
  // TODO(U2-R6): implement three-gate auto-reissue policy here when the
  // workflow runtime exposes per-step state for reissueAttempts tracking.

  const env = getEnv();
  const messageToken = await generateMessageToken(prepared.messageId, env.ENCRYPTION_KEY);
  const sandbox = await reconnectInStep(sandboxRef);

  // U3-e: spawn the runner with per-line streaming on. The runner POSTs
  // each NDJSON line to /api/internal/messages/:messageId/transcript with
  // X-Runner-Attempt-Sequence + X-Batch-Sequence headers; the route's
  // streaming-mode handler dedups by tuple and forwards via resumeHook
  // to the workflow's hook iterator. The workflow body iterates the
  // hook (NOT the legacy logs() iterator).
  const result = await sandbox.runMessage({
    prompt: input.prompt,
    sdkSessionId: prepared.session.sdk_session_id,
    messageId: prepared.messageId,
    messageToken,
    maxTurns: prepared.effectiveMaxTurns,
    maxBudgetUsd: prepared.effectiveBudget,
    streamPerLine: true,
    runnerAttemptSequence: 0, // R6 reissue increments this in a follow-up
  });
  // The legacy logs iterator is intentionally not consumed — the workflow
  // body's hook iterator is the consumer. Voiding to silence lint
  // warnings about the unused property.
  void result.logs;
}

export async function writeChunkStep(
  tenantId: TenantId,
  messageId: string,
  chunk: RunnerChunk,
): Promise<void> {
  "use step";

  // Per-line scrub + asset-persist BEFORE any byte enters the workflow
  // stream. This preserves the institutional learning from
  // docs/solutions/logic-errors/transcript-capture-and-streaming-fixes.md:
  // secrets are redacted before reaching downstream consumers (REST/A2A
  // render shims, transcript blob), and ephemeral asset URLs are
  // persisted to Vercel Blob before leaving the platform's trust boundary.
  const processed = scrubSecrets(await processLineAssets(chunk.line, tenantId, messageId));

  const writer = getWritable<string>().getWriter();
  try {
    await writer.write(processed);
  } finally {
    writer.releaseLock();
  }
}

export async function finalizeStep(
  prepared: PreparedExecution,
  sandboxRef: SandboxRef,
  opts: { cancelled: boolean; cancelReason?: string },
): Promise<void> {
  "use step";

  // Read accumulated chunks from the workflow stream for the transcript
  // blob upload. Bounded by getTailIndex per the U0 spike — WDK's writable
  // doesn't auto-close on workflow-body return, so a plain `for await`
  // hangs.
  const runId = getWorkflowMetadata().workflowRunId;
  const transcriptChunks = await drainTranscriptChunks(runId);

  if (opts.cancelled) {
    logger.info("dispatchWorkflow: finalize on cancellation path", {
      message_id: prepared.messageId,
      session_id: prepared.session.id,
      reason: opts.cancelReason,
    });
    // TODO(U2-followup): salvage transcript file from sandbox FIRST when
    // chunks are empty (cancellation arrived before runner emitted), to
    // match the legacy cleanup-cron salvage-before-stop ordering. Stub
    // here uses whatever chunks landed before cancel.
  }

  const sandbox = await reconnectInStep(sandboxRef);
  await finalizeMessage({
    messageId: prepared.messageId,
    tenantId: prepared.session.tenant_id as TenantId,
    session: prepared.session as Session,
    sandbox,
    sdkSessionId: prepared.session.sdk_session_id,
    transcriptChunks,
    effectiveBudget: prepared.effectiveBudget,
  });
}

export async function tailStep(
  prepared: PreparedExecution,
  sandboxRef: SandboxRef,
): Promise<void> {
  "use step";
  const sandbox = await reconnectInStep(sandboxRef);
  await sessionTail({
    sessionId: prepared.session.id,
    tenantId: prepared.session.tenant_id as TenantId,
    sandbox,
    sdkSessionId: prepared.session.sdk_session_id,
    ephemeral: prepared.session.ephemeral,
  });
}

/**
 * Drain accumulated transcript chunks from the workflow's persistent
 * stream. Bounded by `getTailIndex()` per U0 — without bounding, a plain
 * `for await` over getReadable hangs because WDK's writable doesn't
 * auto-close when the workflow body returns.
 */
async function drainTranscriptChunks(runId: string): Promise<string[]> {
  const readable = getRun<unknown>(runId).getReadable<string>();
  const tail = await readable.getTailIndex();
  if (tail < 0) return [];
  const chunks: string[] = [];
  const reader = readable.getReader();
  try {
    for (let i = 0; i <= tail; i++) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(typeof value === "string" ? value : JSON.stringify(value));
    }
  } finally {
    reader.releaseLock();
    // NEVER call `readable.cancel()` — the U0 spike confirmed it propagates
    // upstream and cancels the workflow run itself.
  }
  return chunks;
}

// Re-export types from the dispatcher for callers that want the canonical
// DispatchInput / DispatchResult shapes without importing dispatcher
// directly. (Convenient now; mandatory after U10's retirement when
// dispatcher.ts shrinks.)
export type { DispatchInput, DispatchResult };
