/**
 * U0 Phase 0 spike — driver routes for runtime verification.
 *
 * The local CLI in scripts/wdk-spike.ts hits these routes against a deployed
 * Vercel preview to exercise the WDK primitives. Each route handler owns one
 * scenario, returns JSON with the verified/unverified/failed outcome.
 *
 * **Production gate:** these routes are only callable when WDK_SPIKE_TOKEN is
 * set in env. Production should leave it unset so the spike returns 404.
 *
 * Plan reference: U0 in docs/plans/2026-05-05-001-refactor-workflow-sdk-dispatch-plan.md
 */
import { NextRequest, NextResponse } from "next/server";
import { getEnv } from "@/lib/env";
import { getRun, resumeHook, start } from "workflow/api";
import {
  spikeStreamingWorkflow,
  type SpikeChunk,
} from "@/lib/workflows/spike/streaming-workflow";
import {
  spikeFlakyWorkflow,
  __resetFlakyCounterForSpike,
} from "@/lib/workflows/spike/flaky-workflow";
import { spikeLongIdleWorkflow } from "@/lib/workflows/spike/long-idle-workflow";
import { timingSafeEqual } from "@/lib/crypto";

interface ScenarioResult {
  scenario: number;
  status: "verified" | "unverified" | "failed";
  notes: string;
  details?: unknown;
}

function authorize(request: NextRequest): { ok: true } | { ok: false; reason: string } {
  const expected = getEnv().WDK_SPIKE_TOKEN;
  if (!expected) {
    return { ok: false, reason: "WDK_SPIKE_TOKEN not configured (spike disabled)" };
  }
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/.exec(header);
  if (!match) return { ok: false, reason: "Missing bearer token" };
  if (!timingSafeEqual(match[1], expected)) {
    return { ok: false, reason: "Bad token" };
  }
  return { ok: true };
}

function errMsg(err: unknown): string {
  if (err instanceof Error) return `${err.name}: ${err.message}`;
  return String(err);
}

/**
 * Retry resumeHook with exponential backoff. After `start()` returns, the
 * workflow runtime may take several seconds (Vercel cold-start) before it
 * begins executing the workflow body, where `createHook` registers the
 * deterministic token. Until then, `resumeHook(token, ...)` throws
 * `HookNotFoundError`. This helper retries with backoff until the token
 * is registered, capped at the budget, and returns the last error if it
 * never succeeds.
 *
 * Caller pays the cost as a one-time per-run delay; subsequent resumes
 * after the first success are immediate.
 */
interface ResumeBackoffResult {
  ok: boolean;
  attempts: number;
  lastError: string;
}

async function resumeHookWithBackoff(
  token: string,
  payload: unknown,
  options: { budgetMs?: number } = {},
): Promise<ResumeBackoffResult> {
  const budgetMs = options.budgetMs ?? 30_000;
  const start = Date.now();
  let attempts = 0;
  let waitMs = 100;
  let lastError = "";
  while (Date.now() - start < budgetMs) {
    attempts++;
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await resumeHook(token, payload as any);
      return { ok: true, attempts, lastError };
    } catch (err) {
      lastError = errMsg(err);
      // HookNotFoundError is the expected pre-registration error; other errors
      // are reported back without further retry.
      if (!lastError.includes("Hook not found")) {
        return { ok: false, attempts, lastError };
      }
      await new Promise((r) => setTimeout(r, waitMs));
      waitMs = Math.min(waitMs * 1.5, 2_000);
    }
  }
  return { ok: false, attempts, lastError };
}

async function readAll(stream: ReadableStream<unknown>): Promise<string[]> {
  const chunks: string[] = [];
  const reader = stream.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(typeof value === "string" ? value : JSON.stringify(value));
    }
  } finally {
    reader.releaseLock();
  }
  return chunks;
}

/**
 * Read exactly `tail - startIndex + 1` chunks from a WorkflowReadableStream.
 *
 * WDK's writable doesn't auto-close when the workflow body returns, so a
 * plain `for await` over the readable hangs after the last chunk because
 * `done` never fires. Use `getTailIndex()` (absolute index of the last
 * known chunk) to know exactly how many chunks to expect.
 *
 * This is the pattern U2's REST/A2A render shims must use when draining
 * the workflow stream of a completed run.
 */
