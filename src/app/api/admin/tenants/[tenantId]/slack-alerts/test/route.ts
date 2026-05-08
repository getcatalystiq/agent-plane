/**
 * POST /api/admin/tenants/[tenantId]/slack-alerts/test
 *
 * Operator-facing roundtrip test: posts a fixed payload via the saved
 * Slack webhook URL and surfaces the result inline in the settings UI.
 * Uses the same notifier helper as the failure-alert path so the manual
 * test exercises the real send path.
 */
import { NextRequest, NextResponse } from "next/server";
import { queryOne } from "@/db";
import { z } from "zod";
import { withErrorHandler } from "@/lib/api";
import { decrypt } from "@/lib/crypto";
import { getEnv } from "@/lib/env";
import { postSlackMcpFailureAlert } from "@/lib/notifications/slack";
import { getCallbackBaseUrl } from "@/lib/mcp-connections";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ tenantId: string }> };

const TenantSlackRow = z.object({
  name: z.string(),
  slack_alert_webhook_url_enc: z.string().nullable(),
});

export const POST = withErrorHandler(
  async (_request: NextRequest, context) => {
    const { tenantId } = await (context as RouteContext).params;

    const tenant = await queryOne(
      TenantSlackRow,
      "SELECT name, slack_alert_webhook_url_enc FROM tenants WHERE id = $1",
      [tenantId],
    );

    if (!tenant || !tenant.slack_alert_webhook_url_enc) {
      return NextResponse.json(
        {
          error: {
            code: "not_configured",
            message:
              "No Slack webhook URL is configured for this company. Save one first.",
          },
        },
        { status: 400 },
      );
    }

    let webhookUrl: string;
    try {
      const env = getEnv();
      webhookUrl = await decrypt(
        JSON.parse(tenant.slack_alert_webhook_url_enc),
        env.ENCRYPTION_KEY,
      );
    } catch {
      return NextResponse.json(
        {
          error: {
            code: "decrypt_failed",
            message:
              "Failed to decrypt the saved webhook URL. Re-save it from the settings form.",
          },
        },
        { status: 500 },
      );
    }

    const result = await postSlackMcpFailureAlert({
      webhookUrl,
      tenantName: tenant.name,
      agentName: "(test alert)",
      agentId: "test",
      serverName: "(test alert)",
      errorMessage:
        "This is a test alert from AgentPlane. If you can read this, your webhook is configured correctly.",
      baseUrl: getCallbackBaseUrl(),
    });

    if (result.ok) {
      return NextResponse.json({ ok: true });
    }
    return NextResponse.json({
      ok: false,
      status: result.status,
      message: result.reason,
    });
  },
);
