import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { RunStatusBadge } from "@/components/ui/run-status-badge";
import { PaginationBar, parsePaginationParams } from "@/components/ui/pagination-bar";
import { LocalDate } from "@/components/local-date";
import { queryOne, query } from "@/db";
import { AgentRow, RunRow, TenantRow } from "@/lib/validation";
import { AgentEditForm } from "./edit-form";
import { SkillsEditor } from "./skills-editor";
import { ConnectorsManager } from "./connectors-manager";
import { PluginsManager } from "./plugins-manager";
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
      <div>
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <Link href="/admin/agents" className="text-muted-foreground hover:text-foreground text-sm">&larr; Agents</Link>
            <span className="text-muted-foreground">/</span>
            <h1 className="text-2xl font-semibold">{agent.name}</h1>
          </div>
          <AgentHeaderActions agentId={agent.id} tenantId={agent.tenant_id} />
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          Tenant: <Link href={`/admin/tenants/${agent.tenant_id}`} className="text-primary hover:underline">{tenant?.name ?? agent.tenant_id.slice(0, 8)}</Link>
        </p>
      </div>

      <div className="grid grid-cols-5 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Runs</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{totalRuns}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Max Turns</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{agent.max_turns}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Budget</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold font-mono">${agent.max_budget_usd.toFixed(2)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Skills</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{agent.skills.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Plugins</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{agent.plugins.length}</p>
          </CardContent>
        </Card>
      </div>

      <AgentEditForm agent={agent} />

      <ConnectorsManager agentId={agent.id} toolkits={agent.composio_toolkits} composioAllowedTools={agent.composio_allowed_tools} />

      <PluginsManager agentId={agent.id} initialPlugins={agent.plugins} />

      <SkillsEditor agentId={agent.id} initialSkills={agent.skills} />

      {/* Runs */}
      <div>
        <h2 className="text-lg font-semibold mb-3">Runs</h2>
        <div className="rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="text-left p-3 font-medium">Run ID</th>
                <th className="text-left p-3 font-medium">Status</th>
                <th className="text-left p-3 font-medium">Prompt</th>
                <th className="text-right p-3 font-medium">Cost</th>
                <th className="text-right p-3 font-medium">Turns</th>
                <th className="text-right p-3 font-medium">Duration</th>
                <th className="text-left p-3 font-medium">Created</th>
              </tr>
            </thead>
            <tbody>
              {runs.map((r) => (
                <tr key={r.id} className="border-b border-border hover:bg-muted/30">
                  <td className="p-3 font-mono text-xs">
                    <Link href={`/admin/runs/${r.id}?from=agent`} className="text-primary hover:underline">
                      {r.id.slice(0, 8)}...
                    </Link>
                  </td>
                  <td className="p-3"><RunStatusBadge status={r.status} /></td>
                  <td className="p-3 max-w-xs text-muted-foreground text-xs truncate" title={r.prompt}>
                    {r.prompt.slice(0, 60)}{r.prompt.length > 60 ? "…" : ""}
                  </td>
                  <td className="p-3 text-right font-mono">${r.cost_usd.toFixed(4)}</td>
                  <td className="p-3 text-right">{r.num_turns}</td>
                  <td className="p-3 text-right text-muted-foreground text-xs">
                    {r.duration_ms > 0 ? `${(r.duration_ms / 1000).toFixed(1)}s` : "—"}
                  </td>
                  <td className="p-3 text-muted-foreground text-xs"><LocalDate value={r.created_at} /></td>
                </tr>
              ))}
              {runs.length === 0 && (
                <tr><td colSpan={7} className="p-6 text-center text-muted-foreground">No runs</td></tr>
              )}
            </tbody>
          </table>

          <PaginationBar
            page={page}
            pageSize={pageSize}
            total={totalRuns}
            buildHref={(p, ps) => `/admin/agents/${agentId}?page=${p}&pageSize=${ps}`}
          />
        </div>
      </div>
    </div>
  );
}

