import { NextRequest } from "next/server";
import { queryOne } from "@/db";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { verifyCronSecret } from "@/lib/cron-auth";
import { AgentRowInternal, TenantRow, ScheduleRow } from "@/lib/validation";
import { dispatchSessionMessage } from "@/lib/dispatcher";
import { findWarmScheduleSession, casActiveToIdle } from "@/lib/sessions";
import { transitionMessageStatus } from "@/lib/session-messages";
import { BudgetExceededError, ConcurrencyLimitError } from "@/lib/errors";
import { getCallbackBaseUrl } from "@/lib/mcp-connections";
import { logger } from "@/lib/logger";
import { z } from "zod";
import type { AgentId, TenantId } from "@/lib/types";

export const dynamic = "force-dynamic";

const ExecuteSchema = z.object({
  schedule_id: z.string().uuid(),
});

export const POST = withErrorHandler(async (request: NextRequest) => {
  verifyCronSecret(request);

  const body = await request.json();
  const { schedule_id } = ExecuteSchema.parse(body);

  // Load schedule from DB (never trust POST body for anything besides schedule_id)
  const schedule = await queryOne(
    ScheduleRow,
    "SELECT * FROM schedules WHERE id = $1",
    [schedule_id],
  );
  if (!schedule || !schedule.enabled || !schedule.prompt) {
    logger.warn("Scheduled run skipped: schedule not found or not enabled", { schedule_id });
    return jsonResponse({ status: "skipped", reason: "not_schedulable" });
  }

  const agent = await queryOne(
    AgentRowInternal,
    "SELECT * FROM agents WHERE id = $1",
    [schedule.agent_id],
  );
  if (!agent) {
    logger.warn("Scheduled run skipped: agent not found", { schedule_id, agent_id: schedule.agent_id });
    return jsonResponse({ status: "skipped", reason: "agent_not_found" });
  }

  const tenant = await queryOne(TenantRow, "SELECT * FROM tenants WHERE id = $1", [agent.tenant_id]);
  if (!tenant || tenant.status === "suspended") {
    logger.warn("Scheduled run skipped: tenant suspended or not found", {
      schedule_id,
      agent_id: agent.id,
      tenant_id: agent.tenant_id,
    });
    return jsonResponse({ status: "skipped", reason: "tenant_suspended" });
  }

  const tenantId = agent.tenant_id as TenantId;
  const agentId = agent.id as AgentId;

  // U4: dispatch through the unified chokepoint. Schedule runs are PERSISTENT
  // (ephemeral=false) so a short follow-up window (idle TTL of 300s, set by
  // the dispatcher's per-trigger default) lets a follow-up cron tick reuse
  // the warm sandbox. The cleanup cron stops idle schedule sessions after
  // the per-row TTL elapses.
  // FIX #6 (adv-003): try to reuse a warm session created by a previous
  // schedule tick. The dispatcher's CAS handles the race with the cleanup
  // cron (and falls back gracefully — for internal triggers a stopped
  // session does NOT throw, the dispatcher auto-creates).
  let warmSessionId: string | undefined;
  try {
    const warm = await findWarmScheduleSession(tenantId, agentId);
    if (warm) warmSessionId = warm.id;
  } catch (err) {
    logger.warn("findWarmScheduleSession lookup failed (non-fatal)", {
      schedule_id,
      agent_id: agent.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }

  let messageId: string;
  let sessionId: string;
  let streamDetached = false;
  try {
    const dispatchResult = await dispatchSessionMessage({
      tenantId,
      agentId,
      sessionId: warmSessionId,
      prompt: schedule.prompt,
      triggeredBy: "schedule",
      ephemeral: false,
      callerKeyId: null,
      platformApiUrl: getCallbackBaseUrl(),
    });
    messageId = dispatchResult.messageId;
    sessionId = dispatchResult.sessionId;

    // Drain the dispatcher stream so finalize hooks fire. The schedule cron
    // function instance bounds this with its 5-min maxDuration; long-running
    // schedule prompts detach naturally via the dispatcher's stream-detach
    // path.
    //
    // FIX #20 (reliability MED): wedged streams (sandbox SDK never produces
    // bytes after spawn) used to pin the function until maxDuration. Each
    // read is now wrapped in a 30s race; on timeout we mark the message
    // failed with `error_type: 'drain_timeout'` and break out of the loop.
    const reader = dispatchResult.stream.getReader();
    const decoder = new TextDecoder();
    let lineBuffer = "";
    let timedOut = false;
    try {
      // eslint-disable-next-line no-constant-condition
      while (true) {
        const READ_TIMEOUT_MS = 30_000;
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        const readPromise = reader.read();
        const timeoutPromise = new Promise<{ timeout: true }>((resolve) => {
          timeoutHandle = setTimeout(() => resolve({ timeout: true }), READ_TIMEOUT_MS);
        });
        const result = await Promise.race([readPromise, timeoutPromise]);
        if (timeoutHandle !== undefined) clearTimeout(timeoutHandle);
        if ("timeout" in result) {
          timedOut = true;
          logger.warn("Scheduled run drain loop timed out per-read", {
            schedule_id,
            agent_id: agent.id,
            message_id: messageId,
            read_timeout_ms: READ_TIMEOUT_MS,
          });
          break;
        }
        if (result.done) break;
        // Scan the chunk for the dispatcher's `stream_detached` event. After
        // detach the runner is still running and will finalize via the
        // internal-upload route — racing it with the post-drain fallback
        // prematurely flips a long-running schedule run to `failed`. Decode
        // line-by-line (4.5min runs may emit dozens of events) and look for
        // the marker; we don't need full JSON parsing, just substring match.
        lineBuffer += decoder.decode(result.value, { stream: true });
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() ?? "";
        for (const line of lines) {
          if (line.includes('"type":"stream_detached"')) {
            streamDetached = true;
          }
        }
      }
    } finally {
      try { reader.releaseLock(); } catch { /* ignore */ }
    }
    if (timedOut) {
      await transitionMessageStatus(messageId, tenantId, "running", "failed", {
        completed_at: new Date().toISOString(),
        error_type: "drain_timeout",
        error_messages: ["Scheduled run drain loop hit per-read timeout (30s without bytes)."],
      }).catch(() => {});
      // Schedule sessions are persistent (ephemeral=false). The dispatcher's
      // finalize is bypassed when we abandon the stream, so flip the session
      // active→idle here. Idle-TTL (300s) then stops the sandbox via the
      // cleanup cron. Without this the row leaks in `active` forever — the
      // active-watchdog requires a `running` message that this transition
      // just destroyed.
      await casActiveToIdle(sessionId, tenantId, messageId).catch(() => {});
    }
  } catch (err) {
    if (err instanceof ConcurrencyLimitError || err instanceof BudgetExceededError) {
      const reason = err instanceof ConcurrencyLimitError ? "concurrency_limit" : "budget_exceeded";
      logger.warn("Scheduled run dispatch skipped", {
        schedule_id,
        agent_id: agent.id,
        reason,
        error: err.message,
      });
      return jsonResponse({ status: "skipped", reason });
    }
    logger.error("Scheduled run dispatch failed", {
      schedule_id,
      agent_id: agent.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return jsonResponse({ status: "failed", reason: "dispatch_error" });
  }

  // If the dispatcher's stream-detach fired during drain (long-running job),
  // the runner is still executing and owns finalization via the internal
  // upload route. Skip the post-drain fallback — racing it with the runner
  // prematurely stamps `schedule_no_terminal_event` on jobs that succeed
  // moments later. The cleanup cron's 30-min active-watchdog is the real
  // backstop if the runner never uploads.
  if (streamDetached) {
    logger.info("Scheduled run detached — runner will finalize via internal upload", {
      schedule_id,
      agent_id: agent.id,
      message_id: messageId,
    });
    return jsonResponse({ status: "detached", message_id: messageId });
  }

  // If the dispatcher stream finished but the message status is still
  // "running" (for example, the runner crashed silently), best-effort
  // transition to failed so the schedule tick doesn't leave a stuck row.
  // Track whether we actually flipped the message (vs. happy-path no-op) so
  // we only escalate to a session-level CAS in the failure case.
  const flippedMessage = await transitionMessageStatus(
    messageId,
    tenantId,
    "running",
    "failed",
    {
      completed_at: new Date().toISOString(),
      error_type: "schedule_no_terminal_event",
      error_messages: ["Scheduled run ended without terminal event"],
    },
  ).catch(() => false);

  // If we just transitioned a "stuck running" message to failed, the parent
  // session is still in `active` (the dispatcher's finalize never ran). The
  // active-watchdog requires a running message and will skip this row, so
  // the session would leak forever. Flip active→idle and let idle-TTL stop
  // the sandbox on the next cleanup tick.
  if (flippedMessage) {
    await casActiveToIdle(sessionId, tenantId, messageId).catch(() => {});
  }

  logger.info("Scheduled run completed", { schedule_id, agent_id: agent.id, message_id: messageId });
  return jsonResponse({ status: "triggered", message_id: messageId });
});
