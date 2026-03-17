import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { DetailPageHeader } from "@/components/ui/detail-page-header";
import { SectionHeader } from "@/components/ui/section-header";
import { queryOne } from "@/db";
import { PluginMarketplaceRow } from "@/lib/validation";
import { listPlugins } from "@/lib/plugins";
import { decrypt } from "@/lib/crypto";
import { getEnv } from "@/lib/env";
import { TokenConfig } from "./token-config";

export const dynamic = "force-dynamic";

export default async function MarketplaceDetailPage({
  params,
}: {
  params: Promise<{ marketplaceId: string }>;
}) {
  const { marketplaceId } = await params;

  const marketplace = await queryOne(
    PluginMarketplaceRow,
    "SELECT * FROM plugin_marketplaces WHERE id = $1",
    [marketplaceId],
  );
  if (!marketplace) notFound();

  const isOwned = marketplace.github_token_enc !== null;

  let token: string | undefined;
  if (marketplace.github_token_enc) {
    try {
      const env = getEnv();
      token = await decrypt(JSON.parse(marketplace.github_token_enc), env.ENCRYPTION_KEY, env.ENCRYPTION_KEY_PREVIOUS);
    } catch { /* fall through to global token */ }
  }

  const pluginsResult = await listPlugins(marketplace.github_repo, token);

  return (
    <div className="space-y-6">
      <DetailPageHeader
        backHref="/admin/plugin-marketplaces"
        backLabel="Marketplaces"
        title={marketplace.name}
        badge={isOwned ? <Badge variant="secondary">Owned</Badge> : undefined}
        subtitle={
          <a
            href={`https://github.com/${marketplace.github_repo}`}
            target="_blank"
            rel="noopener noreferrer"
            className="font-mono text-xs text-primary hover:underline"
          >
            {marketplace.github_repo}
          </a>
        }
      />

      {/* Token configuration */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">GitHub Token</CardTitle>
        </CardHeader>
        <CardContent>
          <TokenConfig marketplaceId={marketplaceId} hasToken={isOwned} />
        </CardContent>
      </Card>

      {/* Plugin list */}
      <div>
        <SectionHeader title="Plugins" />
        {!pluginsResult.ok ? (
          <p className="text-sm text-destructive">Failed to load plugins: {pluginsResult.message}</p>
        ) : pluginsResult.data.length === 0 ? (
          <p className="text-sm text-muted-foreground">No plugins found in this marketplace.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {pluginsResult.data.map((plugin) => (
              <Link
                key={plugin.name}
                href={`/admin/plugin-marketplaces/${marketplaceId}/plugins/${plugin.name}`}
              >
                <Card className="hover:border-primary/50 transition-colors cursor-pointer h-full">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm font-medium flex items-center justify-between">
                      {plugin.displayName}
                      {plugin.version && (
                        <span className="text-xs text-muted-foreground font-normal">v{plugin.version}</span>
                      )}
                    </CardTitle>
                  </CardHeader>
                  <CardContent>
                    {plugin.description && (
                      <p className="text-xs text-muted-foreground mb-3">{plugin.description}</p>
                    )}
                    <div className="flex gap-1.5">
                      {plugin.hasAgents && <Badge variant="secondary" className="text-xs">Agents</Badge>}
                      {plugin.hasSkills && <Badge variant="secondary" className="text-xs">Skills</Badge>}
                      {plugin.hasMcpJson && <Badge variant="secondary" className="text-xs">MCP</Badge>}
                    </div>
                  </CardContent>
                </Card>
              </Link>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
