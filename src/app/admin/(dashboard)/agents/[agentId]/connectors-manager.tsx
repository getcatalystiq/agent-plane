"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { ToolkitMultiselect } from "@/components/toolkit-multiselect";
import { SectionHeader } from "@/components/ui/section-header";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { FormError } from "@/components/ui/form-error";
import { ToolsModal } from "./tools-modal";
import { McpToolsModal } from "./mcp-tools-modal";
import type { AuthMethod, AuthScheme, ConnectorStatus } from "@/lib/composio";
import { adminFetch } from "@/app/admin/lib/api";

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

interface PluginSuggestion {
  connector_name: string;
  composio_slug: string;
  suggested_by_plugin: string;
}

interface Props {
  agentId: string;
  toolkits: string[];
  composioAllowedTools: string[];
  hasPlugins?: boolean;
}

const METHOD_LABELS: Record<AuthMethod, string> = {
  composio_oauth: "Composio OAuth",
  byoa_oauth: "Bring your own app",
  custom_token: "Custom token",
};

const METHOD_DESCRIPTIONS: Record<AuthMethod, string> = {
  composio_oauth: "Use AgentPlane's app credentials. Fastest setup.",
  byoa_oauth: "Use your own OAuth app. Required for actor=app flows like Linear.",
  custom_token: "Paste a long-lived bot or integration token (Slack xoxb-, Notion secret_…).",
};

function statusColor(status: string | null) {
  if (status === "ACTIVE") return "text-green-500";
  if (status === "INITIATED") return "text-yellow-500";
  if (status === "FAILED" || status === "EXPIRED" || status === "INACTIVE") return "text-destructive";
  return "text-muted-foreground";
}

/** Map a connector's available_schemes to the methods we render in the picker. */
function supportedMethodsFor(schemes: AuthScheme[]): AuthMethod[] {
  const out: AuthMethod[] = [];
  if (schemes.includes("OAUTH2") || schemes.includes("OAUTH1")) {
    out.push("composio_oauth");
  }
  if (schemes.includes("OAUTH2")) {
    out.push("byoa_oauth");
  }
  if (schemes.includes("API_KEY") || schemes.includes("BEARER_TOKEN")) {
    out.push("custom_token");
  }
  return out;
}

function defaultMethodFor(schemes: AuthScheme[]): AuthMethod | null {
  const supported = supportedMethodsFor(schemes);
  if (supported.includes("composio_oauth")) return "composio_oauth";
  if (supported.includes("custom_token")) return "custom_token";
  return supported[0] ?? null;
}

function customTokenSchemeFor(schemes: AuthScheme[]): "API_KEY" | "BEARER_TOKEN" {
  return schemes.includes("BEARER_TOKEN") ? "BEARER_TOKEN" : "API_KEY";
}

