/**
 * Tests for src/lib/platform/bot.ts.
 *
 * Coverage:
 *   - SECURITY INVARIANT: refreshBots() SELECT does not reference credentials_enc
 *   - findBotByToken / findBotByTeamId basic lookups
 *   - LRU eviction at 200 entries (rememberBot via getOrCreateBot)
 *   - credentialsVersion change rebuilds the cached bot
 *   - getSharedState fail-closed on missing UPSTASH_REDIS_URL
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TenantId, AgentId } from "@/lib/types";

const env = {
  UPSTASH_REDIS_URL: "rediss://test" as string | undefined,
};

vi.mock("@/lib/env", () => ({
  getEnv: () => env,
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const queryMock = vi.hoisted(() => vi.fn());
vi.mock("@/db", () => ({ query: queryMock }));

const decryptMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/platform/operations", () => ({
  getDecryptedCredentials: decryptMock,
}));

vi.mock("@chat-adapter/state-redis", () => ({
  createRedisState: vi.fn(() => ({ kind: "redis-state" })),
}));
vi.mock("@chat-adapter/discord", () => ({
  createDiscordAdapter: vi.fn((cfg) => ({ kind: "discord", cfg })),
}));
vi.mock("@chat-adapter/slack", () => ({
  createSlackAdapter: vi.fn((cfg) => ({ kind: "slack", cfg })),
}));
vi.mock("chat", () => {
  // The implementation uses `new Chat(...)`, so the mock must be
  // constructable. vi.fn() arrow returns aren't.
  class FakeChat {
    onNewMention = vi.fn();
    onSubscribedMessage = vi.fn();
    constructor(_cfg: unknown) {}
  }
  return { Chat: FakeChat };
});
vi.mock("@/lib/platform/adapters/discord", async () => {
  const actual = await vi.importActual<typeof import("@/lib/platform/adapters/discord")>(
    "@/lib/platform/adapters/discord",
  );
  return {
    ...actual,
    registerDiscordHandlers: vi.fn(),
    patchDiscord160004Idempotency: vi.fn(),
  };
});
vi.mock("@/lib/platform/adapters/slack", () => ({
  registerSlackHandlers: vi.fn(),
}));

import {
  refreshBots,
  getOrCreateBot,
  findBotByToken,
  findBotByTeamId,
  getAllBots,
} from "@/lib/platform/bot";

const tenantId = "00000000-0000-0000-0000-000000000001" as TenantId;
function agentId(n: number): AgentId {
  // Pad to a valid UUID shape.
  const hex = n.toString(16).padStart(12, "0");
  return `00000000-0000-0000-0000-${hex}` as AgentId;
}

beforeEach(() => {
  vi.clearAllMocks();
  // Drain the singleton cache between tests by evicting everything.
  const cache = getAllBots();
  for (const k of [...cache.keys()]) cache.delete(k);
  env.UPSTASH_REDIS_URL = "rediss://test";
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("refreshBots SECURITY INVARIANT: no credentials_enc in SELECT", () => {
  it("the system-scope SELECT does NOT reference credentials_enc", async () => {
    queryMock.mockResolvedValueOnce([]);
    await refreshBots();

    expect(queryMock).toHaveBeenCalledOnce();
    const sql = queryMock.mock.calls[0]?.[1] as string;
    expect(sql).toBeDefined();
    expect(sql).not.toMatch(/credentials_enc/i);
    // Verify the columns we DO need are still selected.
    expect(sql).toMatch(/tenant_id/);
    expect(sql).toMatch(/agent_id/);
    expect(sql).toMatch(/platform/);
    expect(sql).toMatch(/credentials_version/);
    expect(sql).toMatch(/enabled/);
    expect(sql).toMatch(/platform_identity/);
  });
});

describe("findBotByToken / findBotByTeamId", () => {
  it("findBotByToken returns null when cache is empty", () => {
    expect(findBotByToken("does-not-exist")).toBeNull();
  });

  it("findBotByTeamId returns null when cache is empty", () => {
    expect(findBotByTeamId("T1")).toBeNull();
  });

  it("getOrCreateBot for discord caches by (platform, agentId) and findBotByToken finds it", async () => {
    const aid = agentId(1);
    decryptMock.mockResolvedValueOnce({
      platform: "discord",
      botToken: "tok-1",
      publicKey: "0".repeat(64),
      applicationId: "app",
    });
    const cached = await getOrCreateBot({
      tenantId,
      agentId: aid,
      platform: "discord",
      credentialsVersion: 1,
      platformIdentity: { bot_user_id: "BOT123" },
    });
    expect(cached.botToken).toBe("tok-1");
    expect(cached.botUserId).toBe("BOT123");
    expect(findBotByToken("tok-1")).toBe(cached);
    expect(findBotByToken("other")).toBeNull();
  });

  it("getOrCreateBot for slack populates slackTeamId from platform_identity.team_id", async () => {
    const aid = agentId(2);
    decryptMock.mockResolvedValueOnce({
      platform: "slack",
      botToken: "xoxb-1",
      signingSecret: "sec",
    });
    const cached = await getOrCreateBot({
      tenantId,
      agentId: aid,
      platform: "slack",
      credentialsVersion: 1,
      platformIdentity: { team_id: "T1", bot_user_id: "U1" },
    });
    expect(cached.slackTeamId).toBe("T1");
    expect(findBotByTeamId("T1")).toBe(cached);
  });
});

describe("LRU eviction", () => {
  it("evicts the oldest entry when cache exceeds 200 entries", async () => {
    decryptMock.mockResolvedValue({
      platform: "discord",
      botToken: "tok",
      publicKey: "0".repeat(64),
      applicationId: "app",
    });

    // Insert 201 distinct discord bots.
    for (let i = 0; i < 201; i++) {
      await getOrCreateBot({
        tenantId,
        agentId: agentId(i),
        platform: "discord",
        credentialsVersion: 1,
        platformIdentity: {},
      });
    }

    const cache = getAllBots();
    expect(cache.size).toBe(200);
    // The oldest (i=0) entry should be evicted.
    expect(cache.has(`discord:${agentId(0)}`)).toBe(false);
    // The most recent entries should still be there.
    expect(cache.has(`discord:${agentId(200)}`)).toBe(true);
    expect(cache.has(`discord:${agentId(1)}`)).toBe(true);
  });
});

describe("credentialsVersion-driven rebuild", () => {
  it("rebuilds the cached entry when credentialsVersion changes", async () => {
    const aid = agentId(7);
    decryptMock.mockResolvedValue({
      platform: "discord",
      botToken: "tok",
      publicKey: "0".repeat(64),
      applicationId: "app",
    });

    const first = await getOrCreateBot({
      tenantId,
      agentId: aid,
      platform: "discord",
      credentialsVersion: 1,
      platformIdentity: {},
    });
    const second = await getOrCreateBot({
      tenantId,
      agentId: aid,
      platform: "discord",
      credentialsVersion: 2, // bumped
      platformIdentity: {},
    });

    expect(second).not.toBe(first);
    expect(second.credentialsVersion).toBe(2);
    // Same v reuses cached entry.
    const third = await getOrCreateBot({
      tenantId,
      agentId: aid,
      platform: "discord",
      credentialsVersion: 2,
      platformIdentity: {},
    });
    expect(third).toBe(second);
  });
});

describe("UPSTASH_REDIS_URL boot-fail-closed", () => {
  // sharedState is a module singleton, so once it's been initialized by
  // another test, unsetting UPSTASH_REDIS_URL is not enough — the env
  // check only runs on first init. Reset modules to force a fresh
  // sharedState initialization for this test.
  it("buildCachedBot throws a clear error when UPSTASH_REDIS_URL is unset", async () => {
    vi.resetModules();
    env.UPSTASH_REDIS_URL = undefined;
    decryptMock.mockResolvedValue({
      platform: "discord",
      botToken: "tok",
      publicKey: "0".repeat(64),
      applicationId: "app",
    });

    const fresh = await import("@/lib/platform/bot");
    await expect(
      fresh.getOrCreateBot({
        tenantId,
        agentId: agentId(99),
        platform: "discord",
        credentialsVersion: 1,
        platformIdentity: {},
      }),
    ).rejects.toThrow(/UPSTASH_REDIS_URL/);
  });
});
