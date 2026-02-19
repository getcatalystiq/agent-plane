import { NextRequest, NextResponse } from "next/server";
import { queryOne } from "@/db";
import { PluginMarketplaceRow, PluginMcpJsonSchema, SafePluginFilename } from "@/lib/validation";
import { withErrorHandler } from "@/lib/api";
import { NotFoundError, ForbiddenError, ConflictError, ValidationError } from "@/lib/errors";
import { fetchRepoTree, fetchRawContent, pushFiles, getDefaultBranch } from "@/lib/github";
import { clearPluginCache, cacheRecentPush } from "@/lib/plugins";
import { decrypt } from "@/lib/crypto";
import { getEnv } from "@/lib/env";
import { z } from "zod";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ marketplaceId: string; pluginName: string }> };

function getGlobalToken(): string | undefined {
  try {
    return getEnv().GITHUB_TOKEN;
  } catch {
    return undefined;
  }
}

async function getMarketplaceToken(marketplace: z.infer<typeof PluginMarketplaceRow>): Promise<string | undefined> {
  if (!marketplace.github_token_enc) return getGlobalToken();
  try {
    const env = getEnv();
    const encrypted = JSON.parse(marketplace.github_token_enc);
    return await decrypt(encrypted, env.ENCRYPTION_KEY, env.ENCRYPTION_KEY_PREVIOUS);
  } catch {
    return getGlobalToken();
  }
}

/**
 * GET — Fetch full plugin content for the editor.
 */
export const GET = withErrorHandler(async (_request: NextRequest, context) => {
  const { marketplaceId, pluginName } = await (context as RouteContext).params;

  const marketplace = await queryOne(
    PluginMarketplaceRow,
    "SELECT * FROM plugin_marketplaces WHERE id = $1",
    [marketplaceId],
  );
  if (!marketplace) throw new NotFoundError("Plugin marketplace not found");

  const [owner, repo] = marketplace.github_repo.split("/");
  const token = await getMarketplaceToken(marketplace);

  const treeResult = await fetchRepoTree(owner, repo, token);
  if (!treeResult.ok) {
    return NextResponse.json({ error: `Failed to fetch repo tree: ${treeResult.message}` }, { status: 502 });
  }

  const tree = treeResult.data;

  // Find skill files
  const skillEntries = tree.filter(
    e => e.type === "blob" && e.path.startsWith(`${pluginName}/skills/`),
  );

  // Find command files
  const commandEntries = tree.filter(
    e => e.type === "blob" && e.path.startsWith(`${pluginName}/commands/`) && e.path.endsWith(".md"),
  );

  // Check for .mcp.json
  const mcpJsonEntry = tree.find(
    e => e.type === "blob" && e.path === `${pluginName}/.mcp.json`,
  );

  // Fetch all file contents in parallel
  const [skillResults, commandResults, mcpJsonResult] = await Promise.all([
    Promise.all(skillEntries.map(async (entry) => {
      const contentResult = await fetchRawContent(owner, repo, entry.path, token);
      if (!contentResult.ok) return null;
      return { path: entry.path.replace(`${pluginName}/skills/`, ""), content: contentResult.data };
    })),
    Promise.all(commandEntries.map(async (entry) => {
      const contentResult = await fetchRawContent(owner, repo, entry.path, token);
      if (!contentResult.ok) return null;
      return { path: entry.path.replace(`${pluginName}/commands/`, ""), content: contentResult.data };
    })),
    mcpJsonEntry
      ? fetchRawContent(owner, repo, mcpJsonEntry.path, token).then(r => r.ok ? r.data : null)
      : Promise.resolve(null),
  ]);

  const skills = skillResults.filter(Boolean) as Array<{ path: string; content: string }>;
  const commands = commandResults.filter(Boolean) as Array<{ path: string; content: string }>;

  return NextResponse.json({
    skills,
    commands,
    mcpJson: mcpJsonResult,
    isOwned: marketplace.github_token_enc !== null,
  });
});

/**
 * PUT — Save edited plugin files back to GitHub.
 */
const PluginFileSchema = z.object({
  path: z.string().min(1).max(500),
  content: z.string().max(100_000),
});

const SavePluginSchema = z.object({
  skills: z.array(PluginFileSchema),
  commands: z.array(PluginFileSchema),
  mcpJson: z.string().nullable(),
});

export const PUT = withErrorHandler(async (request: NextRequest, context) => {
  const { marketplaceId, pluginName } = await (context as RouteContext).params;

  const marketplace = await queryOne(
    PluginMarketplaceRow,
    "SELECT * FROM plugin_marketplaces WHERE id = $1",
    [marketplaceId],
  );
  if (!marketplace) throw new NotFoundError("Plugin marketplace not found");
  if (!marketplace.github_token_enc) throw new ForbiddenError("Marketplace is read-only (no GitHub token configured)");

  const body = await request.json();
  const input = SavePluginSchema.parse(body);

  // Validate filenames
  for (const file of [...input.skills, ...input.commands]) {
    const filename = file.path.split("/").pop() ?? file.path;
    const validation = SafePluginFilename.safeParse(filename);
    if (!validation.success) {
      throw new ValidationError(`Unsafe filename: ${filename}`);
    }
  }

  // Validate .mcp.json if provided
  if (input.mcpJson !== null) {
    try {
      const parsed = JSON.parse(input.mcpJson);
      PluginMcpJsonSchema.parse(parsed);
    } catch (e) {
      throw new ValidationError(
        e instanceof SyntaxError ? "Invalid JSON in .mcp.json" : `.mcp.json validation failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  // Decrypt marketplace token
  const env = getEnv();
  const encrypted = JSON.parse(marketplace.github_token_enc);
  const token = await decrypt(encrypted, env.ENCRYPTION_KEY, env.ENCRYPTION_KEY_PREVIOUS);

  const [owner, repo] = marketplace.github_repo.split("/");

  // Get default branch
  const branchResult = await getDefaultBranch(owner, repo, token);
  if (!branchResult.ok) {
    return NextResponse.json({ error: `Failed to get default branch: ${branchResult.message}` }, { status: 502 });
  }
  const branch = branchResult.data;

  // Build file list for push
  const files = [
    ...input.skills.map(f => ({ path: `${pluginName}/skills/${f.path}`, content: f.content })),
    ...input.commands.map(f => ({ path: `${pluginName}/commands/${f.path}`, content: f.content })),
  ];

  if (input.mcpJson !== null) {
    files.push({ path: `${pluginName}/.mcp.json`, content: input.mcpJson });
  }

  if (files.length === 0) {
    throw new ValidationError("No files to save");
  }

  const result = await pushFiles(owner, repo, token, branch, files, `Update ${pluginName} via AgentPlane`);

  if (!result.ok) {
    if (result.error === "conflict") {
      throw new ConflictError("Plugin was modified externally. Please refresh and try again.");
    }
    return NextResponse.json({ error: `Failed to push: ${result.message}` }, { status: 502 });
  }

  // Clear tree cache and cache pushed content so page reloads don't hit stale CDN
  clearPluginCache(marketplace.github_repo);
  cacheRecentPush(marketplace.github_repo, files);

  return NextResponse.json({ commitSha: result.data.commitSha });
});
