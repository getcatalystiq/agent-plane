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
 *
 * This module also owns three perf-critical hot-path optimizations:
 *
 *   1. `fireReceiptAckEarly`  — fires 👀 + "Thinking…" platform-native
 *      indicators in parallel with `start()` so the user sees feedback
 *      within ~300 ms instead of waiting for WDK to schedule the
 *      workflow body (~0.5–2 s). The cached bot adapter is guaranteed
 *      to be in-process because this bridge runs INSIDE the SDK's
 *      webhook dispatch.
 *
 *   2. `claimChatEventDedupe`  — pre-claims the chat_event_dedupe row
 *      BEFORE `start()`. On duplicate Slack/Discord deliveries (which
 *      happen routinely: app_mention + message.channels for the same
 *      @mention, plus 3-second-ack retries) the bridge bails entirely
 *      and never spins up a WDK workflow lifecycle. Saves ~0.5–2 s of
 *      WDK scheduling per duplicate.
 *
 *   3. The `bridgeClaimed` flag passed into the workflow lets the
 *      winner skip its own dedupe INSERT inside `startInnerDispatchStep`,
 *      collapsing the 3 sequential Neon round-trips on the chat hot
 *      path into 2.
 */

import { logger } from "@/lib/logger";
import { checkRateLimit } from "@/lib/rate-limit";
import { getBot } from "@/lib/platform/bot";
import { withTenantTransaction } from "@/db";
import { z } from "zod";
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

// 👀 receipt fires here, before the workflow body even starts. Matches the
// emoji constant used in chat-dispatch-workflow.ts so the receipt-removal
// path in `safeRemoveReaction(REACTION_RECEIPT)` swaps the same reaction
// we add here. Keep the two in sync.
const REACTION_RECEIPT_EMOJI = "eyes";

interface ReactingAdapter {
  addReaction?: (threadId: string, messageId: string, emoji: string) => Promise<void>;
}

interface TypingAdapter {
  startTyping?: (threadId: string, status?: string) => Promise<void>;
}

/**
 * Fire the user-visible ack — 👀 reaction + platform-native typing
 * indicator — directly from the bridge, racing against
 * `startChatDispatchWorkflow`. Previously this lived as a WDK step
 * (`ackReceiptStep`) inside the workflow body, which meant the user saw
 * no feedback until WDK had scheduled the workflow (~0.5–2 s of dead
 * time on cold function instances). Hoisting it here lands the eyes
 * within ~300 ms of the inbound webhook.
 *
 * Strictly best-effort: every external call is wrapped in
 * `Promise.allSettled` and the entire helper swallows top-level errors —
 * a missing reaction must not gate dispatch.
 *
 * Why a sync `getBot` is safe: this helper is only called from chat
 * adapter handlers (slack onNewMention / onSubscribedMessage,
 * discord onMessageCreate) which run INSIDE the SDK's webhook
 * dispatch — the same Chat instance has therefore already been built
 * and cached via `getOrCreateBot`. The cache is a process-scoped Map,
 * so the lookup is microseconds. If the bot somehow isn't cached
 * (e.g. a future caller invokes the bridge from outside the SDK), we
 * silently skip the ack — the workflow's `consumeAndPostStep`
 * finalize path still posts terminal status reactions.
 */
function fireReceiptAckEarly(input: ChatTriggerInput): void {
  const cached = getBot(input.platform, input.agentId);
  if (!cached) return;

  const reactingAdapter = cached.adapter as unknown as ReactingAdapter;
  const typingAdapter = cached.adapter as unknown as TypingAdapter;

  const tasks: Promise<unknown>[] = [];
  if (input.replyToMessageId && typeof reactingAdapter.addReaction === "function") {
    tasks.push(
      reactingAdapter.addReaction(
        input.threadKey,
        input.replyToMessageId,
        REACTION_RECEIPT_EMOJI,
      ),
    );
  }
  if (typeof typingAdapter.startTyping === "function") {
    // Slack reads the second arg as `assistant.threads.setStatus`. Discord
    // ignores it. One call shape works for both — the constant string is
    // harmless on platforms that don't render it.
    tasks.push(
      input.platform === "slack"
        ? typingAdapter.startTyping(input.threadKey, "Thinking…")
        : typingAdapter.startTyping(input.threadKey),
    );
  }
  if (tasks.length === 0) return;

  // Fire-and-forget so the bridge can return immediately. Failures land
  // in the .then() and are logged-and-dropped.
  Promise.allSettled(tasks).then((results) => {
    for (const r of results) {
      if (r.status === "rejected") {
        logger.warn("fireReceiptAckEarly: adapter call failed (best-effort)", {
          tenant_id: input.tenantId,
          agent_id: input.agentId,
          platform: input.platform,
          thread_key: input.threadKey,
          error: r.reason instanceof Error ? r.reason.message : String(r.reason),
        });
      }
    }
  }).catch(() => {
    /* Promise.allSettled never rejects; defensive only. */
  });
}

