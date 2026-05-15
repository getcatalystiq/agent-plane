/**
 * Regression test for the schedule executor's workflow path.
 *
 * Bug: runViaWorkflow used to call `start(dispatchWorkflow, [input])` with a
 * single-element args array. dispatchWorkflow's body reads `prepared.messageId`
 * on its first line, so passing prepared=undefined produced
 * `TypeError: Cannot read properties of undefined (reading 'messageId')`
 * on every workflow-backed schedule tick — no session/message rows were ever
 * written, the schedule looked like it "didn't run".
 *
 * This test pins the two-arg contract: start() must receive
 * `[dispatchWorkflow, [input, prepared]]` where prepared is the result of
 * reserveSessionAndMessage. Mirrors src/lib/workflows/dispatch-shim.ts.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { TenantId, AgentId } from "@/lib/types";

const mocks = vi.hoisted(() => ({
  reserveSessionAndMessage: vi.fn(),
  dispatchSessionMessage: vi.fn(),
  shouldUseWorkflow: vi.fn(),
  start: vi.fn(),
  findWarmScheduleSession: vi.fn(),
  transitionMessageStatus: vi.fn(),
  casActiveToIdle: vi.fn(),
  getCallbackBaseUrl: vi.fn(() => "https://platform.example"),
  verifyCronSecret: vi.fn(),
  queryOne: vi.fn(),
}));

vi.mock("@/lib/dispatcher", () => ({
  reserveSessionAndMessage: mocks.reserveSessionAndMessage,
  dispatchSessionMessage: mocks.dispatchSessionMessage,
}));

vi.mock("@/lib/sessions", () => ({
  findWarmScheduleSession: mocks.findWarmScheduleSession,
  casActiveToIdle: mocks.casActiveToIdle,
}));

vi.mock("@/lib/session-messages", () => ({
  transitionMessageStatus: mocks.transitionMessageStatus,
}));

vi.mock("@/lib/workflows/toggle", () => ({
  shouldUseWorkflow: mocks.shouldUseWorkflow,
}));

vi.mock("@/lib/workflows/dispatch-workflow", () => ({
  // Identity placeholder — runViaWorkflow forwards this reference into
  // start(); the test asserts start.calls[0][0] === this same reference.
  dispatchWorkflow: function dispatchWorkflow() {},
}));

vi.mock("workflow/api", () => ({
  start: mocks.start,
}));

vi.mock("@/lib/cron-auth", () => ({
  verifyCronSecret: mocks.verifyCronSecret,
}));

vi.mock("@/lib/mcp-connections", () => ({
  getCallbackBaseUrl: mocks.getCallbackBaseUrl,
}));

vi.mock("@/db", () => ({
  queryOne: mocks.queryOne,
}));

vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { POST } from "@/app/api/cron/scheduled-runs/execute/route";
import { dispatchWorkflow } from "@/lib/workflows/dispatch-workflow";

const TENANT_ID = "f542cc57-6057-4796-a1f7-3e1664939f91" as TenantId;
const AGENT_ID = "8896d0c4-f3a5-4b4e-a7b2-a2fef3c824a7" as AgentId;
const SCHEDULE_ID = "53ddcc83-34e8-4328-a489-24a2a1b1ed39";

function fixtureSchedule() {
  return {
    id: SCHEDULE_ID,
    tenant_id: TENANT_ID,
    agent_id: AGENT_ID,
    name: "Nightly",
    frequency: "daily" as const,
    time: "02:00:00",
    day_of_week: null,
    prompt: "do the thing",
    enabled: true,
    last_run_at: new Date().toISOString(),
    next_run_at: new Date(Date.now() + 86_400_000).toISOString(),
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
  };
}

function fixtureAgent() {
  return {
    id: AGENT_ID,
    tenant_id: TENANT_ID,
    name: "Sleep Cycle",
    model: "claude-opus-4.7",
    max_runtime_seconds: 14400,
  };
}

function fixtureTenant() {
  return { id: TENANT_ID, slug: "truetake", status: "active" as const };
}

function makeRequest() {
  return new Request("https://platform.example/api/cron/scheduled-runs/execute", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: "Bearer test" },
    body: JSON.stringify({ schedule_id: SCHEDULE_ID }),
  }) as unknown as import("next/server").NextRequest;
}

describe("schedule executor (workflow path)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.verifyCronSecret.mockReturnValue(undefined);
    mocks.findWarmScheduleSession.mockResolvedValue(null);
    mocks.shouldUseWorkflow.mockResolvedValue(true);
    mocks.queryOne
      .mockResolvedValueOnce(fixtureSchedule())
      .mockResolvedValueOnce(fixtureAgent())
      .mockResolvedValueOnce(fixtureTenant());
  });

  it("calls start(dispatchWorkflow, [input, prepared]) — passes 2 args, not 1", async () => {
    const prepared = {
      session: { id: "sess-1", tenant_id: TENANT_ID } as never,
      agent: fixtureAgent() as never,
      messageId: "msg-1",
      effectiveBudget: 10,
      effectiveMaxTurns: 50,
    };
    mocks.reserveSessionAndMessage.mockResolvedValue(prepared);
    // start() returns a run handle; returnValue resolves to the workflow's
    // happy-path output. The route races against a 270s timeout, but the
    // promise resolves immediately so the timeout never fires.
    mocks.start.mockResolvedValue({
      runId: "wrun_test_01",
      returnValue: Promise.resolve({ sessionId: "sess-1", messageId: "msg-1" }),
    });

    const res = await POST(makeRequest());
    expect(res.status).toBe(200);

    expect(mocks.reserveSessionAndMessage).toHaveBeenCalledTimes(1);
    expect(mocks.start).toHaveBeenCalledTimes(1);

    const [workflowFn, args] = mocks.start.mock.calls[0]!;
    expect(workflowFn).toBe(dispatchWorkflow);
    // The pin: args is a 2-element array [input, prepared]. The pre-fix bug
    // passed only [input], leaving prepared=undefined inside the workflow.
    expect(Array.isArray(args)).toBe(true);
    expect((args as unknown[]).length).toBe(2);

    const [input, preparedArg] = args as [
      { tenantId: TenantId; agentId: AgentId; triggeredBy: string; ephemeral: boolean },
      typeof prepared,
    ];
    expect(input.tenantId).toBe(TENANT_ID);
    expect(input.agentId).toBe(AGENT_ID);
    expect(input.triggeredBy).toBe("schedule");
    expect(input.ephemeral).toBe(false);
    expect(preparedArg).toBe(prepared);
    expect(preparedArg.messageId).toBe("msg-1");
  });

  it("on start() failure, transitions message to failed with workflow_start_failed", async () => {
    const prepared = {
      session: { id: "sess-1", tenant_id: TENANT_ID } as never,
      agent: fixtureAgent() as never,
      messageId: "msg-failed",
      effectiveBudget: 10,
      effectiveMaxTurns: 50,
    };
    mocks.reserveSessionAndMessage.mockResolvedValue(prepared);
    mocks.start.mockRejectedValue(new Error("workflow boot failed"));
    mocks.transitionMessageStatus.mockResolvedValue(true);

    const res = await POST(makeRequest());
    const body = (await res.json()) as { status: string; reason: string };
    expect(body.status).toBe("failed");
    expect(body.reason).toBe("dispatch_error");

    expect(mocks.transitionMessageStatus).toHaveBeenCalledWith(
      "msg-failed",
      TENANT_ID,
      "running",
      "failed",
      expect.objectContaining({
        error_type: "workflow_start_failed",
        error_messages: ["workflow boot failed"],
      }),
    );
  });
});
