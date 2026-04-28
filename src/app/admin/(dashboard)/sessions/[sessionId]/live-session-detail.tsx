"use client";

import { useState, useEffect, useRef, useCallback, useMemo } from "react";
import { useRouter } from "next/navigation";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardTitle, CardContent } from "@/components/ui/card";
import { MetricCard } from "@/components/ui/metric-card";
import { LocalDate } from "@/components/local-date";
import { TranscriptViewer, type TranscriptEvent } from "@/components/transcript-viewer";
import { MessageSourceBadge } from "@/components/ui/message-source-badge";
import { CancelSessionButton } from "./cancel-session-button";
import type { RunTriggeredBy, SessionStatus } from "@/lib/types";
import { toast } from "@/hooks/use-toast";

interface SessionData {
  id: string;
  agent_id: string;
  tenant_id: string;
  status: SessionStatus;
  ephemeral: boolean;
  sandbox_id: string | null;
  sdk_session_id: string | null;
  expires_at: string;
  idle_ttl_seconds: number;
  message_count: number;
  idle_since: string | null;
  context_id: string | null;
  created_at: string;
  updated_at: string;
}

interface SessionMessage {
  id: string;
  session_id: string;
  prompt: string;
  status: string;
  triggered_by: RunTriggeredBy;
  runner: string | null;
  cost_usd: number;
  num_turns: number;
  duration_ms: number;
  total_input_tokens: number;
  total_output_tokens: number;
  result_summary: string | null;
  error_type: string | null;
  error_messages: string[];
  transcript_blob_url: string | null;
  started_at: string | null;
  completed_at: string | null;
  created_at: string;
}

const TERMINAL_MESSAGE_STATUSES = new Set(["completed", "failed", "cancelled", "timed_out"]);
const PAGE_SIZE = 50;

interface Props {
  session: SessionData;
  messages: SessionMessage[];
  agentName: string | null;
  agentModel: string | null;
}

interface MessageRowProps {
  message: SessionMessage;
  defaultExpanded: boolean;
  isLatestActive: boolean;
  liveEvents: TranscriptEvent[];
  isStreaming: boolean;
  streamingText: string;
}

function MessageRow({
  message,
  defaultExpanded,
  isLatestActive,
  liveEvents,
  isStreaming,
  streamingText,
}: MessageRowProps) {
  const [expanded, setExpanded] = useState(defaultExpanded);
  const [transcriptEvents, setTranscriptEvents] = useState<TranscriptEvent[] | null>(null);
  const [loadingTranscript, setLoadingTranscript] = useState(false);
  const [transcriptError, setTranscriptError] = useState<string | null>(null);

  const events = useMemo(() => {
    if (isLatestActive) return liveEvents;
    return transcriptEvents ?? [];
  }, [isLatestActive, liveEvents, transcriptEvents]);

  // Lazy-load transcript blob when expanded for non-active messages
  useEffect(() => {
    if (!expanded || isLatestActive) return;
    if (transcriptEvents !== null) return;
    if (!message.transcript_blob_url) return;

    let cancelled = false;
    setLoadingTranscript(true);
    setTranscriptError(null);
    fetch(message.transcript_blob_url)
      .then(async (res) => {
        if (!res.ok) throw new Error(`Failed to load transcript: ${res.status}`);
        return res.text();
      })
      .then((text) => {
        if (cancelled) return;
        // Transcript blobs are stored as NDJSON (one event per line),
        // not a JSON array. Split + parse per line; skip lines that fail.
        const arr: TranscriptEvent[] = [];
        for (const line of text.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            arr.push(JSON.parse(trimmed) as TranscriptEvent);
          } catch {
            // Skip malformed lines rather than failing the whole load.
          }
        }
        setTranscriptEvents(arr);
      })
      .catch((err: Error) => {
        if (cancelled) return;
        setTranscriptError(err.message);
        setTranscriptEvents([]);
      })
      .finally(() => {
        if (!cancelled) setLoadingTranscript(false);
      });

    return () => {
      cancelled = true;
    };
  }, [expanded, isLatestActive, message.transcript_blob_url, transcriptEvents]);

  const startTime = message.started_at ?? message.created_at;

  return (
    <Card>
      <button
        type="button"
        className="w-full flex items-center justify-between px-6 py-4 cursor-pointer hover:bg-muted/30 transition-colors text-left"
        onClick={() => setExpanded(!expanded)}
      >
        <div className="flex items-center gap-3">
          <span className="text-xs text-muted-foreground details-marker">
            {expanded ? "▼" : "▶"}
          </span>
          <MessageSourceBadge triggeredBy={message.triggered_by} />
          <Badge
            variant={
              message.status === "completed"
                ? "default"
                : message.status === "running"
                  ? "secondary"
                  : message.status === "failed" || message.status === "timed_out"
                    ? "destructive"
                    : "outline"
            }
            className="text-[10px]"
          >
            {message.status.replace("_", " ")}
          </Badge>
          <span className="text-xs text-muted-foreground">
            <LocalDate value={startTime} />
          </span>
        </div>
        <div className="flex items-center gap-4 text-xs text-muted-foreground">
          <span className="font-mono">${message.cost_usd.toFixed(4)}</span>
          <span>{message.num_turns} turns</span>
          {message.duration_ms > 0 && <span>{(message.duration_ms / 1000).toFixed(1)}s</span>}
        </div>
      </button>

      {expanded && (
        <CardContent className="pt-0">
          {message.error_messages.length > 0 && (
            <div className="mb-4 space-y-2">
              {message.error_type && <Badge variant="destructive">{message.error_type}</Badge>}
              {message.error_messages.map((msg, i) => (
                <pre
                  key={i}
                  className="whitespace-pre-wrap text-sm text-destructive font-mono bg-destructive/10 rounded-md p-3"
                >
                  {msg}
                </pre>
              ))}
            </div>
          )}

          {loadingTranscript ? (
            <div className="text-sm text-muted-foreground py-6">Loading transcript…</div>
          ) : transcriptError ? (
            <div className="text-sm text-destructive py-6">{transcriptError}</div>
          ) : (
            <TranscriptViewer
              transcript={events}
              prompt={message.prompt}
              isStreaming={isLatestActive && isStreaming}
            />
          )}

          {isLatestActive && isStreaming && streamingText && (
            <Card className="mt-3">
              <CardContent className="py-3">
                <div className="text-xs font-medium text-muted-foreground mb-1">Streaming text...</div>
                <pre className="text-sm font-mono whitespace-pre-wrap text-foreground">{streamingText}</pre>
              </CardContent>
            </Card>
          )}
        </CardContent>
      )}
    </Card>
  );
}

