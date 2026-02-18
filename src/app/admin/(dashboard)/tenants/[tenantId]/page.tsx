import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { RunStatusBadge } from "@/components/ui/run-status-badge";
import { PaginationBar, parsePaginationParams } from "@/components/ui/pagination-bar";
import { queryOne, query } from "@/db";
import { TenantRow, AgentRow, ApiKeyRow } from "@/lib/validation";
import { TenantEditForm } from "./edit-form";
import { ApiKeysSection } from "./api-keys";
import { AddAgentForm } from "../../agents/add-agent-form";
import { DeleteAgentButton } from "../../agents/delete-agent-button";

export const dynamic = "force-dynamic";

export default async function TenantDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<{ page?: string; pageSize?: string }>;
}) {
  const { tenantId } = await params;
  const { page: pageParam, pageSize: pageSizeParam } = await searchParams;
  const { page, pageSize, offset } = parsePaginationParams(pageParam, pageSizeParam);

  const tenant = await queryOne(TenantRow, "SELECT * FROM tenants WHERE id = $1", [tenantId]);
  if (!tenant) notFound();

  const RunWithAgent = z.object({
    id: z.string(),
    agent_id: z.string(),
    agent_name: z.string(),
    status: z.string(),
    prompt: z.string(),
    cost_usd: z.coerce.number(),
    num_turns: z.coerce.number(),
    duration_ms: z.coerce.number(),
    created_at: z.coerce.string(),
  });

  const [agents, runs, countResult, apiKeys] = await Promise.all([
    query(AgentRow, "SELECT * FROM agents WHERE tenant_id = $1 ORDER BY created_at DESC", [tenantId]),
    query(
      RunWithAgent,
      `SELECT r.id, r.agent_id, a.name AS agent_name, r.status, r.prompt, r.cost_usd, r.num_turns, r.duration_ms, r.created_at
       FROM runs r JOIN agents a ON a.id = r.agent_id
       WHERE r.tenant_id = $1 ORDER BY r.created_at DESC LIMIT $2 OFFSET $3`,
      [tenantId, pageSize, offset],
    ),
    queryOne(z.object({ total: z.number() }), "SELECT COUNT(*)::int AS total FROM runs WHERE tenant_id = $1", [tenantId]),
    query(
      ApiKeyRow.omit({ key_hash: true }),
      `SELECT id, tenant_id, name, key_prefix, scopes, last_used_at, expires_at, revoked_at, created_at
       FROM api_keys WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId],
    ),
  ]);

  const totalRuns = countResult?.total ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/admin/tenants" className="text-muted-foreground hover:text-foreground text-sm">&larr; Tenants</Link>
        <span className="text-muted-foreground">/</span>
        <h1 className="text-2xl font-semibold">{tenant.name}</h1>
        <Badge variant={tenant.status === "active" ? "default" : "destructive"}>{tenant.status}</Badge>
      </div>

      <div className="grid grid-cols-4 gap-4">
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
            <CardTitle className="text-sm font-medium text-muted-foreground">Agents</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{agents.length}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Runs</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{totalRuns}</p>
          </CardContent>
        </Card>
      </div>

      <TenantEditForm tenant={tenant} />

      <ApiKeysSection tenantId={tenantId} initialKeys={apiKeys} />

      {/* Agents table */}
      <div>
        <div className="flex items-center justify-between mb-3">
          <h2 className="text-lg font-semibold">Agents</h2>
          <AddAgentForm tenants={[{ id: tenant.id, name: tenant.name }]} defaultTenantId={tenant.id} />
        </div>
        <div className="rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="text-left p-3 font-medium">Name</th>
                <th className="text-left p-3 font-medium">Model</th>
                <th className="text-left p-3 font-medium">Permission Mode</th>
                <th className="text-left p-3 font-medium">Created</th>
                <th className="text-right p-3 font-medium"></th>
              </tr>
            </thead>
            <tbody>
              {agents.map((a) => (
                <tr key={a.id} className="border-b border-border hover:bg-muted/30">
                  <td className="p-3 font-medium">
                    <Link href={`/admin/agents/${a.id}`} className="text-primary hover:underline">
                      {a.name}
                    </Link>
                  </td>
                  <td className="p-3 font-mono text-xs text-muted-foreground">{a.model}</td>
                  <td className="p-3"><Badge variant="outline">{a.permission_mode}</Badge></td>
                  <td className="p-3 text-muted-foreground text-xs">{new Date(a.created_at).toLocaleDateString()}</td>
                  <td className="p-3 text-right">
                    <DeleteAgentButton agentId={a.id} agentName={a.name} />
                  </td>
                </tr>
              ))}
              {agents.length === 0 && (
                <tr><td colSpan={5} className="p-6 text-center text-muted-foreground">No agents</td></tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      {/* Runs */}
      <div>
        <h2 className="text-lg font-semibold mb-3">Runs</h2>
        <div className="rounded-lg border border-border">
          <table className="w-full text-sm">
            <thead>
              <tr className="border-b border-border bg-muted/50">
                <th className="text-left p-3 font-medium">Run ID</th>
                <th className="text-left p-3 font-medium">Agent</th>
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
                    <Link href={`/admin/runs/${r.id}`} className="text-primary hover:underline">
                      {r.id.slice(0, 8)}...
                    </Link>
                  </td>
                  <td className="p-3 text-xs">
                    <Link href={`/admin/agents/${r.agent_id}`} className="text-primary hover:underline">
                      {r.agent_name}
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
                  <td className="p-3 text-muted-foreground text-xs">{new Date(r.created_at).toLocaleString()}</td>
                </tr>
              ))}
              {runs.length === 0 && (
                <tr><td colSpan={8} className="p-6 text-center text-muted-foreground">No runs</td></tr>
              )}
            </tbody>
          </table>
          <PaginationBar
            page={page}
            pageSize={pageSize}
            total={totalRuns}
            buildHref={(p, ps) => `/admin/tenants/${tenantId}?page=${p}&pageSize=${ps}`}
          />
        </div>
      </div>
    </div>
  );
}

