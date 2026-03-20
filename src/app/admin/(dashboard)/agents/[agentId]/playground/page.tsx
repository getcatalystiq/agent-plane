"use client";

import { use, useState, useRef, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

function MarkdownContent({ children }: { children: string }) {
  return (
    <div className="text-sm text-foreground [&_p]:my-1 [&_h1]:text-lg [&_h1]:font-bold [&_h1]:my-2 [&_h2]:text-base [&_h2]:font-semibold [&_h2]:my-2 [&_h3]:text-sm [&_h3]:font-semibold [&_h3]:my-1 [&_ul]:list-disc [&_ul]:pl-5 [&_ul]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_ol]:my-1 [&_li]:my-0.5 [&_pre]:bg-muted [&_pre]:rounded-md [&_pre]:p-3 [&_pre]:overflow-x-auto [&_pre]:text-xs [&_pre]:my-2 [&_code:not(pre_code)]:bg-muted [&_code:not(pre_code)]:px-1 [&_code:not(pre_code)]:py-0.5 [&_code:not(pre_code)]:rounded [&_code:not(pre_code)]:text-xs [&_code:not(pre_code)]:font-mono [&_a]:text-blue-400 [&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-border [&_blockquote]:pl-3 [&_blockquote]:text-muted-foreground [&_blockquote]:my-2 [&_hr]:border-border [&_hr]:my-3 [&_table]:border-collapse [&_table]:text-xs [&_table]:w-full [&_th]:border [&_th]:border-border [&_th]:px-2 [&_th]:py-1 [&_th]:text-left [&_th]:font-semibold [&_th]:bg-muted [&_td]:border [&_td]:border-border [&_td]:px-2 [&_td]:py-1 [&_strong]:font-semibold [&_em]:italic">
      <ReactMarkdown
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        remarkPlugins={[remarkGfm as any]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}

interface PlaygroundEvent {
  type: string;
  [key: string]: unknown;
}

function CollapsibleJson({ data, maxHeight = "12rem" }: { data: unknown; maxHeight?: string }) {
  const [expanded, setExpanded] = useState(false);
  const json = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return (
    <div className="relative">
      <pre
        className={`text-xs font-mono text-muted-foreground bg-muted/50 rounded-md p-2 overflow-x-auto whitespace-pre-wrap break-all ${expanded ? "" : "overflow-hidden"}`}
        style={expanded ? undefined : { maxHeight }}
      >
        {json}
      </pre>
      {json.length > 200 && (
        <button
          onClick={() => setExpanded(!expanded)}
          className="text-xs text-blue-400 hover:text-blue-300 mt-1"
        >
          {expanded ? "Collapse" : "Expand"}
        </button>
      )}
    </div>
  );
}

function renderEvent(event: PlaygroundEvent, idx: number) {
  if (event.type === "heartbeat") return null;
  if (event.type === "text_delta") return null;
  if (event.type === "session_created") return null;
  if (event.type === "session_info") return null;

  if (event.type === "user_message") {
    return (
      <div key={idx} className="border-t border-border pt-3 mt-1">
        <span className="text-xs font-semibold text-emerald-400 uppercase">You</span>
        <p className="text-sm text-foreground mt-1 whitespace-pre-wrap">{String(event.text)}</p>
      </div>
    );
  }

  if (event.type === "assistant") {
    const content = event.message as { content?: Array<{ type: string; text?: string; name?: string; id?: string; input?: unknown }> } | undefined;
    const blocks = content?.content ?? [];
    const textBlocks = blocks.filter((c) => c.type === "text").map((c) => c.text).join("");
    const toolUseBlocks = blocks.filter((c) => c.type === "tool_use");
    if (!textBlocks && toolUseBlocks.length === 0) return null;
    return (
      <div key={idx} className="space-y-2">
        {textBlocks && (
          <div className="space-y-1">
            <span className="text-xs font-semibold text-blue-400 uppercase">Assistant</span>
            <MarkdownContent>{textBlocks}</MarkdownContent>
          </div>
        )}
        {toolUseBlocks.map((tool, ti) => (
          <div key={ti} className="space-y-1 ml-3 pl-3 border-l-2 border-yellow-800/50">
            <span className="text-xs font-semibold text-yellow-400 uppercase">
              Tool Call: {tool.name ?? "unknown"}
            </span>
            {tool.id && <span className="text-xs text-muted-foreground ml-2 font-mono">{String(tool.id)}</span>}
            {tool.input != null && <CollapsibleJson data={tool.input} />}
          </div>
        ))}
      </div>
    );
  }

  if (event.type === "tool_use") {
    const toolName = String(event.tool_name ?? event.name ?? "unknown");
    return (
      <div key={idx} className="space-y-1 ml-3 pl-3 border-l-2 border-yellow-800/50">
        <div className="flex items-center gap-2">
          <span className="text-xs font-semibold text-yellow-400 uppercase">Tool Call</span>
          <span className="text-xs font-mono text-yellow-400/80">{toolName}</span>
          {event.tool_use_id ? <span className="text-xs text-muted-foreground font-mono">{String(event.tool_use_id)}</span> : null}
        </div>
        {event.input != null ? <CollapsibleJson data={event.input} /> : null}
      </div>
    );
  }

  if (event.type === "tool_result") {
    const isError = event.is_error === true || event.error === true;
    const content = event.output ?? event.content ?? "";
    const contentStr = typeof content === "string" ? content : JSON.stringify(content, null, 2);
    return (
      <div key={idx} className={`space-y-1 ml-3 pl-3 border-l-2 ${isError ? "border-red-800/50" : "border-green-800/50"}`}>
        <div className="flex items-center gap-2">
          <span className={`text-xs font-semibold uppercase ${isError ? "text-red-400" : "text-green-400"}`}>
            {isError ? "Tool Error" : "Tool Result"}
          </span>
          {event.tool_name ? <span className="text-xs font-mono text-muted-foreground">{String(event.tool_name)}</span> : null}
          {event.tool_use_id ? <span className="text-xs text-muted-foreground font-mono">{String(event.tool_use_id)}</span> : null}
        </div>
        {contentStr ? <CollapsibleJson data={contentStr} /> : null}
      </div>
    );
  }

  if (event.type === "result") {
    const success = event.subtype === "success";
    const costUsd = event.cost_usd ?? event.total_cost_usd;
    return (
      <div key={idx} className={`rounded-md px-3 py-2 flex items-center gap-3 ${success ? "bg-green-950/50 border border-green-800/50" : "bg-red-950/50 border border-red-800/50"}`}>
        <span className={`text-xs font-semibold ${success ? "text-green-400" : "text-red-400"}`}>
          {success ? "Completed" : "Failed"}
        </span>
        <div className="flex flex-wrap gap-3 text-xs text-muted-foreground">
          {event.num_turns != null && <span>{String(event.num_turns)} turns</span>}
          {costUsd != null && Number(costUsd) > 0 && <span>${Number(costUsd).toFixed(4)}</span>}
          {event.duration_ms != null && <span>{(Number(event.duration_ms) / 1000).toFixed(1)}s</span>}
          {event.duration_api_ms != null && <span>API: {(Number(event.duration_api_ms) / 1000).toFixed(1)}s</span>}
        </div>
      </div>
    );
  }

  if (event.type === "error") {
    return (
      <div key={idx} className="rounded-md p-3 bg-red-950 border border-red-800">
        <div className="flex items-center gap-2">
          <p className="text-sm font-semibold text-red-400">Error</p>
          {event.code ? <span className="text-xs font-mono text-red-400/70">{String(event.code)}</span> : null}
        </div>
        <p className="text-sm text-foreground mt-1">{String(event.error ?? "Unknown error")}</p>
      </div>
    );
  }

  if (event.type === "stream_detached") {
    return (
      <div key={idx} className="text-xs text-muted-foreground italic border-t border-border pt-2">
        Stream detached at {event.timestamp ? new Date(String(event.timestamp)).toLocaleTimeString() : "unknown"} — run continues in background
      </div>
    );
  }

  if (event.type === "queued") {
    return (
      <div key={idx} className="text-xs text-muted-foreground">Queued…</div>
    );
  }

  if (event.type === "sandbox_starting") {
    return (
      <div key={idx} className="text-xs text-muted-foreground">Starting sandbox…</div>
    );
  }

  if (event.type === "run_started") {
    return (
      <div key={idx} className="text-xs text-muted-foreground">
        Agent started
        {event.model ? <span className="ml-2 font-mono text-foreground/60">{String(event.model)}</span> : null}
        {event.mcp_server_count != null && Number(event.mcp_server_count) > 0 && (
          <span className="ml-2">{String(event.mcp_server_count)} MCP server{Number(event.mcp_server_count) !== 1 ? "s" : ""}</span>
        )}
      </div>
    );
  }

  if (event.type === "system") {
    return (
      <div key={idx} className="text-xs text-muted-foreground italic">
        {String(event.message ?? JSON.stringify(event))}
      </div>
    );
  }

  // Catch-all: show any unrecognized events so nothing is hidden
  return (
    <div key={idx} className="space-y-1">
      <span className="text-xs font-semibold text-purple-400 uppercase">{event.type}</span>
      <CollapsibleJson data={event} maxHeight="8rem" />
    </div>
  );
}

const TERMINAL_STATUSES = new Set(["completed", "failed", "cancelled", "timed_out"]);

export default function PlaygroundPage({ params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = use(params);
  const [prompt, setPrompt] = useState("");
  const [events, setEvents] = useState<PlaygroundEvent[]>([]);
  const [streamingText, setStreamingText] = useState("");
  const [running, setRunning] = useState(false);
  const [polling, setPolling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const runIdRef = useRef<string | null>(null);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events, streamingText]);

  // Cleanup AbortController on unmount
  useEffect(() => {
    return () => {
      abortRef.current?.abort();
    };
  }, []);

  async function reconnectToStream(runId: string, eventOffset: number) {
    setPolling(true);

    try {
      const res = await fetch(`/api/admin/runs/${runId}/stream?offset=${eventOffset}`, {
        signal: abortRef.current?.signal,
      });

      if (!res.ok) {
        await pollForFinalResult(runId);
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
            const event = JSON.parse(trimmed) as PlaygroundEvent;
            if (event.type === "heartbeat") continue;

            if (event.type === "stream_detached") {
              const newOffset = typeof event.offset === "number" ? event.offset : eventOffset;
              reconnectToStream(runId, newOffset);
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
      await pollForFinalResult(runId);
      return;
    } finally {
      setPolling(false);
      setRunning(false);
      abortRef.current = null;
      runIdRef.current = null;
    }
  }

  async function pollForFinalResult(runId: string) {
    let delay = 3000;
    const maxDelay = 10_000;

    try {
      while (true) {
        if (abortRef.current?.signal.aborted) break;

        await new Promise((r) => setTimeout(r, delay));
        if (abortRef.current?.signal.aborted) break;

        const res = await fetch(`/api/admin/runs/${runId}`, {
          signal: abortRef.current?.signal,
        });
        if (!res.ok) {
          delay = Math.min(delay * 2, maxDelay);
          continue;
        }

        const data = await res.json();
        const run = data.run;

        if (TERMINAL_STATUSES.has(run.status)) {
          const transcript = data.transcript as PlaygroundEvent[] | undefined;
          if (transcript && transcript.length > 0) {
            const detachIdx = transcript.findIndex((ev) => ev.type === "stream_detached");
            const eventsAfterDetach = detachIdx >= 0 ? transcript.slice(detachIdx + 1) : [];
            const newEvents = eventsAfterDetach.filter(
              (ev: PlaygroundEvent) =>
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
            const syntheticResult: PlaygroundEvent = {
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
            const event = JSON.parse(trimmed) as PlaygroundEvent;

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

    // Show user message in the event stream
    setEvents((prev) => [...prev, { type: "user_message", text: messageText }]);

    const abort = new AbortController();
    abortRef.current = abort;

    try {
      let res: Response;

      const currentSessionId = sessionIdRef.current;
      if (currentSessionId) {
        // Follow-up message to existing session
        res = await fetch(`/api/admin/sessions/${currentSessionId}/messages`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ prompt: messageText }),
          signal: abort.signal,
        });
      } else {
        // First message — create session with prompt
        res = await fetch("/api/admin/sessions", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ agent_id: agentId, prompt: messageText }),
          signal: abort.signal,
        });
      }

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        const msg = data?.error?.message ?? data?.error ?? `HTTP ${res.status}`;
        setError(typeof msg === "string" ? msg : JSON.stringify(msg));
        setRunning(false);
        return;
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
    // Stop the current session in the background
    if (sessionId) {
      fetch(`/api/admin/sessions/${sessionId}`, { method: "DELETE" }).catch((err) => {
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
    const id = runIdRef.current;
    if (id) {
      runIdRef.current = null;
      fetch(`/api/admin/runs/${id}/cancel`, { method: "POST" }).catch((err) => {
        console.error("Failed to cancel run:", err);
      });
    }
  }

  const hasContent = events.length > 0 || running;

  return (
    <div className="flex flex-col h-[calc(100vh-6rem)]">
      <div className="flex items-center gap-3 mb-4">
        {(sessionId || events.length > 0) && (
          <Button onClick={handleNewChat} variant="outline" size="sm" disabled={running}>
            New Chat
          </Button>
        )}
        {sessionId && (
          <span className="text-xs text-muted-foreground font-mono">
            Session: {sessionId.slice(0, 12)}…
          </span>
        )}
      </div>

      {/* Scrollable output area */}
      {hasContent && (
        <div ref={scrollRef} className="flex-1 min-h-0 overflow-y-auto rounded-lg border border-border bg-muted/20 p-4 space-y-4 mb-4">
          {events.map((ev, i) => renderEvent(ev, i))}
          {streamingText && (
            <div className="space-y-1">
              <span className="text-xs font-semibold text-blue-400 uppercase">Assistant</span>
              <MarkdownContent>{streamingText}</MarkdownContent>
              <span className="inline-block w-0.5 h-4 bg-foreground animate-pulse align-text-bottom" />
            </div>
          )}
          {running && !streamingText && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="animate-pulse">●</span> {polling ? "Reconnected to sandbox, streaming updates…" : "Running…"}
            </div>
          )}
        </div>
      )}

      {/* Input area at the bottom */}
      <div className="space-y-2 shrink-0">
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
