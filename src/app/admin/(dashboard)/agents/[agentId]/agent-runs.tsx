import Link from "next/link";
import { RunStatusBadge } from "@/components/ui/run-status-badge";
import { MessageSourceBadge } from "@/components/ui/message-source-badge";
import { AdminTable, AdminTableHead, AdminTableRow, Th, EmptyRow } from "@/components/ui/admin-table";
import { LocalDate } from "@/components/local-date";
import { query } from "@/db";
import { RunTriggeredBySchema } from "@/lib/validation";
import { z } from "zod";

const AgentMessage = z.object({
  id: z.string(),
  session_id: z.string(),
  status: z.string(),
  prompt: z.string(),
  cost_usd: z.coerce.number(),
  num_turns: z.coerce.number(),
  duration_ms: z.coerce.number(),
  triggered_by: RunTriggeredBySchema.catch("api"),
  error_type: z.string().nullable(),
  created_at: z.coerce.string(),
});

export async function AgentRuns({ agentId }: { agentId: string }) {
  // Recent executions (session_messages) for this agent.
  const messages = await query(
    AgentMessage,
    `SELECT m.id, m.session_id, m.status, m.prompt, m.cost_usd, m.num_turns, m.duration_ms,
       m.triggered_by, m.error_type, m.created_at
     FROM session_messages m
     JOIN sessions s ON s.id = m.session_id
     WHERE s.agent_id = $1
     ORDER BY m.created_at DESC
     LIMIT 50`,
    [agentId],
  );

  return (
    <AdminTable>
      <AdminTableHead>
        <Th>Run</Th>
        <Th>Status</Th>
        <Th>Trigger</Th>
        <Th className="max-w-xs">Prompt</Th>
        <Th align="right">Cost</Th>
        <Th align="right">Turns</Th>
        <Th align="right">Duration</Th>
        <Th>Created</Th>
      </AdminTableHead>
      <tbody>
        {messages.map((m) => (
          <AdminTableRow key={m.id}>
            <td className="p-3 font-mono text-xs">
              <Link href={`/admin/sessions/${m.session_id}`} className="text-primary hover:underline">
                {m.session_id.slice(0, 8)}...
              </Link>
            </td>
            <td className="p-3"><RunStatusBadge status={m.status} /></td>
            <td className="p-3"><MessageSourceBadge triggeredBy={m.triggered_by} /></td>
            <td className="p-3 max-w-xs truncate text-muted-foreground text-xs" title={m.prompt}>
              {m.prompt.slice(0, 80)}{m.prompt.length > 80 ? "..." : ""}
            </td>
            <td className="p-3 text-right font-mono">${m.cost_usd.toFixed(4)}</td>
            <td className="p-3 text-right">{m.num_turns}</td>
            <td className="p-3 text-right text-muted-foreground text-xs">
              {m.duration_ms > 0 ? `${(m.duration_ms / 1000).toFixed(1)}s` : "—"}
            </td>
            <td className="p-3 text-muted-foreground text-xs">
              <LocalDate value={m.created_at} />
            </td>
          </AdminTableRow>
        ))}
        {messages.length === 0 && <EmptyRow colSpan={8}>No executions yet</EmptyRow>}
      </tbody>
    </AdminTable>
  );
}
