/**
 * Platform Bot Registry — module-scope cache of Chat SDK instances per agent.
 *
 * Plan reference: U3 in
 * docs/plans/2026-05-06-001-feat-chat-platform-bots-discord-slack-plan.md
 *
 * One Chat instance per (platform, agent) pair, cached LRU-by-insertion at
 * 200 entries. credentialsVersion changes evict the cached instance on next
 * refresh tick. The cache survives warm Vercel function invocations.
 *
 * `refreshBots()` runs system-scope (RLS bypass) so the gateway cron can
 * load every enabled bot across all tenants in one pass. The query
 * deliberately omits `credentials_enc` from the SELECT — decryption happens
 * lazily per-bot via `getDecryptedCredentials`, so a SQL change adding the
 * column to refreshBots' SELECT would not silently expose tokens.
 *
 * `findBotByToken` (Discord) and `findBotByTeamId` (Slack) are O(N) over
 * the 200-entry cap — fine.
 */

import { Chat } from "chat";
import { createDiscordAdapter, type DiscordAdapter } from "@chat-adapter/discord";
import { createSlackAdapter, type SlackAdapter } from "@chat-adapter/slack";
import { createRedisState } from "@chat-adapter/state-redis";
import { z } from "zod";
import { query } from "@/db";
import { getEnv } from "@/lib/env";
import { logger } from "@/lib/logger";
import {
  getDecryptedCredentials,
  type ChatPlatform,
  type DiscordCredentials,
  type SlackCredentials,
} from "@/lib/platform/operations";
import {
  registerDiscordHandlers,
  patchDiscord160004Idempotency,
} from "@/lib/platform/adapters/discord";
import { registerSlackHandlers } from "@/lib/platform/adapters/slack";
import type { TenantId, AgentId } from "@/lib/types";

// ---------------------------------------------------------------------------
// Cache shape
// ---------------------------------------------------------------------------

export interface CachedBot {
  bot: Chat;
  platform: ChatPlatform;
  adapter: DiscordAdapter | SlackAdapter;
  agentId: AgentId;
  tenantId: TenantId;
  credentialsVersion: number;
  /** Raw bot token — used by findBotByToken on the Discord webhook routing path. */
  botToken: string;
  /** Slack-only — populated from validateCredentials response on connect. */
  slackTeamId: string | null;
  /** Discord-only — populated from validateCredentials response on connect.
   *  Used by the @mention filter to drop non-mention MESSAGE_CREATE events. */
  botUserId: string | null;
}

const MAX_BOT_CACHE_ENTRIES = 200;

// Map preserves insertion order; oldest entry evicts on overflow.
const botCache = new Map<string, CachedBot>();

function botKey(platform: ChatPlatform, agentId: AgentId): string {
  return `${platform}:${agentId}`;
}

function rememberBot(key: string, entry: CachedBot): void {
  botCache.set(key, entry);
  while (botCache.size > MAX_BOT_CACHE_ENTRIES) {
    const oldest = botCache.keys().next();
    if (oldest.done) break;
    botCache.delete(oldest.value);
  }
}

// ---------------------------------------------------------------------------
// State backend (shared across all bots in this process)
// ---------------------------------------------------------------------------

let sharedState: ReturnType<typeof createRedisState> | null = null;

function getSharedState(): ReturnType<typeof createRedisState> {
  if (!sharedState) {
    const env = getEnv();
    if (!env.REDIS_URL) {
      // Boot-fail-closed: chat ingress must not silently fall back to an
      // in-memory state store; cross-instance correctness depends on Redis.
      throw new Error(
        "Chat-platform bots require REDIS_URL env var (rediss://... native Redis endpoint). " +
          "Provision Upstash Redis via Vercel Marketplace.",
      );
    }
    sharedState = createRedisState({ url: env.REDIS_URL });
  }
  return sharedState;
}

