/**
 * Schedule-to-channel delivery helper.
 *
 * Background. Migration 041 added `target_platform` + `target_channel`
 * to the `schedules` table so a scheduled run can deliver its agent
 * reply to a Slack or Discord channel. The delivery uses the same
 * `@chat-adapter/*` Chat SDK adapter the chat workflow uses for its
 * @mention path (`postOrEdit` in `src/lib/platform/callback.ts`),
 * just routed at a channel ID instead of a thread ID.
 *
 * Why a helper file. The scheduled-runs cron has TWO dispatch paths
 * (legacy `dispatchSessionMessage` drain + WDK `runViaWorkflow`) and
 * both need to deliver to a channel when the schedule has the target
 * fields set. Inlining the post call would duplicate the
 * resolveCachedBot + adapter-shape lookup. Encapsulated here.
 *
 * Best-effort. Delivery failures (missing scope, channel not found,
 * bot not a member of a private channel, etc.) log a warn and don't
 * fail the cron — the run still succeeds; the operator just doesn't
 * see the reply where they configured it. Same posture as the chat
 * workflow's `postOrEdit` failures (PR #38 + downstream).
 */

import { logger } from "@/lib/logger";
import { getOrCreateBot, type CachedBot } from "@/lib/platform/bot";
import { getBotConfig, type ChatPlatform } from "@/lib/platform/operations";
import type { TenantId, AgentId } from "@/lib/types";

// Inlined `resolveCachedBot` — chat-dispatch-workflow.ts has the same
// helper as a module-private function. Inlining here avoids exporting
// it from a workflow file (which has sandbox constraints). Future
// cleanup can hoist the helper into bot.ts so both files share one
// definition.
async function resolveCachedBot(
  tenantId: TenantId,
  agentId: AgentId,
  platform: ChatPlatform,
): Promise<CachedBot | null> {
  const config = await getBotConfig(tenantId, agentId, platform);
  if (!config) return null;
  return getOrCreateBot({
    tenantId,
    agentId,
    platform,
    credentialsVersion: config.credentials_version,
    platformIdentity: config.platform_identity,
  });
}

interface ChannelPostingAdapter {
  postChannelMessage?: (channelId: string, message: string) => Promise<unknown>;
  // Slack-specific. Some adapter versions expose only postChannelMessage,
  // others have postMessage as a fallback (treats the channelId like a
  // thread root). We try the channel-specific call first and fall back.
  postMessage?: (threadId: string, message: string) => Promise<unknown>;
}

/**
 * Extract the agent's final reply text from a completed message's
 * transcript blob. The blob is NDJSON, written by the runner. We scan
 * for:
 *   1. The terminal `result` event's `result` field (Claude Agent SDK
 *      sets this to the assistant's final text).
 *   2. An `assistant` event's `content[].text` (Vercel AI runner format
 *      and a fallback for runs where `result.result` is empty).
 *
 * Returns null when the transcript has no recoverable reply text — the
 * caller should skip channel delivery (nothing useful to post).
 */
export async function extractAgentReplyText(
  transcriptBlobUrl: string,
): Promise<string | null> {
  let body: string;
  try {
    const res = await fetch(transcriptBlobUrl);
    if (!res.ok) return null;
    body = await res.text();
  } catch {
    return null;
  }

  const lines = body.split("\n").filter((l) => l.trim().length > 0);

  // Pass 1: scan from the end for the terminal `result` event.
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const evt = JSON.parse(lines[i]) as { type?: string; result?: unknown };
      if (evt.type === "result" && typeof evt.result === "string" && evt.result.length > 0) {
        return evt.result;
      }
    } catch {
      // skip malformed lines
    }
  }

  // Pass 2: fall back to the LAST assistant event with text content.
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const evt = JSON.parse(lines[i]) as {
        type?: string;
        message?: { content?: Array<{ type?: string; text?: string }> };
      };
      if (evt.type === "assistant" && Array.isArray(evt.message?.content)) {
        const text = evt
          .message!.content!.filter((b) => b.type === "text" && typeof b.text === "string" && b.text.length > 0)
          .map((b) => b.text!)
          .join("\n");
        if (text.length > 0) return text;
      }
    } catch {
      // skip malformed lines
    }
  }

  return null;
}

export interface ScheduleDeliveryArgs {
  tenantId: TenantId;
  agentId: AgentId;
  scheduleId: string;
  targetPlatform: ChatPlatform;
  targetChannel: string;
  text: string;
}

