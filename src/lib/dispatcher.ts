/**
 * Single dispatch chokepoint for all session message executions.
 *
 * Replaces the old `run-executor.ts` and `session-executor.ts` split. Every
 * trigger source (api, schedule, webhook, a2a, playground, chat) goes
 * through this module. The contract is:
 *
 *     dispatchSessionMessage({...}) -> { sessionId, messageId, stream }
 *
 * The caller streams `result.stream` to the client (NDJSON via
 * `createNdjsonStream`). On the terminal event the dispatcher persists the
 * transcript, writes billing rollup, and idles or stops the session per the
 * `ephemeral` flag set at session creation.
 *
 * All cross-unit hand-offs (internal upload endpoint stopping ephemeral
 * sandboxes, U3 routes returning 410 Gone, U4 trigger handlers) are
 * documented inline so reviewers can follow the contract.
 */
import { z } from "zod";
import { withTenantTransaction, queryOne, execute } from "@/db";
import {
  getSession,
  casCreatingToActive,
  casToStopped,
  transitionSessionStatus,
  updateSessionSandbox,
  updateSessionMcpRefreshedAt,
  defaultIdleTtlSeconds,
  incrementMessageCount,
  SESSION_EXPIRES_AFTER_INTERVAL,
  MAX_CONCURRENT_ACTIVE_SESSIONS,
  type Session,
} from "@/lib/sessions";
import {
  checkTenantBudget,
  transitionMessageStatus,
} from "@/lib/session-messages";
import { SessionMessageRow, SessionRow as SessionRowSchema, AgentRowInternal, type AgentInternal } from "@/lib/validation";
import {
  createSessionSandbox,
  reconnectSessionSandbox,
  reconnectSandbox,
  type SessionSandboxInstance,
  type SessionSandboxConfig,
} from "@/lib/sandbox";
import { buildMcpConfig, type McpBuildResult, type CallbackData } from "@/lib/mcp";
import { fetchPluginContent, type PluginFileSet } from "@/lib/plugins";
import { resolveSandboxAuth } from "@/lib/tenant-auth";
import { resolveEffectiveRunner } from "@/lib/models";
import { supportsClaudeRunner } from "@/lib/models";
import { backupSessionFile, restoreSessionFile } from "@/lib/session-files";
import { generateMessageToken } from "@/lib/crypto";
import {
  parseResultEvent,
  captureTranscript,
  NO_TERMINAL_EVENT_FALLBACK,
} from "@/lib/transcript-utils";
import { uploadTranscript } from "@/lib/transcripts";
import { createNdjsonStream, ndjsonHeaders } from "@/lib/streaming";
import { getIdempotentResponse, setIdempotentResponse } from "@/lib/idempotency";
import { logger } from "@/lib/logger";
import { getEnv } from "@/lib/env";
import {
  NotFoundError,
  ConcurrencyLimitError,
  SessionStoppedError,
} from "@/lib/errors";
import type { TenantId, AgentId, RunTriggeredBy, WebhookSourceId } from "@/lib/types";

const DEFAULT_SESSION_TIMEOUT_MS = 30 * 60 * 1000;
const MCP_REFRESH_TTL_MS = 30 * 60 * 1000;

const EMPTY_PLUGINS: PluginFileSet = { skillFiles: [], agentFiles: [], warnings: [] };

const PUBLIC_TRIGGERS: ReadonlySet<RunTriggeredBy> = new Set([
  "api",
  "playground",
  "chat",
]);

/**
 * FIX #29: Zod schema for idempotency cache reads. The cache is process memory
 * (Map<string, unknown>); without a schema parse a corrupt entry could leak
 * raw `unknown` to callers. Parse-on-read with fall-through on failure keeps
 * the dispatcher honest.
 */
const IdempotentResponseSchema = z.object({
  sessionId: z.string().uuid(),
  messageId: z.string().uuid(),
});
type IdempotentResponse = z.infer<typeof IdempotentResponseSchema>;

