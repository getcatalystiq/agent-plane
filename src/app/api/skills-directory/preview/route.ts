import { NextRequest } from "next/server";
import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { checkRateLimit } from "@/lib/rate-limit";
import { RateLimitError } from "@/lib/errors";
import { previewSkill } from "@/lib/skills-directory";

export const dynamic = "force-dynamic";

// GET /api/skills-directory/preview — preview SKILL.md content (tenant-scoped, rate-limited)
export const GET = withErrorHandler(async (request: NextRequest) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));

  const { allowed } = checkRateLimit(`skills-dir:${auth.tenantId}`, 30, 60_000);
  if (!allowed) throw new RateLimitError(60);

  const owner = request.nextUrl.searchParams.get("owner");
  const repo = request.nextUrl.searchParams.get("repo");
  const skill = request.nextUrl.searchParams.get("skill");

  if (!owner || !repo || !skill) {
    return jsonResponse({ error: "Missing required query parameters: owner, repo, skill" }, 400);
  }

  const result = await previewSkill(owner, repo, skill);
  if (result.ok === true) {
    return jsonResponse({ data: { content: result.data } });
  }

  const status = result.error === "not_found" ? 404 : 502;
  return jsonResponse({ error: result.message }, status);
});
