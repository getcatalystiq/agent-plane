"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function AddTenantForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [apiKey, setApiKey] = useState("");
  const [form, setForm] = useState({ name: "", slug: "", monthly_budget_usd: "100.00" });

  function handleNameChange(name: string) {
    const slug = name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
    setForm((f) => ({ ...f, name, slug }));
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/admin/tenants", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          slug: form.slug,
          monthly_budget_usd: parseFloat(form.monthly_budget_usd),
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.error?.message ?? `Error ${res.status}`);
        return;
      }
      const data = await res.json();
      setApiKey(data.api_key);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSaving(false);
    }
  }

  function handleClose() {
    setOpen(false);
    setApiKey("");
    setError("");
    setForm({ name: "", slug: "", monthly_budget_usd: "100.00" });
  }

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>Add Tenant</Button>
      <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); else setOpen(true); }}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>{apiKey ? "Tenant Created" : "Add Tenant"}</DialogTitle>
          </DialogHeader>
          {apiKey ? (
            <div className="space-y-3">
              <p className="text-sm text-muted-foreground">
                Save this API key now — it cannot be shown again.
              </p>
              <code className="block p-3 bg-muted rounded text-xs break-all font-mono select-all">
                {apiKey}
              </code>
              <div className="flex justify-end pt-2">
                <Button size="sm" onClick={handleClose}>Done</Button>
              </div>
            </div>
          ) : (
            <form onSubmit={handleSubmit} className="space-y-3">
              <div>
                <label className="text-xs font-medium text-muted-foreground">Name</label>
                <Input
                  value={form.name}
                  onChange={(e) => handleNameChange(e.target.value)}
                  placeholder="Acme Corp"
                  required
                />
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Slug</label>
                <Input
                  value={form.slug}
                  onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value }))}
                  placeholder="acme-corp"
                  pattern="^[a-z0-9-]+$"
                  required
                />
                <p className="text-xs text-muted-foreground mt-1">Lowercase alphanumeric with hyphens</p>
              </div>
              <div>
                <label className="text-xs font-medium text-muted-foreground">Monthly Budget (USD)</label>
                <Input
                  type="number"
                  step="0.01"
                  min="0"
                  value={form.monthly_budget_usd}
                  onChange={(e) => setForm((f) => ({ ...f, monthly_budget_usd: e.target.value }))}
                  required
                />
              </div>
              {error && <p className="text-xs text-red-500">{error}</p>}
              <div className="flex justify-end gap-2 pt-2">
                <Button type="button" variant="ghost" size="sm" onClick={handleClose}>Cancel</Button>
                <Button type="submit" size="sm" disabled={saving}>
                  {saving ? "Creating..." : "Create"}
                </Button>
              </div>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
