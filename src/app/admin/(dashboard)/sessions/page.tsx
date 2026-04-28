import { Suspense } from "react";
import { PaginationBar, parsePaginationParams } from "@/components/ui/pagination-bar";
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
      <div className="text-muted-foreground text-sm py-12 text-center">
        Select a company from the sidebar.
      </div>
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
  const orderBy =
    sort === "latest_activity"
      ? "COALESCE((SELECT MAX(m.completed_at) FROM session_messages m WHERE m.session_id = s.id), s.updated_at) DESC NULLS LAST"
      : sort === "total_cost"
        ? "(SELECT COALESCE(SUM(m.cost_usd), 0) FROM session_messages m WHERE m.session_id = s.id) DESC"
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
  if (sourceFilter) {
    whereParts.push(
      `EXISTS (SELECT 1 FROM session_messages m
                WHERE m.session_id = s.id
                  AND m.created_at = (SELECT MAX(m2.created_at) FROM session_messages m2 WHERE m2.session_id = s.id)
                  AND m.triggered_by = $${p++})`,
    );
    params.push(sourceFilter);
  }

  const whereSql = whereParts.join(" AND ");

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
      COALESCE((SELECT SUM(m.cost_usd) FROM session_messages m WHERE m.session_id = s.id), 0) AS total_cost_usd,
      (SELECT MAX(m.completed_at) FROM session_messages m WHERE m.session_id = s.id) AS latest_activity,
      (
        SELECT m.triggered_by FROM session_messages m
         WHERE m.session_id = s.id
         ORDER BY m.created_at DESC
         LIMIT 1
      ) AS latest_trigger
    FROM sessions s
    JOIN agents a ON a.id = s.agent_id
    WHERE ${whereSql}
    ORDER BY ${orderBy}
    LIMIT $${p++} OFFSET $${p}`;

  const listParams = [...params, pageSize, offset];

  const countSql = `
    SELECT COUNT(*)::int AS total
    FROM sessions s
    WHERE ${whereSql}`;

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
