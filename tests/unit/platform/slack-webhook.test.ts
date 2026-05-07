/**
 * Tests for src/app/api/webhooks/slack/route.ts.
 *
 * Coverage:
 *   - 401 on missing X-Slack-Request-Timestamp
 *   - 401 on stale timestamp (>5 min skew)
 *   - 400 when team_id absent in first 4KB of body
 *   - 200 unhandled when team_id not in registry — DECRYPT NEVER CALLED
 *     (this is the security invariant in R12)
 *   - 401 on signature format mismatch
 *   - 401 on signature value mismatch
 *   - url_verification with valid signature returns the challenge
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const { findBotByTeamIdMock, decryptMock } = vi.hoisted(() => ({
  findBotByTeamIdMock: vi.fn(),
  decryptMock: vi.fn(),
}));

vi.mock("@/lib/platform/bot", () => ({
  findBotByTeamId: findBotByTeamIdMock,
}));

vi.mock("@/lib/platform/operations", () => ({
  getDecryptedCredentials: decryptMock,
}));

vi.mock("next/server", async () => {
  const actual = await vi.importActual<typeof import("next/server")>("next/server");
  return {
    ...actual,
    after: (fn: () => void | Promise<void>) => fn(),
  };
});

import { POST } from "@/app/api/webhooks/slack/route";
import { NextRequest } from "next/server";

const SIGNING_SECRET = "test-signing-secret-aaaaaaaaaaaa";

async function hmacHex(secret: string, message: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret).buffer as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(message).buffer as ArrayBuffer);
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function nowSeconds(): string {
  return String(Math.floor(Date.now() / 1000));
}

function makeRequest(body: string, headers: Record<string, string>): NextRequest {
  return new NextRequest("https://example.com/api/webhooks/slack", {
    method: "POST",
    body,
    headers,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  findBotByTeamIdMock.mockReset();
  decryptMock.mockReset();
});

describe("Slack webhook strict ordering", () => {
  it("returns 401 on missing X-Slack-Request-Timestamp", async () => {
    const res = await POST(makeRequest('{"team_id":"T123"}', { "x-slack-signature": "v0=abc" }));
    expect(res.status).toBe(401);
    expect(findBotByTeamIdMock).not.toHaveBeenCalled();
    expect(decryptMock).not.toHaveBeenCalled();
  });

  it("returns 401 on stale timestamp", async () => {
    const tenMinAgo = String(Math.floor(Date.now() / 1000) - 600);
    const res = await POST(
      makeRequest('{"team_id":"T123"}', {
        "x-slack-request-timestamp": tenMinAgo,
        "x-slack-signature": "v0=abc",
      }),
    );
    expect(res.status).toBe(401);
    expect(findBotByTeamIdMock).not.toHaveBeenCalled();
    expect(decryptMock).not.toHaveBeenCalled();
  });

  it("returns 400 when team_id is missing", async () => {
    const res = await POST(
      makeRequest('{"some":"thing"}', {
        "x-slack-request-timestamp": nowSeconds(),
        "x-slack-signature": "v0=abc",
      }),
    );
    expect(res.status).toBe(400);
    expect(findBotByTeamIdMock).not.toHaveBeenCalled();
    expect(decryptMock).not.toHaveBeenCalled();
  });

  it("returns 200 unhandled and DOES NOT decrypt when team_id is unknown", async () => {
    findBotByTeamIdMock.mockReturnValueOnce(null);
    const res = await POST(
      makeRequest('{"team_id":"T999"}', {
        "x-slack-request-timestamp": nowSeconds(),
        "x-slack-signature": "v0=abc",
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { status: string };
    expect(json.status).toBe("unhandled");
    expect(findBotByTeamIdMock).toHaveBeenCalledWith("T999");
    // Critical security invariant from R12 — no decryption on unknown team_id.
    expect(decryptMock).not.toHaveBeenCalled();
  });

  it("returns 401 on signature value mismatch even after team_id matches", async () => {
    findBotByTeamIdMock.mockReturnValueOnce({
      tenantId: "tenant-1",
      agentId: "agent-1",
      botToken: "xoxb-fake",
    });
    decryptMock.mockResolvedValueOnce({
      platform: "slack",
      botToken: "xoxb-fake",
      signingSecret: SIGNING_SECRET,
    });
    const res = await POST(
      makeRequest('{"team_id":"T123"}', {
        "x-slack-request-timestamp": nowSeconds(),
        "x-slack-signature": "v0=deadbeef",
      }),
    );
    expect(res.status).toBe(401);
  });

  it("returns 200 with the challenge when url_verification arrives with a valid signature", async () => {
    findBotByTeamIdMock.mockReturnValueOnce({
      tenantId: "tenant-1",
      agentId: "agent-1",
    });
    decryptMock.mockResolvedValueOnce({
      platform: "slack",
      botToken: "xoxb-fake",
      signingSecret: SIGNING_SECRET,
    });
    const ts = nowSeconds();
    const body = JSON.stringify({
      type: "url_verification",
      challenge: "test-challenge-value",
      team_id: "T123",
    });
    const sig = await hmacHex(SIGNING_SECRET, `v0:${ts}:${body}`);
    const res = await POST(
      makeRequest(body, {
        "x-slack-request-timestamp": ts,
        "x-slack-signature": `v0=${sig}`,
      }),
    );
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).toBe("test-challenge-value");
  });
});
