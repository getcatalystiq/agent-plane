/**
 * Slack Events API webhook — fast-ack + deferred verify/dispatch.
 *
 * Plan reference: U5 in
 * docs/plans/2026-05-06-001-feat-chat-platform-bots-discord-slack-plan.md
 *
 * Slack's 3-second ack window is too narrow for the cold-start cost of
 * Neon SELECT + AES-GCM decrypt + Chat SDK boot + workflow start. When
 * we missed it, Slack retried with exponential backoff (immediate, +1s,
 * +5s, +10s), producing up to 4 webhook deliveries per single user
 * message — wasted compute even after the m.ts dedupe collapsed them
 * onto a single workflow run.
 *
 * Sync (fast) path — runs before the response:
 *   1. Read raw body once.
 *   2. Verify timestamp skew from headers (≤5 min). Fail → 401.
 *   3. url_verification short-circuit. The handshake body has no
 *      `team_id`, so we'd 400 it on the path below; route directly
 *      to the global-fallback HMAC verifier and echo the challenge.
 *   4. Length-bounded team_id extract — if missing, 400.
 *   5. Return 200 `queued` immediately.
 *
 * Deferred (after()) path — runs after the response:
 *   6. listSlackBotsByTeamId(teamId) — return ALL enabled bots for that
 *      workspace (some teams have two registered apps; LIMIT 1 picked
 *      arbitrary). Drop silently if none.
 *   7. For each candidate, HMAC-SHA-256 verify `v0:${timestamp}:${rawBody}`
 *      with the candidate's per-bot signing secret. The first match
 *      identifies which app sent the event.
 *   8. Resolve the matched candidate's cached Chat instance via
 *      getOrCreateBot, then hand to Chat SDK's webhook dispatch.
 *   9. If no candidate verified, drop silently and log fingerprints.
 *
 * Security: bad-sig events get a 200 `queued` ack but are silently
 * dropped after the deferred verify fails — same outcome as the prior
 * synchronous "200 unhandled" path that closed the team_id oracle
 * (P2 #18). The 200 ack is not a signature attestation; it's just
 * Slack's retry suppression contract.
 */

import { NextRequest, after } from "next/server";
import { logger } from "@/lib/logger";
import { getEnv } from "@/lib/env";
import { withErrorHandler } from "@/lib/api";
import {
  findSlackBotByTeamAndApp,
  getOrCreateBot,
  listSlackBotSigningSecrets,
  listSlackBotsByTeamId,
  persistSlackAppIdIfMissing,
} from "@/lib/platform/bot";

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
  // Slack's url_verification body has NO `team_id`, so we cannot look
  // up a single bot to verify against. Try in order:
  //   1. The legacy global env-var fallback (SLACK_SIGNING_SECRET) —
  //      kept for the single-bot deploy + dual-accept rotation case.
  //   2. Every enabled Slack bot's per-bot signing secret. The user has
  //      already saved this app's credentials in admin BEFORE pasting
  //      the URL into Event Subscriptions; the matching secret is in
  //      the DB already. Brute force is bounded by the bot cache cap.
  //
  // Only echoes the `challenge` on a verified signature, and ONLY for
  // body type === "url_verification" — never for real events. Same
  // SEC-R2-001 posture as the prior global-fallback-only path.
  const env = getEnv();
  const candidates: Array<{ source: string; secret: string }> = [];
  if (env.SLACK_SIGNING_SECRET) {
    candidates.push({ source: "global_fallback", secret: env.SLACK_SIGNING_SECRET });
  }
  if (env.SLACK_SIGNING_SECRET_PREVIOUS) {
    candidates.push({ source: "global_fallback_previous", secret: env.SLACK_SIGNING_SECRET_PREVIOUS });
  }
  try {
    const perBot = await listSlackBotSigningSecrets();
    for (const b of perBot) {
      candidates.push({ source: `agent:${b.agentId}`, secret: b.signingSecret });
    }
  } catch (err) {
    logger.warn("slack-webhook: listSlackBotSigningSecrets failed (challenge handshake)", {
      error: err instanceof Error ? err.message : String(err),
    });
  }

  if (candidates.length === 0) return unhandledResponse();

  let matchedSource: string | null = null;
  for (const c of candidates) {
    if (await verifySlackV0(rawBody, ts, sigHeader, c.secret)) {
      matchedSource = c.source;
      break;
    }
  }

  if (!matchedSource) {
    // List per-candidate secret_head/tail so the operator can see at a
    // glance whether their newly-saved bot's secret made it into the
    // candidate list AND whether the head/tail matches what's visible
    // in the Slack app's Basic Info → Signing Secret. Common failure
    // modes:
    //   - The new bot row isn't in the candidates → save didn't persist
    //     (UI/admin bug) or the row is `enabled=false`.
    //   - The new bot row IS in the candidates but secret_head/tail
    //     don't match Slack's UI value → wrong value pasted.
    logger.warn("slack-webhook: url_verification signature did not match any registered secret", {
      candidates_tried: candidates.length,
      candidates: candidates.map((c) => ({
        source: c.source,
        secret_len: c.secret.length,
        secret_head: c.secret.slice(0, 4),
        secret_tail: c.secret.slice(-4),
      })),
    });
    return unhandledResponse();
  }

  let parsed: SlackEventBody;
  try {
    parsed = JSON.parse(rawBody) as SlackEventBody;
  } catch {
    return unhandledResponse();
  }
  if (parsed.type === "url_verification" && typeof parsed.challenge === "string") {
    logger.info("slack-webhook: url_verification accepted", { source: matchedSource });
    return new Response(parsed.challenge, {
      status: 200,
      headers: { "Content-Type": "text/plain" },
    });
  }
  return unhandledResponse();
}

