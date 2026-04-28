"use client";

import { use, useState, useRef, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Card, CardContent } from "@/components/ui/card";
import { MetricCard } from "@/components/ui/metric-card";
import { TranscriptViewer, type TranscriptEvent } from "@/components/transcript-viewer";
import { adminFetch, adminStream } from "@/app/admin/lib/api";

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "timed_out"]);

interface RunMetrics {
  costUsd: number;
  numTurns: number;
  durationMs: number;
  inputTokens: number;
  outputTokens: number;
}

function aggregateMetrics(events: TranscriptEvent[]): RunMetrics {
  let costUsd = 0;
  let numTurns = 0;
  let durationMs = 0;
  let inputTokens = 0;
  let outputTokens = 0;

  for (const ev of events) {
    if (ev.type === "result") {
      costUsd += Number(ev.cost_usd ?? ev.total_cost_usd ?? 0);
      numTurns += Number(ev.num_turns ?? 0);
      durationMs += Number(ev.duration_ms ?? 0);
      const usage = ev.usage as { input_tokens?: number; output_tokens?: number } | undefined;
      if (usage) {
        inputTokens += Number(usage.input_tokens ?? 0);
        outputTokens += Number(usage.output_tokens ?? 0);
      }
    }
  }

  return { costUsd, numTurns, durationMs, inputTokens, outputTokens };
}