async function readBounded<R = unknown>(
  stream: ReadableStream<R> & { getTailIndex(): Promise<number> },
  startIndex: number,
): Promise<string[]> {
  const tail = await stream.getTailIndex();
  const expected = Math.max(0, tail - startIndex + 1);
  const chunks: string[] = [];
  const reader = stream.getReader();
  try {
    for (let i = 0; i < expected; i++) {
      const { value, done } = await reader.read();
      if (done) break;
      chunks.push(typeof value === "string" ? value : JSON.stringify(value));
    }
  } finally {
    reader.releaseLock();
  }
  return chunks;
}

// ------------------------------------------------------------
// Scenarios
// ------------------------------------------------------------

async function scenario1(): Promise<ScenarioResult> {
  const messageId = `spike-${Date.now()}-1`;
  try {
    const run = await start(spikeStreamingWorkflow, [{ messageId }]);
    const t0 = Date.now();
    const first = await resumeHookWithBackoff(
      `spike:transcript:${messageId}`,
      { kind: "chunk", data: "hello" } satisfies SpikeChunk,
    );
    if (!first.ok) {
      throw new Error(
        `Hook never registered within budget (attempts=${first.attempts}): ${first.lastError}`,
      );
    }
    const registrationLatencyMs = Date.now() - t0;
    await resumeHook(`spike:transcript:${messageId}`, {
      kind: "terminal",
      data: "bye",
    } satisfies SpikeChunk);
    const result = await run.returnValue;
    return {
      scenario: 1,
      status: "verified",
      notes: `Workflow returned ${JSON.stringify(result)}; hook registration latency=${registrationLatencyMs}ms (attempts=${first.attempts})`,
    };
  } catch (err) {
    return { scenario: 1, status: "failed", notes: errMsg(err) };
  }
}

async function scenario2(): Promise<ScenarioResult> {
  // Verifies that resumeHook tolerates being fired before the iterator parks.
  // Implemented via the same backoff helper as scenario 1 — the post-start
  // window during which resumeHook 404s IS the test surface. If backoff
  // succeeds, the fire-before-park race is not a correctness issue (just a
  // cold-start latency we measure in scenario 1).
  const messageId = `spike-${Date.now()}-2`;
  try {
    const run = await start(spikeStreamingWorkflow, [{ messageId }]);
    // Fire IMMEDIATELY — no wait at all.
    const result1 = await resumeHookWithBackoff(
      `spike:transcript:${messageId}`,
      { kind: "chunk", data: "racy-0" } satisfies SpikeChunk,
      { budgetMs: 30_000 },
    );
    if (!result1.ok) {
      throw new Error(
        `Could not resume hook (attempts=${result1.attempts}): ${result1.lastError}`,
      );
    }
    await resumeHook(`spike:transcript:${messageId}`, {
      kind: "terminal",
      data: "done",
    } satisfies SpikeChunk);
    const result = await run.returnValue;
    return {
      scenario: 2,
      status: "verified",
      notes: `Hook delivered the racy resume after ${result1.attempts} attempts; result ${JSON.stringify(result)}`,
    };
  } catch (err) {
    return {
      scenario: 2,
      status: "failed",
      notes: errMsg(err) +
        " (the runner-side retry policy in U3 must use the same backoff pattern)",
    };
  }
}

