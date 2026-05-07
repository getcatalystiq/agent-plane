/**
 * Discord webhook receive — verifies the gateway-forwarder HMAC, looks up
 * the right cached bot, and delegates to the Chat SDK's webhook handler
 * (which fires onNewMention / onSubscribedMessage post-@mention-filter).
 *
 * Plan reference: U4 in
 * docs/plans/2026-05-06-001-feat-chat-platform-bots-discord-slack-plan.md
 *
 * Verification order:
 *   1. Read raw body once.
 *   2. Verify X-Gateway-Signature against GATEWAY_FORWARDER_SECRET, then
 *      _PREVIOUS (if set), constant-time compare. Fail → 401.
 *   3. Pre-parse attachments → stash by msg id.
 *   4. Route via findBotByToken(x-discord-gateway-token).
 *   5. If no match: 200 unhandled (no leakage that the token is unknown).
 */

import { NextRequest, after } from "next/server";
import { logger } from "@/lib/logger";
import { getEnv } from "@/lib/env";
import { findBotByToken } from "@/lib/platform/bot";
import { stashInboundAttachments, normalizeDiscordAttachments } from "@/lib/platform/attachments";

export const dynamic = "force-dynamic";

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

function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

async function verifyForwarderSignature(rawBody: string, signatureHeader: string | null): Promise<boolean> {
  if (!signatureHeader) return false;
  const env = getEnv();
  if (!env.GATEWAY_FORWARDER_SECRET) return false;
  // Header format: "v1=<hex>".
  const match = signatureHeader.match(/^v1=([0-9a-f]+)$/i);
  if (!match) return false;
  const provided = match[1].toLowerCase();
  const candidates = [env.GATEWAY_FORWARDER_SECRET];
  if (env.GATEWAY_FORWARDER_SECRET_PREVIOUS) candidates.push(env.GATEWAY_FORWARDER_SECRET_PREVIOUS);
  for (const secret of candidates) {
    const expected = await hmacSha256Hex(secret, rawBody);
    if (constantTimeEqual(provided, expected)) return true;
  }
  return false;
}

interface InboundEvent {
  type?: string;
  t?: string;
  data?: { id?: string; attachments?: unknown[] };
  d?: { id?: string; attachments?: unknown[] };
  id?: string;
  attachments?: unknown[];
}

function extractInboundMessage(event: InboundEvent): { id?: string; attachments?: unknown[] } | null {
  if (!event) return null;
  const typeStr = typeof event.type === "string" ? event.type : "";
  if (typeStr === "MESSAGE_CREATE" || typeStr === "GATEWAY_MESSAGE_CREATE") {
    return event.data ?? null;
  }
  if (event.t === "MESSAGE_CREATE") {
    return event.d ?? null;
  }
  if (typeof event.id === "string" && Array.isArray(event.attachments)) {
    return { id: event.id, attachments: event.attachments };
  }
  return null;
}

function stashAttachmentsFromBody(bodyText: string): void {
  try {
    const event = JSON.parse(bodyText) as InboundEvent;
    const message = extractInboundMessage(event);
    if (!message?.id || !Array.isArray(message.attachments) || message.attachments.length === 0) return;
    const normalized = normalizeDiscordAttachments(
      message.attachments as Parameters<typeof normalizeDiscordAttachments>[0],
    );
    if (normalized.length > 0) stashInboundAttachments(String(message.id), normalized);
  } catch {
    // Body wasn't JSON or had a different shape — best-effort stash, the
    // text body still dispatches without attachments.
  }
}

export async function POST(req: NextRequest) {
  const rawBody = await req.text();

  // 1. Verify forwarder signature BEFORE consulting findBotByToken.
  const sig = req.headers.get("x-gateway-signature");
  const verified = await verifyForwarderSignature(rawBody, sig);
  if (!verified) {
    return new Response(JSON.stringify({ error: "invalid_signature" }), {
      status: 401,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 2. Pre-parse attachments before SDK strips them.
  stashAttachmentsFromBody(rawBody);

  // 3. Route via findBotByToken.
  const gatewayToken = req.headers.get("x-discord-gateway-token");
  const targetBot = gatewayToken ? findBotByToken(gatewayToken) : null;
  if (!targetBot) {
    // Unknown bot token (cache miss / cold start / disabled). Return 200
    // unhandled so a forwarder doesn't retry-storm; the next refreshBots
    // tick rebuilds the cache.
    return new Response(JSON.stringify({ status: "unhandled" }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }

  // 4. Reconstruct request and hand to SDK.
  const newReq = new NextRequest(req.url, {
    method: req.method,
    headers: req.headers,
    body: rawBody,
  });

  try {
    await targetBot.bot.initialize();
    const response = await targetBot.bot.webhooks.discord(newReq, {
      waitUntil: (p) => after(() => p),
    });
    if (response) return response;
  } catch (err) {
    logger.error("discord-webhook: SDK dispatch failed", {
      agent_id: targetBot.agentId,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  return new Response(JSON.stringify({ status: "ok" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}
