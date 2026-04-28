import { logger } from "./logger";

const HEARTBEAT_INTERVAL_MS = 15_000;
const STREAM_DETACH_MS = 4.5 * 60 * 1000; // 4.5 minutes

interface StreamOptions {
  /** Per-message identifier used in stream_detached poll URL + log lines. */
  messageId: string;
  /** Parent session id; included in detach event so clients can poll the session. */
  sessionId: string;
  logIterator: AsyncIterable<string>;
  onDetach?: () => void;
}

export function createNdjsonStream(options: StreamOptions): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const { messageId, sessionId, logIterator, onDetach } = options;

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

        // Set up detach timer for long-running messages
        detachTimer = setTimeout(() => {
          detached = true;
          const event = JSON.stringify({
            type: "stream_detached",
            session_id: sessionId,
            message_id: messageId,
            poll_url: `/api/sessions/${sessionId}/messages/${messageId}`,
            stream_url: `/api/sessions/${sessionId}/messages/${messageId}/stream`,
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
          message_id: messageId,
          session_id: sessionId,
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
