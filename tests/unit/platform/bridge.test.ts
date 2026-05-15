/**
 * Tests for src/lib/platform/bridge.ts.
 *
 * Coverage:
 *   - chatIdempotencyKey — tenant-scoped composition
 *   - checkChatRateLimits — agent vs user precedence + rate limiting
 *   - triggerChatWorkflow — length guard
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { startWorkflowMock } = vi.hoisted(() => ({
  startWorkflowMock: vi.fn(),
}));

vi.mock("@/lib/workflows/chat-dispatch-workflow", () => ({
  startChatDispatchWorkflow: startWorkflowMock,
}));

import {
  chatIdempotencyKey,
  checkChatRateLimits,
  triggerChatWorkflow,
  RATE_LIMIT_PER_AGENT_PER_MIN,
  RATE_LIMIT_PER_USER_PER_MIN,
  MAX_INBOUND_LENGTH,
  type ChatTriggerInput,
} from "@/lib/platform/bridge";
import type { TenantId, AgentId } from "@/lib/types";

const baseInput: ChatTriggerInput = {
  tenantId: "11111111-1111-1111-1111-111111111111" as TenantId,
  agentId: "22222222-2222-2222-2222-222222222222" as AgentId,
  platform: "discord",
  threadKey: "discord:G:C:T",
  channelId: "C",
  prompt: "hello",
  authorId: "U1",
  authorDisplayName: "alice",
  eventId: "evt-1",
};

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  startWorkflowMock.mockReset();
});

describe("chatIdempotencyKey", () => {
  it("includes tenantId so two tenants in the same Slack workspace don't collide", () => {
    const k1 = chatIdempotencyKey({ tenantId: "tenant-a" as TenantId, platform: "slack", eventId: "evt-shared" });
    const k2 = chatIdempotencyKey({ tenantId: "tenant-b" as TenantId, platform: "slack", eventId: "evt-shared" });
    expect(k1).not.toBe(k2);
  });

  it("uses chat: prefix and platform discriminator", () => {
    const k = chatIdempotencyKey({ tenantId: "t" as TenantId, platform: "discord", eventId: "e" });
    expect(k).toBe("chat:t:discord:e");
  });
});

describe("checkChatRateLimits", () => {
  it("allows under-limit requests", () => {
    const fresh = { ...baseInput, agentId: `agent-fresh-${Date.now()}` as AgentId, authorId: `user-fresh-${Date.now()}` };
    expect(checkChatRateLimits(fresh).allowed).toBe(true);
  });

  it("rate-limits the agent when burst exceeds 30/min", () => {
    const agentId = `agent-burst-${Date.now()}` as AgentId;
    const userId = `user-burst-${Date.now()}`;
    const inputs: ChatTriggerInput[] = Array.from({ length: RATE_LIMIT_PER_AGENT_PER_MIN }, (_, i) => ({
      ...baseInput,
      agentId,
      authorId: `${userId}-${i}`,
      eventId: `evt-${i}`,
    }));
    let blockedCount = 0;
    for (const inp of inputs) {
      const r = checkChatRateLimits(inp);
      if (!r.allowed) blockedCount += 1;
    }
    expect(blockedCount).toBe(0);
    // 31st call (different user, same agent) trips agent limit first
    const tripping = { ...baseInput, agentId, authorId: `${userId}-final`, eventId: "evt-final" };
    const r = checkChatRateLimits(tripping);
    expect(r.allowed).toBe(false);
    expect(r.which).toBe("agent");
  });

  it("rate-limits the user when burst from one user exceeds 10/min", () => {
    const agentId = `agent-userburst-${Date.now()}` as AgentId;
    const userId = `user-${Date.now()}`;
    let blocked: { allowed: boolean; which?: string } | null = null;
    for (let i = 0; i < RATE_LIMIT_PER_USER_PER_MIN + 1; i++) {
      const r = checkChatRateLimits({
        ...baseInput,
        agentId,
        authorId: userId,
        eventId: `evt-${i}`,
      });
      if (!r.allowed) {
        blocked = r;
        break;
      }
    }
    expect(blocked).not.toBeNull();
    expect(blocked?.which).toBe("user");
  });
});

describe("triggerChatWorkflow", () => {
  beforeEach(() => {
    startWorkflowMock.mockResolvedValue(undefined);
  });

  it("drops the message and does NOT start the workflow when prompt > MAX_INBOUND_LENGTH", async () => {
    const fresh = {
      ...baseInput,
      agentId: `agent-len-${Date.now()}` as AgentId,
      authorId: `user-len-${Date.now()}`,
      prompt: "x".repeat(MAX_INBOUND_LENGTH + 1),
    };
    await triggerChatWorkflow(fresh);
    expect(startWorkflowMock).not.toHaveBeenCalled();
  });

  it("calls the workflow with rateLimited=null on the happy path", async () => {
    const fresh = {
      ...baseInput,
      agentId: `agent-happy-${Date.now()}` as AgentId,
      authorId: `user-happy-${Date.now()}`,
    };
    await triggerChatWorkflow(fresh);
    expect(startWorkflowMock).toHaveBeenCalledOnce();
    const optsArg = startWorkflowMock.mock.calls[0]?.[1] as { rateLimited: string | null };
    expect(optsArg.rateLimited).toBeNull();
  });

  it("still calls the workflow with rateLimited=which when limit hit", async () => {
    const agentId = `agent-overlim-${Date.now()}` as AgentId;
    // Saturate the per-user limit
    for (let i = 0; i < RATE_LIMIT_PER_USER_PER_MIN; i++) {
      checkChatRateLimits({ ...baseInput, agentId, authorId: "user-hot", eventId: `evt-${i}` });
    }
    await triggerChatWorkflow({ ...baseInput, agentId, authorId: "user-hot", eventId: "evt-trigger" });
    expect(startWorkflowMock).toHaveBeenCalled();
    const optsArg = startWorkflowMock.mock.calls.at(-1)?.[1] as { rateLimited: string | null };
    expect(optsArg.rateLimited).toBe("user");
  });
});
