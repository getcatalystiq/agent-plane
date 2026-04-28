"use client";

import { useEffect, useState, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { FormField } from "@/components/ui/form-field";
import { SectionHeader } from "@/components/ui/section-header";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogBody,
  DialogFooter,
  DialogTitle,
} from "@/components/ui/dialog";
import { adminFetch } from "@/app/admin/lib/api";
import { PROVIDER_OPTIONS } from "@/lib/webhook-providers";

interface TenantRule {
  id: string;
  tenant_id: string;
  provider: string;
  key_path: string;
  window_seconds: number;
  enabled: boolean;
  created_at: string;
  updated_at: string;
}

interface DedupeRule {
  keyPath: string;
  windowSeconds: number;
  enabled: boolean;
}

interface EffectiveRule extends DedupeRule {
  source: "default" | "override";
}

interface DedupeRulesResponse {
  defaults: Record<string, DedupeRule>;
  overrides: TenantRule[];
  effective: Record<string, EffectiveRule>;
}

interface DialogFormState {
  provider: string;
  keyPath: string;
  windowSeconds: string;
  enabled: boolean;
  // When editing, we lock provider and remember the rule id.
  editingId: string | null;
}

const EMPTY_FORM: DialogFormState = {
  provider: "linear",
  keyPath: "data.url",
  windowSeconds: "60",
  enabled: true,
  editingId: null,
};

