import type {
  AgentCard,
  AgentSkill,
  Task,
  TaskState,
  TextPart,
  DataPart,
  Message,
  TaskStatusUpdateEvent,
  TaskArtifactUpdateEvent,
} from "@a2a-js/sdk";
import {
  type TaskStore,
  type AgentExecutor,
  type ExecutionEventBus,
  RequestContext,
  ServerCallContext,
  A2AError,
} from "@a2a-js/sdk/server";
import { getHttpClient } from "@/db";
import { dispatchSessionMessage, cancelSession } from "@/lib/dispatcher";
import { findSessionByContextId } from "@/lib/sessions";
import { ConcurrencyLimitError, BudgetExceededError } from "@/lib/errors";
import type { CallbackData } from "@/lib/mcp";
import { IDENTITY_METADATA_KEY, IDENTITY_METADATA_KEY_V2 } from "@/lib/identity";
import { logger } from "@/lib/logger";
import type { TenantId, AgentId } from "@/lib/types";
import type { AgentInternal, SessionMessageStatus } from "@/lib/validation";
import { z } from "zod";
import { identityJsonbSchema } from "@/lib/validation";

// --- Status Mapping ---

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Map a session_message status to an A2A TaskState. Replaces the legacy
 * `runStatusToA2a` — the status enum picked up `queued` (pre-`running` slot)
 * but otherwise carries the same values.
 */
export function messageStatusToA2a(status: SessionMessageStatus): TaskState {
  switch (status) {
    case "queued":    return "submitted";
    case "running":   return "working";
    case "completed": return "completed";
    case "failed":    return "failed";
    case "cancelled": return "canceled";
    case "timed_out": return "failed";
    default: { const _: never = status; throw new Error(`Unhandled message status: ${_}`); }
  }
}

export function a2aToMessageStatus(state: TaskState): SessionMessageStatus | null {
  switch (state) {
    case "submitted": return "queued";
    case "working":   return "running";
    case "completed": return "completed";
    case "failed":    return "failed";
    case "canceled":  return "cancelled";
    case "rejected":  return "failed";
    default: return null;
  }
}

// --- A2A Response Headers ---

export function a2aHeaders(requestId: string, extra?: Record<string, string>): Record<string, string> {
  return { "A2A-Version": "1.0", "A2A-Request-Id": requestId, ...extra };
}

// --- Agent Card Cache (process-level, 60s TTL, max 1000 entries, LRU) ---

const agentCardCache = new Map<string, { card: AgentCard; expiresAt: number }>();
const agentCardInFlight = new Map<string, Promise<AgentCard | null>>();
const AGENT_CARD_TTL_MS = 60_000;
const AGENT_CARD_CACHE_MAX = 1000;

/** @internal Exported for testing only. */
export function getCachedAgentCard(cacheKey: string): AgentCard | null {
  const cached = agentCardCache.get(cacheKey);
  if (!cached) return null;
  if (cached.expiresAt <= Date.now()) {
    agentCardCache.delete(cacheKey);
    return null;
  }
  // LRU: move to end on access
  agentCardCache.delete(cacheKey);
  agentCardCache.set(cacheKey, cached);
  return cached.card;
}

/** @internal Exported for testing only. */
export function setCachedAgentCard(cacheKey: string, card: AgentCard): void {
  if (agentCardCache.size >= AGENT_CARD_CACHE_MAX) {
    // Evict LRU entry (first in insertion order)
    const firstKey = agentCardCache.keys().next().value;
    if (firstKey !== undefined) agentCardCache.delete(firstKey);
  }
  agentCardCache.set(cacheKey, { card, expiresAt: Date.now() + AGENT_CARD_TTL_MS });
}

/** Fetch-or-build with in-flight deduplication. Multiple simultaneous cold requests share one DB query. */
export async function getOrBuildAgentCard(
  cacheKey: string,
  build: () => Promise<AgentCard | null>,
): Promise<AgentCard | null> {
  const cached = getCachedAgentCard(cacheKey);
  if (cached) return cached;

  const inflight = agentCardInFlight.get(cacheKey);
  if (inflight) return inflight;

  const promise = build().then((card) => {
    agentCardInFlight.delete(cacheKey);
    if (card) setCachedAgentCard(cacheKey, card);
    return card;
  }).catch((err) => {
    agentCardInFlight.delete(cacheKey);
    throw err;
  });
  agentCardInFlight.set(cacheKey, promise);
  return promise;
}

