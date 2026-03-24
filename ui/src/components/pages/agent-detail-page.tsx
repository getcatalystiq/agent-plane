"use client";

import { useCallback } from "react";
import { useSWRConfig } from "swr";
import { useApi } from "../../hooks/use-api";
import { useNavigation } from "../../hooks/use-navigation";
import { Skeleton } from "../ui/skeleton";
import { MetricCard } from "../ui/metric-card";
import { Tabs } from "../ui/tabs";
import { buttonVariants } from "../ui/button";
import { AgentEditForm } from "./agent-edit-form";
import { AgentConnectorsManager } from "./agent-connectors-manager";
import { AgentSkillManager } from "./agent-skill-manager";
import { AgentPluginManager } from "./agent-plugin-manager";
import { AgentRuns } from "./agent-runs";
import { AgentA2aInfo } from "./agent-a2a-info";

/* eslint-disable @typescript-eslint/no-explicit-any */
interface AgentDetailData {
  id: string;
  name: string;
  description: string | null;
  slug?: string;
  model: string;
  permission_mode: string;
  max_turns: number;
  max_budget_usd: number;
  max_runtime_seconds: number;
  skills: any[];
  plugins: any[];
  composio_toolkits: string[];
  composio_allowed_tools: string[];
  soul_md: string | null;
  identity_md: string | null;
  a2a_enabled: boolean;
  a2a_tags?: string[];
  [key: string]: unknown;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

interface AgentDetailPageProps {
  agentId: string;
  /** Base URL for A2A endpoints (e.g. "https://app.example.com") */
  a2aBaseUrl?: string;
  /** Tenant slug (needed for A2A URLs) */
  tenantSlug?: string;
}

export function AgentDetailPage({ agentId, a2aBaseUrl, tenantSlug }: AgentDetailPageProps) {
  const { LinkComponent, basePath } = useNavigation();
  const { mutate } = useSWRConfig();

  const cacheKey = `agent-${agentId}`;

  const { data: agent, error, isLoading } = useApi<AgentDetailData>(
    cacheKey,
    (client) => client.agents.get(agentId) as Promise<AgentDetailData>,
  );

  const invalidate = useCallback(() => {
    mutate(cacheKey);
  }, [mutate, cacheKey]);

  if (isLoading) {
    return (
      <div className="space-y-6">
        <Skeleton className="h-9 w-40" />
        <div className="grid grid-cols-6 gap-4">
          {[1, 2, 3, 4, 5, 6].map((i) => <Skeleton key={i} className="h-20" />)}
        </div>
        <Skeleton className="h-64 w-full" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="text-destructive text-sm py-12 text-center">
        {error.status === 404
          ? "Agent not found."
          : `Failed to load agent: ${error.message}`}
      </div>
    );
  }

  if (!agent) {
    return (
      <div className="text-muted-foreground text-sm py-12 text-center">
        Agent not found.
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-start">
        <LinkComponent
          href={`${basePath}/agents/${agentId}/playground`}
          className={buttonVariants({ variant: "outline", size: "sm" })}
        >
          Open Playground
        </LinkComponent>
      </div>

      <Tabs
        tabs={[
          {
            label: "General",
            content: (
              <div className="space-y-6">
                <div className="grid grid-cols-6 gap-4">
                  <MetricCard label="Max Turns">{agent.max_turns}</MetricCard>
                  <MetricCard label="Budget"><span className="font-mono">${agent.max_budget_usd.toFixed(2)}</span></MetricCard>
                  <MetricCard label="Max Runtime"><span className="font-mono">{Math.floor(agent.max_runtime_seconds / 60)}m</span></MetricCard>
                  <MetricCard label="Skills">{(agent.skills ?? []).length}</MetricCard>
                  <MetricCard label="Plugins">{(agent.plugins ?? []).length}</MetricCard>
                  <MetricCard label="Model"><span className="font-mono text-xs">{agent.model}</span></MetricCard>
                </div>
                <AgentEditForm agent={agent} onSaved={invalidate} />
                {tenantSlug && a2aBaseUrl && (
                  <AgentA2aInfo
                    agentId={agent.id}
                    tenantSlug={tenantSlug}
                    agentSlug={agent.slug ?? agent.name}
                    baseUrl={a2aBaseUrl}
                    initialEnabled={agent.a2a_enabled}
                    initialTags={agent.a2a_tags ?? []}
                    onChanged={invalidate}
                  />
                )}
              </div>
            ),
          },
          {
            label: "Connectors",
            content: (
              <AgentConnectorsManager
                agentId={agent.id}
                toolkits={agent.composio_toolkits ?? []}
                composioAllowedTools={agent.composio_allowed_tools ?? []}
                onChanged={invalidate}
              />
            ),
          },
          {
            label: "Skills",
            content: (
              <AgentSkillManager
                agentId={agent.id}
                initialSkills={agent.skills ?? []}
                onSaved={invalidate}
              />
            ),
          },
          {
            label: "Plugins",
            content: (
              <AgentPluginManager
                agentId={agent.id}
                initialPlugins={agent.plugins ?? []}
                onSaved={invalidate}
              />
            ),
          },
          {
            label: "Runs",
            content: <AgentRuns agentId={agent.id} />,
          },
        ]}
      />
    </div>
  );
}
