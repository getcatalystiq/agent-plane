"use client";

import { useState, useMemo, useRef, useEffect, useCallback } from "react";
import ReactMarkdown from "react-markdown";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

export interface TranscriptEvent {
  type: string;
  [key: string]: unknown;
}

interface ContentBlock {
  type: string;
  text?: string;
  id?: string;
  name?: string;
  input?: unknown;
}

interface ConversationItem {
  role: "user" | "system" | "assistant" | "tool" | "result" | "error" | "a2a_incoming" | "mcp_status" | "rate_limit";
  text?: string;
  toolName?: string;
  toolInput?: unknown;
  toolOutput?: string;
  toolUseId?: string;
  model?: string;
  tools?: string[];
  skills?: string[];
  costUsd?: number;
  numTurns?: number;
  durationMs?: number;
  subtype?: string;
  error?: string;
  timestamp?: string;
  callbackUrl?: string;
  sender?: string;
  raw?: unknown;
}

function buildConversation(events: TranscriptEvent[]): ConversationItem[] {
  const items: ConversationItem[] = [];
  // Map tool_use_id to index for pairing results
  const toolCallMap = new Map<string, number>();

  for (const event of events) {
    if (event.type === "user_message") {
      items.push({ role: "user", text: String(event.text || "") });
    } else if (event.type === "system") {
      items.push({
        role: "system",
        model: String((event as TranscriptEvent).model || ""),
        tools: (event.tools as string[]) || [],
        skills: (event.skills as string[]) || [],
      });
    } else if (event.type === "assistant") {
      const msg = event.message as { content?: ContentBlock[] };
      const blocks = msg?.content || [];
      for (const block of blocks) {
        if (block.type === "text" && block.text) {
          items.push({ role: "assistant", text: block.text });
        } else if (block.type === "tool_use" && block.name) {
          const idx = items.length;
          items.push({
            role: "tool",
            toolName: block.name,
            toolInput: block.input,
            toolUseId: block.id,
          });
          if (block.id) toolCallMap.set(block.id, idx);
        }
      }
    } else if (event.type === "user") {
      const msg = event.message as { content?: Array<{ type: string; tool_use_id?: string; content?: string | Array<{ type: string; text?: string }> }> };
      const blocks = msg?.content || [];
      for (const block of blocks) {
        if (block.type === "tool_result" && block.tool_use_id) {
          const idx = toolCallMap.get(block.tool_use_id);
          if (idx !== undefined && items[idx]) {
            let output = "";
            if (typeof block.content === "string") {
              output = block.content;
            } else if (Array.isArray(block.content)) {
              output = block.content
                .filter((c) => c.type === "text" && c.text)
                .map((c) => c.text)
                .join("\n");
            }
            items[idx] = { ...items[idx], toolOutput: output };
          }
        }
      }
    } else if (event.type === "tool_use") {
      // Vercel AI SDK flat tool_use events
      const idx = items.length;
      items.push({
        role: "tool",
        toolName: String(event.tool_name || event.name || "unknown"),
        toolInput: event.input,
        toolUseId: event.tool_use_id ? String(event.tool_use_id) : undefined,
      });
      if (event.tool_use_id) toolCallMap.set(String(event.tool_use_id), idx);
    } else if (event.type === "tool_result") {
      // Vercel AI SDK flat tool_result events
      const id = String(event.tool_use_id || "");
      const idx = toolCallMap.get(id);
      const output = typeof event.result === "string" ? event.result : JSON.stringify(event.result, null, 2);
      if (idx !== undefined && items[idx]) {
        items[idx] = { ...items[idx], toolOutput: output };
      } else {
        // Unmatched result — show as standalone tool result
        items.push({
          role: "tool",
          toolName: String(event.tool_name || "tool"),
          toolOutput: output,
          toolUseId: id || undefined,
        });
      }
    } else if (event.type === "run_started") {
      items.push({
        role: "system",
        model: String(event.model || ""),
        tools: (event.mcp_server_names as string[]) || [],
      });
    } else if (event.type === "mcp_error") {
      items.push({
        role: "error",
        error: `MCP (${event.server}): ${event.error}`,
      });
    } else if (event.type === "result") {
      items.push({
        role: "result",
        subtype: String(event.subtype || ""),
        costUsd: Number(event.cost_usd || 0),
        numTurns: Number(event.num_turns || 0),
        durationMs: Number(event.duration_ms || 0),
        text: String(event.result || ""),
      });
    } else if (event.type === "a2a_incoming") {
      items.push({
        role: "a2a_incoming",
        sender: String(event.agent_name || event.sender || "unknown"),
        text: event.prompt_preview ? String(event.prompt_preview) : undefined,
        callbackUrl: event.callback_url ? String(event.callback_url) : undefined,
        timestamp: event.timestamp ? String(event.timestamp) : undefined,
      });
    } else if (event.type === "error") {
      items.push({
        role: "error",
        error: String(event.error || "Unknown error"),
      });
    } else if (event.type === "mcp_status") {
      items.push({ role: "mcp_status", raw: event });
    } else if (event.type === "rate_limit_event") {
      items.push({ role: "rate_limit", raw: event });
    }
  }

  return items;
}

