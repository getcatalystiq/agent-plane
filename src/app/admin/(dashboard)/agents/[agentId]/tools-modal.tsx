"use client";

import { useCallback, useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";

interface Tool {
  slug: string;
  name: string;
  description: string;
}

interface Props {
  agentId: string;
  toolkit: string;
  toolkitLogo?: string;
  allowedTools: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (toolkit: string, selectedSlugs: string[]) => void;
}

export function ToolsModal({ agentId: _agentId, toolkit, toolkitLogo, allowedTools, open, onOpenChange, onSave }: Props) {
  const [tools, setTools] = useState<Tool[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  const fetchTools = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/composio/tools?toolkit=${encodeURIComponent(toolkit)}`);
      const data = await res.json();
      setTools(data.data ?? []);
    } finally {
      setLoading(false);
    }
  }, [toolkit]);

  useEffect(() => {
    if (open) {
      fetchTools();
      setSearch("");
      // Initialize selection from current allowed tools for this toolkit
      const toolkitPrefix = toolkit.toUpperCase() + "_";
      const relevant = allowedTools.filter((t) => t.startsWith(toolkitPrefix));
      setSelected(new Set(relevant));
    }
  }, [open, toolkit, allowedTools, fetchTools]);

  const filtered = tools.filter((t) => {
    if (!search) return true;
    const q = search.toLowerCase();
    return t.name.toLowerCase().includes(q) || t.slug.toLowerCase().includes(q);
  });

  const allSelected = filtered.length > 0 && filtered.every((t) => selected.has(t.slug));

  function toggleAll() {
    setSelected((prev) => {
      const next = new Set(prev);
      if (allSelected) {
        for (const t of filtered) next.delete(t.slug);
      } else {
        for (const t of filtered) next.add(t.slug);
      }
      return next;
    });
  }

  function toggle(slug: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(slug)) next.delete(slug);
      else next.add(slug);
      return next;
    });
  }

  async function handleSave() {
    setSaving(true);
    try {
      // If all tools are selected, pass empty array (= no filtering)
      const selection = selected.size === tools.length ? [] : Array.from(selected);
      onSave(toolkit, selection);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle className="capitalize flex items-center gap-2">
            {toolkitLogo && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={toolkitLogo} alt="" className="w-5 h-5 rounded-sm object-contain flex-shrink-0" />
            )}
            {toolkit} Tools
          </DialogTitle>
          {!loading && (
            <p className="text-sm text-muted-foreground">{tools.length} tools available</p>
          )}
        </DialogHeader>

        <Input
          placeholder="Search tools..."
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          className="h-8 text-sm"
        />

        {loading ? (
          <p className="text-sm text-muted-foreground py-4 text-center">Loading tools...</p>
        ) : (
          <>
            <div className="flex items-center justify-between text-xs text-muted-foreground mt-1 mb-1">
              <span>{selected.size === 0 ? "All tools (no filter)" : `${selected.size} / ${tools.length} selected`}</span>
              <button type="button" className="text-primary hover:underline" onClick={toggleAll}>
                {allSelected ? "Deselect All" : "Select All"}
              </button>
            </div>
            <div className="max-h-72 overflow-y-auto border rounded-md divide-y">
              {filtered.map((t) => (
                <label
                  key={t.slug}
                  className="flex items-start gap-2 px-3 py-2 hover:bg-muted/50 cursor-pointer"
                >
                  <input
                    type="checkbox"
                    checked={selected.has(t.slug)}
                    onChange={() => toggle(t.slug)}
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

        <div className="flex justify-end gap-2 pt-2">
          <Button size="sm" variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button size="sm" onClick={handleSave} disabled={saving || loading}>
            {saving ? "Saving..." : "Save"}
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
