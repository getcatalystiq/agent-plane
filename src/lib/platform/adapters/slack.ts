/**
 * Slack adapter wiring — registers Chat SDK handlers that dispatch to the
 * chat workflow on app_mention and on in-thread continuations only (not on
 * every channel message).
 *
 * Plan reference: U3 in
 * docs/plans/2026-05-06-001-feat-chat-platform-bots-discord-slack-plan.md
 */

import type { Chat } from "chat";
import { logger } from "@/lib/logger";
import { triggerChatWorkflow } from "@/lib/platform/bridge";
import type { TenantId, AgentId } from "@/lib/types";

interface SlackHandlerInput {
  tenantId: TenantId;
  agentId: AgentId;
  botUserId: string | null;
}

interface SlackThreadLike {
  id: string;
  subscribe?: () => Promise<void>;
}

interface SlackMessageLike {
  id?: string;
  text?: string;
  isMention?: boolean;
  threadTs?: string | null;
  ts?: string;
  author?: { userId?: string; userName?: string; isBot?: boolean; isMe?: boolean };
}

function extractSlackChannelId(thread: SlackThreadLike): string {
  // thread.id format: slack:teamId:channelId[:threadTs]
  const parts = thread.id.split(":");
  return parts[2] ?? thread.id;
}

export function registerSlackHandlers(bot: Chat, input: SlackHandlerInput): void {
  bot.onNewMention(async (thread, message) => {
    try {
      if (typeof thread.subscribe === "function") {
        await thread.subscribe();
      }
      const m = message as unknown as SlackMessageLike;
      const t = thread as unknown as SlackThreadLike;
      await triggerChatWorkflow({
        tenantId: input.tenantId,
        agentId: input.agentId,
        platform: "slack",
        threadKey: t.id,
        channelId: extractSlackChannelId(t),
        prompt: m.text ?? "",
        authorId: m.author?.userId ?? "",
        authorDisplayName: m.author?.userName ?? "",
        eventId: m.id ?? `${Date.now()}`,
        replyToMessageId: m.id,
      });
    } catch (err) {
      logger.error("slack onNewMention failed", {
        tenant_id: input.tenantId,
        agent_id: input.agentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  bot.onSubscribedMessage(async (thread, message) => {
    try {
      const m = message as unknown as SlackMessageLike;
      const t = thread as unknown as SlackThreadLike;

      // Drop bot echoes.
      if (m.author?.isMe || m.author?.isBot) return;

      await triggerChatWorkflow({
        tenantId: input.tenantId,
        agentId: input.agentId,
        platform: "slack",
        threadKey: t.id,
        channelId: extractSlackChannelId(t),
        prompt: m.text ?? "",
        authorId: m.author?.userId ?? "",
        authorDisplayName: m.author?.userName ?? "",
        eventId: m.id ?? `${Date.now()}`,
        replyToMessageId: m.id,
      });
    } catch (err) {
      logger.error("slack onSubscribedMessage failed", {
        tenant_id: input.tenantId,
        agent_id: input.agentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
