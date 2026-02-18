import { NextRequest, NextResponse } from "next/server";
import ComposioClient from "@composio/client";
import { withErrorHandler } from "@/lib/api";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (request: NextRequest) => {
  const toolkit = request.nextUrl.searchParams.get("toolkit");
  if (!toolkit) {
    return NextResponse.json({ error: "toolkit query parameter is required" }, { status: 400 });
  }

  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) {
    return NextResponse.json({ data: [] });
  }

  const client = new ComposioClient({ apiKey });
  const slugLower = toolkit.toLowerCase();

  // Fetch all pages — the API may paginate even with a high limit,
  // and defaults to only "important" tools unless explicitly disabled.
  const allItems: { slug: string; name: string; description: string }[] = [];
  let cursor: string | undefined;

  do {
    const response = await client.tools.list({
      toolkit_slug: slugLower,
      limit: 200,
      important: "false",
      toolkit_versions: "latest",
      ...(cursor ? { cursor } : {}),
    });
    for (const t of response.items) {
      allItems.push({ slug: t.slug, name: t.name, description: t.description ?? "" });
    }
    cursor = response.next_cursor ?? undefined;
  } while (cursor);

  return NextResponse.json({ data: allItems });
});
