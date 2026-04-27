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

interface WebhookSource {
  id: string;
  tenant_id: string;
  agent_id: string;
  name: string;
  enabled: boolean;
  signature_header: string;
  prompt_template: string;
  last_triggered_at: string | null;
  created_at: string;
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
      </td>
    </tr>
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
            {error ? <div className="text-sm text-destructive">{error}</div> : null}
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button variant="default" onClick={submit} disabled={submitting || !name || !promptTemplate}>
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
