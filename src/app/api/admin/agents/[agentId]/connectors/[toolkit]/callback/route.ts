import { NextRequest, NextResponse } from "next/server";
import { verifyOAuthState } from "@/lib/oauth-state";
import { withErrorHandler } from "@/lib/api";

export const dynamic = "force-dynamic";

// OAuth callback — handles both redirect mode and popup mode.
// Verifies signed state parameter for CSRF protection.
export const GET = withErrorHandler(async (request: NextRequest) => {
  const mode = request.nextUrl.searchParams.get("mode");
  const state = request.nextUrl.searchParams.get("state");

  // Verify signed state for CSRF protection
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
      { type: 'agentplane_oauth_callback', success: true, toolkit: ${JSON.stringify(payload.toolkit)}, agentId: ${JSON.stringify(payload.agentId)} },
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

  // Default: redirect back to the agent detail page
  const adminUrl = new URL(`/admin/agents/${payload.agentId}`, request.url);
  adminUrl.searchParams.set("connected", "1");
  return NextResponse.redirect(adminUrl.toString());
});