async function scenario3(): Promise<ScenarioResult> {
  const messageId = `spike-${Date.now()}-3`;
  try {
    const run = await start(spikeStreamingWorkflow, [{ messageId }]);

    // First chunk uses backoff; subsequent chunks should be immediate.
    const first = await resumeHookWithBackoff(
      `spike:transcript:${messageId}`,
      { kind: "chunk", data: "line-0" } satisfies SpikeChunk,
    );
    if (!first.ok) {
      throw new Error(`Hook never registered: ${first.lastError}`);
    }
    for (let i = 1; i < 5; i++) {
      await resumeHook(`spike:transcript:${messageId}`, {
        kind: "chunk",
        data: `line-${i}`,
      } satisfies SpikeChunk);
    }
    await resumeHook(`spike:transcript:${messageId}`, {
      kind: "terminal",
      data: "line-end",
    } satisfies SpikeChunk);

    // Wait for workflow completion BEFORE reading the stream — WDK closes
    // the writable when the run reaches terminal status, after which the
    // tail index is final. Reading without bounding by tailIndex hangs
    // because `done` never fires (writable stays open across step calls).
    await run.returnValue;
    const chunks = await readBounded(run.getReadable<string>(), 0);

    const expected = 6;
    if (chunks.length !== expected) {
      throw new Error(
        `Expected ${expected} chunks, got ${chunks.length}: ${JSON.stringify(chunks)}`,
      );
    }

    return {
      scenario: 3,
      status: "verified",
      notes: `Read ${chunks.length} chunks from workflow stream after run completion (bounded by getTailIndex)`,
      details: chunks,
    };
  } catch (err) {
    return { scenario: 3, status: "failed", notes: errMsg(err) };
  }
}

async function scenario4(): Promise<ScenarioResult> {
  const messageId = `spike-${Date.now()}-4`;
  try {
    const run = await start(spikeStreamingWorkflow, [{ messageId }]);

    const first = await resumeHookWithBackoff(
      `spike:transcript:${messageId}`,
      { kind: "chunk", data: "r0" } satisfies SpikeChunk,
    );
    if (!first.ok) {
      throw new Error(`Hook never registered: ${first.lastError}`);
    }
    for (let i = 1; i < 6; i++) {
      await resumeHook(`spike:transcript:${messageId}`, {
        kind: "chunk",
        data: `r${i}`,
      } satisfies SpikeChunk);
    }
    await resumeHook(`spike:transcript:${messageId}`, {
      kind: "terminal",
      data: "rEnd",
    } satisfies SpikeChunk);
    // Wait for workflow completion before reading — see scenario 3 comment.
    await run.returnValue;

    // Read first 3 chunks via getReadable startIndex=0; just release the
    // reader lock when done. Do NOT call `r1.cancel()` — calling cancel on a
    // WorkflowReadableStream propagates upstream and cancels the workflow
    // run itself (verified via Vercel runtime logs:
    // "Unconsumed event in event log: eventType=run_cancelled" + the
    // downstream "TypeError: Invalid state: Unable to enqueue" in the
    // route's response stream).
    const r1 = getRun<unknown>(run.runId).getReadable<string>({ startIndex: 0 });
    const first3: string[] = [];
    {
      const reader = r1.getReader();
      try {
        for (let i = 0; i < 3; i++) {
          const { value, done } = await reader.read();
          if (done) break;
          first3.push(typeof value === "string" ? value : JSON.stringify(value));
        }
      } finally {
        reader.releaseLock();
      }
    }

    // Reconnect at startIndex=3 to verify chunks 3..end arrive without
    // duplication or skip. Bounded by getTailIndex.
    const r2 = getRun<unknown>(run.runId).getReadable<string>({ startIndex: 3 });
    const rest = await readBounded(r2, 3);

    if (first3.length !== 3 || rest.length !== 4) {
      throw new Error(
        `Expected 3 + 4 chunks, got ${first3.length} + ${rest.length}: first=${JSON.stringify(first3)} rest=${JSON.stringify(rest)}`,
      );
    }

    return {
      scenario: 4,
      status: "verified",
      notes: "Reconnected at startIndex=3, no duplication",
      details: { first3, rest },
    };
  } catch (err) {
    return { scenario: 4, status: "failed", notes: errMsg(err) };
  }
}

