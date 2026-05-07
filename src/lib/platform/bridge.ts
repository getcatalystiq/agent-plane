/**
 * Platform bridge — thin entry point that bot handlers call after the
 * @mention filter passes.
 *
 * Plan reference: U6 in
 * docs/plans/2026-05-06-001-feat-chat-platform-bots-discord-slack-plan.md
 *
 * Inline rate limit (per-agent 30/min + per-platform-user 10/min) runs here
 * BEFORE the workflow is started — pure in-memory check, no WDK step
 * overhead. Workflow trigger key includes tenantId to prevent cross-tenant
 * collision when two tenants share a Slack workspace.
 */

import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rate-limit";
import type { ChatPlatform } from "@/lib/platform/operations";
import type { TenantId, AgentId } from "@/lib/types";

export interface ChatTriggerInput {
  tenantId: TenantId;
  agentId: AgentId;
  platform: ChatPlatform;
  /** Full thread key — `discord:guildId:channelId:threadId` or `slack:teamId:channelId:thread_ts`. */
  threadKey: string;
  /** Raw platform channel/thread id used by callback.ts when posting. */
  channelId: string;
  prompt: string;
  authorId: string;
  authorDisplayName: string;
  /** Discord message id or Slack event_id — used as the workflow idempotency key. */
  eventId: string;
  replyToMessageId?: string;
  /** Optional attachment refs pre-parsed from the inbound payload. */
  attachmentRefs?: Array<{ filename: string; url: string; contentType: string; sizeBytes: number }>;
}

export const RATE_LIMIT_PER_AGENT_PER_MIN = 30;
export const RATE_LIMIT_PER_USER_PER_MIN = 10;
export const MAX_INBOUND_LENGTH = 4_000;

export interface RateLimitResult {
  allowed: boolean;
  /** When false: `which` indicates the limiter that fired ('agent' | 'user'). */
  which?: "agent" | "user";
}

export function checkChatRateLimits(input: ChatTriggerInput): RateLimitResult {
  const agent = checkRateLimit(`chat:agent:${input.agentId}`, RATE_LIMIT_PER_AGENT_PER_MIN, 60_000);
  if (!agent.allowed) return { allowed: false, which: "agent" };
  const user = checkRateLimit(
    `chat:user:${input.platform}:${input.authorId}`,
    RATE_LIMIT_PER_USER_PER_MIN,
    60_000,
  );
  if (!user.allowed) return { allowed: false, which: "user" };
  return { allowed: true };
}

/**
 * Build the tenant-scoped idempotency key for a chat event.
 * Tenant prefix prevents cross-tenant collision on Slack `event_id`
 * (which is per-team, not globally unique).
 */
export function chatIdempotencyKey(input: Pick<ChatTriggerInput, "tenantId" | "platform" | "eventId">): string {
  return `chat:${input.tenantId}:${input.platform}:${input.eventId}`;
}

/**
 * Trigger the chat dispatch workflow. Fire-and-forget — does NOT await
 * completion. The workflow runs durably; the bot handler returns to the
 * Chat SDK quickly so the platform's webhook timeout doesn't trip.
 */
export async function triggerChatWorkflow(input: ChatTriggerInput): Promise<void> {
  // 1. Length guard — drop oversized inputs early so they don't burn rate
  //    limit budget. The Chat SDK already enforces a similar cap on most
  //    platforms, but this is the authoritative ceiling for AgentPlane.
  if (input.prompt.length > MAX_INBOUND_LENGTH) {
    logger.warn("chat trigger dropped — prompt too long", {
      tenant_id: input.tenantId,
      agent_id: input.agentId,
      platform: input.platform,
      length: input.prompt.length,
    });
    return;
  }

  // 2. Inline rate-limit check.
  const rl = checkChatRateLimits(input);
  if (!rl.allowed) {
    logger.warn("chat trigger rate-limited", {
      tenant_id: input.tenantId,
      agent_id: input.agentId,
      platform: input.platform,
      which: rl.which,
    });
    // The workflow's busy-reply step is what posts to the platform; we
    // could call it here as a non-workflow shortcut, but routing through
    // the workflow keeps a single audit trail. The workflow re-checks rate
    // limits in its first step and posts a generic "busy" reply.
  }

  // 3. Start the workflow. We import lazily to avoid a circular dep during
  //    bot.ts boot (bot.ts → adapters → bridge → workflow, where workflow
  //    pulls in dispatcher → workflows/index → dispatch-workflow).
  try {
    const { startChatDispatchWorkflow } = await import("@/lib/workflows/chat-dispatch-workflow");
    await startChatDispatchWorkflow(input, {
      idempotencyKey: chatIdempotencyKey(input),
      rateLimited: rl.allowed ? null : (rl.which ?? null),
    });
  } catch (err) {
    logger.error("triggerChatWorkflow: failed to start workflow", {
      tenant_id: input.tenantId,
      agent_id: input.agentId,
      platform: input.platform,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
