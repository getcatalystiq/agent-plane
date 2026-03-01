import { NextRequest, NextResponse } from "next/server";
import { withErrorHandler } from "@/lib/api";
import { queryOne } from "@/db";
import { AgentRow, UpdateMcpConnectionSchema } from "@/lib/validation";
import { NotFoundError } from "@/lib/errors";
import { deleteConnection, updateAllowedTools } from "@/lib/mcp-connections";
import type { AgentId, McpServerId, TenantId } from "@/lib/types";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ agentId: string; mcpServerId: string }> };

export const DELETE = withErrorHandler(async (_request: NextRequest, context) => {
  const { agentId, mcpServerId } = await (context as RouteContext).params;

  const agent = await queryOne(AgentRow, "SELECT * FROM agents WHERE id = $1", [agentId]);
  if (!agent) throw new NotFoundError("Agent not found");

  const deleted = await deleteConnection(
    agentId as AgentId,
    mcpServerId as McpServerId,
    agent.tenant_id as TenantId,
  );
  if (!deleted) throw new NotFoundError("Connection not found");

  return NextResponse.json({ deleted: true });
});

export const PATCH = withErrorHandler(async (request: NextRequest, context) => {
  const { agentId, mcpServerId } = await (context as RouteContext).params;
  const body = await request.json();
  const input = UpdateMcpConnectionSchema.parse(body);

  const agent = await queryOne(AgentRow, "SELECT * FROM agents WHERE id = $1", [agentId]);
  if (!agent) throw new NotFoundError("Agent not found");

  await updateAllowedTools(
    agentId as AgentId,
    mcpServerId as McpServerId,
    agent.tenant_id as TenantId,
    input.allowed_tools,
  );

  return NextResponse.json({ updated: true });
});
