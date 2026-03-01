import { NextRequest, NextResponse } from "next/server";
import { withErrorHandler } from "@/lib/api";
import { queryOne } from "@/db";
import { AgentRow } from "@/lib/validation";
import { NotFoundError } from "@/lib/errors";
import { initiateOAuth, getCallbackBaseUrl } from "@/lib/mcp-connections";
import type { AgentId, McpServerId, TenantId } from "@/lib/types";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ agentId: string; mcpServerId: string }> };

export const POST = withErrorHandler(async (_request: NextRequest, context) => {
  const { agentId, mcpServerId } = await (context as RouteContext).params;

  const agent = await queryOne(AgentRow, "SELECT * FROM agents WHERE id = $1", [agentId]);
  if (!agent) throw new NotFoundError("Agent not found");

  const result = await initiateOAuth({
    mcpServerId: mcpServerId as McpServerId,
    agentId: agentId as AgentId,
    tenantId: agent.tenant_id as TenantId,
    callbackBaseUrl: getCallbackBaseUrl(),
  });

  return NextResponse.json(result);
});
