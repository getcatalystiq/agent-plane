"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { SectionHeader } from "@/components/ui/section-header";
import { FormField } from "@/components/ui/form-field";

interface Tenant {
  id: string;
  name: string;
  slug: string;
  status: "active" | "suspended";
  timezone: string;
  monthly_budget_usd: number;
  logo_url: string | null;
}

// Use the runtime's full IANA timezone list instead of a hand-curated subset
const TIMEZONES = typeof Intl !== "undefined" && Intl.supportedValuesOf
  ? Intl.supportedValuesOf("timeZone")
  : ["UTC"];

export function TenantForm({ tenant }: { tenant: Tenant }) {
  const router = useRouter();
  const [name, setName] = useState(tenant.name);
  const [budget, setBudget] = useState(tenant.monthly_budget_usd.toString());
  const [timezone, setTimezone] = useState(tenant.timezone);
  const [logoUrl, setLogoUrl] = useState(tenant.logo_url ?? "");
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);
  const isDirty =
    name !== tenant.name ||
    budget !== tenant.monthly_budget_usd.toString() ||
    timezone !== tenant.timezone ||
    (logoUrl || "") !== (tenant.logo_url ?? "");

  async function handleSave() {
    setSaving(true);
    try {
      await fetch(`/api/admin/tenants/${tenant.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          monthly_budget_usd: parseFloat(budget),
          timezone,
          logo_url: logoUrl || null,
        }),
      });
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Logo */}
      <div className="rounded-lg border border-muted-foreground/25 p-5">
        <SectionHeader title="Logo" />
        <div className="flex items-center gap-5">
          {logoUrl ? (
            <img src={logoUrl} alt={name} className="w-16 h-16 rounded-xl object-cover border border-border" />
          ) : (
            <div className="w-16 h-16 rounded-xl bg-muted flex items-center justify-center text-xl font-bold text-muted-foreground">
              {name.split(/\s+/).map(w => w[0]).join("").toUpperCase().slice(0, 2) || "?"}
            </div>
          )}
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">Upload a logo for your tenant. Recommended size: 256x256px.</p>
            <div className="flex items-center gap-2">
              <Button size="sm" variant="outline" onClick={() => fileInputRef.current?.click()}>
                <Upload className="size-4 mr-1.5" />
                Upload image
              </Button>
              {logoUrl && (
                <Button size="sm" variant="outline" onClick={() => setLogoUrl("")}>
                  Remove
                </Button>
              )}
              <input
                ref={fileInputRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={e => {
                  const file = e.target.files?.[0];
                  if (!file) return;
                  const reader = new FileReader();
                  reader.onload = () => setLogoUrl(reader.result as string);
                  reader.readAsDataURL(file);
                  e.target.value = "";
                }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Tenant Details */}
      <div className="rounded-lg border border-muted-foreground/25 p-5">
        <SectionHeader title="Tenant Details" />
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <FormField label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </FormField>
          <FormField label="Slug">
            <Input value={tenant.slug} readOnly disabled className="opacity-60" />
          </FormField>
          <FormField label="Status">
            <div className="flex items-center h-9">
              <Badge variant={tenant.status === "active" ? "default" : "destructive"}>
                {tenant.status}
              </Badge>
            </div>
          </FormField>
          <FormField label="Timezone">
            <Select value={timezone} onChange={(e) => setTimezone(e.target.value)}>
              {TIMEZONES.map((tz) => (
                <option key={tz} value={tz}>{tz.replace(/_/g, " ")}</option>
              ))}
            </Select>
          </FormField>
          <FormField label="Monthly Budget (USD)">
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">$</span>
              <Input
                type="number"
                step="0.01"
                value={budget}
                onChange={(e) => setBudget(e.target.value)}
                className="pl-7"
              />
            </div>
          </FormField>
        </div>
      </div>

      {/* Save */}
      <div className="flex items-center">
        <Button onClick={handleSave} disabled={saving || !isDirty} size="sm">
          {saving ? "Saving..." : "Save Changes"}
        </Button>
      </div>
    </div>
  );
}
