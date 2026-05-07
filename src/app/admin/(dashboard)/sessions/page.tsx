import { Suspense } from "react";
import { Building2 } from "lucide-react";
import { PaginationBar, parsePaginationParams } from "@/components/ui/pagination-bar";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty";
import { SourceFilter } from "./source-filter";
import { StatusFilter } from "./status-filter";
import { SessionsListClient } from "./sessions-list-client";
import { SessionsLoadingSkeleton } from "./sessions-loading";
import { query, queryOne } from "@/db";
import { RunTriggeredBySchema, SessionStatusSchema } from "@/lib/validation";
import { getActiveTenantId } from "@/lib/active-tenant";
import { z } from "zod";

const SessionWithContext = z.object({
  id: z.string(),
  agent_id: z.string(),
  agent_name: z.string(),
  tenant_id: z.string(),
  status: SessionStatusSchema,
  ephemeral: z.boolean(),
  message_count: z.coerce.number(),
  total_cost_usd: z.coerce.number(),
  latest_activity: z.coerce.string().nullable(),
  latest_trigger: RunTriggeredBySchema.nullable().catch(null),
  latest_message_status: z.string().nullable(),
  sandbox_id: z.string().nullable(),
  created_at: z.coerce.string(),
  updated_at: z.coerce.string(),
});

export const dynamic = "force-dynamic";

const VALID_SOURCES = ["api", "schedule", "playground", "chat", "a2a", "webhook"] as const;
const VALID_STATUSES = ["creating", "active", "idle", "stopped"] as const;
const VALID_SORTS = ["created_at", "latest_activity", "total_cost"] as const;
type SortKey = typeof VALID_SORTS[number];

