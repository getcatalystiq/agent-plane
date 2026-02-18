"use client";

import { use, useState, useRef } from "react";
import Link from "next/link";
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

function renderEvent(event: PlaygroundEvent, idx: number) {
  if (event.type === "heartbeat") return null;
  if (event.type === "text_delta") return null; // rendered separately as streaming text

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
        <MarkdownContent>{texts}</MarkdownContent>
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
  const [streamingText, setStreamingText] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  async function handleRun() {
    if (!prompt.trim() || running) return;

    setRunning(true);
    setEvents([]);
    setStreamingText("");
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
          {streamingText && (
            <div className="space-y-1">
              <span className="text-xs font-semibold text-blue-400 uppercase">Assistant</span>
              <MarkdownContent>{streamingText}</MarkdownContent>
              <span className="inline-block w-0.5 h-4 bg-foreground animate-pulse align-text-bottom" />
            </div>
          )}
          {running && !streamingText && (
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="animate-pulse">●</span> Running…
            </div>
          )}
        </div>
      )}
    </div>
  );
}
