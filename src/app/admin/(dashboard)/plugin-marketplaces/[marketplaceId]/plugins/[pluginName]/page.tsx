import Link from "next/link";
import { notFound } from "next/navigation";
import { queryOne } from "@/db";
import { PluginMarketplaceRow, PluginManifestSchema } from "@/lib/validation";
import { fetchRepoTree, fetchRawContent } from "@/lib/github";
import { getCachedContent } from "@/lib/plugins";
import { Badge } from "@/components/ui/badge";
import { getEnv } from "@/lib/env";
import { decrypt } from "@/lib/crypto";
import { PluginEditorClient } from "./plugin-editor-client";

export const dynamic = "force-dynamic";

function getGlobalToken(): string | undefined {
  try {
    return getEnv().GITHUB_TOKEN;
  } catch {
    return undefined;
  }
}

export default async function PluginEditorPage({
  params,
}: {
  params: Promise<{ marketplaceId: string; pluginName: string }>;
}) {
  const { marketplaceId, pluginName } = await params;

  const marketplace = await queryOne(
    PluginMarketplaceRow,
    "SELECT * FROM plugin_marketplaces WHERE id = $1",
    [marketplaceId],
  );
  if (!marketplace) notFound();

  const isOwned = marketplace.github_token_enc !== null;

  // Get token (marketplace-specific or global)
  let token: string | undefined;
  if (marketplace.github_token_enc) {
    try {
      const env = getEnv();
      const encrypted = JSON.parse(marketplace.github_token_enc);
      token = await decrypt(encrypted, env.ENCRYPTION_KEY, env.ENCRYPTION_KEY_PREVIOUS);
    } catch {
      token = getGlobalToken();
    }
  } else {
    token = getGlobalToken();
  }

  const [owner, repo] = marketplace.github_repo.split("/");
  const treeResult = await fetchRepoTree(owner, repo, token);
  if (!treeResult.ok) {
    return (
      <div className="space-y-4">
        <Link href={`/admin/plugin-marketplaces/${marketplaceId}`} className="text-muted-foreground hover:text-foreground text-sm">&larr; Back</Link>
        <p className="text-sm text-red-500">Failed to load plugin: {treeResult.message}</p>
      </div>
    );
  }

  const tree = treeResult.data;

  // Fetch plugin manifest for display name
  const manifestResult = await fetchRawContent(owner, repo, `${pluginName}/.claude-plugin/plugin.json`, token);
  let displayName = pluginName;
  if (manifestResult.ok) {
    try {
      const manifest = PluginManifestSchema.parse(JSON.parse(manifestResult.data));
      displayName = manifest.name;
    } catch { /* use pluginName */ }
  }

  const githubRepo = marketplace.github_repo;

  // Helper: use recently-pushed content cache before falling back to GitHub CDN
  async function getContent(filePath: string): Promise<string | null> {
    const cached = getCachedContent(githubRepo, filePath);
    if (cached !== null) return cached;
    const result = await fetchRawContent(owner, repo, filePath, token);
    return result.ok ? result.data : null;
  }

  // Fetch skill files
  const skillEntries = tree.filter(
    e => e.type === "blob" && e.path.startsWith(`${pluginName}/skills/`),
  );
  const skillResults = await Promise.all(skillEntries.map(async (entry) => {
    const content = await getContent(entry.path);
    if (content === null) return null;
    return { path: entry.path.replace(`${pluginName}/skills/`, ""), content };
  }));

  // Fetch command files
  const commandEntries = tree.filter(
    e => e.type === "blob" && e.path.startsWith(`${pluginName}/commands/`) && e.path.endsWith(".md"),
  );
  const commandResults = await Promise.all(commandEntries.map(async (entry) => {
    const content = await getContent(entry.path);
    if (content === null) return null;
    return { path: entry.path.replace(`${pluginName}/commands/`, ""), content };
  }));

  // Fetch .mcp.json
  const mcpJsonEntry = tree.find(e => e.type === "blob" && e.path === `${pluginName}/.mcp.json`);
  let mcpJson: string | null = null;
  if (mcpJsonEntry) {
    mcpJson = await getContent(mcpJsonEntry.path);
  }

  const skills = skillResults.filter(Boolean) as Array<{ path: string; content: string }>;
  const commands = commandResults.filter(Boolean) as Array<{ path: string; content: string }>;

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-3">
          <Link href={`/admin/plugin-marketplaces/${marketplaceId}`} className="text-muted-foreground hover:text-foreground text-sm">&larr; {marketplace.name}</Link>
          <span className="text-muted-foreground">/</span>
          <h1 className="text-2xl font-semibold">{displayName}</h1>
          {isOwned ? (
            <Badge variant="secondary">Editable</Badge>
          ) : (
            <Badge variant="outline">Read-only</Badge>
          )}
        </div>
      </div>

      <PluginEditorClient
        marketplaceId={marketplaceId}
        pluginName={pluginName}
        initialSkills={skills}
        initialCommands={commands}
        initialMcpJson={mcpJson}
        readOnly={!isOwned}
      />
    </div>
  );
}
