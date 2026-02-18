"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
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

export function ConnectorsManager({ agentId, toolkits }: Props) {
  const router = useRouter();
  const [connectors, setConnectors] = useState<ConnectorStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});

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

  useEffect(() => { load(); }, [agentId]);

  async function handleSaveKey(slug: string) {
    const key = apiKeys[slug];
    if (!key) return;
    setSaving((s) => ({ ...s, [slug]: true }));
    try {
      await fetch(`/api/admin/agents/${agentId}/connectors`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ toolkit: slug, api_key: key }),
      });
      setApiKeys((k) => ({ ...k, [slug]: "" }));
      await load();
      router.refresh();
    } finally {
      setSaving((s) => ({ ...s, [slug]: false }));
    }
  }

  if (toolkits.length === 0) return null;

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Connectors</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {loading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : (
          connectors.map((c) => (
            <div key={c.slug} className="flex items-center gap-3 py-2 border-b border-border last:border-0">
              {/* Logo + name */}
              <div className="flex items-center gap-2 w-48 flex-shrink-0">
                {c.logo && (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img src={c.logo} alt="" className="w-6 h-6 rounded-sm object-contain" />
                )}
                <span className="text-sm font-medium truncate">{c.name}</span>
              </div>

              {/* Auth scheme badge */}
              <Badge variant={schemeBadgeVariant(c.authScheme)} className="text-xs flex-shrink-0">
                {c.authScheme}
              </Badge>

              {/* Status */}
              {c.authScheme === "NO_AUTH" ? (
                <span className="text-xs text-muted-foreground">No auth required</span>
              ) : c.connectionStatus === "ACTIVE" ? (
                <span className={`text-xs font-medium ${statusColor(c.connectionStatus)}`}>
                  ✓ Connected
                </span>
              ) : c.connectionStatus ? (
                <span className={`text-xs ${statusColor(c.connectionStatus)}`}>
                  {c.connectionStatus.toLowerCase()}
                </span>
              ) : null}

              {/* Action: API_KEY input */}
              {c.authScheme === "API_KEY" && (
                <div className="flex items-center gap-2 ml-auto">
                  <Input
                    type="password"
                    placeholder={c.connectionStatus === "ACTIVE" ? "Update API key…" : "Enter API key…"}
                    value={apiKeys[c.slug] ?? ""}
                    onChange={(e) => setApiKeys((k) => ({ ...k, [c.slug]: e.target.value }))}
                    className="h-7 text-xs w-56"
                  />
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs"
                    disabled={!apiKeys[c.slug] || saving[c.slug]}
                    onClick={() => handleSaveKey(c.slug)}
                  >
                    {saving[c.slug] ? "Saving…" : "Save"}
                  </Button>
                </div>
              )}

              {/* Action: OAuth connect */}
              {(c.authScheme === "OAUTH2" || c.authScheme === "OAUTH1") && c.connectionStatus !== "ACTIVE" && (
                <div className="ml-auto">
                  <a href={`/api/admin/agents/${agentId}/connectors/${c.slug}`}>
                    <Button size="sm" variant="outline" className="h-7 text-xs">
                      Connect
                    </Button>
                  </a>
                </div>
              )}

              {/* Reconnect for OAuth if expired/failed */}
              {(c.authScheme === "OAUTH2" || c.authScheme === "OAUTH1") && c.connectionStatus === "ACTIVE" && (
                <div className="ml-auto">
                  <a href={`/api/admin/agents/${agentId}/connectors/${c.slug}`}>
                    <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground">
                      Reconnect
                    </Button>
                  </a>
                </div>
              )}
            </div>
          ))
        )}
      </CardContent>
    </Card>
  );
}
