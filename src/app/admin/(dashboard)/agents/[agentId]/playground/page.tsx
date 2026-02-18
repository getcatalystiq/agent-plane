"use client";

import { use, useState, useRef } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

interface PlaygroundEvent {
  type: string;
  [key: string]: unknown;
}

function renderEvent(event: PlaygroundEvent, idx: number) {
  if (event.type === "heartbeat") return null;

  if (event.type === "assistant") {
    const content = event.message as { content?: Array<{ type: string; text?: string }> };
    const texts = content?.content
      ?.filter((c) => c.type === "text")
      .map((c) => c.text)
      .join("") ?? "";
    if (!texts) return null;
    return (
      <div key={idx} className="space-y-1">
        <span className="text-xs font-semibold text-blue-400 uppercase">Assistant</span>
        <p className="text-sm whitespace-pre-wrap text-foreground">{texts}</p>
      </div>
    );
  }

  if (event.type === "tool_use") {
    return (
      <div key={idx} className="space-y-1">
        <span className="text-xs font-semibold text-yellow-400 uppercase">Tool</span>
        <p className="text-xs font-mono text-muted-foreground">
          {String(event.tool_name ?? event.name ?? "unknown")}
          {event.input ? ` ${JSON.stringify(event.input).slice(0, 200)}` : ""}
        </p>
      </div>
    );
  }

  if (event.type === "tool_result") {
    return (
      <div key={idx} className="space-y-1">
        <span className="text-xs font-semibold text-green-400 uppercase">Tool Result</span>
        <p className="text-xs font-mono text-muted-foreground line-clamp-3">
          {String(event.output ?? event.content ?? "").slice(0, 300)}
        </p>
      </div>
    );
  }

  if (event.type === "result") {
    const success = event.subtype === "success";
    return (
      <div key={idx} className={`rounded-md p-3 ${success ? "bg-green-950 border border-green-800" : "bg-red-950 border border-red-800"}`}>
        <p className={`text-sm font-semibold ${success ? "text-green-400" : "text-red-400"}`}>
          {success ? "Completed" : "Failed"}
        </p>
        {event.result != null && (
          <p className="text-sm mt-1 text-foreground whitespace-pre-wrap">{String(event.result)}</p>
        )}
        <p className="text-xs text-muted-foreground mt-1">
          {event.num_turns != null ? `${event.num_turns} turns` : ""}
          {event.cost_usd != null ? ` · $${Number(event.cost_usd).toFixed(4)}` : ""}
        </p>
      </div>
    );
  }

  if (event.type === "error") {
    return (
      <div key={idx} className="rounded-md p-3 bg-red-950 border border-red-800">
        <p className="text-sm font-semibold text-red-400">Error</p>
        <p className="text-sm text-foreground mt-1">{String(event.error ?? "Unknown error")}</p>
      </div>
    );
  }

  if (event.type === "stream_detached") {
    return (
      <div key={idx} className="text-xs text-muted-foreground italic">
        Stream detached (run continues in background)
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
      <div key={idx} className="text-xs text-muted-foreground">Agent started</div>
    );
  }

  // Skip other low-level events
  return null;
}

export default function PlaygroundPage({ params }: { params: Promise<{ agentId: string }> }) {
  const { agentId } = use(params);
  const [prompt, setPrompt] = useState("");
  const [events, setEvents] = useState<PlaygroundEvent[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  async function handleRun() {
    if (!prompt.trim() || running) return;

    setRunning(true);
    setEvents([]);
    setError(null);

    const abort = new AbortController();
    abortRef.current = abort;

    try {
      const res = await fetch(`/api/admin/agents/${agentId}/runs`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ prompt }),
        signal: abort.signal,
      });

      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.error ?? `HTTP ${res.status}`);
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
            setEvents((prev) => [...prev, event]);
          } catch {
            // Skip non-JSON lines
          }
        }
      }
    } catch (err) {
      if ((err as Error)?.name !== "AbortError") {
        setError(err instanceof Error ? err.message : "Unknown error");
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }

  function handleStop() {
    abortRef.current?.abort();
  }

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Link href={`/admin/agents/${agentId}`} className="text-muted-foreground hover:text-foreground text-sm">
          &larr; Agent
        </Link>
        <span className="text-muted-foreground">/</span>
        <h1 className="text-xl font-semibold">Playground</h1>
      </div>

      <div className="space-y-2">
        <Textarea
          placeholder="Enter your prompt…"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          rows={5}
          disabled={running}
          className="font-mono text-sm resize-none"
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) handleRun();
          }}
        />
        <div className="flex items-center gap-2">
          <Button onClick={handleRun} disabled={running || !prompt.trim()} size="sm">
            {running ? "Running…" : "Run"}
          </Button>
          {running && (
            <Button onClick={handleStop} variant="outline" size="sm">
              Stop
            </Button>
          )}
          <span className="text-xs text-muted-foreground ml-1">⌘+Enter to run</span>
        </div>
        {error && <p className="text-sm text-red-500">{error}</p>}
      </div>

      {(running || events.length > 0) && (
        <div className="rounded-lg border border-border bg-muted/20 p-4 space-y-4 min-h-32 max-h-[60vh] overflow-y-auto">
          {events.map((ev, i) => renderEvent(ev, i))}
          {running && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="animate-pulse">●</span> Running…
            </div>
          )}
        </div>
      )}
    </div>
  );
}
