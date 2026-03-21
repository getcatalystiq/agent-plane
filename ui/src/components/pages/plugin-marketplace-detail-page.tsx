"use client";

import { useState } from "react";
import { useSWRConfig } from "swr";
import { useApi } from "../../hooks/use-api";
import { useAgentPlaneClient } from "../../hooks/use-client";
import { useNavigation } from "../../hooks/use-navigation";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Card, CardHeader, CardTitle, CardContent } from "../ui/card";
import { SectionHeader } from "../ui/section-header";
import { Skeleton } from "../ui/skeleton";

interface MarketplaceDetail {
  id: string;
  name: string;
  github_repo: string;
  has_token: boolean;
  created_at: string;
}

interface Plugin {
  name: string;
  displayName: string;
  description?: string;
  version?: string;
  hasAgents: boolean;
  hasSkills: boolean;
  hasMcpJson: boolean;
}

type PluginsResult = Plugin[];

export interface PluginMarketplaceDetailPageProps {
  marketplaceId: string;
  initialData?: MarketplaceDetail;
  initialPlugins?: PluginsResult;
}

export function PluginMarketplaceDetailPage({ marketplaceId, initialData, initialPlugins }: PluginMarketplaceDetailPageProps) {
  const { mutate } = useSWRConfig();
  const client = useAgentPlaneClient();
  const { LinkComponent, basePath } = useNavigation();

  const { data: marketplace, error, isLoading } = useApi<MarketplaceDetail>(
    `marketplace-${marketplaceId}`,
    (c) => c.pluginMarketplaces.get(marketplaceId) as Promise<MarketplaceDetail>,
    initialData ? { fallbackData: initialData } : undefined,
  );

  const { data: plugins } = useApi<PluginsResult>(
    `marketplace-${marketplaceId}-plugins`,
    (c) => c.pluginMarketplaces.listPlugins(marketplaceId) as Promise<PluginsResult>,
    initialPlugins ? { fallbackData: initialPlugins } : undefined,
  );

  const [tokenInput, setTokenInput] = useState("");
  const [savingToken, setSavingToken] = useState(false);

  async function handleSaveToken() {
    setSavingToken(true);
    try {
      await client.pluginMarketplaces.updateToken(marketplaceId, { github_token: tokenInput });
      setTokenInput("");
      mutate(`marketplace-${marketplaceId}`);
      mutate(`marketplace-${marketplaceId}-plugins`);
    } finally {
      setSavingToken(false);
    }
  }

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-[40vh]">
        <p className="text-destructive">Failed to load marketplace: {error.message}</p>
      </div>
    );
  }

  if (isLoading || !marketplace) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-12 w-64" />
        <Skeleton className="h-32 rounded-lg" />
        <Skeleton className="h-64 rounded-lg" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        {marketplace.has_token && <Badge variant="secondary">Owned</Badge>}
        <a
          href={`https://github.com/${marketplace.github_repo}`}
          target="_blank"
          rel="noopener noreferrer"
          className="font-mono text-xs text-primary hover:underline"
        >
          {marketplace.github_repo}
        </a>
      </div>

      {/* Token configuration */}
      <Card>
        <CardHeader>
          <CardTitle className="text-base">GitHub Token</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-3">
            <p className="text-sm text-muted-foreground">
              {marketplace.has_token
                ? "A GitHub token is configured. You can update it below."
                : "Add a GitHub personal access token to enable write access and private repo support."}
            </p>
            <div className="flex gap-2">
              <Input
                type="password"
                placeholder="ghp_..."
                value={tokenInput}
                onChange={(e) => setTokenInput(e.target.value)}
                className="flex-1"
              />
              <Button size="sm" onClick={handleSaveToken} disabled={savingToken || !tokenInput}>
                {savingToken ? "Saving..." : marketplace.has_token ? "Update Token" : "Save Token"}
              </Button>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Plugin list */}
      <div>
        <SectionHeader title="Plugins" />
        {!plugins ? (
          <Skeleton className="h-48 rounded-lg" />
        ) : plugins.length === 0 ? (
          <p className="text-sm text-muted-foreground">No plugins found in this marketplace.</p>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {plugins.map((plugin) => (
              <LinkComponent
                key={plugin.name}
                href={`${basePath}/plugin-marketplaces/${marketplaceId}/plugins/${plugin.name}`}
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
              </LinkComponent>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
