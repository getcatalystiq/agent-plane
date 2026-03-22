import { query, queryOne } from "@/db";
import { getActiveTenantId } from "@/lib/active-tenant";
import { AdminTable, AdminTableHead, AdminTableRow, Th, EmptyRow } from "@/components/ui/admin-table";
import { LocalDate } from "@/components/local-date";
import { Badge } from "@/components/ui/badge";
import { StopSessionButton } from "./stop-session-button";
import { z } from "zod";

export const dynamic = "force-dynamic";

const SessionWithAgent = z.object({
  id: z.string(),
  agent_id: z.string(),
  agent_name: z.string(),
  status: z.string(),
  message_count: z.coerce.number(),
  sandbox_id: z.string().nullable(),
  idle_since: z.coerce.string().nullable(),
  last_message_at: z.coerce.string().nullable(),
  created_at: z.coerce.string(),
});

const STATUS_VARIANT: Record<string, "default" | "secondary" | "destructive" | "outline"> = {
  active: "default",
  idle: "secondary",
  creating: "outline",
  stopped: "outline",
};

export default async function SessionsPage() {
  const tenantId = (await getActiveTenantId()) ?? null;
  if (!tenantId) {
    return (
      <div className="text-muted-foreground text-sm py-12 text-center">
        Select a company from the sidebar.
      </div>
    );
  }

  const [sessions, countResult] = await Promise.all([
    query(
      SessionWithAgent,
      `SELECT s.id, s.agent_id, a.name AS agent_name, s.status,
         s.message_count, s.sandbox_id, s.idle_since, s.last_message_at, s.created_at
       FROM sessions s
       JOIN agents a ON a.id = s.agent_id
       WHERE s.tenant_id = $1
       ORDER BY s.created_at DESC
       LIMIT 100`,
      [tenantId],
    ),
    queryOne(
      z.object({ active: z.number(), total: z.number() }),
      `SELECT
         COUNT(*) FILTER (WHERE status != 'stopped')::int AS active,
         COUNT(*)::int AS total
       FROM sessions WHERE tenant_id = $1`,
      [tenantId],
    ),
  ]);

  const active = countResult?.active ?? 0;
  const total = countResult?.total ?? 0;

  return (
    <div>
      <div className="flex items-center gap-4 mb-6">
        <p className="text-sm text-muted-foreground">
          <span className={active >= 5 ? "text-destructive font-semibold" : ""}>{active}</span>
          {" "}/ 5 active sessions
          <span className="ml-2 text-muted-foreground/60">({total} total)</span>
        </p>
      </div>
      <AdminTable>
        <AdminTableHead>
          <Th>Session</Th>
          <Th>Agent</Th>
          <Th>Status</Th>
          <Th align="right">Messages</Th>
          <Th>Last Active</Th>
          <Th>Created</Th>
          <Th></Th>
        </AdminTableHead>
        <tbody>
          {sessions.map((s) => (
            <AdminTableRow key={s.id}>
              <td className="p-3 font-mono text-xs text-muted-foreground">
                {s.id.slice(0, 8)}...
              </td>
              <td className="p-3 text-xs">{s.agent_name}</td>
              <td className="p-3">
                <Badge variant={STATUS_VARIANT[s.status] ?? "outline"} className="text-[10px]">
                  {s.status}
                </Badge>
              </td>
              <td className="p-3 text-right text-xs">{s.message_count}</td>
              <td className="p-3 text-muted-foreground text-xs">
                {s.last_message_at ? <LocalDate value={s.last_message_at} /> : "—"}
              </td>
              <td className="p-3 text-muted-foreground text-xs">
                <LocalDate value={s.created_at} />
              </td>
              <td className="p-3 text-right">
                <StopSessionButton sessionId={s.id} status={s.status} />
              </td>
            </AdminTableRow>
          ))}
          {sessions.length === 0 && <EmptyRow colSpan={7}>No sessions found</EmptyRow>}
        </tbody>
      </AdminTable>
    </div>
  );
}
