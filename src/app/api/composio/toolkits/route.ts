import { NextRequest } from "next/server";
import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { checkRateLimit } from "@/lib/rate-limit";
import { RateLimitError } from "@/lib/errors";
import { listComposioToolkits } from "@/lib/composio";

export const dynamic = "force-dynamic";

// GET /api/composio/toolkits — list available Composio toolkits (tenant-scoped, rate-limited)
export const GET = withErrorHandler(async (request: NextRequest) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));

  const { allowed } = checkRateLimit(`composio:${auth.tenantId}`, 30, 60_000);
  if (!allowed) throw new RateLimitError(60);

  const toolkits = await listComposioToolkits();
  return jsonResponse({ data: toolkits });
});
