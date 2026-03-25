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
import { createRun, getRun, transitionRunStatus } from "@/lib/runs";
import { prepareRunExecution, finalizeRun } from "@/lib/run-executor";
import type { CallbackData } from "@/lib/mcp";
import { reconnectSandbox } from "@/lib/sandbox";
import { IDENTITY_METADATA_KEY, IDENTITY_METADATA_KEY_V2 } from "@/lib/identity";
import { logger } from "@/lib/logger";
import type { RunStatus, TenantId, AgentId, RunId } from "@/lib/types";
import type { AgentInternal } from "@/lib/validation";
import { z } from "zod";
import { identityJsonbSchema } from "@/lib/validation";

// --- Status Mapping ---

const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export function runStatusToA2a(status: RunStatus): TaskState {
  switch (status) {
    case "pending":   return "working";
    case "running":   return "working";
    case "completed": return "completed";
    case "failed":    return "failed";
    case "cancelled": return "canceled";
    case "timed_out": return "failed";
    default: { const _: never = status; throw new Error(`Unhandled run status: ${_}`); }
  }
}

export function a2aToRunStatus(state: TaskState): RunStatus | null {
  switch (state) {
    case "submitted": return "pending";
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
      if (!identityV2) return {};
      const identityCompat = {
        name: (identityV2 as Record<string, any>)?.identity?.name ?? null,
        role: (identityV2 as Record<string, any>)?.identity?.role ?? null,
        description: (identityV2 as Record<string, any>)?.disclosure_summary ?? null,
      };
      return {
        metadata: {
          [IDENTITY_METADATA_KEY_V2]: identityV2,
          [IDENTITY_METADATA_KEY]: identityCompat,
        },
      };
    })(),
  } as AgentCard & { metadata?: Record<string, unknown> };
}

// --- Run → A2A Task Mapper ---

const RunForTaskRow = z.object({
  id: z.string(),
  status: z.enum(["pending", "running", "completed", "failed", "cancelled", "timed_out"]),
  result_summary: z.string().nullable(),
  duration_ms: z.coerce.number(),
  created_at: z.coerce.string(),
  completed_at: z.coerce.string().nullable(),
});

export function runToA2aTask(run: z.infer<typeof RunForTaskRow>): Task {
  const state = runStatusToA2a(run.status as RunStatus);
  const artifacts: Task["artifacts"] = [];

  if (run.result_summary && (state === "completed" || state === "failed")) {
    artifacts.push({
      artifactId: "result",
      name: "Agent Result",
      parts: [{ kind: "text", text: run.result_summary } as TextPart],
    });
  }

  const metadata: Record<string, unknown> = {};
  if (run.duration_ms > 0) {
    metadata["agent-plane"] = {
      duration_ms: run.duration_ms,
    };
  }

  return {
    id: run.id,
    kind: "task",
    contextId: run.id, // Phase 1: contextId = taskId (no multi-turn)
    status: {
      state,
      timestamp: run.completed_at || run.created_at,
    },
    artifacts: artifacts.length > 0 ? artifacts : undefined,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
  };
}

// --- RunBackedTaskStore ---

export class RunBackedTaskStore implements TaskStore {
  private lastWrittenStatus: TaskState | null = null;

