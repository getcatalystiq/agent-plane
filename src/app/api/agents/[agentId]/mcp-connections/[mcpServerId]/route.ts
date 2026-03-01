import { NextRequest } from "next/server";
import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { getAgentForTenant } from "@/lib/agents";
import { NotFoundError } from "@/lib/errors";
import { deleteConnection, updateAllowedTools } from "@/lib/mcp-connections";
import { UpdateMcpConnectionSchema } from "@/lib/validation";
import type { AgentId, McpServerId, TenantId } from "@/lib/types";

export const dynamic = "force-dynamic";

export const DELETE = withErrorHandler(async (request: NextRequest, context) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const { agentId, mcpServerId } = await context!.params;

  await getAgentForTenant(agentId, auth.tenantId);

  const deleted = await deleteConnection(
    agentId as AgentId,
    mcpServerId as McpServerId,
    auth.tenantId,
  );
  if (!deleted) throw new NotFoundError("Connection not found");

  return jsonResponse({ deleted: true });
});

export const PATCH = withErrorHandler(async (request: NextRequest, context) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const { agentId, mcpServerId } = await context!.params;
  const body = await request.json();
  const input = UpdateMcpConnectionSchema.parse(body);

  await getAgentForTenant(agentId, auth.tenantId);

  await updateAllowedTools(
    agentId as AgentId,
    mcpServerId as McpServerId,
    auth.tenantId,
    input.allowed_tools,
  );

  return jsonResponse({ updated: true });
});
