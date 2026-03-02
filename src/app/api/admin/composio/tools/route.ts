import { NextRequest, NextResponse } from "next/server";
import { withErrorHandler } from "@/lib/api";
import { listComposioTools } from "@/lib/composio";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (request: NextRequest) => {
  const toolkit = request.nextUrl.searchParams.get("toolkit");
  if (!toolkit) {
    return NextResponse.json({ error: "toolkit query parameter is required" }, { status: 400 });
  }

  const tools = await listComposioTools(toolkit);
  return NextResponse.json({ data: tools });
});
