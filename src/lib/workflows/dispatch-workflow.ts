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
 *   │   // tailStep is intentionally NOT called: finalizeMessage's          │
 *   │   // happy path already calls sessionTail internally.                 │
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
  isMcpFresh,
  recordMcpRefresh,
  SESSION_TIMEOUT_MS,
  SESSION_RECONNECT_TIMEOUT_EXTEND_THRESHOLD_MS,
  type DispatchInput,
  type DispatchResult,
  type PreparedExecution,
} from "@/lib/dispatcher";
import {
  casCreatingToActive,
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
 * The shape the runner POSTs (one POST = one batch of up to ~10 NDJSON
 * lines, coalesced by the runner template) and the hook delivers to the
 * workflow body's `for await`. The internal endpoint (U3) parses raw
 * runner NDJSON into a batch and `resumeHook`s once with the whole batch.
 *
 * `terminal` is set when at least one of `lines` is a terminal event
 * (`result` or `error`). The workflow body breaks its for-await after
 * processing the batch.
 *
 * PERF: pre-batching this was one chunk per parsed line, meaning every
 * NDJSON line emitted by the runner became a separate WDK step boundary
 * (writeChunkStep). With the runner already coalescing 10 lines / 100ms
 * per HTTP POST, batching here cuts step count by up to 10×.
 */
export interface RunnerChunkLine {
  line: string;
  eventType: string;
}

export type RunnerChunk = {
  kind: "chunk" | "terminal";
  lines: RunnerChunkLine[];
};

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
  prepared: PreparedExecution,
): Promise<DispatchWorkflowOutput> {
  "use workflow";

  const runId = getWorkflowMetadata().workflowRunId;

  // PERF: reserveSessionAndMessage now runs in the shim (dispatch-shim.ts)
  // BEFORE start(), so:
  //   - The shim has session.id + messageId immediately and skips
  //     pollForReserveCommit entirely (was up to 5s of polling pre-fix,
  //     ~300-700ms even on the happy path).
  //   - The first step of the workflow is no longer a 100-300ms WDK
  //     round-trip just to do a DB write the shim could've done in-process.
  // The legacy in-process dispatchSessionMessage works the same way; this
  // brings the workflow path to parity on the cheapest part of the boot
  // path.
  //
  // Hook MUST exist before launchRunner so the runner's first POST never
  // 404s — the U0 spike measured a 500ms–1.2s registration window absorbed
  // by U3's runner-side backoff (100ms→1.6s, 30s budget).
  // Token is deterministic (the internal endpoint reconstructs it from
  // messageId without needing additional state).
  const hook = createHook<RunnerChunk>({
    token: `transcript:${prepared.messageId}`,
  });

  // PERF: persist runId + ensureSandbox + launchRunner all in ONE step.
  // Pre-fix these were three separate steps, each paying ~100-500ms of WDK
  // step-boundary overhead. Combined here because:
  //   - setWorkflowRunId is an idempotent UPDATE on a row that already
  //     exists (the shim reserved it before start()).
  //   - coldStartSandbox / reconnectSessionSandbox are idempotent on retry
  //     (sandbox_id CAS, mcp_refreshed_at TTL).
  //   - markRunnerStarted is the spawn-idempotency CAS — replay still skips
  //     the actual spawn after the first attempt.
  const sandboxRef = await prepareSandboxAndLaunchStep(
    input,
    prepared,
    runId,
  );

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

  // Step 4 — finalize: assemble transcript blob, billing, transition message,
  // and run session-tail (backup + idle/stop). finalizeMessage already
  // delegates to sessionTail internally for the happy path, so a separate
  // tailStep here would double-run incrementMessageCount + backupSessionFile
  // and double-transition active→idle (which manifested as "Session status
  // transition failed (stale state)" warnings on the first workflow-backed
  // schedule run after the cutover).
  //
  // tailStep remains exported for tests that pin its delegation-to-sessionTail
  // contract, but is intentionally NOT called from the workflow body.
  await finalizeStep(prepared, sandboxRef, { cancelled, cancelReason });

  return { sessionId: prepared.session.id, messageId: prepared.messageId };
}

// --- Steps (exported for testability; not re-exported from workflows/index.ts
//     so callers don't accidentally invoke them outside the workflow body) ---

/**
 * Single step that does runId persistence + sandbox provisioning + runner
 * launch. Combined to save WDK step boundaries — pre-fix this was three
 * separate steps each paying ~100-500ms of cross-function overhead.
 *
 * All three operations are idempotent on retry:
 *   - setWorkflowRunId is an UPDATE on an existing row (same value on replay).
 *   - ensureSandboxImpl uses sandbox_id CAS / mcp_refreshed_at TTL.
 *   - launchRunnerImpl uses markRunnerStarted CAS — replay skips spawn.
 */
