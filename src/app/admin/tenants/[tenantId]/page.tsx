import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { queryOne, query } from "@/db";
import { TenantRow, AgentRow, RunRow } from "@/lib/validation";
import { TenantEditForm } from "./edit-form";

export const dynamic = "force-dynamic";

export default async function TenantDetailPage({ params }: { params: Promise<{ tenantId: string }> }) {
  const { tenantId } = await params;

  const tenant = await queryOne(TenantRow, "SELECT * FROM tenants WHERE id = $1", [tenantId]);
  if (!tenant) notFound();

  const agents = await query(
    AgentRow,
    "SELECT * FROM agents WHERE tenant_id = $1 ORDER BY created_at DESC",
    [tenantId],
  );

  const recentRuns = await query(
    RunRow,
    "SELECT * FROM runs WHERE tenant_id = $1 ORDER BY created_at DESC LIMIT 20",
    [tenantId],
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/admin/tenants" className="text-muted-foreground hover:text-foreground text-sm">&larr; Tenants</Link>
        <span className="text-muted-foreground">/</span>
        <h1 className="text-2xl font-semibold">{tenant.name}</h1>
        <Badge variant={tenant.status === "active" ? "default" : "destructive"}>{tenant.status}</Badge>
      </div>

      <div className="grid grid-cols-3 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Monthly Budget</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold font-mono">${tenant.monthly_budget_usd.toFixed(2)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Current Spend</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold font-mono">${tenant.current_month_spend.toFixed(2)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Agents / Runs</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{agents.length} / {recentRuns.length}</p>
          </CardContent>
        </Card>
      </div>

      <TenantEditForm tenant={tenant} />

      {/* Agents table */}
      <div>
        <h2 className="text-lg font-semibold mb-3">Agents</h2>
        <div className="rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="text-left p-3 font-medium">Name</th>
                <th className="text-left p-3 font-medium">Model</th>
                <th className="text-left p-3 font-medium">Permission Mode</th>
                <th className="text-left p-3 font-medium">Created</th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr key={a.id} className="border-b border-border hover:bg-muted/30">
                  <td className="p-3 font-medium">{a.name}</td>
                  <td className="p-3 font-mono text-xs text-muted-foreground">{a.model}</td>
                  <td className="p-3"><Badge variant="outline">{a.permission_mode}</Badge></td>
                  <td className="p-3 text-muted-foreground text-xs">{new Date(a.created_at).toLocaleDateString()}</td>
                </tr>
              ))}
              {agents.length === 0 && (
                <tr><td colSpan={4} className="p-6 text-center text-muted-foreground">No agents</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

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
