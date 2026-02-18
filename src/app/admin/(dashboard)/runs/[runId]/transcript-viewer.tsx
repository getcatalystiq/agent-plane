"use client";

import { useState, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface TranscriptEvent {
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
  role: "system" | "assistant" | "tool" | "result" | "error";
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
}

function buildConversation(events: TranscriptEvent[]): ConversationItem[] {
  const items: ConversationItem[] = [];
  // Map tool_use_id to index for pairing results
  const toolCallMap = new Map<string, number>();

  for (const event of events) {
    if (event.type === "system") {
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
    } else if (event.type === "result") {
      items.push({
        role: "result",
        subtype: String(event.subtype || ""),
        costUsd: Number(event.cost_usd || 0),
        numTurns: Number(event.num_turns || 0),
        durationMs: Number(event.duration_ms || 0),
        text: String(event.result || ""),
      });
    } else if (event.type === "error") {
      items.push({
        role: "error",
        error: String(event.error || "Unknown error"),
      });
    }
  }

  return items;
}

export function TranscriptViewer({ transcript }: { transcript: TranscriptEvent[] }) {
  const [formatted, setFormatted] = useState(true);
  const conversation = useMemo(() => buildConversation(transcript), [transcript]);

  if (transcript.length === 0) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="text-base">Transcript</CardTitle>
        </CardHeader>
        <CardContent>
          <p className="text-sm text-muted-foreground">No transcript available</p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">Transcript</CardTitle>
        <div className="flex items-center gap-1 rounded-md border border-border p-0.5">
          <button
            onClick={() => setFormatted(true)}
            className={`px-3 py-1 text-xs rounded transition-colors ${formatted ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            Formatted
          </button>
          <button
            onClick={() => setFormatted(false)}
            className={`px-3 py-1 text-xs rounded transition-colors ${!formatted ? "bg-primary text-primary-foreground" : "text-muted-foreground hover:text-foreground"}`}
          >
            Raw
          </button>
        </div>
      </CardHeader>
      <CardContent>
        {formatted ? (
          <ConversationView items={conversation} />
        ) : (
          <RawView transcript={transcript} />
        )}
      </CardContent>
    </Card>
  );
}

function ConversationView({ items }: { items: ConversationItem[] }) {
  // Find the index of the last result item
  const lastResultIdx = items.reduce((last, item, i) => item.role === "result" ? i : last, -1);

  return (
    <div className="space-y-3">
      {items.map((item, i) => {
        switch (item.role) {
          case "system":
            return <SystemItem key={i} item={item} />;
          case "assistant":
            return <AssistantItem key={i} item={item} />;
          case "tool":
            return <ToolItem key={i} item={item} />;
          case "result":
            return <ResultItem key={i} item={item} defaultExpanded={i === lastResultIdx} />;
          case "error":
            return <ErrorItem key={i} item={item} />;
          default:
            return null;
        }
      })}
    </div>
  );
}

function SystemItem({ item }: { item: ConversationItem }) {
  const [expanded, setExpanded] = useState(false);
  return (
    <div className="rounded-md border border-border bg-muted/30 px-4 py-2">
      <button onClick={() => setExpanded(!expanded)} className="w-full text-left">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Badge variant="outline" className="text-[10px]">system</Badge>
          <span>Model: <span className="font-mono">{item.model}</span></span>
          <span>&middot;</span>
          <span>{item.tools?.length || 0} tools</span>
          {(item.skills?.length || 0) > 0 && (
            <>
              <span>&middot;</span>
              <span>{item.skills!.length} skills</span>
            </>
          )}
        </div>
      </button>
      {expanded && (
        <div className="mt-2 text-xs text-muted-foreground space-y-1">
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
  return (
    <div className="pl-4 border-l-2 border-primary/30">
      <div className="text-xs text-muted-foreground mb-1 font-medium">Assistant</div>
      <div className="text-sm prose prose-sm dark:prose-invert max-w-none">
        <ReactMarkdown>{item.text ?? ""}</ReactMarkdown>
      </div>
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
              <pre className="text-xs font-mono overflow-x-auto max-h-64 overflow-y-auto whitespace-pre-wrap">
                {item.toolOutput}
              </pre>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function ResultItem({ item, defaultExpanded = false }: { item: ConversationItem; defaultExpanded?: boolean }) {
  const [showFull, setShowFull] = useState(defaultExpanded);
  return (
    <div className="rounded-md border border-green-500/30 bg-green-500/5 px-4 py-3">
      <div className="flex items-center gap-3 text-sm">
        <Badge variant="default" className="text-[10px]">{item.subtype}</Badge>
        <span className="font-mono">${item.costUsd?.toFixed(4)}</span>
        <span className="text-muted-foreground">&middot;</span>
        <span>{item.numTurns} turns</span>
        <span className="text-muted-foreground">&middot;</span>
        <span>{((item.durationMs || 0) / 1000).toFixed(1)}s</span>
      </div>
      {item.text && (
        <div className="mt-2">
          <button onClick={() => setShowFull(!showFull)} className="text-xs text-primary hover:underline">
            {showFull ? "Hide result" : "Show result"}
          </button>
          {showFull && (
            <div className="mt-2 text-sm prose prose-sm dark:prose-invert max-w-none">
              <ReactMarkdown>{item.text}</ReactMarkdown>
            </div>
          )}
        </div>
      )}
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

// Raw events view
function RawView({ transcript }: { transcript: TranscriptEvent[] }) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const displayed = showAll ? transcript : transcript.slice(0, 50);

  function toggleExpand(idx: number) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  }

  return (
    <div>
      {transcript.length > 50 && (
        <div className="mb-2">
          <Button variant="ghost" size="sm" onClick={() => setShowAll(!showAll)}>
            {showAll ? "Show less" : `Show all ${transcript.length}`}
          </Button>
        </div>
      )}
      <div className="space-y-1">
        {displayed.map((event, idx) => (
          <div key={idx} className="group">
            <button
              onClick={() => toggleExpand(idx)}
              className="w-full flex items-center gap-2 px-3 py-1.5 rounded text-left hover:bg-muted/50 transition-colors text-sm"
            >
              <Badge
                variant={
                  event.type === "error" ? "destructive"
                    : event.type === "result" ? "default"
                    : event.type === "assistant" ? "secondary"
                    : "outline"
                }
                className="text-[10px] min-w-[80px] justify-center"
              >
                {event.type}
              </Badge>
              <span className="flex-1 truncate text-muted-foreground">
                <RawEventSummary event={event} />
              </span>
            </button>
            {expanded.has(idx) && (
              <pre className="ml-8 px-3 py-2 text-xs font-mono bg-muted/30 rounded overflow-x-auto max-h-96">
                {JSON.stringify(event, null, 2)}
              </pre>
            )}
          </div>
        ))}
      </div>
    </div>
  );
}

function RawEventSummary({ event }: { event: TranscriptEvent }) {
  switch (event.type) {
    case "run_started":
      return <>Run started — model: {String(event.model)}</>;
    case "system":
      return <>System init — {(event.tools as string[])?.length || 0} tools</>;
    case "assistant": {
      const content = event.message as { content?: Array<{ type: string; text?: string }> };
      const text = content?.content?.find((c) => c.type === "text")?.text;
      return <>{text ? text.slice(0, 120) : "assistant message"}</>;
    }
    case "tool_use":
      return <>Tool: {String(event.tool_name)}</>;
    case "tool_result":
      return <>Result: {String(event.tool_name)}</>;
    case "error":
      return <span className="text-destructive">{String(event.error).slice(0, 120)}</span>;
    case "result":
      return <>Result: {String(event.subtype)} — ${Number(event.cost_usd).toFixed(4)}</>;
    default:
      return <>{event.type}</>;
  }
}