export default async function SessionsPage({
  searchParams,
}: {
  searchParams: Promise<{
    page?: string;
    pageSize?: string;
    source?: string;
    status?: string;
    sort?: string;
  }>;
}) {
  const tenantId = (await getActiveTenantId()) ?? null;
  if (!tenantId) {
    return (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon"><Building2 /></EmptyMedia>
          <EmptyTitle>No company selected</EmptyTitle>
          <EmptyDescription>Pick a company from the switcher in the sidebar to view its runs.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  }

  const sp = await searchParams;
  const { page, pageSize, offset } = parsePaginationParams(sp.page, sp.pageSize);
  const sourceFilter = VALID_SOURCES.includes(sp.source as typeof VALID_SOURCES[number])
    ? (sp.source as typeof VALID_SOURCES[number])
    : null;
  const statusFilter = VALID_STATUSES.includes(sp.status as typeof VALID_STATUSES[number])
    ? (sp.status as typeof VALID_STATUSES[number])
    : null;
  const sort: SortKey = (VALID_SORTS as readonly string[]).includes(sp.sort ?? "")
    ? (sp.sort as SortKey)
    : "created_at";
  // FIX #11: ORDER BY references the LATERAL aggregate columns (single pass)
  // instead of correlated subqueries. With idx_session_messages_session_created
  // the planner can drive the lateral via the index.
  const orderBy =
    sort === "latest_activity"
      ? "COALESCE(agg.latest_activity, s.updated_at) DESC NULLS LAST"
      : sort === "total_cost"
        ? "agg.total_cost DESC NULLS LAST"
        : "s.created_at DESC";

  return (
    <Suspense fallback={<SessionsLoadingSkeleton />}>
      <SessionsListServer
        tenantId={tenantId}
        page={page}
        pageSize={pageSize}
        offset={offset}
        sourceFilter={sourceFilter}
        statusFilter={statusFilter}
        sort={sort}
        orderBy={orderBy}
      />
    </Suspense>
  );
}

async function SessionsListServer({
  tenantId,
  page,
  pageSize,
  offset,
  sourceFilter,
  statusFilter,
  sort,
  orderBy,
}: {
  tenantId: string;
  page: number;
  pageSize: number;
  offset: number;
  sourceFilter: string | null;
  statusFilter: string | null;
  sort: SortKey;
  orderBy: string;
}) {
  const whereParts: string[] = ["s.tenant_id = $1"];
  const params: unknown[] = [tenantId];
  let p = 2;

  if (statusFilter) {
    whereParts.push(`s.status = $${p++}`);
    params.push(statusFilter);
  }
  // FIX #11: filter-by-source uses the per-session aggregate `latest_trigger`
  // computed by the LATERAL join below — single pass over session_messages.
  if (sourceFilter) {
    whereParts.push(`agg.latest_trigger = $${p++}`);
    params.push(sourceFilter);
  }

  const whereSql = whereParts.join(" AND ");

  // FIX #11 (perf-001): keep the SUM + MAX aggregate inside the LATERAL but
  // serve `latest_trigger` from a one-row LIMIT 1 subquery. The previous
  // ARRAY_AGG materialized every triggered_by per session; the LIMIT 1 form
  // hits idx_session_messages_session_created with a single index fetch.
  const listSql = `
    SELECT
      s.id,
      s.agent_id,
      a.name AS agent_name,
      s.tenant_id,
      s.status,
      s.ephemeral,
      s.message_count,
      s.sandbox_id,
      s.created_at,
      s.updated_at,
      COALESCE(agg.total_cost, 0) AS total_cost_usd,
      agg.latest_activity AS latest_activity,
      latest.triggered_by AS latest_trigger,
      latest.status AS latest_message_status
    FROM sessions s
    JOIN agents a ON a.id = s.agent_id
    LEFT JOIN LATERAL (
      SELECT
        SUM(m.cost_usd) AS total_cost,
        MAX(COALESCE(m.completed_at, m.created_at)) AS latest_activity
      FROM session_messages m
      WHERE m.session_id = s.id
    ) agg ON true
    LEFT JOIN LATERAL (
      SELECT triggered_by, status
      FROM session_messages
      WHERE session_id = s.id
      ORDER BY created_at DESC
      LIMIT 1
    ) latest ON true
    WHERE ${whereSql.replace(/agg\.latest_trigger/g, "latest.triggered_by")}
    ORDER BY ${orderBy}
    LIMIT $${p++} OFFSET $${p}`;

  const listParams = [...params, pageSize, offset];

  // The count query also needs `latest_trigger` when sourceFilter is active.
  // Same LIMIT 1 subquery; no full-message aggregation required.
  const countSql = sourceFilter
    ? `
      SELECT COUNT(*)::int AS total
      FROM sessions s
      LEFT JOIN LATERAL (
        SELECT triggered_by AS latest_trigger
        FROM session_messages m
        WHERE m.session_id = s.id
        ORDER BY m.created_at DESC
        LIMIT 1
      ) agg ON true
      WHERE ${whereSql}`
    : `
      SELECT COUNT(*)::int AS total
      FROM sessions s
      WHERE ${whereSql}`;

  // FIX #11: countSql only references `agg.latest_trigger` when sourceFilter
  // is set; otherwise it's a plain COUNT over sessions. Either way `params`
  // already carries all positional placeholders used by `whereParts`.
  const [sessions, countResult] = await Promise.all([
    query(SessionWithContext, listSql, listParams),
    queryOne(z.object({ total: z.number() }), countSql, params),
  ]);

  const total = countResult?.total ?? 0;

  const qs = (extra: Record<string, string | null>) => {
    const out = new URLSearchParams();
    if (sourceFilter) out.set("source", sourceFilter);
    if (statusFilter) out.set("status", statusFilter);
    if (sort !== "created_at") out.set("sort", sort);
    for (const [k, v] of Object.entries(extra)) {
      if (v === null) out.delete(k);
      else out.set(k, v);
    }
    const s = out.toString();
    return s ? `?${s}` : "";
  };

  return (
    <SessionsListClient
      initialSessions={sessions}
      total={total}
      page={page}
      pageSize={pageSize}
      sourceFilter={sourceFilter}
      statusFilter={statusFilter}
      sort={sort}
      filterBar={
        <div className="flex items-center gap-2">
          <SourceFilter current={sourceFilter} />
          <StatusFilter current={statusFilter} />
        </div>
      }
      paginationBar={
        <PaginationBar
          page={page}
          pageSize={pageSize}
          total={total}
          buildHref={(pp, ps) => `/admin/sessions${qs({ page: String(pp), pageSize: String(ps) })}`}
        />
      }
    />
  );
}
