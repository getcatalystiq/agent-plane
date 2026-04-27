import { PaginationBar, parsePaginationParams } from "@/components/ui/pagination-bar";
import { SourceFilter } from "./source-filter";
import { RunsListClient } from "./runs-list-client";
import { query, queryOne } from "@/db";
import { RunTriggeredBySchema } from "@/lib/validation";
import { getActiveTenantId } from "@/lib/active-tenant";
import { z } from "zod";

const RunWithContext = z.object({
  id: z.string(),
  agent_id: z.string(),
  agent_name: z.string(),
  tenant_id: z.string(),
  status: z.string(),
  prompt: z.string(),
  cost_usd: z.coerce.number(),
  num_turns: z.coerce.number(),
  duration_ms: z.coerce.number(),
  total_input_tokens: z.coerce.number(),
  total_output_tokens: z.coerce.number(),
  triggered_by: RunTriggeredBySchema.catch("api"),
  error_type: z.string().nullable(),
  started_at: z.coerce.string().nullable(),
  completed_at: z.coerce.string().nullable(),
  created_at: z.coerce.string(),
});

export const dynamic = "force-dynamic";

const VALID_SOURCES = ["api", "schedule", "playground", "chat", "a2a"] as const;

export default async function RunsPage({
  searchParams,
}: {
  searchParams: Promise<{ page?: string; pageSize?: string; source?: string }>;
}) {
  const tenantId = (await getActiveTenantId()) ?? null;
  if (!tenantId) {
    return (
      <div className="text-muted-foreground text-sm py-12 text-center">
        Select a company from the sidebar.
      </div>
    );
  }

  const { page: pageParam, pageSize: pageSizeParam, source: sourceParam } = await searchParams;
  const { page, pageSize, offset } = parsePaginationParams(pageParam, pageSizeParam);
  const sourceFilter = VALID_SOURCES.includes(sourceParam as typeof VALID_SOURCES[number])
    ? (sourceParam as typeof VALID_SOURCES[number])
    : null;

  const sourceWhere = sourceFilter
    ? `WHERE r.tenant_id = $3 AND r.triggered_by = $4`
    : `WHERE r.tenant_id = $3`;
  const sourceWhereCount = sourceFilter
    ? `WHERE r.tenant_id = $1 AND r.triggered_by = $2`
    : `WHERE r.tenant_id = $1`;
  const params = sourceFilter
    ? [pageSize, offset, tenantId, sourceFilter]
    : [pageSize, offset, tenantId];

  const [runs, countResult] = await Promise.all([
    query(
      RunWithContext,
      `SELECT r.id, r.agent_id, a.name AS agent_name, r.tenant_id,
         r.status, r.triggered_by, r.prompt, r.cost_usd, r.num_turns, r.duration_ms,
         r.total_input_tokens, r.total_output_tokens, r.error_type,
         r.started_at, r.completed_at, r.created_at
       FROM runs r
       JOIN agents a ON a.id = r.agent_id
       ${sourceWhere}
       ORDER BY r.created_at DESC
       LIMIT $1 OFFSET $2`,
      params,
    ),
    queryOne(
      z.object({ total: z.number() }),
      `SELECT COUNT(*)::int AS total FROM runs r
       JOIN agents a ON a.id = r.agent_id
       ${sourceWhereCount}`,
      sourceFilter ? [tenantId, sourceFilter] : [tenantId],
    ),
  ]);

  const total = countResult?.total ?? 0;

  return (
    <RunsListClient
      initialRuns={runs}
      total={total}
      page={page}
      pageSize={pageSize}
      sourceFilter={sourceFilter}
      sourceFilterBar={<SourceFilter current={sourceFilter} />}
      paginationBar={
        <PaginationBar
          page={page}
          pageSize={pageSize}
          total={total}
          buildHref={(p, ps) => `/admin/runs?page=${p}&pageSize=${ps}${sourceFilter ? `&source=${sourceFilter}` : ""}`}
        />
      }
    />
  );
}
