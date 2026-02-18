import { NextRequest } from "next/server";
import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { queryOne } from "@/db";
import { AgentRow } from "@/lib/validation";
import { NotFoundError, ValidationError } from "@/lib/errors";
import { initiateOAuthConnector } from "@/lib/composio";
import { signOAuthState } from "@/lib/oauth-state";

export const dynamic = "force-dynamic";

// POST /api/agents/:agentId/connectors/:toolkit/initiate-oauth
// Returns { redirect_url } as JSON for popup-based OAuth flows.
export const POST = withErrorHandler(async (request: NextRequest, context) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const { agentId, toolkit } = await context!.params;

  const agent = await queryOne(
    AgentRow,
    "SELECT * FROM agents WHERE id = $1 AND tenant_id = $2",
    [agentId, auth.tenantId],
  );
  if (!agent) throw new NotFoundError("Agent not found");

  // Validate toolkit is in agent's configured toolkits
  if (!agent.composio_toolkits.map((t) => t.toLowerCase()).includes(toolkit.toLowerCase())) {
    throw new ValidationError(
      `Toolkit "${toolkit}" is not configured on this agent. Add it to composio_toolkits first.`,
    );
  }

  // Generate signed state for CSRF protection on the callback
  const state = await signOAuthState({ agentId, tenantId: auth.tenantId, toolkit });

  const callbackUrl = new URL(
    `/api/agents/${agentId}/connectors/${toolkit}/callback?mode=popup&state=${encodeURIComponent(state)}`,
    request.url,
  ).toString();

  const result = await initiateOAuthConnector(agent.tenant_id, toolkit, callbackUrl);
  if (!result) {
    return jsonResponse(
      { error: { code: "composio_error", message: "Failed to initiate OAuth" } },
      502,
    );
  }

  return jsonResponse({ redirect_url: result.redirectUrl });
});
