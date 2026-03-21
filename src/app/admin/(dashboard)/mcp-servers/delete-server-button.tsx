"use client";

import { DeleteButton } from "@/components/ui/delete-button";

interface Props {
  serverId: string;
  serverName: string;
  hasConnections: boolean;
}

export function DeleteServerButton({ serverId, serverName, hasConnections }: Props) {
  return (
    <DeleteButton
      endpoint={`/api/admin/mcp-servers/${serverId}`}
      title="Delete Custom Connector"
    >
      Delete <span className="font-medium text-foreground">{serverName}</span>?
      {hasConnections && " All agent connections to this server will also be removed."}
    </DeleteButton>
  );
}
