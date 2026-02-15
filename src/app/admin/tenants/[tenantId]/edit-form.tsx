"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

interface Tenant {
  id: string;
  name: string;
  status: string;
  monthly_budget_usd: number;
}

export function TenantEditForm({ tenant }: { tenant: Tenant }) {
  const router = useRouter();
  const [name, setName] = useState(tenant.name);
  const [budget, setBudget] = useState(tenant.monthly_budget_usd.toString());
  const [status, setStatus] = useState(tenant.status);
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      await fetch(`/api/admin/tenants/${tenant.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          status,
          monthly_budget_usd: parseFloat(budget),
        }),
      });
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Edit Tenant</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-3 gap-4">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Name</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Monthly Budget (USD)</label>
            <Input type="number" step="0.01" value={budget} onChange={(e) => setBudget(e.target.value)} />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Status</label>
            <select
              value={status}
              onChange={(e) => setStatus(e.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
            >
              <option value="active">active</option>
              <option value="suspended">suspended</option>
            </select>
          </div>
        </div>
        <div className="mt-4">
          <Button onClick={handleSave} disabled={saving} size="sm">
            {saving ? "Saving..." : "Save Changes"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
