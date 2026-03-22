"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { adminFetch, AdminApiError } from "@/app/admin/lib/api";
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
      await adminFetch(`/runs/${runId}/cancel`, { method: "POST" });
      setOpen(false);
      router.refresh();
    } catch (err) {
      alert(err instanceof AdminApiError ? err.message : "Failed to cancel run");
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
