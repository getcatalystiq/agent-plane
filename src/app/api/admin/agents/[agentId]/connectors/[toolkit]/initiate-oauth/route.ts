import { NextRequest, NextResponse } from "next/server";
import { queryOne } from "@/db";
import { AgentRow } from "@/lib/validation";
import { initiateOAuthConnector } from "@/lib/composio";
import { signOAuthState } from "@/lib/oauth-state";
import { withErrorHandler } from "@/lib/api";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ agentId: string; toolkit: string }> };

// POST /api/admin/agents/:agentId/connectors/:toolkit/initiate-oauth
// Returns { redirect_url } as JSON instead of doing a redirect.
// Used by Envoy admin UI to open OAuth in a popup.
export const POST = withErrorHandler(async (request: NextRequest, context) => {
  const { agentId, toolkit } = await (context as RouteContext).params;
  const agent = await queryOne(AgentRow, "SELECT * FROM agents WHERE id = $1", [agentId]);
  if (!agent) return NextResponse.json({ error: { code: "not_found", message: "Agent not found" } }, { status: 404 });

  // Generate signed state for CSRF protection
  const state = await signOAuthState({
    agentId,
    tenantId: agent.tenant_id,
    toolkit,
    authMethod: "composio_oauth",
  });

  // Build callback URL with popup mode flag and signed state
  const callbackUrl = new URL(
    `/api/admin/agents/${agentId}/connectors/${toolkit}/callback?mode=popup&state=${encodeURIComponent(state)}`,
    request.url,
  ).toString();

  const result = await initiateOAuthConnector(agent.id, toolkit, callbackUrl);
  if (!result) {
    return NextResponse.json({ error: { code: "upstream_error", message: "Failed to initiate OAuth" } }, { status: 502 });
  }

  return NextResponse.json({ redirect_url: result.redirectUrl });
});
