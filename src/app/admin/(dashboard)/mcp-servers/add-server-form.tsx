"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Dialog, DialogContent, DialogHeader, DialogBody, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { FormError } from "@/components/ui/form-error";
import { adminFetch, AdminApiError } from "@/app/admin/lib/api";

export function AddMcpServerForm({ tenantId }: { tenantId: string }) {
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
      await adminFetch("/mcp-servers", {
        method: "POST",
        body: JSON.stringify({
          tenant_id: tenantId,
          name: form.name,
          slug: form.slug,
          description: form.description,
          base_url: form.base_url,
          mcp_endpoint_path: form.mcp_endpoint_path || "/mcp",
          logo_url: form.logo_url || undefined,
        }),
      });
      setOpen(false);
      setForm({ name: "", slug: "", description: "", base_url: "", mcp_endpoint_path: "/mcp", logo_url: "" });
      router.refresh();
    } catch (err) {
      setError(err instanceof AdminApiError ? err.message : "Unknown error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>+ New Connector</Button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-md">
          <form onSubmit={handleSubmit}>
            <DialogHeader>
              <DialogTitle>Register Custom Connector</DialogTitle>
            </DialogHeader>
            <DialogBody className="space-y-3">
              <FormField label="Name">
                <Input
                  value={form.name}
                  onChange={(e) => updateField("name", e.target.value)}
                  placeholder="My Custom Connector"
                  required
                />
              </FormField>
              <FormField label="Slug">
                <Input
                  value={form.slug}
                  onChange={(e) => setForm((f) => ({ ...f, slug: e.target.value }))}
                  placeholder="my-mcp-server"
                  required
                />
              </FormField>
              <FormField label="Description">
                <Input
                  value={form.description}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                  placeholder="What this server does"
                />
              </FormField>
              <FormField label="Base URL">
                <Input
                  value={form.base_url}
                  onChange={(e) => setForm((f) => ({ ...f, base_url: e.target.value }))}
                  placeholder="https://mcp.example.com"
                  required
                />
              </FormField>
              <FormField label="MCP Endpoint Path">
                <Input
                  value={form.mcp_endpoint_path}
                  onChange={(e) => setForm((f) => ({ ...f, mcp_endpoint_path: e.target.value }))}
                  placeholder="/mcp"
                />
              </FormField>
              <FormField label="Logo URL (optional)">
                <Input
                  value={form.logo_url}
                  onChange={(e) => setForm((f) => ({ ...f, logo_url: e.target.value }))}
                  placeholder="https://..."
                />
              </FormField>
              <FormError error={error} />
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="outline" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
              <Button type="submit" size="sm" disabled={saving}>
                {saving ? "Registering..." : "Register"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
