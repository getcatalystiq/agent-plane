"use client";

import { useApi } from "../../hooks/use-api";
import { useNavigation } from "../../hooks/use-navigation";
import { Badge } from "../ui/badge";
import { Card, CardHeader, CardTitle, CardContent } from "../ui/card";
import { Skeleton } from "../ui/skeleton";
import { Tabs } from "../ui/tabs";

interface PluginAgentMeta {
  filename: string;
  name: string;
  description: string | null;
}

interface PluginDetailData {
  name: string;
  displayName: string;
  description: string | null;
  version: string | null;
  agents: PluginAgentMeta[];
  skills: string[];
  hasMcpJson: boolean;
}

export interface PluginDetailPageProps {
  marketplaceId: string;
  pluginName: string;
}

function AgentsTab({ agents }: { agents: PluginAgentMeta[] }) {
  if (agents.length === 0) {
    return <p className="text-sm text-muted-foreground py-4">No agents defined in this plugin.</p>;
  }
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      {agents.map((agent) => (
        <Card key={agent.filename}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">{agent.name}</CardTitle>
          </CardHeader>
          <CardContent>
            {agent.description ? (
              <p className="text-xs text-muted-foreground">{agent.description}</p>
            ) : (
              <p className="text-xs text-muted-foreground italic">No description</p>
            )}
            <p className="text-xs text-muted-foreground/60 mt-2 font-mono">{agent.filename}</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function SkillsTab({ skills }: { skills: string[] }) {
  if (skills.length === 0) {
    return <p className="text-sm text-muted-foreground py-4">No skills defined in this plugin.</p>;
  }
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {skills.map((skill) => (
        <Card key={skill}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium">{skill}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-xs text-muted-foreground font-mono">skills/{skill}/</p>
          </CardContent>
        </Card>
      ))}
    </div>
  );
}

function ConnectorsTab({ hasMcpJson }: { hasMcpJson: boolean }) {
  if (!hasMcpJson) {
    return <p className="text-sm text-muted-foreground py-4">No connectors defined in this plugin.</p>;
  }
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium">.mcp.json</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-xs text-muted-foreground">
          This plugin includes an MCP connector configuration that will be suggested to agents using it.
        </p>
      </CardContent>
    </Card>
  );
}

export function PluginDetailPage({ marketplaceId, pluginName }: PluginDetailPageProps) {
  const { LinkComponent, basePath } = useNavigation();

  const { data: plugin, error, isLoading } = useApi<PluginDetailData>(
    `marketplace-${marketplaceId}-plugin-${pluginName}`,
    (c) => c.pluginMarketplaces.getPlugin(marketplaceId, pluginName) as Promise<PluginDetailData>,
  );

  if (error) {
    return (
      <div className="flex items-center justify-center min-h-[40vh]">
        <p className="text-destructive">Failed to load plugin: {error.message}</p>
      </div>
    );
  }

  if (isLoading || !plugin) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-8 w-48" />
        <Skeleton className="h-4 w-96" />
        <Skeleton className="h-64 rounded-lg" />
      </div>
    );
  }

  const tabs = [
    {
      label: `Agents (${plugin.agents.length})`,
      content: <AgentsTab agents={plugin.agents} />,
    },
    {
      label: `Skills (${plugin.skills.length})`,
      content: <SkillsTab skills={plugin.skills} />,
    },
    {
      label: `Connectors (${plugin.hasMcpJson ? 1 : 0})`,
      content: <ConnectorsTab hasMcpJson={plugin.hasMcpJson} />,
    },
  ];

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <div className="flex items-center gap-3 mb-1">
          <LinkComponent
            href={`${basePath}/plugin-marketplaces/${marketplaceId}`}
            className="text-muted-foreground hover:text-foreground text-sm"
          >
            &larr; Back to marketplace
          </LinkComponent>
        </div>
        <div className="flex items-center gap-3">
          <h1 className="text-2xl font-semibold">{plugin.displayName}</h1>
          {plugin.version && (
            <Badge variant="outline">v{plugin.version}</Badge>
          )}
        </div>
        {plugin.description && (
          <p className="text-sm text-muted-foreground mt-1">{plugin.description}</p>
        )}
      </div>

      <Tabs tabs={tabs} />
    </div>
  );
}
