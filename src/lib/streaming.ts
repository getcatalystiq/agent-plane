import { logger } from "./logger";
import type { RunId } from "./types";

const HEARTBEAT_INTERVAL_MS = 15_000;
const STREAM_DETACH_MS = 4.5 * 60 * 1000; // 4.5 minutes

interface StreamOptions {
  runId: RunId;
  logIterator: AsyncIterable<string>;
  onDetach?: () => void;
}

export function createNdjsonStream(options: StreamOptions): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const { runId, logIterator, onDetach } = options;

  let iterator: AsyncIterator<string>;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let detachTimer: ReturnType<typeof setTimeout> | null = null;
  let detached = false;

  return new ReadableStream<Uint8Array>({
    start() {
      iterator = logIterator[Symbol.asyncIterator]();
    },

    async pull(controller) {
      // Set up heartbeat on first pull
      if (!heartbeatTimer) {
        heartbeatTimer = setInterval(() => {
          try {
            const heartbeat = JSON.stringify({
              type: "heartbeat",
              timestamp: new Date().toISOString(),
            });
            controller.enqueue(encoder.encode(heartbeat + "\n"));
          } catch {
            // Controller might be closed
          }
        }, HEARTBEAT_INTERVAL_MS);

        // Set up detach timer for long runs
        detachTimer = setTimeout(() => {
          detached = true;
          const event = JSON.stringify({
            type: "stream_detached",
            poll_url: `/api/runs/${runId}`,
            timestamp: new Date().toISOString(),
          });
          controller.enqueue(encoder.encode(event + "\n"));
          cleanup();
          controller.close();
          onDetach?.();
        }, STREAM_DETACH_MS);
      }

      if (detached) return;

      try {
        const { value, done } = await iterator.next();
        if (done) {
          cleanup();
          controller.close();
          return;
        }

        // Relay raw line + newline (byte-level relay, no parse/re-stringify)
        const line = value.endsWith("\n") ? value : value + "\n";
        controller.enqueue(encoder.encode(line));
      } catch (err) {
        logger.error("Stream read error", {
          run_id: runId,
          error: err instanceof Error ? err.message : String(err),
        });
        cleanup();
        controller.close();
      }
    },

    cancel() {
      cleanup();
      iterator?.return?.();
    },
  });

  function cleanup() {
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    if (detachTimer) {
      clearTimeout(detachTimer);
      detachTimer = null;
    }
  }
}

export function ndjsonHeaders(): HeadersInit {
  return {
    "Content-Type": "application/x-ndjson",
    "Cache-Control": "no-cache, no-transform",
    "X-Accel-Buffering": "no",
  };
}
