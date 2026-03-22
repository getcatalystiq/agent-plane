"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogBody, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { FormError } from "@/components/ui/form-error";
import { adminFetch } from "@/app/admin/lib/api";

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
      const data = await adminFetch<{ api_key: string }>("/tenants", {
        method: "POST",
        body: JSON.stringify({
          name: form.name,
          slug: form.slug,
          monthly_budget_usd: parseFloat(form.monthly_budget_usd),
        }),
      });
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
      <Button size="sm" onClick={() => setOpen(true)}>Add Company</Button>
      <Dialog open={open} onOpenChange={(v) => { if (!v) handleClose(); else setOpen(true); }}>
        <DialogContent className="max-w-md">
          {apiKey ? (
            <>
              <DialogHeader>
                <DialogTitle>Company Created</DialogTitle>
              </DialogHeader>
              <DialogBody className="space-y-3">
                <p className="text-sm text-muted-foreground">
                  Save this API key now — it cannot be shown again.
                </p>
                <code className="block p-3 bg-muted rounded-lg text-xs break-all font-mono select-all">
                  {apiKey}
                </code>
              </DialogBody>
              <DialogFooter>
                <Button size="sm" onClick={handleClose}>Done</Button>
              </DialogFooter>
            </>
          ) : (
            <form onSubmit={handleSubmit}>
              <DialogHeader>
                <DialogTitle>Add Company</DialogTitle>
              </DialogHeader>
              <DialogBody className="space-y-3">
                <FormField label="Name">
                  <Input
                    value={form.name}
                    onChange={(e) => handleNameChange(e.target.value)}
                    placeholder="Acme Corp"
                    required
                  />
                </FormField>
                <FormField label="Slug" hint="Lowercase alphanumeric with hyphens">
                  <Input
                    value={form.slug}
                    onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value }))}
                    placeholder="acme-corp"
                    pattern="^[a-z0-9-]+$"
                    required
                  />
                </FormField>
                <FormField label="Monthly Budget (USD)">
                  <Input
                    type="number"
                    step="0.01"
                    min="0"
                    value={form.monthly_budget_usd}
                    onChange={(e) => setForm((f) => ({ ...f, monthly_budget_usd: e.target.value }))}
                    required
                  />
                </FormField>
                <FormError error={error} />
              </DialogBody>
              <DialogFooter>
                <Button type="button" variant="outline" size="sm" onClick={handleClose}>Cancel</Button>
                <Button type="submit" size="sm" disabled={saving}>
                  {saving ? "Creating..." : "Create"}
                </Button>
              </DialogFooter>
            </form>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
