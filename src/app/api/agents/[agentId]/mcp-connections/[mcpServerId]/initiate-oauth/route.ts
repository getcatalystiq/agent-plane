import { NextRequest } from "next/server";
import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { getAgentForTenant } from "@/lib/agents";
import { initiateOAuth, getCallbackBaseUrl } from "@/lib/mcp-connections";
import type { AgentId, McpServerId } from "@/lib/types";

export const dynamic = "force-dynamic";

export const POST = withErrorHandler(async (request: NextRequest, context) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const { agentId, mcpServerId } = await context!.params;

  await getAgentForTenant(agentId, auth.tenantId);

  const result = await initiateOAuth({
    mcpServerId: mcpServerId as McpServerId,
    agentId: agentId as AgentId,
    tenantId: auth.tenantId,
    callbackBaseUrl: getCallbackBaseUrl(),
  });

  return jsonResponse(result);
});
