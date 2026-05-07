"use client";

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from "recharts";

// Each entry: { date: "2025-01-15", [agentName]: value, ... }
type ChartRow = Record<string, string | number>;

const COLORS = [
  "#6366f1", "#f59e0b", "#10b981", "#ef4444", "#3b82f6",
  "#ec4899", "#14b8a6", "#f97316", "#8b5cf6", "#84cc16",
];

function AgentLineChart({
  title,
  data,
  agents,
  valueFormatter,
  yLabel,
}: {
  title: string;
  data: ChartRow[];
  agents: string[];
  valueFormatter: (v: number) => string;
  yLabel?: string;
}) {
  if (data.length === 0) {
    return (
      <div className="rounded-lg border border-border p-6">
        <h3 className="text-sm font-semibold mb-4">{title}</h3>
        <p className="text-sm text-muted-foreground text-center py-8">
          No activity in this period
        </p>
      </div>
    );
  }

  return (
    <div className="rounded-lg border border-border p-4">
      <h3 className="text-sm font-semibold mb-4">{title}</h3>
      <ResponsiveContainer width="100%" height={220}>
        <LineChart data={data} margin={{ top: 4, right: 16, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
          <XAxis
            dataKey="date"
            tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
            tickLine={false}
            axisLine={false}
          />
          <YAxis
            tick={{ fontSize: 11, fill: "hsl(var(--muted-foreground))" }}
            tickLine={false}
            axisLine={false}
            label={yLabel ? { value: yLabel, angle: -90, position: "insideLeft", fontSize: 11 } : undefined}
            tickFormatter={valueFormatter}
            width={50}
          />
          <Tooltip
            contentStyle={{
              backgroundColor: "hsl(var(--card))",
              border: "1px solid hsl(var(--border))",
              borderRadius: "6px",
              fontSize: 12,
            }}
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            formatter={(value: any, name: any) => [valueFormatter(Number(value)), String(name)]}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} />
          {agents.map((agent, i) => (
            <Line
              key={agent}
              type="monotone"
              dataKey={agent}
              stroke={COLORS[i % COLORS.length]}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4 }}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

export interface DailyAgentStat {
  date: string;
  agent_name: string;
  execution_count: number;
  cost_usd: number;
}

function buildChartData(rows: DailyAgentStat[], valueKey: "execution_count" | "cost_usd") {
  const dateSet = new Set<string>();
  const agentSet = new Set<string>();
  for (const r of rows) {
    dateSet.add(r.date);
    agentSet.add(r.agent_name);
  }

  const dates = Array.from(dateSet).sort();
  const agents = Array.from(agentSet).sort();

  const lookup = new Map<string, number>();
  for (const r of rows) lookup.set(`${r.date}|${r.agent_name}`, r[valueKey]);

  const data: ChartRow[] = dates.map((date) => {
    const row: ChartRow = { date };
    for (const agent of agents) {
      row[agent] = lookup.get(`${date}|${agent}`) ?? 0;
    }
    return row;
  });

  return { data, agents };
}

export function ExecutionCharts({ stats }: { stats: DailyAgentStat[] }) {
  const { data: execData, agents: execAgents } = buildChartData(stats, "execution_count");
  const { data: costData, agents: costAgents } = buildChartData(stats, "cost_usd");

  return (
    <div className="grid grid-cols-2 gap-4">
      <AgentLineChart
        title="Runs per day"
        data={execData}
        agents={execAgents}
        valueFormatter={(v) => String(Math.round(v))}
      />
      <AgentLineChart
        title="Cost per day (USD)"
        data={costData}
        agents={costAgents}
        valueFormatter={(v) => `$${v.toFixed(2)}`}
      />
    </div>
  );
}
