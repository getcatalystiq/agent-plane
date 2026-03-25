"use client";

import { useCallback, useMemo, lazy, Suspense } from "react";
import { useSWRConfig } from "swr";
import { useApi } from "../../hooks/use-api";
import { useAgentPlaneClient } from "../../hooks/use-client";
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

import { FileTreeEditor } from "../editor/file-tree-editor";

const AgentIdentityTab = lazy(() => import("./agent-identity-tab").then(m => ({ default: m.AgentIdentityTab })));

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
  style_md: string | null;
  agents_md: string | null;
  heartbeat_md: string | null;
  user_template_md: string | null;
  examples_good_md: string | null;
  examples_bad_md: string | null;
  soul_spec_version: string | null;
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
  /** Admin API base URL — when provided, enables Generate/Import/Export/Publish buttons on the Identity tab */
  adminApiBaseUrl?: string;
  /** Admin API key or auth token for admin endpoints */
  adminApiKey?: string;
}

export type { AgentDetailPageProps };

export function AgentDetailPage({ agentId, a2aBaseUrl, tenantSlug, adminApiBaseUrl, adminApiKey }: AgentDetailPageProps) {
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

  // Admin API helpers for SoulSpec operations (only active when adminApiBaseUrl is provided)
  const adminFetch = useCallback(async (path: string, options?: RequestInit) => {
    if (!adminApiBaseUrl) throw new Error("Admin API not configured");
    const res = await fetch(`${adminApiBaseUrl}${path}`, {
      ...options,
      headers: {
        "Content-Type": "application/json",
        ...(adminApiKey ? { Authorization: `Bearer ${adminApiKey}` } : {}),
        ...options?.headers,
      },
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: { message: res.statusText } }));
      throw new Error(body?.error?.message ?? `Request failed: ${res.status}`);
    }
    return res.json();
  }, [adminApiBaseUrl, adminApiKey]);

  const soulCallbacks = useMemo(() => {
    if (!adminApiBaseUrl) return {};
    return {
      onGenerateSoul: async () => {
        const result = await adminFetch(`/api/agents/${agentId}/generate-soul`, { method: "POST" });
        return { files: result.files as Record<string, string> };
      },
      onImportSoul: async (ref: string) => {
        const [owner, name] = ref.split("/");
        const result = await adminFetch(`/api/agents/${agentId}/import-soul`, {
          method: "POST",
          body: JSON.stringify({ owner, name }),
        });
        return { files: result.imported_files as Record<string, string> };
      },
      onExportSoul: async () => {
        const result = await adminFetch(`/api/agents/${agentId}/export-soul`);
        return { files: result.files as Record<string, string>, name: agent?.name ?? "agent" };
      },
      onPublishSoul: async (owner: string) => {
        await adminFetch(`/api/agents/${agentId}/publish-soul`, {
          method: "POST",
          body: JSON.stringify({ owner }),
        });
      },
    };
  }, [adminApiBaseUrl, adminFetch, agentId, agent?.name]);

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
            label: "Identity",
            content: (
              <Suspense fallback={<Skeleton className="h-64 w-full" />}>
                <AgentIdentityTab agent={agent} FileTreeEditor={FileTreeEditor} onSaved={invalidate} {...soulCallbacks} />
              </Suspense>
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