  constructor(
    private readonly tenantId: TenantId,
    private readonly createdByKeyId?: string,
  ) {}

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async load(taskId: string, _context?: ServerCallContext): Promise<Task | undefined> {
    if (!UUID_V4_REGEX.test(taskId)) return undefined;

    try {
      const sql = getHttpClient();
      const rows = await sql`
        SELECT id, status, result_summary, duration_ms, created_at, completed_at, transcript
        FROM runs
        WHERE id = ${taskId}
          AND tenant_id = ${this.tenantId}
      `;

      if (rows.length === 0) return undefined;
      const run = RunForTaskRow.parse(rows[0]);
      const task = runToA2aTask(run);

      // If completed and result_summary is just a status code, extract actual output from transcript
      if (task.status.state === "completed" && rows[0].transcript) {
        const transcript = typeof rows[0].transcript === "string" ? rows[0].transcript : "";
        const lines = transcript.split("\n").filter(Boolean);
        let lastAssistantText = "";
        for (const line of lines) {
          try {
            const event = JSON.parse(line);
            if (event.type === "assistant" && event.message?.content) {
              const textBlocks = Array.isArray(event.message.content)
                ? event.message.content.filter((b: { type?: string }) => b.type === "text")
                : [];
              if (textBlocks.length > 0) {
                lastAssistantText = textBlocks.map((b: { text: string }) => b.text).join("\n");
              }
            }
          } catch { /* skip non-JSON */ }
        }
        if (lastAssistantText) {
          task.artifacts = [{
            artifactId: "result",
            name: "Agent Result",
            parts: [{ kind: "text", text: lastAssistantText } as TextPart],
          }];
        }
      }

      return task;
    } catch (err) {
      logger.error("RunBackedTaskStore.load failed", {
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
    // Skip if status hasn't changed (reduces ~200 DB calls to ~3 per run).
    if (task.status.state === this.lastWrittenStatus) return;

    try {
      const runStatus = a2aToRunStatus(task.status.state);
      if (!runStatus) return; // Unknown/unhandled state — skip

      const sql = getHttpClient();
      await sql`
        UPDATE runs SET status = ${runStatus}
        WHERE id = ${task.id} AND tenant_id = ${this.tenantId}
          AND status NOT IN ('completed', 'failed', 'cancelled', 'timed_out')
      `;
      this.lastWrittenStatus = task.status.state;
    } catch (err) {
      // CRITICAL: SDK leaks err.message into JSON-RPC responses.
      // Never throw SQL, connection strings, or internal details.
      logger.error("RunBackedTaskStore.save failed", {
        task_id: task.id,
        tenant_id: this.tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      throw A2AError.internalError("Internal storage error");
    }
  }
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

export class SandboxAgentExecutor implements AgentExecutor {
  constructor(private readonly deps: ExecutorDeps) {}

  async execute(requestContext: RequestContext, eventBus: ExecutionEventBus): Promise<void> {
    const taskId = requestContext.taskId;

    try {
      // Validate taskId
      if (!UUID_V4_REGEX.test(taskId)) {
        throw A2AError.invalidParams("Invalid task ID format");
      }

      // Publish initial task event — required by SDK to set currentTask
      eventBus.publish({
        kind: "task",
        id: taskId,
        contextId: requestContext.contextId,
        status: { state: "working", timestamp: new Date().toISOString() },
      } as unknown as Task);

      // Publish "working" status update
      eventBus.publish({
        kind: "status-update",
        taskId,
        contextId: requestContext.contextId,
        status: { state: "working", timestamp: new Date().toISOString() },
        final: false,
      } as TaskStatusUpdateEvent);

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

      // Parse callback fields once
      const cb = callbackData
        ? callbackData.data as Record<string, unknown>
        : undefined;
      const callbackUrl = cb?.callback_url as string | undefined;

      logger.info("A2A message parts", {
        text_parts: textParts.length,
        data_parts: dataParts.length,
        has_callback: !!cb,
        callback_url: callbackUrl,
        tool_count: cb?.available_tools ? (cb.available_tools as unknown[]).length : 0,
      });

      // Build prompt from text parts (callback data is handled via MCP bridge, not prompt text)
      const prompt = textParts.map((p) => p.text).join("\n");

      // Extract callback hostname for network policy
      let callbackHostname: string | undefined;
      if (callbackUrl) {
        try {
          callbackHostname = new URL(callbackUrl).hostname;
        } catch { /* invalid URL, skip */ }
      }

      const agent = this.deps.agent;

      // Compute effective budget
      const agentBudget = agent.max_budget_usd;
      const tenantRemaining = this.deps.remainingBudget;
      const requestedBudget = this.deps.requestedMaxBudget;
      const effectiveBudget = Math.min(
        agentBudget,
        tenantRemaining,
        ...(requestedBudget !== undefined ? [requestedBudget] : []),
      );

      // Create run
      const { run } = await createRun(
        this.deps.tenantId,
        agent.id as AgentId,
        prompt,
        {
          triggeredBy: "a2a",
          createdByKeyId: this.deps.createdByKeyId,
        },
      );

      // Log incoming A2A message as the first transcript event
      const promptPreview = prompt.split("\n").slice(0, 5).join("\n").slice(0, 500);
      const a2aIncomingEvent = JSON.stringify({
        type: "a2a_incoming",
        run_id: run.id,
        context_id: requestContext.contextId,
        task_id: taskId,
        agent_name: agent.name,
        sender: this.deps.createdByKeyId ?? "unknown",
        prompt_preview: promptPreview,
        has_callback: !!cb,
        callback_url: callbackUrl,
        timestamp: new Date().toISOString(),
      });

      // Prepare and start sandbox execution
      const { sandbox, logIterator, transcriptChunks } = await prepareRunExecution({
        agent,
        tenantId: this.deps.tenantId,
        runId: run.id as RunId,
        prompt,
        platformApiUrl: this.deps.platformApiUrl,
        effectiveBudget,
        effectiveMaxTurns: agent.max_turns,
        maxRuntimeSeconds: agent.max_runtime_seconds,
        extraAllowedHostnames: callbackHostname ? [callbackHostname] : [],
        callbackData: cb ? {
          url: callbackUrl!,
          token: cb.callback_token as string,
          tools: cb.available_tools as CallbackData["tools"],
        } : undefined,
      });

      // Inject the A2A incoming event as the first transcript entry
      transcriptChunks.unshift(a2aIncomingEvent);

      // Consume log stream, publish A2A events
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
                  contextId: requestContext.contextId,
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

      // Finalize run: persist transcript, update billing, stop sandbox
      await finalizeRun(run.id as RunId, this.deps.tenantId, transcriptChunks, sandbox, effectiveBudget);

      // Read finalized status and publish final A2A event
      const sql = getHttpClient();
      const finalRows = await sql`
        SELECT status FROM runs WHERE id = ${run.id} AND tenant_id = ${this.deps.tenantId}
      `;
      const finalStatus = finalRows[0]?.status as RunStatus | undefined;
      const finalState = finalStatus ? runStatusToA2a(finalStatus) : "completed";

      // Publish final status
      eventBus.publish({
        kind: "status-update",
        taskId,
        contextId: requestContext.contextId,
        status: {
          state: finalState,
          timestamp: new Date().toISOString(),
          ...(finalState === "failed" ? { message: { role: "agent", kind: "message", messageId: taskId, parts: [{ kind: "text", text: "Agent execution failed" } as TextPart] } } : {}),
        },
        final: true,
      } as TaskStatusUpdateEvent);

    } catch (err) {
      // Sanitize errors — never leak internals
      const isA2aError = err instanceof A2AError;
      if (!isA2aError) {
        logger.error("SandboxAgentExecutor.execute failed", {
          task_id: taskId,
          error: err instanceof Error ? err.message : String(err),
        });
      }

      eventBus.publish({
        kind: "status-update",
        taskId,
        contextId: requestContext.contextId,
        status: {
          state: "failed",
          timestamp: new Date().toISOString(),
          message: {
            role: "agent",
            kind: "message",
            messageId: taskId,
            parts: [{ kind: "text", text: isA2aError ? (err as A2AError).message : "Internal execution error" } as TextPart],
          },
        },
        final: true,
      } as TaskStatusUpdateEvent);
    } finally {
      eventBus.finished();
    }
  }

  async cancelTask(taskId: string, eventBus: ExecutionEventBus): Promise<void> {
    try {
      if (!UUID_V4_REGEX.test(taskId)) {
        throw A2AError.taskNotFound(taskId);
      }

      // Load the run to check current status and get sandbox_id
      const run = await getRun(taskId, this.deps.tenantId);

      if (run.status !== "running" && run.status !== "pending") {
        // Already in terminal state — nothing to cancel
        eventBus.publish({
          kind: "status-update",
          taskId,
          contextId: taskId,
          status: { state: "canceled", timestamp: new Date().toISOString() },
          final: true,
        } as TaskStatusUpdateEvent);
        return;
      }

      // Stop the sandbox if running (mirrors /api/runs/:id/cancel)
      if (run.sandbox_id) {
        const sandbox = await reconnectSandbox(run.sandbox_id);
        if (sandbox) {
          await sandbox.stop();
          logger.info("Sandbox stopped for A2A cancellation", {
            task_id: taskId,
            sandbox_id: run.sandbox_id,
          });
        }
      }

      await transitionRunStatus(
        taskId as RunId,
        this.deps.tenantId,
        run.status,
        "cancelled",
        { completed_at: new Date().toISOString() },
      );

      eventBus.publish({
        kind: "status-update",
        taskId,
        contextId: taskId,
        status: { state: "canceled", timestamp: new Date().toISOString() },
        final: true,
      } as TaskStatusUpdateEvent);
    } catch (err) {
      logger.error("SandboxAgentExecutor.cancelTask failed", {
        task_id: taskId,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      eventBus.finished();
    }
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
