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

const env: { SLACK_SIGNING_SECRET: string | undefined; SLACK_SIGNING_SECRET_PREVIOUS: string | undefined } = {
  SLACK_SIGNING_SECRET: undefined,
  SLACK_SIGNING_SECRET_PREVIOUS: undefined,
};

vi.mock("@/lib/env", () => ({
  getEnv: () => env,
}));

const { findBotByTeamIdMock, decryptMock } = vi.hoisted(() => ({
  findBotByTeamIdMock: vi.fn(),
  decryptMock: vi.fn(),
}));

vi.mock("@/lib/platform/bot", () => ({
  // Route now calls findOrLoadSlackBotByTeamId (async) — the underlying
  // shape from the route's POV is the same: returns a CachedBot or null.
  findOrLoadSlackBotByTeamId: findBotByTeamIdMock,
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
    findBotByTeamIdMock.mockResolvedValueOnce(null);
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

  it("returns 200 unhandled on signature value mismatch (closes team_id oracle)", async () => {
    // P2 #18: returning 401 on bad signature for a registered team_id and
    // 200 on unknown team_id leaks which team_ids are registered. Both
    // paths now return 200 unhandled with the same body.
    findBotByTeamIdMock.mockResolvedValueOnce({
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
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("unhandled");
  });

  it("returns 200 with the challenge on url_verification — uses global SLACK_SIGNING_SECRET fallback (no team_id in Slack's payload)", async () => {
    // Slack's url_verification body does NOT include team_id — only
    // {type, challenge, token}. The route must short-circuit on
    // type === 'url_verification' BEFORE the team_id requirement so
    // the global SLACK_SIGNING_SECRET fallback can authorize the
    // handshake. Per-bot signing secret isn't queried; findBotByTeamId
    // is never reached.
    env.SLACK_SIGNING_SECRET = SIGNING_SECRET;
    try {
      const ts = nowSeconds();
      const body = JSON.stringify({
        type: "url_verification",
        challenge: "test-challenge-value",
        token: "verification-token",
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
      expect(findBotByTeamIdMock).not.toHaveBeenCalled();
      expect(decryptMock).not.toHaveBeenCalled();
    } finally {
      env.SLACK_SIGNING_SECRET = undefined;
    }
  });

  it("returns 200 unhandled on url_verification when SLACK_SIGNING_SECRET is unset", async () => {
    // No global fallback configured. The route still short-circuits
    // on type before the team_id check, but maybeHandleFirstTimeChallenge
    // returns the unhandled response when the signing secret is absent.
    const ts = nowSeconds();
    const body = JSON.stringify({
      type: "url_verification",
      challenge: "test-challenge-value",
      token: "verification-token",
    });
    const res = await POST(
      makeRequest(body, {
        "x-slack-request-timestamp": ts,
        "x-slack-signature": "v0=abc",
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { status: string };
    expect(json.status).toBe("unhandled");
  });
});
