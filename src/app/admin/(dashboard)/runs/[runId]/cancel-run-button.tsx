"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogBody,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

export function CancelRunButton({ runId }: { runId: string }) {
  const [open, setOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const router = useRouter();

  async function handleConfirm() {
    setCancelling(true);
    try {
      const res = await fetch(`/api/admin/runs/${runId}/cancel`, { method: "POST" });
      if (res.ok) {
        setOpen(false);
        router.refresh();
      } else {
        const data = await res.json().catch(() => ({}));
        alert(data?.error ?? `Failed to cancel (HTTP ${res.status})`);
      }
    } catch {
      alert("Failed to cancel run");
    } finally {
      setCancelling(false);
    }
  }

  return (
    <>
      <Button
        variant="destructive"
        size="sm"
        onClick={() => setOpen(true)}
      >
        Stop Run
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Stop this run?</DialogTitle>
            <DialogDescription>
              This will terminate the sandbox immediately.
            </DialogDescription>
          </DialogHeader>
          <DialogBody />
          <DialogFooter>
            <Button variant="outline" size="sm" onClick={() => setOpen(false)} disabled={cancelling}>
              Cancel
            </Button>
            <Button variant="destructive" size="sm" onClick={handleConfirm} disabled={cancelling}>
              {cancelling ? "Stopping…" : "Stop Run"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
