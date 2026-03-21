"use client";

import { DeleteButton } from "@/components/ui/delete-button";

interface Props {
  agentId: string;
  agentName: string;
}

export function DeleteAgentButton({ agentId, agentName }: Props) {
  return (
    <DeleteButton
      endpoint={`/api/admin/agents/${agentId}`}
      title="Delete Agent"
    >
      Delete <span className="font-medium text-foreground">{agentName}</span>? This will also remove all associated runs and connections.
    </DeleteButton>
  );
}
