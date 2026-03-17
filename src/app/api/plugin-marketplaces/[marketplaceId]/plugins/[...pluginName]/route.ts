import { NextRequest, NextResponse } from "next/server";
import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { queryOne } from "@/db";
import { PluginMarketplaceRow, PluginManifestSchema } from "@/lib/validation";
import { NotFoundError } from "@/lib/errors";
import { fetchRepoTree, fetchRawContent } from "@/lib/github";
import { decrypt } from "@/lib/crypto";
import { getEnv } from "@/lib/env";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ marketplaceId: string; pluginName: string[] }> };

/**
 * Extract name and description from YAML frontmatter in a markdown file.
 * Returns null values if frontmatter is missing or malformed.
 */
function extractFrontmatter(content: string): { name: string | null; description: string | null } {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") return { name: null, description: null };

  const closingIndex = lines.findIndex((line, i) => i > 0 && line.trim() === "---");
  if (closingIndex === -1) return { name: null, description: null };

  const frontmatterLines = lines.slice(1, closingIndex);
  let name: string | null = null;
  let description: string | null = null;

  for (const line of frontmatterLines) {
    const nameMatch = line.match(/^name:\s*(.+)/);
    if (nameMatch) name = nameMatch[1].trim().replace(/^["']|["']$/g, "");

    const descMatch = line.match(/^description:\s*(.+)/);
    if (descMatch) description = descMatch[1].trim().replace(/^["']|["']$/g, "");
  }

  return { name, description };
}

/**
 * GET /api/plugin-marketplaces/:marketplaceId/plugins/:pluginName
 * Read-only tenant endpoint returning plugin metadata (agent/skill names + descriptions).
 */
export const GET = withErrorHandler(async (request: NextRequest, context) => {
  await authenticateApiKey(request.headers.get("authorization"));
  const { marketplaceId, pluginName: pluginNameSegments } = await (context as RouteContext).params;
  const pluginName = pluginNameSegments.join("/");

  const marketplace = await queryOne(
    PluginMarketplaceRow,
    "SELECT * FROM plugin_marketplaces WHERE id = $1",
    [marketplaceId],
  );
  if (!marketplace) throw new NotFoundError("Plugin marketplace not found");

  let token: string | undefined;
  if (marketplace.github_token_enc) {
    try {
      const env = getEnv();
      token = await decrypt(JSON.parse(marketplace.github_token_enc), env.ENCRYPTION_KEY, env.ENCRYPTION_KEY_PREVIOUS);
    } catch { /* fall through */ }
  }

  const [owner, repo] = marketplace.github_repo.split("/");
  const treeResult = await fetchRepoTree(owner, repo, token);
  if (!treeResult.ok) {
    return NextResponse.json(
      { error: `Failed to fetch repo tree: ${treeResult.message}` },
      { status: 502 },
    );
  }

  const tree = treeResult.data;

  // Verify plugin exists (has plugin.json)
  const hasManifest = tree.some(
    e => e.type === "blob" && e.path === `${pluginName}/.claude-plugin/plugin.json`,
  );
  if (!hasManifest) throw new NotFoundError("Plugin not found");

  // Fetch manifest for display info
  const manifestResult = await fetchRawContent(owner, repo, `${pluginName}/.claude-plugin/plugin.json`, token);
  let displayName = pluginName;
  let pluginDescription: string | null = null;
  let version: string | null = null;
  if (manifestResult.ok) {
    try {
      const manifest = PluginManifestSchema.parse(JSON.parse(manifestResult.data));
      displayName = manifest.name;
      pluginDescription = manifest.description ?? null;
      version = manifest.version ?? null;
    } catch { /* use defaults */ }
  }

  // Find agent and skill files
  const agentEntries = tree.filter(
    e => e.type === "blob" && e.path.startsWith(`${pluginName}/agents/`) && e.path.endsWith(".md"),
  );
  const skillEntries = tree.filter(
    e => e.type === "blob" && e.path.startsWith(`${pluginName}/skills/`),
  );

  // Fetch agent files to extract frontmatter metadata
  const agentMetadata = await Promise.all(
    agentEntries.map(async (entry) => {
      const filename = entry.path.split("/").pop() ?? "";
      const contentResult = await fetchRawContent(owner, repo, entry.path, token);
      if (!contentResult.ok) return null;
      const fm = extractFrontmatter(contentResult.data);
      return {
        filename,
        name: fm.name ?? filename.replace(/\.md$/, ""),
        description: fm.description,
      };
    }),
  );

  // Extract unique skill folder names (skills are folder-based: skills/<folder>/SKILL.md)
  const skillFolders = new Set<string>();
  for (const entry of skillEntries) {
    const relativePath = entry.path.replace(`${pluginName}/skills/`, "");
    const folder = relativePath.split("/")[0];
    if (folder) skillFolders.add(folder);
  }

  return jsonResponse({
    name: pluginName,
    displayName,
    description: pluginDescription,
    version,
    agents: agentMetadata.filter(Boolean),
    skills: [...skillFolders].sort(),
    hasMcpJson: tree.some(e => e.type === "blob" && e.path === `${pluginName}/.mcp.json`),
  });
});
