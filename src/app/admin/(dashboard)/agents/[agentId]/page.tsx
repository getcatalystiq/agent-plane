import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { MetricCard } from "@/components/ui/metric-card";
import { RunStatusBadge } from "@/components/ui/run-status-badge";
import { RunSourceBadge } from "@/components/ui/run-source-badge";
import { PaginationBar, parsePaginationParams } from "@/components/ui/pagination-bar";
import { DetailPageHeader } from "@/components/ui/detail-page-header";
import { SectionHeader } from "@/components/ui/section-header";
import { AdminTable, AdminTableHead, AdminTableRow, Th, EmptyRow } from "@/components/ui/admin-table";
import { LocalDate } from "@/components/local-date";
import { queryOne, query } from "@/db";
import { AgentRow, RunRow, TenantRow } from "@/lib/validation";
import { AgentEditForm } from "./edit-form";
import { SkillsEditor } from "./skills-editor";
import { ConnectorsManager } from "./connectors-manager";
import { PluginsManager } from "./plugins-manager";
import { ScheduleEditor } from "./schedule-editor";
import { AgentHeaderActions } from "./header-actions";

export const dynamic = "force-dynamic";

export default async function AgentDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ agentId: string }>;
  searchParams: Promise<{ page?: string; pageSize?: string }>;
}) {
  const { agentId } = await params;
  const { page: pageParam, pageSize: pageSizeParam } = await searchParams;
  const { page, pageSize, offset } = parsePaginationParams(pageParam, pageSizeParam);

  const agent = await queryOne(AgentRow, "SELECT * FROM agents WHERE id = $1", [agentId]);
  if (!agent) notFound();

  const tenant = await queryOne(TenantRow, "SELECT * FROM tenants WHERE id = $1", [agent.tenant_id]);

  const [runs, countResult] = await Promise.all([
    query(RunRow, "SELECT * FROM runs WHERE agent_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3", [agentId, pageSize, offset]),
    queryOne(
      z.object({ total: z.number() }),
      "SELECT COUNT(*)::int AS total FROM runs WHERE agent_id = $1",
      [agentId],
    ),
  ]);

  const totalRuns = countResult?.total ?? 0;

  return (
    <div className="space-y-6">
      <DetailPageHeader
        backHref="/admin/agents"
        backLabel="Agents"
        title={agent.name}
        actions={<AgentHeaderActions agentId={agent.id} tenantId={agent.tenant_id} />}
        subtitle={
          <p className="text-sm text-muted-foreground">
            Tenant: <Link href={`/admin/tenants/${agent.tenant_id}`} className="text-primary hover:underline">{tenant?.name ?? agent.tenant_id.slice(0, 8)}</Link>
          </p>
        }
      />

      <div className="grid grid-cols-6 gap-4">
        <MetricCard label="Runs">{totalRuns}</MetricCard>
        <MetricCard label="Max Turns">{agent.max_turns}</MetricCard>
        <MetricCard label="Budget"><span className="font-mono">${agent.max_budget_usd.toFixed(2)}</span></MetricCard>
        <MetricCard label="Max Runtime"><span className="font-mono">{Math.floor(agent.max_runtime_seconds / 60)}m</span></MetricCard>
        <MetricCard label="Skills">{agent.skills.length}</MetricCard>
        <MetricCard label="Plugins">{agent.plugins.length}</MetricCard>
      </div>

      <AgentEditForm agent={agent} />

      <ConnectorsManager agentId={agent.id} toolkits={agent.composio_toolkits} composioAllowedTools={agent.composio_allowed_tools} hasPlugins={agent.plugins.length > 0} />

      <PluginsManager agentId={agent.id} initialPlugins={agent.plugins} />

      <SkillsEditor agentId={agent.id} initialSkills={agent.skills} />

      <ScheduleEditor
        agentId={agent.id}
        initialSchedule={{
          frequency: agent.schedule_frequency,
          time: agent.schedule_time,
          dayOfWeek: agent.schedule_day_of_week,
          prompt: agent.schedule_prompt,
          enabled: agent.schedule_enabled,
          lastRunAt: agent.schedule_last_run_at,
          nextRunAt: agent.schedule_next_run_at,
        }}
        timezone={tenant?.timezone ?? "UTC"}
      />

      {/* Runs */}
      <div className="rounded-lg border border-muted-foreground/25 p-5">
        <SectionHeader title="Runs" />
        <AdminTable footer={
          <PaginationBar
            page={page}
            pageSize={pageSize}
            total={totalRuns}
            buildHref={(p, ps) => `/admin/agents/${agentId}?page=${p}&pageSize=${ps}`}
          />
        }>
          <AdminTableHead>
            <Th>Run ID</Th>
            <Th>Status</Th>
            <Th>Source</Th>
            <Th>Prompt</Th>
            <Th align="right">Cost</Th>
            <Th align="right">Turns</Th>
            <Th align="right">Duration</Th>
            <Th>Created</Th>
          </AdminTableHead>
          <tbody>
            {runs.map((r) => (
              <AdminTableRow key={r.id}>
                <td className="p-3 font-mono text-xs">
                  <Link href={`/admin/runs/${r.id}?from=agent`} className="text-primary hover:underline">
                    {r.id.slice(0, 8)}...
                  </Link>
                </td>
                <td className="p-3"><RunStatusBadge status={r.status} /></td>
                <td className="p-3">
                  <RunSourceBadge triggeredBy={r.triggered_by} />
                </td>
                <td className="p-3 max-w-xs text-muted-foreground text-xs truncate" title={r.prompt}>
                  {r.prompt.slice(0, 60)}{r.prompt.length > 60 ? "…" : ""}
                </td>
                <td className="p-3 text-right font-mono">${r.cost_usd.toFixed(4)}</td>
                <td className="p-3 text-right">{r.num_turns}</td>
                <td className="p-3 text-right text-muted-foreground text-xs">
                  {r.duration_ms > 0 ? `${(r.duration_ms / 1000).toFixed(1)}s` : "—"}
                </td>
                <td className="p-3 text-muted-foreground text-xs"><LocalDate value={r.created_at} /></td>
              </AdminTableRow>
            ))}
            {runs.length === 0 && <EmptyRow colSpan={8}>No runs</EmptyRow>}
          </tbody>
        </AdminTable>
      </div>
    </div>
  );
}
