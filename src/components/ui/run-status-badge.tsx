import { Badge } from "@/components/ui/badge";

export function RunStatusBadge({ status }: { status: string }) {
  const variant =
    status === "completed" ? "default"
    : status === "running" ? "secondary"
    : status === "failed" || status === "timed_out" ? "destructive"
    : "outline";
  return <Badge variant={variant}>{status.replace("_", " ")}</Badge>;
}
