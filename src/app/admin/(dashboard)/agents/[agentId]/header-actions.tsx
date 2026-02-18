"use client";

import { useState } from "react";
import Link from "next/link";
import { Button } from "@/components/ui/button";
import { ApiKeysModal } from "./api-keys-modal";

interface Props {
  agentId: string;
  tenantId: string;
}

export function AgentHeaderActions({ agentId, tenantId }: Props) {
  const [keysOpen, setKeysOpen] = useState(false);

  return (
    <>
      <div className="flex items-center gap-2">
        <Link
          href={`/admin/agents/${agentId}/playground`}
          className="inline-flex items-center justify-center rounded-md border border-input bg-background shadow-sm hover:bg-accent hover:text-accent-foreground h-8 px-3 text-xs font-medium transition-colors"
        >
          Open Playground
        </Link>
        <Button variant="outline" size="sm" onClick={() => setKeysOpen(true)}>
          API Keys
        </Button>
      </div>

      <ApiKeysModal tenantId={tenantId} open={keysOpen} onClose={() => setKeysOpen(false)} />
    </>
  );
}
