import { Badge } from "@/components/ui/badge";
import { AdminTable, AdminTableHead, AdminTableRow, Th, EmptyRow } from "@/components/ui/admin-table";
import { query } from "@/db";
import { z } from "zod";
import { AddMcpServerForm } from "./add-server-form";
import { DeleteServerButton } from "./delete-server-button";

const McpServerWithStats = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  description: z.string(),
  logo_url: z.string().nullable(),
  base_url: z.string(),
  mcp_endpoint_path: z.string(),
  client_id: z.string().nullable(),
  created_at: z.coerce.string(),
  connection_count: z.coerce.number(),
  active_count: z.coerce.number(),
});

export const dynamic = "force-dynamic";

export default async function McpServersPage() {
  const servers = await query(
    McpServerWithStats,
    `SELECT ms.*,
       COUNT(mc.id)::int AS connection_count,
       COUNT(mc.id) FILTER (WHERE mc.status = 'active')::int AS active_count
     FROM mcp_servers ms
     LEFT JOIN mcp_connections mc ON mc.mcp_server_id = ms.id
     GROUP BY ms.id
     ORDER BY ms.name`,
    [],
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-end">
        <AddMcpServerForm />
      </div>

      <AdminTable>
        <AdminTableHead>
          <Th>Name</Th>
          <Th>Slug</Th>
          <Th>Base URL</Th>
          <Th>OAuth</Th>
          <Th align="right">Connections</Th>
          <Th align="right">Active</Th>
          <Th>Created</Th>
          <Th align="right" />
        </AdminTableHead>
        <tbody>
          {servers.map((s) => (
            <AdminTableRow key={s.id}>
              <td className="p-3">
                <div className="flex items-center gap-2">
                  {s.logo_url && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={s.logo_url} alt="" className="w-5 h-5 rounded-sm object-contain" />
                  )}
                  <span className="font-medium">{s.name}</span>
                </div>
              </td>
              <td className="p-3 font-mono text-xs text-muted-foreground">{s.slug}</td>
              <td className="p-3 font-mono text-xs text-muted-foreground truncate max-w-xs" title={s.base_url}>
                {s.base_url}
              </td>
              <td className="p-3">
                <Badge variant={s.client_id ? "default" : "secondary"}>
                  {s.client_id ? "Registered" : "No DCR"}
                </Badge>
              </td>
              <td className="p-3 text-right">{s.connection_count}</td>
              <td className="p-3 text-right text-green-500">{s.active_count}</td>
              <td className="p-3 text-muted-foreground text-xs">
                {new Date(s.created_at).toLocaleDateString()}
              </td>
              <td className="p-3 text-right">
                <DeleteServerButton
                  serverId={s.id}
                  serverName={s.name}
                  hasConnections={s.connection_count > 0}
                />
              </td>
            </AdminTableRow>
          ))}
          {servers.length === 0 && (
            <EmptyRow colSpan={8}>
              No custom connectors registered. Click &quot;Register Connector&quot; to add one.
            </EmptyRow>
          )}
        </tbody>
      </AdminTable>
    </div>
  );
}
