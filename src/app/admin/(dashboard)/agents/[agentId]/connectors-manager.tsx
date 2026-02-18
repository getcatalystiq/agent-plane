"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ToolkitMultiselect } from "@/components/toolkit-multiselect";
import type { AuthScheme, ConnectorStatus } from "@/lib/composio";

interface Props {
  agentId: string;
  toolkits: string[];
}

function schemeBadgeVariant(scheme: AuthScheme) {
  if (scheme === "NO_AUTH") return "secondary";
  if (scheme === "API_KEY") return "outline";
  if (scheme === "OAUTH2" || scheme === "OAUTH1") return "outline";
  return "outline";
}

function statusColor(status: string | null) {
  if (status === "ACTIVE") return "text-green-600";
  if (status === "INITIATED") return "text-yellow-600";
  if (status === "FAILED" || status === "EXPIRED" || status === "INACTIVE") return "text-red-500";
  return "text-muted-foreground";
}

export function ConnectorsManager({ agentId, toolkits: initialToolkits }: Props) {
  const router = useRouter();
  const [localToolkits, setLocalToolkits] = useState<string[]>(initialToolkits);
  const [connectors, setConnectors] = useState<ConnectorStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [pendingToolkits, setPendingToolkits] = useState<string[]>(initialToolkits);
  const [applyingToolkits, setApplyingToolkits] = useState(false);
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/agents/${agentId}/connectors`);
      const data = await res.json();
      setConnectors(data.connectors ?? []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => { load(); }, [agentId, localToolkits.join(",")]);

  async function patchToolkits(newToolkits: string[]) {
    await fetch(`/api/admin/agents/${agentId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ composio_toolkits: newToolkits }),
    });
    setLocalToolkits(newToolkits);
    router.refresh();
  }

  async function handleApplyAdd() {
    setApplyingToolkits(true);
    try {
      await patchToolkits(pendingToolkits);
      setShowAdd(false);
    } finally {
      setApplyingToolkits(false);
    }
  }

  async function handleDelete(slug: string) {
    await patchToolkits(localToolkits.filter((t) => t !== slug));
  }

  async function handleSaveKey(slug: string) {
    const key = apiKeys[slug];
    if (!key) return;
    setSaving((s) => ({ ...s, [slug]: true }));
    setErrors((e) => ({ ...e, [slug]: "" }));
    try {
      const res = await fetch(`/api/admin/agents/${agentId}/connectors`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolkit: slug, api_key: key }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setErrors((e) => ({ ...e, [slug]: data?.error ?? `Error ${res.status}` }));
        return;
      }
      setApiKeys((k) => ({ ...k, [slug]: "" }));
      await load();
      router.refresh();
    } catch (err) {
      setErrors((e) => ({ ...e, [slug]: err instanceof Error ? err.message : "Unknown error" }));
    } finally {
      setSaving((s) => ({ ...s, [slug]: false }));
    }
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">Connector Configuration</CardTitle>
        <Button
          size="sm"
          variant="outline"
          onClick={() => { setPendingToolkits(localToolkits); setShowAdd(true); }}
        >
          Add
        </Button>
      </CardHeader>
      <CardContent>
        {showAdd && (
          <div className="mb-4 flex items-start gap-2">
            <div className="flex-1">
              <ToolkitMultiselect value={pendingToolkits} onChange={setPendingToolkits} />
            </div>
            <Button size="sm" onClick={handleApplyAdd} disabled={applyingToolkits}>
              {applyingToolkits ? "Saving..." : "Apply"}
            </Button>
            <Button size="sm" variant="ghost" onClick={() => setShowAdd(false)}>Cancel</Button>
          </div>
        )}
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : localToolkits.length === 0 ? (
          <p className="text-sm text-muted-foreground">No connectors added. Click Add to configure connectors.</p>
        ) : (
          <div className="grid grid-cols-3 gap-3">
            {connectors.map((c) => (
              <div key={c.slug} className="rounded-lg border border-border p-3 flex flex-col gap-2">
                {/* Logo + name + badge + delete */}
                <div className="flex items-center gap-2">
                  {c.logo && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={c.logo} alt="" className="w-5 h-5 rounded-sm object-contain flex-shrink-0" />
                  )}
                  <span className="text-sm font-medium truncate flex-1">{c.name}</span>
                  <Badge variant={schemeBadgeVariant(c.authScheme)} className="text-xs flex-shrink-0">
                    {c.authScheme}
                  </Badge>
                  <button
                    type="button"
                    onClick={() => handleDelete(c.slug)}
                    className="text-muted-foreground hover:text-red-500 flex-shrink-0 ml-1 text-base leading-none"
                    title="Remove connector"
                  >
                    ×
                  </button>
                </div>

                {/* Status */}
                {c.authScheme === "NO_AUTH" ? (
                  <span className="text-xs text-muted-foreground">No auth required</span>
                ) : c.connectionStatus === "ACTIVE" ? (
                  <span className={`text-xs font-medium ${statusColor(c.connectionStatus)}`}>✓ Connected</span>
                ) : c.connectionStatus ? (
                  <span className={`text-xs ${statusColor(c.connectionStatus)}`}>{c.connectionStatus.toLowerCase()}</span>
                ) : null}

                {/* Action: API_KEY input */}
                {c.authScheme === "API_KEY" && (
                  <div className="flex flex-col gap-1 mt-auto">
                    <div className="flex items-center gap-2">
                      <Input
                        type="password"
                        placeholder={c.connectionStatus === "ACTIVE" ? "Update API key…" : "Enter API key…"}
                        value={apiKeys[c.slug] ?? ""}
                        onChange={(e) => setApiKeys((k) => ({ ...k, [c.slug]: e.target.value }))}
                        className="h-7 text-xs flex-1 min-w-0"
                      />
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs flex-shrink-0"
                        disabled={!apiKeys[c.slug] || saving[c.slug]}
                        onClick={() => handleSaveKey(c.slug)}
                      >
                        {saving[c.slug] ? "Saving…" : "Save"}
                      </Button>
                    </div>
                    {errors[c.slug] && (
                      <p className="text-xs text-red-500">{errors[c.slug]}</p>
                    )}
                  </div>
                )}

                {/* Action: OAuth connect */}
                {(c.authScheme === "OAUTH2" || c.authScheme === "OAUTH1") && c.connectionStatus !== "ACTIVE" && (
                  <a href={`/api/admin/agents/${agentId}/connectors/${c.slug}`} className="mt-auto">
                    <Button size="sm" variant="outline" className="h-7 text-xs w-full">Connect</Button>
                  </a>
                )}

                {/* Reconnect for OAuth if active */}
                {(c.authScheme === "OAUTH2" || c.authScheme === "OAUTH1") && c.connectionStatus === "ACTIVE" && (
                  <a href={`/api/admin/agents/${agentId}/connectors/${c.slug}`} className="mt-auto">
                    <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground w-full">Reconnect</Button>
                  </a>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
