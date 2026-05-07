import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { AdminTable, AdminTableHead, AdminTableRow, Th, EmptyRow } from "@/components/ui/admin-table";
import { DetailPageHeader } from "@/components/ui/detail-page-header";
import { query } from "@/db";
import { z } from "zod";
import { AddTenantForm } from "./add-tenant-form";

const TenantWithStats = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  status: z.string(),
  monthly_budget_usd: z.coerce.number(),
  current_month_spend: z.coerce.number(),
  created_at: z.coerce.string(),
  agent_count: z.coerce.number(),
  message_count: z.coerce.number(),
});

export const dynamic = "force-dynamic";

export default async function TenantsPage() {
  const tenants = await query(
    TenantWithStats,
    `SELECT t.*,
       COUNT(DISTINCT a.id)::int AS agent_count,
       COUNT(DISTINCT m.id)::int AS message_count
     FROM tenants t
     LEFT JOIN agents a ON a.tenant_id = t.id
     LEFT JOIN session_messages m ON m.tenant_id = t.id
     GROUP BY t.id
     ORDER BY t.created_at DESC`,
    [],
  );

  return (
    <div className="space-y-6">
      <DetailPageHeader title="Companies" actions={<AddTenantForm />} />
      <AdminTable>
        <AdminTableHead>
          <Th>Name</Th>
          <Th>Slug</Th>
          <Th>Status</Th>
          <Th align="right">Budget</Th>
          <Th align="right">Spend</Th>
          <Th align="right">Agents</Th>
          <Th align="right">Runs</Th>
          <Th>Created</Th>
        </AdminTableHead>
        <tbody>
          {tenants.map((t) => (
            <AdminTableRow key={t.id}>
              <td className="p-3 font-medium">
                <Link href={`/admin/tenants/${t.id}`} className="text-primary hover:underline">
                  {t.name}
                </Link>
              </td>
              <td className="p-3 text-muted-foreground font-mono text-xs">{t.slug}</td>
              <td className="p-3">
                <Badge variant={t.status === "active" ? "default" : "destructive"}>
                  {t.status}
                </Badge>
              </td>
              <td className="p-3 text-right font-mono">${t.monthly_budget_usd.toFixed(2)}</td>
              <td className="p-3 text-right font-mono">${t.current_month_spend.toFixed(2)}</td>
              <td className="p-3 text-right">{t.agent_count}</td>
              <td className="p-3 text-right">{t.message_count}</td>
              <td className="p-3 text-muted-foreground text-xs">
                {new Date(t.created_at).toLocaleDateString()}
              </td>
            </AdminTableRow>
          ))}
          {tenants.length === 0 && <EmptyRow colSpan={8}>No companies found</EmptyRow>}
        </tbody>
      </AdminTable>
    </div>
  );
}
