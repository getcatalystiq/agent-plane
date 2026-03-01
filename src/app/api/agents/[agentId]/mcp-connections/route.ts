import { NextRequest } from "next/server";
import { z } from "zod";
import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { query } from "@/db";
import { getAgentForTenant } from "@/lib/agents";
import { McpConnectionRow, McpServerRow } from "@/lib/validation";

export const dynamic = "force-dynamic";

const ConnectionWithServer = McpConnectionRow.extend({
  server_name: z.string(),
  server_slug: z.string(),
  server_logo_url: z.string().nullable(),
  server_base_url: z.string(),
});

export const GET = withErrorHandler(async (request: NextRequest, context) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const { agentId } = await context!.params;

  const agent = await getAgentForTenant(agentId, auth.tenantId);

  const connections = await query(
    ConnectionWithServer,
    `SELECT mc.id, mc.tenant_id, mc.agent_id, mc.mcp_server_id, mc.status,
            mc.granted_scopes, mc.allowed_tools, mc.token_expires_at,
            mc.created_at, mc.updated_at,
            ms.name AS server_name, ms.slug AS server_slug,
            ms.logo_url AS server_logo_url, ms.base_url AS server_base_url
     FROM mcp_connections mc
     JOIN mcp_servers ms ON ms.id = mc.mcp_server_id
     WHERE mc.agent_id = $1 AND mc.tenant_id = $2
     ORDER BY mc.created_at`,
    [agentId, agent.tenant_id],
  );

  return jsonResponse({ data: connections });
});
