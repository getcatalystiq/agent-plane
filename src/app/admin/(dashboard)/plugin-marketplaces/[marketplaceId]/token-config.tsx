"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogBody, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";

export function TokenConfig({ marketplaceId, hasToken }: { marketplaceId: string; hasToken: boolean }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [token, setToken] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [removeError, setRemoveError] = useState("");

  async function handleSave() {
    setSaving(true);
    setError("");
    try {
      const res = await fetch(`/api/admin/plugin-marketplaces/${marketplaceId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ github_token: token }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.error?.message ?? `Error ${res.status}`);
        return;
      }
      setOpen(false);
      setToken("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSaving(false);
    }
  }

  async function handleRemove() {
    setRemoving(true);
    setRemoveError("");
    try {
      const res = await fetch(`/api/admin/plugin-marketplaces/${marketplaceId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ github_token: null }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setRemoveError(data?.error?.message ?? `Error ${res.status}`);
        return;
      }
      setConfirmRemove(false);
      router.refresh();
    } catch (err) {
      setRemoveError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setRemoving(false);
    }
  }

  return (
    <div className="flex items-center gap-2">
      {hasToken ? (
        <>
          <span className="text-xs text-muted-foreground">Token configured</span>
          <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>Update</Button>
          <Button size="sm" variant="ghost" onClick={() => setConfirmRemove(true)} disabled={removing}>Remove</Button>
        </>
      ) : (
        <Button size="sm" variant="outline" onClick={() => setOpen(true)}>Configure GitHub Token</Button>
      )}

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{hasToken ? "Update" : "Configure"} GitHub Token</DialogTitle>
          </DialogHeader>
          <DialogBody className="space-y-3">
            <Input
              type="password"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              placeholder="ghp_... or github_pat_..."
            />
            <div className="text-xs text-muted-foreground space-y-1">
              <p className="font-medium">How to create a token:</p>
              <ol className="list-decimal list-inside space-y-0.5 text-[11px]">
                <li>Go to <a href="https://github.com/settings/tokens?type=beta" target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground">GitHub → Settings → Fine-grained tokens</a></li>
                <li>Click <strong>Generate new token</strong></li>
                <li>Set a name and expiration</li>
                <li>Under <strong>Repository access</strong>, select the marketplace repo</li>
                <li>Under <strong>Permissions → Repository permissions</strong>, set <strong>Contents</strong> to <strong>Read and write</strong></li>
                <li>Click <strong>Generate token</strong> and paste it above</li>
              </ol>
            </div>
            {error && <p className="text-xs text-destructive">{error}</p>}
          </DialogBody>
          <DialogFooter>
            <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
            <Button size="sm" disabled={saving || !token} onClick={handleSave}>
              {saving ? "Validating..." : "Save Token"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmRemove}
        onOpenChange={setConfirmRemove}
        title="Remove GitHub Token"
        confirmLabel="Remove"
        loadingLabel="Removing..."
        loading={removing}
        error={removeError}
        onConfirm={handleRemove}
      >
        Remove the GitHub token? This will make the marketplace read-only.
      </ConfirmDialog>
    </div>
  );
}
