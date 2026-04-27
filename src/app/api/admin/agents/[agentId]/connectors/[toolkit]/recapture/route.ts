import { NextRequest, NextResponse } from "next/server";
import { queryOne } from "@/db";
import { AgentRow } from "@/lib/validation";
import { withErrorHandler } from "@/lib/api";
import {
  captureBotUserIdFromConnectedAccount,
  getConnectorStatuses,
} from "@/lib/composio";
import {
  auditCredentialChange,
  readConnectionMetadata,
  upsertConnectionMetadata,
} from "@/lib/connection-metadata";
import type { ConnectionMetadata } from "@/lib/types";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ agentId: string; toolkit: string }> };

// POST — re-run identity capture for a connected toolkit. Used when the
// initial whoami timed out (capture_deferred=true) or when the user wants to
// refresh display_name after rotating the integration's name.
export const POST = withErrorHandler(async (_request: NextRequest, context) => {
  const { agentId, toolkit } = await (context as RouteContext).params;
  const slugLower = toolkit.toLowerCase();

  const agent = await queryOne(AgentRow, "SELECT * FROM agents WHERE id = $1", [agentId]);
  if (!agent) {
    return NextResponse.json(
      { error: { code: "not_found", message: "Agent not found" } },
      { status: 404 },
    );
  }

  const statuses = await getConnectorStatuses(agent.tenant_id, [slugLower]);
  const status = statuses[0];
  if (!status?.connectedAccountId || status.connectionStatus !== "ACTIVE") {
    return NextResponse.json(
      { error: { code: "not_connected", message: "No active connection for toolkit" } },
      { status: 409 },
    );
  }

  const stored = await readConnectionMetadata(agentId);
  const previous = stored[slugLower];

  const whoami = await captureBotUserIdFromConnectedAccount(
    slugLower,
    status.connectedAccountId,
  );

  const entry: ConnectionMetadata = {
    auth_method: previous?.auth_method ?? "composio_oauth",
    auth_scheme: previous?.auth_scheme ?? status.primaryScheme,
    bot_user_id: whoami?.bot_user_id ?? null,
    display_name: whoami?.display_name ?? null,
    captured_at: whoami ? new Date().toISOString() : null,
    capture_deferred: !whoami,
  };
  await upsertConnectionMetadata(agentId, slugLower, entry);
  auditCredentialChange({
    agentId,
    tenantId: agent.tenant_id,
    slug: slugLower,
    authMethod: entry.auth_method,
    event: "recapture",
  });

  return NextResponse.json({
    slug: slugLower,
    bot_user_id: entry.bot_user_id,
    display_name: entry.display_name,
    capture_deferred: entry.capture_deferred,
  });
});
