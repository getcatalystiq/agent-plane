"use client";

import { useCallback, useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ToolkitMultiselect } from "@/components/toolkit-multiselect";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ToolsModal } from "./tools-modal";
import { McpToolsModal } from "./mcp-tools-modal";
import type { AuthScheme, ConnectorStatus } from "@/lib/composio";

interface McpServer {
  id: string;
  name: string;
  slug: string;
  description: string;
  logo_url: string | null;
  base_url: string;
}

interface McpConnection {
  id: string;
  mcp_server_id: string;
  status: string;
  allowed_tools: string[];
  token_expires_at: string | null;
  server_name: string;
  server_slug: string;
  server_logo_url: string | null;
  server_base_url: string;
}

interface Props {
  agentId: string;
  toolkits: string[];
  composioAllowedTools: string[];
}

function schemeBadgeVariant(scheme: AuthScheme) {
  if (scheme === "NO_AUTH") return "secondary";
  return "outline";
}

function statusColor(status: string | null) {
  if (status === "ACTIVE") return "text-green-600";
  if (status === "INITIATED") return "text-yellow-600";
  if (status === "FAILED" || status === "EXPIRED" || status === "INACTIVE") return "text-red-500";
  return "text-muted-foreground";
}

function isExpiringSoon(expiresAt: string | null): boolean {
  if (!expiresAt) return false;
  const ms = new Date(expiresAt).getTime() - Date.now();
  return ms > 0 && ms < 24 * 60 * 60 * 1000;
}

