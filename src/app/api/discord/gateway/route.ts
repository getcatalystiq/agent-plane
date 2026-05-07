/**
 * Discord Gateway cron — keeps a Discord WebSocket alive ~750s and forwards
 * MESSAGE_CREATE events to /api/webhooks/discord with an HMAC signature.
 *
 * Plan reference: U4 in
 * docs/plans/2026-05-06-001-feat-chat-platform-bots-discord-slack-plan.md
 *
 * Schedule: every 9 min cron (1m overlap window with the next tick).
 * maxDuration: 800
 *
 * Each forwarded event carries:
 *   - X-Gateway-Signature: v1=<hex>  HMAC-SHA-256 over the body using
 *                                    GATEWAY_FORWARDER_SECRET (or PREVIOUS).
 *   - x-discord-gateway-token: <bot token>  routing hint only; the webhook
 *                                           receive verifies signature first
 *                                           BEFORE consulting findBotByToken.
 */

import { after, NextResponse, type NextRequest } from "next/server";
import { verifyCronSecret } from "@/lib/cron-auth";
import { logger } from "@/lib/logger";
import { getEnv } from "@/lib/env";
import { refreshBots, getAllBots, type CachedBot } from "@/lib/platform/bot";

export const dynamic = "force-dynamic";
export const maxDuration = 800;

const LISTENER_DURATION_MS = 750_000;

export async function GET(request: NextRequest) {
  try {
    verifyCronSecret(request);
  } catch (err) {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }

  try {
    await refreshBots();
  } catch (err) {
    logger.error("discord-gateway: refreshBots failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: "refresh_failed" }, { status: 500 });
  }

  const bots = [...getAllBots().values()].filter((b) => b.platform === "discord");
  if (bots.length === 0) {
    return NextResponse.json({ status: "ok", bots: 0, message: "No enabled Discord bots" });
  }

  const env = getEnv();
  if (!env.GATEWAY_FORWARDER_SECRET) {
    logger.error("discord-gateway: GATEWAY_FORWARDER_SECRET not set; refusing to start listener");
    return NextResponse.json(
      { error: "forwarder_secret_missing" },
      { status: 503 },
    );
  }

  const baseUrl = (env.NEXT_PUBLIC_APP_URL ?? "").trim();
  if (!baseUrl) {
    logger.error("discord-gateway: NEXT_PUBLIC_APP_URL not set; refusing to start listener");
    return NextResponse.json({ error: "base_url_missing" }, { status: 503 });
  }
  const webhookUrl = `${baseUrl}/api/webhooks/discord`;

  // Keep listeners alive for the full function duration.
  after(async () => {
    const abortController = new AbortController();
    const cleanup = setTimeout(() => abortController.abort(), LISTENER_DURATION_MS);

    try {
      const startPromises = bots.map(async (cached: CachedBot) => {
        try {
          await cached.bot.initialize();
          const adapter = cached.adapter as {
            startGatewayListener: (
              opts: { waitUntil: (p: Promise<unknown>) => void },
              durationMs: number,
              abortSignal: AbortSignal,
              webhookUrl: string,
            ) => Promise<unknown>;
          };
          const listenerPromises: Promise<unknown>[] = [];
          await adapter.startGatewayListener(
            { waitUntil: (p) => listenerPromises.push(p) },
            LISTENER_DURATION_MS,
            abortController.signal,
            webhookUrl,
          );
          await Promise.all(listenerPromises);
        } catch (err) {
          if ((err as Error).name !== "AbortError") {
            logger.error("discord-gateway: listener failed", {
              agent_id: cached.agentId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        }
      });
      await Promise.allSettled(startPromises);
    } finally {
      clearTimeout(cleanup);
    }
  });

  return NextResponse.json({
    status: "ok",
    bots: bots.length,
    message: `Gateway listeners starting for ${bots.length} bot(s)`,
  });
}