export async function prepareSandboxAndLaunchStep(
  input: DispatchInput,
  prepared: PreparedExecution,
  runId: string,
): Promise<SandboxRef> {
  "use step";
  await setWorkflowRunId(prepared.session.id, input.tenantId, `wdk_v1_${runId}`);
  const sandboxRef = await ensureSandboxImpl(input, prepared);
  await launchRunnerImpl(input, prepared, sandboxRef);
  return sandboxRef;
}

/**
 * @deprecated Kept for unit tests that pin its behavior. The workflow body
 * now calls `prepareSandboxAndLaunchStep` which inlines this work.
 */
export async function persistWorkflowRunIdStep(
  prepared: PreparedExecution,
  runId: string,
  tenantId: TenantId,
): Promise<void> {
  "use step";
  await setWorkflowRunId(prepared.session.id, tenantId, `wdk_v1_${runId}`);
}

/**
 * @deprecated Kept exported for unit tests that pin its behavior. The
 * workflow body no longer calls this — reserve runs in the shim before
 * start() and `persistWorkflowRunIdStep` records the runId after.
 */
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
  return ensureSandboxImpl(input, prepared);
}

/**
 * Body of ensureSandboxStep without the `"use step"` directive so it can be
 * called from inside another step (e.g. `prepareSandboxAndLaunchStep`)
 * without scheduling a nested WDK step boundary.
 */
