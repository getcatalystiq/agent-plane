/**
 * Slack Events API webhook — strict signature-verification ordering.
 *
 * Plan reference: U5 in
 * docs/plans/2026-05-06-001-feat-chat-platform-bots-discord-slack-plan.md
 *
 * Order (R12, no decryption before authentication):
 *   1. Read raw body once.
 *   2. Verify timestamp skew from headers (≤5 min). Fail → 401, no parse.
 *   3. Parse team_id from body via a length-bounded JSON pointer extract.
 *   4. findBotByTeamId(teamId) — if null: 200 `unhandled`, no decrypt.
 *   5. Decrypt the bot's signing secret (via getDecryptedCredentials).
 *   6. HMAC-SHA-256 verify `v0:${timestamp}:${rawBody}` against
 *      X-Slack-Signature `v0=` prefix; constant-time compare.
 *   7. Hand to Chat SDK's webhook dispatch (which fires onAppMention etc.).
 *
 * url_verification challenge requires the same signature path — Slack signs
 * those events too, so we don't short-circuit before signature verify.
 */

import { NextRequest, after } from "next/server";
import { logger } from "@/lib/logger";
import { getEnv } from "@/lib/env";
import { withErrorHandler } from "@/lib/api";
import { findBotByTeamId } from "@/lib/platform/bot";
import { getDecryptedCredentials, type SlackCredentials } from "@/lib/platform/operations";
import type { TenantId, AgentId } from "@/lib/types";

export const dynamic = "force-dynamic";

const TIMESTAMP_SKEW_SECONDS = 300; // 5 minutes