/**
 * Pre-claim the chat_event_dedupe row in the bridge BEFORE starting the
 * workflow. Two wins on the chat hot path:
 *
 *  1. Fast-bail on Slack/Discord retry storms. Slack delivers up to 4
 *     copies of an event when the 3-second ack window slips, plus
 *     `app_mention` + `message.channels` arrive together for every
 *     in-channel @mention. Today every duplicate spins up a full WDK
 *     workflow lifecycle (start, schedule, body, INSERT-loser, poll,
 *     attach) just to discover the original is already running. With
 *     this bridge-side claim, duplicates skip `start(...)` entirely.
 *
 *  2. The winner's workflow body skips its own INSERT — the loser-path
 *     poll/steal logic is not on this run's hot path. The workflow
 *     recognizes a bridge-claimed winner via the `bridgeClaimed` option
 *     and goes straight to `reserveSessionAndMessage`.
 *
 * Returns one of:
 *   - "winner": bridge owns the claim, workflow runs as winner.
 *   - "loser-bail": existing row has a winner already (inner_run_id
 *     filled or claim is fresh); safe to skip the workflow entirely.
 *   - "loser-stale": existing claim looks abandoned; we still start the
 *     workflow as a loser so its existing claim-recovery path can steal
 *     it (preserves crash-recovery durability).
 */
type DedupeClaim = "winner" | "loser-bail" | "loser-stale";

const DedupeProbeRow = z.object({
  inner_run_id: z.string().nullable(),
  fresh: z.boolean(),
});

const STALE_BRIDGE_CLAIM_SECONDS = 90;

async function claimChatEventDedupe(input: ChatTriggerInput): Promise<DedupeClaim> {
  return withTenantTransaction(input.tenantId, async (tx) => {
    const inserted = await tx.execute(
      `INSERT INTO chat_event_dedupe (tenant_id, platform, event_id)
       VALUES ($1, $2, $3)
       ON CONFLICT (tenant_id, platform, event_id) DO NOTHING`,
      [input.tenantId, input.platform, input.eventId],
    );
    if (inserted.rowCount === 1) return "winner";

    const row = await tx.queryOne(
      DedupeProbeRow,
      `SELECT
         inner_run_id,
         (claimed_at > now() - make_interval(secs => $4)) AS fresh
       FROM chat_event_dedupe
       WHERE tenant_id = $1 AND platform = $2 AND event_id = $3`,
      [input.tenantId, input.platform, input.eventId, STALE_BRIDGE_CLAIM_SECONDS],
    );
    if (!row) return "loser-stale";
    if (row.inner_run_id !== null) return "loser-bail";
    if (row.fresh) return "loser-bail";
    return "loser-stale";
  });
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

  // 3. Pre-claim the dedupe row. Failure is recoverable — the workflow's
  //    own INSERT remains the durable backstop. Skipped on rate-limited
  //    inputs so the busy-reply path doesn't burn a dedupe slot.
  let bridgeClaimed = false;
  if (rl.allowed) {
    try {
      const claim = await claimChatEventDedupe(input);
      if (claim === "loser-bail") {
        logger.info("triggerChatWorkflow: skipping start() — dedupe already claimed", {
          tenant_id: input.tenantId,
          agent_id: input.agentId,
          platform: input.platform,
          event_id: input.eventId,
        });
        return;
      }
      bridgeClaimed = claim === "winner";
    } catch (err) {
      logger.warn("triggerChatWorkflow: bridge dedupe claim failed (falling through)", {
        tenant_id: input.tenantId,
        agent_id: input.agentId,
        platform: input.platform,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  // 4. Fire 👀 + "Thinking…" IMMEDIATELY, in parallel with the workflow
  //    start. `fireReceiptAckEarly` does not await; it kicks the platform
  //    calls off and returns synchronously so we don't block the workflow
  //    start on Slack/Discord round-trip latency. Skipped on rate-limited
  //    inputs — the workflow's `postBusyReplyStep` posts a "busy" reply
  //    instead, and we don't want a 👀 sitting on a message that gets a
  //    rate-limit response.
  if (rl.allowed) {
    fireReceiptAckEarly(input);
  }

  // 5. Start the workflow. We import lazily to avoid a circular dep during
  //    bot.ts boot (bot.ts → adapters → bridge → workflow, where workflow
  //    pulls in dispatcher → workflows/index → dispatch-workflow).
  try {
    const { startChatDispatchWorkflow } = await import("@/lib/workflows/chat-dispatch-workflow");
    await startChatDispatchWorkflow(input, {
      rateLimited: rl.allowed ? null : (rl.which ?? null),
      bridgeClaimed,
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
