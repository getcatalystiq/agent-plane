/**
 * Slack adapter wiring — registers Chat SDK handlers that dispatch to the
 * chat workflow on app_mention and on in-thread continuations, plus the
 * Slack Agents & AI Apps surface (assistant_thread_started events).
 *
 * Plan reference: U3 in
 * docs/plans/2026-05-06-001-feat-chat-platform-bots-discord-slack-plan.md
 *
 * AI Apps additions (later):
 *   - `assistant_thread_started` handler — fires when a Slack user opens
 *     a fresh assistant thread with the bot from the AI assistant panel.
 *     We post a greeting and set suggested follow-up prompts so the user
 *     sees concrete next steps the moment the thread opens (Slack's
 *     native AI assistant UX shows these as clickable chips).
 *
 * Slack app config requirements for AI Apps:
 *   - Enable "Agents & AI Apps" in the Slack app config
 *   - Add `assistant:write` to the bot OAuth token scopes
 *   - Subscribe to `assistant_thread_started` and
 *     `assistant_thread_context_changed` event types
 *   - Reinstall the bot in the workspace
 *
 * Without those, the `onAssistantThreadStarted` handler never fires and
 * the suggested-prompts / title / status calls inside the chat workflow
 * fall back to `missing_scope` warnings — no degradation of the @mention
 * path.
 */

import type { Chat } from "chat";
import { logger } from "@/lib/logger";
import { triggerChatWorkflow } from "@/lib/platform/bridge";
import { queryOne } from "@/db";
import { z } from "zod";
import type { TenantId, AgentId } from "@/lib/types";

interface SlackHandlerInput {
  tenantId: TenantId;
  agentId: AgentId;
  botUserId: string | null;
}

// ---------------------------------------------------------------------------
// AI Apps suggested prompts — generic fallback. Customizable per-agent
// later via agent config; for now every agent sees the same three.
// ---------------------------------------------------------------------------
const DEFAULT_SUGGESTED_PROMPTS: ReadonlyArray<{ title: string; message: string }> = [
  { title: "Show me what you can do", message: "What kinds of questions can you help me with?" },
  { title: "Give me a quick overview", message: "Summarize what's most important right now." },
  { title: "Help me get started", message: "What's a good first question to ask you?" },
];

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
        // Slack delivers BOTH app_mention AND message.channels for one
        // @mention, with different m.id but the SAME m.ts (the user's
        // message timestamp). Keying the dedupe row on m.ts collapses
        // them into one chat_event_dedupe row so only one workflow
        // runs per user message. Without this, the second handler's
        // reserveSessionAndMessage hits the first session in `creating`
        // and throws ConcurrencyLimitError → WDK FatalError loop.
        eventId: m.ts ?? m.id ?? crypto.randomUUID(),
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

  // ---- AI Apps: assistant_thread_started ----
  // Fires when a Slack user opens a fresh assistant thread with the
  // bot from the AI assistant panel. Slack's native AI assistant UX
  // expects the bot to:
  //   - post a greeting message
  //   - set suggested follow-up prompts (clickable chips below the
  //     greeting that auto-populate the input)
  //   - set a thread title (shown in the assistant history list)
  //
  // No-op when the bot doesn't have AI Apps configured — Slack never
  // delivers `assistant_thread_started` and this handler never fires.
  // The downstream @mention path is unaffected.
  bot.onAssistantThreadStarted(async (event) => {
    try {
      const agent = await queryOne(
        z.object({ name: z.string().nullable() }),
        "SELECT name FROM agents WHERE id = $1",
        [input.agentId],
      );
      const agentName = agent?.name ?? "your AI assistant";

      const adapter = event.adapter as unknown as {
        setSuggestedPrompts?: (
          channelId: string,
          threadTs: string,
          prompts: Array<{ title: string; message: string }>,
          title?: string,
        ) => Promise<void>;
        setAssistantTitle?: (
          channelId: string,
          threadTs: string,
          title: string,
        ) => Promise<void>;
        postMessage?: (threadId: string, text: string) => Promise<unknown>;
      };

      if (typeof adapter.setAssistantTitle === "function") {
        await adapter.setAssistantTitle(
          event.channelId,
          event.threadTs,
          `Chat with ${agentName}`,
        ).catch((err: unknown) => {
          logger.warn("slack onAssistantThreadStarted: setAssistantTitle failed", {
            tenant_id: input.tenantId,
            agent_id: input.agentId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }

      if (typeof adapter.setSuggestedPrompts === "function") {
        await adapter.setSuggestedPrompts(
          event.channelId,
          event.threadTs,
          [...DEFAULT_SUGGESTED_PROMPTS],
        ).catch((err: unknown) => {
          logger.warn("slack onAssistantThreadStarted: setSuggestedPrompts failed", {
            tenant_id: input.tenantId,
            agent_id: input.agentId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }

      if (typeof adapter.postMessage === "function") {
        const greeting = `Hi <@${event.userId}>! I'm ${agentName}. Ask me anything, or pick one of the suggestions below to get started.`;
        await adapter.postMessage(event.threadId, greeting).catch((err: unknown) => {
          logger.warn("slack onAssistantThreadStarted: postMessage greeting failed", {
            tenant_id: input.tenantId,
            agent_id: input.agentId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
      }
    } catch (err) {
      logger.error("slack onAssistantThreadStarted failed", {
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
        // Slack delivers BOTH app_mention AND message.channels for one
        // @mention, with different m.id but the SAME m.ts (the user's
        // message timestamp). Keying the dedupe row on m.ts collapses
        // them into one chat_event_dedupe row so only one workflow
        // runs per user message. Without this, the second handler's
        // reserveSessionAndMessage hits the first session in `creating`
        // and throws ConcurrencyLimitError → WDK FatalError loop.
        eventId: m.ts ?? m.id ?? crypto.randomUUID(),
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
