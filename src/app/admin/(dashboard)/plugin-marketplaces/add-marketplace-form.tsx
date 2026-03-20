"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogBody, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { FormError } from "@/components/ui/form-error";

export function AddMarketplaceForm({ tenantId }: { tenantId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState({ name: "", github_repo: "", github_token: "" });
  const [showTokenHelp, setShowTokenHelp] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/admin/plugin-marketplaces", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenant_id: tenantId,
          name: form.name,
          github_repo: form.github_repo,
          ...(form.github_token && { github_token: form.github_token }),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.error?.message ?? `Error ${res.status}`);
        return;
      }
      await res.json();
      setOpen(false);
      setForm({ name: "", github_repo: "", github_token: "" });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>+ New Marketplace</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <form onSubmit={handleSubmit}>
            <DialogHeader>
              <DialogTitle>Add Plugin Marketplace</DialogTitle>
            </DialogHeader>
            <DialogBody className="space-y-3">
              <FormField label="Name">
                <Input
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="Knowledge Work Plugins"
                  required
                />
              </FormField>
              <FormField label="GitHub Repository" hint="Format: owner/repo">
                <Input
                  value={form.github_repo}
                  onChange={(e) => setForm((f) => ({ ...f, github_repo: e.target.value }))}
                  placeholder="anthropics/knowledge-work-plugins"
                  required
                />
              </FormField>
              <div className="space-y-1">
                <div className="flex items-center gap-1.5">
                  <label className="text-xs font-medium text-muted-foreground">GitHub Token (optional, required for private repos)</label>
                  <button
                    type="button"
                    onClick={() => setShowTokenHelp((v) => !v)}
                    className="inline-flex items-center justify-center w-4 h-4 rounded-full border border-muted-foreground/40 text-muted-foreground text-[10px] leading-none hover:bg-muted/50 transition-colors"
                    title="How to create a token"
                  >
                    ?
                  </button>
                </div>
                <Input
                  type="password"
                  value={form.github_token}
                  onChange={(e) => setForm((f) => ({ ...f, github_token: e.target.value }))}
                  placeholder="ghp_... or github_pat_..."
                />
                {showTokenHelp && (
                  <div className="text-xs text-muted-foreground mt-2 rounded-md border border-border bg-muted/30 p-2.5 space-y-1">
                    <p className="font-medium">How to create a fine-grained token:</p>
                    <ol className="list-decimal list-inside space-y-0.5 text-[11px]">
                      <li>Go to <a href="https://github.com/settings/tokens?type=beta" target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground">GitHub &rarr; Settings &rarr; Fine-grained tokens</a></li>
                      <li>Click <strong>Generate new token</strong></li>
                      <li>Set a name and expiration</li>
                      <li>Under <strong>Repository access</strong>, select the marketplace repo</li>
                      <li>Under <strong>Permissions &rarr; Repository permissions</strong>, set <strong>Contents</strong> to <strong>Read and write</strong></li>
                      <li>Click <strong>Generate token</strong> and paste it above</li>
                    </ol>
                  </div>
                )}
              </div>
              <FormError error={error} />
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" size="sm" disabled={saving}>
                {saving ? "Adding..." : "Add"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
