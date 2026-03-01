import { NextResponse } from "next/server";
import { withErrorHandler } from "@/lib/api";
import { listMcpServers } from "@/lib/mcp-connections";

export const dynamic = "force-dynamic";

// Tenant route: list available MCP servers from the registry
export const GET = withErrorHandler(async () => {
  const servers = await listMcpServers();
  return NextResponse.json({ data: servers });
});