// ---------------------------------------------------------------------------
// getOrCreateBot
// ---------------------------------------------------------------------------

interface BuildBotInput {
  tenantId: TenantId;
  agentId: AgentId;
  platform: ChatPlatform;
  credentialsVersion: number;
  platformIdentity: Record<string, unknown>;
}

async function buildCachedBot(input: BuildBotInput): Promise<CachedBot> {
  const credentials = await getDecryptedCredentials(input.tenantId, input.agentId, input.platform);
  if (!credentials) {
    throw new Error(`Bot config for agent ${input.agentId} (${input.platform}) is disabled or missing.`);
  }

  if (credentials.platform === "discord" && input.platform === "discord") {
    const discordCreds = credentials as DiscordCredentials;
    const adapter = createDiscordAdapter({
      botToken: discordCreds.botToken,
      publicKey: discordCreds.publicKey,
      applicationId: discordCreds.applicationId,
    });
    patchDiscord160004Idempotency(adapter);
    const bot = new Chat({
      userName: input.agentId,
      adapters: { discord: adapter },
      state: getSharedState(),
    });
    const botUserId = (input.platformIdentity.bot_user_id as string | undefined) ?? null;
    registerDiscordHandlers(bot, {
      tenantId: input.tenantId,
      agentId: input.agentId,
      botUserId,
    });
    return {
      bot,
      platform: "discord",
      adapter,
      agentId: input.agentId,
      tenantId: input.tenantId,
      credentialsVersion: input.credentialsVersion,
      botToken: discordCreds.botToken,
      slackTeamId: null,
      botUserId,
    };
  }

  if (credentials.platform === "slack" && input.platform === "slack") {
    const slackCreds = credentials as SlackCredentials;
    const adapter = createSlackAdapter({
      botToken: slackCreds.botToken,
      signingSecret: slackCreds.signingSecret,
    });
    const bot = new Chat({
      userName: input.agentId,
      adapters: { slack: adapter },
      state: getSharedState(),
    });
    const teamId = (input.platformIdentity.team_id as string | undefined) ?? null;
    const botUserId = (input.platformIdentity.bot_user_id as string | undefined) ?? null;
    registerSlackHandlers(bot, {
      tenantId: input.tenantId,
      agentId: input.agentId,
      botUserId,
    });
    return {
      bot,
      platform: "slack",
      adapter,
      agentId: input.agentId,
      tenantId: input.tenantId,
      credentialsVersion: input.credentialsVersion,
      botToken: slackCreds.botToken,
      slackTeamId: teamId,
      botUserId,
    };
  }

  throw new Error(`Platform mismatch: row says ${input.platform}, credentials say ${credentials.platform}`);
}

export async function getOrCreateBot(input: BuildBotInput): Promise<CachedBot> {
  const key = botKey(input.platform, input.agentId);
  const cached = botCache.get(key);
  if (cached && cached.credentialsVersion === input.credentialsVersion) {
    return cached;
  }
  if (cached) botCache.delete(key);
  const built = await buildCachedBot(input);
  rememberBot(key, built);
  return built;
}

// ---------------------------------------------------------------------------
// Lookup helpers (called by gateway/webhook routes)
// ---------------------------------------------------------------------------

export function findBotByToken(token: string): CachedBot | null {
  for (const entry of botCache.values()) {
    if (entry.platform === "discord" && entry.botToken === token) return entry;
  }
  return null;
}

export function findBotByTeamId(teamId: string): CachedBot | null {
  for (const entry of botCache.values()) {
    if (entry.platform === "slack" && entry.slackTeamId === teamId) return entry;
  }
  return null;
}

