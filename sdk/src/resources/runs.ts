import type { AgentPlane } from "../client";
import type {
  Run,
  CreateRunParams,
  ListRunsParams,
  PaginatedResponse,
  StreamEvent,
} from "../types";
import { narrowStreamEvent } from "../types";
import { RunStream, parseNdjsonStream } from "../streaming";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "timed_out"]);

export class RunsResource {
  constructor(private readonly _client: AgentPlane) {}

  /**
   * Create a run and stream events.
   *
   * Returns a `RunStream` (async iterable of `StreamEvent`). If the stream
   * detaches after 4.5 minutes, a `stream_detached` event is yielded and
   * iteration stops. Use `createAndWait()` for automatic detach handling.
   */
  async create(
    params: CreateRunParams,
    options?: { signal?: AbortSignal },
  ): Promise<RunStream> {
    const streamOpts: { body: unknown; signal?: AbortSignal } = { body: params };
    if (options?.signal) streamOpts.signal = options.signal;

    const response = await this._client._requestStream("POST", "/api/runs", streamOpts);

    const runStreamOpts: import("../streaming").RunStreamOptions = {
      pollRun: (id) => this.get(id),
      fetchTranscript: (id, sig) => this._fetchTranscriptResponse(id, sig),
    };
    if (options?.signal) runStreamOpts.signal = options.signal;

    return new RunStream(response, runStreamOpts);
  }

  /**
   * Create a run and wait for completion.
   *
   * Streams events internally, handling `stream_detached` by polling until the
   * run reaches a terminal status. Returns the final `Run` object.
   */
  async createAndWait(
    params: CreateRunParams,
    options?: { signal?: AbortSignal; timeout_ms?: number },
  ): Promise<Run> {
    const timeoutMs = options?.timeout_ms ?? 10 * 60 * 1000; // 10 min default

    // Create a timeout signal if not already provided
    let signal = options?.signal;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;

    if (!signal) {
      const controller = new AbortController();
      signal = controller.signal;
      timeoutId = setTimeout(() => controller.abort(new Error("Timeout")), timeoutMs);
    }

    try {
      const stream = await this.create(params, { signal });
      let runId: string | null = null;

      // Consume events — discard them, just track runId
      for await (const event of stream) {
        if (event.type === "run_started") {
          runId = (event as import("../types").RunStartedEvent).run_id;
        }

        if (event.type === "stream_detached") {
          // Transition to polling
          runId = runId ?? stream.run_id;
          if (!runId) {
            throw new Error("stream_detached received but no run_id available");
          }
          return await this._pollUntilTerminal(runId, signal);
        }
      }

      // Stream completed normally — fetch final state
      runId = runId ?? stream.run_id;
      if (!runId) {
        throw new Error("Stream ended without a run_started event");
      }
      return await this.get(runId);
    } finally {
      if (timeoutId !== undefined) clearTimeout(timeoutId);
    }
  }

  /** Get a run by ID. */
  async get(runId: string): Promise<Run> {
    return this._client._request<Run>("GET", `/api/runs/${runId}`);
  }

  /** List runs with optional filtering. */
  async list(params?: ListRunsParams): Promise<PaginatedResponse<Run>> {
    const query: Record<string, string | number | undefined> = {
      limit: params?.limit,
      offset: params?.offset,
      agent_id: params?.agent_id,
      status: params?.status,
    };

    const response = await this._client._request<{ data: Run[]; limit: number; offset: number }>(
      "GET",
      "/api/runs",
      { query },
    );

    return {
      ...response,
      has_more: response.data.length === response.limit,
    };
  }

  /**
   * Cancel a run.
   *
   * Returns `{ cancelled: true }` on success, `{ cancelled: false }` if the run
   * has already reached a terminal status (409). Does NOT throw on 409.
   */
  async cancel(runId: string): Promise<{ cancelled: boolean }> {
    try {
      await this._client._request<unknown>("POST", `/api/runs/${runId}/cancel`);
      return { cancelled: true };
    } catch (err) {
      if (err instanceof Error && "status" in err && (err as { status: number }).status === 409) {
        return { cancelled: false };
      }
      throw err;
    }
  }

  /**
   * Get the transcript for a completed run as an async iterable of events.
   *
   * Note: `text_delta` events are NOT included in transcripts.
   */
  async *transcript(runId: string): AsyncGenerator<StreamEvent> {
    const response = await this._fetchTranscriptResponse(runId);
    const body = response.body;
    if (!body) return;

    for await (const raw of parseNdjsonStream(body)) {
      const event = narrowStreamEvent(raw);
      if (event !== null) yield event;
    }
  }

  /** @internal Fetch raw transcript response. */
  private async _fetchTranscriptResponse(
    runId: string,
    signal?: AbortSignal,
  ): Promise<Response> {
    const opts: { signal?: AbortSignal } = {};
    if (signal) opts.signal = signal;
    return this._client._requestStream("GET", `/api/runs/${runId}/transcript`, opts);
  }

  /** Poll GET /api/runs/:id until terminal status with exponential backoff. */
  private async _pollUntilTerminal(runId: string, signal?: AbortSignal): Promise<Run> {
    let delay = 3000; // 3s initial
    const maxDelay = 10000; // 10s cap

    while (true) {
      if (signal?.aborted) {
        throw signal.reason ?? new Error("Aborted");
      }

      await new Promise((resolve) => setTimeout(resolve, delay));

      const run = await this.get(runId);
      if (TERMINAL_STATUSES.has(run.status)) {
        return run;
      }

      delay = Math.min(delay * 2, maxDelay);
    }
  }
}
