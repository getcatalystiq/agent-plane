"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

interface Props {
  tenantId: string;
  tenantName: string;
}

export function DeleteTenantButton({ tenantId, tenantName }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");

  async function handleDelete() {
    setDeleting(true);
    setError("");
    try {
      const res = await fetch(`/api/admin/tenants/${tenantId}`, { method: "DELETE" });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.error?.message ?? `Error ${res.status}`);
        return;
      }
      document.cookie = "ap-active-tenant=; path=/; SameSite=Lax; Secure; max-age=0";
      setOpen(false);
      router.push("/admin");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <Button size="sm" variant="destructive" onClick={() => setOpen(true)}>
        Delete Tenant
      </Button>

      <ConfirmDialog
        open={open}
        onOpenChange={(v) => { if (!v) { setOpen(false); setError(""); } }}
        title="Delete Tenant"
        confirmLabel="Delete Tenant"
        loadingLabel="Deleting..."
        loading={deleting}
        error={error}
        onConfirm={handleDelete}
      >
        This action <span className="font-medium text-foreground">cannot be undone</span>. All agents, runs, sessions, and API keys for <span className="font-medium text-foreground">{tenantName}</span> will be permanently deleted.
      </ConfirmDialog>
    </>
  );
}
