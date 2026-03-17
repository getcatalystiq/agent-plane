import { NextRequest, NextResponse } from "next/server";
import { withErrorHandler } from "@/lib/api";
import { verifyMcpOAuthState } from "@/lib/mcp-oauth-state";
import { completeOAuth } from "@/lib/mcp-connections";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ mcpServerId: string }> };

/**
 * OAuth callback for MCP server connections.
 * This route bypasses auth middleware (see middleware.ts).
 * Security relies on the signed state parameter.
 */
export const GET = withErrorHandler(async (request: NextRequest, context) => {
  const { mcpServerId: urlMcpServerId } = await (context as RouteContext).params;
  const url = new URL(request.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const error = url.searchParams.get("error");

  // Handle OAuth error responses
  if (error) {
    const errorDesc = url.searchParams.get("error_description") ?? error;
    logger.warn("MCP OAuth callback received error", { error, errorDesc, mcpServerId: urlMcpServerId });
    return renderCallbackHtml(false, urlMcpServerId, "", errorDesc);
  }

  if (!code || !state) {
    return renderCallbackHtml(false, urlMcpServerId, "", "Missing code or state parameter");
  }

  // Verify signed state
  const payload = await verifyMcpOAuthState(state);
  if (!payload) {
    logger.warn("MCP OAuth callback: invalid or expired state", { mcpServerId: urlMcpServerId });
    return renderCallbackHtml(false, urlMcpServerId, "", "Invalid or expired state");
  }

  // Verify URL mcpServerId matches state mcpServerId
  if (payload.mcpServerId !== urlMcpServerId) {
    logger.warn("MCP OAuth callback: server ID mismatch", {
      urlMcpServerId,
      stateMcpServerId: payload.mcpServerId,
    });
    return renderCallbackHtml(false, urlMcpServerId, "", "Server ID mismatch");
  }

  // Complete the OAuth flow (exchanges code for tokens, stores in DB)
  // completeOAuth verifies status === 'initiated' and uses withTenantTransaction
  await completeOAuth({
    connectionId: payload.connectionId,
    tenantId: payload.tenantId,
    mcpServerId: payload.mcpServerId,
    code,
  });

  return renderCallbackHtml(true, payload.mcpServerId, payload.agentId);
});

function renderCallbackHtml(
  success: boolean,
  mcpServerId: string,
  agentId: string,
  errorMessage?: string,
): NextResponse {
  const html = `<!DOCTYPE html>
<html>
<head><title>AgentPlane MCP Connection</title></head>
<body>
<script>
  if (window.opener) {
    window.opener.postMessage({
      type: 'agent_plane_mcp_oauth_callback',
      success: ${success},
      mcpServerId: '${mcpServerId}',
      agentId: '${agentId}',
      ${errorMessage ? `error: ${JSON.stringify(errorMessage)},` : ""}
    }, window.location.origin);
    window.close();
  } else {
    window.location.href = '/admin/agents/${agentId}${success ? "?mcp_connected=1" : "?mcp_error=1"}';
  }
</script>
<p>${success ? "Connected successfully. This window will close." : `Connection failed: ${errorMessage ?? "Unknown error"}`}</p>
</body>
</html>`;

  return new NextResponse(html, {
    status: 200,
    headers: { "Content-Type": "text/html" },
  });
}
