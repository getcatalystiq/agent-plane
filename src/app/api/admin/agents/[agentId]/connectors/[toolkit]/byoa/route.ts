import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { queryOne } from "@/db";
import { AgentRow } from "@/lib/validation";
import { initiateByoaOAuthConnector } from "@/lib/composio";
import { signOAuthState } from "@/lib/oauth-state";
import { withErrorHandler } from "@/lib/api";
import { auditCredentialChange } from "@/lib/connection-metadata";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const COMPOSIO_REDIRECT_HOPS = 3;
const COMPOSIO_REDIRECT_TIMEOUT_MS = 5000;

/**
 * Follow up to N redirects (without auto-following) and return the final URL
 * with `actor=app` appended. Stops as soon as we land on a linear.app host
 * (we only want to mutate Linear's URL, not Composio intermediates). Returns
 * the original `shortLink` unchanged on any failure — the BYOA flow still
 * works, the user just authorizes as themselves instead of as the app.
 */
async function resolveAndAppendActorApp(shortLink: string): Promise<string> {
  let current = shortLink;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), COMPOSIO_REDIRECT_TIMEOUT_MS);
  try {
    for (let hop = 0; hop < COMPOSIO_REDIRECT_HOPS; hop++) {
      const res = await fetch(current, { redirect: "manual", signal: ctrl.signal });
      if (res.status < 300 || res.status >= 400) break;
      const loc = res.headers.get("location");
      if (!loc) break;
      current = new URL(loc, current).toString();
      const host = new URL(current).hostname;
      if (host.endsWith("linear.app")) {
        const u = new URL(current);
        u.searchParams.set("actor", "app");
        return u.toString();
      }
    }
    logger.warn("linear_byoa_redirect_resolve_no_linear_host", { last: current });
    return shortLink;
  } catch (err) {
    logger.warn("linear_byoa_redirect_resolve_failed", {
      error: err instanceof Error ? err.message : String(err),
    });
    return shortLink;
  } finally {
    clearTimeout(timer);
  }
}

type RouteContext = { params: Promise<{ agentId: string; toolkit: string }> };

const BodySchema = z.object({
  client_id: z.string().min(1),
  client_secret: z.string().min(1),
});

// POST /api/admin/agents/:agentId/connectors/:toolkit/byoa
//
// Tenant supplies their own OAuth app credentials. We create a per-tenant
// auth_config in Composio loaded with `shared_credentials: { client_id,
// client_secret }`, then return the redirect URL pointing at our existing
// callback handler. The callback URL embeds the same signed state token as
// the managed-OAuth path (CSRF defense reused).
//
// Credentials never re-enter any structured log line. They land in the
// Composio side via the SDK call and are dropped from this handler's scope on
// return.
export const POST = withErrorHandler(async (request: NextRequest, context) => {
  const { agentId, toolkit } = await (context as RouteContext).params;

  const agent = await queryOne(AgentRow, "SELECT * FROM agents WHERE id = $1", [agentId]);
  if (!agent) {
    return NextResponse.json(
      { error: { code: "not_found", message: "Agent not found" } },
      { status: 404 },
    );
  }

  // Validate body. Do NOT echo the parsed body back in any error path.
  let credentials: z.infer<typeof BodySchema>;
  try {
    credentials = BodySchema.parse(await request.json());
  } catch {
    return NextResponse.json(
      { error: { code: "bad_request", message: "client_id and client_secret are required" } },
      { status: 400 },
    );
  }

  const state = await signOAuthState({
    agentId,
    tenantId: agent.tenant_id,
    toolkit,
    authMethod: "byoa_oauth",
  });
  const callbackUrl = new URL(
    `/api/admin/agents/${agentId}/connectors/${toolkit}/callback?mode=popup&state=${encodeURIComponent(state)}`,
    request.url,
  ).toString();

  const result = await initiateByoaOAuthConnector(
    agent.id,
    toolkit,
    credentials.client_id,
    credentials.client_secret,
    callbackUrl,
  );

  if (!result) {
    return NextResponse.json(
      { error: { code: "upstream_error", message: "Failed to initiate BYOA OAuth" } },
      { status: 502 },
    );
  }

  auditCredentialChange({
    agentId,
    tenantId: agent.tenant_id,
    slug: toolkit.toLowerCase(),
    authMethod: "byoa_oauth",
    event: "install",
  });

  // Per-toolkit OAuth-URL tweaks for attribution. Linear's default OAuth
  // attributes writes to the authorizing user; `actor=app` tells Linear to
  // install the app as a bot user so writes attribute to the app itself.
  // Composio's BYOA flow does not surface this toggle, so we append it.
  //
  // Composio returns a short-link (https://backend.composio.dev/api/v3/s/...)
  // that 302s to the real Linear authorize URL. Appending `actor=app` to the
  // short-link does NOT propagate downstream (Composio rebuilds the Linear URL
  // server-side from the auth_config). To make the param actually reach Linear,
  // we follow the redirect ourselves, capture the resolved authorize URL, and
  // append `actor=app` to that. Falls back to the short-link if resolution
  // fails (so the user can still complete the flow without `actor=app`).
  const slug = toolkit.toLowerCase();
  let redirectUrl = result.redirectUrl;
  let attributionNote: string | null = null;
  if (slug === "linear") {
    redirectUrl = await resolveAndAppendActorApp(result.redirectUrl);
    attributionNote =
      "Linear's default OAuth attributes writes to the authorizing user. We added actor=app so the OAuth app installs as a bot user — writes will be attributed to the app, not to you. The bot will appear in your Linear workspace's member list after you authorize.";
  }

  return NextResponse.json({
    redirect_url: redirectUrl,
    ...(attributionNote ? { attribution_note: attributionNote } : {}),
  });
});