// --- Agent Card Builder ---

const A2aAgentRow = z.object({
  id: z.string(),
  slug: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  model: z.string(),
  max_turns: z.coerce.number(),
  max_runtime_seconds: z.coerce.number(),
  a2a_tags: z.array(z.string()).default([]),
  skills: z.unknown().default([]),
  plugins: z.unknown().default([]),
  identity: identityJsonbSchema.default(null),
});

type SkillFile = { path: string; content: string };
type AgentSkillEntry = { folder: string; files?: SkillFile[] };
type AgentPluginEntry = { marketplace_id: string; plugin_name: string };

/** Extract first meaningful description line from SKILL.md content */
function extractSkillDescription(content: string): string | null {
  const lines = content.split("\n");
  let inFrontmatter = false;
  let frontmatterDone = false;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!frontmatterDone && trimmed === "---") {
      inFrontmatter = !inFrontmatter;
      if (!inFrontmatter) frontmatterDone = true;
      continue;
    }
    if (inFrontmatter) continue;
    if (!trimmed || trimmed.startsWith("#")) continue;
    if (trimmed.length > 10) return trimmed.slice(0, 200);
  }
  return null;
}

interface BuildAgentCardOptions {
  agentId: string;
  agentSlug: string;
  tenantSlug: string;
  tenantName: string;
  baseUrl: string;
}

export async function buildAgentCard(opts: BuildAgentCardOptions): Promise<AgentCard | null> {
  const { agentId, agentSlug, tenantSlug, tenantName, baseUrl } = opts;
  const sql = getHttpClient();

  const rows = await sql`
    SELECT id, slug, name, description, model, max_turns, max_runtime_seconds, a2a_tags, skills, plugins, identity
    FROM agents
    WHERE id = ${agentId}
      AND a2a_enabled = true
  `;

  if (rows.length === 0) return null;

  const agent = A2aAgentRow.parse(rows[0]);
  const jsonrpcUrl = `${baseUrl}/api/a2a/${tenantSlug}/${agentSlug}/jsonrpc`;

  const agentSkills: AgentSkill[] = [];

  // Skills from agents.skills JSONB: { folder, files: [{path, content}] }[]
  const ownSkills = Array.isArray(agent.skills) ? (agent.skills as AgentSkillEntry[]) : [];
  for (const skill of ownSkills) {
    if (!skill.folder) continue;
    // Extract description from SKILL.md file if present
    const skillMd = skill.files?.find((f) =>
      f.path.toLowerCase().endsWith("skill.md") || f.path.toLowerCase() === "skill.md",
    );
    const description = (skillMd && extractSkillDescription(skillMd.content)) ||
      `${skill.folder} skill`;
    agentSkills.push({
      id: skill.folder,
      name: skill.folder,
      description,
      inputModes: ["text/plain"],
      outputModes: ["text/plain"],
      tags: agent.a2a_tags,
    });
  }

  // Skills from agents.plugins JSONB: { marketplace_id, plugin_name }[]
  const pluginEntries = Array.isArray(agent.plugins) ? (agent.plugins as AgentPluginEntry[]) : [];
  for (const plugin of pluginEntries) {
    if (!plugin.plugin_name) continue;
    // plugin_name may be "vendor/skill-name" — use last segment as display name
    const name = plugin.plugin_name.split("/").pop() ?? plugin.plugin_name;
    agentSkills.push({
      id: `plugin:${plugin.plugin_name}`,
      name,
      description: `${name} (plugin skill)`,
      inputModes: ["text/plain"],
      outputModes: ["text/plain"],
      tags: [],
    });
  }

  // Fallback: represent the agent itself as a single skill
  if (agentSkills.length === 0) {
    agentSkills.push({
      id: agent.name,
      name: agent.name,
      description: agent.description || `Agent: ${agent.name}`,
      inputModes: ["text/plain"],
      outputModes: ["text/plain"],
      tags: agent.a2a_tags,
    });
  }

  // U4: agent-plane metadata version 2 signals that A2A taskId now maps
  // to `session_messages.id` (not `runs.id`) and that contextId-based
  // multi-turn reuses an existing session when the contextId matches a
  // non-stopped session for this tenant+agent.
  const agentPlaneMeta = {
    "agent-plane:taskid_mapping": "session_message_id",
    "agent-plane:metadata_version": 2,
    "agent-plane:multi_turn":
      "Send the same `contextId` on subsequent message/send|stream calls to reuse the existing session (if non-stopped). Each message becomes a distinct task whose taskId equals the session_messages row id.",
  };

  return {
    name: agent.name,
    description: (agent.identity as Record<string, any>)?.disclosure_summary || agent.description || `${agent.name} — powered by ${tenantName}`,
    url: jsonrpcUrl,
    version: "1.0.0",
    protocolVersion: "0.3.0",
    preferredTransport: "JSONRPC",
    defaultInputModes: ["text/plain"],
    defaultOutputModes: ["text/plain"],
    capabilities: {
      streaming: true,
      pushNotifications: false,
      stateTransitionHistory: false,
    },
    skills: agentSkills,
    additionalInterfaces: [
      { transport: "JSONRPC", url: jsonrpcUrl },
    ],
    provider: {
      organization: tenantName,
      url: baseUrl,
    },
    security: [{ bearerAuth: [] }],
    securitySchemes: {
      bearerAuth: {
        type: "http",
        scheme: "bearer",
      },
    },
    ...(() => {
      const identityV2 = agent.identity;
      const identityCompat = identityV2
        ? {
            name: (identityV2 as Record<string, any>)?.identity?.name ?? null,
            role: (identityV2 as Record<string, any>)?.identity?.role ?? null,
            description: (identityV2 as Record<string, any>)?.disclosure_summary ?? null,
          }
        : null;
      return {
        metadata: {
          ...agentPlaneMeta,
          ...(identityV2 ? { [IDENTITY_METADATA_KEY_V2]: identityV2 } : {}),
          ...(identityCompat ? { [IDENTITY_METADATA_KEY]: identityCompat } : {}),
        },
      };
    })(),
  } as AgentCard & { metadata?: Record<string, unknown> };
}

