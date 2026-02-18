import Link from "next/link";

interface Props {
  agentId: string;
  tenantId: string;
}

export function AgentHeaderActions({ agentId }: Props) {
  return (
    <Link
      href={`/admin/agents/${agentId}/playground`}
      className="inline-flex items-center justify-center rounded-md border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground h-8 px-3 text-xs font-medium transition-colors"
    >
      Open Playground
    </Link>
  );
}
