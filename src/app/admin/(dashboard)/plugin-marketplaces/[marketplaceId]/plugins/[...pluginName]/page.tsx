import Link from "next/link";
import { notFound } from "next/navigation";
import { queryOne } from "@/db";
import { PluginMarketplaceRow, PluginManifestSchema } from "@/lib/validation";
import { fetchRepoTree, fetchFileContent } from "@/lib/github";
import { Badge } from "@/components/ui/badge";
import { getEnv } from "@/lib/env";
import { decrypt } from "@/lib/crypto";
import { PluginEditorClient } from "./plugin-editor-client";

export const dynamic = "force-dynamic";

export default async function PluginEditorPage({
  params,
}: {
  params: Promise<{ marketplaceId: string; pluginName: string[] }>;
}) {
  const { marketplaceId, pluginName: pluginNameSegments } = await params;
  const pluginName = pluginNameSegments.join("/");

  const marketplace = await queryOne(
    PluginMarketplaceRow,
    "SELECT * FROM plugin_marketplaces WHERE id = $1",
    [marketplaceId],
  );
  if (!marketplace) notFound();

  const isOwned = marketplace.github_token_enc !== null;

  // Get token from marketplace
  let token: string | undefined;
  if (marketplace.github_token_enc) {
    try {
      const env = getEnv();
      const encrypted = JSON.parse(marketplace.github_token_enc);
      token = await decrypt(encrypted, env.ENCRYPTION_KEY, env.ENCRYPTION_KEY_PREVIOUS);
    } catch { /* no token available */ }
  }

  const [owner, repo] = marketplace.github_repo.split("/");
  const treeResult = await fetchRepoTree(owner, repo, token);
  if (!treeResult.ok) {
    return (
      <div className="space-y-4">
        <Link href={`/admin/plugin-marketplaces/${marketplaceId}`} className="text-muted-foreground hover:text-foreground text-sm">&larr; Back</Link>
        <p className="text-sm text-destructive">Failed to load plugin: {treeResult.message}</p>
      </div>
    );
  }

  const tree = treeResult.data;

  // Fetch plugin manifest for display name
  const manifestResult = await fetchFileContent(owner, repo, `${pluginName}/.claude-plugin/plugin.json`, token);
  let displayName = pluginName;
  if (manifestResult.ok) {
    try {
      const manifest = PluginManifestSchema.parse(JSON.parse(manifestResult.data));
      displayName = manifest.name;
    } catch { /* use pluginName */ }
  }

  // Helper: fetch via GitHub Contents API (always fresh, unlike CDN)
  async function getContent(filePath: string): Promise<string | null> {
    const result = await fetchFileContent(owner, repo, filePath, token);
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

  // Fetch agent files
  const agentEntries = tree.filter(
    e => e.type === "blob" && e.path.startsWith(`${pluginName}/agents/`) && e.path.endsWith(".md"),
  );
  const agentResults = await Promise.all(agentEntries.map(async (entry) => {
    const content = await getContent(entry.path);
    if (content === null) return null;
    return { path: entry.path.replace(`${pluginName}/agents/`, ""), content };
  }));

  // Fetch .mcp.json
  const mcpJsonEntry = tree.find(e => e.type === "blob" && e.path === `${pluginName}/.mcp.json`);
  let mcpJson: string | null = null;
  if (mcpJsonEntry) {
    mcpJson = await getContent(mcpJsonEntry.path);
  }

  const skills = skillResults.filter(Boolean) as Array<{ path: string; content: string }>;
  const agents = agentResults.filter(Boolean) as Array<{ path: string; content: string }>;

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
        initialAgents={agents}
        initialMcpJson={mcpJson}
        readOnly={!isOwned}
      />
    </div>
  );
}
