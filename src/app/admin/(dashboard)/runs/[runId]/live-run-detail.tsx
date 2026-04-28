"use client";

import { useState, useEffect, useRef, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { MetricCard } from "@/components/ui/metric-card";
import { LocalDate } from "@/components/local-date";
import { TranscriptViewer } from "@/components/transcript-viewer";
import { CancelRunButton } from "./cancel-run-button";
import { adminStream } from "@/app/admin/lib/api";
import { toast } from "@/hooks/use-toast";

interface RunData {
  id: string;
  agent_id: string;
  tenant_id: string;
  status: string;
  prompt: string;
  result_summary: string | null;
  total_input_tokens: number;
  total_output_tokens: number;
  cost_usd: number | null;
  num_turns: number;
  duration_ms: number;
  runner: string | null;
  transcript_blob_url: string | null;
  error_type: string | null;
  error_messages: string[];
  sandbox_id: string | null;
  triggered_by: string;
  created_by_key_id: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

interface TranscriptEvent {
  type: string;
  [key: string]: unknown;
}

interface LiveRunDetailProps {
  run: RunData;
  transcript: TranscriptEvent[];
  agentModel: string | null;
  requestedByKeyName: string | null;
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "timed_out"]);
const RERUNNABLE_STATUSES = new Set(["failed", "cancelled", "timed_out"]);

export function LiveRunDetail({ run: initialRun, transcript: initialTranscript, agentModel, requestedByKeyName }: LiveRunDetailProps) {
  const router = useRouter();
  const [run, setRun] = useState(initialRun);
  const [events, setEvents] = useState<TranscriptEvent[]>(initialTranscript);
  const [isStreaming, setIsStreaming] = useState(!TERMINAL_STATUSES.has(initialRun.status));
  const [textDelta, setTextDelta] = useState("");
  const [isRerunning, setIsRerunning] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const eventCountRef = useRef(initialTranscript.length);

  const connectStream = useCallback((offset: number) => {
    const controller = new AbortController();
    abortRef.current = controller;

    (async () => {
      try {
        const res = await fetch(`/api/admin/runs/${initialRun.id}/stream?offset=${offset}`, {
          signal: controller.signal,
        });
        if (!res.ok || !res.body) {
          setIsStreaming(false);
          return;
        }

        const reader = res.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (!line.trim()) continue;
            let event: TranscriptEvent;
            try {
              event = JSON.parse(line);
            } catch {
              continue;
            }

            if (event.type === "heartbeat") continue;

            if (event.type === "stream_detached") {
              // Reconnect with current offset
              const currentOffset = eventCountRef.current;
              setTimeout(() => connectStream(currentOffset), 1000);
              return;
            }

            if (event.type === "text_delta") {
              setTextDelta((prev) => prev + String(event.text || ""));
              continue;
            }

            if (event.type === "assistant") {
              setTextDelta("");
            }

            // Accumulate events
            setEvents((prev) => {
              const next = [...prev, event];
              eventCountRef.current = next.length;
              return next;
            });

            // Handle terminal events
            if (event.type === "result") {
              setIsStreaming(false);
              const success = event.subtype === "success";
              toast({
                title: success ? "Run completed" : "Run finished",
                description: success
                  ? `Completed in ${event.num_turns || 0} turns`
                  : String(event.result || "Run finished"),
                variant: success ? "success" : "default",
              });
              // Refresh server data
              router.refresh();
              return;
            }

            if (event.type === "error") {
              setIsStreaming(false);
              toast({
                title: "Run failed",
                description: String(event.error || "Unknown error"),
                variant: "destructive",
              });
              router.refresh();
              return;
            }
          }
        }

        // Stream ended without terminal event — poll for final state
        setIsStreaming(false);
        router.refresh();
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setIsStreaming(false);
        router.refresh();
      }
    })();
  }, [initialRun.id, router]);

  useEffect(() => {
    if (!TERMINAL_STATUSES.has(initialRun.status)) {
      connectStream(initialTranscript.length);
    }
    return () => {
      abortRef.current?.abort();
    };
  }, [initialRun.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // Update run from initial props when server refreshes
  useEffect(() => {
    setRun(initialRun);
    if (TERMINAL_STATUSES.has(initialRun.status)) {
      setIsStreaming(false);
      setEvents(initialTranscript);
    }
  }, [initialRun, initialTranscript]);

  const isActive = run.status === "running" || run.status === "pending";
  const isRerunnable = RERUNNABLE_STATUSES.has(run.status);

  const handleRerun = async () => {
    setIsRerunning(true);
    try {
      const res = await adminStream(`/agents/${run.agent_id}/runs`, {
        method: "POST",
        body: JSON.stringify({ prompt: run.prompt }),
      });
      const reader = res.body?.getReader();
      if (!reader) throw new Error("No response body");
      const decoder = new TextDecoder();
      let buffer = "";
      let newRunId: string | null = null;

      while (!newRunId) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const event = JSON.parse(line);
            if (event.type === "sandbox_starting" && event.run_id) {
              newRunId = event.run_id;
            }
          } catch { /* skip non-JSON */ }
        }
      }
      reader.cancel();

      if (newRunId) {
        router.push(`/admin/runs/${newRunId}`);
      } else {
        throw new Error("Could not get new run ID from response");
      }
    } catch (err) {
      toast({
        title: "Rerun failed",
        description: err instanceof Error ? err.message : String(err),
        variant: "destructive",
      });
    } finally {
      setIsRerunning(false);
    }
  };

  return (
    <div className="space-y-6">
      {(isActive || isRerunnable) && (
        <div className="flex items-center justify-end gap-2">
          {isActive && <CancelRunButton runId={run.id} />}
          {isRerunnable && (
            <button
              onClick={handleRerun}
              disabled={isRerunning}
              className="inline-flex items-center gap-1.5 rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isRerunning ? "Rerunning..." : "\u21BB Rerun"}
            </button>
          )}
        </div>
      )}

      {/* A2A request origin */}
      {run.triggered_by === "a2a" && requestedByKeyName && (
        <div className="flex items-center gap-2 text-sm text-muted-foreground">
          <Badge variant="outline" className="text-[10px]">A2A</Badge>
          <span>Requested by <span className="font-medium text-foreground">{requestedByKeyName}</span></span>
        </div>
      )}

      {/* Metadata cards */}
      <div className={`grid gap-4 ${run.result_summary ? "grid-cols-5" : "grid-cols-4"}`}>
        {run.result_summary && (
          <MetricCard label="Result Summary">
            <span className="line-clamp-1">{run.result_summary}</span>
            <p className="text-xs text-muted-foreground mt-0.5 font-normal">{run.status}</p>
          </MetricCard>
        )}
        <MetricCard label="Model">
          <span className="font-mono text-xs">{agentModel || "—"}</span>
          <p className="text-xs text-muted-foreground mt-0.5 font-normal">
            <span className={`inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${run.runner === "vercel-ai-sdk" ? "bg-blue-500/10 text-blue-400" : "bg-orange-500/10 text-orange-400"}`}>
              {run.runner === "vercel-ai-sdk" ? "AI SDK" : "Claude SDK"}
            </span>
          </p>
        </MetricCard>
        <MetricCard label="Cost"><span className="font-mono">${run.cost_usd != null ? run.cost_usd.toFixed(4) : "—"}</span></MetricCard>
        <MetricCard label="Turns">{run.num_turns}</MetricCard>
        <MetricCard label="Duration">
          {run.duration_ms > 0 ? `${(run.duration_ms / 1000).toFixed(1)}s` : isStreaming ? "..." : "—"}
        </MetricCard>
        <MetricCard label="Tokens">
          {(run.total_input_tokens + run.total_output_tokens).toLocaleString()}
          <p className="text-xs text-muted-foreground mt-0.5 font-normal">
            {run.total_input_tokens.toLocaleString()} in / {run.total_output_tokens.toLocaleString()} out
          </p>
        </MetricCard>
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
      <TranscriptViewer transcript={events} prompt={run.prompt} isStreaming={isStreaming} />

      {/* Text delta accumulation */}
      {isStreaming && textDelta && (
        <Card>
          <CardContent className="py-3">
            <div className="text-xs font-medium text-muted-foreground mb-1">Streaming text...</div>
            <pre className="text-sm font-mono whitespace-pre-wrap text-foreground">{textDelta}</pre>
          </CardContent>
        </Card>
      )}

      {/* Raw metadata */}
      <Card>
        <details>
          <summary className="flex items-center justify-between px-6 py-4 cursor-pointer list-none hover:bg-muted/30 transition-colors rounded-xl">
            <span className="text-base font-semibold">Metadata</span>
            <span className="text-xs text-muted-foreground details-marker">&#9660;</span>
          </summary>
          <div className="px-6 pb-6">
            <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Run ID</dt>
              <dd className="font-mono">{run.id}</dd>
              <dt className="text-muted-foreground">Agent ID</dt>
              <dd className="font-mono">{run.agent_id}</dd>
              <dt className="text-muted-foreground">Company ID</dt>
              <dd className="font-mono">{run.tenant_id}</dd>
              <dt className="text-muted-foreground">Sandbox ID</dt>
              <dd className="font-mono">{run.sandbox_id || "—"}</dd>
              <dt className="text-muted-foreground">Started</dt>
              <dd><LocalDate value={run.started_at} /></dd>
              <dt className="text-muted-foreground">Completed</dt>
              <dd><LocalDate value={run.completed_at} /></dd>
              <dt className="text-muted-foreground">Created</dt>
              <dd><LocalDate value={run.created_at} /></dd>
            </dl>
          </div>
        </details>
      </Card>
    </div>
  );
}
