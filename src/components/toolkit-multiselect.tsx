"use client";

import { useEffect, useRef, useState } from "react";

interface ToolkitOption {
  slug: string;
  name: string;
  logo: string;
}

interface Props {
  value: string[];
  onChange: (value: string[]) => void;
}

export function ToolkitMultiselect({ value, onChange }: Props) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [toolkits, setToolkits] = useState<ToolkitOption[]>([]);
  const [loading, setLoading] = useState(true);
  const containerRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    fetch("/api/admin/composio/toolkits")
      .then((r) => r.json())
      .then((data) => setToolkits(data.data ?? []))
      .finally(() => setLoading(false));
  }, []);

  // Close on outside click
  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setOpen(false);
        setSearch("");
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, []);

  // Focus search when opening
  useEffect(() => {
    if (open) searchRef.current?.focus();
  }, [open]);

  const filtered = toolkits.filter((t) => {
    const q = search.toLowerCase();
    return t.slug.includes(q) || t.name.toLowerCase().includes(q);
  });

  function toggle(slug: string) {
    onChange(value.includes(slug) ? value.filter((s) => s !== slug) : [...value, slug]);
  }

  function remove(slug: string) {
    onChange(value.filter((s) => s !== slug));
  }

  const selectedToolkits = value
    .map((slug) => toolkits.find((t) => t.slug === slug) ?? { slug, name: slug, logo: "" })
    .filter(Boolean);

  return (
    <div ref={containerRef} className="relative">
      {/* Selected badges + trigger */}
      <div
        className="min-h-9 flex flex-wrap gap-1.5 rounded-md border border-input bg-transparent px-3 py-1.5 cursor-text"
        onClick={() => setOpen(true)}
      >
        {selectedToolkits.map((t) => (
          <span
            key={t.slug}
            className="inline-flex items-center gap-1 rounded-md bg-secondary text-secondary-foreground text-xs px-2 py-0.5"
          >
            {t.logo && (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={t.logo} alt="" className="w-3.5 h-3.5 rounded-sm object-contain" />
            )}
            {t.name}
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); remove(t.slug); }}
              className="text-muted-foreground hover:text-foreground ml-0.5"
            >
              ×
            </button>
          </span>
        ))}
        <span className="text-sm text-muted-foreground self-center">
          {value.length === 0 ? "Select toolkits..." : ""}
        </span>
      </div>

      {/* Dropdown */}
      {open && (
        <div className="absolute z-50 mt-1 w-full rounded-md border border-border bg-popover shadow-md">
          <div className="p-2 border-b border-border">
            <input
              ref={searchRef}
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder="Search toolkits..."
              className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
            />
          </div>
          <div className="max-h-64 overflow-y-auto">
            {loading && (
              <p className="text-sm text-muted-foreground p-3">Loading...</p>
            )}
            {!loading && filtered.length === 0 && (
              <p className="text-sm text-muted-foreground p-3">No toolkits found</p>
            )}
            {filtered.map((t) => {
              const selected = value.includes(t.slug);
              return (
                <button
                  key={t.slug}
                  type="button"
                  onClick={() => toggle(t.slug)}
                  className={`w-full flex items-center gap-2.5 px-3 py-2 text-sm text-left hover:bg-accent ${selected ? "bg-accent/50" : ""}`}
                >
                  <span className={`w-4 h-4 flex-shrink-0 rounded-sm border flex items-center justify-center text-xs ${selected ? "bg-primary border-primary text-primary-foreground" : "border-input"}`}>
                    {selected && "✓"}
                  </span>
                  {t.logo && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img src={t.logo} alt="" className="w-5 h-5 rounded-sm object-contain flex-shrink-0" />
                  )}
                  <span className="truncate">{t.name}</span>
                  <span className="ml-auto text-xs text-muted-foreground font-mono flex-shrink-0">{t.slug}</span>
                </button>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
