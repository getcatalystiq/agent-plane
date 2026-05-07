/**
 * Server-side helpers for the workflow streaming bridge.
 *
 * Used by the refactored `/api/internal/messages/:messageId/transcript`
 * endpoint to translate runner per-line POSTs into `resumeHook(token, ...)`
 * calls against the workflow body's hook iterator.
 *
 * Plan reference: U3 in docs/plans/2026-05-05-001-refactor-workflow-sdk-dispatch-plan.md
 *
 * **Three guards before any byte reaches the workflow stream** (per the plan):
 *   1. Token verified by the route (existing per-message bearer token)
 *   2. (messageId, attemptSequence, batchSequence) NOT in dedup → first-time
 *   3. Per-message line count under cap → bounds stolen-token blast radius
 *   4. session_messages.status == 'running' (route-level)
 *
 * **Storage choice (in-memory vs Vercel KV):** v1 uses in-memory state with
 * the same eviction shape as `src/lib/rate-limit.ts`. Each runner attempt
 * has a single attemptSequence stream that's monotonically increasing within
 * one process — collision risk across instances is bounded by the runner's
 * single-active-attempt invariant. If duplicate POSTs slip through (e.g.,
 * runner retries to a different region), the worst case is one extra
 * resumeHook call → one extra chunk in the workflow stream → bounded by
 * the per-message line cap. Migrate to Vercel KV when production traffic
 * shows cross-instance dedup gaps in the logs.
 */
import { resumeHook } from "workflow/api";

// ---------------------------------------------------------------------------
// Dedup state
// ---------------------------------------------------------------------------

interface DedupEntry {
  /** Process-monotonic insertion time for LRU eviction. */
  insertedAtMs: number;
  /** Auto-eviction time. Must be ≥ agent.max_runtime_seconds + 5min. */
  expiresAtMs: number;
}

const MAX_DEDUP_ENTRIES = 100_000;
const DEDUP_TTL_MS = 65 * 60 * 1000; // 65min — covers max agent runtime (60min) + 5min grace

const dedupState = new Map<string, DedupEntry>();

function dedupKey(messageId: string, attemptSequence: number, batchSequence: number): string {
  return `${messageId}:${attemptSequence}:${batchSequence}`;
}

function evictExpired() {
  const now = Date.now();
  for (const [key, entry] of dedupState) {
    if (entry.expiresAtMs <= now) dedupState.delete(key);
  }
}

/**
 * Check whether a `(messageId, attemptSequence, batchSequence)` tuple has
 * been seen. Returns the previous-state observation:
 *   - `"first"` → never seen; CALLER must call `markBatchSeen` after the
 *     batch is forwarded to the hook (so a failure path doesn't poison
 *     the dedup cache)
 *   - `"duplicate"` → seen; the route should return 200-OK without
 *     re-firing resumeHook
 */
export function checkBatchDedup(
  messageId: string,
  attemptSequence: number,
  batchSequence: number,
): "first" | "duplicate" {
  const key = dedupKey(messageId, attemptSequence, batchSequence);
  const entry = dedupState.get(key);
  if (entry && entry.expiresAtMs > Date.now()) return "duplicate";
  return "first";
}

/**
 * Mark a batch as seen after successful resumeHook delivery. Idempotent —
 * calling twice is a no-op (the entry is just refreshed).
 */
export function markBatchSeen(
  messageId: string,
  attemptSequence: number,
  batchSequence: number,
): void {
  if (dedupState.size >= MAX_DEDUP_ENTRIES) evictExpired();
  if (dedupState.size >= MAX_DEDUP_ENTRIES) {
    // Eviction didn't recover space — drop the oldest entries by
    // insertion order (Map iteration is insertion-ordered).
    const dropTarget = Math.floor(MAX_DEDUP_ENTRIES * 0.1);
    let dropped = 0;
    for (const k of dedupState.keys()) {
      dedupState.delete(k);
      if (++dropped >= dropTarget) break;
    }
  }
  const now = Date.now();
  dedupState.set(dedupKey(messageId, attemptSequence, batchSequence), {
    insertedAtMs: now,
    expiresAtMs: now + DEDUP_TTL_MS,
  });
}

/** Test-only: clear all dedup state. */
export function __resetDedupForTests(): void {
  dedupState.clear();
}

// ---------------------------------------------------------------------------
// Per-message line cap (bounds stolen-token blast radius from SEC-002)
// ---------------------------------------------------------------------------

interface LineCounter {
  count: number;
  cap: number;
  expiresAtMs: number;
}

const lineCounters = new Map<string, LineCounter>();
const LINE_COUNTER_TTL_MS = DEDUP_TTL_MS;