// --- Message → A2A Task Mapper ---

const MessageForTaskRow = z.object({
  id: z.string(),
  session_id: z.string(),
  status: z.enum(["queued", "running", "completed", "failed", "cancelled", "timed_out"]),
  result_summary: z.string().nullable(),
  duration_ms: z.coerce.number(),
  created_at: z.coerce.string(),
  completed_at: z.coerce.string().nullable(),
});

/**
 * Map a session_messages row to an A2A Task. The taskId IS the session_message
 * id; the contextId comes from the parent session row when available (the
 * session's `context_id` mirrors the original A2A request's contextId).
 * Callers may pass `effectiveContextId` to force the wire-level contextId
 * a client supplied — that takes precedence over the row.
 */
export function messageToA2aTask(
  message: z.infer<typeof MessageForTaskRow>,
  effectiveContextId?: string,
): Task {
  const state = messageStatusToA2a(message.status as SessionMessageStatus);
  const artifacts: Task["artifacts"] = [];

  if (message.result_summary && (state === "completed" || state === "failed")) {
    artifacts.push({
      artifactId: "result",
      name: "Agent Result",
      parts: [{ kind: "text", text: message.result_summary } as TextPart],
    });
  }

  const metadata: Record<string, unknown> = {};
  if (message.duration_ms > 0) {
    metadata["agent-plane"] = {
      duration_ms: message.duration_ms,
    };
  }

  return {
    id: message.id,
    kind: "task",
    contextId: effectiveContextId ?? message.session_id,
    status: {
      state,
      timestamp: message.completed_at || message.created_at,
    },
    artifacts: artifacts.length > 0 ? artifacts : undefined,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  };
}

// --- MessageBackedTaskStore ---

/**
 * A2A `TaskStore` backed by `session_messages`. Each task is one message;
 * the taskId IS `session_messages.id`. Implementation mirrors the legacy
 * `RunBackedTaskStore` — same `lastWrittenStatus` dedupe optimization
 * (saves ~200 DB calls per run) and same sanitized-error pattern (errors
 * surface to the SDK and into the JSON-RPC response, so we never let raw
 * SQL or internal text through).
 */
export class MessageBackedTaskStore implements TaskStore {
  private lastWrittenStatus: TaskState | null = null;

