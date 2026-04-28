import Link from "next/link";
import { notFound } from "next/navigation";
import { z } from "zod";
import { Badge } from "@/components/ui/badge";
import { MetricCard } from "@/components/ui/metric-card";
import { RunStatusBadge } from "@/components/ui/run-status-badge";
import { PaginationBar, parsePaginationParams } from "@/components/ui/pagination-bar";
import { SectionHeader } from "@/components/ui/section-header";
import { AdminTable, AdminTableHead, AdminTableRow, Th, EmptyRow } from "@/components/ui/admin-table";
import { queryOne, query } from "@/db";
import { TenantRow, AgentRow, ApiKeyRow } from "@/lib/validation";
import { TenantEditForm } from "./edit-form";
import { ApiKeysSection } from "./api-keys";
import { AddAgentForm } from "../../agents/add-agent-form";
import { DeleteAgentButton } from "../../agents/delete-agent-button";
import { DeleteTenantButton } from "./delete-tenant-button";

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

  const MessageWithAgent = z.object({
    id: z.string(),
    session_id: z.string(),
    agent_id: z.string(),
    agent_name: z.string(),
    status: z.string(),
    prompt: z.string(),
    cost_usd: z.coerce.number(),
    num_turns: z.coerce.number(),
    duration_ms: z.coerce.number(),
    created_at: z.coerce.string(),
  });

  const [agents, messages, countResult, apiKeys] = await Promise.all([
    query(AgentRow, "SELECT * FROM agents WHERE tenant_id = $1 ORDER BY created_at DESC", [tenantId]),
    query(
      MessageWithAgent,
      `SELECT m.id, m.session_id, s.agent_id, a.name AS agent_name, m.status, m.prompt,
              m.cost_usd, m.num_turns, m.duration_ms, m.created_at
       FROM session_messages m
       JOIN sessions s ON s.id = m.session_id
       JOIN agents a ON a.id = s.agent_id
       WHERE m.tenant_id = $1 ORDER BY m.created_at DESC LIMIT $2 OFFSET $3`,
      [tenantId, pageSize, offset],
    ),
    queryOne(
      z.object({ total: z.number() }),
      "SELECT COUNT(*)::int AS total FROM session_messages WHERE tenant_id = $1",
      [tenantId],
    ),
    query(
      ApiKeyRow.omit({ key_hash: true }),
      `SELECT id, tenant_id, name, key_prefix, scopes, last_used_at, expires_at, revoked_at, created_at
       FROM api_keys WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId],
    ),
  ]);

  const totalMessages = countResult?.total ?? 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <Badge variant={tenant.status === "active" ? "default" : "destructive"}>{tenant.status}</Badge>
        <DeleteTenantButton tenantId={tenant.id} tenantName={tenant.name} />
      </div>

      <div className="grid grid-cols-4 gap-4">
        <MetricCard label="Monthly Budget"><span className="font-mono">${tenant.monthly_budget_usd.toFixed(2)}</span></MetricCard>
        <MetricCard label="Current Spend"><span className="font-mono">${tenant.current_month_spend.toFixed(2)}</span></MetricCard>
        <MetricCard label="Agents">{agents.length}</MetricCard>
        <MetricCard label="Executions">{totalMessages}</MetricCard>
      </div>

      <TenantEditForm tenant={tenant} />

      <ApiKeysSection tenantId={tenantId} initialKeys={apiKeys} />

      {/* Agents table */}
      <div className="rounded-lg border border-muted-foreground/25 p-5">
        <SectionHeader title="Agents">
          <AddAgentForm tenantId={tenant.id} />
        </SectionHeader>
        <AdminTable>
          <AdminTableHead>
            <Th>Name</Th>
            <Th>Model</Th>
            <Th>Permission Mode</Th>
            <Th>Created</Th>
            <Th align="right" />
          </AdminTableHead>
          <tbody>
            {agents.map((a) => (
              <AdminTableRow key={a.id}>
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
              </AdminTableRow>
            ))}
            {agents.length === 0 && <EmptyRow colSpan={5}>No agents</EmptyRow>}
          </tbody>
        </AdminTable>
      </div>

      {/* Executions */}
      <div className="rounded-lg border border-muted-foreground/25 p-5">
        <SectionHeader title="Executions" />
        <AdminTable footer={
          <PaginationBar
            page={page}
            pageSize={pageSize}
            total={totalMessages}
            buildHref={(p, ps) => `/admin/tenants/${tenantId}?page=${p}&pageSize=${ps}`}
          />
        }>
          <AdminTableHead>
            <Th>Run</Th>
            <Th>Agent</Th>
            <Th>Status</Th>
            <Th>Prompt</Th>
            <Th align="right">Cost</Th>
            <Th align="right">Turns</Th>
            <Th align="right">Duration</Th>
            <Th>Created</Th>
          </AdminTableHead>
          <tbody>
            {messages.map((m) => (
              <AdminTableRow key={m.id}>
                <td className="p-3 font-mono text-xs">
                  <Link href={`/admin/sessions/${m.session_id}`} className="text-primary hover:underline">
                    {m.session_id.slice(0, 8)}...
                  </Link>
                </td>
                <td className="p-3 text-xs">
                  <Link href={`/admin/agents/${m.agent_id}`} className="text-primary hover:underline">
                    {m.agent_name}
                  </Link>
                </td>
                <td className="p-3"><RunStatusBadge status={m.status} /></td>
                <td className="p-3 max-w-xs text-muted-foreground text-xs truncate" title={m.prompt}>
                  {m.prompt.slice(0, 60)}{m.prompt.length > 60 ? "…" : ""}
                </td>
                <td className="p-3 text-right font-mono">${m.cost_usd.toFixed(4)}</td>
                <td className="p-3 text-right">{m.num_turns}</td>
                <td className="p-3 text-right text-muted-foreground text-xs">
                  {m.duration_ms > 0 ? `${(m.duration_ms / 1000).toFixed(1)}s` : "—"}
                </td>
                <td className="p-3 text-muted-foreground text-xs">{new Date(m.created_at).toLocaleString()}</td>
              </AdminTableRow>
            ))}
            {messages.length === 0 && <EmptyRow colSpan={8}>No executions</EmptyRow>}
          </tbody>
        </AdminTable>
      </div>
    </div>
  );
}
