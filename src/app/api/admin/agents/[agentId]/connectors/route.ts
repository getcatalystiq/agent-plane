import { NextRequest, NextResponse } from "next/server";
import { queryOne, execute } from "@/db";
import { AgentRow } from "@/lib/validation";
import { getConnectorStatuses, saveApiKeyConnector } from "@/lib/composio";
import { z } from "zod";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ agentId: string }> };

export async function GET(_request: NextRequest, context: RouteContext) {
  const { agentId } = await context.params;
  const agent = await queryOne(AgentRow, "SELECT * FROM agents WHERE id = $1", [agentId]);
  if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });

  const statuses = await getConnectorStatuses(agent.tenant_id, agent.composio_toolkits);
  return NextResponse.json({ connectors: statuses });
}

const SaveKeySchema = z.object({
  toolkit: z.string(),
  api_key: z.string().min(1),
});

export async function POST(request: NextRequest, context: RouteContext) {
  const { agentId } = await context.params;
  const agent = await queryOne(AgentRow, "SELECT * FROM agents WHERE id = $1", [agentId]);
  if (!agent) return NextResponse.json({ error: "Agent not found" }, { status: 404 });

  const body = await request.json();
  const { toolkit, api_key } = SaveKeySchema.parse(body);

  const result = await saveApiKeyConnector(agent.tenant_id, toolkit, api_key);

  // Clear the MCP cache so the next run rebuilds the server with proper auth configs
  await execute(
    `UPDATE agents SET composio_mcp_server_id = NULL, composio_mcp_server_name = NULL,
     composio_mcp_url = NULL, composio_mcp_api_key_enc = NULL WHERE id = $1`,
    [agentId],
  );

  return NextResponse.json(result);
}
