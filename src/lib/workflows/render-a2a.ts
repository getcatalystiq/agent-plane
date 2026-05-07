/**
 * A2A render shim — consumes a workflow run's getReadable() and publishes
 * A2A spec events to the provided ExecutionEventBus, matching the legacy
 * `consumeA2aLogStream` mapping in `src/lib/a2a.ts`.
 *
 * Plan reference: U3 in docs/plans/2026-05-05-001-refactor-workflow-sdk-dispatch-plan.md
 *
 * Event mapping (preserved verbatim from a2a.ts:consumeA2aLogStream):
 *   - `type: "assistant"` with text content blocks → accumulate as
 *     `lastAssistantText` (returned for the caller to publish a final
 *     status event with full agent output)
 *   - `type: "result"` → publish `artifact-update` with the accumulated
 *     `lastAssistantText` (or `event.result` / `event.text` fallback)
 *   - Other types → no-op (the legacy executor doesn't emit per-step
 *     events; only assistant accumulation + final result artifact)
 *
 * U0 spike constraints baked in:
 *   - Bounded reads via getTailIndex (writable doesn't auto-close)
 *   - NEVER call .cancel() on the WorkflowReadableStream
 *   - Polls run.status to know when to exit
 */
import type { ExecutionEventBus } from "@a2a-js/sdk/server";
import type { TaskArtifactUpdateEvent, TextPart } from "@a2a-js/sdk";
import { getRun } from "workflow/api";
import { logger } from "@/lib/logger";

const TAIL_POLL_INTERVAL_MS = 200;
const STATUS_POLL_INTERVAL_MS = 1_000;

const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "stopped",
]);

export interface ConsumeWorkflowStreamAsA2AOptions {
  runId: string;
  eventBus: ExecutionEventBus;
  taskId: string;
  contextId: string | undefined;
  /** Optional starting position for reconnect; defaults to 0. */
  startIndex?: number;
}

/**
 * Drain a workflow run's stream, publish A2A events, return the last
 * assistant text accumulated. Caller is responsible for the final status
 * event (it depends on terminal message status from the DB, not from
 * the workflow stream).
 *
 * Mirrors `consumeA2aLogStream` in a2a.ts but reads from the WDK
 * workflow stream instead of a generic AsyncIterable<string>.
 */
export async function consumeWorkflowStreamAsA2A(
  options: ConsumeWorkflowStreamAsA2AOptions,
): Promise<string> {
  const { runId, eventBus, taskId, contextId, startIndex = 0 } = options;
  const run = getRun<unknown>(runId);
  const readable = run.getReadable<string>({ startIndex });
  const reader = readable.getReader();

  let lastAssistantText = "";
  let position = startIndex;
  let lastStatusCheckMs = 0;

  try {
    while (true) {
      const tail = await readable.getTailIndex();

      while (position <= tail) {
        const { value, done } = await reader.read();
        if (done) {
          // Defensive — WDK readables typically don't signal done on
          // workflow termination, but if it does, exit cleanly.
          return lastAssistantText;
        }
        const line = typeof value === "string" ? value : JSON.stringify(value);
        try {
          const event = JSON.parse(line);
          // Mapping preserved verbatim from
          // src/lib/a2a.ts:consumeA2aLogStream — keep these exact field
          // accesses so byte-identical SSE output is achievable for fixed
          // input fixtures (the U2 characterization-parity bar).
          if (event.type === "assistant" && event.message?.content) {
            const textBlocks = Array.isArray(event.message.content)
              ? event.message.content.filter(
                  (b: { type?: string }) => b.type === "text",
                )
              : [];
            if (textBlocks.length > 0) {
              lastAssistantText = textBlocks
                .map((b: { text: string }) => b.text)
                .join("\n");
            }
          }
          if (event.type === "result") {
            const resultText =
              lastAssistantText || event.result || event.text || "";
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
          // Non-JSON line — skip. Matches consumeA2aLogStream's posture.
        }
        position++;
      }

      const now = Date.now();
      if (now - lastStatusCheckMs >= STATUS_POLL_INTERVAL_MS) {
        lastStatusCheckMs = now;
        const status = await run.status;
        if (TERMINAL_STATUSES.has(status as string)) {
          // Final tail check in case more arrived during the loop.
          const finalTail = await readable.getTailIndex();
          while (position <= finalTail) {
            const { value, done } = await reader.read();
            if (done) break;
            const line = typeof value === "string" ? value : JSON.stringify(value);
            try {
              const event = JSON.parse(line);
              if (event.type === "assistant" && event.message?.content) {
                const textBlocks = Array.isArray(event.message.content)
                  ? event.message.content.filter(
                      (b: { type?: string }) => b.type === "text",
                    )
                  : [];
                if (textBlocks.length > 0) {
                  lastAssistantText = textBlocks
                    .map((b: { text: string }) => b.text)
                    .join("\n");
                }
              }
              if (event.type === "result") {
                const resultText =
                  lastAssistantText || event.result || event.text || "";
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
              /* non-JSON line — skip */
            }
            position++;
          }
          break;
        }
      }

      await new Promise((r) => setTimeout(r, TAIL_POLL_INTERVAL_MS));
    }
  } catch (err) {
    logger.error("consumeWorkflowStreamAsA2A: read loop error", {
      run_id: runId,
      task_id: taskId,
      error: err instanceof Error ? err.message : String(err),
    });
  } finally {
    reader.releaseLock();
    // NEVER readable.cancel() — that propagates upstream and cancels the run.
  }

  return lastAssistantText;
}
