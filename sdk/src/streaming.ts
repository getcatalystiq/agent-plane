import type { StreamEvent, Run } from "./types";
import { narrowStreamEvent } from "./types";
import { StreamDisconnectedError } from "./errors";

const MAX_LINE_BYTES = 1_048_576; // 1MB

/**
 * Parse an NDJSON response body into an async iterable of parsed objects.
 * Returns `unknown` — callers narrow to typed events.
 */
export async function* parseNdjsonStream(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  try {
    while (true) {
      if (signal?.aborted) break;

      const { value, done } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Security: prevent unbounded memory from server that never sends newlines
      if (!buffer.includes("\n") && buffer.length > MAX_LINE_BYTES) {
        throw new Error(`NDJSON line exceeded ${MAX_LINE_BYTES} byte limit`);
      }

      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (trimmed.length === 0) continue;
        try {
          yield JSON.parse(trimmed);
        } catch {
          // Skip malformed JSON lines
        }
      }
    }

    // Flush decoder and remaining buffer
    buffer += decoder.decode();
    const remaining = buffer.trim();
    if (remaining.length > 0) {
      try {
        yield JSON.parse(remaining);
      } catch {
        // Skip malformed
      }
    }
  } finally {
    reader.releaseLock();
  }
}

export interface RunStreamOptions {
  /** Injected: poll run status by ID. */
  pollRun: (runId: string) => Promise<Run>;
  /** Injected: fetch transcript stream by run ID. */
  fetchTranscript: (runId: string, signal?: AbortSignal) => Promise<Response>;
  /** External abort signal. */
  signal?: AbortSignal;
}

/**
 * An async iterable over stream events from a run.
 *
 * Heartbeats are filtered. `stream_detached` is yielded to the consumer (the
 * stream then stops). Use `createAndWait()` for automatic detach handling.
 */
export class RunStream implements AsyncIterable<StreamEvent> {
  /** The run ID, available after the first `run_started` event. */
  run_id: string | null = null;

  private readonly _response: Response;
  private readonly _controller: AbortController;
  private readonly _options: RunStreamOptions;
  private _consumed = false;

  constructor(response: Response, options: RunStreamOptions) {
    this._response = response;
    this._options = options;
    this._controller = new AbortController();

    // Link external signal to internal controller
    const externalSignal = options.signal;
    if (externalSignal) {
      if (externalSignal.aborted) {
        this._controller.abort(externalSignal.reason);
      } else {
        externalSignal.addEventListener(
          "abort",
          () => this._controller.abort(externalSignal.reason),
          { once: true },
        );
      }
    }
  }

  /** Cancel the stream and release resources. */
  abort(reason?: unknown): void {
    this._controller.abort(reason);
  }

  [Symbol.asyncIterator](): AsyncIterableIterator<StreamEvent> {
    if (this._consumed) {
      throw new Error("RunStream has already been consumed. A stream can only be read once.");
    }
    this._consumed = true;

    const generator = this._iterate();

    return {
      next: () => generator.next(),
      return: async () => {
        this.abort();
        return generator.return(undefined as never);
      },
      throw: (err) => generator.throw(err),
      [Symbol.asyncIterator]() {
        return this;
      },
    };
  }

  async [Symbol.asyncDispose](): Promise<void> {
    this.abort();
  }

  private async *_iterate(): AsyncGenerator<StreamEvent> {
    const body = this._response.body;
    if (!body) {
      throw new StreamDisconnectedError(null);
    }

    try {
      for await (const raw of parseNdjsonStream(body, this._controller.signal)) {
        const event = narrowStreamEvent(raw);
        if (event === null) continue; // heartbeat or invalid

        // Extract run_id from first event
        if (event.type === "run_started") {
          this.run_id = (event as import("./types").RunStartedEvent).run_id;
        }

        yield event;

        // Stop after stream_detached — consumer handles polling
        if (event.type === "stream_detached") {
          return;
        }
      }
    } catch (err) {
      if (this._controller.signal.aborted) return;
      throw new StreamDisconnectedError(this.run_id, err);
    }
  }
}