/**
 * Reserve N lines against a per-message cap. Returns the result of the
 * reservation:
 *   - `{ allowed: true, remaining: N }` → caller may forward those N lines
 *   - `{ allowed: false, ... }` → cap exceeded; caller should 429
 *
 * The cap is initialized lazily on the first reserveLines call for a
 * given messageId. Default cap = `agent.max_runtime_seconds * 100` (the
 * plan's blast-radius bound: a 600s agent gets 60k lines, a 3600s agent
 * gets 360k lines).
 */
export function reserveLines(
  messageId: string,
  count: number,
  defaultCap: number,
): { allowed: boolean; remaining: number; cap: number } {
  evictExpiredCounters();
  let counter = lineCounters.get(messageId);
  if (!counter) {
    counter = {
      count: 0,
      cap: defaultCap,
      expiresAtMs: Date.now() + LINE_COUNTER_TTL_MS,
    };
    lineCounters.set(messageId, counter);
  }
  if (counter.count + count > counter.cap) {
    return {
      allowed: false,
      remaining: Math.max(0, counter.cap - counter.count),
      cap: counter.cap,
    };
  }
  counter.count += count;
  return {
    allowed: true,
    remaining: counter.cap - counter.count,
    cap: counter.cap,
  };
}

function evictExpiredCounters() {
  const now = Date.now();
  for (const [k, c] of lineCounters) {
    if (c.expiresAtMs <= now) lineCounters.delete(k);
  }
}

/** Test-only: clear all line counter state. */
export function __resetLineCountersForTests(): void {
  lineCounters.clear();
}

// ---------------------------------------------------------------------------
// resumeHook batch — call resumeHook(token, payload) once per parsed line
// ---------------------------------------------------------------------------

export interface RunnerChunkPayload {
  /** Either "chunk" or "terminal" — drives the workflow body's break. */
  kind: "chunk" | "terminal";
  /** Original NDJSON line (post-parse, pre-scrub — scrub happens in writeChunk step). */
  line: string;
  /** SDK event type (`assistant`, `tool_use`, `result`, `error`, `text_delta`, etc.). */
  eventType: string;
}

export interface ResumeBatchResult {
  delivered: number;
  /**
   * Set when at least one resumeHook returned a `HookNotFoundError`. The
   * route handler should return retryable 5xx so the runner backs off and
   * retries — the workflow body's createHook may not have registered yet
   * (~500ms-1.2s window measured by U0 spike).
   */
  hookNotFound: boolean;
  /**
   * Other resumeHook errors (transient WDK runtime issues). Same retryable
   * 5xx response is appropriate.
   */
  otherError: string | null;
}

/**
 * Forward a batch of parsed RunnerChunk payloads to the workflow's hook
 * via resumeHook. Returns aggregate delivery status.
 *
 * Order is preserved within the batch — the runner's coalescing window
 * keeps batches small (10 lines OR 100ms in U3-e), so within-batch order
 * is the only ordering guarantee callers can rely on. Cross-batch reorder
 * is possible under network reorder; tolerated by the workflow body's
 * `for await` consuming whatever order the hook delivers.
 */
export async function resumeHookBatch(
  messageId: string,
  payloads: RunnerChunkPayload[],
): Promise<ResumeBatchResult> {
  const token = `transcript:${messageId}`;
  let delivered = 0;
  for (const payload of payloads) {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await resumeHook(token, payload as any);
      delivered++;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("Hook not found")) {
        return { delivered, hookNotFound: true, otherError: null };
      }
      return { delivered, hookNotFound: false, otherError: message };
    }
  }
  return { delivered, hookNotFound: false, otherError: null };
}

// ---------------------------------------------------------------------------
// Parse runner NDJSON into RunnerChunk payloads
// ---------------------------------------------------------------------------

/**
 * Classify a single NDJSON line into a RunnerChunkPayload. Terminal-kind
 * is set for `result` and `error` event types — they're the natural
 * loop-break markers for the workflow body.
 *
 * Returns `null` for empty lines so callers can filter without needing
 * try/catch. Throws on malformed JSON because that's a bug in the runner
 * template, not a normal-path condition.
 */
export function parseRunnerLine(line: string): RunnerChunkPayload | null {
  const trimmed = line.trim();
  if (!trimmed) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // Don't crash the request on malformed runner output — treat as a
    // generic "unknown" chunk. The workflow body's writeChunk step will
    // still scrub and write the line; downstream consumers see it as-is.
    return { kind: "chunk", line: trimmed, eventType: "unknown" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { kind: "chunk", line: trimmed, eventType: "unknown" };
  }
  const eventType =
    typeof (parsed as { type?: unknown }).type === "string"
      ? ((parsed as { type: string }).type)
      : "unknown";
  const isTerminal = eventType === "result" || eventType === "error";
  if (isTerminal) {
    return { kind: "terminal", line: trimmed, eventType: eventType as "result" | "error" };
  }
  return { kind: "chunk", line: trimmed, eventType };
}
