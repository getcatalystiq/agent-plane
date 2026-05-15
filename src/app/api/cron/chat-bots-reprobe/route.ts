/**
 * Daily re-probe of chat-platform bot workspaces.
 *
 * Plan reference: post-connect re-probe follow-up for review run
 * 20260506-221948-2402b0ed P0 #6 (R19 install-then-grow).
 *
 * R19's connect-time gate refuses workspaces above the threshold. But
 * a workspace can grow past the threshold AFTER connect — operator
 * adds the bot to a new server, members are invited en masse, etc.
 * This cron runs daily, re-probes each enabled bot's workspace, and
 * marks the bot disabled (via markBotError) when the count crosses
 * the threshold. Operator must explicitly re-enable from the admin UI
 * after auditing.
 *
 * Failures don't take the bot down — probe-failure is logged and
 * skipped (transient Discord/Slack outages happen). The bot stays
 * enabled until the next probe confirms.
 */

import { type NextRequest } from "next/server";
import { z } from "zod";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { verifyCronSecret } from "@/lib/cron-auth";
import { logger } from "@/lib/logger";
import { query, withTenantTransaction } from "@/db";
import {
  getDecryptedCredentials,
  markBotError,
  type ChatPlatform,
  type DiscordCredentials,
  type SlackCredentials,
} from "@/lib/platform/operations";
import { probeWorkspaceSize } from "@/lib/platform/workspace-probe";
import type { TenantId, AgentId } from "@/lib/types";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

const BotRow = z.object({
  tenant_id: z.string().uuid(),
  agent_id: z.string().uuid(),
  platform: z.enum(["discord", "slack"]),
  platform_identity: z.unknown().transform((v) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {})),
});

const TenantThreshold = z.object({
  max_trusted_members: z.number().int().positive(),
});

export const GET = withErrorHandler(async (request: NextRequest) => {
  verifyCronSecret(request);

  // System-scope SELECT — no credentials_enc, only what's needed to
  // re-probe. Mirrors refreshBots' isolation.
  const bots = await query(
    BotRow,
    `SELECT tenant_id, agent_id, platform, platform_identity
     FROM platform_bot_configs
     WHERE enabled = true
     ORDER BY created_at ASC`,
  );

  let probedCount = 0;
  let disabledCount = 0;
  let probeFailures = 0;

  // REL-R2-04 fix (review run 20260506-232400-round2): batch in
  // parallel groups of 10 so 50+ bots fit comfortably under the 300s
  // maxDuration ceiling. Each batch is bounded by the slowest probe
  // in the group (~5s timeout), so 100 bots ≈ 50s wall-clock instead
  // of 500s serial.
  const BATCH_SIZE = 10;
  for (let i = 0; i < bots.length; i += BATCH_SIZE) {
    const batch = bots.slice(i, i + BATCH_SIZE);
    await Promise.allSettled(batch.map(processOneBot));
  }

  async function processOneBot(bot: typeof bots[number]): Promise<void> {
    try {
      const tenantId = bot.tenant_id as TenantId;
      const agentId = bot.agent_id as AgentId;
      const platform: ChatPlatform = bot.platform;

      const creds = await getDecryptedCredentials(tenantId, agentId, platform);
      if (!creds) return;

      // Use the same identity object stored at connect time. Probe
      // doesn't read from it — it's a forward-compat hook.
      const probe = await probeWorkspaceSize(
        creds as DiscordCredentials | SlackCredentials,
        bot.platform_identity,
      );
      probedCount += 1;

      if (!probe.probed) {
        // Transient probe failure — log and skip; bot remains enabled.
        // Daily cadence means a single missed probe is recoverable on
        // the next tick.
        probeFailures += 1;
        logger.warn("chat-bots-reprobe: probe failed (transient)", {
          tenant_id: tenantId,
          agent_id: agentId,
          platform,
          reason: probe.reason,
        });
        return;
      }

      // Read the per-tenant threshold (default 100 from the migration).
      const threshold = await withTenantTransaction(tenantId, async (tx) => {
        const row = await tx.queryOne(
          TenantThreshold,
          "SELECT max_trusted_members FROM tenants WHERE id = $1",
          [tenantId],
        );
        return row?.max_trusted_members ?? 100;
      });

      if (probe.memberCount > threshold) {
        // Disable the bot and record the reason. Operator must re-enable
        // from the admin UI after auditing the workspace.
        await withTenantTransaction(tenantId, async (tx) => {
          await tx.execute(
            `UPDATE platform_bot_configs
             SET enabled = false, updated_at = now()
             WHERE tenant_id = $1 AND agent_id = $2 AND platform = $3`,
            [tenantId, agentId, platform],
          );
        });
        await markBotError(
          tenantId,
          agentId,
          platform,
          `Workspace grew to ${probe.memberCount} members (threshold ${threshold}). Disabled by re-probe; re-enable from the admin UI after auditing.`,
        );
        disabledCount += 1;
        logger.warn("chat-bots-reprobe: bot disabled (workspace grew past threshold)", {
          tenant_id: tenantId,
          agent_id: agentId,
          platform,
          member_count: probe.memberCount,
          threshold,
        });
      }
    } catch (err) {
      probeFailures += 1;
      logger.error("chat-bots-reprobe: bot probe errored", {
        tenant_id: bot.tenant_id,
        agent_id: bot.agent_id,
        platform: bot.platform,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return jsonResponse({
    status: "ok",
    bots_total: bots.length,
    probed: probedCount,
    disabled: disabledCount,
    probe_failures: probeFailures,
  });
});