export function ConnectorsManager({ agentId, toolkits: initialToolkits, composioAllowedTools: initialAllowedTools, hasPlugins }: Props) {
  const router = useRouter();

  const [localToolkits, setLocalToolkits] = useState<string[]>(initialToolkits);
  const [connectors, setConnectors] = useState<ConnectorStatus[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [pendingToolkits, setPendingToolkits] = useState<string[]>(initialToolkits);
  const [applyingToolkits, setApplyingToolkits] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<{ slug: string; name: string } | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [allowedTools, setAllowedTools] = useState<string[]>(initialAllowedTools);
  const [toolCounts, setToolCounts] = useState<Record<string, number>>({});
  const [toolsModalToolkit, setToolsModalToolkit] = useState<string | null>(null);

  // Per-toolkit picker + credential drafts. Drafts never enter any logger sink.
  const [pickedMethod, setPickedMethod] = useState<Record<string, AuthMethod>>({});
  const [tokens, setTokens] = useState<Record<string, string>>({});
  const [clientIds, setClientIds] = useState<Record<string, string>>({});
  const [clientSecrets, setClientSecrets] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState<Record<string, boolean>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [byoaPopupOpen, setByoaPopupOpen] = useState<Record<string, boolean>>({});
  const [recapturing, setRecapturing] = useState<Record<string, boolean>>({});
  const [confirmSwitch, setConfirmSwitch] = useState<{
    slug: string;
    name: string;
    fromMethod: AuthMethod;
    toMethod: AuthMethod;
  } | null>(null);

  const [mcpConnections, setMcpConnections] = useState<McpConnection[]>([]);
  const [mcpServers, setMcpServers] = useState<McpServer[]>([]);
  const [mcpLoading, setMcpLoading] = useState(true);
  const [mcpConnecting, setMcpConnecting] = useState<string | null>(null);
  const [confirmMcpDisconnect, setConfirmMcpDisconnect] = useState<McpConnection | null>(null);
  const [mcpDisconnecting, setMcpDisconnecting] = useState(false);
  const [mcpToolsModal, setMcpToolsModal] = useState<McpConnection | null>(null);

  const [pluginSuggestions, setPluginSuggestions] = useState<PluginSuggestion[]>([]);

  const loadComposio = useCallback(async () => {
    setLoading(true);
    try {
      const data = await adminFetch<{ connectors: ConnectorStatus[] }>(`/agents/${agentId}/connectors`);
      setConnectors(data.connectors ?? []);
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  const loadMcp = useCallback(async () => {
    setMcpLoading(true);
    try {
      const data = await adminFetch<{ data: McpConnection[] }>(`/agents/${agentId}/mcp-connections`);
      setMcpConnections(data.data ?? []);
    } finally {
      setMcpLoading(false);
    }
  }, [agentId]);

  const toolkitsKey = localToolkits.join(",");
  useEffect(() => { loadComposio(); }, [loadComposio, toolkitsKey]);
  useEffect(() => { loadMcp(); }, [loadMcp]);

  useEffect(() => {
    if (!hasPlugins) return;
    adminFetch<{ data: PluginSuggestion[] }>(`/agents/${agentId}/plugin-suggestions`)
      .then((data) => setPluginSuggestions(data.data ?? []))
      .catch(() => {});
  }, [agentId, hasPlugins]);

  useEffect(() => {
    if (localToolkits.length === 0) return;
    for (const slug of localToolkits) {
      if (toolCounts[slug] !== undefined) continue;
      adminFetch<{ data: unknown[] }>(`/composio/tools?toolkit=${encodeURIComponent(slug)}`)
        .then((data) => setToolCounts((prev) => ({ ...prev, [slug]: (data.data ?? []).length })))
        .catch(() => {});
    }
  }, [toolkitsKey]); // eslint-disable-line react-hooks/exhaustive-deps

  async function loadMcpServers() {
    const data = await adminFetch<{ data: McpServer[] }>("/mcp-servers");
    setMcpServers(data.data ?? []);
  }

  async function handleToolsSave(toolkit: string, selectedSlugs: string[]) {
    const prefix = toolkit.toUpperCase() + "_";
    const otherTools = allowedTools.filter((t) => !t.startsWith(prefix));
    const updated = [...otherTools, ...selectedSlugs];
    await adminFetch(`/agents/${agentId}`, {
      method: "PATCH",
      body: JSON.stringify({ composio_allowed_tools: updated }),
    });
    setAllowedTools(updated);
    setToolsModalToolkit(null);
    router.refresh();
  }

  async function patchToolkits(newToolkits: string[]) {
    await adminFetch(`/agents/${agentId}`, {
      method: "PATCH",
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

  /** Picker change. If switching from an active method, gate behind a confirm dialog. */
  function handlePickerChange(c: ConnectorStatus, next: AuthMethod) {
    const active = c.connectionStatus === "ACTIVE";
    const current = c.selectedMethod;
    if (active && current && current !== next) {
      setConfirmSwitch({ slug: c.slug, name: c.name, fromMethod: current, toMethod: next });
      return;
    }
    setPickedMethod((prev) => ({ ...prev, [c.slug]: next }));
  }

  function confirmSwitchAccept() {
    if (!confirmSwitch) return;
    setPickedMethod((prev) => ({ ...prev, [confirmSwitch.slug]: confirmSwitch.toMethod }));
    setTokens((prev) => ({ ...prev, [confirmSwitch.slug]: "" }));
    setClientIds((prev) => ({ ...prev, [confirmSwitch.slug]: "" }));
    setClientSecrets((prev) => ({ ...prev, [confirmSwitch.slug]: "" }));
    setErrors((prev) => ({ ...prev, [confirmSwitch.slug]: "" }));
    setConfirmSwitch(null);
  }

  async function handleSaveToken(slug: string, scheme: "API_KEY" | "BEARER_TOKEN") {
    const token = tokens[slug];
    if (!token) return;
    setSaving((s) => ({ ...s, [slug]: true }));
    setErrors((e) => ({ ...e, [slug]: "" }));
    try {
      await adminFetch(`/agents/${agentId}/connectors`, {
        method: "POST",
        body: JSON.stringify({ toolkit: slug, auth_method: "custom_token", scheme, token }),
      });
      setTokens((t) => ({ ...t, [slug]: "" }));
      await loadComposio();
      router.refresh();
    } catch (err) {
      setErrors((e) => ({ ...e, [slug]: err instanceof Error ? err.message : "Unknown error" }));
    } finally {
      setSaving((s) => ({ ...s, [slug]: false }));
    }
  }

  async function handleInitiateByoa(slug: string) {
    const clientId = clientIds[slug];
    const clientSecret = clientSecrets[slug];
    if (!clientId || !clientSecret) return;
    setSaving((s) => ({ ...s, [slug]: true }));
    setErrors((e) => ({ ...e, [slug]: "" }));
    try {
      const data = await adminFetch<{ redirect_url?: string }>(
        `/agents/${agentId}/connectors/${slug}/byoa`,
        {
          method: "POST",
          body: JSON.stringify({ client_id: clientId, client_secret: clientSecret }),
        },
      );
      if (data.redirect_url) {
        setByoaPopupOpen((p) => ({ ...p, [slug]: true }));
        const popup = window.open(data.redirect_url, "byoa-oauth", "width=600,height=700");
        const handler = (event: MessageEvent) => {
          if (event.data?.type === "agent_plane_oauth_callback" && event.data.toolkit === slug) {
            popup?.close();
            window.removeEventListener("message", handler);
            setByoaPopupOpen((p) => ({ ...p, [slug]: false }));
            setClientIds((c) => ({ ...c, [slug]: "" }));
            setClientSecrets((c) => ({ ...c, [slug]: "" }));
            loadComposio();
            router.refresh();
          }
        };
        window.addEventListener("message", handler);
        const closeWatch = setInterval(() => {
          if (popup?.closed) {
            clearInterval(closeWatch);
            window.removeEventListener("message", handler);
            setByoaPopupOpen((p) => ({ ...p, [slug]: false }));
          }
        }, 500);
      }
    } catch (err) {
      setErrors((e) => ({ ...e, [slug]: err instanceof Error ? err.message : "Unknown error" }));
      setByoaPopupOpen((p) => ({ ...p, [slug]: false }));
    } finally {
      setSaving((s) => ({ ...s, [slug]: false }));
    }
  }

  async function handleRecapture(slug: string) {
    setRecapturing((r) => ({ ...r, [slug]: true }));
    try {
      await adminFetch(`/agents/${agentId}/connectors/${slug}/recapture`, { method: "POST" });
      await loadComposio();
    } catch {
      // best-effort
    } finally {
      setRecapturing((r) => ({ ...r, [slug]: false }));
    }
  }

  async function handleMcpConnect(serverId: string) {
    setMcpConnecting(serverId);
    try {
      const data = await adminFetch<{ redirectUrl?: string }>(`/agents/${agentId}/mcp-connections/${serverId}/initiate-oauth`, {
        method: "POST",
      });
      if (data.redirectUrl) {
        const popup = window.open(data.redirectUrl, "mcp-oauth", "width=600,height=700");
        const handler = (event: MessageEvent) => {
          if (event.data?.type === "agent_plane_mcp_oauth_callback") {
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
      await adminFetch(`/agents/${agentId}/mcp-connections/${confirmMcpDisconnect.mcp_server_id}`, {
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
      <ConfirmDialog
        open={!!confirmDelete}
        onOpenChange={(open) => { if (!open) setConfirmDelete(null); }}
        title="Remove Connector"
        confirmLabel="Remove"
        loadingLabel="Removing..."
        loading={deleting}
        onConfirm={handleConfirmDelete}
      >
        Remove <span className="font-medium text-foreground">{confirmDelete?.name}</span> from this agent?
      </ConfirmDialog>

      <ConfirmDialog
        open={!!confirmMcpDisconnect}
        onOpenChange={(open) => { if (!open) setConfirmMcpDisconnect(null); }}
        title="Disconnect Connector"
        confirmLabel="Disconnect"
        loadingLabel="Disconnecting..."
        loading={mcpDisconnecting}
        onConfirm={handleMcpDisconnect}
      >
        Disconnect <span className="font-medium text-foreground">{confirmMcpDisconnect?.server_name}</span> from this agent?
      </ConfirmDialog>

      <ConfirmDialog
        open={!!confirmSwitch}
        onOpenChange={(open) => { if (!open) setConfirmSwitch(null); }}
        title="Replace active connection?"
        confirmLabel="Replace"
        loadingLabel="..."
        onConfirm={confirmSwitchAccept}
      >
        Switching <span className="font-medium text-foreground">{confirmSwitch?.name}</span>{" "}
        from <span className="font-medium text-foreground">{confirmSwitch ? METHOD_LABELS[confirmSwitch.fromMethod] : ""}</span>{" "}
        to <span className="font-medium text-foreground">{confirmSwitch ? METHOD_LABELS[confirmSwitch.toMethod] : ""}</span>{" "}
        will sign out the agent and require re-authorizing the new credentials.
      </ConfirmDialog>

      <div className="rounded-lg border border-muted-foreground/25 p-5">
        <SectionHeader title="Connectors">
          <Button
            size="sm"
            variant="outline"
            onClick={() => { setPendingToolkits(localToolkits); loadMcpServers(); setShowAdd(true); }}
          >
            Add
          </Button>
        </SectionHeader>
        <div>
          {showAdd && (
            <div className="mb-4 space-y-3">
              <ToolkitMultiselect value={pendingToolkits} onChange={setPendingToolkits} />

              {availableMcpServers.length > 0 && (
                <div className="grid grid-cols-4 gap-2">
                  {availableMcpServers.map((s) => (
                    <div key={s.id} className="flex flex-col gap-2 p-2 rounded border border-border">
                      <div className="flex items-center gap-2 min-w-0">
                        {s.logo_url && (
                          // eslint-disable-next-line @next/next/no-img-element
                          <img src={s.logo_url} alt="" className="w-5 h-5 rounded-sm object-contain flex-shrink-0" />
                        )}
                        <span className="text-sm font-medium truncate">{s.name}</span>
                        <Badge variant="outline" className="text-xs flex-shrink-0 ml-auto">{s.slug}</Badge>
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

              <div className="flex justify-end gap-2">
                <Button size="sm" variant="ghost" onClick={() => setShowAdd(false)}>Cancel</Button>
                <Button size="sm" onClick={handleApplyAdd} disabled={applyingToolkits}>
                  {applyingToolkits ? "Saving..." : "Apply"}
                </Button>
              </div>
            </div>
          )}

          {isAllLoading ? (
            <p className="text-sm text-muted-foreground">Loading...</p>
          ) : isEmpty ? (
            <p className="text-sm text-muted-foreground">No connectors added. Click Add to configure connectors.</p>
          ) : (
            <div className="grid grid-cols-3 gap-3">
              {connectors.map((c) => (
                <ComposioConnectorCard
                  key={`composio-${c.slug}`}
                  connector={c}
                  agentId={agentId}
                  toolCounts={toolCounts}
                  allowedTools={allowedTools}
                  pickedMethod={pickedMethod[c.slug]}
                  onPickerChange={(m) => handlePickerChange(c, m)}
                  tokens={tokens}
                  setTokens={setTokens}
                  clientIds={clientIds}
                  setClientIds={setClientIds}
                  clientSecrets={clientSecrets}
                  setClientSecrets={setClientSecrets}
                  saving={!!saving[c.slug]}
                  error={errors[c.slug]}
                  byoaPopupOpen={!!byoaPopupOpen[c.slug]}
                  recapturing={!!recapturing[c.slug]}
                  onSaveToken={handleSaveToken}
                  onInitiateByoa={handleInitiateByoa}
                  onRecapture={handleRecapture}
                  onRemove={() => setConfirmDelete({ slug: c.slug, name: c.name })}
                  onShowTools={() => setToolsModalToolkit(c.slug)}
                />
              ))}

              {mcpConnections.map((c) => (
                <div key={`mcp-${c.id}`} className="rounded-lg border border-border p-3 flex flex-col gap-2">
                  <div className="flex items-center gap-2">
                    {c.server_logo_url && (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img src={c.server_logo_url} alt="" className="w-5 h-5 rounded-sm object-contain flex-shrink-0" />
                    )}
                    <span className="text-sm font-medium truncate flex-1">{c.server_name}</span>
                    <Badge variant="outline" className="text-xs flex-shrink-0">{c.server_slug}</Badge>
                    <button
                      type="button"
                      onClick={() => setConfirmMcpDisconnect(c)}
                      className="text-muted-foreground hover:text-destructive flex-shrink-0 ml-1 text-base leading-none"
                      title="Disconnect"
                    >
                      ×
                    </button>
                  </div>

                  {c.status === "active" ? (
                    <span className="text-xs font-medium text-green-500">✓ Connected</span>
                  ) : (
                    <span className={`text-xs ${c.status === "expired" || c.status === "failed" ? "text-destructive" : "text-muted-foreground"}`}>
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
                      variant="ghost"
                      className="h-7 text-xs text-muted-foreground mt-auto"
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

          {pluginSuggestions.length > 0 && (
            <div className="mt-4 rounded-md border border-dashed border-border p-3">
              <p className="text-xs font-medium text-muted-foreground mb-2">Suggested by plugins</p>
              <div className="flex flex-wrap gap-2">
                {pluginSuggestions.map((s) => (
                  <div
                    key={`${s.composio_slug}-${s.suggested_by_plugin}`}
                    className="flex items-center gap-1.5 rounded-md border border-border px-2 py-1"
                  >
                    <span className="text-xs font-medium">{s.connector_name}</span>
                    <span className="text-[10px] text-muted-foreground">via {s.suggested_by_plugin}</span>
                  </div>
                ))}
              </div>
              <p className="text-[10px] text-muted-foreground mt-1.5">
                These connectors are recommended by enabled plugins. Add them above to unlock plugin features.
              </p>
            </div>
          )}
        </div>
      </div>

      {toolsModalToolkit && (
        <ToolsModal
          toolkit={toolsModalToolkit}
          toolkitLogo={connectors.find((c) => c.slug === toolsModalToolkit)?.logo}
          allowedTools={allowedTools}
          open={!!toolsModalToolkit}
          onOpenChange={(open) => { if (!open) setToolsModalToolkit(null); }}
          onSave={handleToolsSave}
        />
      )}

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
            await adminFetch(`/agents/${agentId}/mcp-connections/${mcpToolsModal.mcp_server_id}`, {
              method: "PATCH",
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

// ─── Composio connector card ──────────────────────────────────────────────────

interface CardProps {
  connector: ConnectorStatus;
  agentId: string;
  toolCounts: Record<string, number>;
  allowedTools: string[];
  pickedMethod: AuthMethod | undefined;
  onPickerChange: (method: AuthMethod) => void;
  tokens: Record<string, string>;
  setTokens: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  clientIds: Record<string, string>;
  setClientIds: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  clientSecrets: Record<string, string>;
  setClientSecrets: React.Dispatch<React.SetStateAction<Record<string, string>>>;
  saving: boolean;
  error: string | undefined;
  byoaPopupOpen: boolean;
  recapturing: boolean;
  onSaveToken: (slug: string, scheme: "API_KEY" | "BEARER_TOKEN") => void;
  onInitiateByoa: (slug: string) => void;
  onRecapture: (slug: string) => void;
  onRemove: () => void;
  onShowTools: () => void;
}

function ComposioConnectorCard(props: CardProps) {
  const c = props.connector;
  const supportedMethods = useMemo(() => supportedMethodsFor(c.availableSchemes), [c.availableSchemes]);
  const activeMethod: AuthMethod | null = useMemo(() => {
    if (props.pickedMethod) return props.pickedMethod;
    if (c.selectedMethod) return c.selectedMethod;
    return defaultMethodFor(c.availableSchemes);
  }, [props.pickedMethod, c.selectedMethod, c.availableSchemes]);

  const isNoAuth = c.availableSchemes.includes("NO_AUTH");
  const isActive = c.connectionStatus === "ACTIVE";

  return (
    <div className="rounded-lg border border-border p-3 flex flex-col gap-2">
      <div className="flex items-center gap-2">
        {c.logo && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={c.logo} alt="" className="w-5 h-5 rounded-sm object-contain flex-shrink-0" />
        )}
        <span className="text-sm font-medium truncate flex-1">{c.name}</span>
        <Badge variant="outline" className="text-xs flex-shrink-0">
          {activeMethod ? METHOD_LABELS[activeMethod] : c.primaryScheme}
        </Badge>
        <button
          type="button"
          onClick={props.onRemove}
          className="text-muted-foreground hover:text-destructive flex-shrink-0 ml-1 text-base leading-none"
          title="Remove connector"
        >
          ×
        </button>
      </div>

      {isNoAuth ? (
        <span className="text-xs text-muted-foreground">No auth required</span>
      ) : isActive ? (
        <div className="text-xs">
          <span className="font-medium text-green-500">✓ Connected</span>
          {c.displayName && (
            <span className="text-muted-foreground">{" "}as {c.displayName}{c.botUserId ? ` (${c.botUserId})` : ""}</span>
          )}
          {!c.displayName && c.botUserId && (
            <span className="text-muted-foreground">{" "}as {c.botUserId}</span>
          )}
        </div>
      ) : c.connectionStatus ? (
        <span className={`text-xs ${statusColor(c.connectionStatus)}`}>{c.connectionStatus.toLowerCase()}</span>
      ) : null}

      {isActive && (c.captureDeferred || (!c.botUserId && c.selectedMethod)) && (
        <button
          type="button"
          className="text-xs text-primary hover:underline text-left"
          disabled={props.recapturing}
          onClick={() => props.onRecapture(c.slug)}
        >
          {props.recapturing ? "Capturing identity..." : "Re-capture identity"}
        </button>
      )}

      {(() => {
        const total = props.toolCounts[c.slug];
        if (total === undefined) return null;
        const prefix = c.slug.toUpperCase() + "_";
        const filtered = props.allowedTools.filter((t) => t.startsWith(prefix));
        const hasFilter = filtered.length > 0;
        return (
          <button
            type="button"
            className="text-xs text-primary hover:underline text-left"
            onClick={props.onShowTools}
          >
            {hasFilter ? `${filtered.length} / ${total} tools` : `All tools (${total})`}
          </button>
        );
      })()}

      {!isNoAuth && supportedMethods.length > 1 && activeMethod && (
        <div className="flex flex-col gap-1">
          <select
            value={activeMethod}
            onChange={(e) => props.onPickerChange(e.target.value as AuthMethod)}
            className="h-7 text-xs border border-border bg-background rounded px-1"
            disabled={props.saving || props.byoaPopupOpen}
          >
            {supportedMethods.map((m) => (
              <option key={m} value={m}>{METHOD_LABELS[m]}</option>
            ))}
          </select>
          <p className="text-[10px] text-muted-foreground">{METHOD_DESCRIPTIONS[activeMethod]}</p>
        </div>
      )}

      {!isNoAuth && activeMethod === "composio_oauth" && !isActive && (
        <a href={`/api/admin/agents/${props.agentId}/connectors/${c.slug}`} className="mt-auto">
          <Button size="sm" variant="outline" className="h-7 text-xs w-full">Connect</Button>
        </a>
      )}
      {!isNoAuth && activeMethod === "composio_oauth" && isActive && c.selectedMethod === "composio_oauth" && (
        <a href={`/api/admin/agents/${props.agentId}/connectors/${c.slug}`} className="mt-auto">
          <Button size="sm" variant="ghost" className="h-7 text-xs text-muted-foreground w-full">Reconnect</Button>
        </a>
      )}

      {!isNoAuth && activeMethod === "byoa_oauth" && (
        <div className="flex flex-col gap-1 mt-auto">
          <Input
            type="password"
            placeholder="Client ID"
            value={props.clientIds[c.slug] ?? ""}
            onChange={(e) => props.setClientIds((p) => ({ ...p, [c.slug]: e.target.value }))}
            className="h-7 text-xs"
            disabled={props.saving || props.byoaPopupOpen}
          />
          <Input
            type="password"
            placeholder="Client Secret"
            value={props.clientSecrets[c.slug] ?? ""}
            onChange={(e) => props.setClientSecrets((p) => ({ ...p, [c.slug]: e.target.value }))}
            className="h-7 text-xs"
            disabled={props.saving || props.byoaPopupOpen}
          />
          <Button
            size="sm"
            variant="outline"
            className="h-7 text-xs"
            disabled={!props.clientIds[c.slug] || !props.clientSecrets[c.slug] || props.saving || props.byoaPopupOpen}
            onClick={() => props.onInitiateByoa(c.slug)}
          >
            {props.byoaPopupOpen ? "Waiting for OAuth..." : props.saving ? "Starting..." : isActive ? "Reconnect with my app" : "Connect"}
          </Button>
          <FormError error={props.error} />
        </div>
      )}

      {!isNoAuth && activeMethod === "custom_token" && (
        <div className="flex flex-col gap-1 mt-auto">
          <div className="flex items-center gap-2">
            <Input
              type="password"
              placeholder={isActive ? "Update token…" : "Paste token (e.g. xoxb-…, secret_…)"}
              value={props.tokens[c.slug] ?? ""}
              onChange={(e) => props.setTokens((t) => ({ ...t, [c.slug]: e.target.value }))}
              className="h-7 text-xs flex-1 min-w-0"
              disabled={props.saving}
            />
            <Button
              size="sm"
              variant="outline"
              className="h-7 text-xs flex-shrink-0"
              disabled={!props.tokens[c.slug] || props.saving}
              onClick={() => props.onSaveToken(c.slug, customTokenSchemeFor(c.availableSchemes))}
            >
              {props.saving ? "Saving…" : "Save"}
            </Button>
          </div>
          <FormError error={props.error} />
        </div>
      )}
    </div>
  );
}