async function ensureSandboxImpl(
  input: DispatchInput,
  prepared: PreparedExecution,
): Promise<SandboxRef> {
  // Mirrors the legacy runMessageStream optimization layout (dispatcher.ts:
  // 590–765) so workflow-backed follow-up messages don't pay the full cold-
  // start cost on every turn. The hot-path process-local cache (activeSessions)
  // is intentionally not ported — workflow steps may run on different function
  // instances and a per-instance cache wouldn't reliably hit. The warm
  // reconnect path is the big win: skips ~3s of sandbox provisioning when
  // the session already has a live sandbox.
  const env = getEnv();
  const { agent, session, effectiveBudget, effectiveMaxTurns } = prepared;
  const effectiveRunner = resolveEffectiveRunner(agent.model, agent.runner);

  // skipPluginRefresh: the existing sandbox already has plugin files on disk
  // (reconnectSessionSandbox doesn't re-inject — see "OPTIMIZATION B" comment
  // in sandbox.ts). MCP freshness is the proxy for "the sandbox state is still
  // valid"; if MCP refreshed within the TTL, skip the plugin GitHub fetch too.
  const mcpFresh = isMcpFresh(session);
  const skipPluginRefresh = !!session.sandbox_id && mcpFresh;

  // Kick off all three builds in parallel — they overlap with reconnect or
  // cold-start work below. fetchPluginContent on an empty plugin list is a
  // no-op fast path; resolveSandboxAuth is one cached DB read.
  const mcpPromise = withTenantTransaction(
    input.tenantId,
    () => buildMcpConfig(agent, input.tenantId),
  ) as Promise<McpBuildResult>;
  const pluginPromise = (skipPluginRefresh
    ? Promise.resolve<PluginFileSet>({ skillFiles: [], agentFiles: [], warnings: [] })
    : fetchPluginContent(agent.plugins ?? [])) as Promise<PluginFileSet>;
  const authPromise = resolveSandboxAuth(input.tenantId, effectiveRunner);

  // Warm path: the session already has a sandbox_id. Try reconnecting to
  // the live sandbox (saves ~3s of fresh provision). Race the reconnect
  // against the parallel builds so MCP/plugin work overlaps with the
  // Sandbox.get() RPC.
  if (session.sandbox_id) {
    const auth = await authPromise;
    // Build the FULL sandbox config now so the SandboxRef returned to
    // subsequent steps carries everything they need — they reconnect via
    // reconnectSessionSandbox(sandboxId, sandboxConfig) on every step.
    // Legacy passes mcpServers=undefined to reconnect, then calls
    // updateMcpConfig on the same wrapper instance — that pattern doesn't
    // translate to workflow steps because each step rebuilds the wrapper.
    // Here we wait for mcpPromise so the config is complete.
    const [mcpResult, pluginResult] = await Promise.all([mcpPromise, pluginPromise]);
    void pluginResult; // unused on reconnect path; existing sandbox has files

    const sandboxConfig: SessionSandboxConfig = {
      agent: { ...agent, max_budget_usd: effectiveBudget, max_turns: effectiveMaxTurns },
      tenantId: input.tenantId,
      sessionId: session.id,
      platformApiUrl: input.platformApiUrl,
      aiGatewayApiKey: env.AI_GATEWAY_API_KEY,
      auth,
      mcpServers: mcpResult.servers,
      mcpErrors: mcpResult.errors,
      pluginFiles: [],
      maxIdleTimeoutMs: SESSION_TIMEOUT_MS,
      callbackData: input.callbackData,
    };

    const reconnectResult = await reconnectSessionSandbox(
      session.sandbox_id,
      sandboxConfig,
    );

    if (reconnectResult) {
      // Bump the sandbox idle timeout if it's been sitting for a while —
      // mirror legacy's threshold (5 min idle → bump). Without this, a
      // follow-up message on a session that idled past the sandbox's own
      // timeout would race the sandbox going away mid-message.
      const idleSinceMs = session.idle_since
        ? Date.now() - new Date(session.idle_since).getTime()
        : Infinity;
      if (idleSinceMs > SESSION_RECONNECT_TIMEOUT_EXTEND_THRESHOLD_MS) {
        try {
          await reconnectResult.extendTimeout(SESSION_TIMEOUT_MS);
        } catch (err) {
          logger.warn("ensureSandboxStep: extendTimeout failed (best-effort)", {
            session_id: session.id,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
      recordMcpRefresh(session.id, input.tenantId);

      // U7 chat-attachments warm path: re-stage attachments on follow-up
      // turns. writeFiles overwrites by path so re-running on a session
      // that already has the file is idempotent. SessionSandboxInstance
      // exposes writeFiles via its underlying sandboxRef.
      if (input.preInjectFiles && input.preInjectFiles.length > 0) {
        await Promise.allSettled(
          input.preInjectFiles.map(async (f) => {
            try {
              const res = await fetch(f.signedReadUrl, { redirect: "error" });
              if (!res.ok) throw new Error(`http_${res.status}`);
              const buf = Buffer.from(await res.arrayBuffer());
              await reconnectResult.sandboxRef.writeFiles([{ path: f.path, content: buf }]);
            } catch (err) {
              logger.warn("preInjectFiles (warm): stage failed (fail-open)", {
                path: f.path,
                error: err instanceof Error ? err.message : String(err),
              });
            }
          }),
        );
      }

      logger.info("ensureSandboxStep: warm reconnect", {
        session_id: session.id,
        sandbox_id: session.sandbox_id,
        skip_plugin_refresh: skipPluginRefresh,
      });
      return { sandboxId: session.sandbox_id, sandboxConfig };
    }
    // Reconnect returned null → sandbox vanished (cleanup-cron stopped it,
    // Vercel idle-killed it, etc.). Fall through to cold-start. The plugin
    // promise we resolved with the fast path may have been wrong (we needed
    // the full plugin content for cold-start); kick a fresh fetch since we
    // skipped it on the assumption that the sandbox still had the files.
    logger.info("ensureSandboxStep: reconnect failed → cold start", {
      session_id: session.id,
      stale_sandbox_id: session.sandbox_id,
    });
  }

  // Cold path: either no prior sandbox, or reconnect failed. Provision fresh.
  // Re-fetch plugin content if we skipped it earlier on the warm-path
  // assumption.
  const [mcpResult, pluginResult, auth] = await Promise.all([
    mcpPromise,
    skipPluginRefresh
      ? (fetchPluginContent(agent.plugins ?? []) as Promise<PluginFileSet>)
      : pluginPromise,
    authPromise,
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

  // Promote creating→active now that the sandbox boot succeeded — same
  // transition the legacy runMessageStream does at dispatcher.ts:770. Without
  // this, fresh sessions stay in `creating` for their entire lifetime,
  // which (a) makes finalizeMessage's internal sessionTail's active→idle
  // CAS no-op (logs "Session status transition failed (stale state)"),
  // and (b) — far worse — leaves the session visible to the next schedule
  // tick's findWarmScheduleSession, whose query includes 'creating'.
  // The next tick passes that stuck session as warmSessionId and reserveStep
  // throws "Session is still being created", which WDK retries 3× before
  // bubbling FatalError.
  //
  // Idempotent CAS: noop on warm-reuse paths where the session was already
  // 'active' coming out of reserveStep.
  await casCreatingToActive(session.id, input.tenantId, { sandbox_id: sandbox.id });

  // U7 chat-attachments: pre-inject staged files BEFORE the runner spawns.
  // The chat workflow passes signed-URL handoff metadata in
  // input.preInjectFiles; we fetch each URL server-side and write to the
  // sandbox FS. Bytes never cross a WDK step boundary because the fetch +
  // write happens inside this single step. Per-attachment fail-open (a
  // failed download / 404 logs and skips; the text message still
  // dispatches with the agent prompt's `## Attachments` block intact).
  if (input.preInjectFiles && input.preInjectFiles.length > 0) {
    await Promise.allSettled(
      input.preInjectFiles.map(async (f) => {
        try {
          // 30s timeout + size cap — review run 20260506-221948-2402b0ed
          // P2 #23 (no timeout) and correctness #11 (no size cap). Cap at
          // sizeBytes from the persisted record (already capped at 25 MB
          // upstream); reject larger to prevent OOM via attacker-controlled
          // blob.
          const ctl = new AbortController();
          const tm = setTimeout(() => ctl.abort(), 30_000);
          let res: Response;
          try {
            res = await fetch(f.signedReadUrl, { redirect: "error", signal: ctl.signal });
          } finally {
            clearTimeout(tm);
          }
          if (!res.ok) throw new Error(`http_${res.status}`);
          const ab = await res.arrayBuffer();
          if (ab.byteLength > f.sizeBytes + 1024) {
            throw new Error(`response_size_exceeds_metadata: ${ab.byteLength} > ${f.sizeBytes}`);
          }
          const buf = Buffer.from(ab);
          await sandbox.sandboxRef.writeFiles([{ path: f.path, content: buf }]);
        } catch (err) {
          logger.warn("preInjectFiles: stage failed (fail-open)", {
            path: f.path,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }),
    );
  }

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
  await launchRunnerImpl(input, prepared, sandboxRef);
}

/**
 * Body of launchRunnerStep without the `"use step"` directive. Called from
 * `prepareSandboxAndLaunchStep` to avoid scheduling a nested WDK boundary.
 */
async function launchRunnerImpl(
  input: DispatchInput,
  prepared: PreparedExecution,
  sandboxRef: SandboxRef,
): Promise<void> {
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
  //
  // PERF: process lines in parallel — scrubSecrets + processLineAssets
  // are independent across lines; serial dispatch was leaving latency
  // on the table for batches of 5-10 lines.
  const processed = await Promise.all(
    chunk.lines.map(async (l) =>
      scrubSecrets(await processLineAssets(l.line, tenantId, messageId)),
    ),
  );

  const writer = getWritable<string>().getWriter();
  try {
    // Single write call per batch; the writable is durable so the writes
    // line up in order on subsequent reader pulls.
    for (const line of processed) {
      await writer.write(line);
    }
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

  // Capture sdk_session_id from the runner's `session_info` event so the
  // session row can persist it via sessionTail (called inside finalizeMessage).
  // Without this, follow-up messages on the same persistent session launch
  // the runner without `resume`, which makes the SDK start a fresh
  // conversation — visible in the playground as "you haven't shared any
  // code in this conversation yet" responses to follow-ups. Mirrors the
  // legacy capture at dispatcher.ts:827-842.
  const capturedSdkSessionId = extractSdkSessionId(transcriptChunks)
    ?? prepared.session.sdk_session_id;

  const sandbox = await reconnectInStep(sandboxRef);
  await finalizeMessage({
    messageId: prepared.messageId,
    tenantId: prepared.session.tenant_id as TenantId,
    session: prepared.session as Session,
    sandbox,
    sdkSessionId: capturedSdkSessionId,
    transcriptChunks,
    effectiveBudget: prepared.effectiveBudget,
  });
}

/**
 * Walk the captured NDJSON chunks for a `session_info` event whose
 * `sdk_session_id` is the SDK's session id. The runner emits this once on
 * iterator init (sandbox.ts:788). Returns the LAST one in case the runner
 * spans multiple SDK sessions in a single message (rare; present for
 * future-proofing).
 */
function extractSdkSessionId(chunks: string[]): string | null {
  let captured: string | null = null;
  for (const line of chunks) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const event = JSON.parse(trimmed);
      if (
        event &&
        typeof event === "object" &&
        event.type === "session_info" &&
        typeof event.sdk_session_id === "string" &&
        event.sdk_session_id.length > 0
      ) {
        captured = event.sdk_session_id;
      }
    } catch {
      // Non-JSON line — skip. Same defensive parse as parseRunnerLine.
    }
  }
  return captured;
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
