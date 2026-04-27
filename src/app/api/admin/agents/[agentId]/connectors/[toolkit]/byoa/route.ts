import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { queryOne } from "@/db";
import { AgentRow } from "@/lib/validation";
import { initiateByoaOAuthConnector } from "@/lib/composio";
import { signOAuthState } from "@/lib/oauth-state";
import { withErrorHandler } from "@/lib/api";
import { auditCredentialChange } from "@/lib/connection-metadata";

export const dynamic = "force-dynamic";

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
    agent.tenant_id,
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

  return NextResponse.json({ redirect_url: result.redirectUrl });
});