  constructor(
    private readonly tenantId: TenantId,
    // Retained for parity with the legacy constructor (audit-trail glue
    // upstream — currently passed through but not used here).
    private readonly createdByKeyId?: string,
  ) {
    void this.createdByKeyId;
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async load(taskId: string, _context?: ServerCallContext): Promise<Task | undefined> {
    if (!UUID_V4_REGEX.test(taskId)) return undefined;

    try {
      const sql = getHttpClient();
      const rows = await sql`
        SELECT m.id, m.session_id, m.status, m.result_summary, m.duration_ms,
               m.created_at, m.completed_at, m.transcript_blob_url,
               s.context_id AS session_context_id
        FROM session_messages m
        JOIN sessions s ON s.id = m.session_id
        WHERE m.id = ${taskId}
          AND m.tenant_id = ${this.tenantId}
      `;

      if (rows.length === 0) return undefined;
      const message = MessageForTaskRow.parse(rows[0]);
      const sessionContextId = (rows[0] as { session_context_id?: string | null }).session_context_id ?? undefined;
      const task = messageToA2aTask(message, sessionContextId ?? undefined);

      // Note: result_summary already carries the assistant tail when the
      // dispatcher's finalize path persisted it. We deliberately don't fetch
      // and parse the transcript blob here — the legacy in-row `transcript`
      // column is gone, and a Vercel Blob round-trip on every `tasks/get`
      // would dominate the request budget. Callers needing the full
      // transcript hit `/api/sessions/:id/messages/:id`.
      return task;
    } catch (err) {
      logger.error("MessageBackedTaskStore.load failed", {
        task_id: taskId,
        tenant_id: this.tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async save(task: Task, _context?: ServerCallContext): Promise<void> {
    // Status-only UPDATE — SDK calls save() on EVERY event (50-200 per run).
    // Skip if status hasn't changed (reduces ~200 DB calls to ~3 per message).
    if (task.status.state === this.lastWrittenStatus) return;

    try {
      const messageStatus = a2aToMessageStatus(task.status.state);
      if (!messageStatus) return; // Unknown/unhandled state — skip

      const sql = getHttpClient();
      // Bound to non-terminal rows (terminal status guard) so we never
      // overwrite the dispatcher's authoritative finalize write with a
      // stale A2A SDK status update.
      await sql`
        UPDATE session_messages SET status = ${messageStatus}
        WHERE id = ${task.id} AND tenant_id = ${this.tenantId}
          AND status NOT IN ('completed', 'failed', 'cancelled', 'timed_out')
      `;
      this.lastWrittenStatus = task.status.state;
    } catch (err) {
      // CRITICAL: SDK leaks err.message into JSON-RPC responses.
      // Never throw SQL, connection strings, or internal details.
      logger.error("MessageBackedTaskStore.save failed", {
        task_id: task.id,
        tenant_id: this.tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw A2AError.internalError("Internal storage error");
    }
  }
}

// --- Shared A2A Log Consumption (Unit 2) ---

/**
 * Consume an async log stream, publish A2A events (artifact + status updates),
 * and return the last assistant text for result extraction.
 * Works with both `prepareRunExecution().logIterator` and `captureTranscript(runMessage().logs())`.
 */
async function consumeA2aLogStream(
  logIterator: AsyncIterable<string>,
  eventBus: ExecutionEventBus,
  taskId: string,
  contextId: string | undefined,
): Promise<string> {
  let lastAssistantText = "";
  try {
    for await (const line of logIterator) {
      try {
        const event = JSON.parse(line);
        // Accumulate assistant message text (the actual agent output)
        if (event.type === "assistant" && event.message?.content) {
          const textBlocks = Array.isArray(event.message.content)
            ? event.message.content.filter((b: { type?: string }) => b.type === "text")
            : [];
          if (textBlocks.length > 0) {
            lastAssistantText = textBlocks.map((b: { text: string }) => b.text).join("\n");
          }
        }
        if (event.type === "result") {
          // Publish artifact with the accumulated agent output
          const resultText = lastAssistantText || event.result || event.text || "";
          if (resultText) {
            eventBus.publish({
              kind: "artifact-update",
              taskId,
              contextId,
              artifact: {
                artifactId: "result",
                name: "Agent Result",
                parts: [{ kind: "text", text: resultText } as TextPart],
              },
              lastChunk: true,
            } as TaskArtifactUpdateEvent);
          }
        }
      } catch {
        // Non-JSON line — skip
      }
    }
  } catch (err) {
    logger.error("Error consuming log stream", {
      task_id: taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return lastAssistantText;
}

// --- SandboxAgentExecutor ---

interface ExecutorDeps {
  tenantId: TenantId;
  agent: AgentInternal;
  createdByKeyId: string;
  platformApiUrl: string;
  remainingBudget: number;
  requestedMaxBudget?: number;
}

/**
 * U4: AgentExecutor backed by the unified `dispatchSessionMessage` chokepoint.
 *
 * Flow:
 *  1. Parse the inbound A2A message (text + optional `ac_callback` data part).
 *  2. If the request supplies a non-trivial `contextId`, look it up. A
 *     non-stopped match means we reuse the session (`ephemeral: false`).
 *     Otherwise dispatch with `ephemeral: true` so the sandbox tears down
 *     after the message completes — and stamp the contextId on the session
 *     so subsequent calls with the same contextId reuse it.
 *  3. The dispatcher returns a `messageId` — that becomes the A2A `taskId`
 *     in every subsequent event. We then drain the dispatcher's NDJSON
 *     stream, surface assistant text + result artifacts, and read the
 *     terminal message status to publish the final A2A event.
 *
 *  Errors are sanitized at the boundary: anything not already an `A2AError`
 *  is translated to a generic "Internal execution error" wire message.
 */
export class SandboxAgentExecutor implements AgentExecutor {
  constructor(private readonly deps: ExecutorDeps) {}

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const inboundTaskId = requestContext.taskId;
    // Wire-level contextId: prefer client-supplied, fall back to inboundTaskId
    // so SDK contracts (every event carries a contextId) hold even when the
    // client didn't send one.
    let effectiveContextId = requestContext.contextId || inboundTaskId;
    let liveTaskId = inboundTaskId; // Re-bound to the dispatcher's messageId once known.

    try {
      // Validate inbound taskId
      if (!UUID_V4_REGEX.test(inboundTaskId)) {
        throw A2AError.invalidParams("Invalid task ID format");
      }

      // Extract prompt from user message (text parts + data parts)
      const textParts = requestContext.userMessage.parts.filter(
        (p): p is TextPart => p.kind === "text",
      );
      if (textParts.length === 0) {
        throw A2AError.invalidParams("Message must contain at least one text part");
      }

      // Extract data parts (e.g. ac_callback with callback_url, callback_token, available_tools)
      const dataParts = requestContext.userMessage.parts.filter(
        (p): p is DataPart => p.kind === "data",
      );
      const callbackData = dataParts.find(
        (p) => p.data && typeof p.data === "object" && (p.data as Record<string, unknown>).type === "ac_callback",
      );
      const cb = callbackData ? callbackData.data as Record<string, unknown> : undefined;
      const callbackUrl = cb?.callback_url as string | undefined;

      logger.info("A2A message parts", {
        text_parts: textParts.length,
        data_parts: dataParts.length,
        has_callback: !!cb,
        callback_url: callbackUrl,
        tool_count: cb?.available_tools ? (cb.available_tools as unknown[]).length : 0,
        context_id: requestContext.contextId,
      });

      const prompt = textParts.map((p) => p.text).join("\n");

      // Extract callback hostname for network policy
      let callbackHostname: string | undefined;
      if (callbackUrl) {
        try {
          callbackHostname = new URL(callbackUrl).hostname;
        } catch { /* invalid URL, skip */ }
      }

      const parsedCallbackData: CallbackData | undefined = cb ? {
        url: callbackUrl!,
        token: cb.callback_token as string,
        tools: cb.available_tools as CallbackData["tools"],
      } : undefined;

      const agent = this.deps.agent;
      const tenantId = this.deps.tenantId;

      // Compute effective budget (intersection of agent cap, tenant remaining,
      // and any caller-requested override carried in the A2A metadata).
      const effectiveBudget = Math.min(
        agent.max_budget_usd,
        this.deps.remainingBudget,
        ...(this.deps.requestedMaxBudget !== undefined ? [this.deps.requestedMaxBudget] : []),
      );

      // --- Session reuse decision ---
      // ContextId distinguishes "this is a follow-up turn" from "this is the
      // first turn / a one-shot". We treat `contextId === inboundTaskId` as
      // "not really a contextId" because some clients auto-generate that as
      // a default; the dispatcher then creates a fresh ephemeral session.
      const clientContextId =
        requestContext.contextId && requestContext.contextId !== inboundTaskId
          ? requestContext.contextId
          : undefined;

      let reuseSessionId: string | undefined;
      let dispatchEphemeral = true;

      if (clientContextId) {
        const existing = await findSessionByContextId(
          tenantId,
          agent.id as AgentId,
          clientContextId,
        );
        if (existing && existing.status !== "stopped") {
          reuseSessionId = existing.id;
          dispatchEphemeral = false;
          logger.info("A2A session reuse hit", {
            session_id: existing.id,
            context_id: clientContextId,
            status: existing.status,
          });
        } else {
          // First call with this contextId — dispatcher stamps the session
          // with `context_id` so the next call reuses it. The session is
          // PERSISTENT (ephemeral=false) for the first turn so future
          // contextId-keyed messages can re-attach via findSessionByContextId.
          // The cleanup cron will stop the session after its per-row idle TTL
          // if no follow-up arrives.
          dispatchEphemeral = false;
          logger.info("A2A first message with contextId", {
            context_id: clientContextId,
          });
        }
      }

      // --- Dispatch via the unified chokepoint ---
      let dispatch;
      try {
        dispatch = await dispatchSessionMessage({
          tenantId,
          agentId: agent.id as AgentId,
          sessionId: reuseSessionId,
          prompt,
          triggeredBy: "a2a",
          ephemeral: dispatchEphemeral,
          callerKeyId: this.deps.createdByKeyId,
          contextId: clientContextId,
          callbackData: parsedCallbackData,
          extraAllowedHostnames: callbackHostname ? [callbackHostname] : undefined,
          platformApiUrl: this.deps.platformApiUrl,
          overrides: { maxBudgetUsd: this.deps.requestedMaxBudget },
        });
      } catch (err) {
        if (err instanceof ConcurrencyLimitError) {
          throw new A2AError(
            -32000,
            "Tenant or session is busy — try again in a moment",
          );
        }
        if (err instanceof BudgetExceededError) {
          throw new A2AError(-32001, "Monthly budget exceeded");
        }
        throw err;
      }

      // From here on, A2A taskId == messageId. Re-bind so all subsequent
      // events carry the dispatcher's authoritative id.
      liveTaskId = dispatch.messageId;

      // Publish the canonical "task" + initial "working" event using the
      // dispatcher's messageId so clients reconciling on `tasks/get` see the
      // same id we wrote into `session_messages`.
      eventBus.publish({
        kind: "task",
        id: liveTaskId,
        contextId: effectiveContextId,
        status: { state: "working", timestamp: new Date().toISOString() },
      } as unknown as Task);

      eventBus.publish({
        kind: "status-update",
        taskId: liveTaskId,
        contextId: effectiveContextId,
        status: { state: "working", timestamp: new Date().toISOString() },
        final: false,
      } as TaskStatusUpdateEvent);

      // Drain the dispatcher's NDJSON stream — pull events, surface assistant
      // text + result artifacts on the A2A bus, and let finalize hooks run.
      const lineIterator = ndjsonLines(dispatch.stream);
      await consumeA2aLogStream(lineIterator, eventBus, liveTaskId, effectiveContextId);

      // Read the finalized message status to emit the final A2A event with
      // the correct terminal state.
      await this.publishFinalStatus(liveTaskId, effectiveContextId, eventBus);
    } catch (err) {
      // Sanitize: only `A2AError` messages are safe to surface. Anything
      // else collapses to a generic "Internal execution error" string.
      const isA2aError = err instanceof A2AError;
      if (!isA2aError) {
        logger.error("SandboxAgentExecutor.execute failed", {
          task_id: liveTaskId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      eventBus.publish({
        kind: "status-update",
        taskId: liveTaskId,
        contextId: effectiveContextId,
        status: {
          state: "failed",
          timestamp: new Date().toISOString(),
          message: {
            role: "agent",
            kind: "message",
            messageId: liveTaskId,
            parts: [{ kind: "text", text: isA2aError ? (err as A2AError).message : "Internal execution error" } as TextPart],
          },
        },
        final: true,
      } as TaskStatusUpdateEvent);
    } finally {
      eventBus.finished();
    }
  }

  /**
   * Read finalized message status and publish a final A2A status event.
   */
  private async publishFinalStatus(
    messageId: string,
    effectiveContextId: string,
    eventBus: ExecutionEventBus,
  ): Promise<void> {
    let finalState: TaskState = "completed";
    try {
      const sql = getHttpClient();
      const finalRows = await sql`
        SELECT status FROM session_messages WHERE id = ${messageId} AND tenant_id = ${this.deps.tenantId}
      `;
      const finalStatus = finalRows[0]?.status as SessionMessageStatus | undefined;
      finalState = finalStatus ? messageStatusToA2a(finalStatus) : "completed";
    } catch (err) {
      logger.error("publishFinalStatus failed to read message status", {
        message_id: messageId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    eventBus.publish({
      kind: "status-update",
      taskId: messageId,
      contextId: effectiveContextId,
      status: {
        state: finalState,
        timestamp: new Date().toISOString(),
        ...(finalState === "failed"
          ? {
              message: {
                role: "agent",
                kind: "message",
                messageId,
                parts: [{ kind: "text", text: "Agent execution failed" } as TextPart],
              },
            }
          : {}),
      },
      final: true,
    } as TaskStatusUpdateEvent);
  }

  /**
   * Map taskId → messageId → sessionId, then call `cancelSession`. Errors
   * are sanitized — the SDK will leak `err.message` onto the wire.
   */
  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    try {
      if (!UUID_V4_REGEX.test(taskId)) {
        throw A2AError.taskNotFound(taskId);
      }

      const sql = getHttpClient();
      const rows = await sql`
        SELECT session_id, status FROM session_messages
        WHERE id = ${taskId} AND tenant_id = ${this.deps.tenantId}
      `;
      if (rows.length === 0) {
        throw A2AError.taskNotFound(taskId);
      }

      const sessionId = rows[0].session_id as string;
      const messageStatus = rows[0].status as SessionMessageStatus;

      // Already terminal — emit a canceled event for protocol parity, then return.
      if (messageStatus !== "queued" && messageStatus !== "running") {
        eventBus.publish({
          kind: "status-update",
          taskId,
          contextId: taskId,
          status: { state: "canceled", timestamp: new Date().toISOString() },
          final: true,
        } as TaskStatusUpdateEvent);
        return;
      }

      // Stops the sandbox + marks active message cancelled in one shot.
      await cancelSession(sessionId, this.deps.tenantId);
      logger.info("A2A cancelTask: session cancelled", {
        task_id: taskId,
        session_id: sessionId,
      });

      eventBus.publish({
        kind: "status-update",
        taskId,
        contextId: taskId,
        status: { state: "canceled", timestamp: new Date().toISOString() },
        final: true,
      } as TaskStatusUpdateEvent);
    } catch (err) {
      const isA2aError = err instanceof A2AError;
      if (!isA2aError) {
        logger.error("SandboxAgentExecutor.cancelTask failed", {
          task_id: taskId,
          error: err instanceof Error ? err.message : String(err),
        });
        // Don't re-throw raw errors onto the wire — the SDK serializes them.
      } else {
        // A2AError messages are safe to surface; let the SDK propagate it.
        throw err;
      }
    } finally {
      eventBus.finished();
    }
  }

}

/**
 * Convert a Uint8Array stream of NDJSON bytes into an async iterable of
 * lines (one JSON event per yield). Drops trailing partial line at EOF.
 */
async function* ndjsonLines(stream: ReadableStream<Uint8Array>): AsyncIterable<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    // eslint-disable-next-line no-constant-condition
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      if (!value) continue;
      buffer += decoder.decode(value, { stream: true });
      let nl: number;
      while ((nl = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (line.length > 0) yield line;
      }
    }
    if (buffer.length > 0) {
      yield buffer;
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}

// --- Input Validation Helpers ---

export function validateA2aMessage(message: Message): string | null {
  if (!message.parts || message.parts.length === 0) {
    return "Message must contain at least one part";
  }
  if (message.role !== "user") {
    return "Message role must be 'user'";
  }
  if (message.referenceTaskIds) {
    if (message.referenceTaskIds.length > 10) {
      return "Maximum 10 referenceTaskIds allowed";
    }
    for (const refId of message.referenceTaskIds) {
      if (!UUID_V4_REGEX.test(refId)) {
        return `Invalid referenceTaskId format: ${refId}`;
      }
    }
  }
  if (message.contextId) {
    if (message.contextId.length > 128) {
      return "contextId must be at most 128 characters";
    }
    if (!/^[a-zA-Z0-9-]+$/.test(message.contextId)) {
      return "contextId must be alphanumeric with hyphens only";
    }
  }
  return null;
}

export function sanitizeRequestId(header: string | null): string {
  if (!header) return crypto.randomUUID();
  const cleaned = header.slice(0, 128).replace(/[^a-zA-Z0-9-]/g, "");
  return cleaned.length > 0 ? cleaned : crypto.randomUUID();
}
