import Link from "next/link";
import { notFound } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { queryOne } from "@/db";
import { RunRow } from "@/lib/validation";
import { TranscriptViewer } from "./transcript-viewer";

export const dynamic = "force-dynamic";

export default async function RunDetailPage({
  params,
  searchParams,
}: {
  params: Promise<{ runId: string }>;
  searchParams: Promise<{ from?: string }>;
}) {
  const { runId } = await params;
  const { from } = await searchParams;

  const run = await queryOne(RunRow, "SELECT * FROM runs WHERE id = $1", [runId]);
  if (!run) notFound();

  // Fetch transcript
  let transcript: { type: string; [key: string]: unknown }[] = [];
  if (run.transcript_blob_url) {
    try {
      const res = await fetch(run.transcript_blob_url);
      if (res.ok) {
        const text = await res.text();
        transcript = text
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            try {
              return JSON.parse(line);
            } catch {
              return { type: "raw", data: line };
            }
          });
      }
    } catch {
      // ok
    }
  }

  const statusVariant = run.status === "completed" ? "default"
    : run.status === "running" ? "secondary"
    : run.status === "failed" || run.status === "timed_out" ? "destructive"
    : "outline";

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        {from === "agent" ? (
          <Link href={`/admin/agents/${run.agent_id}`} className="text-muted-foreground hover:text-foreground text-sm">&larr; Agent</Link>
        ) : (
          <Link href="/admin/runs" className="text-muted-foreground hover:text-foreground text-sm">&larr; Runs</Link>
        )}
        <span className="text-muted-foreground">/</span>
        <h1 className="text-2xl font-semibold font-mono">{run.id.slice(0, 12)}...</h1>
        <Badge variant={statusVariant}>{run.status}</Badge>
      </div>

      {/* Metadata cards */}
      <div className={`grid gap-4 ${run.result_summary ? "grid-cols-5" : "grid-cols-4"}`}>
        {run.result_summary && (
          <Card>
            <CardHeader className="pb-2">
              <CardTitle className="text-sm font-medium text-muted-foreground">Result Summary</CardTitle>
            </CardHeader>
            <CardContent>
              <p className="text-sm text-muted-foreground line-clamp-3">{run.result_summary}</p>
            </CardContent>
          </Card>
        )}
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Cost</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold font-mono">${run.cost_usd.toFixed(4)}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Turns</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">{run.num_turns}</p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Duration</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold">
              {run.duration_ms > 0 ? `${(run.duration_ms / 1000).toFixed(1)}s` : "—"}
            </p>
          </CardContent>
        </Card>
        <Card>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm font-medium text-muted-foreground">Tokens</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="text-2xl font-bold font-mono">
              {(run.total_input_tokens + run.total_output_tokens).toLocaleString()}
            </p>
            <p className="text-xs text-muted-foreground mt-0.5">
              {run.total_input_tokens.toLocaleString()} in / {run.total_output_tokens.toLocaleString()} out
            </p>
          </CardContent>
        </Card>
      </div>

      {/* Errors */}
      {run.error_messages.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base text-destructive">Errors</CardTitle>
          </CardHeader>
          <CardContent className="space-y-2">
            {run.error_type && (
              <Badge variant="destructive">{run.error_type}</Badge>
            )}
            {run.error_messages.map((msg, i) => (
              <pre key={i} className="whitespace-pre-wrap text-sm text-destructive font-mono bg-destructive/10 rounded-md p-3">
                {msg}
              </pre>
            ))}
          </CardContent>
        </Card>
      )}

      {/* Transcript */}
      <TranscriptViewer transcript={transcript} prompt={run.prompt} />

      {/* Raw metadata */}
      <Card>
        <details>
          <summary className="flex items-center justify-between px-6 py-4 cursor-pointer list-none hover:bg-muted/30 transition-colors rounded-xl">
            <span className="text-base font-semibold">Metadata</span>
            <span className="text-xs text-muted-foreground details-marker">▼</span>
          </summary>
          <div className="px-6 pb-6">
            <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Run ID</dt>
              <dd className="font-mono">{run.id}</dd>
              <dt className="text-muted-foreground">Agent ID</dt>
              <dd className="font-mono">{run.agent_id}</dd>
              <dt className="text-muted-foreground">Tenant ID</dt>
              <dd className="font-mono">{run.tenant_id}</dd>
              <dt className="text-muted-foreground">Sandbox ID</dt>
              <dd className="font-mono">{run.sandbox_id || "—"}</dd>
              <dt className="text-muted-foreground">Started</dt>
              <dd>{run.started_at ? new Date(run.started_at).toLocaleString() : "—"}</dd>
              <dt className="text-muted-foreground">Completed</dt>
              <dd>{run.completed_at ? new Date(run.completed_at).toLocaleString() : "—"}</dd>
              <dt className="text-muted-foreground">Created</dt>
              <dd>{new Date(run.created_at).toLocaleString()}</dd>
            </dl>
          </div>
        </details>
      </Card>
    </div>
  );
}
