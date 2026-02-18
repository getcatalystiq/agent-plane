"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";

export function AddMcpServerForm() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState({
    name: "",
    slug: "",
    description: "",
    base_url: "",
    mcp_endpoint_path: "/mcp",
    logo_url: "",
  });

  function updateField(field: string, value: string) {
    setForm((f) => ({ ...f, [field]: value }));
    // Auto-generate slug from name if slug hasn't been manually edited
    if (field === "name") {
      const autoSlug = value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
      setForm((f) => ({ ...f, name: value, slug: autoSlug }));
    }
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/admin/mcp-servers", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: form.name,
          slug: form.slug,
          description: form.description,
          base_url: form.base_url,
          mcp_endpoint_path: form.mcp_endpoint_path || "/mcp",
          logo_url: form.logo_url || undefined,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.error?.message ?? `Error ${res.status}`);
        return;
      }
      // Wait for response body before refreshing to ensure DB write is committed
      await res.json();
      setOpen(false);
      setForm({ name: "", slug: "", description: "", base_url: "", mcp_endpoint_path: "/mcp", logo_url: "" });
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>Register Connector</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Register Custom Connector</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleSubmit} className="space-y-3">
            <div>
              <label className="text-xs font-medium text-muted-foreground">Name</label>
              <Input
                value={form.name}
                onChange={(e) => updateField("name", e.target.value)}
                placeholder="My Custom Connector"
                required
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Slug</label>
              <Input
                value={form.slug}
                onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value }))}
                placeholder="my-mcp-server"
                required
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Description</label>
              <Input
                value={form.description}
                onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                placeholder="What this server does"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Base URL</label>
              <Input
                value={form.base_url}
                onChange={(e) => setForm((f) => ({ ...f, base_url: e.target.value }))}
                placeholder="https://mcp.example.com"
                required
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">MCP Endpoint Path</label>
              <Input
                value={form.mcp_endpoint_path}
                onChange={(e) => setForm((f) => ({ ...f, mcp_endpoint_path: e.target.value }))}
                placeholder="/mcp"
              />
            </div>
            <div>
              <label className="text-xs font-medium text-muted-foreground">Logo URL (optional)</label>
              <Input
                value={form.logo_url}
                onChange={(e) => setForm((f) => ({ ...f, logo_url: e.target.value }))}
                placeholder="https://..."
              />
            </div>
            {error && <p className="text-xs text-red-500">{error}</p>}
            <div className="flex justify-end gap-2 pt-2">
              <Button type="button" variant="ghost" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" size="sm" disabled={saving}>
                {saving ? "Registering..." : "Register"}
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
