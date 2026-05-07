import Link from "next/link";
import { Building2 } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { AdminTable, AdminTableHead, AdminTableRow, Th, EmptyRow } from "@/components/ui/admin-table";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty";
import { query } from "@/db";
import { z } from "zod";
import { AddAgentForm } from "./add-agent-form";
import { DeleteAgentButton } from "./delete-agent-button";
import { getActiveTenantId } from "@/lib/active-tenant";

const AgentRow = z.object({
  id: z.string(),
  tenant_id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  model: z.string(),
  permission_mode: z.string(),
  composio_toolkits: z.array(z.string()),
  max_turns: z.coerce.number(),
  max_budget_usd: z.coerce.number(),
  a2a_enabled: z.boolean().default(false),
  created_at: z.coerce.string(),
  message_count: z.coerce.number(),
  last_message_at: z.coerce.string().nullable(),
  mcp_active_slugs: z.array(z.string()),
  mcp_unhealthy_slugs: z.array(z.string()),
  schedule_count: z.coerce.number(),
});

export const dynamic = "force-dynamic";

export default async function AgentsPage() {
  const tenantId = (await getActiveTenantId()) ?? null;

  if (!tenantId) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon"><Building2 /></EmptyMedia>
          <EmptyTitle>No company selected</EmptyTitle>
          <EmptyDescription>Pick a company from the switcher in the sidebar to manage its agents.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const agents = await query(
    AgentRow,
    `SELECT a.id, a.tenant_id, a.name, a.description, a.model,
       a.permission_mode, a.composio_toolkits, a.max_turns, a.max_budget_usd, a.a2a_enabled, a.created_at,
       (SELECT COUNT(*)::int FROM schedules s WHERE s.agent_id = a.id AND s.enabled = true) AS schedule_count,
       (SELECT COUNT(*)::int FROM session_messages m WHERE m.session_id IN (SELECT id FROM sessions WHERE agent_id = a.id)) AS message_count,
       (SELECT MAX(m.created_at) FROM session_messages m WHERE m.session_id IN (SELECT id FROM sessions WHERE agent_id = a.id)) AS last_message_at,
       COALESCE(array_agg(DISTINCT ms.slug) FILTER (WHERE ms.slug IS NOT NULL AND mc.status = 'active'), '{}') AS mcp_active_slugs,
       COALESCE(array_agg(DISTINCT ms.slug) FILTER (WHERE ms.slug IS NOT NULL AND mc.status IN ('expired', 'failed')), '{}') AS mcp_unhealthy_slugs
     FROM agents a
     LEFT JOIN mcp_connections mc ON mc.agent_id = a.id
     LEFT JOIN mcp_servers ms ON ms.id = mc.mcp_server_id
     WHERE a.tenant_id = $1
     GROUP BY a.id
     ORDER BY a.created_at DESC`,
    [tenantId],
  );

  return (
    <div>
      <div className="flex items-center mb-6">
        <AddAgentForm tenantId={tenantId} />
      </div>
      <AdminTable>
        <AdminTableHead>
          <Th>Name</Th>
          <Th>Description</Th>
          <Th>Model</Th>
          <Th>Connectors</Th>
          <Th>Schedule</Th>
          <Th align="right">Runs</Th>
          <Th>Last Message</Th>
          <Th align="right" />
        </AdminTableHead>
        <tbody>
          {agents.map((a) => (
            <AdminTableRow key={a.id}>
              <td className="p-3 font-medium">
                <div className="flex items-center gap-2">
                  <Link href={`/admin/agents/${a.id}`} className="text-primary hover:underline">
                    {a.name}
                  </Link>
                  {a.a2a_enabled && (
                    <Badge className="text-[10px] px-1.5 py-0 bg-indigo-500/10 text-indigo-400 border-indigo-500/20">A2A</Badge>
                  )}
                </div>
              </td>
              <td className="p-3 text-muted-foreground text-xs max-w-xs truncate" title={a.description ?? undefined}>
                {a.description ?? "—"}
              </td>
              <td className="p-3 font-mono text-xs text-muted-foreground">{a.model}</td>
              <td className="p-3">
                {a.composio_toolkits.length > 0 || a.mcp_active_slugs.length > 0 || a.mcp_unhealthy_slugs.length > 0 ? (
                  <div className="flex gap-1 flex-wrap">
                    {a.composio_toolkits.map((t) => (
                      <Badge key={t} variant="secondary" className="text-xs">{t}</Badge>
                    ))}
                    {a.mcp_active_slugs.map((s) => (
                      <Badge key={`mcp-${s}`} variant="secondary" className="text-xs">{s}</Badge>
                    ))}
                    {a.mcp_unhealthy_slugs.map((s) => (
                      <Badge key={`mcp-err-${s}`} variant="destructive" className="text-xs">{s}</Badge>
                    ))}
                  </div>
                ) : (
                  <span className="text-muted-foreground text-xs">—</span>
                )}
              </td>
              <td className="p-3">
                {a.schedule_count > 0 ? (
                  <Badge variant="default" className="text-xs">{a.schedule_count} active</Badge>
                ) : (
                  <span className="text-muted-foreground text-xs">—</span>
                )}
              </td>
              <td className="p-3 text-right">{a.message_count}</td>
              <td className="p-3 text-muted-foreground text-xs">
                {a.last_message_at ? new Date(a.last_message_at).toLocaleString() : "—"}
              </td>
              <td className="p-3 text-right">
                <DeleteAgentButton agentId={a.id} agentName={a.name} />
              </td>
            </AdminTableRow>
          ))}
          {agents.length === 0 && <EmptyRow colSpan={8}>No agents found</EmptyRow>}
        </tbody>
      </AdminTable>
    </div>
  );
}