/**
 * Slack-webhook lazy loader. The Slack webhook serverless function is a
 * different Vercel instance from the Discord gateway cron that calls
 * refreshBots() — its in-process botCache is empty until we populate it
 * here. On cache miss, query platform_bot_configs by
 * platform_identity->>'team_id' and lazy-build the Chat instance via
 * getOrCreateBot (which decrypts credentials lazily). System-scope query
 * mirrors refreshBots — credentials_enc is NEVER part of the SELECT, so
 * a regression that re-adds it would fail Zod parsing rather than
 * silently widening the audit surface.
 */
export async function findOrLoadSlackBotByTeamId(teamId: string): Promise<CachedBot | null> {
  const cached = findBotByTeamId(teamId);
  if (cached) return cached;

  const rows = await query(
    BotRegistryRow,
    `SELECT id, tenant_id, agent_id, platform, credentials_version, enabled, platform_identity
       FROM platform_bot_configs
      WHERE enabled = true
        AND platform = 'slack'
        AND platform_identity->>'team_id' = $1
      LIMIT 1`,
    [teamId],
  );
  if (rows.length === 0) return null;

  const row = rows[0];
  try {
    return await getOrCreateBot({
      tenantId: row.tenant_id as TenantId,
      agentId: row.agent_id as AgentId,
      platform: row.platform,
      credentialsVersion: row.credentials_version,
      platformIdentity: row.platform_identity,
    });
  } catch (err) {
    logger.error("findOrLoadSlackBotByTeamId: failed to build bot", {
      team_id: teamId,
      agent_id: row.agent_id,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

export function getAllBots(): Map<string, CachedBot> {
  return botCache;
}

export function getBot(platform: ChatPlatform, agentId: AgentId): CachedBot | null {
  return botCache.get(botKey(platform, agentId)) ?? null;
}

// ---------------------------------------------------------------------------
// refreshBots — system-scope query (RLS bypass), excludes credentials_enc
// ---------------------------------------------------------------------------

const BotRegistryRow = z.object({
  id: z.string().uuid(),
  tenant_id: z.string().uuid(),
  agent_id: z.string().uuid(),
  platform: z.enum(["discord", "slack"]),
  credentials_version: z.number().int(),
  enabled: z.boolean(),
  platform_identity: z.unknown().transform((v) => (v && typeof v === "object" ? (v as Record<string, unknown>) : {})),
});

/**
 * Reload the cache from the DB. Called by the gateway cron at the top of
 * each tick. This is the only RLS-bypass path in the platform module — it
 * deliberately omits `credentials_enc` from the SELECT so a regression
 * adding it back would surface as a build / type error rather than silently
 * exposing tokens across the cache.
 */
export async function refreshBots(): Promise<void> {
  const rows = await query(
    BotRegistryRow,
    `SELECT id, tenant_id, agent_id, platform, credentials_version, enabled, platform_identity
     FROM platform_bot_configs
     WHERE enabled = true
     ORDER BY created_at ASC`,
  );

  const seenKeys = new Set<string>();

  for (const row of rows) {
    const key = botKey(row.platform, row.agent_id as AgentId);
    seenKeys.add(key);
    const cached = botCache.get(key);
    if (cached && cached.credentialsVersion === row.credentials_version) continue;

    try {
      await getOrCreateBot({
        tenantId: row.tenant_id as TenantId,
        agentId: row.agent_id as AgentId,
        platform: row.platform,
        credentialsVersion: row.credentials_version,
        platformIdentity: row.platform_identity,
      });
    } catch (err) {
      logger.error("refreshBots: failed to build bot", {
        agent_id: row.agent_id,
        platform: row.platform,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // Evict bots no longer in the active set.
  for (const key of botCache.keys()) {
    if (!seenKeys.has(key)) botCache.delete(key);
  }

  logger.info("refreshBots: cache refreshed", { active_count: botCache.size });
}

/**
 * Force-refresh the cache. Called by the admin route after a successful
 * upsert / disable / rotate so credential changes propagate in <100ms
 * instead of waiting for the next 9-minute cron tick.
 */
export async function forceRefresh(): Promise<void> {
  await refreshBots();
}

