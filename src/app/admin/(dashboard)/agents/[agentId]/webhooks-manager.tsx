"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogBody, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { SectionHeader } from "@/components/ui/section-header";
import { CopyButton } from "@/components/ui/copy-button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { adminFetch, AdminApiError } from "@/app/admin/lib/api";
import { PROVIDER_OPTIONS, PROVIDER_PRESETS, detectProvider } from "./webhook-provider-presets";
import {
  OPERATOR_LABELS,
  VALUE_REQUIRED_OPERATORS,
  type FilterCondition,
  type FilterOperator,
  type FilterRules,
} from "@/lib/webhook-filter";

interface WebhookSource {
  id: string;
  tenant_id: string;
  agent_id: string;
  name: string;
  enabled: boolean;
  signature_header: string;
  prompt_template: string;
  last_triggered_at: string | null;
  filter_rules: FilterRules | null;
  created_at: string;
}

const OPERATORS_IN_ORDER: FilterOperator[] = [
  "equals",
  "not_equals",
  "contains",
  "not_contains",
  "exists",
  "not_exists",
];

const KEY_PATH_REGEX =
  /^[a-zA-Z_][a-zA-Z0-9_]{0,63}(\.[a-zA-Z_][a-zA-Z0-9_]{0,63}){0,9}$/;

function emptyCondition(): FilterCondition {
  return { keyPath: "data.action", operator: "equals", value: "create" };
}

