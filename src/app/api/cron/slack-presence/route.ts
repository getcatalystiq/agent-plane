/**
 * Daily Slack presence cron.
 *
 * Slack defaults non-Socket-Mode bot users to "offline" unless the bot
 * actively declares its presence via `users.setPresence(presence: "auto")`.
 * Without this, the bot shows a grey dot in the workspace member list,
 * which users frequently misread as "the bot is broken / not running".
 *
 * Both the Chat SDK adapter (`@chat-adapter/slack`) and the previous
 * Composio path use the Web API + Events API model, so neither maintains
 * a continuous WebSocket. The fix is a daily ping to setPresence per
 * enabled Slack bot, sticky for ~24h on Slack's side. Scheduling daily
 * is conservative — Slack docs say setPresence sets "away or auto-mode";
 * once set to auto, the green dot stays as long as the workspace
 * considers the app "active" (recent API activity counts). Daily is
 * plenty of margin.
 *
 * Scope requirements:
 *   - The bot needs `users:write` scope (NOT `users:write.bot`, which
 *     was deprecated for new apps in 2020). If missing, Slack returns
 *     `not_authorized` / `missing_scope` and we log a warning per bot;
 *     other bots in the loop continue.
 *
 * No-Socket-Mode caveat: a bot connected via Socket Mode is auto-online
 * on connect — calling setPresence on those is harmless (Slack accepts
 * it) but redundant. We don't differentiate; the cron treats all enabled
 * Slack bots uniformly.
 *
 * System-scope query: iterates platform_bot_configs across ALL tenants
 * (RLS bypass — same pattern as refreshBots in src/lib/platform/bot.ts).
 * Decrypts each bot's bot token via getDecryptedCredentials and posts
 * directly to https://slack.com/api/users.setPresence — no Chat SDK
 * dependency since the adapter doesn't expose setPresence.
 *
 * Best-effort. A single bot's failure (network, missing scope, expired
 * token, disabled workspace) logs a warn and the loop continues.
 *
 * Paired with vercel.json cron entry:
 *   { "path": "/api/cron/slack-presence", "schedule": "0 8 * * *" }
 */

import { NextRequest } from "next/server";
import { z } from "zod";
import { query } from "@/db";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { verifyCronSecret } from "@/lib/cron-auth";
import { getDecryptedCredentials, type SlackCredentials } from "@/lib/platform/operations";
import { logger } from "@/lib/logger";
import type { TenantId, AgentId } from "@/lib/types";

export const dynamic = "force-dynamic";

const SLACK_SET_PRESENCE_URL = "https://slack.com/api/users.setPresence";

// platform_bot_configs row subset — credentials_enc deliberately omitted
// from the SELECT so a regression that includes it would fail Zod parsing
// instead of silently widening the audit surface (mirrors refreshBots).
const SlackBotIdentityRow = z.object({
  tenant_id: z.string().uuid(),
  agent_id: z.string().uuid(),
  platform: z.literal("slack"),
});

const SlackSetPresenceResponse = z.object({
  ok: z.boolean(),
  error: z.string().optional(),
});

export const POST = withErrorHandler(async (request: NextRequest) => {
  verifyCronSecret(request);
  return await refreshAllSlackBotPresence();
});

export const GET = withErrorHandler(async (request: NextRequest) => {
  // Vercel Cron POSTs by default, but the dashboard "Run Now" button
  // sends a GET. Same handler.
  verifyCronSecret(request);
  return await refreshAllSlackBotPresence();
});

async function refreshAllSlackBotPresence() {
  const rows = await query(
    SlackBotIdentityRow,
    `SELECT tenant_id, agent_id, platform
       FROM platform_bot_configs
      WHERE enabled = true AND platform = 'slack'`,
  );

  let okCount = 0;
  let errCount = 0;

  for (const row of rows) {
    const tenantId = row.tenant_id as TenantId;
    const agentId = row.agent_id as AgentId;

    let creds: SlackCredentials;
    try {
      const decrypted = await getDecryptedCredentials(tenantId, agentId, "slack");
      if (!decrypted) {
        // Bot was disabled between SELECT and decrypt. Skip silently.
        continue;
      }
      creds = decrypted as SlackCredentials;
    } catch (err) {
      logger.warn("slack-presence: decrypt failed", {
        tenant_id: tenantId,
        agent_id: agentId,
        error: err instanceof Error ? err.message : String(err),
      });
      errCount += 1;
      continue;
    }

    try {
      // POST `presence=auto` so Slack treats the bot as online.
      // The other valid value is `away` — we never want that here.
      const response = await fetch(SLACK_SET_PRESENCE_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/x-www-form-urlencoded",
          Authorization: `Bearer ${creds.botToken}`,
        },
        body: "presence=auto",
      });
      const json = SlackSetPresenceResponse.parse(await response.json());
      if (!json.ok) {
        // Common Slack errors here: `missing_scope` (user_scopes lacks
        // `users:write`), `token_revoked`, `account_inactive`. None of
        // these warrant aborting the loop — surface as a warn so
        // operators see them per-bot in observability.
        logger.warn("slack-presence: setPresence rejected", {
          tenant_id: tenantId,
          agent_id: agentId,
          slack_error: json.error,
        });
        errCount += 1;
        continue;
      }
      okCount += 1;
    } catch (err) {
      logger.warn("slack-presence: setPresence call failed", {
        tenant_id: tenantId,
        agent_id: agentId,
        error: err instanceof Error ? err.message : String(err),
      });
      errCount += 1;
    }
  }

  logger.info("slack-presence: cron complete", {
    bot_count: rows.length,
    ok_count: okCount,
    err_count: errCount,
  });

  return jsonResponse({
    status: "ok",
    bot_count: rows.length,
    ok_count: okCount,
    err_count: errCount,
  });
}
