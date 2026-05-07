/**
 * Tests for the Discord webhook forwarder-signature verification.
 *
 * Coverage:
 *   - Valid signature with CURRENT secret → SDK dispatch path is reached
 *   - Valid signature with PREVIOUS secret (rotation window) → accepted
 *   - Invalid signature → 401, never calls findBotByToken
 *   - Missing signature → 401
 *   - Unknown bot token (post-signature) → 200 unhandled
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const ENV = {
  GATEWAY_FORWARDER_SECRET: "current-secret-1234567890",
  GATEWAY_FORWARDER_SECRET_PREVIOUS: "previous-secret-9876543210",
  CRON_SECRET: "cron",
  ENCRYPTION_KEY: "0".repeat(64),
};

vi.mock("@/lib/env", () => ({
  getEnv: () => ENV,
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { findBotByTokenMock, stashMock } = vi.hoisted(() => ({
  findBotByTokenMock: vi.fn(),
  stashMock: vi.fn(),
}));

vi.mock("@/lib/platform/bot", () => ({
  findBotByToken: findBotByTokenMock,
}));

vi.mock("@/lib/platform/attachments", () => ({
  stashInboundAttachments: stashMock,
  normalizeDiscordAttachments: () => [],
}));

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return {
    ...actual,
    after: (fn: () => void | Promise<void>) => fn(),
  };
});

import { POST } from "@/app/api/webhooks/discord/route";
import { NextRequest } from "next/server";

async function hmacHex(secret: string, body: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret).buffer as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(body).buffer as ArrayBuffer);
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function makeRequest(body: string, headers: Record<string, string>): NextRequest {
  return new NextRequest("https://example.com/api/webhooks/discord", {
    method: "POST",
    body,
    headers,
  });
}

describe("Discord webhook forwarder-signature verify", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    findBotByTokenMock.mockReset();
    stashMock.mockReset();
  });

  it("returns 401 when no signature header is provided", async () => {
    const body = JSON.stringify({ type: "GATEWAY_MESSAGE_CREATE", data: { id: "m1" } });
    const res = await POST(makeRequest(body, { "content-type": "application/json", "x-discord-gateway-token": "token-x" }));
    expect(res.status).toBe(401);
    expect(findBotByTokenMock).not.toHaveBeenCalled();
  });

  it("returns 401 on invalid signature", async () => {
    const body = JSON.stringify({ type: "GATEWAY_MESSAGE_CREATE", data: { id: "m1" } });
    const res = await POST(
      makeRequest(body, {
        "content-type": "application/json",
        "x-discord-gateway-token": "token-x",
        "x-gateway-signature": "v1=deadbeef",
      }),
    );
    expect(res.status).toBe(401);
    expect(findBotByTokenMock).not.toHaveBeenCalled();
  });

  it("accepts a payload signed with CURRENT secret and consults findBotByToken", async () => {
    const body = JSON.stringify({ type: "GATEWAY_MESSAGE_CREATE", data: { id: "m1" } });
    const sig = await hmacHex(ENV.GATEWAY_FORWARDER_SECRET, body);
    findBotByTokenMock.mockReturnValueOnce(null);
    const res = await POST(
      makeRequest(body, {
        "content-type": "application/json",
        "x-discord-gateway-token": "unknown-token",
        "x-gateway-signature": `v1=${sig}`,
      }),
    );
    expect(res.status).toBe(200);
    expect(findBotByTokenMock).toHaveBeenCalledWith("unknown-token");
    const json = (await res.json()) as { status: string };
    expect(json.status).toBe("unhandled");
  });

  it("accepts a payload signed with PREVIOUS secret (rotation window)", async () => {
    const body = JSON.stringify({ type: "GATEWAY_MESSAGE_CREATE", data: { id: "m1" } });
    const sig = await hmacHex(ENV.GATEWAY_FORWARDER_SECRET_PREVIOUS, body);
    findBotByTokenMock.mockReturnValueOnce(null);
    const res = await POST(
      makeRequest(body, {
        "content-type": "application/json",
        "x-discord-gateway-token": "unknown-token",
        "x-gateway-signature": `v1=${sig}`,
      }),
    );
    expect(res.status).toBe(200);
    expect(findBotByTokenMock).toHaveBeenCalled();
  });
});
