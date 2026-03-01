import { NextRequest, NextResponse } from "next/server";
import { withErrorHandler } from "@/lib/api";
import { queryOne, query } from "@/db";
import { AgentRow, McpConnectionRow, McpServerRow } from "@/lib/validation";
import { NotFoundError } from "@/lib/errors";
import type { AgentId, TenantId } from "@/lib/types";
import { z } from "zod";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ agentId: string }> };

const ConnectionWithServer = McpConnectionRow.extend({
  server_name: z.string(),
  server_slug: z.string(),
  server_logo_url: z.string().nullable(),
  server_base_url: z.string(),
});

export const GET = withErrorHandler(async (_request: NextRequest, context) => {
  const { agentId } = await (context as RouteContext).params;

  // Verify agent exists and get tenant_id
  const agent = await queryOne(AgentRow, "SELECT * FROM agents WHERE id = $1", [agentId]);
  if (!agent) throw new NotFoundError("Agent not found");

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

  return NextResponse.json({ data: connections });
});