/**
 * FIX #9 (partial): per-session AbortControllers used to signal in-flight
 * sandbox boots that the session has been cancelled. ensureSandbox /
 * createSessionSandbox in @/lib/sandbox does not yet accept a signal — that
 * change is too risky for an automated pass — so this map currently provides
 * the wiring for cancelSession to surface intent. A follow-up should plumb
 * the signal into the sandbox SDK call chain (TODO below).
 *
 * TODO(fix-9): plumb `signal: bootController.signal` through
 * `createSessionSandbox` / `reconnectSessionSandbox` so the in-flight Vercel
 * Sandbox provisioning can be aborted cleanly. Until then, cancel during
 * `creating` still falls back to the 5-min creating-watchdog.
 */
const sessionBootAborts = new Map<string, AbortController>();

export interface DispatchInput {
  tenantId: TenantId;
  agentId: AgentId;
  /** When undefined, a new session is created. */
  sessionId?: string;
  prompt: string;
  triggeredBy: RunTriggeredBy;
  /**
   * When true, the session is one-shot: stop the sandbox synchronously after
   * the message completes (or async via the internal-upload endpoint when
   * the request detached). Schedule + webhook + first-touch A2A use this.
   */
  ephemeral?: boolean;
  /** Per-session idle TTL override (seconds). Server-set only. */
  idleTtlSeconds?: number;
  /**
   * Idempotency key. Hits the in-memory store and returns the previously
   * computed `{ sessionId, messageId }` without spawning a new sandbox.
   * (DB-backed dedupe lands when the schema gains an idempotency column.)
   */
  idempotencyKey?: string;
  /** API key id that authenticated this request (audit trail). */
  callerKeyId?: string | null;
  /** Webhook source id when triggeredBy=webhook (audit + reverse linkage). */
  webhookSourceId?: WebhookSourceId | null;
  /** A2A contextId for multi-turn reuse. Resolved to an existing session before create. */
  contextId?: string;
  /** AgentCo callback bridge data (A2A only). */
  callbackData?: CallbackData;
  /** Extra hostnames for the sandbox network policy. */
  extraAllowedHostnames?: string[];
  platformApiUrl: string;
  /** Override the agent's max_turns for this message. Capped to validation bounds upstream. */
  maxTurnsOverride?: number;
  /** Override the agent's max_budget_usd for this message. */
  maxBudgetUsdOverride?: number;
}

export interface DispatchResult {
  sessionId: string;
  messageId: string;
  /** NDJSON byte stream for the caller to relay to the client. */
  stream: ReadableStream<Uint8Array>;
  /** Streaming Response shorthand — sets the right headers + status. */
  response: () => Response;
}

interface PreparedExecution {
  session: Session;
  agent: AgentInternal;
  messageId: string;
  effectiveBudget: number;
  effectiveMaxTurns: number;
}

/**
 * Single chokepoint. See module docstring for the contract.
 */