export function DedupeRulesManager({ tenantId }: { tenantId: string }) {
  const [data, setData] = useState<DedupeRulesResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState<DialogFormState>(EMPTY_FORM);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [formError, setFormError] = useState<string | null>(null);

  const [deleteTarget, setDeleteTarget] = useState<TenantRule | null>(null);
  const [deleting, setDeleting] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const result = await adminFetch<DedupeRulesResponse>(
        `/dedupe-rules?tenant_id=${tenantId}`,
      );
      setData(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load rules");
    } finally {
      setLoading(false);
    }
  }, [tenantId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  function openCreate() {
    setForm(EMPTY_FORM);
    setFormError(null);
    setDialogOpen(true);
  }

  function openEdit(rule: TenantRule) {
    setForm({
      provider: rule.provider,
      keyPath: rule.key_path,
      windowSeconds: String(rule.window_seconds),
      enabled: rule.enabled,
      editingId: rule.id,
    });
    setFormError(null);
    setDialogOpen(true);
  }

  function openOverrideFromDefault(provider: string, rule: DedupeRule) {
    setForm({
      provider,
      keyPath: rule.keyPath,
      windowSeconds: String(rule.windowSeconds),
      enabled: rule.enabled,
      editingId: null,
    });
    setFormError(null);
    setDialogOpen(true);
  }

  async function handleSave() {
    setSaving(true);
    setFormError(null);
    const windowSeconds = Number.parseInt(form.windowSeconds, 10);
    if (!Number.isFinite(windowSeconds) || windowSeconds < 1 || windowSeconds > 3600) {
      setFormError("Window must be an integer between 1 and 3600 seconds");
      setSaving(false);
      return;
    }
    try {
      if (form.editingId) {
        await adminFetch(`/dedupe-rules/${form.editingId}`, {
          method: "PATCH",
          body: JSON.stringify({
            tenant_id: tenantId,
            key_path: form.keyPath,
            window_seconds: windowSeconds,
            enabled: form.enabled,
          }),
        });
      } else {
        await adminFetch("/dedupe-rules", {
          method: "POST",
          body: JSON.stringify({
            tenant_id: tenantId,
            provider: form.provider,
            key_path: form.keyPath,
            window_seconds: windowSeconds,
            enabled: form.enabled,
          }),
        });
      }
      setDialogOpen(false);
      await refresh();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  async function handleDelete() {
    if (!deleteTarget) return;
    setDeleting(true);
    try {
      await adminFetch(`/dedupe-rules/${deleteTarget.id}?tenant_id=${tenantId}`, {
        method: "DELETE",
      });
      setDeleteTarget(null);
      await refresh();
    } catch (err) {
      setFormError(err instanceof Error ? err.message : "Delete failed");
    } finally {
      setDeleting(false);
    }
  }

  return (
    <div id="dedupe-rules" className="rounded-lg border p-5">
      <SectionHeader title="Webhook Dedupe Rules">
        <Button size="sm" onClick={openCreate}>Add rule</Button>
      </SectionHeader>
      <p className="text-sm text-muted-foreground mb-4">
        Suppress logical-duplicate webhook deliveries within a sliding window.
        Rules are matched by provider (derived from the source&apos;s signature header).
        Tenant overrides take precedence over platform defaults.
      </p>

      {loading && <p className="text-sm text-muted-foreground">Loading rules…</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}

      {!loading && !error && data && (
        <DedupeRulesTable
          data={data}
          onOverrideFromDefault={openOverrideFromDefault}
          onEdit={openEdit}
          onDelete={setDeleteTarget}
        />
      )}

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {form.editingId ? "Edit dedupe rule" : "Add dedupe rule"}
            </DialogTitle>
          </DialogHeader>
          <DialogBody>
            <div className="space-y-3">
              <FormField label="Provider" hint="Matched against the signature_header on each webhook source.">
                <select
                  value={form.provider}
                  onChange={(e) => setForm({ ...form, provider: e.target.value })}
                  disabled={!!form.editingId}
                  className="w-full h-9 rounded-md border border-input bg-transparent px-3 text-sm focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50"
                >
                  {PROVIDER_OPTIONS.filter((o) => o.value !== "custom").map((o) => (
                    <option key={o.value} value={o.value}>{o.label}</option>
                  ))}
                </select>
              </FormField>
              <FormField label="Key path" hint="Dot-path into the JSON payload, e.g. data.url">
                <Input
                  value={form.keyPath}
                  onChange={(e) => setForm({ ...form, keyPath: e.target.value })}
                  placeholder="data.url"
                />
              </FormField>
              <FormField label="Window (seconds)" hint="1–3600. Sliding window from now.">
                <Input
                  type="number"
                  min={1}
                  max={3600}
                  value={form.windowSeconds}
                  onChange={(e) => setForm({ ...form, windowSeconds: e.target.value })}
                />
              </FormField>
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.enabled}
                  onChange={(e) => setForm({ ...form, enabled: e.target.checked })}
                />
                <span>Enabled</span>
                <span className="text-xs text-muted-foreground">
                  (uncheck to explicitly disable a platform default)
                </span>
              </label>
              {formError && <p className="text-xs text-destructive">{formError}</p>}
            </div>
          </DialogBody>
          <DialogFooter>
            <Button size="sm" variant="outline" onClick={() => setDialogOpen(false)} disabled={saving}>
              Cancel
            </Button>
            <Button size="sm" onClick={handleSave} disabled={saving}>
              {saving ? "Saving…" : form.editingId ? "Save" : "Create"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={!!deleteTarget}
        onOpenChange={(open) => { if (!open) setDeleteTarget(null); }}
        title="Delete override"
        confirmLabel="Delete"
        loadingLabel="Deleting…"
        loading={deleting}
        onConfirm={handleDelete}
      >
        Delete the override for <strong>{deleteTarget?.provider}</strong>?
        The platform default (if any) will apply again.
      </ConfirmDialog>
    </div>
  );
}

interface TableProps {
  data: DedupeRulesResponse;
  onOverrideFromDefault: (provider: string, rule: DedupeRule) => void;
  onEdit: (rule: TenantRule) => void;
  onDelete: (rule: TenantRule) => void;
}

function DedupeRulesTable({ data, onOverrideFromDefault, onEdit, onDelete }: TableProps) {
  const overrideByProvider = new Map(data.overrides.map((o) => [o.provider, o]));

  // Show one row per provider that has either a default or an override.
  const providers = Array.from(
    new Set([...Object.keys(data.defaults), ...data.overrides.map((o) => o.provider)]),
  ).sort();

  if (providers.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        No dedupe rules configured. Add one to suppress logical-duplicate webhook
        deliveries for a provider.
      </p>
    );
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-sm">
        <thead>
          <tr className="text-left text-xs text-muted-foreground border-b">
            <th className="py-2 pr-3 font-medium">Provider</th>
            <th className="py-2 pr-3 font-medium">Key path</th>
            <th className="py-2 pr-3 font-medium">Window</th>
            <th className="py-2 pr-3 font-medium">Enabled</th>
            <th className="py-2 pr-3 font-medium">Source</th>
            <th className="py-2 pr-3 font-medium text-right">Actions</th>
          </tr>
        </thead>
        <tbody>
          {providers.map((provider) => {
            const override = overrideByProvider.get(provider);
            const effective = data.effective[provider];
            const fallbackDefault = data.defaults[provider];
            const display = override
              ? {
                  keyPath: override.key_path,
                  windowSeconds: override.window_seconds,
                  enabled: override.enabled,
                }
              : effective ?? fallbackDefault;

            const source: "override" | "default" =
              override ? "override" : "default";

            return (
              <tr key={provider} className="border-b last:border-b-0">
                <td className="py-2 pr-3 font-mono text-xs">{provider}</td>
                <td className="py-2 pr-3 font-mono text-xs">{display.keyPath}</td>
                <td className="py-2 pr-3">{display.windowSeconds}s</td>
                <td className="py-2 pr-3">
                  {display.enabled ? (
                    <Badge variant="default">on</Badge>
                  ) : (
                    <Badge variant="outline">off</Badge>
                  )}
                </td>
                <td className="py-2 pr-3">
                  {source === "override" ? (
                    <Badge variant="default">override</Badge>
                  ) : (
                    <Badge variant="outline">default</Badge>
                  )}
                </td>
                <td className="py-2 pr-3 text-right space-x-2">
                  {override ? (
                    <>
                      <Button size="sm" variant="outline" onClick={() => onEdit(override)}>
                        Edit
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => onDelete(override)}>
                        Delete
                      </Button>
                    </>
                  ) : (
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() =>
                        onOverrideFromDefault(provider, fallbackDefault ?? {
                          keyPath: "data.url",
                          windowSeconds: 60,
                          enabled: true,
                        })
                      }
                    >
                      Override
                    </Button>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