export default function PlaygroundPage({ params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = use(params);
  const [prompt, setPrompt] = useState("");
  const [events, setEvents] = useState<TranscriptEvent[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [running, setRunning] = useState(false);
  const [polling, setPolling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const runIdRef = useRef<string | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const metrics = useMemo(() => aggregateMetrics(events), [events]);

  // Cleanup AbortController on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  async function reconnectToStream(messageId: string, eventOffset: number) {
    setPolling(true);

    const sid = sessionIdRef.current;
    try {
      let res: Response;
      try {
        if (!sid) throw new Error("No session id available for reconnect");
        res = await adminStream(`/sessions/${sid}/messages/${messageId}/stream?offset=${eventOffset}`, {
          signal: abortRef.current?.signal,
        });
      } catch (err) {
        if ((err as Error)?.name === "AbortError") return;
        await pollForFinalResult(messageId);
        return;
      }

      const reader = res.body!.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const event = JSON.parse(trimmed) as TranscriptEvent;
            if (event.type === "heartbeat") continue;

            if (event.type === "stream_detached") {
              const newOffset = typeof event.offset === "number" ? event.offset : eventOffset;
              reconnectToStream(messageId, newOffset);
              return;
            }

            if (event.type === "text_delta") {
              setStreamingText((prev) => prev + (event.text as string ?? ""));
            } else {
              if (event.type === "assistant") setStreamingText("");
              setEvents((prev) => [...prev, event]);
            }
          } catch {
            // Skip non-JSON lines
          }
        }
      }
    } catch (err) {
      if ((err as Error)?.name === "AbortError") return;
      await pollForFinalResult(messageId);
      return;
    } finally {
      setPolling(false);
      setRunning(false);
      abortRef.current = null;
      runIdRef.current = null;
    }
  }

  async function pollForFinalResult(messageId: string) {
    let delay = 3000;
    const maxDelay = 10_000;
    const sid = sessionIdRef.current;

    try {
      while (true) {
        if (abortRef.current?.signal.aborted) break;

        await new Promise((r) => setTimeout(r, delay));
        if (abortRef.current?.signal.aborted) break;

        let data: Record<string, unknown>;
        try {
          if (!sid) throw new Error("no session id");
          data = await adminFetch<Record<string, unknown>>(`/sessions/${sid}/messages/${messageId}`, {
            signal: abortRef.current?.signal,
          });
        } catch {
          delay = Math.min(delay * 2, maxDelay);
          continue;
        }
        const run = (data.message ?? data) as Record<string, unknown> | undefined;

        if (run && TERMINAL_STATUSES.has(run.status as string)) {
          const transcript = data.transcript as TranscriptEvent[] | undefined;
          if (transcript && transcript.length > 0) {
            const detachIdx = transcript.findIndex((ev) => ev.type === "stream_detached");
            const eventsAfterDetach = detachIdx >= 0 ? transcript.slice(detachIdx + 1) : [];
            const newEvents = eventsAfterDetach.filter(
              (ev: TranscriptEvent) =>
                ev.type !== "heartbeat" &&
                ev.type !== "text_delta" &&
                ev.type !== "run_started" &&
                ev.type !== "queued" &&
                ev.type !== "sandbox_starting"
            );
            if (newEvents.length > 0) {
              setEvents((prev) => [...prev, ...newEvents]);
            }
          }

          setEvents((prev) => {
            if (prev.some((ev) => ev.type === "result")) return prev;
            const syntheticResult: TranscriptEvent = {
              type: "result",
              subtype: run.status === "completed" ? "success" : "failed",
              cost_usd: run.cost_usd,
              num_turns: run.num_turns,
              duration_ms: run.duration_ms,
            };
            if (run.error_type) {
              syntheticResult.result = run.error_type;
            }
            return [...prev, syntheticResult];
          });
          break;
        }

        delay = Math.min(delay * 2, maxDelay);
      }
    } catch (err) {
      if ((err as Error)?.name !== "AbortError") {
        setError("Lost connection while waiting for results");
      }
    } finally {
      setPolling(false);
      setRunning(false);
      abortRef.current = null;
      runIdRef.current = null;
    }
  }

  async function consumeStream(res: Response) {
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let handedOffToReconnect = false;
    let transcriptEventCount = 0;
    let runId: string | null = null;

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const event = JSON.parse(trimmed) as TranscriptEvent;

            // Capture session ID from session_created event
            if (event.type === "session_created" && event.session_id) {
              sessionIdRef.current = event.session_id as string;
              setSessionId(event.session_id as string);
            }

            if (event.type === "run_started" && event.run_id) {
              runId = event.run_id as string;
              runIdRef.current = runId;
            }

            if (event.type === "text_delta") {
              setStreamingText((prev) => prev + (event.text as string ?? ""));
            } else if (event.type === "stream_detached") {
              setStreamingText("");
              setEvents((prev) => [...prev, event]);
              if (runId) {
                handedOffToReconnect = true;
                reconnectToStream(runId, transcriptEventCount);
                return;
              }
            } else {
              if (event.type === "assistant") setStreamingText("");
              setEvents((prev) => [...prev, event]);
              if (event.type !== "heartbeat") {
                transcriptEventCount++;
              }
            }
          } catch {
            // Skip non-JSON lines
          }
        }
      }
    } finally {
      if (!handedOffToReconnect) {
        setRunning(false);
        abortRef.current = null;
        runIdRef.current = null;
      }
    }
  }

  const handleSend = useCallback(async () => {
    if (!prompt.trim() || running) return;

    const messageText = prompt.trim();
    setPrompt("");
    setRunning(true);
    setStreamingText("");
    setError(null);
    setPolling(false);

    // Show user message in the event stream (rendered by TranscriptViewer)
    setEvents((prev) => [...prev, { type: "user_message", text: messageText }]);

    const abort = new AbortController();
    abortRef.current = abort;

    try {
      let res: Response;

      const currentSessionId = sessionIdRef.current;
      if (currentSessionId) {
        res = await adminStream(`/sessions/${currentSessionId}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: messageText }),
          signal: abort.signal,
        });
      } else {
        res = await adminStream("/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agent_id: agentId, prompt: messageText }),
          signal: abort.signal,
        });
      }

      // Dispatcher returns the session id via response header on the first
      // message — there is no `session_created` NDJSON event. Capture it
      // before consuming the stream so follow-up messages target this session.
      const headerSessionId = res.headers.get("X-Session-Id");
      if (headerSessionId && !sessionIdRef.current) {
        sessionIdRef.current = headerSessionId;
        setSessionId(headerSessionId);
      }
      const headerMessageId = res.headers.get("X-Message-Id");
      if (headerMessageId) {
        runIdRef.current = headerMessageId;
      }

      await consumeStream(res);
    } catch (err) {
      if ((err as Error)?.name !== "AbortError") {
        setError(err instanceof Error ? err.message : "Unknown error");
      }
      setRunning(false);
      abortRef.current = null;
      runIdRef.current = null;
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [prompt, running, agentId]);

  function handleNewChat() {
    abortRef.current?.abort();
    if (sessionId) {
      adminFetch(`/sessions/${sessionId}`, { method: "DELETE" }).catch((err) => {
        console.error("Failed to stop session:", err);
      });
    }
    sessionIdRef.current = null;
    setSessionId(null);
    setEvents([]);
    setStreamingText("");
    setRunning(false);
    setPolling(false);
    setError(null);
    setPrompt("");
    runIdRef.current = null;
    abortRef.current = null;
    textareaRef.current?.focus();
  }

  async function handleStop() {
    abortRef.current?.abort();
    const sid = sessionIdRef.current;
    if (sid) {
      adminFetch(`/sessions/${sid}/cancel`, { method: "POST" }).catch((err) => {
        console.error("Failed to cancel session:", err);
      });
    }
    runIdRef.current = null;
  }

  const hasContent = events.length > 0 || running;
  const isStreaming = running;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        {(sessionId || events.length > 0) && (
          <Button onClick={handleNewChat} variant="outline" size="sm" disabled={running}>
            New Chat
          </Button>
        )}
        {sessionId && (
          <span className="text-xs text-muted-foreground font-mono">
            Run: {sessionId.slice(0, 12)}…
          </span>
        )}
        {sessionId && !running && events.some((ev) => ev.type === "result") && (
          <Link
            href={`/admin/sessions/${sessionId}`}
            className="text-xs text-primary hover:underline"
          >
            View run →
          </Link>
        )}
      </div>

      {hasContent && (
        <>
          {/* Metric cards — same shape as runs view */}
          <div className="grid gap-4 grid-cols-4">
            <MetricCard label="Cost">
              <span className="font-mono">${metrics.costUsd > 0 ? metrics.costUsd.toFixed(4) : "—"}</span>
            </MetricCard>
            <MetricCard label="Turns">{metrics.numTurns}</MetricCard>
            <MetricCard label="Duration">
              {metrics.durationMs > 0 ? `${(metrics.durationMs / 1000).toFixed(1)}s` : isStreaming ? "..." : "—"}
            </MetricCard>
            <MetricCard label="Tokens">
              {(metrics.inputTokens + metrics.outputTokens).toLocaleString()}
              <p className="text-xs text-muted-foreground mt-0.5 font-normal">
                {metrics.inputTokens.toLocaleString()} in / {metrics.outputTokens.toLocaleString()} out
              </p>
            </MetricCard>
          </div>

          {/* Transcript — exact same component as runs view */}
          <TranscriptViewer transcript={events} isStreaming={isStreaming} />

          {/* Streaming text accumulation — same as runs view */}
          {isStreaming && streamingText && (
            <Card>
              <CardContent className="py-3">
                <div className="text-xs font-medium text-muted-foreground mb-1">Streaming text...</div>
                <pre className="text-sm font-mono whitespace-pre-wrap text-foreground">{streamingText}</pre>
              </CardContent>
            </Card>
          )}

          {running && !streamingText && polling && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="animate-pulse">●</span>
              Reconnected to sandbox, streaming updates…
            </div>
          )}
        </>
      )}

      {/* Input area */}
      <div className="space-y-2">
        {error && <p className="text-sm text-destructive">{error}</p>}
        <Textarea
          ref={textareaRef}
          placeholder={sessionId ? "Send a follow-up message…" : "Enter your prompt…"}
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={hasContent ? 3 : 12}
          disabled={running}
          className="font-mono text-sm resize-none"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleSend();
          }}
        />
        <div className="flex items-center gap-2">
          <Button onClick={handleSend} disabled={running || !prompt.trim()} size="sm">
            {running ? "Running…" : sessionId ? "Send" : "Run"}
          </Button>
          {running && (
            <Button onClick={handleStop} variant="outline" size="sm">
              Stop
            </Button>
          )}
          <span className="text-xs text-muted-foreground ml-1">⌘+Enter to send</span>
        </div>
      </div>
    </div>
  );
}