export async function dispatchSessionMessage(input: DispatchInput): Promise<DispatchResult> {
  // 1. Idempotency short-circuit (process-memory store).
  // SEC: cache key MUST be tenant-namespaced. Otherwise Tenant A's idempotency
  // key collides with Tenant B's identical key, leaking message ids/sessionIds
  // across tenants. Mirrors the A2A pattern in the JSON-RPC route.
  const idempCacheKey = input.idempotencyKey
    ? `dispatch:${input.tenantId}:${input.idempotencyKey}`
    : null;
  if (idempCacheKey) {
    const raw = getIdempotentResponse(idempCacheKey);
    let cached: IdempotentResponse | null = null;
    if (raw !== null) {
      const parseResult = IdempotentResponseSchema.safeParse(raw);
      if (parseResult.success) {
        cached = parseResult.data;
      } else {
        // FIX #29: corrupt cache entry — fall through to fresh dispatch.
        logger.warn("Idempotency cache entry failed schema parse; dispatching fresh", {
          idempotency_key: input.idempotencyKey,
          tenant_id: input.tenantId,
        });
      }
    }
    if (cached) {
      // FIX #22: verify the cached message still exists in DB and is in a
      // sane state (i.e. tenant-scoped row was not deleted). If not, fall
      // through and dispatch fresh.
      const existing = await queryOne(
        z.object({ id: z.string(), status: z.string() }),
        "SELECT id, status FROM session_messages WHERE id = $1 AND tenant_id = $2",
        [cached.messageId, input.tenantId],
      );
      if (!existing) {
        logger.warn("Idempotency cache hit but message row missing; dispatching fresh", {
          idempotency_key: input.idempotencyKey,
          tenant_id: input.tenantId,
          cached_message_id: cached.messageId,
        });
      } else {
        logger.info("Dispatcher idempotency hit", {
          idempotency_key: input.idempotencyKey,
          tenant_id: input.tenantId,
          session_id: cached.sessionId,
          message_id: cached.messageId,
          message_status: existing.status,
        });
        // Empty closed stream — caller already has the message_id and can poll.
        const empty = new ReadableStream<Uint8Array>({
          start(controller) {
            controller.close();
          },
        });
        return {
          sessionId: cached.sessionId,
          messageId: cached.messageId,
          stream: empty,
          response: () => new Response(empty, { status: 200, headers: ndjsonHeaders() }),
        };
      }
    }
  }

  // 2. Resolve / create session, claim the active slot, append the message
  //    row, and stamp budget reserve — all inside one tenant-scoped tx.
  const prepared = await reserveSessionAndMessage(input);

  // FIX #10 (adv-008): write the idempotency cache entry BEFORE spawning the
  // sandbox/runner. The transactional reservation is already committed by
  // reserveSessionAndMessage, so the {sessionId, messageId} pair is durable;
  // we just need to make the in-memory mapping available before any async
  // work that could be retried. (A future revision should persist this in DB
  // — note: in-memory is per-process and lost on restart.)
  if (idempCacheKey) {
    setIdempotentResponse(idempCacheKey, {
      sessionId: prepared.session.id,
      messageId: prepared.messageId,
    });
  }

  // 3. Outside the tx: ensure sandbox, build MCP, spawn runner.
  const stream = await runMessageStream(input, prepared);

  return {
    sessionId: prepared.session.id,
    messageId: prepared.messageId,
    stream,
    response: () => new Response(stream, { status: 200, headers: ndjsonHeaders() }),
  };
}

/**
 * Cancel the in-flight runner on a session.
 *
 *  - `creating`  → CAS to `stopped`. Sandbox boot is best-effort aborted by
 *                  the cleanup cron's stuck-creating watchdog. Active message
 *                  (if any) is marked `cancelled`.
 *  - `active`    → Mark active message `cancelled`, stop sandbox, CAS to `stopped`.
 *  - `idle`      → CAS to `stopped`, drop sandbox if any.
 *  - `stopped`   → Idempotent no-op; returns the existing row.
 */
