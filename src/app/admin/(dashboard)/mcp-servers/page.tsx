import { Badge } from "@/components/ui/badge";
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
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Custom Connectors</h1>
        <AddMcpServerForm />
      </div>

      <div className="rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th className="text-left p-3 font-medium">Name</th>
              <th className="text-left p-3 font-medium">Slug</th>
              <th className="text-left p-3 font-medium">Base URL</th>
              <th className="text-left p-3 font-medium">OAuth</th>
              <th className="text-right p-3 font-medium">Connections</th>
              <th className="text-right p-3 font-medium">Active</th>
              <th className="text-left p-3 font-medium">Created</th>
              <th className="text-right p-3 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {servers.map((s) => (
              <tr key={s.id} className="border-b border-border hover:bg-muted/30 transition-colors">
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
              </tr>
            ))}
            {servers.length === 0 && (
              <tr>
                <td colSpan={8} className="p-8 text-center text-muted-foreground">
                  No custom connectors registered. Click &quot;Register Connector&quot; to add one.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
