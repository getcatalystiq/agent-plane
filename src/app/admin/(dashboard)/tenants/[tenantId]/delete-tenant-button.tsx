"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { adminFetch, AdminApiError } from "@/app/admin/lib/api";

interface Props {
  tenantId: string;
  tenantName: string;
}

export function DeleteTenantButton({ tenantId, tenantName }: Props) {
  const router = useRouter();
  const [step, setStep] = useState<0 | 1 | 2>(0);
  const [deleting, setDeleting] = useState(false);
  const [error, setError] = useState("");

  async function handleDelete() {
    setDeleting(true);
    setError("");
    try {
      await adminFetch(`/tenants/${tenantId}`, { method: "DELETE" });
      setStep(0);
      router.push("/admin/tenants");
    } catch (err) {
      setError(err instanceof AdminApiError ? err.message : "Unknown error");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <>
      <Button
        size="sm"
        variant="ghost"
        className="text-muted-foreground hover:text-destructive text-xs"
        onClick={() => setStep(1)}
      >
        Delete Company
      </Button>

      {/* Step 1 */}
      <ConfirmDialog
        open={step === 1}
        onOpenChange={(open) => !open && setStep(0)}
        title="Delete Company"
        confirmLabel="Continue"
        loadingLabel="Loading..."
        onConfirm={() => setStep(2)}
      >
        Delete <span className="font-medium text-foreground">{tenantName}</span>? This will permanently remove all agents, runs, sessions, and API keys belonging to this company.
      </ConfirmDialog>

      {/* Step 2 */}
      <ConfirmDialog
        open={step === 2}
        onOpenChange={(open) => { if (!open) setStep(0); setError(""); }}
        title="Are you absolutely sure?"
        confirmLabel="Delete Company"
        loadingLabel="Deleting..."
        loading={deleting}
        error={error}
        onConfirm={handleDelete}
      >
        This action <span className="font-medium text-foreground">cannot be undone</span>. All data for <span className="font-medium text-foreground">{tenantName}</span> will be permanently deleted.
      </ConfirmDialog>
    </>
  );
}
