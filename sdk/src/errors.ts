/**
 * Base error for all AgentPlane API errors.
 *
 * Discriminate by `code` field:
 * - "unauthorized" (401)
 * - "forbidden" (403)
 * - "budget_exceeded" (403)
 * - "not_found" (404)
 * - "validation_error" (400)
 * - "conflict" (409)
 * - "rate_limited" (429)
 * - "concurrency_limit" (429)
 * - "internal_error" (500)
 */
export class AgentPlaneError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, status: number, message: string) {
    super(message);
    this.name = "AgentPlaneError";
    this.code = code;
    this.status = status;
  }

  /** Create from an API error response body. */
  static fromResponse(
    status: number,
    body: unknown,
  ): AgentPlaneError {
    if (
      body !== null &&
      typeof body === "object" &&
      "error" in body &&
      typeof (body as Record<string, unknown>)["error"] === "object"
    ) {
      const err = (body as { error: Record<string, unknown> }).error;
      const code = typeof err["code"] === "string" ? err["code"] : "unknown";
      const message = typeof err["message"] === "string" ? err["message"] : "Unknown error";
      return new AgentPlaneError(code, status, message);
    }
    return new AgentPlaneError("unknown", status, `HTTP ${status}`);
  }
}

/**
 * Thrown when the NDJSON stream disconnects unexpectedly (not a server-initiated detach).
 * The `run_id` allows recovery via `client.runs.get()` + `client.runs.transcript()`.
 */
export class StreamDisconnectedError extends AgentPlaneError {
  readonly run_id: string | null;

  constructor(run_id: string | null, cause?: unknown) {
    super(
      "stream_disconnected",
      0,
      run_id
        ? `Stream disconnected for run ${run_id}`
        : "Stream disconnected before run_id was received",
    );
    this.run_id = run_id;
    if (cause !== undefined) {
      this.cause = cause;
    }
  }
}