export async function cancelSession(sessionId: string, tenantId: TenantId): Promise<Session> {
  const session = await getSession(sessionId, tenantId);
  if (session.status === "stopped") return session;

  // FIX #9 (partial): if a sandbox boot is in flight for this session, fire
  // its abort signal. The sandbox SDK call doesn't yet honor the signal
  // (TODO above), but cancelSession also CASes to stopped below — when the
  // boot completes the dispatcher's casCreatingToActive will see stopped
  // and shut the sandbox down on its own.
  const ctrl = sessionBootAborts.get(sessionId);
  if (ctrl) {
    try { ctrl.abort(); } catch { /* ignore */ }
    sessionBootAborts.delete(sessionId);
  }

  // Mark any in-flight message cancelled (best-effort — message may already
  // have terminated naturally between our read and write).
  await execute(
    `UPDATE session_messages
     SET status = 'cancelled', completed_at = NOW(),
         error_type = COALESCE(error_type, 'cancelled'),
         error_messages = CASE
           WHEN array_length(error_messages, 1) IS NULL
             THEN ARRAY['Cancelled by caller']
           ELSE error_messages
         END
     WHERE session_id = $1 AND tenant_id = $2 AND status IN ('queued', 'running')`,
    [sessionId, tenantId],
  );

  // Stop the sandbox if we have one — kill the runner subprocess.
  if (session.sandbox_id) {
    try {
      const sandbox = await reconnectSandbox(session.sandbox_id);
      if (sandbox) await sandbox.stop();
    } catch (err) {
      logger.warn("cancelSession: failed to stop sandbox (best-effort)", {
        session_id: sessionId,
        sandbox_id: session.sandbox_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return casToStopped(sessionId, tenantId);
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

async function reserveSessionAndMessage(input: DispatchInput): Promise<PreparedExecution> {
  return withTenantTransaction(input.tenantId, async (tx) => {
    // FIX #3 (adv-001): TOCTOU-safe concurrency cap. Acquire a tx-scoped
    // advisory lock keyed on tenant_id BEFORE any session count / insert.
    // Two concurrent dispatches for the same tenant are serialized at this
    // line; the lock auto-releases on commit/rollback. The previous
    // INSERT...WHERE (SELECT COUNT) pattern is not safe under READ COMMITTED.
    await tx.execute(
      `SELECT pg_advisory_xact_lock(hashtext('session_cap:' || $1::text))`,
      [input.tenantId],
    );

    // Load agent + budget once. Composio MCP cache fields live on the
    // internal row and the dispatcher needs them for buildMcpConfig.
    const agent = await tx.queryOne(
      AgentRowInternal,
      "SELECT * FROM agents WHERE id = $1 AND tenant_id = $2",
      [input.agentId, input.tenantId],
    );
    if (!agent) throw new NotFoundError("Agent not found");

    const isSubscriptionRun = supportsClaudeRunner(agent.model);
    await checkTenantBudget(tx, input.tenantId, { isSubscriptionRun });

    let session: Session | null = null;

    // a) Existing-session path: caller named a session.
    if (input.sessionId) {
      const row = await tx.queryOne(
        SessionRowSchema,
        `SELECT * FROM sessions WHERE id = $1 AND tenant_id = $2 FOR UPDATE`,
        [input.sessionId, input.tenantId],
      );
      if (!row) throw new NotFoundError("Session not found");
      if (row.agent_id !== input.agentId) {
        throw new NotFoundError("Session/agent mismatch");
      }
      if (row.status === "stopped") {
        // Public routes get 410 Gone. Internal triggers (schedule, webhook,
        // a2a) wrap dispatchSessionMessage and re-dispatch with sessionId
        // undefined on this error.
        if (PUBLIC_TRIGGERS.has(input.triggeredBy)) {
          throw new SessionStoppedError("Session is stopped");
        }
        session = null;
      } else if (row.status === "idle" || row.status === "active" || row.status === "creating") {
        // We can't claim active concurrency from `creating` — sandbox boot
        // hasn't finished — but for `idle` we run the CAS now.
        if (row.status === "idle") {
          // CAS idle → active inside this tx. Loser path — same as stopped:
          // public routes get 410, internal callers fall through to create
          // a fresh session.
          const claimed = await tx.queryOne(
            SessionRowSchema,
            `UPDATE sessions
             SET status = 'active', idle_since = NULL
             WHERE id = $1 AND tenant_id = $2 AND status = 'idle'
             RETURNING *`,
            [input.sessionId, input.tenantId],
          );
          if (!claimed) {
            if (PUBLIC_TRIGGERS.has(input.triggeredBy)) {
              throw new SessionStoppedError("Session is no longer idle");
            }
            session = null;
          } else {
            session = claimed;
          }
        } else if (row.status === "active") {
          // In-session concurrency: another message is already running.
          // R8: 409 via atomic CAS — surface as a typed error.
          throw new ConcurrencyLimitError("Session has an in-flight message");
        } else {
          // status === 'creating' — sandbox boot in progress. Treat like
          // active for R8 purposes; caller should retry after a short delay.
          throw new ConcurrencyLimitError("Session is still being created");
        }
      }
    }

    // b) Auto-resolve A2A contextId reuse.
    if (!session && input.contextId) {
      const reuse = await tx.queryOne(
        SessionRowSchema,
        `SELECT * FROM sessions
         WHERE tenant_id = $1 AND agent_id = $2 AND context_id = $3
           AND status NOT IN ('stopped')
         LIMIT 1
         FOR UPDATE`,
        [input.tenantId, input.agentId, input.contextId],
      );
      if (reuse && reuse.status === "idle") {
        const claimed = await tx.queryOne(
          SessionRowSchema,
          `UPDATE sessions
           SET status = 'active', idle_since = NULL
           WHERE id = $1 AND tenant_id = $2 AND status = 'idle'
           RETURNING *`,
          [reuse.id, input.tenantId],
        );
        if (claimed) session = claimed;
      } else if (reuse && reuse.status === "active") {
        throw new ConcurrencyLimitError("ContextId session has an in-flight message");
      }
      // creating/stopped fall through to create-new path
    }

    // c) Create a fresh session if none claimed yet.
    if (!session) {
      const ephemeral = input.ephemeral ?? false;
      const idleTtlSeconds = input.idleTtlSeconds ?? defaultIdleTtlSeconds(input.triggeredBy);

      // Concurrency cap (TOCTOU-safe). Same atomic INSERT-WHERE-COUNT
      // pattern as the legacy MAX_CONCURRENT_RUNS guard. `idle` does NOT
      // count toward the cap.
      const created = await tx.queryOne(
        SessionRowSchema,
        `INSERT INTO sessions (tenant_id, agent_id, status, context_id, ephemeral, idle_ttl_seconds, expires_at)
         SELECT $1, $2, 'creating', $4, $5, $6, NOW() + INTERVAL '${SESSION_EXPIRES_AFTER_INTERVAL}'
         WHERE (SELECT COUNT(*) FROM sessions WHERE tenant_id = $1 AND status IN ('creating', 'active')) < $3
         RETURNING *`,
        [input.tenantId, input.agentId, MAX_CONCURRENT_ACTIVE_SESSIONS, input.contextId ?? null, ephemeral, idleTtlSeconds],
      );
      if (!created) {
        throw new ConcurrencyLimitError(
          `Maximum of ${MAX_CONCURRENT_ACTIVE_SESSIONS} concurrent active sessions per tenant`,
        );
      }
      session = created;
    }

    // d) Append the session_messages row in `running` state. The runner
    //    flips it to a terminal status via finalize.
    const effectiveRunner = resolveEffectiveRunner(agent.model, agent.runner);
    const effectiveMaxTurns = input.maxTurnsOverride ?? agent.max_turns;
    const effectiveBudget = input.maxBudgetUsdOverride ?? agent.max_budget_usd;

    const messageRow = await tx.queryOne(
      SessionMessageRow,
      `INSERT INTO session_messages
         (session_id, tenant_id, prompt, status, triggered_by, runner, webhook_source_id, created_by_key_id, started_at)
       VALUES ($1, $2, $3, 'running', $4, $5, $6, $7, NOW())
       RETURNING *`,
      [
        session.id,
        input.tenantId,
        input.prompt,
        input.triggeredBy,
        effectiveRunner,
        input.webhookSourceId ?? null,
        input.callerKeyId ?? null,
      ],
    );
    if (!messageRow) {
      // Should be impossible — INSERT...RETURNING without WHERE always returns.
      throw new Error("Failed to create session_message row");
    }

    return {
      session,
      agent,
      messageId: messageRow.id,
      effectiveBudget,
      effectiveMaxTurns,
    };
  });
}

async function runMessageStream(
  input: DispatchInput,
  prepared: PreparedExecution,
): Promise<ReadableStream<Uint8Array>> {
  const env = getEnv();
  const { session, agent, messageId, effectiveBudget, effectiveMaxTurns } = prepared;

  // Spawn sandbox + builds in parallel (hot path — same shape as legacy
  // session-executor.prepareSessionSandbox).
  const effectiveRunner = resolveEffectiveRunner(agent.model, agent.runner);
  const skipPluginRefresh = !!session.sandbox_id && isMcpFresh(session);
  const mcpPromise = buildMcpConfig(agent, input.tenantId);
  const pluginPromise = skipPluginRefresh
    ? Promise.resolve(EMPTY_PLUGINS)
    : fetchPluginContent(agent.plugins ?? []);
  const authPromise = resolveSandboxAuth(input.tenantId, effectiveRunner);

  let sandbox: SessionSandboxInstance;

  // FIX #9: register a per-session AbortController so cancelSession can
  // signal in-flight sandbox boots. Cleaned up after sandbox is up (or on
  // throw). Plumbing into the sandbox SDK is the TODO above.
  const bootController = new AbortController();
  sessionBootAborts.set(session.id, bootController);

  if (session.sandbox_id) {
    // Reconnect path: race reconnect against MCP/plugin fetch.
    const auth = await authPromise;
    const [reconnectResult, mcpResult, pluginResult] = await Promise.all([
      reconnectSessionSandbox(session.sandbox_id, {
        agent: { ...agent, max_budget_usd: effectiveBudget, max_turns: effectiveMaxTurns },
        tenantId: input.tenantId,
        sessionId: session.id,
        platformApiUrl: input.platformApiUrl,
        aiGatewayApiKey: env.AI_GATEWAY_API_KEY,
        auth,
        mcpServers: undefined,
        mcpErrors: [],
        pluginFiles: [],
        maxIdleTimeoutMs: DEFAULT_SESSION_TIMEOUT_MS,
        callbackData: input.callbackData,
      }),
      mcpPromise,
      pluginPromise,
    ]);

    if (reconnectResult) {
      if (Object.keys(mcpResult.servers).length > 0) {
        reconnectResult.updateMcpConfig(mcpResult.servers, mcpResult.errors);
      }
      const idleSinceMs = session.idle_since
        ? Date.now() - new Date(session.idle_since).getTime()
        : Infinity;
      if (idleSinceMs > 5 * 60 * 1000) {
        await reconnectResult.extendTimeout(DEFAULT_SESSION_TIMEOUT_MS);
      }
      recordMcpRefresh(session.id, input.tenantId);
      sandbox = reconnectResult;
    } else {
      // Sandbox went missing — cold path with the resolved MCP/plugin set.
      sandbox = await coldStartSandbox({
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
    }
  } else {
    // Cold path: pure new-sandbox.
    const [mcpResult, pluginResult, auth] = await Promise.all([mcpPromise, pluginPromise, authPromise]);
    sandbox = await coldStartSandbox({
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
  }

  // Sandbox is up; we no longer need the boot abort controller for this session.
  sessionBootAborts.delete(session.id);

  // Flip session creating→active if it was creating.
  if (session.status === "creating") {
    const promoted = await casCreatingToActive(session.id, input.tenantId, { sandbox_id: sandbox.id });
    if (!promoted) {
      // Race: cleanup cron (or cancel) flipped it to stopped while we were
      // booting. Drop the sandbox and fail this message.
      await sandbox.stop().catch(() => {});
      throw new SessionStoppedError("Session was stopped during sandbox boot");
    }
  }

  // If the cancel signal fired during boot, drop the sandbox and bail.
  if (bootController.signal.aborted) {
    await sandbox.stop().catch(() => {});
    throw new SessionStoppedError("Session boot aborted by cancelSession");
  }

  // Mint the per-message bearer token bound to this messageId.
  const messageToken = await generateMessageToken(messageId, env.ENCRYPTION_KEY);

  let logsFn: () => AsyncIterable<string>;
  try {
    const result = await sandbox.runMessage({
      prompt: input.prompt,
      sdkSessionId: session.sdk_session_id,
      messageId,
      messageToken,
      maxTurns: effectiveMaxTurns,
      maxBudgetUsd: effectiveBudget,
    });
    logsFn = result.logs;
  } catch (err) {
    // Roll the session back to idle (or stop, if ephemeral) so the user can
    // retry. Mark the message failed in the same step.
    await transitionMessageStatus(messageId, input.tenantId, "running", "failed", {
      completed_at: new Date().toISOString(),
      error_type: "runner_spawn_failed",
      error_messages: [err instanceof Error ? err.message : String(err)],
    });
    if (session.ephemeral) {
      await casToStopped(session.id, input.tenantId).catch(() => {});
    } else {
      await transitionSessionStatus(
        session.id,
        input.tenantId,
        "active",
        "idle",
        { idle_since: new Date().toISOString() },
      ).catch(() => {});
    }
    throw err;
  }

  // Stream wrapping: capture transcript with truncation rules + persist
  // assets, then on natural close finalize the message.
  const transcriptChunks: string[] = [];
  const sdkSessionIdRef: { value: string | null } = { value: session.sdk_session_id };
  const logIterator = captureTranscript(
    logsFn(),
    transcriptChunks,
    input.tenantId,
    messageId,
    (event) => {
      if (
        event.type === "session_info" &&
        typeof event.sdk_session_id === "string" &&
        event.sdk_session_id.length > 0
      ) {
        sdkSessionIdRef.value = event.sdk_session_id;
      }
    },
  );

  let detached = false;
  async function* streamWithFinalize() {
    for await (const line of logIterator) {
      yield line;
    }
    if (detached) return;
    await finalizeMessage({
      messageId,
      tenantId: input.tenantId,
      session,
      sandbox,
      sdkSessionId: sdkSessionIdRef.value,
      transcriptChunks,
      effectiveBudget,
    });
  }

  return createNdjsonStream({
    messageId,
    sessionId: session.id,
    logIterator: streamWithFinalize(),
    onDetach: () => {
      detached = true;
      // CONTRACT (handled by U3 internal-upload route):
      //   When the stream detaches at 4.5min, the runner is still running.
      //   On its terminal event the runner POSTs to
      //   /api/internal/messages/:messageId/transcript. That endpoint owns
      //   finalization for the detached path: it persists the transcript,
      //   transitions the message, and — if the session is `ephemeral`
      //   AND the messageId token validates against the URL param — stops
      //   the sandbox. Persistent sessions go idle via `finalizeMessage`'s
      //   sister path.
      logger.info("Stream detached — runner will finalize via internal upload", {
        message_id: messageId,
        session_id: session.id,
      });
    },
  });
}

interface ColdStartArgs {
  agent: AgentInternal;
  tenantId: TenantId;
  sessionId: string;
  sdkSessionId: string | null;
  sessionBlobUrl: string | null;
  platformApiUrl: string;
  aiGatewayApiKey: string;
  auth: Awaited<ReturnType<typeof resolveSandboxAuth>>;
  mcpResult: McpBuildResult;
  pluginResult: PluginFileSet;
  callbackData?: CallbackData;
  effectiveBudget: number;
  effectiveMaxTurns: number;
}

async function coldStartSandbox(args: ColdStartArgs): Promise<SessionSandboxInstance> {
  if (args.mcpResult.errors.length > 0) {
    logger.warn("MCP config errors for session", {
      session_id: args.sessionId,
      errors: args.mcpResult.errors,
    });
  }
  const sandboxConfig: SessionSandboxConfig = {
    agent: { ...args.agent, max_budget_usd: args.effectiveBudget, max_turns: args.effectiveMaxTurns },
    tenantId: args.tenantId,
    sessionId: args.sessionId,
    platformApiUrl: args.platformApiUrl,
    aiGatewayApiKey: args.aiGatewayApiKey,
    auth: args.auth,
    mcpServers: args.mcpResult.servers,
    mcpErrors: args.mcpResult.errors,
    pluginFiles: [...args.pluginResult.skillFiles, ...args.pluginResult.agentFiles],
    maxIdleTimeoutMs: DEFAULT_SESSION_TIMEOUT_MS,
    callbackData: args.callbackData,
  };

  const sandbox = await createSessionSandbox(sandboxConfig);
  await updateSessionSandbox(args.sessionId, args.tenantId, sandbox.id);
  recordMcpRefresh(args.sessionId, args.tenantId);

  if (args.sdkSessionId && args.sessionBlobUrl) {
    await restoreSessionFile(sandbox, args.sessionBlobUrl, args.sdkSessionId);
  }
  return sandbox;
}

interface FinalizeArgs {
  messageId: string;
  tenantId: TenantId;
  session: Session;
  sandbox: SessionSandboxInstance;
  sdkSessionId: string | null;
  transcriptChunks: string[];
  effectiveBudget: number;
}

/**
 * Finalize a message reaching a terminal state. Writes:
 *   - transcript blob URL
 *   - message status (running → completed/failed/etc.)
 *   - tenant.current_month_spend rollup (preserves legacy
 *     transitionRunStatus billing semantics)
 *
 * Then transitions the session: `idle` if persistent, `stopped` if ephemeral.
 * Skips backupSessionFile for ephemeral sessions (the SDK session is about
 * to be discarded).
 *
 * Idempotency: short-circuits if the runner-driven internal-upload route
 * already finalized the message (status != 'running').
 */
async function finalizeMessage(args: FinalizeArgs): Promise<void> {
  const { messageId, tenantId, session, sandbox, sdkSessionId, transcriptChunks, effectiveBudget } = args;

  try {
    const currentStatus = await queryOne(
      z.object({ status: z.string() }),
      "SELECT status FROM session_messages WHERE id = $1 AND tenant_id = $2",
      [messageId, tenantId],
    );
    const alreadyFinalized = currentStatus?.status !== "running";

    if (!alreadyFinalized && transcriptChunks.length > 0) {
      const transcript = transcriptChunks.join("\n") + "\n";
      const blobUrl = await uploadTranscript(tenantId, messageId, transcript);
      const lastLine = transcriptChunks[transcriptChunks.length - 1];
      const resultData = (await parseResultEvent(lastLine)) ?? NO_TERMINAL_EVENT_FALLBACK;

      await transitionMessageStatus(
        messageId,
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
    } else if (alreadyFinalized) {
      logger.info("finalizeMessage: runner already finalized message, skipping", {
        message_id: messageId,
        status: currentStatus?.status,
      });
    }

    // Session-tail work — only if we did the finalization (otherwise the
    // internal-upload endpoint owns it).
    if (!alreadyFinalized) {
      await sessionTail({ sessionId: session.id, tenantId, sandbox, sdkSessionId, ephemeral: session.ephemeral });
    }
  } catch (err) {
    logger.error("finalizeMessage failed", {
      message_id: messageId,
      session_id: session.id,
      error: err instanceof Error ? err.message : String(err),
    });
    // Best-effort: mark message failed
    await transitionMessageStatus(messageId, tenantId, "running", "failed", {
      completed_at: new Date().toISOString(),
      error_type: "finalize_error",
      error_messages: [err instanceof Error ? err.message : String(err)],
    }).catch(() => {});
    // Best-effort: idle/stop the session
    if (session.ephemeral) {
      await casToStopped(session.id, tenantId).catch(() => {});
      await sandbox.stop().catch(() => {});
    } else {
      await transitionSessionStatus(
        session.id,
        tenantId,
        "active",
        "idle",
        { idle_since: new Date().toISOString() },
      ).catch(() => {});
    }
  }
}

interface SessionTailArgs {
  sessionId: string;
  tenantId: TenantId;
  sandbox: SessionSandboxInstance;
  sdkSessionId: string | null;
  ephemeral: boolean;
}

async function sessionTail(args: SessionTailArgs): Promise<void> {
  const { sessionId, tenantId, sandbox, sdkSessionId, ephemeral } = args;

  await incrementMessageCount(sessionId, tenantId);

  // Skip blob backup for ephemeral sessions — the session is about to be
  // discarded. (Saves I/O + storage churn under high-frequency
  // webhook/schedule fan-in.)
  let sessionBlobUrl: string | null = null;
  if (!ephemeral && sdkSessionId) {
    sessionBlobUrl = await backupSessionFile(sandbox, tenantId, sessionId, sdkSessionId);
    if (!sessionBlobUrl) {
      // FIX #21: structured-event surface so backup-retry / observability can
      // hook in. TODO: add a `last_backup_failed_at` column to sessions so
      // the cleanup cron can drive a follow-up backup pass; deferred here
      // because schema migrations are outside this fixer's scope.
      logger.error("session_blob_backup_failed", {
        event: "session_blob_backup_failed",
        session_id: sessionId,
        tenant_id: tenantId,
        sdk_session_id: sdkSessionId,
        impact: "cold_start_loses_context_since_last_successful_backup",
      });
    }
  }

  if (ephemeral) {
    await casToStopped(sessionId, tenantId);
    await sandbox.stop().catch((err) => {
      logger.warn("ephemeral sandbox stop failed (best-effort)", {
        session_id: sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
    });
  } else {
    await transitionSessionStatus(
      sessionId,
      tenantId,
      "active",
      "idle",
      {
        idle_since: new Date().toISOString(),
        ...(sdkSessionId ? { sdk_session_id: sdkSessionId } : {}),
        ...(sessionBlobUrl
          ? { session_blob_url: sessionBlobUrl, last_backup_at: new Date().toISOString() }
          : {}),
      },
    );
  }
}

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

