import type {
  AgentCard,
  AgentSkill,
  Task,
  TaskState,
  TextPart,
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
import { createRun, transitionRunStatus } from "@/lib/runs";
import { prepareRunExecution } from "@/lib/run-executor";
import { logger } from "@/lib/logger";
import type { RunStatus, TenantId, AgentId, RunId } from "@/lib/types";
import type { AgentInternal } from "@/lib/validation";
import { z } from "zod";

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

// --- Agent Card Cache (process-level, 60s TTL) ---

const agentCardCache = new Map<string, { card: AgentCard; expiresAt: number }>();
const AGENT_CARD_TTL_MS = 60_000;

export function getCachedAgentCard(tenantId: string): AgentCard | null {
  const cached = agentCardCache.get(tenantId);
  if (cached && cached.expiresAt > Date.now()) return cached.card;
  if (cached) agentCardCache.delete(tenantId);
  return null;
}

export function setCachedAgentCard(tenantId: string, card: AgentCard): void {
  agentCardCache.set(tenantId, { card, expiresAt: Date.now() + AGENT_CARD_TTL_MS });
}

// --- Agent Card Builder ---

const A2aAgentRow = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  max_runtime_seconds: z.coerce.number(),
});

export async function buildAgentCard(
  tenantSlug: string,
  tenantName: string,
  baseUrl: string,
): Promise<AgentCard | null> {
  const sql = getHttpClient();

  // Query a2a_enabled agents for this tenant (via slug lookup)
  const rows = await sql`
    SELECT a.id, a.name, a.description, a.max_runtime_seconds
    FROM agents a
    JOIN tenants t ON a.tenant_id = t.id
    WHERE t.slug = ${tenantSlug}
      AND a.a2a_enabled = true
    ORDER BY a.name
  `;

  const agents = rows.map((row: unknown) => A2aAgentRow.parse(row));

  if (agents.length === 0) return null;

  const skills: AgentSkill[] = agents.map((agent) => ({
    id: agent.name,
    name: agent.name,
    description: agent.description || `Agent: ${agent.name} (max runtime: ${agent.max_runtime_seconds}s)`,
    inputModes: ["text/plain"],
    outputModes: ["text/plain"],
    tags: [],
  }));

  return {
    name: tenantName,
    description: `A2A agents provided by ${tenantName}`,
    url: `${baseUrl}/api/a2a/${tenantSlug}/jsonrpc`,
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
    skills,
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
  };
}

// --- Run → A2A Task Mapper ---

const RunForTaskRow = z.object({
  id: z.string(),
  status: z.enum(["pending", "running", "completed", "failed", "cancelled", "timed_out"]),
  prompt: z.string(),
  result_summary: z.string().nullable(),
  transcript_blob_url: z.string().nullable(),
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
  if (run.transcript_blob_url) {
    metadata["agentplane"] = {
      transcript_url: run.transcript_blob_url,
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
  constructor(
    private readonly tenantId: TenantId,
    private readonly createdByKeyId?: string,
  ) {}

  async load(taskId: string, _context?: ServerCallContext): Promise<Task | undefined> {
    if (!UUID_V4_REGEX.test(taskId)) return undefined;

    try {
      const sql = getHttpClient();
      const rows = await sql`
        SELECT id, status, prompt, result_summary, transcript_blob_url, duration_ms, created_at, completed_at
        FROM runs
        WHERE id = ${taskId}
          AND tenant_id = ${this.tenantId}
      `;

      if (rows.length === 0) return undefined;
      const run = RunForTaskRow.parse(rows[0]);
      return runToA2aTask(run);
    } catch (err) {
      logger.error("RunBackedTaskStore.load failed", {
        task_id: taskId,
        tenant_id: this.tenantId,
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  async save(task: Task, _context?: ServerCallContext): Promise<void> {
    // Status-only UPDATE — SDK calls save() on EVERY event (50-200 per run).
    // No JSONB history, no version check. History derived from transcript on load().
    try {
      const runStatus = a2aToRunStatus(task.status.state);
      if (!runStatus) return; // Unknown/unhandled state — skip

      const sql = getHttpClient();
      await sql`
        UPDATE runs SET status = ${runStatus}
        WHERE id = ${task.id} AND tenant_id = ${this.tenantId}
      `;
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
  createdByKeyId: string;
  platformApiUrl: string;
  resolveAgent: (agentName: string) => Promise<AgentInternal | null>;
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

      // Publish immediate "working" status
      eventBus.publish({
        kind: "status-update",
        taskId,
        contextId: requestContext.contextId,
        status: { state: "working", timestamp: new Date().toISOString() },
        final: false,
      } as TaskStatusUpdateEvent);

      // Extract prompt from user message
      const textParts = requestContext.userMessage.parts.filter(
        (p): p is TextPart => p.kind === "text",
      );
      if (textParts.length === 0) {
        throw A2AError.invalidParams("Message must contain at least one text part");
      }
      const prompt = textParts.map((p) => p.text).join("\n");

      // Resolve agent from skill ID (agent name)
      // The DefaultRequestHandler doesn't pass skill info in requestContext,
      // so we use the first a2a_enabled agent for this tenant.
      // TODO: When SDK supports skill routing, resolve by skill ID.
      const agents = await this.loadA2aAgents();
      if (agents.length === 0) {
        throw A2AError.internalError("No A2A-enabled agents found");
      }
      const agent = agents[0];

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

      // Prepare and start sandbox execution (detached)
      const { sandbox, logIterator, transcriptChunks } = await prepareRunExecution({
        agent,
        tenantId: this.deps.tenantId,
        runId: run.id as RunId,
        prompt,
        platformApiUrl: this.deps.platformApiUrl,
        effectiveBudget,
        effectiveMaxTurns: agent.max_turns,
        maxRuntimeSeconds: agent.max_runtime_seconds,
      });

      // PATH B — Streaming: consume logIterator, publish events
      try {
        for await (const line of logIterator) {
          try {
            const event = JSON.parse(line);
            if (event.type === "text_delta" && event.text) {
              // Publish status update with working state during streaming
              eventBus.publish({
                kind: "status-update",
                taskId,
                contextId: requestContext.contextId,
                status: { state: "working", timestamp: new Date().toISOString() },
                final: false,
              } as TaskStatusUpdateEvent);
            } else if (event.type === "result") {
              // Publish artifact with final result
              const resultText = event.result_summary || event.text || "";
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

      // Finalize — check run status from DB
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

      await transitionRunStatus(
        taskId as RunId,
        this.deps.tenantId,
        "running",
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

  private async loadA2aAgents(): Promise<AgentInternal[]> {
    const sql = getHttpClient();
    const rows = await sql`
      SELECT * FROM agents
      WHERE tenant_id = ${this.deps.tenantId}
        AND a2a_enabled = true
      ORDER BY name
      LIMIT 10
    `;
    // Parse with internal schema to get all fields needed for sandbox execution
    const { AgentRowInternal } = await import("@/lib/validation");
    return rows.map((row: unknown) => AgentRowInternal.parse(row));
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
    for (const refId of message.referenceTaskIds) {
      if (!UUID_V4_REGEX.test(refId)) {
        return `Invalid referenceTaskId format: ${refId}`;
      }
    }
    if (message.referenceTaskIds.length > 10) {
      return "Maximum 10 referenceTaskIds allowed";
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
