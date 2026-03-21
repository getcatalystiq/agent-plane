"use client";

import { useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

interface DeleteButtonProps {
  /** The API endpoint to send DELETE to (e.g. `/api/admin/agents/123`). */
  endpoint: string;
  /** Dialog title (e.g. "Delete Agent"). */
  title: string;
  /** Content shown inside the confirmation dialog. */
  children: ReactNode;
  /** Label for the trigger button. Defaults to "Delete". */
  buttonLabel?: string;
  /** Variant for the trigger button. Defaults to "ghost". */
  buttonVariant?: "ghost" | "destructive" | "outline";
  /** Optional callback after successful deletion. If not provided, calls router.refresh(). */
  onDeleted?: () => void;
}

export function DeleteButton({
  endpoint,
  title,
  children,
  buttonLabel = "Delete",
  buttonVariant = "ghost",
  onDeleted,
}: DeleteButtonProps) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");

  async function handleDelete() {
    setDeleting(true);
    setError("");
    try {
      const res = await fetch(endpoint, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.error?.message ?? `Error ${res.status}`);
        return;
      }
      setOpen(false);
      if (onDeleted) {
        onDeleted();
      } else {
        router.refresh();
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <Button
        size="sm"
        variant={buttonVariant}
        className={buttonVariant === "ghost" ? "text-muted-foreground hover:text-destructive text-xs" : undefined}
        onClick={() => setOpen(true)}
      >
        {buttonLabel}
      </Button>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={title}
        confirmLabel="Delete"
        loadingLabel="Deleting..."
        loading={deleting}
        error={error}
        onConfirm={handleDelete}
      >
        {children}
      </ConfirmDialog>
    </>
  );
}
