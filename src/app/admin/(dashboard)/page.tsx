import Link from "next/link";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { query, queryOne } from "@/db";
import { z } from "zod";
import { RunCharts, type DailyAgentStat } from "./run-charts";

export const dynamic = "force-dynamic";

const StatsRow = z.object({
  tenant_count: z.coerce.number(),
  agent_count: z.coerce.number(),
  total_runs: z.coerce.number(),
  active_runs: z.coerce.number(),
  total_spend: z.coerce.number(),
});

const DailyStatRow = z.object({
  date: z.string(),
  agent_name: z.string(),
  run_count: z.coerce.number(),
  cost_usd: z.coerce.number(),
});

export default async function AdminDashboardPage() {
  const [stats, dailyStats] = await Promise.all([
    queryOne(
      StatsRow,
      `SELECT
         (SELECT COUNT(*) FROM tenants)::int AS tenant_count,
         (SELECT COUNT(*) FROM agents)::int AS agent_count,
         (SELECT COUNT(*) FROM runs)::int AS total_runs,
         (SELECT COUNT(*) FROM runs WHERE status = 'running')::int AS active_runs,
         (SELECT COALESCE(SUM(cost_usd), 0) FROM runs) AS total_spend`,
      [],
    ),
    query(
      DailyStatRow,
      `SELECT
         DATE(r.created_at)::text AS date,
         a.name AS agent_name,
         COUNT(*)::int AS run_count,
         COALESCE(SUM(r.cost_usd), 0) AS cost_usd
       FROM runs r
       JOIN agents a ON a.id = r.agent_id
       WHERE r.created_at >= NOW() - INTERVAL '30 days'
       GROUP BY DATE(r.created_at), a.name
       ORDER BY date ASC`,
      [],
    ),
  ]);

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">Dashboard</h1>

      <div className="grid grid-cols-5 gap-4">
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Tenants</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold">{stats?.tenant_count ?? 0}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Agents</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold">{stats?.agent_count ?? 0}</p>
          </CardContent>
        </Card>
        <Link href="/admin/runs" className="block">
          <Card className="hover:bg-muted/30 transition-colors cursor-pointer h-full">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Total Runs</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-3xl font-bold">{stats?.total_runs ?? 0}</p>
            </CardContent>
          </Card>
        </Link>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Active Runs</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold text-green-500">{stats?.active_runs ?? 0}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Total Spend</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-3xl font-bold font-mono">${(stats?.total_spend ?? 0).toFixed(2)}</p>
          </CardContent>
        </Card>
      </div>

      <RunCharts stats={dailyStats as DailyAgentStat[]} />
    </div>
  );
}

