import { NextRequest, NextResponse } from "next/server";
import { verifyOAuthState } from "@/lib/oauth-state";
import { withErrorHandler } from "@/lib/api";
import {
  captureBotUserIdFromConnectedAccount,
  getConnectorStatuses,
  pollConnectedAccountActive,
} from "@/lib/composio";
import {
  auditCredentialChange,
  upsertConnectionMetadata,
} from "@/lib/connection-metadata";
import type { AuthMethod, ConnectionMetadata } from "@/lib/types";

export const dynamic = "force-dynamic";

// OAuth callback — handles both managed-OAuth and bring-your-own-app paths.
// Verifies signed state for CSRF, then polls the just-created connected
// account until ACTIVE, runs whoami, and persists metadata. The OAuth flow
// itself is unaffected — this only adds identity capture and metadata write
// alongside the existing redirect/popup-message response.
export const GET = withErrorHandler(async (request: NextRequest) => {
  const mode = request.nextUrl.searchParams.get("mode");
  const state = request.nextUrl.searchParams.get("state");

  const payload = state ? await verifyOAuthState(state) : null;
  if (!payload) {
    return NextResponse.json(
      { error: { code: "invalid_state", message: "Invalid or expired OAuth state" } },
      { status: 400 },
    );
  }

  const slugLower = payload.toolkit.toLowerCase();
  const authMethod: AuthMethod = payload.authMethod ?? "composio_oauth";

  // Look up the just-created connected account for this tenant + slug. We
  // don't have the connectedAccountId in the redirect URL, so resolve via
  // Composio. Failure here doesn't block the response — the user still sees
  // a successful page and metadata capture is deferred.
  const statuses = await getConnectorStatuses(payload.agentId, [slugLower]);
  const status = statuses[0];
  const connectedAccountId = status?.connectedAccountId ?? null;
  const primaryScheme = status?.primaryScheme ?? "OAUTH2";

  if (connectedAccountId) {
    const poll = await pollConnectedAccountActive(connectedAccountId);
    let entry: ConnectionMetadata;
    if (poll.status === "ACTIVE") {
      const whoami = await captureBotUserIdFromConnectedAccount(slugLower, connectedAccountId);
      entry = {
        auth_method: authMethod,
        auth_scheme: primaryScheme,
        bot_user_id: whoami?.bot_user_id ?? null,
        display_name: whoami?.display_name ?? null,
        captured_at: whoami ? new Date().toISOString() : null,
        capture_deferred: !whoami,
      };
    } else {
      // Connection isn't ACTIVE within budget — defer capture to a later
      // recapture call. The connection itself is still legitimate; Composio
      // typically activates within 1-2 seconds but slow IdPs can exceed the
      // 5-second poll budget.
      entry = {
        auth_method: authMethod,
        auth_scheme: primaryScheme,
        bot_user_id: null,
        display_name: null,
        captured_at: null,
        capture_deferred: true,
      };
    }
    await upsertConnectionMetadata(payload.agentId, slugLower, entry);
    auditCredentialChange({
      agentId: payload.agentId,
      tenantId: payload.tenantId,
      slug: slugLower,
      authMethod,
      event: "install",
    });
  }

  // Popup mode: return HTML that posts message to opener and closes.
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

  // Default: redirect back to the agent detail page.
  const adminUrl = new URL(`/admin/agents/${payload.agentId}`, request.url);
  adminUrl.searchParams.set("connected", "1");
  return NextResponse.redirect(adminUrl.toString());
});
