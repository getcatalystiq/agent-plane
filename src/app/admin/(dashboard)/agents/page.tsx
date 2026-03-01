import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { query } from "@/db";
import { TenantRow } from "@/lib/validation";
import { z } from "zod";
import { AddAgentForm } from "./add-agent-form";
import { DeleteAgentButton } from "./delete-agent-button";

const AgentWithTenant = z.object({
  id: z.string(),
  tenant_id: z.string(),
  tenant_name: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  model: z.string(),
  permission_mode: z.string(),
  composio_toolkits: z.array(z.string()),
  max_turns: z.coerce.number(),
  max_budget_usd: z.coerce.number(),
  created_at: z.coerce.string(),
  run_count: z.coerce.number(),
  last_run_at: z.coerce.string().nullable(),
  mcp_active_slugs: z.array(z.string()),
  mcp_unhealthy_slugs: z.array(z.string()),
});

export const dynamic = "force-dynamic";

export default async function AgentsPage() {
  const [agents, tenants] = await Promise.all([
    query(
    AgentWithTenant,
    `SELECT a.id, a.tenant_id, t.name AS tenant_name, a.name, a.description, a.model,
       a.permission_mode, a.composio_toolkits, a.max_turns, a.max_budget_usd, a.created_at,
       COUNT(DISTINCT r.id)::int AS run_count,
       MAX(r.created_at) AS last_run_at,
       COALESCE(array_agg(DISTINCT ms.slug) FILTER (WHERE ms.slug IS NOT NULL AND mc.status = 'active'), '{}') AS mcp_active_slugs,
       COALESCE(array_agg(DISTINCT ms.slug) FILTER (WHERE ms.slug IS NOT NULL AND mc.status IN ('expired', 'failed')), '{}') AS mcp_unhealthy_slugs
     FROM agents a
     JOIN tenants t ON t.id = a.tenant_id
     LEFT JOIN runs r ON r.agent_id = a.id
     LEFT JOIN mcp_connections mc ON mc.agent_id = a.id
     LEFT JOIN mcp_servers ms ON ms.id = mc.mcp_server_id
     GROUP BY a.id, t.name
     ORDER BY a.created_at DESC`,
    [],
  ),
    query(TenantRow, "SELECT * FROM tenants ORDER BY name ASC", []),
  ]);

  return (
    <div>
      <div className="flex items-center justify-between mb-6">
        <h1 className="text-2xl font-semibold">Agents</h1>
        <AddAgentForm tenants={tenants.map((t) => ({ id: t.id, name: t.name }))} />
      </div>
      <div className="rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th className="text-left p-3 font-medium">Name</th>
              <th className="text-left p-3 font-medium">Description</th>
              <th className="text-left p-3 font-medium">Tenant</th>
              <th className="text-left p-3 font-medium">Model</th>
              <th className="text-left p-3 font-medium">Connectors</th>
              <th className="text-right p-3 font-medium">Runs</th>
              <th className="text-left p-3 font-medium">Last Run</th>
              <th className="text-right p-3 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {agents.map((a) => (
              <tr key={a.id} className="border-b border-border hover:bg-muted/30 transition-colors">
                <td className="p-3 font-medium">
                  <Link href={`/admin/agents/${a.id}`} className="text-primary hover:underline">
                    {a.name}
                  </Link>
                </td>
                <td className="p-3 text-muted-foreground text-xs max-w-xs truncate" title={a.description ?? undefined}>
                  {a.description ?? "—"}
                </td>
                <td className="p-3">
                  <Link href={`/admin/tenants/${a.tenant_id}`} className="text-primary hover:underline text-xs">
                    {a.tenant_name}
                  </Link>
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
                <td className="p-3 text-right">{a.run_count}</td>
                <td className="p-3 text-muted-foreground text-xs">
                  {a.last_run_at ? new Date(a.last_run_at).toLocaleString() : "—"}
                </td>
                <td className="p-3 text-right">
                  <DeleteAgentButton agentId={a.id} agentName={a.name} />
                </td>
              </tr>
            ))}
            {agents.length === 0 && (
              <tr>
                <td colSpan={8} className="p-8 text-center text-muted-foreground">No agents found</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
