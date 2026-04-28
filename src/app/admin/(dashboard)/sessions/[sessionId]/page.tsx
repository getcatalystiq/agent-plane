import { notFound } from "next/navigation";
import { queryOne, query } from "@/db";
import { SessionRow, SessionMessageRow } from "@/lib/validation";
import { z } from "zod";
import { LiveSessionDetail } from "./live-session-detail";

export const dynamic = "force-dynamic";

const AgentSummary = z.object({
  name: z.string(),
  model: z.string().nullable(),
});

export default async function SessionDetailPage({
  params,
}: {
  params: Promise<{ sessionId: string }>;
}) {
  const { sessionId } = await params;

  const session = await queryOne(SessionRow, "SELECT * FROM sessions WHERE id = $1", [sessionId]);
  if (!session) notFound();

  const [messages, agent] = await Promise.all([
    query(
      SessionMessageRow,
      `SELECT m.*, a.name AS agent_name, a.model AS agent_model, s.agent_id
       FROM session_messages m
       LEFT JOIN sessions s ON m.session_id = s.id
       LEFT JOIN agents a ON s.agent_id = a.id
       WHERE m.session_id = $1
       ORDER BY m.created_at ASC`,
      [sessionId],
    ),
    queryOne(AgentSummary, "SELECT name, model FROM agents WHERE id = $1", [session.agent_id]),
  ]);

  // Cast messages to plain JSON-friendly shape (z.infer types include extras we want passed)
  const plainMessages = messages.map((m) => ({
    id: m.id,
    session_id: m.session_id,
    prompt: m.prompt,
    status: m.status,
    triggered_by: m.triggered_by,
    runner: m.runner,
    cost_usd: Number(m.cost_usd),
    num_turns: Number(m.num_turns),
    duration_ms: Number(m.duration_ms),
    total_input_tokens: Number(m.total_input_tokens),
    total_output_tokens: Number(m.total_output_tokens),
    result_summary: m.result_summary,
    error_type: m.error_type,
    error_messages: m.error_messages,
    transcript_blob_url: m.transcript_blob_url,
    started_at: m.started_at,
    completed_at: m.completed_at,
    created_at: m.created_at,
  }));

  return (
    <LiveSessionDetail
      session={{
        id: session.id,
        agent_id: session.agent_id,
        tenant_id: session.tenant_id,
        status: session.status,
        ephemeral: session.ephemeral,
        sandbox_id: session.sandbox_id,
        sdk_session_id: session.sdk_session_id,
        expires_at: session.expires_at,
        idle_ttl_seconds: session.idle_ttl_seconds,
        message_count: session.message_count,
        idle_since: session.idle_since,
        context_id: session.context_id,
        created_at: session.created_at,
        updated_at: session.updated_at,
      }}
      messages={plainMessages}
      agentName={agent?.name ?? null}
      agentModel={agent?.model ?? null}
    />
  );
}
