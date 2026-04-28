"use client";

import { useState, useRef } from "react";
import { useRouter } from "next/navigation";
import { Upload, Info } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { FormField } from "@/components/ui/form-field";
import { DatePicker } from "@/components/ui/date-picker";
import { adminFetch } from "@/app/admin/lib/api";

interface Company {
  id: string;
  name: string;
  slug: string;
  status: "active" | "suspended";
  timezone: string;
  monthly_budget_usd: number;
  logo_url: string | null;
  has_subscription_token: boolean;
  subscription_base_url: string | null;
  subscription_token_expires_at: string | null;
}

// Use the runtime's full IANA timezone list instead of a hand-curated subset
const TIMEZONES = typeof Intl !== "undefined" && Intl.supportedValuesOf
  ? Intl.supportedValuesOf("timeZone")
  : ["UTC"];

function toDateStr(v: string | null | undefined): string {
  if (!v) return "";
  const d = new Date(v);
  return isNaN(d.getTime()) ? "" : d.toISOString().split("T")[0];
}

export function CompanyForm({ tenant }: { tenant: Company }) {
  const router = useRouter();
  const initialExpiresAt = toDateStr(tenant.subscription_token_expires_at) || (() => {
    const d = new Date();
    d.setFullYear(d.getFullYear() + 1);
    d.setDate(d.getDate() - 1);
    return d.toISOString().split("T")[0];
  })();
  const [name, setName] = useState(tenant.name);
  const [budget, setBudget] = useState(tenant.monthly_budget_usd.toString());
  const [timezone, setTimezone] = useState(tenant.timezone);
  const [logoUrl, setLogoUrl] = useState(tenant.logo_url ?? "");
  const [subscriptionToken, setSubscriptionToken] = useState("");
  const [subscriptionBaseUrl, setSubscriptionBaseUrl] = useState(tenant.subscription_base_url ?? "");
  const [subscriptionExpiresAt, setSubscriptionExpiresAt] = useState(initialExpiresAt);
  const [hasToken, setHasToken] = useState(tenant.has_subscription_token);
  const [tokenError, setTokenError] = useState("");
  const [showTokenHelp, setShowTokenHelp] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);
  const isDirty =
    name !== tenant.name ||
    budget !== tenant.monthly_budget_usd.toString() ||
    timezone !== tenant.timezone ||
    (logoUrl || "") !== (tenant.logo_url ?? "") ||
    subscriptionToken !== "" ||
    subscriptionBaseUrl !== (tenant.subscription_base_url ?? "") ||
    subscriptionExpiresAt !== initialExpiresAt;

  async function handleSave() {
    setSaving(true);
    setTokenError("");
    try {
      const payload: Record<string, unknown> = {
        name,
        monthly_budget_usd: parseFloat(budget),
        timezone,
        logo_url: logoUrl || null,
      };
      if (subscriptionToken !== "") {
        payload.subscription_token = subscriptionToken;
      }
      if (subscriptionBaseUrl !== (tenant.subscription_base_url ?? "")) {
        payload.subscription_base_url = subscriptionBaseUrl || null;
      }
      if (subscriptionExpiresAt !== initialExpiresAt) {
        payload.subscription_token_expires_at = subscriptionExpiresAt ? new Date(subscriptionExpiresAt).toISOString() : null;
      }
      const data = await adminFetch<Record<string, unknown>>(`/tenants/${tenant.id}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      setHasToken((data.has_subscription_token as boolean) ?? hasToken);
      setSubscriptionToken("");
      router.refresh();
    } catch (err) {
      setTokenError(err instanceof Error ? err.message : "Failed to save");
    } finally {
      setSaving(false);
    }
  }

  async function handleClearToken() {
    setSubscriptionToken("");
    setSubscriptionBaseUrl("");
    setSubscriptionExpiresAt("");
    setSaving(true);
    setTokenError("");
    try {
      await adminFetch(`/tenants/${tenant.id}`, {
        method: "PATCH",
        body: JSON.stringify({ subscription_token: "" }),
      });
      setHasToken(false);
      router.refresh();
    } catch (err) {
      setTokenError(err instanceof Error ? err.message : "Failed to clear token");
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="space-y-6">
      {/* Company Details */}
      <div className="rounded-lg border border-muted-foreground/25 p-5">
        <div className="flex items-center gap-2 mb-3">
          <h2 className="text-lg font-semibold">Company Details</h2>
          <Badge variant={tenant.status === "active" ? "default" : "destructive"}>
            {tenant.status}
          </Badge>
        </div>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          <FormField label="Name">
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </FormField>
          <FormField label="Slug">
            <Input value={tenant.slug} readOnly disabled className="opacity-60" />
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
        {/* Logo */}
        <div className="flex items-center gap-5 mt-5 pt-5 border-t border-muted-foreground/15">
          {logoUrl ? (
            <img src={logoUrl} alt={name} className="w-16 h-16 rounded-xl object-cover border border-border" />
          ) : (
            <div className="w-16 h-16 rounded-xl bg-muted flex items-center justify-center text-xl font-bold text-muted-foreground">
              {name.split(/\s+/).map(w => w[0]).join("").toUpperCase().slice(0, 2) || "?"}
            </div>
          )}
          <div className="space-y-2">
            <p className="text-sm text-muted-foreground">Upload a logo for your company. Recommended size: 256x256px.</p>
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
                  const img = new Image();
                  img.onload = () => {
                    const MAX = 256;
                    let w = img.width, h = img.height;
                    if (w > MAX || h > MAX) {
                      const ratio = Math.min(MAX / w, MAX / h);
                      w = Math.round(w * ratio);
                      h = Math.round(h * ratio);
                    }
                    const canvas = document.createElement("canvas");
                    canvas.width = w;
                    canvas.height = h;
                    canvas.getContext("2d")!.drawImage(img, 0, 0, w, h);
                    setLogoUrl(canvas.toDataURL("image/png"));
                    URL.revokeObjectURL(img.src);
                  };
                  img.src = URL.createObjectURL(file);
                  e.target.value = "";
                }}
              />
            </div>
          </div>
        </div>
      </div>

      {/* Claude Subscription */}
      <div className="rounded-lg border border-muted-foreground/25 p-5">
        <div className="flex items-center gap-2 mb-3">
          <h2 className="text-lg font-semibold">Claude Subscription</h2>
          <Button
            type="button"
            variant="ghost"
            size="icon-xs"
            onClick={() => setShowTokenHelp(!showTokenHelp)}
            aria-label="How to get a token"
            title="How to get a token"
          >
            <Info />
          </Button>
          {hasToken && <Badge variant="default">Configured</Badge>}
          {(() => {
            if (!subscriptionExpiresAt && !tenant.subscription_token_expires_at) return null;
            const expiryStr = subscriptionExpiresAt || toDateStr(tenant.subscription_token_expires_at);
            if (!expiryStr) return null;
            const daysUntilExpiry = Math.ceil((new Date(expiryStr).getTime() - Date.now()) / (1000 * 60 * 60 * 24));
            if (daysUntilExpiry <= 0) return <Badge variant="destructive">Expired</Badge>;
            if (daysUntilExpiry <= 30) return <Badge className="bg-amber-600">Expires soon</Badge>;
            return null;
          })()}
        </div>
        <p className="text-sm text-muted-foreground mb-4">
          Use your Claude Pro/Max subscription token instead of the AI Gateway for Claude models. Non-Claude models (OpenAI, Gemini, etc.) always use the AI Gateway.
        </p>
        {showTokenHelp && (
          <div className="rounded-md bg-muted/50 border border-border p-3 mb-4 text-sm text-muted-foreground space-y-1">
            <p className="font-medium text-foreground">How to get a long-lived token:</p>
            <ol className="list-decimal list-inside space-y-0.5">
              <li>Install Claude Code CLI: <code className="text-xs bg-muted px-1 py-0.5 rounded">npm install -g @anthropic-ai/claude-code</code></li>
              <li>Run: <code className="text-xs bg-muted px-1 py-0.5 rounded">claude login</code></li>
              <li>Authenticate with your Claude Pro/Max account in the browser</li>
              <li>Run: <code className="text-xs bg-muted px-1 py-0.5 rounded">claude setup-token</code></li>
              <li>Copy the generated <code className="text-xs bg-muted px-1 py-0.5 rounded">sk-ant-oat01-...</code> token</li>
            </ol>
            <p>The token is valid for approximately 1 year.</p>
          </div>
        )}
        {tokenError && (
          <p className="text-sm text-destructive mb-3">{tokenError}</p>
        )}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <FormField label="Claude Subscription Token">
            <div className="flex gap-2">
              <Input
                type="password"
                placeholder={hasToken ? "sk-ant-oat01-••••••" : "sk-ant-oat01-..."}
                value={subscriptionToken}
                onChange={(e) => setSubscriptionToken(e.target.value)}
              />
              {hasToken && (
                <Button size="sm" variant="outline" onClick={handleClearToken} disabled={saving}>
                  Clear
                </Button>
              )}
            </div>
          </FormField>
          <FormField label="Base URL">
            <Input
              placeholder="https://api.claude.ai (default)"
              value={subscriptionBaseUrl}
              onChange={(e) => setSubscriptionBaseUrl(e.target.value)}
              disabled={!hasToken && !subscriptionToken}
            />
          </FormField>
          <FormField label="Token Expires">
            <DatePicker
              value={subscriptionExpiresAt}
              onChange={setSubscriptionExpiresAt}
              placeholder="Select expiry date"
              disabled={!hasToken && !subscriptionToken}
            />
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
