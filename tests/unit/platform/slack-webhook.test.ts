/**
 * Tests for src/app/api/webhooks/slack/route.ts.
 *
 * Coverage:
 *   - 401 on missing X-Slack-Request-Timestamp
 *   - 401 on stale timestamp (>5 min skew)
 *   - 400 when team_id absent in first 4KB of body
 *   - 200 queued when team_id not in registry — bot lookup probed but
 *     getDecryptedCredentials never called from the route (the route
 *     gets candidates with their signing secret bundled by listSlackBotsByTeamId,
 *     which is itself mocked here)
 *   - 200 queued on signature value mismatch — body identical to the
 *     unknown-team path, preserving the team_id oracle (P2 #18)
 *   - url_verification with valid signature returns the challenge
 *
 * Mock contract: the route imports five helpers from `@/lib/platform/bot`
 * (`findSlackBotByTeamAndApp`, `getOrCreateBot`, `listSlackBotSigningSecrets`,
 * `listSlackBotsByTeamId`, `persistSlackAppIdIfMissing`). All five must
 * be mocked here — `vi.mock(..., factory)` with omitted exports leaves
 * them undefined, which would crash the deferred `after()` path.
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

const {
  findSlackBotByTeamAndAppMock,
  listSlackBotsByTeamIdMock,
  listSlackBotSigningSecretsMock,
  getOrCreateBotMock,
  persistSlackAppIdIfMissingMock,
  decryptMock,
} = vi.hoisted(() => ({
  findSlackBotByTeamAndAppMock: vi.fn(),
  listSlackBotsByTeamIdMock: vi.fn(),
  listSlackBotSigningSecretsMock: vi.fn(),
  getOrCreateBotMock: vi.fn(),
  persistSlackAppIdIfMissingMock: vi.fn(),
  decryptMock: vi.fn(),
}));

vi.mock("@/lib/platform/bot", () => ({
  findSlackBotByTeamAndApp: findSlackBotByTeamAndAppMock,
  listSlackBotsByTeamId: listSlackBotsByTeamIdMock,
  listSlackBotSigningSecrets: listSlackBotSigningSecretsMock,
  getOrCreateBot: getOrCreateBotMock,
  persistSlackAppIdIfMissing: persistSlackAppIdIfMissingMock,
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
  findSlackBotByTeamAndAppMock.mockReset();
  listSlackBotsByTeamIdMock.mockReset();
  listSlackBotSigningSecretsMock.mockReset();
  getOrCreateBotMock.mockReset();
  persistSlackAppIdIfMissingMock.mockReset();
  decryptMock.mockReset();
});

describe("Slack webhook strict ordering", () => {
  it("returns 401 on missing X-Slack-Request-Timestamp", async () => {
    const res = await POST(makeRequest('{"team_id":"T123"}', { "x-slack-signature": "v0=abc" }));
    expect(res.status).toBe(401);
    expect(listSlackBotsByTeamIdMock).not.toHaveBeenCalled();
    expect(findSlackBotByTeamAndAppMock).not.toHaveBeenCalled();
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
    expect(listSlackBotsByTeamIdMock).not.toHaveBeenCalled();
    expect(findSlackBotByTeamAndAppMock).not.toHaveBeenCalled();
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
    expect(listSlackBotsByTeamIdMock).not.toHaveBeenCalled();
    expect(findSlackBotByTeamAndAppMock).not.toHaveBeenCalled();
    expect(decryptMock).not.toHaveBeenCalled();
  });

  it("returns 200 queued and DOES NOT decrypt when team_id is unknown (deferred path drops silently)", async () => {
    // Body has no api_app_id → route skips the surgical lookup and goes
    // straight to the enumerate-by-team_id fallback. An unknown team_id
    // returns an empty candidate list; the deferred path drops without
    // decrypting any credentials.
    listSlackBotsByTeamIdMock.mockResolvedValueOnce([]);
    const res = await POST(
      makeRequest('{"team_id":"T999"}', {
        "x-slack-request-timestamp": nowSeconds(),
        "x-slack-signature": "v0=abc",
      }),
    );
    expect(res.status).toBe(200);
    const json = (await res.json()) as { status: string };
    expect(json.status).toBe("queued");
    // The route's `after()` mock runs deferred work inline before the
    // response promise resolves, so the bot lookup HAS happened by now.
    expect(findSlackBotByTeamAndAppMock).not.toHaveBeenCalled();
    expect(listSlackBotsByTeamIdMock).toHaveBeenCalledWith("T999");
    // Critical security invariant from R12 — no decryption on unknown
    // team_id, even after the deferred path runs. (decrypt is invoked
    // inside listSlackBotsByTeamId's helper only when rows are returned;
    // we mocked that to [] here so it never reaches decrypt.)
    expect(decryptMock).not.toHaveBeenCalled();
  });

  it("returns 200 queued on signature value mismatch (oracle preserved — body is identical to unknown-team path)", async () => {
    // P2 #18: returning 401 on bad signature for a registered team_id
    // and 200 on unknown team_id leaks which team_ids are registered.
    // With the after() refactor, both paths get the same immediate
    // 200 queued ack; the registered-but-bad-sig case enumerates
    // candidates in the deferred path and drops silently when none
    // verify. The team_id oracle stays closed because the response
    // shape is identical for both branches.
    //
    // listSlackBotsByTeamId returns SlackBotCandidate[], each carrying
    // their own signingSecret (its internal helper called
    // getDecryptedCredentials at the storage layer). The route does
    // NOT call getDecryptedCredentials directly — it walks the
    // candidates and HMACs each signing secret against the request
    // body. The test mocks listSlackBotsByTeamId so the storage-layer
    // decrypt call is bypassed entirely.
    listSlackBotsByTeamIdMock.mockResolvedValueOnce([
      {
        tenantId: "tenant-1",
        agentId: "agent-1",
        credentialsVersion: 1,
        platformIdentity: { team_id: "T123" },
        signingSecret: SIGNING_SECRET,
      },
    ]);
    const res = await POST(
      makeRequest('{"team_id":"T123"}', {
        "x-slack-request-timestamp": nowSeconds(),
        "x-slack-signature": "v0=deadbeef",
      }),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as { status: string };
    expect(body.status).toBe("queued");
    // The route enumerates candidates from listSlackBotsByTeamId (1
    // call) and runs the constant-time HMAC comparison; no candidate
    // matches, so the deferred path silently drops. No SDK dispatch
    // should happen.
    expect(listSlackBotsByTeamIdMock).toHaveBeenCalledTimes(1);
    expect(getOrCreateBotMock).not.toHaveBeenCalled();
    // getDecryptedCredentials is mocked separately and never called by
    // the route (the candidate's signing secret arrives bundled with
    // the row).
    expect(decryptMock).not.toHaveBeenCalled();
  });

  it("returns 200 with the challenge on url_verification — uses global SLACK_SIGNING_SECRET fallback (no team_id in Slack's payload)", async () => {
    // Slack's url_verification body does NOT include team_id — only
    // {type, challenge, token}. The route must short-circuit on
    // type === 'url_verification' BEFORE the team_id requirement so
    // the global SLACK_SIGNING_SECRET fallback can authorize the
    // handshake. Per-bot signing secret isn't queried;
    // listSlackBotsByTeamId is never reached.
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
      expect(listSlackBotsByTeamIdMock).not.toHaveBeenCalled();
      expect(findSlackBotByTeamAndAppMock).not.toHaveBeenCalled();
      expect(decryptMock).not.toHaveBeenCalled();
    } finally {
      env.SLACK_SIGNING_SECRET = undefined;
    }
  });

  it("returns 200 unhandled on url_verification when SLACK_SIGNING_SECRET is unset and no per-bot secret matches", async () => {
    // No global fallback configured; per-bot fallback list is empty
    // (no Slack bots registered yet — typical first-time install
    // scenario before the user pastes credentials in admin). The
    // route's maybeHandleFirstTimeChallenge returns "unhandled" when
    // no candidate signing secret matches the inbound signature.
    listSlackBotSigningSecretsMock.mockResolvedValueOnce([]);
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
