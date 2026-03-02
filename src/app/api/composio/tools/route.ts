import { NextRequest } from "next/server";
import ComposioClient from "@composio/client";
import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { checkRateLimit } from "@/lib/rate-limit";
import { RateLimitError, ValidationError } from "@/lib/errors";

export const dynamic = "force-dynamic";

const TOOLKIT_PATTERN = /^[a-z0-9_-]+$/;

// GET /api/composio/tools?toolkit=X — list tools in a toolkit (tenant-scoped, rate-limited)
export const GET = withErrorHandler(async (request: NextRequest) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));

  const { allowed } = checkRateLimit(`composio:${auth.tenantId}`, 30, 60_000);
  if (!allowed) throw new RateLimitError(60);

  const toolkit = request.nextUrl.searchParams.get("toolkit");
  if (!toolkit) {
    throw new ValidationError("toolkit query parameter is required");
  }
  if (!TOOLKIT_PATTERN.test(toolkit)) {
    throw new ValidationError("toolkit must be lowercase alphanumeric with hyphens/underscores");
  }

  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) {
    return jsonResponse({ data: [] });
  }

  const client = new ComposioClient({ apiKey });
  const slugLower = toolkit.toLowerCase();

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

  return jsonResponse({ data: allItems });
});
