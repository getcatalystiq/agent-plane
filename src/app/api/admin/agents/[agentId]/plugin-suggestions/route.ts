import { NextRequest, NextResponse } from "next/server";
import { queryOne } from "@/db";
import { AgentRow } from "@/lib/validation";
import { withErrorHandler } from "@/lib/api";
import { NotFoundError } from "@/lib/errors";
import { fetchPluginMcpSuggestions } from "@/lib/plugins";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ agentId: string }> };

export const GET = withErrorHandler(async (_request: NextRequest, context) => {
  const { agentId } = await (context as RouteContext).params;

  const agent = await queryOne(AgentRow, "SELECT * FROM agents WHERE id = $1", [agentId]);
  if (!agent) throw new NotFoundError("Agent not found");

  if (!agent.plugins || agent.plugins.length === 0) {
    return NextResponse.json({ data: [] });
  }

  const { suggestions, warnings } = await fetchPluginMcpSuggestions(agent.plugins);

  // Filter out connectors already connected via Composio
  const connectedSlugs = new Set(agent.composio_toolkits.map((t) => t.toUpperCase()));
  const filtered = suggestions.filter((s) => !connectedSlugs.has(s.composio_slug));

  return NextResponse.json({ data: filtered, warnings });
});
