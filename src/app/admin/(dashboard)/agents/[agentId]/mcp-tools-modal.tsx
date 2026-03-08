"use client";

import { useCallback, useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogBody, DialogFooter, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface Tool {
  name: string;
  description?: string;
}

interface Props {
  agentId: string;
  mcpServerId: string;
  serverName: string;
  serverLogo: string | null;
  allowedTools: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (selectedTools: string[]) => Promise<void>;
}

export function McpToolsModal({
  agentId,
  mcpServerId,
  serverName,
  serverLogo,
  allowedTools,
  open,
  onOpenChange,
  onSave,
}: Props) {
  const [tools, setTools] = useState<Tool[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const fetchTools = useCallback(async () => {
    setLoading(true);
    setError("");
    try {
      const res = await fetch(`/api/admin/agents/${agentId}/mcp-connections/${mcpServerId}/tools`);
      if (!res.ok) {
        setError("Failed to load tools");
        return;
      }
      const data = await res.json();
      setTools(data.data ?? []);
    } catch {
      setError("Failed to load tools");
    } finally {
      setLoading(false);
    }
  }, [agentId, mcpServerId]);

  useEffect(() => {
    if (open) {
      fetchTools();
      setSearch("");
      setSelected(new Set(allowedTools));
    }
  }, [open, allowedTools, fetchTools]);

  const filtered = tools.filter((t) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return t.name.toLowerCase().includes(q) || (t.description?.toLowerCase().includes(q) ?? false);
  });

  const allSelected = filtered.length > 0 && filtered.every((t) => selected.has(t.name));

  function toggleAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        for (const t of filtered) next.delete(t.name);
      } else {
        for (const t of filtered) next.add(t.name);
      }
      return next;
    });
  }

  function toggle(name: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  async function handleSave() {
    setSaving(true);
    try {
      const selection = selected.size === tools.length ? [] : Array.from(selected);
      await onSave(selection);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            {serverLogo && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={serverLogo} alt="" className="w-5 h-5 rounded-sm object-contain flex-shrink-0" />
            )}
            {serverName} Tools
          </DialogTitle>
          {!loading && !error && (
            <DialogDescription>{tools.length} tools available</DialogDescription>
          )}
        </DialogHeader>

        <DialogBody className="space-y-3">
          <Input
            placeholder="Search tools..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="h-8 text-sm"
          />

          {loading ? (
            <p className="text-sm text-muted-foreground py-4 text-center">Loading tools...</p>
          ) : error ? (
            <p className="text-sm text-destructive py-4 text-center">{error}</p>
          ) : (
            <>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{selected.size === 0 ? "All tools (no filter)" : `${selected.size} / ${tools.length} selected`}</span>
                <button type="button" className="text-primary hover:underline" onClick={toggleAll}>
                  {allSelected ? "Deselect All" : "Select All"}
                </button>
              </div>
              <div className="max-h-72 overflow-y-auto border border-border rounded-lg divide-y divide-border">
                {filtered.map((t) => (
                  <label
                    key={t.name}
                    className="flex items-start gap-2.5 px-3 py-2.5 hover:bg-muted/50 cursor-pointer transition-colors"
                  >
                    <input
                      type="checkbox"
                      checked={selected.has(t.name)}
                      onChange={() => toggle(t.name)}
                      className="mt-0.5"
                    />
                    <div className="min-w-0">
                      <div className="text-sm font-medium truncate">{t.name}</div>
                      {t.description && (
                        <div className="text-xs text-muted-foreground line-clamp-1">{t.description}</div>
                      )}
                    </div>
                  </label>
                ))}
                {filtered.length === 0 && (
                  <p className="text-sm text-muted-foreground py-4 text-center">No tools match your search</p>
                )}
              </div>
            </>
          )}
        </DialogBody>

        <DialogFooter>
          <Button size="sm" variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button size="sm" onClick={handleSave} disabled={saving || loading}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