export function ConnectorsManager({ agentId, toolkits: initialToolkits, composioAllowedTools: initialAllowedTools }: Props) {
  const router = useRouter();

  // Composio state
  const [localToolkits, setLocalToolkits] = useState<string[]>(initialToolkits);
  const [connectors, setConnectors] = useState<ConnectorStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [pendingToolkits, setPendingToolkits] = useState<string[]>(initialToolkits);
  const [applyingToolkits, setApplyingToolkits] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<{ slug: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [apiKeys, setApiKeys] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [allowedTools, setAllowedTools] = useState<string[]>(initialAllowedTools);
  const [toolCounts, setToolCounts] = useState<Record<string, number>>({});
  const [toolsModalToolkit, setToolsModalToolkit] = useState<string | null>(null);

  // MCP state
  const [mcpConnections, setMcpConnections] = useState<McpConnection[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [mcpLoading, setMcpLoading] = useState(true);
  const [mcpConnecting, setMcpConnecting] = useState<string | null>(null);
  const [confirmMcpDisconnect, setConfirmMcpDisconnect] = useState<McpConnection | null>(null);
  const [mcpDisconnecting, setMcpDisconnecting] = useState(false);
  const [mcpToolsModal, setMcpToolsModal] = useState<McpConnection | null>(null);

  // Load Composio connectors
  const loadComposio = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/agents/${agentId}/connectors`);
      const data = await res.json();
      setConnectors(data.connectors ?? []);
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  // Load MCP connections
  const loadMcp = useCallback(async () => {
    setMcpLoading(true);
    try {
      const res = await fetch(`/api/admin/agents/${agentId}/mcp-connections`);
      const data = await res.json();
      setMcpConnections(data.data ?? []);
    } finally {
      setMcpLoading(false);
    }
  }, [agentId]);

  const toolkitsKey = localToolkits.join(",");
  useEffect(() => { loadComposio(); }, [loadComposio, toolkitsKey]);
  useEffect(() => { loadMcp(); }, [loadMcp]);

  // Fetch total tool count per Composio toolkit
  useEffect(() => {
    if (localToolkits.length === 0) return;
    for (const slug of localToolkits) {
      if (toolCounts[slug] !== undefined) continue;
      fetch(`/api/admin/composio/tools?toolkit=${encodeURIComponent(slug)}`)
        .then((res) => res.json())
        .then((data) => setToolCounts((prev) => ({ ...prev, [slug]: (data.data ?? []).length })))
        .catch(() => {});
    }
  }, [toolkitsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  // Load available MCP servers (for Add panel)
  async function loadMcpServers() {
    const res = await fetch("/api/admin/mcp-servers");
    const data = await res.json();
    setMcpServers(data.data ?? []);
  }

  // --- Composio handlers ---

  async function handleToolsSave(toolkit: string, selectedSlugs: string[]) {
    const prefix = toolkit.toUpperCase() + "_";
    const otherTools = allowedTools.filter((t) => !t.startsWith(prefix));
    const updated = [...otherTools, ...selectedSlugs];
    await fetch(`/api/admin/agents/${agentId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ composio_allowed_tools: updated }),
    });
    setAllowedTools(updated);
    setToolsModalToolkit(null);
    router.refresh();
  }

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

  async function handleConfirmDelete() {
    if (!confirmDelete) return;
    setDeleting(true);
    try {
      await patchToolkits(localToolkits.filter((t) => t !== confirmDelete.slug));
      setConfirmDelete(null);
    } finally {
      setDeleting(false);
    }
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
      await loadComposio();
      router.refresh();
    } catch (err) {
      setErrors((e) => ({ ...e, [slug]: err instanceof Error ? err.message : "Unknown error" }));
    } finally {
      setSaving((s) => ({ ...s, [slug]: false }));
    }
  }

  // --- MCP handlers ---

  async function handleMcpConnect(serverId: string) {
    setMcpConnecting(serverId);
    try {
      const res = await fetch(`/api/admin/agents/${agentId}/mcp-connections/${serverId}/initiate-oauth`, {
        method: "POST",
      });
      const data = await res.json();
      if (data.redirectUrl) {
        const popup = window.open(data.redirectUrl, "mcp-oauth", "width=600,height=700");
        const handler = (event: MessageEvent) => {
          if (event.data?.type === "mcp-oauth-complete") {
            popup?.close();
            window.removeEventListener("message", handler);
            loadMcp();
            setShowAdd(false);
            router.refresh();
          }
        };
        window.addEventListener("message", handler);
      }
    } finally {
      setMcpConnecting(null);
    }
  }

  async function handleMcpDisconnect() {
    if (!confirmMcpDisconnect) return;
    setMcpDisconnecting(true);
    try {
      await fetch(`/api/admin/agents/${agentId}/mcp-connections/${confirmMcpDisconnect.mcp_server_id}`, {
        method: "DELETE",
      });
      setConfirmMcpDisconnect(null);
      await loadMcp();
      router.refresh();
    } finally {
      setMcpDisconnecting(false);
    }
  }

  const connectedMcpServerIds = new Set(mcpConnections.map((c) => c.mcp_server_id));
  const availableMcpServers = mcpServers.filter((s) => !connectedMcpServerIds.has(s.id));

  const isAllLoading = loading || mcpLoading;
  const isEmpty = localToolkits.length === 0 && mcpConnections.length === 0;

  return (
    <>
    {/* Composio remove confirmation */}
    <Dialog open={!!confirmDelete} onOpenChange={(open) => { if (!open) setConfirmDelete(null); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Remove Connector</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground mb-4">
          Remove <span className="font-medium text-foreground">{confirmDelete?.name}</span> from this agent?
        </p>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setConfirmDelete(null)} disabled={deleting}>Cancel</Button>
          <Button size="sm" variant="destructive" onClick={handleConfirmDelete} disabled={deleting}>
            {deleting ? "Removing..." : "Remove"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>

    {/* MCP disconnect confirmation */}
    <Dialog open={!!confirmMcpDisconnect} onOpenChange={(open) => { if (!open) setConfirmMcpDisconnect(null); }}>
      <DialogContent className="max-w-sm">
        <DialogHeader>
          <DialogTitle>Disconnect Custom Connector</DialogTitle>
        </DialogHeader>
        <p className="text-sm text-muted-foreground mb-4">
          Disconnect <span className="font-medium text-foreground">{confirmMcpDisconnect?.server_name}</span> from this agent?
        </p>
        <div className="flex justify-end gap-2">
          <Button size="sm" variant="ghost" onClick={() => setConfirmMcpDisconnect(null)} disabled={mcpDisconnecting}>Cancel</Button>
          <Button size="sm" variant="destructive" onClick={handleMcpDisconnect} disabled={mcpDisconnecting}>
            {mcpDisconnecting ? "Disconnecting..." : "Disconnect"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>

    <Card>
      <CardHeader className="flex flex-row items-center justify-between space-y-0">
        <CardTitle className="text-base">Connectors</CardTitle>
        <Button
          size="sm"
          variant="outline"
          onClick={() => { setPendingToolkits(localToolkits); loadMcpServers(); setShowAdd(true); }}
        >
          Add
        </Button>
      </CardHeader>
      <CardContent>
        {showAdd && (
          <div className="mb-4 space-y-3">
            {/* Composio toolkit picker */}
            <div>
              <p className="text-xs font-medium text-muted-foreground mb-1.5">Composio Toolkits</p>
              <div className="flex items-start gap-2">
                <div className="flex-1">
                  <ToolkitMultiselect value={pendingToolkits} onChange={setPendingToolkits} />
                </div>
                <Button size="sm" onClick={handleApplyAdd} disabled={applyingToolkits}>
                  {applyingToolkits ? "Saving..." : "Apply"}
                </Button>
              </div>
            </div>

            {/* MCP servers picker */}
            <div className="rounded-lg border border-border p-3">
              <p className="text-xs font-medium text-muted-foreground mb-2">Custom Connectors</p>
              {availableMcpServers.length === 0 ? (
                <p className="text-xs text-muted-foreground">
                  {mcpServers.length === 0 ? "No custom connectors registered." : "All servers are already connected."}
                </p>
              ) : (
                <div className="grid grid-cols-4 gap-2">
                  {availableMcpServers.map((s) => (
                    <div key={s.id} className="flex flex-col gap-2 p-2 rounded border border-border">
                      <div className="flex items-center gap-2 min-w-0">
                        {s.logo_url && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={s.logo_url} alt="" className="w-5 h-5 rounded-sm object-contain flex-shrink-0" />
                        )}
                        <span className="text-sm font-medium truncate">{s.name}</span>
                      </div>
                      {s.description && (
                        <p className="text-xs text-muted-foreground truncate">{s.description}</p>
                      )}
                      <Button
                        size="sm"
                        variant="outline"
                        className="h-7 text-xs mt-auto"
                        disabled={mcpConnecting === s.id}
                        onClick={() => handleMcpConnect(s.id)}
                      >
                        {mcpConnecting === s.id ? "Connecting..." : "Connect"}
                      </Button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="flex justify-end">
              <Button size="sm" variant="ghost" onClick={() => setShowAdd(false)}>Close</Button>
            </div>
          </div>
        )}

        {isAllLoading ? (
          <p className="text-sm text-muted-foreground">Loading...</p>
        ) : isEmpty ? (
          <p className="text-sm text-muted-foreground">No connectors added. Click Add to configure connectors.</p>
        ) : (
          <>
          <div className="grid grid-cols-3 gap-3">
            {/* Composio connector cards */}
            {connectors.map((c) => (
              <div key={`composio-${c.slug}`} className="rounded-lg border border-border p-3 flex flex-col gap-2">
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
                    onClick={() => setConfirmDelete({ slug: c.slug, name: c.name })}
                    className="text-muted-foreground hover:text-red-500 flex-shrink-0 ml-1 text-base leading-none"
                    title="Remove connector"
                  >
                    ×
                  </button>
                </div>

                {c.authScheme === "NO_AUTH" ? (
                  <span className="text-xs text-muted-foreground">No auth required</span>
                ) : c.connectionStatus === "ACTIVE" ? (
                  <span className={`text-xs font-medium ${statusColor(c.connectionStatus)}`}>✓ Connected</span>
                ) : c.connectionStatus ? (
                  <span className={`text-xs ${statusColor(c.connectionStatus)}`}>{c.connectionStatus.toLowerCase()}</span>
                ) : null}

                {(() => {
                  const total = toolCounts[c.slug];
                  if (total === undefined) return null;
                  const prefix = c.slug.toUpperCase() + "_";
                  const filtered = allowedTools.filter((t) => t.startsWith(prefix));
                  const hasFilter = filtered.length > 0;
                  return (
                    <button
                      type="button"
                      className="text-xs text-primary hover:underline text-left"
                      onClick={() => setToolsModalToolkit(c.slug)}
                    >
                      {hasFilter ? `${filtered.length} / ${total} tools` : `All tools (${total})`}
                    </button>
                  );
                })()}

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

                {(c.authScheme === "OAUTH2" || c.authScheme === "OAUTH1") && c.connectionStatus !== "ACTIVE" && (
                  <a href={`/api/admin/agents/${agentId}/connectors/${c.slug}`} className="mt-auto">
                    <Button size="sm" variant="outline" className="h-7 text-xs w-full">Connect</Button>
                  </a>
                )}

                {(c.authScheme === "OAUTH2" || c.authScheme === "OAUTH1") && c.connectionStatus === "ACTIVE" && (
                  <a href={`/api/admin/agents/${agentId}/connectors/${c.slug}`} className="mt-auto">
                    <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground w-full">Reconnect</Button>
                  </a>
                )}
              </div>
            ))}

          </div>
          {mcpConnections.length > 0 && (
          <div className="grid grid-cols-4 gap-3 mt-3">
            {mcpConnections.map((c) => (
              <div key={`mcp-${c.id}`} className="rounded-lg border border-border p-3 flex flex-col gap-2">
                <div className="flex items-center gap-2">
                  {c.server_logo_url && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={c.server_logo_url} alt="" className="w-5 h-5 rounded-sm object-contain flex-shrink-0" />
                  )}
                  <span className="text-sm font-medium truncate flex-1">{c.server_name}</span>
                  <Badge variant="outline" className="text-xs flex-shrink-0">
                    OAUTH
                  </Badge>
                  <button
                    type="button"
                    onClick={() => setConfirmMcpDisconnect(c)}
                    className="text-muted-foreground hover:text-red-500 flex-shrink-0 ml-1 text-base leading-none"
                    title="Disconnect"
                  >
                    ×
                  </button>
                </div>

                {c.status === "active" ? (
                  <>
                    <span className="text-xs font-medium text-green-600">✓ Connected</span>
                    {isExpiringSoon(c.token_expires_at) && (
                      <span className="text-xs text-yellow-500">Token expires soon</span>
                    )}
                  </>
                ) : (
                  <span className={`text-xs ${c.status === "expired" || c.status === "failed" ? "text-red-500" : "text-muted-foreground"}`}>
                    {c.status}
                  </span>
                )}

                {c.status === "active" && (
                  <button
                    type="button"
                    className="text-xs text-primary hover:underline text-left"
                    onClick={() => setMcpToolsModal(c)}
                  >
                    {c.allowed_tools.length > 0
                      ? `${c.allowed_tools.length} tools selected`
                      : "All tools (no filter)"}
                  </button>
                )}

                {(c.status === "expired" || c.status === "failed") && (
                  <Button
                    size="sm"
                    variant="outline"
                    className="h-7 text-xs mt-auto"
                    disabled={mcpConnecting === c.mcp_server_id}
                    onClick={() => handleMcpConnect(c.mcp_server_id)}
                  >
                    {mcpConnecting === c.mcp_server_id ? "Reconnecting..." : "Reconnect"}
                  </Button>
                )}
              </div>
            ))}
          </div>
          )}
          </>
        )}
      </CardContent>
    </Card>

    {/* Composio tools modal */}
    {toolsModalToolkit && (
      <ToolsModal
        agentId={agentId}
        toolkit={toolsModalToolkit}
        toolkitLogo={connectors.find((c) => c.slug === toolsModalToolkit)?.logo}
        allowedTools={allowedTools}
        open={!!toolsModalToolkit}
        onOpenChange={(open) => { if (!open) setToolsModalToolkit(null); }}
        onSave={handleToolsSave}
      />
    )}

    {/* MCP tools modal */}
    {mcpToolsModal && (
      <McpToolsModal
        agentId={agentId}
        mcpServerId={mcpToolsModal.mcp_server_id}
        serverName={mcpToolsModal.server_name}
        serverLogo={mcpToolsModal.server_logo_url}
        allowedTools={mcpToolsModal.allowed_tools}
        open={!!mcpToolsModal}
        onOpenChange={(open) => { if (!open) setMcpToolsModal(null); }}
        onSave={async (selectedTools) => {
          await fetch(`/api/admin/agents/${agentId}/mcp-connections/${mcpToolsModal.mcp_server_id}`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ allowed_tools: selectedTools }),
          });
          setMcpToolsModal(null);
          await loadMcp();
        }}
      />
    )}
    </>
  );
}
