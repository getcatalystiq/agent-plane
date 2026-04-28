"use client";

import { useCallback, useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogBody, DialogFooter, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { adminFetch } from "@/app/admin/lib/api";

interface Tool {
  slug: string;
  name: string;
  description: string;
}

interface Props {
  toolkit: string;
  toolkitLogo?: string;
  allowedTools: string[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSave: (toolkit: string, selectedSlugs: string[]) => void;
}

export function ToolsModal({ toolkit, toolkitLogo, allowedTools, open, onOpenChange, onSave }: Props) {
  const [tools, setTools] = useState<Tool[]>([]);
  const [loading, setLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [saving, setSaving] = useState(false);

  const fetchTools = useCallback(async () => {
    setLoading(true);
    try {
      const data = await adminFetch<{ data: Tool[] }>(`/composio/tools?toolkit=${encodeURIComponent(toolkit)}`);
      setTools(data.data ?? []);
    } finally {
      setLoading(false);
    }
  }, [toolkit]);

  useEffect(() => {
    if (open) {
      fetchTools();
      setSearch("");
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
          ) : (
            <>
              <div className="flex items-center justify-between text-xs text-muted-foreground">
                <span>{selected.size === 0 ? "All tools (no filter)" : `${selected.size} / ${tools.length} selected`}</span>
                <Button type="button" variant="link" size="sm" className="h-auto p-0 text-xs" onClick={toggleAll}>
                  {allSelected ? "Deselect All" : "Select All"}
                </Button>
              </div>
              <div className="max-h-72 overflow-y-auto border border-border rounded-lg divide-y divide-border">
                {filtered.map((t) => (
                  <label
                    key={t.slug}
                    className="flex items-start gap-2.5 px-3 py-2.5 hover:bg-muted/50 cursor-pointer transition-colors"
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
