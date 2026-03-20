"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
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
  const [saving, setSaving] = useState(false);
  const isDirty =
    name !== tenant.name ||
    budget !== tenant.monthly_budget_usd.toString() ||
    timezone !== tenant.timezone;

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
        }),
      });
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border border-muted-foreground/25 p-5">
      <SectionHeader title="Tenant Details">
        <Button onClick={handleSave} disabled={saving || !isDirty} size="sm">
          {saving ? "Saving..." : "Save Changes"}
        </Button>
      </SectionHeader>
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
  );
}
