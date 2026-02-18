import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { queryOne, query } from "@/db";
import { AgentRow, RunRow, TenantRow } from "@/lib/validation";
import { AgentEditForm } from "./edit-form";
import { SkillsEditor } from "./skills-editor";
import { ConnectorsManager } from "./connectors-manager";

export const dynamic = "force-dynamic";

export default async function AgentDetailPage({ params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = await params;

  const agent = await queryOne(AgentRow, "SELECT * FROM agents WHERE id = $1", [agentId]);
  if (!agent) notFound();

  const tenant = await queryOne(TenantRow, "SELECT * FROM tenants WHERE id = $1", [agent.tenant_id]);

  const recentRuns = await query(
    RunRow,
    "SELECT * FROM runs WHERE agent_id = $1 ORDER BY created_at DESC LIMIT 20",
    [agentId],
  );

  return (
    <div className="space-y-6">
      <div>
        <div className="flex items-center gap-3">
          <Link href="/admin/agents" className="text-muted-foreground hover:text-foreground text-sm">&larr; Agents</Link>
          <span className="text-muted-foreground">/</span>
          <h1 className="text-2xl font-semibold">{agent.name}</h1>
        </div>
        <p className="text-sm text-muted-foreground mt-1">
          Tenant: <Link href={`/admin/tenants/${agent.tenant_id}`} className="text-primary hover:underline">{tenant?.name ?? agent.tenant_id.slice(0, 8)}</Link>
        </p>
        {agent.description && (
          <p className="text-sm text-muted-foreground mt-2 max-w-2xl">{agent.description}</p>
        )}
      </div>

      <div className="grid grid-cols-4 gap-4">
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
            <CardTitle className="text-sm font-medium text-muted-foreground">Max Turns</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{agent.max_turns}</p>
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
            <CardTitle className="text-sm font-medium text-muted-foreground">Runs</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{recentRuns.length}</p>
          </CardContent>
        </Card>
      </div>

      <AgentEditForm agent={agent} />

      <ConnectorsManager agentId={agent.id} toolkits={agent.composio_toolkits} />

      <SkillsEditor agentId={agent.id} initialSkills={agent.skills} />

      {/* Recent runs */}
      <div>
        <h2 className="text-lg font-semibold mb-3">Recent Runs</h2>
        <div className="rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="text-left p-3 font-medium">Run ID</th>
                <th className="text-left p-3 font-medium">Status</th>
                <th className="text-right p-3 font-medium">Cost</th>
                <th className="text-right p-3 font-medium">Turns</th>
                <th className="text-left p-3 font-medium">Created</th>
              </tr>
            </thead>
            <tbody>
              {recentRuns.map((r) => (
                <tr key={r.id} className="border-b border-border hover:bg-muted/30">
                  <td className="p-3 font-mono text-xs">
                    <Link href={`/admin/runs/${r.id}`} className="text-primary hover:underline">
                      {r.id.slice(0, 8)}...
                    </Link>
                  </td>
                  <td className="p-3"><RunStatusBadge status={r.status} /></td>
                  <td className="p-3 text-right font-mono">${r.cost_usd.toFixed(4)}</td>
                  <td className="p-3 text-right">{r.num_turns}</td>
                  <td className="p-3 text-muted-foreground text-xs">{new Date(r.created_at).toLocaleString()}</td>
                </tr>
              ))}
              {recentRuns.length === 0 && (
                <tr><td colSpan={5} className="p-6 text-center text-muted-foreground">No runs</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function RunStatusBadge({ status }: { status: string }) {
  const variant = status === "completed" ? "default"
    : status === "running" ? "secondary"
    : status === "failed" ? "destructive"
    : "outline";
  return <Badge variant={variant}>{status}</Badge>;
}