export function TranscriptViewer({ transcript, prompt, isStreaming = false }: { transcript: TranscriptEvent[]; prompt?: string; isStreaming?: boolean }) {
  const conversation = useMemo(() => buildConversation(transcript), [transcript]);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const userHasScrolledUpRef = useRef(false);
  const [, setUserHasScrolledUp] = useState(false);

  const handleScroll = useCallback(() => {
    const el = scrollContainerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 50;
    if (atBottom) {
      userHasScrolledUpRef.current = false;
      setUserHasScrolledUp(false);
    } else {
      userHasScrolledUpRef.current = true;
      setUserHasScrolledUp(true);
    }
  }, []);

  useEffect(() => {
    if (isStreaming && !userHasScrolledUpRef.current) {
      sentinelRef.current?.scrollIntoView({ behavior: "smooth" });
    }
  }, [transcript.length, isStreaming]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Transcript</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <div
          ref={scrollContainerRef}
          onScroll={isStreaming ? handleScroll : undefined}
          className="space-y-3 overflow-y-auto px-6 pb-6"
        >
          {prompt && (
            <div className="rounded-md border border-border bg-muted/20 px-4 py-3">
              <div className="text-xs font-medium text-muted-foreground mb-1">Prompt</div>
              <pre className="text-xs font-mono whitespace-pre-wrap">{prompt}</pre>
            </div>
          )}
          {transcript.length === 0 ? (
            <p className="text-sm text-muted-foreground">No transcript available</p>
          ) : (
            <ConversationView items={conversation} />
          )}
          {isStreaming && (
            <div className="flex items-center gap-2 px-4 py-2 text-xs text-muted-foreground">
              <span className="h-2 w-2 rounded-full bg-blue-400 animate-pulse" />
              Streaming...
            </div>
          )}
          <div ref={sentinelRef} />
        </div>
      </CardContent>
    </Card>
  );
}

function ConversationView({ items }: { items: ConversationItem[] }) {
  return (
    <div className="space-y-3">
      {items.map((item, i) => {
        switch (item.role) {
          case "user":
            return <UserItem key={i} item={item} />;
          case "a2a_incoming":
            return <A2AIncomingItem key={i} item={item} />;
          case "system":
            return <SystemItem key={i} item={item} />;
          case "assistant":
            return <AssistantItem key={i} item={item} />;
          case "tool":
            return <ToolItem key={i} item={item} />;
          case "result":
            return <ResultItem key={i} item={item} />;
          case "error":
            return <ErrorItem key={i} item={item} />;
          case "mcp_status":
            return <CollapsedEventItem key={i} label="mcp_status" raw={item.raw} />;
          case "rate_limit":
            return <CollapsedEventItem key={i} label="rate_limit_event" raw={item.raw} />;
          default:
            return null;
        }
      })}
    </div>
  );
}

function UserItem({ item }: { item: ConversationItem }) {
  return (
    <div className="rounded-md border border-border bg-muted/20 px-4 py-3">
      <div className="flex items-center gap-2 mb-1">
        <Badge variant="outline" className="text-[10px]">user</Badge>
      </div>
      <pre className="text-xs font-mono whitespace-pre-wrap">{item.text}</pre>
    </div>
  );
}

function A2AIncomingItem({ item }: { item: ConversationItem }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="rounded-md border border-border bg-muted/30 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-4 py-2 text-left hover:bg-muted/50 transition-colors"
      >
        <Badge variant="outline" className="text-[10px]">A2A incoming</Badge>
        <span className="text-xs text-muted-foreground">to <span className="font-medium text-foreground">{item.sender}</span></span>
        {item.callbackUrl && (
          <span className="text-xs text-muted-foreground truncate">via <span className="font-mono">{new URL(item.callbackUrl).hostname}</span></span>
        )}
        {item.timestamp && (
          <span className="text-xs text-muted-foreground ml-auto flex-shrink-0">{new Date(item.timestamp).toLocaleTimeString()}</span>
        )}
        <span className="text-xs text-muted-foreground flex-shrink-0">{expanded ? "▲" : "▼"}</span>
      </button>
      {expanded && item.text && (
        <div className="px-4 py-3 border-t border-border bg-muted/10">
          <pre className="text-xs font-mono whitespace-pre-wrap text-muted-foreground">{item.text}</pre>
        </div>
      )}
    </div>
  );
}

function SystemItem({ item }: { item: ConversationItem }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="rounded-md border border-border bg-muted/30 overflow-hidden">
      <button onClick={() => setExpanded(!expanded)} className="w-full flex items-center gap-2 px-4 py-2 text-left hover:bg-muted/50 transition-colors">
        <Badge variant="outline" className="text-[10px]">system</Badge>
        <span className="text-xs text-muted-foreground flex-1">Model: <span className="font-mono">{item.model}</span> &middot; {item.tools?.length || 0} tools{(item.skills?.length || 0) > 0 ? ` · ${item.skills!.length} skills` : ""}</span>
        <span className="text-xs text-muted-foreground flex-shrink-0">{expanded ? "▲" : "▼"}</span>
      </button>
      {expanded && (
        <div className="px-4 py-3 border-t border-border bg-muted/10 text-xs text-muted-foreground space-y-1">
          {item.tools && item.tools.length > 0 && (
            <div><span className="font-medium">Tools:</span> {item.tools.join(", ")}</div>
          )}
          {item.skills && item.skills.length > 0 && (
            <div><span className="font-medium">Skills:</span> {item.skills.join(", ")}</div>
          )}
        </div>
      )}
    </div>
  );
}

