import { NextRequest, NextResponse } from "next/server";
import { verifyOAuthState } from "@/lib/oauth-state";

export const dynamic = "force-dynamic";

// GET /api/agents/:agentId/connectors/:toolkit/callback
// OAuth callback — unauthenticated (redirect from external provider).
// Supports popup mode (postMessage + close) and JSON mode.
export async function GET(request: NextRequest) {
  const mode = request.nextUrl.searchParams.get("mode");
  const state = request.nextUrl.searchParams.get("state");

  // Verify signed state parameter for CSRF protection
  const payload = state ? await verifyOAuthState(state) : null;
  if (!payload) {
    return NextResponse.json(
      { error: { code: "invalid_state", message: "Invalid or expired OAuth state" } },
      { status: 400 },
    );
  }

  // Popup mode: return HTML that posts message to opener and closes
  if (mode === "popup") {
    const origin = process.env.ADMIN_ORIGIN || request.nextUrl.origin;
    const html = `<!DOCTYPE html>
<html>
<head><title>Connected</title></head>
<body>
<p>Connected successfully. This window will close.</p>
<script>
  if (window.opener) {
    window.opener.postMessage(
      { type: 'agent_plane_oauth_callback', success: true, toolkit: ${JSON.stringify(payload.toolkit)}, agentId: ${JSON.stringify(payload.agentId)} },
      ${JSON.stringify(origin)}
    );
  }
  window.close();
</script>
</body>
</html>`;
    return new NextResponse(html, {
      headers: { "Content-Type": "text/html" },
    });
  }

  // Default: return JSON with connection info
  return NextResponse.json({
    agent_id: payload.agentId,
    toolkit: payload.toolkit,
    status: "connected",
  });
}
