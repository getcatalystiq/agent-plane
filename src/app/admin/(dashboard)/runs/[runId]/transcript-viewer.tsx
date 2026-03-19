"use client";

import { useState, useMemo } from "react";
import ReactMarkdown from "react-markdown";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";

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
  role: "system" | "assistant" | "tool" | "result" | "error" | "a2a_incoming";
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
    } else if (event.type === "a2a_incoming") {
      items.push({
        role: "a2a_incoming",
        sender: String(event.sender || "unknown"),
        callbackUrl: event.callback_url ? String(event.callback_url) : undefined,
        timestamp: event.timestamp ? String(event.timestamp) : undefined,
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

export function TranscriptViewer({ transcript, prompt }: { transcript: TranscriptEvent[]; prompt?: string }) {
  const conversation = useMemo(() => buildConversation(transcript), [transcript]);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Transcript</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
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
      </CardContent>
    </Card>
  );
}

function ConversationView({ items }: { items: ConversationItem[] }) {
  return (
    <div className="space-y-3">
      {items.map((item, i) => {
        switch (item.role) {
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
          default:
            return null;
        }
      })}
    </div>
  );
}

function A2AIncomingItem({ item }: { item: ConversationItem }) {
  return (
    <div className="rounded-md border border-border bg-muted/30 px-4 py-3">
      <div className="flex items-center gap-2">
        <Badge variant="outline" className="text-[10px]">A2A incoming</Badge>
        <span className="text-xs text-muted-foreground">from <span className="font-mono">{item.sender}</span></span>
        {item.timestamp && (
          <span className="text-xs text-muted-foreground ml-auto">{new Date(item.timestamp).toLocaleTimeString()}</span>
        )}
      </div>
      {item.callbackUrl && (
        <div className="mt-1 text-xs text-muted-foreground">
          Callback: <span className="font-mono">{item.callbackUrl}</span>
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
  return (
    <div className="rounded-md border border-green-500/30 bg-green-500/5 px-4 py-3">
      {item.text && (
        <div className="mt-2 text-sm prose prose-sm dark:prose-invert max-w-none">
          <ReactMarkdown>{item.text}</ReactMarkdown>
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
