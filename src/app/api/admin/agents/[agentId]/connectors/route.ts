import { NextRequest, NextResponse } from "next/server";
import { queryOne } from "@/db";
import { AgentRow } from "@/lib/validation";
import {
  captureBotUserIdFromToken,
  getConnectorStatuses,
  removeToolkitConnections,
  saveCustomAuthConnector,
  sanitizeComposioError,
} from "@/lib/composio";
import {
  auditCredentialChange,
  deleteConnectionMetadata,
  readConnectionMetadata,
  upsertConnectionMetadata,
} from "@/lib/connection-metadata";
import { withErrorHandler } from "@/lib/api";
import { z } from "zod";
import type { AuthMethod, AuthScheme, ConnectionMetadata } from "@/lib/types";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ agentId: string }> };

// GET — list connector statuses, enriched with stored metadata + drift reconcile.
export const GET = withErrorHandler(async (_request: NextRequest, context) => {
  const { agentId } = await (context as RouteContext).params;
  const agent = await queryOne(AgentRow, "SELECT * FROM agents WHERE id = $1", [agentId]);
  if (!agent) {
    return NextResponse.json({ error: { code: "not_found", message: "Agent not found" } }, { status: 404 });
  }

  const statuses = await getConnectorStatuses(agent.tenant_id, agent.composio_toolkits);
  const stored = await readConnectionMetadata(agentId);
  const reconciled: typeof statuses = [];
  const driftedSlugs: string[] = [];

  for (const status of statuses) {
    const meta = stored[status.slug];
    if (meta && status.connectionStatus === null) {
      // Drift: stored entry but no live connection. Clear lazily.
      driftedSlugs.push(status.slug);
      reconciled.push(status);
      continue;
    }
    if (meta) {
      reconciled.push({
        ...status,
        selectedMethod: meta.auth_method,
        botUserId: meta.bot_user_id,
        displayName: meta.display_name,
        captureDeferred: !!meta.capture_deferred,
      });
    } else {
      reconciled.push(status);
    }
  }

  // Best-effort drift cleanup; failure does not break the response.
  await Promise.all(driftedSlugs.map((slug) => deleteConnectionMetadata(agentId, slug).catch(() => {})));

  return NextResponse.json({ connectors: reconciled });
});

// POST body: discriminated union over auth_method.
const SaveCustomTokenSchema = z.object({
  toolkit: z.string().min(1),
  auth_method: z.literal("custom_token"),
  scheme: z.enum(["API_KEY", "BEARER_TOKEN"]),
  token: z.string().min(1),
});

// Legacy shape — keep working until UI fully migrates.
const LegacyApiKeySchema = z.object({
  toolkit: z.string().min(1),
  api_key: z.string().min(1),
});

export const POST = withErrorHandler(async (request: NextRequest, context) => {
  const { agentId } = await (context as RouteContext).params;
  const agent = await queryOne(AgentRow, "SELECT * FROM agents WHERE id = $1", [agentId]);
  if (!agent) {
    return NextResponse.json({ error: { code: "not_found", message: "Agent not found" } }, { status: 404 });
  }

  const rawBody = await request.json();

  // Resolve to a normalized custom-token request from either the new or legacy shape.
  const customToken = SaveCustomTokenSchema.safeParse(rawBody);
  const legacy = LegacyApiKeySchema.safeParse(rawBody);

  let toolkit: string;
  let scheme: "API_KEY" | "BEARER_TOKEN";
  let token: string;
  if (customToken.success) {
    ({ toolkit, scheme, token } = customToken.data);
  } else if (legacy.success) {
    toolkit = legacy.data.toolkit;
    scheme = "API_KEY";
    token = legacy.data.api_key;
  } else {
    return NextResponse.json(
      { error: { code: "bad_request", message: "Unsupported request body" } },
      { status: 400 },
    );
  }

  const slugLower = toolkit.toLowerCase();
  const stored = await readConnectionMetadata(agentId);
  const previousMethod = stored[slugLower]?.auth_method;
  const switching = previousMethod && previousMethod !== "custom_token";

  // Save via Composio. If switching from a different method, the stale auth
  // config + connected account get cleaned up after the new one is in place.
  try {
    await saveCustomAuthConnector(agent.tenant_id, slugLower, scheme, token);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json(
      { error: { code: "bad_request", message: sanitizeComposioError(msg) } },
      { status: 400 },
    );
  }

  // Whoami capture: best-effort. The token never enters any logger sink.
  const whoami = await captureBotUserIdFromToken(slugLower, token);

  const entry: ConnectionMetadata = {
    auth_method: "custom_token",
    auth_scheme: scheme as AuthScheme,
    bot_user_id: whoami?.bot_user_id ?? null,
    display_name: whoami?.display_name ?? null,
    captured_at: whoami ? new Date().toISOString() : null,
  };
  await upsertConnectionMetadata(agentId, slugLower, entry);
  auditCredentialChange({
    agentId,
    tenantId: agent.tenant_id,
    slug: slugLower,
    authMethod: "custom_token",
    event: switching ? "replace" : "install",
  });

  // If switching from another method, scrub the prior auth config + connected
  // accounts AFTER the new connection is live. removeToolkitConnections deletes
  // ALL of this tenant's accounts on the slug — but the new save above just
  // refreshed the existing connected account in place rather than creating a
  // duplicate, so cleanup is a no-op. Future scheme switches that create a
  // genuinely new auth config will benefit from this hook.
  if (switching) {
    // No-op for now; placeholder for future scheme-switch cleanup.
  }

  return NextResponse.json({
    slug: slugLower,
    auth_method: "custom_token" as AuthMethod,
    bot_user_id: entry.bot_user_id,
    display_name: entry.display_name,
  });
});
