import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ agentId: string; toolkit: string }> };

// OAuth callback — redirect back to the agent detail page
export async function GET(request: NextRequest, context: RouteContext) {
  const { agentId } = await context.params;
  const adminUrl = new URL(`/admin/agents/${agentId}`, request.url);
  adminUrl.searchParams.set("connected", "1");
  return NextResponse.redirect(adminUrl.toString());
}
