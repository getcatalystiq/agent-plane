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

export async function POST(req: NextRequest) {
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

  // 2. Extract team_id — body is unauthenticated until step 6, but the
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
    return new Response(JSON.stringify({ status: "unhandled" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
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
  const sigHeader = req.headers.get("x-slack-signature");
  const match = sigHeader?.match(/^v0=([0-9a-f]+)$/i);
  if (!match) {
    return new Response(JSON.stringify({ error: "invalid_signature_format" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }
  const provided = match[1].toLowerCase();
  const expected = await hmacSha256Hex(signingSecret, `v0:${ts}:${rawBody}`);
  if (!constantTimeEqualHex(provided, expected)) {
    return new Response(JSON.stringify({ error: "invalid_signature" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

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
}
