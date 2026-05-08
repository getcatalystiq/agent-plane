/**
 * Slack incoming-webhook notifier for MCP connection-failure alerts.
 *
 * Pure I/O. Validates webhook URL shape, formats a plain-mrkdwn payload,
 * POSTs with a hard 3-second timeout. Never throws — callers can fire-and-
 * forget via Vercel's `after()` without try/catch noise.
 *
 * Returns a discriminated result so the manual "Send test alert" admin
 * endpoint can surface success/failure inline. The `after()` dispatch
 * site in buildMcpConfig() ignores the return value.
 */
import { logger } from "@/lib/logger";

const SLACK_WEBHOOK_REGEX =
  /^https:\/\/hooks\.slack\.com\/services\/T[A-Z0-9]+\/B[A-Z0-9]+\/[A-Za-z0-9]+$/;

const TIMEOUT_MS = 3000;

export type SlackPostResult =
  | { ok: true; status: 200 }
  | { ok: false; status: number | "timeout" | "network_error"; reason: string };

export interface SlackMcpFailurePayload {
  webhookUrl: string;
  tenantName: string;
  agentName: string;
  agentId: string;
  serverName: string;
  errorMessage: string;
  baseUrl: string;
}

export function validateSlackWebhookUrl(
  url: string,
): { ok: true } | { ok: false; reason: string } {
  if (!url || typeof url !== "string") {
    return { ok: false, reason: "URL is required" };
  }
  if (!url.startsWith("https://")) {
    return { ok: false, reason: "Webhook URL must use https://" };
  }
  if (!SLACK_WEBHOOK_REGEX.test(url)) {
    return {
      ok: false,
      reason:
        "Expected a Slack incoming webhook URL of the form https://hooks.slack.com/services/T.../B.../...",
    };
  }
  return { ok: true };
}

function buildSlackPayload(p: SlackMcpFailurePayload): { text: string } {
  const link = `${p.baseUrl}/admin/agents/${p.agentId}?tab=connectors`;
  const lines = [
    `*MCP connection failed* — ${escapeMrkdwn(p.tenantName)}`,
    `*Agent:* ${escapeMrkdwn(p.agentName)}`,
    `*Server:* ${escapeMrkdwn(p.serverName)}`,
    `*Error:* ${escapeMrkdwn(p.errorMessage)}`,
    `<${link}|Open agent in admin>`,
  ];
  return { text: lines.join("\n") };
}

// Slack mrkdwn treats <, >, & specially. Replace to neutralize.
function escapeMrkdwn(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export async function postSlackMcpFailureAlert(
  payload: SlackMcpFailurePayload,
): Promise<SlackPostResult> {
  const validation = validateSlackWebhookUrl(payload.webhookUrl);
  if (!validation.ok) {
    logger.warn("Slack webhook URL failed validation; skipping alert", {
      reason: validation.reason,
    });
    return { ok: false, status: "network_error", reason: validation.reason };
  }

  const body = JSON.stringify(buildSlackPayload(payload));

  try {
    const response = await fetch(payload.webhookUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (response.status === 200) {
      return { ok: true, status: 200 };
    }

    let snippet = "";
    try {
      snippet = (await response.text()).slice(0, 200);
    } catch {
      // ignore body read failure
    }
    logger.warn("Slack webhook returned non-200", {
      status: response.status,
      body_snippet: snippet,
    });
    return {
      ok: false,
      status: response.status,
      reason: snippet || `Slack returned ${response.status}`,
    };
  } catch (err) {
    const isAbort =
      err instanceof DOMException && err.name === "TimeoutError";
    if (isAbort || (err instanceof Error && err.name === "TimeoutError")) {
      logger.warn("Slack webhook timed out", { timeout_ms: TIMEOUT_MS });
      return {
        ok: false,
        status: "timeout",
        reason: `Slack webhook timed out after ${TIMEOUT_MS}ms`,
      };
    }
    const message = err instanceof Error ? err.message : String(err);
    logger.warn("Slack webhook network error", { error: message });
    return { ok: false, status: "network_error", reason: message };
  }
}