export const POST = withErrorHandler(async (req: NextRequest) => {
  const rawBody = await req.text();

  // 1. Timestamp skew (fast, sync). Reject obviously bad / replay
  //    requests synchronously so an attacker can't burn after()
  //    capacity by spraying garbage.
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

  // 2. url_verification short-circuit (sync). Slack's handshake body has
  //    no `team_id`, and the response IS the challenge — must be the
  //    response body, can't defer.
  const sigHeader = req.headers.get("x-slack-signature");
  const bodyPrefix = rawBody.length > 4096 ? rawBody.slice(0, 4096) : rawBody;
  if (/"type"\s*:\s*"url_verification"/.test(bodyPrefix)) {
    return await maybeHandleFirstTimeChallenge(rawBody, ts, sigHeader);
  }

  // 3. Extract team_id (fast, sync). Bounded prefix prevents megabyte
  //    JSON DoS on unauthenticated input.
  const teamId = extractTeamId(rawBody);
  if (!teamId) {
    return new Response(JSON.stringify({ error: "missing_team_id" }), {
      status: 400,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 4. Defer everything heavy — bot load + decrypt + HMAC verify + Chat
  //    SDK dispatch. The 200 ack races back to Slack so we never miss
  //    the 3-second window. Bad-sig events still get a 200, but the
  //    deferred verify drops them silently — same end state as the
  //    prior sync "200 unhandled" path that closed the team_id oracle.
  const reqUrl = req.url;
  const reqMethod = req.method;
  const reqHeaders = new Headers(req.headers);
  after(async () => {
    // Multi-bot per workspace: extract `api_app_id` from the body
    // (untrusted — used only for lookup; the signature verify below is
    // the authority) and try the surgical (team_id, app_id) lookup
    // first. If a single row matches and its secret verifies, no
    // enumeration needed.
    //
    // Fall back to enumerate-all-bots-for-team only when:
    //   - the body has no api_app_id (defensive; real events always
    //     include it, but synthetic / replay traffic might not), OR
    //   - the surgical lookup found nothing (this row's app_id hasn't
    //     been persisted yet — first webhook after install, or an
    //     older bot row from before this migration).
    //
    // After a verifying match, write `app_id` back into
    // `platform_identity` so the next event takes the surgical path.
    let apiAppIdFromBody: string | null = null;
    try {
      const peek = JSON.parse(rawBody) as { api_app_id?: unknown };
      if (typeof peek.api_app_id === "string" && peek.api_app_id.length > 0) {
        apiAppIdFromBody = peek.api_app_id;
      }
    } catch {
      // Untrusted body parse failure — fine, we'll use enumerate path.
    }

    let matched: Awaited<ReturnType<typeof findSlackBotByTeamAndApp>> = null;
    let usedSurgicalPath = false;

    if (apiAppIdFromBody) {
      try {
        const surgical = await findSlackBotByTeamAndApp(teamId, apiAppIdFromBody);
        if (surgical && (await verifySlackV0(rawBody, ts, sigHeader, surgical.signingSecret))) {
          matched = surgical;
          usedSurgicalPath = true;
        }
      } catch (err) {
        logger.warn("slack-webhook (deferred): surgical lookup threw — falling back", {
          team_id: teamId,
          api_app_id: apiAppIdFromBody,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    let candidates: Awaited<ReturnType<typeof listSlackBotsByTeamId>> = [];
    if (!matched) {
      try {
        candidates = await listSlackBotsByTeamId(teamId);
      } catch (err) {
        logger.error("slack-webhook (deferred): listSlackBotsByTeamId failed", {
          team_id: teamId,
          error: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      // Unknown team_id: drop silently. Real events from unregistered
      // workspaces shouldn't trigger anything; preserves the oracle
      // closure (same observable behaviour as the registered-but-bad-
      // sig path below).
      if (candidates.length === 0) return;

      for (const c of candidates) {
        if (await verifySlackV0(rawBody, ts, sigHeader, c.signingSecret)) {
          matched = c;
          break;
        }
      }
    }

    if (!matched) {
      // Surgical lookup found nothing AND no candidate's secret
      // verified in the enumerate fallback. Log fingerprints to
      // diagnose without leaking full secrets/signatures.
      const sigMatch = sigHeader?.match(/^v0=([0-9a-f]+)$/i);
      const bodyHashHead = await (async () => {
        const h = await crypto.subtle.digest(
          "SHA-256",
          new TextEncoder().encode(rawBody.slice(0, 256)).buffer as ArrayBuffer,
        );
        return Array.from(new Uint8Array(h)).map((b) => b.toString(16).padStart(2, "0")).join("").slice(0, 16);
      })();
      logger.warn("slack-webhook (deferred): signature mismatch on all candidates — event dropped", {
        team_id: teamId,
        api_app_id: apiAppIdFromBody,
        candidate_count: candidates.length,
        candidates: candidates.map((c) => ({
          agent_id: c.agentId,
          secret_head: c.signingSecret.slice(0, 4),
          secret_tail: c.signingSecret.slice(-4),
        })),
        body_len: rawBody.length,
        body_head_hash: bodyHashHead,
        ts_header: ts,
        sig_header_present: sigHeader !== null,
        sig_header_format_ok: !!sigMatch,
      });
      return;
    }

    let parsed: SlackEventBody;
    try {
      parsed = JSON.parse(rawBody) as SlackEventBody;
    } catch {
      return;
    }
    // url_verification was already handled in the sync path above; if
    // we somehow reach here, just drop.
    if (parsed.type === "url_verification") return;

    // Backfill: if we verified via the enumerate fallback AND the body
    // had an api_app_id AND the matched row doesn't already have one
    // stored, write it back so the next event takes the surgical
    // path. Best-effort — failure here just means the next event also
    // enumerates (acceptable).
    if (!usedSurgicalPath && apiAppIdFromBody) {
      const existingAppId = matched.platformIdentity?.app_id;
      if (typeof existingAppId !== "string" || existingAppId.length === 0) {
        await persistSlackAppIdIfMissing(matched.tenantId, matched.agentId, apiAppIdFromBody);
        logger.info("slack-webhook (deferred): persisted app_id for surgical lookup", {
          team_id: teamId,
          api_app_id: apiAppIdFromBody,
          agent_id: matched.agentId,
        });
      }
    }

    // Resolve the cached Chat instance for the matched bot. Uses the
    // shared `getOrCreateBot` so concurrent webhooks for the same agent
    // share one in-memory Chat per (platform, agentId).
    let targetBot: Awaited<ReturnType<typeof getOrCreateBot>>;
    try {
      targetBot = await getOrCreateBot({
        tenantId: matched.tenantId,
        agentId: matched.agentId,
        platform: "slack",
        credentialsVersion: matched.credentialsVersion,
        platformIdentity: matched.platformIdentity,
      });
    } catch (err) {
      logger.error("slack-webhook (deferred): getOrCreateBot failed", {
        agent_id: matched.agentId,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    try {
      await targetBot.bot.initialize();
      const newReq = new NextRequest(reqUrl, {
        method: reqMethod,
        headers: reqHeaders,
        body: rawBody,
      });
      await targetBot.bot.webhooks.slack(newReq, {
        waitUntil: (p) => after(() => p),
      });
    } catch (err) {
      logger.error("slack-webhook (deferred): SDK dispatch failed", {
        agent_id: targetBot.agentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  // 5. Immediate ack — Slack only needs the 200 to suppress retries.
  return new Response(JSON.stringify({ status: "queued" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
});
