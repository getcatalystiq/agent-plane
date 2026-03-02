import { NextRequest, NextResponse } from "next/server";
import ComposioClient from "@composio/client";
import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { checkRateLimit } from "@/lib/rate-limit";
import { RateLimitError } from "@/lib/errors";

export const dynamic = "force-dynamic";

// GET /api/composio/toolkits — list available Composio toolkits (tenant-scoped, rate-limited)
export const GET = withErrorHandler(async (request: NextRequest) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));

  const { allowed } = checkRateLimit(`composio:${auth.tenantId}`, 30, 60_000);
  if (!allowed) throw new RateLimitError(60);

  const apiKey = process.env.COMPOSIO_API_KEY;
  if (!apiKey) {
    return jsonResponse({ data: [] });
  }

  const client = new ComposioClient({ apiKey });

  const response = await client.toolkits.list({
    limit: 1000,
    sort_by: "alphabetically",
    include_deprecated: false,
  });

  const toolkits = response.items.map((t) => ({
    slug: t.slug,
    name: t.name,
    logo: t.meta.logo,
  }));

  return jsonResponse({ data: toolkits });
});
