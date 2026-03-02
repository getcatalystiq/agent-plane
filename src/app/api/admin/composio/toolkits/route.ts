import { NextResponse } from "next/server";
import { withErrorHandler } from "@/lib/api";
import { listComposioToolkits } from "@/lib/composio";

export const dynamic = "force-dynamic";

export type ToolkitOption = { slug: string; name: string; logo: string };

export const GET = withErrorHandler(async () => {
  const toolkits = await listComposioToolkits();
  return NextResponse.json({ data: toolkits });
});
