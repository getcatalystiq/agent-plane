import { NextRequest, NextResponse } from "next/server";
import { queryOne } from "@/db";
import { AgentRow } from "@/lib/validation";
import { getConnectorStatuses, saveApiKeyConnector, sanitizeComposioError } from "@/lib/composio";
import { withErrorHandler } from "@/lib/api";
import { z } from "zod";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ agentId: string }> };

export const GET = withErrorHandler(async (_request: NextRequest, context) => {
  const { agentId } = await (context as RouteContext).params;
  const agent = await queryOne(AgentRow, "SELECT * FROM agents WHERE id = $1", [agentId]);
  if (!agent) return NextResponse.json({ error: { code: "not_found", message: "Agent not found" } }, { status: 404 });

  const statuses = await getConnectorStatuses(agent.tenant_id, agent.composio_toolkits);
  return NextResponse.json({ connectors: statuses });
});

const SaveKeySchema = z.object({
  toolkit: z.string(),
  api_key: z.string().min(1),
});

export const POST = withErrorHandler(async (request: NextRequest, context) => {
  const { agentId } = await (context as RouteContext).params;
  const agent = await queryOne(AgentRow, "SELECT * FROM agents WHERE id = $1", [agentId]);
  if (!agent) return NextResponse.json({ error: { code: "not_found", message: "Agent not found" } }, { status: 404 });

  const body = await request.json();
  const { toolkit, api_key } = SaveKeySchema.parse(body);

  let result: Awaited<ReturnType<typeof saveApiKeyConnector>>;
  try {
    result = await saveApiKeyConnector(agent.tenant_id, toolkit, api_key);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: { code: "bad_request", message: sanitizeComposioError(msg) } }, { status: 400 });
  }

  return NextResponse.json(result);
});
