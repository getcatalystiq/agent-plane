"use client";

import { DeleteButton } from "@/components/ui/delete-button";

interface Props {
  marketplaceId: string;
  marketplaceName: string;
  hasAgents: boolean;
}

export function DeleteMarketplaceButton({ marketplaceId, marketplaceName, hasAgents }: Props) {
  return (
    <DeleteButton
      endpoint={`/api/admin/plugin-marketplaces/${marketplaceId}`}
      title="Delete Plugin Marketplace"
    >
      Delete <span className="font-medium text-foreground">{marketplaceName}</span>?
      {hasAgents && " Agents using plugins from this marketplace will keep their current configuration but won't receive updates."}
    </DeleteButton>
  );
}
