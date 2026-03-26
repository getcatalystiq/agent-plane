import { NextRequest } from "next/server";
import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { checkRateLimit } from "@/lib/rate-limit";
import { RateLimitError } from "@/lib/errors";
import { fetchSkillsDirectory, type SkillsTab } from "@/lib/skills-directory";

export const dynamic = "force-dynamic";

const VALID_TABS = new Set<SkillsTab>(["all", "trending", "hot"]);

// GET /api/skills-directory — list skills from skills.sh (tenant-scoped, rate-limited)
export const GET = withErrorHandler(async (request: NextRequest) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));

  const { allowed } = checkRateLimit(`skills-dir:${auth.tenantId}`, 30, 60_000);
  if (!allowed) throw new RateLimitError(60);

  const tab = (request.nextUrl.searchParams.get("tab") ?? "all") as SkillsTab;
  if (!VALID_TABS.has(tab)) {
    return jsonResponse({ error: "Invalid tab parameter. Must be: all, trending, or hot" }, 400);
  }

  const result = await fetchSkillsDirectory(tab);
  if (!result.ok) {
    return jsonResponse({ error: result.error }, 502);
  }

  return jsonResponse({ data: result.data });
});