function constantTimeEqualHex(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

async function hmacSha256Hex(secret: string, body: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    "raw",
    enc.encode(secret).buffer as ArrayBuffer,
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  );
  const sig = await crypto.subtle.sign("HMAC", key, enc.encode(body).buffer as ArrayBuffer);
  return Array.from(new Uint8Array(sig)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

/**
 * Length-bounded `team_id` extractor — parses up to the first 4 KB of the
 * body so an attacker cannot drag the route into JSON-parsing megabytes of
 * unauthenticated input. Returns null if `team_id` is absent in the prefix.
 */
function extractTeamId(body: string): string | null {
  const prefix = body.length > 4096 ? body.slice(0, 4096) : body;
  // Match either `"team_id":"T..."` (top-level) or nested under `team`/`event`.
  const match = prefix.match(/"team_id"\s*:\s*"([A-Z0-9]+)"/);
  return match ? match[1] : null;
}

interface SlackEventBody {
  type?: string;
  challenge?: string;
  team_id?: string;
  event?: { type?: string };
}

/**
 * Verify a Slack v0 signature against the given secret. Constant-time
 * compare. Returns true on match. Shared between the per-bot path and
 * the first-time url_verification fallback (maint-2 refactor).
 */
async function verifySlackV0(
  rawBody: string,
  ts: number,
  sigHeader: string | null,
  secret: string,
): Promise<boolean> {
  const match = sigHeader?.match(/^v0=([0-9a-f]+)$/i);
  if (!match) return false;
  const provided = match[1].toLowerCase();
  const expected = await hmacSha256Hex(secret, `v0:${ts}:${rawBody}`);
  return constantTimeEqualHex(provided, expected);
}

function unhandledResponse(): Response {
  return new Response(JSON.stringify({ status: "unhandled" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

async function maybeHandleFirstTimeChallenge(
  rawBody: string,
  ts: number,
  sigHeader: string | null,
): Promise<Response> {
  const env = getEnv();
  const fallback = env.SLACK_SIGNING_SECRET;
  if (!fallback) return unhandledResponse();
  if (!(await verifySlackV0(rawBody, ts, sigHeader, fallback))) return unhandledResponse();

  // Signature valid against the global fallback. Only respond to
  // url_verification — anything else gets unhandled (we don't want to
  // accept real events on the global secret bypass per SEC-R2-001).
  let parsed: SlackEventBody;
  try {
    parsed = JSON.parse(rawBody) as SlackEventBody;
  } catch {
    return unhandledResponse();
  }
  if (parsed.type === "url_verification" && typeof parsed.challenge === "string") {
    logger.info("slack-webhook: first-time url_verification accepted via global fallback secret");
    return new Response(parsed.challenge, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }
  return unhandledResponse();
}

export const POST = withErrorHandler(async (req: NextRequest) => {
  const rawBody = await req.text();

  // 1. Timestamp skew check — header-only, no parse.
  const tsHeader = req.headers.get("x-slack-request-timestamp");
  const ts = tsHeader ? Number.parseInt(tsHeader, 10) : NaN;
  if (!Number.isFinite(ts)) {
    return new Response(JSON.stringify({ error: "missing_timestamp" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  const now = Math.floor(Date.now() / 1000);
  if (Math.abs(now - ts) > TIMESTAMP_SKEW_SECONDS) {
    return new Response(JSON.stringify({ error: "stale_timestamp" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 2. url_verification short-circuit. Slack's url_verification POST
  //    has no `team_id` field — only `{type, challenge, token}` — so
  //    the team_id-required path below would 400 on it. Peek at `type`
  //    in the unauthenticated body prefix and route directly to
  //    maybeHandleFirstTimeChallenge, which does the HMAC verify
  //    before echoing the challenge.
  const bodyPrefix = rawBody.length > 4096 ? rawBody.slice(0, 4096) : rawBody;
  if (/"type"\s*:\s*"url_verification"/.test(bodyPrefix)) {
    return await maybeHandleFirstTimeChallenge(rawBody, ts, req.headers.get("x-slack-signature"));
  }

  // 3. Extract team_id — body is unauthenticated until step 6, but the
  //    extract is length-bounded.
  const teamId = extractTeamId(rawBody);
  if (!teamId) {
    return new Response(JSON.stringify({ error: "missing_team_id" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 3. Registry lookup — no decryption yet.
  const targetBot = findBotByTeamId(teamId);
  if (!targetBot) {
    // A5 (review run 20260506-221948-2402b0ed P1 #12): first-time Slack
    // setup chicken-and-egg. Slack POSTs `url_verification` to the
    // configured Request URL before the operator has saved the signing
    // secret in AgentPlane — so findBotByTeamId returns null. If a
    // global SLACK_SIGNING_SECRET env var is configured AND the body is
    // a url_verification challenge, fall back to that secret to verify
    // and respond with the challenge so the portal handshake completes.
    // After credentials are saved, the per-bot signing secret takes
    // over for real events.
    //
    // Round-3 review #9: the prior SEC-R2-002 no-op HMAC against a
    // zero-secret was timing theatre — it closed <1% of the gap because
    // the known-team-id branch is dominated by Neon SELECT + AES-GCM
    // decrypt latency (~10-100ms), not the HMAC. We accept the residual
    // workspace-existence oracle: the side channel is reconnaissance-
    // grade only. Real events still require the per-bot signing secret,
    // so the oracle does not enable forgery — it only reveals which
    // team_ids have AgentPlane bots installed, information already
    // discoverable by attempting an OAuth install in the workspace.
    return await maybeHandleFirstTimeChallenge(rawBody, ts, req.headers.get("x-slack-signature"));
  }

  // 4. Decrypt the bot's signing secret.
  let signingSecret: string;
  try {
    const creds = (await getDecryptedCredentials(
      targetBot.tenantId as TenantId,
      targetBot.agentId as AgentId,
      "slack",
    )) as SlackCredentials | null;
    if (!creds) {
      return new Response(JSON.stringify({ status: "unhandled" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }
    signingSecret = creds.signingSecret;
  } catch (err) {
    logger.error("slack-webhook: decrypt failed", {
      agent_id: targetBot.agentId,
      error: err instanceof Error ? err.message : String(err),
    });
    return new Response(JSON.stringify({ error: "decrypt_failed" }), {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 5. HMAC verify.
  //
  //    SEC-R2-001 fix (review run 20260506-232400-round2): the per-bot
  //    secret is the ONLY secret that authorizes real events. The
  //    global SLACK_SIGNING_SECRET / SLACK_SIGNING_SECRET_PREVIOUS env
  //    vars are accepted only on the maybeHandleFirstTimeChallenge
  //    path — i.e., url_verification challenges before per-bot
  //    credentials are saved. Round-1 added the global fallback for
  //    multi-bot rotation convenience, but that broke the per-bot
  //    ownership model: anyone holding the global env value could
  //    forge real events on any tenant's bot. Per-bot rotation via
  //    `credentials_version` bump is the canonical rotation path.
  //
  //    Signature failures past the team_id-found branch return 200
  //    unhandled — the same status the unknown-team_id branch returns —
  //    to close the timing/registration oracle (P2 #18).
  const sigHeader = req.headers.get("x-slack-signature");
  const verified = await verifySlackV0(rawBody, ts, sigHeader, signingSecret);
  if (!verified) return unhandledResponse();

  // 6. Parse body — now safe.
  let parsed: SlackEventBody;
  try {
    parsed = JSON.parse(rawBody) as SlackEventBody;
  } catch {
    return new Response(JSON.stringify({ error: "invalid_json" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 7. url_verification — Slack's app-config handshake. Signature already
  //    verified above, so the challenge response is authenticated.
  if (parsed.type === "url_verification" && typeof parsed.challenge === "string") {
    return new Response(parsed.challenge, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }

  // 8. Hand to Chat SDK.
  try {
    await targetBot.bot.initialize();
    const newReq = new NextRequest(req.url, {
      method: req.method,
      headers: req.headers,
      body: rawBody,
    });
    const response = await targetBot.bot.webhooks.slack(newReq, {
      waitUntil: (p) => after(() => p),
    });
    if (response) return response;
  } catch (err) {
    logger.error("slack-webhook: SDK dispatch failed", {
      agent_id: targetBot.agentId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return new Response(JSON.stringify({ status: "ok" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
