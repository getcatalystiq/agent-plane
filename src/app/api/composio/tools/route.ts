import { NextRequest } from "next/server";
import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { checkRateLimit } from "@/lib/rate-limit";
import { RateLimitError, ValidationError } from "@/lib/errors";
import { listComposioTools } from "@/lib/composio";

export const dynamic = "force-dynamic";

const TOOLKIT_PATTERN = /^[a-z0-9_-]{1,100}$/;

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
    throw new ValidationError("toolkit must be lowercase alphanumeric with hyphens/underscores (max 100 chars)");
  }

  const tools = await listComposioTools(toolkit);
  return jsonResponse({ data: tools });
});
