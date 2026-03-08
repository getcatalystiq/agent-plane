"use client";

import { useState, useEffect, useRef, useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogBody, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { SectionHeader } from "@/components/ui/section-header";

interface AgentPlugin {
  marketplace_id: string;
  plugin_name: string;
}

interface Marketplace {
  id: string;
  name: string;
  github_repo: string;
}

interface AvailablePlugin {
  name: string;
  displayName: string;
  description: string | null;
  version: string | null;
  hasSkills: boolean;
  hasCommands: boolean;
  hasMcpJson: boolean;
}

export function PluginsManager({
  agentId,
  initialPlugins,
}: {
  agentId: string;
  initialPlugins: AgentPlugin[];
}) {
  const router = useRouter();
  const [plugins, setPlugins] = useState<AgentPlugin[]>(initialPlugins);
  const [saving, setSaving] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [marketplaces, setMarketplaces] = useState<Marketplace[]>([]);
  const [selectedMarketplace, setSelectedMarketplace] = useState<string | null>(null);
  const [availablePlugins, setAvailablePlugins] = useState<AvailablePlugin[]>([]);
  const [loadingPlugins, setLoadingPlugins] = useState(false);
  const [marketplaceNames, setMarketplaceNames] = useState<Record<string, string>>({});
  const savedSnapshot = useRef(JSON.stringify(initialPlugins));

  useEffect(() => {
    savedSnapshot.current = JSON.stringify(initialPlugins);
    setPlugins(initialPlugins);
  }, [initialPlugins]);

  const isDirty = useMemo(
    () => JSON.stringify(plugins) !== savedSnapshot.current,
    [plugins],
  );

  // Fetch marketplaces on mount for name display
  useEffect(() => {
    fetch("/api/admin/plugin-marketplaces")
      .then((r) => r.json())
      .then((data) => {
        const list: Marketplace[] = data.data ?? [];
        setMarketplaces(list);
        const names: Record<string, string> = {};
        for (const m of list) names[m.id] = m.name;
        setMarketplaceNames(names);
      })
      .catch(() => {});
  }, []);

  const loadPluginsForMarketplace = useCallback(async (marketplaceId: string) => {
    setSelectedMarketplace(marketplaceId);
    setLoadingPlugins(true);
    setAvailablePlugins([]);
    try {
      const res = await fetch(`/api/admin/plugin-marketplaces/${marketplaceId}/plugins`);
      if (res.ok) {
        const data = await res.json();
        setAvailablePlugins(data.data ?? []);
      }
    } catch { /* ignore */ } finally {
      setLoadingPlugins(false);
    }
  }, []);

  function isPluginEnabled(marketplaceId: string, pluginName: string): boolean {
    return plugins.some(
      (p) => p.marketplace_id === marketplaceId && p.plugin_name === pluginName,
    );
  }

  function togglePlugin(marketplaceId: string, pluginName: string) {
    if (isPluginEnabled(marketplaceId, pluginName)) {
      setPlugins((prev) =>
        prev.filter(
          (p) => !(p.marketplace_id === marketplaceId && p.plugin_name === pluginName),
        ),
      );
    } else {
      setPlugins((prev) => [
        ...prev,
        { marketplace_id: marketplaceId, plugin_name: pluginName },
      ]);
    }
  }

  function removePlugin(index: number) {
    setPlugins((prev) => prev.filter((_, i) => i !== index));
  }

  async function handleSave() {
    setSaving(true);
    try {
      await fetch(`/api/admin/agents/${agentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ plugins }),
      });
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div>
      <SectionHeader title="Plugins">
        <div className="flex items-center gap-3">
          {isDirty && <Badge variant="destructive" className="text-xs">Unsaved changes</Badge>}
          <div className="flex gap-2">
            <Button variant="outline" size="sm" onClick={() => setDialogOpen(true)}>
              Add Plugins
            </Button>
            <Button onClick={handleSave} disabled={saving || !isDirty} size="sm">
              {saving ? "Saving..." : "Save Plugins"}
            </Button>
          </div>
        </div>
      </SectionHeader>
      <div>
        {plugins.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No plugins enabled. Click &quot;Add Plugins&quot; to browse available plugins.
          </p>
        ) : (
          <div className="space-y-2">
            {plugins.map((p, i) => (
              <div
                key={`${p.marketplace_id}:${p.plugin_name}`}
                className="flex items-center justify-between rounded-md border border-border px-3 py-2"
              >
                <div>
                  <span className="text-sm font-medium">{p.plugin_name}</span>
                  <span className="text-xs text-muted-foreground ml-2">
                    from {marketplaceNames[p.marketplace_id] ?? p.marketplace_id.slice(0, 8)}
                  </span>
                </div>
                <Button
                  variant="ghost"
                  size="sm"
                  className="text-xs text-muted-foreground hover:text-destructive"
                  onClick={() => removePlugin(i)}
                >
                  Remove
                </Button>
              </div>
            ))}
          </div>
        )}

        {/* Add plugins dialog */}
        <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
          <DialogContent className="max-w-lg max-h-[80vh] flex flex-col">
            <DialogHeader>
              <DialogTitle>Add Plugins</DialogTitle>
            </DialogHeader>

            <DialogBody className="flex-1 overflow-hidden flex flex-col gap-3">
              {marketplaces.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  No plugin marketplaces registered. Add one from the Plugin Marketplaces page first.
                </p>
              ) : (
                <>
                  <div className="flex gap-2 flex-wrap">
                    {marketplaces.map((m) => (
                      <Button
                        key={m.id}
                        size="sm"
                        variant={selectedMarketplace === m.id ? "default" : "outline"}
                        onClick={() => loadPluginsForMarketplace(m.id)}
                      >
                        {m.name}
                      </Button>
                    ))}
                  </div>

                  {selectedMarketplace && (
                    <div className="overflow-y-auto border border-border rounded-lg divide-y divide-border">
                      {loadingPlugins ? (
                        <p className="p-4 text-sm text-muted-foreground text-center">Loading plugins...</p>
                      ) : availablePlugins.length === 0 ? (
                        <p className="p-4 text-sm text-muted-foreground text-center">No plugins found in this marketplace.</p>
                      ) : (
                        availablePlugins.map((ap) => {
                          const enabled = isPluginEnabled(selectedMarketplace, ap.name);
                          return (
                            <div
                              key={ap.name}
                              className="flex items-center justify-between px-3 py-2.5 hover:bg-muted/30 cursor-pointer transition-colors"
                              onClick={() => togglePlugin(selectedMarketplace, ap.name)}
                            >
                              <div className="min-w-0">
                                <div className="flex items-center gap-2">
                                  <span className="text-sm font-medium">{ap.displayName}</span>
                                  {ap.version && (
                                    <span className="text-xs text-muted-foreground">v{ap.version}</span>
                                  )}
                                </div>
                                {ap.description && (
                                  <p className="text-xs text-muted-foreground truncate">{ap.description}</p>
                                )}
                                <div className="flex gap-1 mt-1">
                                  {ap.hasSkills && <Badge variant="secondary" className="text-[10px] px-1 py-0">Skills</Badge>}
                                  {ap.hasCommands && <Badge variant="secondary" className="text-[10px] px-1 py-0">Commands</Badge>}
                                  {ap.hasMcpJson && <Badge variant="secondary" className="text-[10px] px-1 py-0">MCP</Badge>}
                                </div>
                              </div>
                              <div className={`w-4 h-4 rounded border flex items-center justify-center shrink-0 ${
                                enabled
                                  ? "bg-primary border-primary text-primary-foreground"
                                  : "border-muted-foreground"
                              }`}>
                                {enabled && <span className="text-xs">&#10003;</span>}
                              </div>
                            </div>
                          );
                        })
                      )}
                    </div>
                  )}
                </>
              )}
            </DialogBody>

            <DialogFooter>
              <Button size="sm" onClick={() => setDialogOpen(false)}>Done</Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </div>
    </div>
  );
}
