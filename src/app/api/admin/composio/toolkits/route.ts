import { NextResponse } from "next/server";
import ComposioClient from "@composio/client";
import { withErrorHandler } from "@/lib/api";

export const dynamic = "force-dynamic";

export interface ToolkitOption {
  slug: string;
  name: string;
  logo: string;
}

export const GET = withErrorHandler(async () => {
  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ data: [] });
  }

  const client = new ComposioClient({ apiKey });

  // Fetch all toolkits in one request (max 1000), sorted alphabetically
  const response = await client.toolkits.list({
    limit: 1000,
    sort_by: "alphabetically",
    include_deprecated: false,
  });

  const toolkits: ToolkitOption[] = response.items.map((t) => ({
    slug: t.slug,
    name: t.name,
    logo: t.meta.logo,
  }));

  return NextResponse.json({ data: toolkits });
});
