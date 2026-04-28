"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { adminFetch } from "@/app/admin/lib/api";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogBody,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";

const ACTIVE_STATUSES = new Set(["creating", "active", "idle"]);

export function CancelSessionButton({
  sessionId,
  status,
}: {
  sessionId: string;
  status: string;
}) {
  const [open, setOpen] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const router = useRouter();

  if (!ACTIVE_STATUSES.has(status)) return null;
  if (cancelling === false && !ACTIVE_STATUSES.has(status)) return null;

  async function handleConfirm() {
    setCancelling(true);
    try {
      await adminFetch(`/sessions/${sessionId}`, { method: "DELETE" });
      setOpen(false);
      router.refresh();
    } catch (err) {
      alert(err instanceof Error ? err.message : "Failed to stop run");
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
        disabled={cancelling}
      >
        {cancelling ? "Stopping..." : "Stop Run"}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>Stop this run?</DialogTitle>
            <DialogDescription>
              This will cancel the in-flight message (if any) and terminate the sandbox immediately.
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
