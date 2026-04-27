"use client";

import { useState, useEffect, useCallback } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogBody, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { SectionHeader } from "@/components/ui/section-header";
import { CopyButton } from "@/components/ui/copy-button";
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
  const [loading, setLoading] = useState(true);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reveal, setReveal] = useState<RevealedSecret | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await adminFetch<{ data: WebhookSource[] }>(
        `/webhooks?tenant_id=${tenantId}&agent_id=${agentId}`,
      );
      setSources(data.data);
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
          <p className="text-sm text-zinc-400">
            HMAC-signed inbound webhooks that trigger this agent.
          </p>
        </SectionHeader>
        <Button onClick={() => setCreating(true)} variant="default" size="sm">
          New webhook
        </Button>
      </div>

      {error ? <div className="text-sm text-red-400">{error}</div> : null}

      {loading ? (
        <div className="text-sm text-zinc-400">Loading…</div>
      ) : sources.length === 0 ? (
        <div className="rounded border border-zinc-800 p-6 text-sm text-zinc-400">
          No webhooks yet. Click <span className="text-zinc-200">New webhook</span> to add one.
        </div>
      ) : (
        <div className="overflow-hidden rounded border border-zinc-800">
          <table className="w-full text-sm">
            <thead className="bg-zinc-900 text-left text-xs uppercase text-zinc-500">
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
  onChanged,
  onSecretRevealed,
  onError,
}: {
  source: WebhookSource;
  baseUrl: string;
  tenantId: string;
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
    <tr className="border-t border-zinc-800">
      <td className="p-3 font-medium text-zinc-100">{source.name}</td>
      <td className="p-3">
        <Badge>{source.enabled ? "Enabled" : "Disabled"}</Badge>
      </td>
      <td className="p-3 text-zinc-400">
        {source.last_triggered_at ? new Date(source.last_triggered_at).toLocaleString() : "—"}
      </td>
      <td className="p-3">
        <div className="flex items-center gap-2">
          <code className="truncate rounded bg-zinc-900 px-2 py-1 text-xs text-zinc-300">{ingressUrl}</code>
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
              <label className="block text-xs uppercase text-zinc-500">Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="github-pr-events"
                className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs uppercase text-zinc-500">Provider</label>
              <select
                value={provider}
                onChange={(e) => handleProviderChange(e.target.value)}
                className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm"
              >
                {PROVIDER_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>{opt.label}</option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-xs uppercase text-zinc-500">Signature header</label>
              <input
                type="text"
                value={signatureHeader}
                onChange={(e) => handleSignatureHeaderChange(e.target.value)}
                className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-xs"
              />
            </div>
            <div>
              <label className="block text-xs uppercase text-zinc-500">
                Signing secret <span className="ml-2 normal-case text-zinc-500">(optional)</span>
              </label>
              <input
                type="password"
                value={signingSecret}
                onChange={(e) => setSigningSecret(e.target.value)}
                placeholder="Leave empty to auto-generate"
                className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-xs"
              />
            </div>
            <div>
              <label className="block text-xs uppercase text-zinc-500">
                Prompt template <span className="ml-2 normal-case text-zinc-500">— supports {"{{payload}}"} and {"{{source.name}}"}</span>
              </label>
              <textarea
                value={promptTemplate}
                onChange={(e) => setPromptTemplate(e.target.value)}
                rows={4}
                className="mt-1 w-full rounded border border-zinc-700 bg-zinc-900 px-3 py-2 font-mono text-xs"
              />
            </div>
            {error ? <div className="text-sm text-red-400">{error}</div> : null}
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
            <div className="rounded border border-yellow-500/50 bg-yellow-500/10 p-3 text-sm text-yellow-200">
              This secret is shown only once. Store it somewhere safe — it cannot be retrieved later.
            </div>
            <div>
              <label className="block text-xs uppercase text-zinc-500">Secret</label>
              <div className="mt-1 flex items-center gap-2">
                <code className="flex-1 rounded bg-zinc-900 px-3 py-2 font-mono text-xs">{revealed.secret}</code>
                <CopyButton text={revealed.secret} />
              </div>
            </div>
            <div>
              <label className="block text-xs uppercase text-zinc-500">Example request</label>
              <div className="mt-1 flex items-start gap-2">
                <pre className="flex-1 overflow-x-auto rounded bg-zinc-900 p-3 font-mono text-xs text-zinc-300">{curlExample}</pre>
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
