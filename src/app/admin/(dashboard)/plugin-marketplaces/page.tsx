import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { AdminTable, AdminTableHead, AdminTableRow, Th, EmptyRow } from "@/components/ui/admin-table";
import { query } from "@/db";
import { z } from "zod";
import { AddMarketplaceForm } from "./add-marketplace-form";
import { DeleteMarketplaceButton } from "./delete-marketplace-button";

const MarketplaceWithStats = z.object({
  id: z.string(),
  name: z.string(),
  github_repo: z.string(),
  created_at: z.coerce.string(),
  agent_count: z.coerce.number(),
  is_owned: z.boolean(),
});

export const dynamic = "force-dynamic";

export default async function PluginMarketplacesPage() {
  const marketplaces = await query(
    MarketplaceWithStats,
    `SELECT pm.id, pm.name, pm.github_repo, pm.created_at,
       (SELECT COUNT(*)::int FROM agents WHERE plugins @> jsonb_build_array(jsonb_build_object('marketplace_id', pm.id::text))) AS agent_count,
       (pm.github_token_enc IS NOT NULL) AS is_owned
     FROM plugin_marketplaces pm
     ORDER BY pm.name`,
    [],
  );

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-end">
        <AddMarketplaceForm />
      </div>

      <AdminTable>
        <AdminTableHead>
          <Th>Name</Th>
          <Th>GitHub Repo</Th>
          <Th align="right">Agents Using</Th>
          <Th>Added</Th>
          <Th align="right" />
        </AdminTableHead>
        <tbody>
          {marketplaces.map((m) => (
            <AdminTableRow key={m.id}>
              <td className="p-3 font-medium">
                <Link
                  href={`/admin/plugin-marketplaces/${m.id}`}
                  className="text-primary hover:underline"
                >
                  {m.name}
                </Link>
                {m.is_owned && (
                  <Badge variant="secondary" className="ml-2 text-xs">Owned</Badge>
                )}
              </td>
              <td className="p-3">
                <a
                  href={`https://github.com/${m.github_repo}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-xs text-primary hover:underline"
                >
                  {m.github_repo}
                </a>
              </td>
              <td className="p-3 text-right">
                <Badge variant={m.agent_count > 0 ? "default" : "secondary"}>
                  {m.agent_count}
                </Badge>
              </td>
              <td className="p-3 text-muted-foreground text-xs">
                {new Date(m.created_at).toLocaleDateString()}
              </td>
              <td className="p-3 text-right">
                <DeleteMarketplaceButton
                  marketplaceId={m.id}
                  marketplaceName={m.name}
                  hasAgents={m.agent_count > 0}
                />
              </td>
            </AdminTableRow>
          ))}
          {marketplaces.length === 0 && (
            <EmptyRow colSpan={5}>
              No plugin marketplaces registered. Click &quot;Add Marketplace&quot; to add one.
            </EmptyRow>
          )}
        </tbody>
      </AdminTable>
    </div>
  );
}
