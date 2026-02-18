import Link from "next/link";
import { PaginationBar, parsePaginationParams } from "@/components/ui/pagination-bar";
import { RunStatusBadge } from "@/components/ui/run-status-badge";
import { query, queryOne } from "@/db";
import { z } from "zod";

const RunWithContext = z.object({
  id: z.string(),
  agent_id: z.string(),
  agent_name: z.string(),
  tenant_id: z.string(),
  tenant_name: z.string(),
  status: z.string(),
  prompt: z.string(),
  cost_usd: z.coerce.number(),
  num_turns: z.coerce.number(),
  duration_ms: z.coerce.number(),
  total_input_tokens: z.coerce.number(),
  total_output_tokens: z.coerce.number(),
  error_type: z.string().nullable(),
  started_at: z.coerce.string().nullable(),
  completed_at: z.coerce.string().nullable(),
  created_at: z.coerce.string(),
});

export const dynamic = "force-dynamic";

export default async function RunsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; pageSize?: string }>;
}) {
  const { page: pageParam, pageSize: pageSizeParam } = await searchParams;
  const { page, pageSize, offset } = parsePaginationParams(pageParam, pageSizeParam);

  const [runs, countResult] = await Promise.all([
    query(
      RunWithContext,
      `SELECT r.id, r.agent_id, a.name AS agent_name, r.tenant_id, t.name AS tenant_name,
         r.status, r.prompt, r.cost_usd, r.num_turns, r.duration_ms,
         r.total_input_tokens, r.total_output_tokens, r.error_type,
         r.started_at, r.completed_at, r.created_at
       FROM runs r
       JOIN agents a ON a.id = r.agent_id
       JOIN tenants t ON t.id = r.tenant_id
       ORDER BY r.created_at DESC
       LIMIT $1 OFFSET $2`,
      [pageSize, offset],
    ),
    queryOne(
      z.object({ total: z.number() }),
      `SELECT COUNT(*)::int AS total FROM runs r
       JOIN agents a ON a.id = r.agent_id
       JOIN tenants t ON t.id = r.tenant_id`,
      [],
    ),
  ]);

  const total = countResult?.total ?? 0;

  return (
    <div>
      <h1 className="text-2xl font-semibold mb-6">Runs</h1>
      <div className="rounded-lg border border-border overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th className="text-left p-3 font-medium">Run</th>
              <th className="text-left p-3 font-medium">Agent</th>
              <th className="text-left p-3 font-medium">Tenant</th>
              <th className="text-left p-3 font-medium">Status</th>
              <th className="text-left p-3 font-medium max-w-xs">Prompt</th>
              <th className="text-right p-3 font-medium">Cost</th>
              <th className="text-right p-3 font-medium">Turns</th>
              <th className="text-right p-3 font-medium">Duration</th>
              <th className="text-left p-3 font-medium">Created</th>
            </tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id} className="border-b border-border hover:bg-muted/30 transition-colors">
                <td className="p-3 font-mono text-xs">
                  <Link href={`/admin/runs/${r.id}`} className="text-primary hover:underline">
                    {r.id.slice(0, 8)}...
                  </Link>
                </td>
                <td className="p-3 text-xs">{r.agent_name}</td>
                <td className="p-3">
                  <Link href={`/admin/tenants/${r.tenant_id}`} className="text-primary hover:underline text-xs">
                    {r.tenant_name}
                  </Link>
                </td>
                <td className="p-3"><RunStatusBadge status={r.status} /></td>
                <td className="p-3 max-w-xs truncate text-muted-foreground text-xs" title={r.prompt}>
                  {r.prompt.slice(0, 80)}{r.prompt.length > 80 ? "..." : ""}
                </td>
                <td className="p-3 text-right font-mono">${r.cost_usd.toFixed(4)}</td>
                <td className="p-3 text-right">{r.num_turns}</td>
                <td className="p-3 text-right text-muted-foreground">
                  {r.duration_ms > 0 ? `${(r.duration_ms / 1000).toFixed(1)}s` : "—"}
                </td>
                <td className="p-3 text-muted-foreground text-xs">
                  {new Date(r.created_at).toLocaleString()}
                </td>
              </tr>
            ))}
            {runs.length === 0 && (
              <tr>
                <td colSpan={9} className="p-8 text-center text-muted-foreground">No runs found</td>
              </tr>
            )}
          </tbody>
        </table>
        <PaginationBar
          page={page}
          pageSize={pageSize}
          total={total}
          buildHref={(p, ps) => `/admin/runs?page=${p}&pageSize=${ps}`}
        />
      </div>
    </div>
  );
}

