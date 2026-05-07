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
import { withErrorHandler } from "@/lib/api";
import { logger } from "@/lib/logger";
import { getEnv } from "@/lib/env";
import { getPool } from "@/db";
import { refreshBots, getAllBots, type CachedBot } from "@/lib/platform/bot";

export const dynamic = "force-dynamic";
export const maxDuration = 800;

// Listener targets 700s (well under maxDuration: 800), leaving a 100s
// buffer for in-flight forwarder POSTs and clean shutdown. Earlier rev
// used 750s which left only 50s — review run 20260506-221948-2402b0ed
// P2 #25.
const LISTENER_DURATION_MS = 700_000;

export const GET = withErrorHandler(async (request: NextRequest) => {
  verifyCronSecret(request);

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

  // A7 (review run 20260506-221948-2402b0ed P1 #15): cron tick is every
  // 9 min but listener targets ~750s (12.5 min), so every tick has a
  // 210s window where two cron invocations are both holding gateway
  // sessions for the same bot. Discord rejects duplicate sessions
  // (4004/4009). Resolution: per-bot pg_advisory_lock — second listener
  // tries to acquire and fails fast, exits cleanly.
  //
  // Lock key: hash of `discord-gateway:${agentId}` so it's stable across
  // Vercel function instances. We use SESSION-level locks held for the
  // duration of the listener via a dedicated client connection that we
  // release at the end of the listener window.
  after(async () => {
    const abortController = new AbortController();
    const cleanup = setTimeout(() => abortController.abort(), LISTENER_DURATION_MS);

    try {
      const startPromises = bots.map(async (cached: CachedBot) => {
        // REL-R2-06 fix (review run 20260506-232400-round2): pool.connect()
        // can throw on connection-pool exhaustion or transient Neon
        // unavailability. Earlier rev placed it BEFORE try/catch, so a
        // throw bubbled to Promise.allSettled and the bot silently had
        // no listener until the next 9-min cron tick. Move connect
        // inside try so the catch logs and the next tick retries.
        let lockClient: {
          query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
          release: () => void;
        } | null = null;
        try {
          lockClient = (await getPool().connect()) as unknown as {
            query: <T>(sql: string, params?: unknown[]) => Promise<{ rows: T[] }>;
            release: () => void;
          };
          // SEC-R2-003 fix (review run 20260506-232400-round2): use
          // hashtextextended (64-bit) instead of hashtext (32-bit) so
          // birthday collisions stay vanishingly unlikely at any tenant
          // scale. Seed with a fixed nonzero value so the hash is
          // deterministic across processes.
          const lockKeyResult = await lockClient.query<{ ok: boolean }>(
            "SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS ok",
            [`discord-gateway:${cached.agentId}`],
          );
          if (!lockKeyResult.rows[0]?.ok) {
            logger.info("discord-gateway: listener already running for bot; skipping", {
              agent_id: cached.agentId,
            });
            return;
          }

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
          // Round-3 review kt-002: narrow via instanceof rather than the
          // unchecked cast. AbortError is a DOMException-shaped Error in
          // Node 22+ and a plain Error subclass elsewhere; both reach
          // here as `instanceof Error` true with `name === "AbortError"`.
          if (!(err instanceof Error) || err.name !== "AbortError") {
            logger.error("discord-gateway: listener failed", {
              agent_id: cached.agentId,
              error: err instanceof Error ? err.message : String(err),
            });
          }
        } finally {
          // Release the advisory lock before returning the client. The
          // null-check guards the pool.connect() throw path where
          // lockClient was never assigned.
          if (lockClient) {
            try {
              await lockClient.query("SELECT pg_advisory_unlock(hashtextextended($1, 0))", [
                `discord-gateway:${cached.agentId}`,
              ]);
            } catch {
              // Lock auto-releases on connection close; ignore.
            }
            lockClient.release();
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
});
