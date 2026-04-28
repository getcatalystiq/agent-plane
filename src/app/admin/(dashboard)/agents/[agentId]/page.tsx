import { notFound } from "next/navigation";
import { z } from "zod";
import { MetricCard } from "@/components/ui/metric-card";
import { queryOne, query } from "@/db";
import { AgentRow, TenantRow, ScheduleRow } from "@/lib/validation";
import { AgentEditForm } from "./edit-form";
import { A2aInfoSection } from "./a2a-info-section";
import { SkillsEditor } from "./skills-editor";
import { ConnectorsManager } from "./connectors-manager";
import { PluginsManager } from "./plugins-manager";
import { ScheduleEditor } from "./schedule-editor";
import { AgentHeaderActions } from "./header-actions";
import { AgentTabs } from "./agent-tabs";
import { AgentRuns } from "./agent-runs";
import { IdentityTab } from "./identity-tab";
import { WebhooksManager } from "./webhooks-manager";
import { getCallbackBaseUrl } from "@/lib/mcp-connections";

export const dynamic = "force-dynamic";

export default async function AgentDetailPage({
  params,
}: {
  params: Promise<{ agentId: string }>;
}) {
  const { agentId } = await params;

  const agent = await queryOne(AgentRow, "SELECT * FROM agents WHERE id = $1", [agentId]);
  if (!agent) notFound();

  const tenant = await queryOne(TenantRow, "SELECT * FROM tenants WHERE id = $1", [agent.tenant_id]);

  const [countResult, schedules] = await Promise.all([
    queryOne(
      z.object({ total: z.number() }),
      `SELECT COUNT(*)::int AS total FROM session_messages
        WHERE session_id IN (SELECT id FROM sessions WHERE agent_id = $1)`,
      [agentId],
    ),
    query(ScheduleRow, "SELECT * FROM schedules WHERE agent_id = $1 ORDER BY created_at ASC", [agentId]),
  ]);

  const totalMessages = countResult?.total ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-start">
        <AgentHeaderActions agentId={agent.id} tenantId={agent.tenant_id} />
      </div>

      <AgentTabs
        general={
          <div className="space-y-6">
            <div className="grid grid-cols-6 gap-4">
              <MetricCard label="Executions">{totalMessages}</MetricCard>
              <MetricCard label="Max Turns">{agent.max_turns}</MetricCard>
              <MetricCard label="Budget"><span className="font-mono">${agent.max_budget_usd.toFixed(2)}</span></MetricCard>
              <MetricCard label="Max Runtime"><span className="font-mono">{Math.floor(agent.max_runtime_seconds / 60)}m</span></MetricCard>
              <MetricCard label="Skills">{agent.skills.length}</MetricCard>
              <MetricCard label="Plugins">{agent.plugins.length}</MetricCard>
            </div>
            <AgentEditForm agent={agent} />
            {tenant && (
              <A2aInfoSection
                agentId={agent.id}
                tenantSlug={tenant.slug}
                agentSlug={agent.slug}
                baseUrl={getCallbackBaseUrl()}
                initialEnabled={agent.a2a_enabled}
                initialTags={agent.a2a_tags}
              />
            )}
          </div>
        }
        identity={
          <IdentityTab agent={agent} />
        }
        runs={
          <AgentRuns agentId={agent.id} />
        }
        connectors={
          <ConnectorsManager agentId={agent.id} toolkits={agent.composio_toolkits} composioAllowedTools={agent.composio_allowed_tools} hasPlugins={agent.plugins.length > 0} />
        }
        skills={
          <SkillsEditor agentId={agent.id} initialSkills={agent.skills} />
        }
        plugins={
          <PluginsManager agentId={agent.id} tenantId={agent.tenant_id} initialPlugins={agent.plugins} />
        }
        schedules={
          <ScheduleEditor
            agentId={agent.id}
            initialSchedules={schedules}
            timezone={tenant?.timezone ?? "UTC"}
          />
        }
        webhooks={
          <WebhooksManager
            agentId={agent.id}
            tenantId={agent.tenant_id}
            baseUrl={getCallbackBaseUrl()}
          />
        }
      />
    </div>
  );
}