function AssistantItem({ item }: { item: ConversationItem }) {
  const [expanded, setExpanded] = useState(false);
  const preview = item.text?.split("\n")[0]?.slice(0, 120) ?? "";

  return (
    <div className="rounded-md border border-border overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-4 py-2 text-left hover:bg-muted/30 transition-colors"
      >
        <Badge variant="outline" className="text-[10px]">assistant</Badge>
        <span className="text-sm text-muted-foreground truncate flex-1">{preview}</span>
        <span className="text-xs text-muted-foreground flex-shrink-0">{expanded ? "▲" : "▼"}</span>
      </button>
      {expanded && (
        <div className="px-4 py-3 border-t border-border bg-muted/10 prose prose-sm dark:prose-invert max-w-none">
          <ReactMarkdown>{item.text}</ReactMarkdown>
        </div>
      )}
    </div>
  );
}

function ToolItem({ item }: { item: ConversationItem }) {
  const [expanded, setExpanded] = useState(false);
  const hasOutput = item.toolOutput && item.toolOutput.length > 0;

  return (
    <div className="rounded-md border border-border overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-4 py-2 text-left hover:bg-muted/30 transition-colors"
      >
        <Badge variant="secondary" className="text-[10px]">tool</Badge>
        <span className="text-sm font-medium font-mono">{item.toolName}</span>
        {hasOutput && (
          <Badge variant="outline" className="text-[10px] ml-auto">has output</Badge>
        )}
        <span className="text-xs text-muted-foreground">{expanded ? "▲" : "▼"}</span>
      </button>
      {expanded && (
        <div className="border-t border-border">
          {item.toolInput !== undefined && (
            <div className="px-4 py-2 bg-muted/20">
              <div className="text-[10px] font-medium text-muted-foreground uppercase mb-1">Input</div>
              <pre className="text-xs font-mono overflow-x-auto max-h-64 overflow-y-auto">
                {typeof item.toolInput === "string"
                  ? item.toolInput
                  : JSON.stringify(item.toolInput, null, 2)}
              </pre>
            </div>
          )}
          {hasOutput && (
            <div className="px-4 py-2 bg-muted/10 border-t border-border">
              <div className="text-[10px] font-medium text-muted-foreground uppercase mb-1">Output</div>
              <div className="prose prose-sm dark:prose-invert max-w-none max-h-96 overflow-y-auto">
                <ReactMarkdown>{item.toolOutput}</ReactMarkdown>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ResultItem({ item }: { item: ConversationItem }) {
  const success = item.subtype === "success";
  return (
    <div className={`rounded-md px-3 py-2 flex items-center gap-3 ${success ? "bg-green-950 border border-green-900" : "bg-red-950 border border-red-900"}`}>
      <span className={`text-xs font-semibold ${success ? "text-green-400" : "text-red-400"}`}>
        {success ? "Completed" : "Failed"}
      </span>
      <div className="flex flex-wrap gap-3 text-xs text-zinc-400">
        {item.numTurns != null && item.numTurns > 0 && <span>{item.numTurns} turns</span>}
        {item.costUsd != null && item.costUsd > 0 && <span>${item.costUsd.toFixed(4)}</span>}
        {item.durationMs != null && item.durationMs > 0 && <span>{(item.durationMs / 1000).toFixed(1)}s</span>}
      </div>
    </div>
  );
}

function ErrorItem({ item }: { item: ConversationItem }) {
  return (
    <div className="rounded-md border border-destructive/30 bg-destructive/5 px-4 py-3">
      <div className="flex items-center gap-2">
        <Badge variant="destructive" className="text-[10px]">error</Badge>
      </div>
      <pre className="mt-1 text-xs font-mono text-destructive whitespace-pre-wrap">{item.error}</pre>
    </div>
  );
}

function CollapsedEventItem({ label, raw }: { label: string; raw: unknown }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="rounded-md border border-border bg-muted/20 overflow-hidden">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full flex items-center gap-2 px-4 py-1.5 text-left hover:bg-muted/40 transition-colors"
      >
        <Badge variant="outline" className="text-[10px] font-mono">{label}</Badge>
        <span className="text-xs text-muted-foreground flex-shrink-0 ml-auto">{expanded ? "▲" : "▼"}</span>
      </button>
      {expanded && (
        <div className="px-4 py-2 border-t border-border bg-muted/10">
          <pre className="text-xs font-mono overflow-x-auto text-muted-foreground whitespace-pre-wrap">
            {JSON.stringify(raw, null, 2)}
          </pre>
        </div>
      )}
    </div>
  );
}
