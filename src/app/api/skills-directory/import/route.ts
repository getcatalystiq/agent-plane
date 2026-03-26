import { NextRequest } from "next/server";
import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { checkRateLimit } from "@/lib/rate-limit";
import { RateLimitError } from "@/lib/errors";
import { parseSkillsShUrl, importSkillContent } from "@/lib/skills-directory";
import { z } from "zod";

export const dynamic = "force-dynamic";

const ImportBodySchema = z.union([
  z.object({ owner: z.string().min(1), repo: z.string().min(1), skill_name: z.string().min(1) }),
  z.object({ url: z.string().min(1) }),
]);

// POST /api/skills-directory/import — import skill content from GitHub (tenant-scoped, rate-limited)
export const POST = withErrorHandler(async (request: NextRequest) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));

  const { allowed } = checkRateLimit(`skills-dir:${auth.tenantId}`, 10, 60_000);
  if (!allowed) throw new RateLimitError(60);

  const body = await request.json();
  const parsed = ImportBodySchema.safeParse(body);
  if (!parsed.success) {
    return jsonResponse({ error: "Request body must include either { owner, repo, skill_name } or { url }" }, 400);
  }

  let owner: string;
  let repo: string;
  let skillName: string;

  if ("url" in parsed.data) {
    const urlParsed = parseSkillsShUrl(parsed.data.url);
    if (!urlParsed) {
      return jsonResponse({ error: "Invalid skills.sh URL. Expected format: skills.sh/owner/repo/skill or owner/repo/skill" }, 400);
    }
    owner = urlParsed.owner;
    repo = urlParsed.repo;
    skillName = urlParsed.skill;
  } else {
    owner = parsed.data.owner;
    repo = parsed.data.repo;
    skillName = parsed.data.skill_name;
  }

  const result = await importSkillContent(owner, repo, skillName);
  if (result.ok === true) {
    return jsonResponse({ data: result.data });
  }

  const status = result.error === "not_found" ? 404 : result.error === "rate_limited" ? 429 : 502;
  return jsonResponse({ error: result.message }, status);
});
