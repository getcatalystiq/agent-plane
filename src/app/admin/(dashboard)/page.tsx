import Link from "next/link";
import { MetricCard } from "@/components/ui/metric-card";
import { query, queryOne } from "@/db";
import { z } from "zod";
import { ExecutionCharts, type DailyAgentStat } from "./sessions/execution-charts";
import { getActiveTenantId } from "@/lib/active-tenant";

export const dynamic = "force-dynamic";

const StatsRow = z.object({
  agent_count: z.coerce.number(),
  total_sessions: z.coerce.number(),
  active_sessions: z.coerce.number(),
  total_executions: z.coerce.number(),
  total_spend: z.coerce.number(),
});

const DailyStatRow = z.object({
  date: z.string(),
  agent_name: z.string(),
  execution_count: z.coerce.number(),
  cost_usd: z.coerce.number(),
});

export default async function AdminDashboardPage() {
  const tenantId = (await getActiveTenantId()) ?? null;

  if (!tenantId) {
    return (
      <div className="flex items-center justify-center min-h-[40vh]">
        <p className="text-muted-foreground">Select a company from the sidebar to view the dashboard.</p>
      </div>
    );
  }

  const [stats, dailyStats] = await Promise.all([
    queryOne(
      StatsRow,
      `SELECT
         (SELECT COUNT(*) FROM agents WHERE tenant_id = $1)::int AS agent_count,
         (SELECT COUNT(*) FROM sessions WHERE tenant_id = $1)::int AS total_sessions,
         (SELECT COUNT(*) FROM sessions WHERE tenant_id = $1 AND status IN ('creating','active'))::int AS active_sessions,
         (SELECT COUNT(*) FROM session_messages WHERE tenant_id = $1)::int AS total_executions,
         (SELECT COALESCE(SUM(cost_usd), 0) FROM session_messages WHERE tenant_id = $1) AS total_spend`,
      [tenantId],
    ),
    query(
      DailyStatRow,
      `SELECT
         DATE(COALESCE(m.completed_at, m.created_at))::text AS date,
         a.name AS agent_name,
         COUNT(*)::int AS execution_count,
         COALESCE(SUM(m.cost_usd), 0) AS cost_usd
       FROM session_messages m
       JOIN sessions s ON s.id = m.session_id
       JOIN agents a ON a.id = s.agent_id
       WHERE m.tenant_id = $1 AND COALESCE(m.completed_at, m.created_at) >= NOW() - INTERVAL '30 days'
       GROUP BY DATE(COALESCE(m.completed_at, m.created_at)), a.name
       ORDER BY date ASC`,
      [tenantId],
    ),
  ]);

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-4 gap-4">
        <MetricCard label="Agents">
          {stats?.agent_count ?? 0}
        </MetricCard>
        <Link href="/admin/sessions" className="block">
          <MetricCard label="Total Runs" className="hover:bg-muted/30 transition-colors cursor-pointer h-full">
            {stats?.total_sessions ?? 0}
          </MetricCard>
        </Link>
        <MetricCard label="Active Runs">
          <span className="text-green-500">{stats?.active_sessions ?? 0}</span>
        </MetricCard>
        <MetricCard label="Total Spend">
          <span className="font-mono">${(stats?.total_spend ?? 0).toFixed(2)}</span>
        </MetricCard>
      </div>

      <ExecutionCharts stats={dailyStats as DailyAgentStat[]} />
    </div>
  );
}
