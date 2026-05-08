import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  postSlackMcpFailureAlert,
  validateSlackWebhookUrl,
  type SlackMcpFailurePayload,
} from "@/lib/notifications/slack";

const VALID_URL =
  "https://hooks.slack.com/services/T01TESTONLY/B01TESTONLY/FAKEnotarealtokenZZZZZZ";

const basePayload: SlackMcpFailurePayload = {
  webhookUrl: VALID_URL,
  tenantName: "Acme",
  agentName: "Support Triage",
  agentId: "agent_abc123",
  serverName: "Linear",
  errorMessage: "token refresh failed: 401 Unauthorized",
  baseUrl: "https://agentplane.example.com",
};

describe("validateSlackWebhookUrl", () => {
  it("accepts a real-shaped Slack webhook URL", () => {
    expect(validateSlackWebhookUrl(VALID_URL)).toEqual({ ok: true });
  });

  it("rejects http://", () => {
    const r = validateSlackWebhookUrl(VALID_URL.replace("https://", "http://"));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/https/);
  });

  it("rejects a non-Slack https URL", () => {
    const r = validateSlackWebhookUrl("https://example.com/foo/bar/baz");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/hooks\.slack\.com/);
  });

  it("rejects an empty string", () => {
    const r = validateSlackWebhookUrl("");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/required/i);
  });

  it("rejects a malformed slack-shaped URL", () => {
    const r = validateSlackWebhookUrl(
      "https://hooks.slack.com/services/lower/case/path",
    );
    expect(r.ok).toBe(false);
  });
});

describe("postSlackMcpFailureAlert", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("happy path: 200 returns ok and sends a payload with all fields + agent link", async () => {
    let captured: { url: string; init: RequestInit } | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        captured = { url, init };
        return { status: 200, text: async () => "ok" } as Response;
      }),
    );

    const result = await postSlackMcpFailureAlert(basePayload);
    expect(result).toEqual({ ok: true, status: 200 });

    expect(captured).not.toBeNull();
    expect(captured!.url).toBe(VALID_URL);
    expect(captured!.init.method).toBe("POST");
    const body = JSON.parse(captured!.init.body as string) as { text: string };
    expect(body.text).toContain("Acme");
    expect(body.text).toContain("Support Triage");
    expect(body.text).toContain("Linear");
    expect(body.text).toContain("token refresh failed: 401 Unauthorized");
    expect(body.text).toContain(
      "https://agentplane.example.com/admin/agents/agent_abc123?tab=connectors",
    );
  });

  it("error path: returns network_error on fetch throw and never throws to caller", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(new Error("ECONNRESET")),
    );

    const result = await postSlackMcpFailureAlert(basePayload);
    expect(result.ok).toBe(false);
    expect(result.status).toBe("network_error");
  });

  it("error path: returns ok:false with the response status on 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => ({
        status: 404,
        text: async () => "no_service",
      })),
    );

    const result = await postSlackMcpFailureAlert(basePayload);
    expect(result.ok).toBe(false);
    expect(result.status).toBe(404);
    if (!result.ok) expect(result.reason).toContain("no_service");
  });

  it("error path: returns timeout when AbortSignal.timeout fires", async () => {
    const timeoutErr = new DOMException(
      "The operation was aborted due to timeout",
      "TimeoutError",
    );
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(timeoutErr));

    const result = await postSlackMcpFailureAlert(basePayload);
    expect(result.ok).toBe(false);
    expect(result.status).toBe("timeout");
  });

  it("rejects an invalid webhook URL without making a fetch call", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);

    const result = await postSlackMcpFailureAlert({
      ...basePayload,
      webhookUrl: "https://example.com/foo",
    });
    expect(result.ok).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("escapes <, >, & in field values to neutralize Slack mrkdwn special chars", async () => {
    let captured: string | null = null;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url: string, init: RequestInit) => {
        captured = init.body as string;
        return { status: 200, text: async () => "ok" } as Response;
      }),
    );

    await postSlackMcpFailureAlert({
      ...basePayload,
      errorMessage: "fetch <script>alert('x')</script> & more",
    });
    expect(captured).not.toBeNull();
    expect(captured!).toContain("&lt;script&gt;");
    expect(captured!).toContain("&amp;");
    expect(captured!).not.toContain("<script>");
  });
});