export function LiveSessionDetail({ session: initialSession, messages: initialMessages, agentName, agentModel }: Props) {
  const router = useRouter();
  const [session, setSession] = useState(initialSession);
  const [messages, setMessages] = useState(initialMessages);
  const [visibleCount, setVisibleCount] = useState(Math.min(initialMessages.length, PAGE_SIZE));

  // Live streaming state for the latest in-flight message
  const [liveEvents, setLiveEvents] = useState<TranscriptEvent[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const abortRef = useRef<AbortController | null>(null);

  const latestMessage = messages.length > 0 ? messages[messages.length - 1] : null;
  const isLatestInFlight = useMemo(() => {
    if (!latestMessage) return false;
    return !TERMINAL_MESSAGE_STATUSES.has(latestMessage.status);
  }, [latestMessage]);

  // Subscribe to session-level stream when there's an in-flight message
  const connectStream = useCallback(() => {
    if (!latestMessage || !isLatestInFlight) return;
    const controller = new AbortController();
    abortRef.current = controller;
    setIsStreaming(true);
    setLiveEvents([]);
    setStreamingText("");

    (async () => {
      try {
        const res = await fetch(`/api/admin/sessions/${initialSession.id}/stream`, {
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
              setIsStreaming(false);
              router.refresh();
              return;
            }

            if (event.type === "text_delta") {
              setStreamingText((prev) => prev + String(event.text || ""));
              continue;
            }

            if (event.type === "assistant") {
              setStreamingText("");
            }

            setLiveEvents((prev) => [...prev, event]);

            if (event.type === "result") {
              setIsStreaming(false);
              const success = event.subtype === "success";
              toast({
                title: success ? "Message completed" : "Message finished",
                description: success
                  ? `Completed in ${event.num_turns || 0} turns`
                  : String(event.result || "Message finished"),
                variant: success ? "success" : "default",
              });
              router.refresh();
              return;
            }

            if (event.type === "error") {
              setIsStreaming(false);
              toast({
                title: "Message failed",
                description: String(event.error || "Unknown error"),
                variant: "destructive",
              });
              router.refresh();
              return;
            }
          }
        }
        setIsStreaming(false);
        router.refresh();
      } catch (err) {
        if ((err as Error).name === "AbortError") return;
        setIsStreaming(false);
        router.refresh();
      }
    })();
  }, [initialSession.id, isLatestInFlight, latestMessage, router]);

  useEffect(() => {
    if (isLatestInFlight) connectStream();
    return () => {
      abortRef.current?.abort();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLatestInFlight, latestMessage?.id]);

  // Sync server data on refresh
  useEffect(() => {
    setSession(initialSession);
    setMessages(initialMessages);
    setVisibleCount((prev) => Math.max(prev, Math.min(initialMessages.length, PAGE_SIZE)));
  }, [initialSession, initialMessages]);

  const totalMessages = messages.length;
  // Display newest first, but keep latest auto-expanded
  const displayMessages = useMemo(() => {
    const start = Math.max(0, totalMessages - visibleCount);
    return messages.slice(start);
  }, [messages, visibleCount, totalMessages]);
  const hasMore = totalMessages > visibleCount;

  const totalCost = messages.reduce((sum, m) => sum + (Number(m.cost_usd) || 0), 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-end gap-2">
        <CancelSessionButton sessionId={session.id} status={session.status} />
      </div>

      {/* Session metadata cards */}
      <div className="grid grid-cols-4 gap-4">
        <MetricCard label="Status">
          <span className="text-base">
            {session.status === "stopped" && session.ephemeral
              ? "stopped (ephemeral)"
              : session.status}
          </span>
          <p className="text-xs text-muted-foreground mt-0.5 font-normal">
            {session.ephemeral ? "Ephemeral" : "Persistent"}
          </p>
        </MetricCard>
        <MetricCard label="Agent">
          <span className="text-base">{agentName ?? "—"}</span>
          <p className="text-xs text-muted-foreground mt-0.5 font-normal font-mono">
            {agentModel ?? "—"}
          </p>
        </MetricCard>
        <MetricCard label="Messages">
          {totalMessages}
        </MetricCard>
        <MetricCard label="Total Cost">
          <span className="font-mono">${totalCost.toFixed(4)}</span>
        </MetricCard>
      </div>

      {/* Creating placeholder */}
      {session.status === "creating" && messages.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center">
            <p className="text-sm text-muted-foreground animate-pulse">Sandbox starting…</p>
          </CardContent>
        </Card>
      )}

      {/* Messages list (oldest first within visible window) */}
      {messages.length > 0 && (
        <div className="space-y-3">
          {hasMore && (
            <div className="flex justify-center">
              <Button
                type="button"
                variant="link"
                size="sm"
                onClick={() => setVisibleCount((c) => c + PAGE_SIZE)}
              >
                Load older ({totalMessages - visibleCount} more)
              </Button>
            </div>
          )}
          {displayMessages.map((m, i) => {
            const absoluteIdx = totalMessages - displayMessages.length + i;
            const isLast = absoluteIdx === totalMessages - 1;
            const isLatestActive = isLast && isLatestInFlight;
            return (
              <MessageRow
                key={m.id}
                message={m}
                defaultExpanded={isLast}
                isLatestActive={isLatestActive}
                liveEvents={liveEvents}
                isStreaming={isStreaming}
                streamingText={streamingText}
              />
            );
          })}
        </div>
      )}

      {/* Raw metadata */}
      <Card>
        <details>
          <summary className="flex items-center justify-between px-6 py-4 cursor-pointer list-none hover:bg-muted/30 transition-colors rounded-xl">
            <span className="text-base font-semibold">Metadata</span>
            <span className="text-xs text-muted-foreground details-marker">▼</span>
          </summary>
          <div className="px-6 pb-6">
            <dl className="grid grid-cols-2 gap-x-8 gap-y-2 text-sm">
              <dt className="text-muted-foreground">Session ID</dt>
              <dd className="font-mono">{session.id}</dd>
              <dt className="text-muted-foreground">Agent ID</dt>
              <dd className="font-mono">{session.agent_id}</dd>
              <dt className="text-muted-foreground">Company ID</dt>
              <dd className="font-mono">{session.tenant_id}</dd>
              <dt className="text-muted-foreground">Sandbox ID</dt>
              <dd className="font-mono">{session.sandbox_id || "—"}</dd>
              <dt className="text-muted-foreground">SDK Session ID</dt>
              <dd className="font-mono">{session.sdk_session_id || "—"}</dd>
              <dt className="text-muted-foreground">Context ID</dt>
              <dd className="font-mono">{session.context_id || "—"}</dd>
              <dt className="text-muted-foreground">Ephemeral</dt>
              <dd>{session.ephemeral ? "true" : "false"}</dd>
              <dt className="text-muted-foreground">Idle TTL</dt>
              <dd>{session.idle_ttl_seconds}s</dd>
              <dt className="text-muted-foreground">Idle Since</dt>
              <dd>{session.idle_since ? <LocalDate value={session.idle_since} /> : "—"}</dd>
              <dt className="text-muted-foreground">Expires At</dt>
              <dd><LocalDate value={session.expires_at} /></dd>
              <dt className="text-muted-foreground">Created</dt>
              <dd><LocalDate value={session.created_at} /></dd>
              <dt className="text-muted-foreground">Updated</dt>
              <dd><LocalDate value={session.updated_at} /></dd>
            </dl>
          </div>
        </details>
      </Card>
    </div>
  );
}
