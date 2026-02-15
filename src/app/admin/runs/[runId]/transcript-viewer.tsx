"use client";

import { useState } from "react";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

interface TranscriptEvent {
  type: string;
  [key: string]: unknown;
}

export function TranscriptViewer({ transcript }: { transcript: TranscriptEvent[] }) {
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [showAll, setShowAll] = useState(false);

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
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-base">Transcript ({transcript.length} events)</CardTitle>
        {transcript.length > 50 && (
          <Button variant="ghost" size="sm" onClick={() => setShowAll(!showAll)}>
            {showAll ? "Show less" : `Show all ${transcript.length}`}
          </Button>
        )}
      </CardHeader>
      <CardContent className="space-y-1">
        {displayed.map((event, idx) => (
          <div key={idx} className="group">
            <button
              onClick={() => toggleExpand(idx)}
              className="w-full flex items-center gap-2 px-3 py-1.5 rounded text-left hover:bg-muted/50 transition-colors text-sm"
            >
              <EventBadge type={event.type} />
              <span className="flex-1 truncate text-muted-foreground">
                <EventSummary event={event} />
              </span>
              <span className="text-xs text-muted-foreground opacity-0 group-hover:opacity-100">
                {expanded.has(idx) ? "collapse" : "expand"}
              </span>
            </button>
            {expanded.has(idx) && (
              <pre className="ml-8 px-3 py-2 text-xs font-mono bg-muted/30 rounded overflow-x-auto max-h-96">
                {JSON.stringify(event, null, 2)}
              </pre>
            )}
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

function EventBadge({ type }: { type: string }) {
  const variant = type === "error" ? "destructive"
    : type === "result" ? "default"
    : type === "assistant" ? "secondary"
    : "outline";
  return (
    <Badge variant={variant} className="text-[10px] min-w-[80px] justify-center">
      {type}
    </Badge>
  );
}

function EventSummary({ event }: { event: TranscriptEvent }) {
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
