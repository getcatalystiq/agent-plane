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
import { resolveCachedBot } from "@/lib/platform/bot";
import type { ChatPlatform } from "@/lib/platform/operations";
import type { TenantId, AgentId } from "@/lib/types";

interface ChannelPostingAdapter {
  postChannelMessage?: (channelId: string, message: string) => Promise<unknown>;
  // Slack-specific. Some adapter versions expose only postChannelMessage,
  // others have postMessage as a fallback (treats the channelId like a
  // thread root). We try the channel-specific call first and fall back.
  postMessage?: (threadId: string, message: string) => Promise<unknown>;
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

  try {
    if (typeof adapter.postChannelMessage === "function") {
      await adapter.postChannelMessage(args.targetChannel, args.text);
    } else if (typeof adapter.postMessage === "function") {
      // Some Chat SDK versions don't expose a separate channel
      // helper. postMessage with a channel id (no thread_ts) posts
      // a top-level channel message in Slack and a channel message
      // in Discord — same observable behaviour.
      await adapter.postMessage(args.targetChannel, args.text);
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
