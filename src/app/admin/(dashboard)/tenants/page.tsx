import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { query } from "@/db";
import { z } from "zod";

const TenantWithStats = z.object({
  id: z.string(),
  name: z.string(),
  slug: z.string(),
  status: z.string(),
  monthly_budget_usd: z.coerce.number(),
  current_month_spend: z.coerce.number(),
  created_at: z.coerce.string(),
  agent_count: z.coerce.number(),
  run_count: z.coerce.number(),
});

export const dynamic = "force-dynamic";

export default async function TenantsPage() {
  const tenants = await query(
    TenantWithStats,
    `SELECT t.*,
       COUNT(DISTINCT a.id)::int AS agent_count,
       COUNT(DISTINCT r.id)::int AS run_count
     FROM tenants t
     LEFT JOIN agents a ON a.tenant_id = t.id
     LEFT JOIN runs r ON r.tenant_id = t.id
     GROUP BY t.id
     ORDER BY t.created_at DESC`,
    [],
  );

  return (
    <div>
      <h1 className="text-2xl font-semibold mb-6">Tenants</h1>
      <div className="rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th className="text-left p-3 font-medium">Name</th>
              <th className="text-left p-3 font-medium">Slug</th>
              <th className="text-left p-3 font-medium">Status</th>
              <th className="text-right p-3 font-medium">Budget</th>
              <th className="text-right p-3 font-medium">Spend</th>
              <th className="text-right p-3 font-medium">Agents</th>
              <th className="text-right p-3 font-medium">Runs</th>
              <th className="text-left p-3 font-medium">Created</th>
            </tr>
          </thead>
          <tbody>
            {tenants.map((t) => (
              <tr key={t.id} className="border-b border-border hover:bg-muted/30 transition-colors">
                <td className="p-3">
                  <Link href={`/admin/tenants/${t.id}`} className="text-primary hover:underline font-medium">
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
                <td className="p-3 text-right">{t.run_count}</td>
                <td className="p-3 text-muted-foreground text-xs">
                  {new Date(t.created_at).toLocaleDateString()}
                </td>
              </tr>
            ))}
            {tenants.length === 0 && (
              <tr>
                <td colSpan={8} className="p-8 text-center text-muted-foreground">
                  No tenants found
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
