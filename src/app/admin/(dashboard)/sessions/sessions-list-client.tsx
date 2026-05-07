"use client";

import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Inbox } from "lucide-react";
import { AdminTable, AdminTableHead, AdminTableRow, Th, EmptyRow } from "@/components/ui/admin-table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Empty, EmptyHeader, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty";
import { MessageSourceBadge } from "@/components/ui/message-source-badge";
import { LocalDate } from "@/components/local-date";
import type { RunTriggeredBy, SessionStatus } from "@/lib/types";

interface SessionItem {
  id: string;
  agent_id: string;
  agent_name: string;
  tenant_id: string;
  status: SessionStatus;
  ephemeral: boolean;
  message_count: number;
  total_cost_usd: number;
  latest_activity: string | null;
  latest_trigger: RunTriggeredBy | null;
  latest_message_status: string | null;
  sandbox_id: string | null;
  created_at: string;
  updated_at: string;
}

type DisplayStatus =
  | "creating"
  | "active"
  | "idle"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out"
  | "stopped";

const STATUS_VARIANT: Record<DisplayStatus, "default" | "secondary" | "destructive" | "outline"> = {
  creating: "outline",
  active: "default",
  idle: "secondary",
  completed: "default",
  failed: "destructive",
  cancelled: "outline",
  timed_out: "destructive",
  stopped: "outline",
};

const TERMINAL_MESSAGE_STATUSES = new Set(["completed", "failed", "cancelled", "timed_out"]);

// Once a session leaves `creating`/`active`, its lifecycle column (idle/stopped)
// no longer tells the user whether the run succeeded — the latest message status
// does. Mirror the detail page's per-message badge so a successful schedule run
// shows "completed" on the index instead of "stopped".
function deriveDisplayStatus(s: SessionItem): DisplayStatus {
  if (s.status === "creating" || s.status === "active") return s.status;
  if (s.latest_message_status && TERMINAL_MESSAGE_STATUSES.has(s.latest_message_status)) {
    return s.latest_message_status as DisplayStatus;
  }
  return s.status;
}

function statusLabel(s: SessionItem): string {
  const display = deriveDisplayStatus(s);
  if (display === "stopped" && s.ephemeral) return "stopped (ephemeral)";
  return display.replace("_", " ");
}

interface Props {
  initialSessions: SessionItem[];
  total: number;
  page: number;
  pageSize: number;
  sourceFilter: string | null;
  statusFilter: string | null;
  sort: "created_at" | "latest_activity" | "total_cost";
  filterBar: React.ReactNode;
  paginationBar: React.ReactNode;
}

export function SessionsListClient({
  initialSessions,
  total,
  filterBar,
  paginationBar,
  sort,
}: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const setSort = (next: "created_at" | "latest_activity" | "total_cost") => {
    const params = new URLSearchParams(searchParams.toString());
    if (next === "created_at") params.delete("sort");
    else params.set("sort", next);
    params.delete("page");
    const qs = params.toString();
    router.push(`/admin/sessions${qs ? `?${qs}` : ""}`);
  };

  const arrow = (key: typeof sort) => (sort === key ? " ↓" : "");

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        {filterBar}
        <p className="text-sm text-muted-foreground">{total} total</p>
      </div>

      {initialSessions.length === 0 ? (
        <Empty>
          <EmptyHeader>
            <EmptyMedia variant="icon"><Inbox /></EmptyMedia>
            <EmptyTitle>No runs yet</EmptyTitle>
            <EmptyDescription>
              Try the agent playground or wait for a scheduled run.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <AdminTable footer={paginationBar}>
          <AdminTableHead>
            <Th>Run</Th>
            <Th>Agent</Th>
            <Th>Status</Th>
            <Th>Latest Trigger</Th>
            <Th align="right">Messages</Th>
            <Th align="right">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setSort("total_cost")}
                className="ml-auto h-auto px-0 py-0 text-xs font-semibold uppercase tracking-wide hover:bg-transparent hover:underline"
              >
                Cost{arrow("total_cost")}
              </Button>
            </Th>
            <Th>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setSort("latest_activity")}
                className="h-auto px-0 py-0 text-xs font-semibold uppercase tracking-wide hover:bg-transparent hover:underline"
              >
                Latest Activity{arrow("latest_activity")}
              </Button>
            </Th>
            <Th>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => setSort("created_at")}
                className="h-auto px-0 py-0 text-xs font-semibold uppercase tracking-wide hover:bg-transparent hover:underline"
              >
                Created{arrow("created_at")}
              </Button>
            </Th>
          </AdminTableHead>
          <tbody>
            {initialSessions.map((s) => (
              <AdminTableRow key={s.id}>
                <td className="p-3 font-mono text-xs">
                  <Link href={`/admin/sessions/${s.id}`} className="text-primary hover:underline">
                    {s.id.slice(0, 8)}...
                  </Link>
                </td>
                <td className="p-3 text-xs">{s.agent_name}</td>
                <td className="p-3">
                  <Badge variant={STATUS_VARIANT[deriveDisplayStatus(s)] ?? "outline"} className="text-[10px]">
                    {statusLabel(s)}
                  </Badge>
                </td>
                <td className="p-3">
                  {s.latest_trigger ? (
                    <MessageSourceBadge triggeredBy={s.latest_trigger} />
                  ) : (
                    <span className="text-xs text-muted-foreground">—</span>
                  )}
                </td>
                <td className="p-3 text-right text-xs">{s.message_count}</td>
                <td className="p-3 text-right font-mono text-xs">
                  ${s.total_cost_usd.toFixed(4)}
                </td>
                <td className="p-3 text-muted-foreground text-xs">
                  {s.latest_activity ? <LocalDate value={s.latest_activity} /> : "—"}
                </td>
                <td className="p-3 text-muted-foreground text-xs">
                  <LocalDate value={s.created_at} />
                </td>
              </AdminTableRow>
            ))}
            {initialSessions.length === 0 && <EmptyRow colSpan={8}>No runs found</EmptyRow>}
          </tbody>
        </AdminTable>
      )}
    </div>
  );
}
