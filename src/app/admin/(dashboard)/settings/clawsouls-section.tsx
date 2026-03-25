"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { FormField } from "@/components/ui/form-field";
import { adminFetch } from "@/app/admin/lib/api";

interface ClawSoulsSectionProps {
  tenantId: string;
  hasToken: boolean;
}

export function ClawSoulsSection({ tenantId, hasToken: initialHasToken }: ClawSoulsSectionProps) {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [hasToken, setHasToken] = useState(initialHasToken);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  async function handleSave() {
    if (!token.trim()) return;
    setSaving(true);
    setError("");
    try {
      await adminFetch(`/tenants/${tenantId}`, {
        method: "PATCH",
        body: JSON.stringify({ clawsouls_api_token: token.trim() }),
      });
      setHasToken(true);
      setToken("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save token");
    } finally {
      setSaving(false);
    }
  }

  async function handleClear() {
    setSaving(true);
    setError("");
    try {
      await adminFetch(`/tenants/${tenantId}`, {
        method: "PATCH",
        body: JSON.stringify({ clawsouls_api_token: "" }),
      });
      setHasToken(false);
      setToken("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to clear token");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border border-muted-foreground/25 p-5">
      <div className="flex items-center gap-2 mb-3">
        <h2 className="text-lg font-semibold">ClawSouls Registry</h2>
        {hasToken && <Badge variant="default">Connected</Badge>}
      </div>
      <p className="text-sm text-muted-foreground mb-4">
        Connect to the ClawSouls registry to import, export, and publish SoulSpec identity files.
      </p>
      {error && <p className="text-sm text-destructive mb-3">{error}</p>}
      <div className="max-w-md">
        <FormField label="API Token">
          <div className="flex gap-2">
            <Input
              type="password"
              placeholder={hasToken ? "cs-••••••••" : "cs-..."}
              value={token}
              onChange={(e) => setToken(e.target.value)}
            />
            {hasToken && (
              <Button size="sm" variant="outline" onClick={handleClear} disabled={saving}>
                Clear
              </Button>
            )}
          </div>
        </FormField>
      </div>
      {token.trim() && (
        <div className="mt-3">
          <Button size="sm" onClick={handleSave} disabled={saving}>
            {saving ? "Saving..." : "Save Token"}
          </Button>
        </div>
      )}
    </div>
  );
}
