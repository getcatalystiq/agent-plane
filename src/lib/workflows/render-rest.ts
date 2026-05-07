/**
 * REST render shim — wraps a workflow run's getReadable() into the legacy
 * NDJSON byte stream contract used by /api/sessions/:id/messages and
 * /api/sessions/:id/messages/:messageId/stream.
 *
 * Plan reference: U3 in docs/plans/2026-05-05-001-refactor-workflow-sdk-dispatch-plan.md
 *
 * Output shape matches `src/lib/streaming.ts`'s `createNdjsonStream`:
 *   - One NDJSON line per emitted chunk (newline-terminated)
 *   - `{"type":"heartbeat","timestamp":"..."}` injected every 15s
 *   - `{"type":"stream_detached","run_id":"...","timestamp":"..."}` at 4.5min
 *
 * U0 spike constraints baked in:
 *   - Bounded reads via getTailIndex (writable doesn't auto-close on
 *     workflow termination — plain for-await over getReadable hangs)
 *   - NEVER call .cancel() on the WorkflowReadableStream (cancels the run)
 *   - Polling cadence (200ms tail-check / 1s status-check) keeps the
 *     stream responsive without burning CPU
 */
import { getRun } from "workflow/api";
import { logger } from "@/lib/logger";

const HEARTBEAT_INTERVAL_MS = 15_000;
const STREAM_DETACH_MS = 4.5 * 60 * 1000;
const TAIL_POLL_INTERVAL_MS = 200;
const STATUS_POLL_INTERVAL_MS = 1_000;

const TERMINAL_STATUSES = new Set([
  "completed",
  "failed",
  "cancelled",
  "stopped",
]);

export interface RenderRestOptions {
  /** Workflow run id (e.g. from `sessions.workflow_run_id`, prefix-stripped). */
  runId: string;
  /**
   * Resume from this 0-based chunk index. Defaults to 0 (start of stream).
   * Use a positive value for reconnect; the workflow stream is durable so
   * the reconnect picks up exactly where the prior reader left off.
   */
  startIndex?: number;
  /**
   * For the U2 plan's stream_detached + reconnect URL contract. Optional —
   * when omitted the detach event omits the `session_id`/`message_id`
   * shape; clients can still reconnect via the response's URL inferred
   * from the request path.
   */
  sessionId?: string;
  messageId?: string;
}

/**
 * Build a ReadableStream<Uint8Array> backed by the workflow run's chunks.
 * Caller relays via `new Response(stream, { headers: ndjsonHeaders() })`.
 *
 * Lifecycle:
 *   1. Heartbeats fire every 15s while the run is not terminal
 *   2. Reader pulls chunks; tailIndex polled to know when to read
 *   3. When run.status goes terminal, drain any remaining chunks
 *      (final tail check), close the controller cleanly
 *   4. At 4.5min, emit `stream_detached` and close. The run continues;
 *      the workflow stream is durable so the client can reconnect with
 *      `startIndex = position`.
 *   5. If the response is cancelled (client disconnects), stop polling
 *      and release the reader. Never .cancel() the workflow readable.
 */
export function renderRest(options: RenderRestOptions): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const { runId, startIndex = 0, sessionId, messageId } = options;

  let cancelled = false;
  let detached = false;
  let position = startIndex;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let detachTimer: ReturnType<typeof setTimeout> | null = null;

  const run = getRun<unknown>(runId);

  return new ReadableStream<Uint8Array>({
    async start(controller) {
      const readable = run.getReadable<string>({ startIndex });
      const reader = readable.getReader();

      heartbeatTimer = setInterval(() => {
        if (cancelled || detached) return;
        try {
          const heartbeat = JSON.stringify({
            type: "heartbeat",
            timestamp: new Date().toISOString(),
          });
          controller.enqueue(encoder.encode(heartbeat + "\n"));
        } catch {
          /* controller may be closed; ignore */
        }
      }, HEARTBEAT_INTERVAL_MS);

      detachTimer = setTimeout(() => {
        if (cancelled || detached) return;
        detached = true;
        try {
          const event = JSON.stringify({
            type: "stream_detached",
            run_id: runId,
            ...(sessionId ? { session_id: sessionId } : {}),
            ...(messageId ? { message_id: messageId } : {}),
            timestamp: new Date().toISOString(),
            // Hint to clients for reconnect via the existing
            // /api/sessions/:id/messages/:messageId/stream surface.
            poll_url:
              sessionId && messageId
                ? `/api/sessions/${sessionId}/messages/${messageId}`
                : undefined,
            stream_url:
              sessionId && messageId
                ? `/api/sessions/${sessionId}/messages/${messageId}/stream?startIndex=${position}`
                : undefined,
          });
          controller.enqueue(encoder.encode(event + "\n"));
          controller.close();
        } catch {
          /* */
        }
        reader.releaseLock();
        // NEVER readable.cancel() — that kills the workflow run.
      }, STREAM_DETACH_MS);

      let lastStatusCheckMs = 0;

      try {
        while (!cancelled && !detached) {
          const tail = await readable.getTailIndex();

          // Drain any chunks the writable has produced since last loop.
          while (position <= tail && !cancelled && !detached) {
            const { value, done } = await reader.read();
            if (done) break;
            const line = typeof value === "string" ? value : JSON.stringify(value);
            const ndjsonLine = line.endsWith("\n") ? line : line + "\n";
            try {
              controller.enqueue(encoder.encode(ndjsonLine));
            } catch {
              /* controller closed */
              return;
            }
            position++;
          }

          // Check workflow status periodically. If terminal, do a final
          // tail-pass and exit cleanly.
          const now = Date.now();
          if (now - lastStatusCheckMs >= STATUS_POLL_INTERVAL_MS) {
            lastStatusCheckMs = now;
            const status = await run.status;
            if (TERMINAL_STATUSES.has(status as string)) {
              const finalTail = await readable.getTailIndex();
              while (position <= finalTail && !cancelled && !detached) {
                const { value, done } = await reader.read();
                if (done) break;
                const line = typeof value === "string" ? value : JSON.stringify(value);
                const ndjsonLine = line.endsWith("\n") ? line : line + "\n";
                try {
                  controller.enqueue(encoder.encode(ndjsonLine));
                } catch {
                  return;
                }
                position++;
              }
              break;
            }
          }

          // Brief pause before next poll. Keeps responsiveness under
          // ~200ms while avoiding tight-loop CPU burn during idle gaps
          // (e.g. between LLM thinking and tool execution).
          await new Promise((r) => setTimeout(r, TAIL_POLL_INTERVAL_MS));
        }
      } catch (err) {
        logger.error("renderRest: read loop error", {
          run_id: runId,
          error: err instanceof Error ? err.message : String(err),
        });
        try {
          controller.error(err);
        } catch {
          /* */
        }
      } finally {
        reader.releaseLock();
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        if (detachTimer) clearTimeout(detachTimer);
        if (!detached) {
          try {
            controller.close();
          } catch {
            /* already closed */
          }
        }
      }
    },

    cancel() {
      // Client disconnected. Stop the loop but DO NOT cancel the workflow
      // readable (that propagates upstream and cancels the workflow run).
      cancelled = true;
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      if (detachTimer) clearTimeout(detachTimer);
    },
  });
}

/**
 * NDJSON content-type headers matching `src/lib/streaming.ts`'s
 * `ndjsonHeaders()` so existing route response shapes are unchanged.
 */
export function renderRestHeaders(): HeadersInit {
  return {
    "Content-Type": "application/x-ndjson",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
  };
}
