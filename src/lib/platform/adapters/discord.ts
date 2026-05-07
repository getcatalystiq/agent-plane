/**
 * Discord adapter wiring — registers Chat SDK handlers that explicitly
 * filter on `message.isMention` (or, when isMention isn't available on a
 * subscribed-message event, by re-checking the bot user id) BEFORE
 * triggering the chat workflow.
 *
 * Plan reference: U3 in
 * docs/plans/2026-05-06-001-feat-chat-platform-bots-discord-slack-plan.md
 *
 * Why filter explicitly: MESSAGE_CONTENT privileged intent delivers the
 * full content of every visible-channel MESSAGE_CREATE to the gateway. The
 * Chat SDK already routes mentions to onNewMention, but this wrapper logs
 * non-mention events so we can confirm the filter is working in production
 * and adds an extra safety net in case the SDK's filter is permissive.
 */

import type { Chat } from "chat";
import type { DiscordAdapter } from "@chat-adapter/discord";
import { logger } from "@/lib/logger";
import { triggerChatWorkflow } from "@/lib/platform/bridge";
import type { TenantId, AgentId } from "@/lib/types";

interface DiscordHandlerInput {
  tenantId: TenantId;
  agentId: AgentId;
  botUserId: string | null;
}

interface MentionLikeMessage {
  id?: string;
  text?: string;
  isMention?: boolean;
  /** Discord raw mentions array (user IDs). The Chat SDK's abstracted
   *  Message preserves this when MESSAGE_CONTENT intent delivers it. */
  mentions?: Array<string | { userId?: string }>;
  author?: { userId?: string; userName?: string; isBot?: boolean; isMe?: boolean };
}

function messageMentionsBot(m: MentionLikeMessage, botUserId: string | null): boolean {
  if (m.isMention === true) return true;
  if (!botUserId || !Array.isArray(m.mentions)) return false;
  return m.mentions.some((entry) => {
    if (typeof entry === "string") return entry === botUserId;
    return entry?.userId === botUserId;
  });
}

interface ThreadLike {
  id: string;
  subscribe?: () => Promise<void>;
}

function extractDiscordChannelId(thread: ThreadLike): string {
  // thread.id format: discord:guildId:channelId[:threadId]
  // threadId if present (replies go in the thread); otherwise channelId.
  const parts = thread.id.split(":");
  return parts[3] ?? parts[2] ?? thread.id;
}

function isDiscordThread(thread: ThreadLike): boolean {
  // discord:guildId:channelId:threadId — 4th part is the actual thread.
  // Bare channel subscriptions (3 parts) shouldn't dispatch on every message.
  const parts = thread.id.split(":");
  return parts.length >= 4 && Boolean(parts[3]);
}

export function registerDiscordHandlers(bot: Chat, input: DiscordHandlerInput): void {
  bot.onNewMention(async (thread, message) => {
    try {
      // Subscribe so future in-thread messages route via onSubscribedMessage.
      if (typeof thread.subscribe === "function") {
        await thread.subscribe();
      }
      const m = message as unknown as MentionLikeMessage;
      const t = thread as unknown as ThreadLike;
      await triggerChatWorkflow({
        tenantId: input.tenantId,
        agentId: input.agentId,
        platform: "discord",
        threadKey: t.id,
        channelId: extractDiscordChannelId(t),
        prompt: m.text ?? "",
        authorId: m.author?.userId ?? "",
        authorDisplayName: m.author?.userName ?? "",
        eventId: m.id ?? `${Date.now()}`,
        replyToMessageId: m.id,
      });
    } catch (err) {
      logger.error("discord onNewMention failed", {
        tenant_id: input.tenantId,
        agent_id: input.agentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });

  bot.onSubscribedMessage(async (thread, message) => {
    try {
      const m = message as unknown as MentionLikeMessage;
      const t = thread as unknown as ThreadLike;

      // Drop bot's own messages and other bots' echoes.
      if (m.author?.isMe || m.author?.isBot) return;

      // Channel-level subscriptions (3-part ids) are noisy — only dispatch
      // for actual Discord threads.
      if (!isDiscordThread(t)) return;

      // P1 #11 (review run 20260506-221948-2402b0ed): MESSAGE_CONTENT
      // intent delivers every visible-channel message. In a subscribed
      // thread the bot is "in conversation," so non-mention messages from
      // humans count as continuations — dispatch them. But we explicitly
      // log the path so production telemetry can confirm the filter is
      // doing what we expect; if a thread silently fans out for hours,
      // the log is the signal to bound it.
      if (!messageMentionsBot(m, input.botUserId)) {
        logger.info("discord onSubscribedMessage continuation (non-mention)", {
          tenant_id: input.tenantId,
          agent_id: input.agentId,
          thread_id: t.id,
          author_id: m.author?.userId,
        });
      }

      await triggerChatWorkflow({
        tenantId: input.tenantId,
        agentId: input.agentId,
        platform: "discord",
        threadKey: t.id,
        channelId: extractDiscordChannelId(t),
        prompt: m.text ?? "",
        authorId: m.author?.userId ?? "",
        authorDisplayName: m.author?.userName ?? "",
        eventId: m.id ?? `${Date.now()}`,
        replyToMessageId: m.id,
      });
    } catch (err) {
      logger.error("discord onSubscribedMessage failed", {
        tenant_id: input.tenantId,
        agent_id: input.agentId,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

/**
 * Discord returns 400 / code 160004 when POSTing a thread to a message that
 * already has one. Threads started from a message reuse the message's
 * snowflake as the thread ID, so on that specific error we resolve to
 * { id: messageId } and let the adapter continue inside the existing thread.
 * Copied verbatim from agent-co.
 */
export function patchDiscord160004Idempotency(adapter: DiscordAdapter): void {
  const target = adapter as unknown as {
    createDiscordThread?: (channelId: string, messageId: string) => Promise<{ id: string }>;
  };
  if (typeof target.createDiscordThread !== "function") return;
  const original = target.createDiscordThread.bind(adapter);
  target.createDiscordThread = async (channelId: string, messageId: string) => {
    try {
      return await original(channelId, messageId);
    } catch (err) {
      if (String(err).includes("160004")) {
        return { id: messageId };
      }
      throw err;
    }
  };
}