async function scenario5(): Promise<ScenarioResult> {
  const messageId = `spike-${Date.now()}-5`;
  try {
    const run = await start(spikeStreamingWorkflow, [{ messageId }]);

    const first = await resumeHookWithBackoff(
      `spike:transcript:${messageId}`,
      { kind: "chunk", data: "before-cancel" } satisfies SpikeChunk,
    );
    if (!first.ok) {
      throw new Error(`Hook never registered: ${first.lastError}`);
    }
    await new Promise((r) => setTimeout(r, 100));

    await run.cancel();

    let rejected = false;
    try {
      await Promise.race([
        run.returnValue,
        new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 5000)),
      ]);
    } catch {
      rejected = true;
    }
    const status = await run.status;

    if (rejected || status === "cancelled" || status === "failed") {
      return {
        scenario: 5,
        status: "verified",
        notes: `Run reached terminal status=${status} after cancel; returnValue rejected=${rejected}`,
      };
    }
    throw new Error(
      `Cancel did not produce terminal status: status=${status}, rejected=${rejected}`,
    );
  } catch (err) {
    return { scenario: 5, status: "failed", notes: errMsg(err) };
  }
}

async function scenario6(): Promise<ScenarioResult> {
  __resetFlakyCounterForSpike();
  try {
    const run = await start(spikeFlakyWorkflow);
    const result = await run.returnValue;
    if (
      typeof result === "object" &&
      result !== null &&
      "stepId" in result &&
      "attemptedFromStep" in result
    ) {
      return {
        scenario: 6,
        status: "verified",
        notes: `Step retried; final stepId=${(result as { stepId: string }).stepId}; attempts=${(result as { attemptedFromStep: number }).attemptedFromStep}`,
        details: result,
      };
    }
    throw new Error(`Unexpected result shape: ${JSON.stringify(result)}`);
  } catch (err) {
    return {
      scenario: 6,
      status: "unverified",
      notes:
        errMsg(err) +
        " — the runtime may not retry RetryableError in this configuration; check WDK retry policy on the deployment",
    };
  }
}

async function scenario7(request: NextRequest): Promise<ScenarioResult> {
  const sleepMsRaw = request.nextUrl.searchParams.get("sleepMs");
  const sleepMs = sleepMsRaw ? Number(sleepMsRaw) : 5000;
  if (!Number.isFinite(sleepMs) || sleepMs < 100 || sleepMs > 3_600_000) {
    return {
      scenario: 7,
      status: "failed",
      notes: `Invalid sleepMs query param: ${sleepMsRaw}. Must be 100..3,600,000.`,
    };
  }
  try {
    const t0 = Date.now();
    const run = await start(spikeLongIdleWorkflow, [{ sleepMs }]);
    const result = await run.returnValue;
    const elapsed = Date.now() - t0;
    return {
      scenario: 7,
      status: "verified",
      notes: `Slept ${sleepMs}ms; total elapsed ${elapsed}ms; returned ${JSON.stringify(result)}`,
    };
  } catch (err) {
    return { scenario: 7, status: "failed", notes: errMsg(err) };
  }
}

// ------------------------------------------------------------
// Route handler
// ------------------------------------------------------------

const SCENARIO_HANDLERS: Record<
  string,
  (request: NextRequest) => Promise<ScenarioResult>
> = {
  "1": () => scenario1(),
  "2": () => scenario2(),
  "3": () => scenario3(),
  "4": () => scenario4(),
  "5": () => scenario5(),
  "6": () => scenario6(),
  "7": (request) => scenario7(request),
};

export const dynamic = "force-dynamic";
export const maxDuration = 800; // headroom for scenario 7's long-idle run

export async function POST(
  request: NextRequest,
  context: { params: Promise<{ scenario: string }> },
) {
  const auth = authorize(request);
  if (!auth.ok) {
    // Always 404 — never reveal that the route exists when not authorized.
    return new NextResponse("Not Found", { status: 404 });
  }

  const { scenario } = await context.params;
  const handler = SCENARIO_HANDLERS[scenario];
  if (!handler) {
    return NextResponse.json(
      { error: `Unknown scenario: ${scenario}. Valid: 1..7.` },
      { status: 400 },
    );
  }

  const result = await handler(request);
  const httpStatus = result.status === "verified" ? 200 : result.status === "unverified" ? 200 : 500;
  return NextResponse.json(result, { status: httpStatus });
}