function FilterEditor({
  rules,
  onChange,
}: {
  rules: FilterRules | null;
  onChange: (rules: FilterRules | null) => void;
}) {
  const conditions = rules?.conditions ?? [];
  const combinator = rules?.combinator ?? "AND";

  function update(next: FilterRules | null) {
    onChange(next);
  }

  function addCondition() {
    const newConditions = [...conditions, emptyCondition()];
    update({ combinator, conditions: newConditions });
  }

  function removeCondition(index: number) {
    const newConditions = conditions.filter((_, i) => i !== index);
    if (newConditions.length === 0) {
      update(null);
    } else {
      update({ combinator, conditions: newConditions });
    }
  }

  function setCondition(index: number, patch: Partial<FilterCondition>) {
    const next: FilterCondition[] = conditions.map((c, i) =>
      i === index ? { ...c, ...patch } : c,
    );
    update({ combinator, conditions: next });
  }

  function setCombinator(value: "AND" | "OR") {
    if (conditions.length === 0) return;
    update({ combinator: value, conditions });
  }

  if (conditions.length === 0) {
    return (
      <div className="rounded-md border border-dashed border-border p-3 text-xs text-muted-foreground">
        No filters — every verified event triggers a run.{" "}
        <button
          type="button"
          onClick={addCondition}
          className="text-primary hover:underline"
        >
          Add condition
        </button>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-3 text-xs">
        <label className="flex items-center gap-1">
          <input
            type="radio"
            name={`filter-combinator`}
            checked={combinator === "AND"}
            onChange={() => setCombinator("AND")}
          />
          Match ALL conditions
        </label>
        <label className="flex items-center gap-1">
          <input
            type="radio"
            name={`filter-combinator`}
            checked={combinator === "OR"}
            onChange={() => setCombinator("OR")}
          />
          Match ANY condition
        </label>
      </div>

      <div className="space-y-2">
        {conditions.map((cond, i) => {
          const valueRequired = VALUE_REQUIRED_OPERATORS.has(cond.operator);
          const keyPathError =
            cond.keyPath.length > 0 && !KEY_PATH_REGEX.test(cond.keyPath);
          const valueMissing =
            valueRequired && (cond.value === undefined || cond.value === "");
          return (
            <div key={i} className="space-y-1">
              <div className="flex flex-wrap items-center gap-2">
                <Input
                  type="text"
                  value={cond.keyPath}
                  onChange={(e) =>
                    setCondition(i, { keyPath: e.target.value })
                  }
                  placeholder="data.action"
                  className="font-mono text-xs flex-1 min-w-[120px]"
                />
                <select
                  value={cond.operator}
                  onChange={(e) =>
                    setCondition(i, {
                      operator: e.target.value as FilterOperator,
                      // Clear value when switching to existence operator.
                      ...(VALUE_REQUIRED_OPERATORS.has(
                        e.target.value as FilterOperator,
                      )
                        ? {}
                        : { value: undefined }),
                    })
                  }
                  className="flex h-9 rounded-md border border-border bg-background px-2 text-xs shadow-xs focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  {OPERATORS_IN_ORDER.map((op) => (
                    <option key={op} value={op}>
                      {OPERATOR_LABELS[op]}
                    </option>
                  ))}
                </select>
                {valueRequired ? (
                  <Input
                    type="text"
                    value={cond.value ?? ""}
                    onChange={(e) =>
                      setCondition(i, { value: e.target.value })
                    }
                    placeholder="value"
                    className="font-mono text-xs flex-1 min-w-[100px]"
                  />
                ) : null}
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => removeCondition(i)}
                  aria-label="Remove condition"
                >
                  ×
                </Button>
              </div>
              {keyPathError ? (
                <div className="text-xs text-destructive">
                  Key path must be dot-separated identifiers
                  (e.g. <code>data.action</code>).
                </div>
              ) : null}
              {valueMissing ? (
                <div className="text-xs text-destructive">
                  Value is required for this operator.
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <Button size="sm" variant="outline" onClick={addCondition}>
        Add condition
      </Button>
    </div>
  );
}

function isFilterRulesValid(rules: FilterRules | null): boolean {
  if (!rules) return true;
  if (rules.conditions.length === 0) return true;
  for (const c of rules.conditions) {
    if (!KEY_PATH_REGEX.test(c.keyPath)) return false;
    if (
      VALUE_REQUIRED_OPERATORS.has(c.operator) &&
      (c.value === undefined || c.value === "")
    ) {
      return false;
    }
  }
  return true;
}

interface EffectiveDedupeRule {
  keyPath: string;
  windowSeconds: number;
  enabled: boolean;
  source: "default" | "override";
}

type EffectiveDedupeMap = Record<string, EffectiveDedupeRule>;

interface RevealedSecret {
  webhookId: string;
  webhookName: string;
  signatureHeader: string;
  secret: string;
}

const DEFAULT_TEMPLATE = "A new event arrived from {{source.name}}:\n\n{{payload}}";

export function WebhooksManager({
  agentId,
  tenantId,
  baseUrl,
}: {
  agentId: string;
  tenantId: string;
  baseUrl: string;
}) {
  const [sources, setSources] = useState<WebhookSource[]>([]);
  const [dedupeRules, setDedupeRules] = useState<EffectiveDedupeMap>({});
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reveal, setReveal] = useState<RevealedSecret | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [data, rulesResponse] = await Promise.all([
        adminFetch<{ data: WebhookSource[] }>(
          `/webhooks?tenant_id=${tenantId}&agent_id=${agentId}`,
        ),
        adminFetch<{ effective: EffectiveDedupeMap }>(
          `/dedupe-rules?tenant_id=${tenantId}`,
        ).catch(() => ({ effective: {} })),
      ]);
      setSources(data.data);
      setDedupeRules(rulesResponse.effective ?? {});
    } catch (err) {
      setError(err instanceof AdminApiError ? err.message : "Failed to load webhooks");
    } finally {
      setLoading(false);
    }
  }, [agentId, tenantId]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-4">
        <SectionHeader title="Webhooks">
          <p className="text-sm text-muted-foreground">
            HMAC-signed inbound webhooks that trigger this agent.
          </p>
        </SectionHeader>
        <Button onClick={() => setCreating(true)} variant="default" size="sm">
          New webhook
        </Button>
      </div>

      {error ? <div className="text-sm text-destructive">{error}</div> : null}

      {loading ? (
        <div className="text-sm text-muted-foreground">Loading…</div>
      ) : sources.length === 0 ? (
        <div className="rounded border border-border p-6 text-sm text-muted-foreground">
          No webhooks yet. Click <span className="text-foreground">New webhook</span> to add one.
        </div>
      ) : (
        <div className="overflow-hidden rounded border border-border">
          <table className="w-full text-sm">
            <thead className="bg-muted text-left text-xs uppercase text-muted-foreground">
              <tr>
                <th className="p-3">Name</th>
                <th className="p-3">Enabled</th>
                <th className="p-3">Last triggered</th>
                <th className="p-3">URL</th>
                <th className="p-3 text-right">Actions</th>
              </tr>
            </thead>
            <tbody>
              {sources.map((s) => (
                <WebhookRow
                  key={s.id}
                  source={s}
                  baseUrl={baseUrl}
                  tenantId={tenantId}
                  dedupeRule={dedupeRules[detectProvider(s.signature_header)] ?? null}
                  onChanged={refresh}
                  onSecretRevealed={(secret) =>
                    setReveal({
                      webhookId: s.id,
                      webhookName: s.name,
                      signatureHeader: s.signature_header,
                      secret,
                    })
                  }
                  onError={setError}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}

      {creating ? (
        <CreateWebhookDialog
          agentId={agentId}
          tenantId={tenantId}
          onClose={() => setCreating(false)}
          onCreated={(source, secret) => {
            setCreating(false);
            setReveal({
              webhookId: source.id,
              webhookName: source.name,
              signatureHeader: source.signature_header,
              secret,
            });
            void refresh();
          }}
        />
      ) : null}

      {reveal ? (
        <SecretRevealDialog
          baseUrl={baseUrl}
          revealed={reveal}
          onClose={() => setReveal(null)}
        />
      ) : null}
    </div>
  );
}

function WebhookRow({
  source,
  baseUrl,
  tenantId,
  dedupeRule,
  onChanged,
  onSecretRevealed,
  onError,
}: {
  source: WebhookSource;
  baseUrl: string;
  tenantId: string;
  dedupeRule: EffectiveDedupeRule | null;
  onChanged: () => void;
  onSecretRevealed: (secret: string) => void;
  onError: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  const ingressUrl = `${baseUrl}/api/webhooks/${source.id}`;

  async function toggle() {
    setBusy(true);
    try {
      await adminFetch(`/webhooks/${source.id}?tenant_id=${tenantId}`, {
        method: "PATCH",
        body: JSON.stringify({ tenant_id: tenantId, enabled: !source.enabled }),
      });
      onChanged();
    } catch (err) {
      onError(err instanceof AdminApiError ? err.message : "Toggle failed");
    } finally {
      setBusy(false);
    }
  }

  async function rotate() {
    if (!confirm(`Rotate the secret for "${source.name}"? The old secret stays valid for 7 days.`)) {
      return;
    }
    setBusy(true);
    try {
      const res = await adminFetch<{ secret: string }>(
        `/webhooks/${source.id}/rotate`,
        { method: "POST", body: JSON.stringify({ tenant_id: tenantId }) },
      );
      onSecretRevealed(res.secret);
    } catch (err) {
      onError(err instanceof AdminApiError ? err.message : "Rotation failed");
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!confirm(`Delete webhook "${source.name}"? This cannot be undone.`)) return;
    setBusy(true);
    try {
      await adminFetch(`/webhooks/${source.id}?tenant_id=${tenantId}`, { method: "DELETE" });
      onChanged();
    } catch (err) {
      onError(err instanceof AdminApiError ? err.message : "Delete failed");
    } finally {
      setBusy(false);
    }
  }

  const [editingFilter, setEditingFilter] = useState(false);
  const filterCount = source.filter_rules?.conditions.length ?? 0;

  return (
    <tr className="border-t border-border">
      <td className="p-3 font-medium text-foreground align-top">
        <div>{source.name}</div>
        {dedupeRule && dedupeRule.enabled ? (
          <div className="mt-1 text-xs font-normal text-muted-foreground">
            Deduping: <code className="rounded bg-muted px-1 py-0.5 text-foreground">{dedupeRule.keyPath}</code>
            {" · "}{dedupeRule.windowSeconds}s · {dedupeRule.source}{" "}
            <a
              href="/admin/settings#dedupe-rules"
              className="text-primary hover:underline"
            >
              Manage →
            </a>
          </div>
        ) : null}
        {filterCount > 0 && source.filter_rules ? (
          <div className="mt-1 text-xs font-normal text-muted-foreground">
            Filtering: {filterCount} condition{filterCount === 1 ? "" : "s"}{" "}
            ({source.filter_rules.combinator})
            {" · "}
            <button
              type="button"
              onClick={() => setEditingFilter(true)}
              className="text-primary hover:underline"
            >
              Edit →
            </button>
          </div>
        ) : null}
      </td>
      <td className="p-3 align-top">
        <Badge>{source.enabled ? "Enabled" : "Disabled"}</Badge>
      </td>
      <td className="p-3 text-muted-foreground">
        {source.last_triggered_at ? new Date(source.last_triggered_at).toLocaleString() : "—"}
      </td>
      <td className="p-3">
        <div className="flex items-center gap-2">
          <code className="truncate rounded bg-muted px-2 py-1 text-xs text-foreground">{ingressUrl}</code>
          <CopyButton text={ingressUrl} />
        </div>
      </td>
      <td className="p-3 text-right">
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setEditingFilter(true)} disabled={busy}>
            {filterCount > 0 ? "Filter" : "Add filter"}
          </Button>
          <Button size="sm" variant="ghost" onClick={toggle} disabled={busy}>
            {source.enabled ? "Disable" : "Enable"}
          </Button>
          <Button size="sm" variant="ghost" onClick={rotate} disabled={busy}>
            Rotate secret
          </Button>
          <Button size="sm" variant="destructive" onClick={remove} disabled={busy}>
            Delete
          </Button>
        </div>
        {editingFilter ? (
          <EditFilterDialog
            source={source}
            tenantId={tenantId}
            onClose={() => setEditingFilter(false)}
            onSaved={() => {
              setEditingFilter(false);
              onChanged();
            }}
            onError={onError}
          />
        ) : null}
      </td>
    </tr>
  );
}

function EditFilterDialog({
  source,
  tenantId,
  onClose,
  onSaved,
  onError,
}: {
  source: WebhookSource;
  tenantId: string;
  onClose: () => void;
  onSaved: () => void;
  onError: (msg: string) => void;
}) {
  const [rules, setRules] = useState<FilterRules | null>(source.filter_rules);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await adminFetch(`/webhooks/${source.id}?tenant_id=${tenantId}`, {
        method: "PATCH",
        body: JSON.stringify({ tenant_id: tenantId, filter_rules: rules }),
      });
      onSaved();
    } catch (err) {
      onError(err instanceof AdminApiError ? err.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Payload filter — {source.name}</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              Only trigger this agent when the webhook payload matches.
              An empty rule list disables filtering — every verified event will run the agent.
            </p>
            <FilterEditor rules={rules} onChange={setRules} />
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button
            variant="default"
            onClick={save}
            disabled={saving || !isFilterRulesValid(rules)}
          >
            {saving ? "Saving…" : "Save filter"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreateWebhookDialog({
  agentId,
  tenantId,
  onClose,
  onCreated,
}: {
  agentId: string;
  tenantId: string;
  onClose: () => void;
  onCreated: (source: WebhookSource, secret: string) => void;
}) {
  const [name, setName] = useState("");
  const [promptTemplate, setPromptTemplate] = useState(DEFAULT_TEMPLATE);
  const [provider, setProvider] = useState("github");
  const [signatureHeader, setSignatureHeader] = useState(PROVIDER_PRESETS.github.signatureHeader);
  const [signingSecret, setSigningSecret] = useState("");
  const [filterRules, setFilterRules] = useState<FilterRules | null>(null);
  const [showFilter, setShowFilter] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  function handleProviderChange(value: string) {
    setProvider(value);
    const preset = PROVIDER_PRESETS[value];
    if (preset) setSignatureHeader(preset.signatureHeader);
  }

  function handleSignatureHeaderChange(value: string) {
    setSignatureHeader(value);
    setProvider(detectProvider(value));
  }

  async function submit() {
    setSubmitting(true);
    setError(null);
    try {
      const trimmedSecret = signingSecret.trim();
      const res = await adminFetch<WebhookSource & { secret?: string }>(`/webhooks`, {
        method: "POST",
        body: JSON.stringify({
          tenant_id: tenantId,
          agent_id: agentId,
          name,
          prompt_template: promptTemplate,
          signature_header: signatureHeader,
          ...(trimmedSecret ? { secret: trimmedSecret } : {}),
          ...(filterRules ? { filter_rules: filterRules } : {}),
        }),
      });
      const { secret, ...source } = res;
      // When the user supplied a secret, the API doesn't echo it back —
      // they already know it, no reveal dialog needed.
      onCreated(source, secret ?? trimmedSecret);
    } catch (err) {
      setError(err instanceof AdminApiError ? err.message : "Create failed");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>New webhook</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <div className="space-y-3">
            <div>
              <label className="block text-xs font-medium text-foreground mb-1">Name</label>
              <Input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="github-pr-events"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-foreground mb-1">Provider</label>
              <select
                value={provider}
                onChange={(e) => handleProviderChange(e.target.value)}
                className="flex h-9 w-full rounded-md border border-border bg-background px-3 py-1 text-sm shadow-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {PROVIDER_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs font-medium text-foreground mb-1">Signature header</label>
              <Input
                type="text"
                value={signatureHeader}
                onChange={(e) => handleSignatureHeaderChange(e.target.value)}
                className="font-mono text-xs"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-foreground mb-1">
                Signing secret <span className="ml-1 font-normal text-muted-foreground">(optional)</span>
              </label>
              <Input
                type="password"
                value={signingSecret}
                onChange={(e) => setSigningSecret(e.target.value)}
                placeholder="Leave empty to auto-generate"
                className="font-mono text-xs"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-foreground mb-1">
                Prompt template <span className="ml-1 font-normal text-muted-foreground">— supports {"{{payload}}"} and {"{{source.name}}"}</span>
              </label>
              <Textarea
                value={promptTemplate}
                onChange={(e) => setPromptTemplate(e.target.value)}
                rows={4}
                className="font-mono text-xs"
              />
            </div>
            <div>
              <button
                type="button"
                onClick={() => setShowFilter((v) => !v)}
                className="flex items-center gap-1 text-xs font-medium text-foreground hover:text-primary"
              >
                <span>{showFilter ? "▾" : "▸"}</span>
                Payload filter{" "}
                <span className="font-normal text-muted-foreground">
                  (optional — only fire the agent when the payload matches)
                </span>
              </button>
              {showFilter ? (
                <div className="mt-2">
                  <FilterEditor rules={filterRules} onChange={setFilterRules} />
                </div>
              ) : null}
            </div>
            {error ? <div className="text-sm text-destructive">{error}</div> : null}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button
            variant="default"
            onClick={submit}
            disabled={
              submitting ||
              !name ||
              !promptTemplate ||
              !isFilterRulesValid(filterRules)
            }
          >
            {submitting ? "Creating…" : "Create webhook"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function SecretRevealDialog({
  baseUrl,
  revealed,
  onClose,
}: {
  baseUrl: string;
  revealed: RevealedSecret;
  onClose: () => void;
}) {
  const ingressUrl = `${baseUrl}/api/webhooks/${revealed.webhookId}`;
  const curlExample = [
    `TS=$(date +%s)`,
    `BODY='{"hello":"world"}'`,
    `SIG="sha256=$(printf '%s.%s' "$TS" "$BODY" | openssl dgst -sha256 -hmac "${revealed.secret}" -hex | cut -d' ' -f2)"`,
    `curl -X POST ${ingressUrl} \\`,
    `  -H "${revealed.signatureHeader}: $SIG" \\`,
    `  -H "Webhook-Timestamp: $TS" \\`,
    `  -H "Webhook-Delivery-Id: $(uuidgen)" \\`,
    `  -H "Content-Type: application/json" \\`,
    `  -d "$BODY"`,
  ].join("\n");

  return (
    <Dialog open onOpenChange={(open) => { if (!open) onClose(); }}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Webhook secret — copy now</DialogTitle>
        </DialogHeader>
        <DialogBody>
          <div className="space-y-4">
            <div className="rounded border border-amber-500/50 bg-amber-500/10 p-3 text-sm text-amber-700 dark:text-amber-300">
              This secret is shown only once. Store it somewhere safe — it cannot be retrieved later.
            </div>
            <div>
              <label className="block text-xs uppercase text-muted-foreground">Secret</label>
              <div className="mt-1 flex items-center gap-2">
                <code className="flex-1 rounded bg-muted px-3 py-2 font-mono text-xs">{revealed.secret}</code>
                <CopyButton text={revealed.secret} />
              </div>
            </div>
            <div>
              <label className="block text-xs uppercase text-muted-foreground">Example request</label>
              <div className="mt-1 flex items-start gap-2">
                <pre className="flex-1 overflow-x-auto rounded bg-muted p-3 font-mono text-xs text-foreground">{curlExample}</pre>
                <CopyButton text={curlExample} />
              </div>
            </div>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="default" onClick={onClose}>Done</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
