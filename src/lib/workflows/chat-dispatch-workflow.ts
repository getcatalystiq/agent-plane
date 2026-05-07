/**
 * chatDispatchWorkflow — durable orchestration spine for chat ingress.
 *
 * Plan reference: U6 in
 * docs/plans/2026-05-06-001-feat-chat-platform-bots-discord-slack-plan.md
 *
 * Shape A: this workflow `start()`s the existing dispatchWorkflow as an
 * inner workflow, captures innerRunId, and reads the dispatcher's NDJSON
 * via `getRun(innerRunId).getReadable()`. Per-edit `postOrEditStep` writes
 * to Discord/Slack with 429 + Retry-After backoff.
 *
 * NOTE: this file currently exposes a public start function for the bridge
 * to call. The full workflow body is being implemented in U6+U7 — this
 * stub records the trigger to logs so chat ingress is observable end-to-end
 * before the durable streaming path lands.
 */

import { logger } from "@/lib/logger";
import type { ChatTriggerInput } from "@/lib/platform/bridge";

export interface StartChatDispatchOptions {
  idempotencyKey: string;
  rateLimited: "agent" | "user" | null;
}

export async function startChatDispatchWorkflow(
  input: ChatTriggerInput,
  options: StartChatDispatchOptions,
): Promise<void> {
  // Stub implementation — records the trigger and exits. The durable
  // workflow (Shape A: start(dispatchWorkflow) + getRun().getReadable() +
  // per-edit postOrEditStep with 429 handling) lands in U6+U7.
  logger.info("chatDispatchWorkflow trigger (stub)", {
    tenant_id: input.tenantId,
    agent_id: input.agentId,
    platform: input.platform,
    thread_key: input.threadKey,
    idempotency_key: options.idempotencyKey,
    rate_limited: options.rateLimited,
    prompt_length: input.prompt.length,
  });
}
