"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { adminFetch } from "@/app/admin/lib/api";

export function StopSessionButton({ sessionId, status }: { sessionId: string; status: string }) {
  const [stopping, setStopping] = useState(false);
  const router = useRouter();

  if (status === "stopped") return <span className="text-xs text-muted-foreground">stopped</span>;

  async function handleStop() {
    setStopping(true);
    try {
      await adminFetch(`/sessions/${sessionId}`, { method: "DELETE" });
      router.refresh();
    } finally {
      setStopping(false);
    }
  }

  return (
    <Button size="sm" variant="outline" onClick={handleStop} disabled={stopping} className="h-6 px-2 text-xs">
      {stopping ? "Stopping..." : "Stop"}
    </Button>
  );
}