/**
 * Post the agent's reply to the schedule's target channel via the
 * cached Chat SDK adapter. Returns true on success, false on any
 * non-fatal failure (logged as a warn).
 */
export async function deliverScheduleReplyToChannel(
  args: ScheduleDeliveryArgs,
): Promise<boolean> {
  if (args.text.length === 0) {
    logger.warn("scheduled-delivery: skipping empty reply", {
      tenant_id: args.tenantId,
      agent_id: args.agentId,
      schedule_id: args.scheduleId,
      target_platform: args.targetPlatform,
      target_channel: args.targetChannel,
    });
    return false;
  }

  let cached: Awaited<ReturnType<typeof resolveCachedBot>>;
  try {
    cached = await resolveCachedBot(args.tenantId, args.agentId, args.targetPlatform);
  } catch (err) {
    logger.warn("scheduled-delivery: bot lookup failed", {
      tenant_id: args.tenantId,
      agent_id: args.agentId,
      schedule_id: args.scheduleId,
      target_platform: args.targetPlatform,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
  if (!cached) {
    logger.warn("scheduled-delivery: no enabled bot for target platform", {
      tenant_id: args.tenantId,
      agent_id: args.agentId,
      schedule_id: args.scheduleId,
      target_platform: args.targetPlatform,
    });
    return false;
  }

  const adapter = cached.adapter as unknown as ChannelPostingAdapter;

  // Build the platform-specific threadId expected by the Chat SDK
  // adapter from the raw channel ID stored in the schedule. Without
  // this, the Slack adapter's `decodeThreadId` rejects the value with
  // "Invalid Slack channel ID: C…" because the user's saved value is
  // the bare channel ID (e.g. `C0ABCDEF12`) and the adapter expects
  // `slack:C0ABCDEF12` (2-part form, no thread_ts → posts to channel
  // root). The schedule editor's placeholder asks for raw IDs by
  // design — wrapping happens here, not in the user-facing UI.
  let threadId: string;
  if (args.targetPlatform === "slack") {
    threadId = `slack:${args.targetChannel}`;
  } else if (args.targetPlatform === "discord") {
    // Discord's decodeThreadId requires `discord:guildId:channelId`
    // (3 parts minimum). The schedule schema only stores
    // `target_channel`, not `target_guild_id`, so for now we accept
    // either a raw channel id (best-effort: derive guild via the
    // adapter's channel→guild lookup is not exposed) OR a pre-formed
    // `discord:guildId:channelId` string the user pasted directly.
    threadId = args.targetChannel.startsWith("discord:")
      ? args.targetChannel
      : args.targetChannel;
    if (!threadId.startsWith("discord:")) {
      logger.warn(
        "scheduled-delivery: Discord requires `discord:guildId:channelId` — bare channel id will likely fail",
        {
          tenant_id: args.tenantId,
          agent_id: args.agentId,
          schedule_id: args.scheduleId,
          target_channel: args.targetChannel,
        },
      );
    }
  } else {
    threadId = args.targetChannel;
  }

  try {
    if (typeof adapter.postChannelMessage === "function") {
      await adapter.postChannelMessage(threadId, args.text);
    } else if (typeof adapter.postMessage === "function") {
      // Some Chat SDK versions don't expose a separate channel
      // helper. postMessage with a channel id (no thread_ts) posts
      // a top-level channel message in Slack and a channel message
      // in Discord — same observable behaviour.
      await adapter.postMessage(threadId, args.text);
    } else {
      logger.warn("scheduled-delivery: adapter exposes neither postChannelMessage nor postMessage", {
        tenant_id: args.tenantId,
        agent_id: args.agentId,
        schedule_id: args.scheduleId,
        target_platform: args.targetPlatform,
      });
      return false;
    }
    logger.info("scheduled-delivery: posted to channel", {
      tenant_id: args.tenantId,
      agent_id: args.agentId,
      schedule_id: args.scheduleId,
      target_platform: args.targetPlatform,
      target_channel: args.targetChannel,
      text_length: args.text.length,
    });
    return true;
  } catch (err) {
    logger.warn("scheduled-delivery: post failed", {
      tenant_id: args.tenantId,
      agent_id: args.agentId,
      schedule_id: args.scheduleId,
      target_platform: args.targetPlatform,
      target_channel: args.targetChannel,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}
