import type { RunTriggeredBy } from "@/lib/types";

const STYLES: Record<RunTriggeredBy, string> = {
  schedule: "bg-blue-500/10 text-blue-400",
  playground: "bg-purple-500/10 text-purple-400",
  api: "bg-zinc-500/10 text-zinc-400",
  chat: "bg-green-500/10 text-green-400",
  a2a: "bg-indigo-500/10 text-indigo-400",
};

const LABELS: Record<RunTriggeredBy, string> = {
  api: "API",
  schedule: "Schedule",
  playground: "Playground",
  chat: "Chat",
  a2a: "A2A",
};

export function RunSourceBadge({ triggeredBy }: { triggeredBy: RunTriggeredBy }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STYLES[triggeredBy]}`}>
      {LABELS[triggeredBy]}
    </span>
  );
}
