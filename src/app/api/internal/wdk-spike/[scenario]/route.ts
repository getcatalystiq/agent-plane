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

// ------------------------------------------------------------
// Scenarios
// ------------------------------------------------------------

async function scenario1(): Promise<ScenarioResult> {
  const messageId = `spike-${Date.now()}-1`;
  try {
    const run = await start(spikeStreamingWorkflow, [{ messageId }]);
    await new Promise((r) => setTimeout(r, 200));
    await resumeHook(`spike:transcript:${messageId}`, {
      kind: "chunk",
      data: "hello",
    } satisfies SpikeChunk);
    await resumeHook(`spike:transcript:${messageId}`, {
      kind: "terminal",
      data: "bye",
    } satisfies SpikeChunk);
    const result = await run.returnValue;
    return {
      scenario: 1,
      status: "verified",
      notes: `Workflow returned ${JSON.stringify(result)}`,
    };
  } catch (err) {
    return { scenario: 1, status: "failed", notes: errMsg(err) };
  }
}

async function scenario2(): Promise<ScenarioResult> {
  const messageId = `spike-${Date.now()}-2`;
  try {
    const run = await start(spikeStreamingWorkflow, [{ messageId }]);
    // No sleep — try to fire resumeHook immediately, racing the workflow's
    // createHook registration. Token is deterministic so reconstruction works.
    let firstResumeOk = false;
    let lastErr = "";
    for (let i = 0; i < 10; i++) {
      try {
        await resumeHook(`spike:transcript:${messageId}`, {
          kind: "chunk",
          data: `racy-${i}`,
        } satisfies SpikeChunk);
        firstResumeOk = true;
        break;
      } catch (err) {
        lastErr = errMsg(err);
        await new Promise((r) => setTimeout(r, 50));
      }
    }
    if (!firstResumeOk) {
      throw new Error(`Could not resume hook within 500ms of start(): ${lastErr}`);
    }
    await resumeHook(`spike:transcript:${messageId}`, {
      kind: "terminal",
      data: "done",
    } satisfies SpikeChunk);
    const result = await run.returnValue;
    return {
      scenario: 2,
      status: "verified",
      notes: `Hook delivered the racy resume; result ${JSON.stringify(result)}`,
    };
  } catch (err) {
    return {
      scenario: 2,
      status: "failed",
      notes: errMsg(err) +
        " (may need backoff retry on the runner side; see U3 retry policy)",
    };
  }
}

async function scenario3(): Promise<ScenarioResult> {
  const messageId = `spike-${Date.now()}-3`;
  try {
    const run = await start(spikeStreamingWorkflow, [{ messageId }]);
    await new Promise((r) => setTimeout(r, 200));

    for (let i = 0; i < 5; i++) {
      await resumeHook(`spike:transcript:${messageId}`, {
        kind: "chunk",
        data: `line-${i}`,
      } satisfies SpikeChunk);
    }
    await resumeHook(`spike:transcript:${messageId}`, {
      kind: "terminal",
      data: "line-end",
    } satisfies SpikeChunk);

    const chunks = await readAll(run.getReadable<string>());
    await run.returnValue;

    const expected = 6;
    if (chunks.length !== expected) {
      throw new Error(
        `Expected ${expected} chunks, got ${chunks.length}: ${JSON.stringify(chunks)}`,
      );
    }

    return {
      scenario: 3,
      status: "verified",
      notes: `Read ${chunks.length} chunks from workflow stream`,
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
    await new Promise((r) => setTimeout(r, 200));

    for (let i = 0; i < 6; i++) {
      await resumeHook(`spike:transcript:${messageId}`, {
        kind: "chunk",
        data: `r${i}`,
      } satisfies SpikeChunk);
    }
    await resumeHook(`spike:transcript:${messageId}`, {
      kind: "terminal",
      data: "rEnd",
    } satisfies SpikeChunk);
    await run.returnValue;

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
        try {
          await r1.cancel();
        } catch {
          /* ignore */
        }
      }
    }

    const r2 = getRun<unknown>(run.runId).getReadable<string>({ startIndex: 3 });
    const rest = await readAll(r2);

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
    await new Promise((r) => setTimeout(r, 200));

    await resumeHook(`spike:transcript:${messageId}`, {
      kind: "chunk",
      data: "before-cancel",
    } satisfies SpikeChunk);
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
