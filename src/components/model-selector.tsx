"use client";

import { useState, useEffect, useRef, useMemo } from "react";
import { Command } from "cmdk";
import * as Popover from "@radix-ui/react-popover";
import type { CatalogModel } from "@/lib/model-catalog";

interface ModelSelectorProps {
  value: string;
  onChange: (modelId: string) => void;
  disabled?: boolean;
}

function formatContextWindow(tokens: number | null): string {
  if (tokens == null) return "—";
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(tokens % 1_000_000 === 0 ? 0 : 1)}M`;
  if (tokens >= 1_000) return `${Math.round(tokens / 1_000)}K`;
  return tokens.toString();
}

function formatPrice(perMillion: number | null): string {
  if (perMillion == null) return "—";
  if (perMillion < 0.01) return `$${perMillion}/M`;
  if (perMillion < 1) return `$${perMillion.toFixed(2)}/M`;
  return `$${perMillion % 1 === 0 ? perMillion : perMillion.toFixed(2)}/M`;
}

const TAG_LABELS: Record<string, string> = {
  "tool-use": "T",
  reasoning: "R",
  vision: "V",
  "file-input": "F",
  "implicit-caching": "C",
  "image-generation": "I",
};

const TAG_TITLES: Record<string, string> = {
  "tool-use": "Tool Use",
  reasoning: "Reasoning",
  vision: "Vision",
  "file-input": "File Input",
  "implicit-caching": "Implicit Caching",
  "image-generation": "Image Generation",
};

export function ModelSelector({ value, onChange, disabled }: ModelSelectorProps) {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<CatalogModel[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [search, setSearch] = useState("");
  const [providerFilter, setProviderFilter] = useState("all");
  const controllerRef = useRef<AbortController | null>(null);
  const hasFetchedRef = useRef(false);

  // Fetch models lazily on first popover open
  useEffect(() => {
    if (!open || hasFetchedRef.current) return;
    hasFetchedRef.current = true;

    const controller = new AbortController();
    controllerRef.current = controller;
    setLoading(true);
    setError(false);

    fetch("/api/admin/models", { signal: controller.signal })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json();
      })
      .then((data) => {
        if (!controller.signal.aborted) {
          setModels(data.models);
          setLoading(false);
        }
      })
      .catch((err) => {
        if (!controller.signal.aborted) {
          if (err instanceof Error && err.name !== "AbortError") {
            setError(true);
          }
          setLoading(false);
        }
      });

    return () => {
      controller.abort();
      controllerRef.current = null;
    };
  }, [open]);

  // Derive providers from models
  const providers = useMemo(() => {
    if (!models) return [];
    const set = new Set(models.map((m) => m.provider));
    return Array.from(set).sort();
  }, [models]);

  // Group and filter models
  const grouped = useMemo(() => {
    if (!models) return {};
    let filtered = models;
    if (providerFilter !== "all") {
      filtered = filtered.filter((m) => m.provider === providerFilter);
    }
    const groups: Record<string, CatalogModel[]> = {};
    for (const m of filtered) {
      const key = m.provider;
      if (!groups[key]) groups[key] = [];
      groups[key].push(m);
    }
    return groups;
  }, [models, providerFilter]);

  // Find display name for current value
  const selectedModel = models?.find((m) => m.id === value);
  const displayName = selectedModel?.name || value || "Select model...";
  const displayProvider = selectedModel?.provider;

  // Check if search matches any model (for custom entry)
  const searchMatchesAny = useMemo(() => {
    if (!search || !models) return true;
    const lower = search.toLowerCase();
    return models.some(
      (m) =>
        m.id.toLowerCase().includes(lower) ||
        m.name.toLowerCase().includes(lower) ||
        m.provider.toLowerCase().includes(lower),
    );
  }, [search, models]);

  function handleSelect(modelId: string) {
    onChange(modelId);
    setOpen(false);
    setSearch("");
  }

  function handleOpenChange(newOpen: boolean) {
    if (disabled) return;
    setOpen(newOpen);
    if (!newOpen) {
      setSearch("");
    }
  }

  return (
    <Popover.Root open={open} onOpenChange={handleOpenChange}>
      <Popover.Trigger asChild>
        <button
          type="button"
          disabled={disabled}
          className="flex h-9 w-full items-center justify-between rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors hover:bg-accent disabled:opacity-50 disabled:cursor-not-allowed"
        >
          <span className="truncate text-left">
            {displayProvider && !value.includes("/") && (
              <span className="text-muted-foreground mr-1">{displayProvider} /</span>
            )}
            {displayName}
          </span>
          {selectedModel === undefined && value && models && (
            <span className="ml-1 rounded bg-yellow-500/20 px-1 py-0.5 text-[10px] text-yellow-400">
              custom
            </span>
          )}
          <svg
            className="ml-2 h-4 w-4 shrink-0 text-muted-foreground"
            fill="none"
            viewBox="0 0 24 24"
            stroke="currentColor"
            strokeWidth={2}
          >
            <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
          </svg>
        </button>
      </Popover.Trigger>

      <Popover.Portal>
        <Popover.Content
          className="z-50 w-[600px] rounded-lg border border-muted-foreground/25 bg-card shadow-xl"
          sideOffset={4}
          align="start"
          onOpenAutoFocus={(e) => e.preventDefault()}
        >
          <Command
            filter={(value, search) => {
              const model = models?.find((m) => m.id === value);
              if (!model) return 0;
              const lower = search.toLowerCase();
              if (model.id.toLowerCase().includes(lower)) return 1;
              if (model.name.toLowerCase().includes(lower)) return 1;
              if (model.provider.toLowerCase().includes(lower)) return 0.5;
              return 0;
            }}
          >
            <div className="flex items-center gap-2 border-b border-muted-foreground/25 px-3">
              <svg className="h-4 w-4 shrink-0 text-muted-foreground" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
                <path strokeLinecap="round" strokeLinejoin="round" d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
              </svg>
              <Command.Input
                value={search}
                onValueChange={setSearch}
                placeholder="Search model..."
                className="flex h-10 w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
              {providers.length > 0 && (
                <select
                  value={providerFilter}
                  onChange={(e) => setProviderFilter(e.target.value)}
                  className="h-7 rounded border border-muted-foreground/25 bg-transparent px-2 text-xs text-muted-foreground outline-none"
                >
                  <option value="all">All Providers</option>
                  {providers.map((p) => (
                    <option key={p} value={p}>
                      {p.charAt(0).toUpperCase() + p.slice(1)}
                    </option>
                  ))}
                </select>
              )}
            </div>

            <Command.List className="max-h-[360px] overflow-y-auto p-1">
              {loading && (
                <div className="space-y-1 p-2">
                  {[1, 2, 3, 4, 5].map((i) => (
                    <div key={i} className="h-8 animate-pulse rounded bg-muted-foreground/10" />
                  ))}
                </div>
              )}

              {error && (
                <div className="px-3 py-2 text-xs text-yellow-400">
                  Failed to load models from gateway. Showing cached data.
                </div>
              )}

              <Command.Empty className="px-3 py-4 text-center text-sm text-muted-foreground">
                No models found.
              </Command.Empty>

              {/* Column headers */}
              {!loading && models && (
                <div className="grid grid-cols-[1fr_70px_80px_80px_auto] gap-1 px-3 py-1 text-[10px] font-medium uppercase tracking-wider text-muted-foreground">
                  <span>Model</span>
                  <span className="text-right">Context</span>
                  <span className="text-right">Input</span>
                  <span className="text-right">Output</span>
                  <span className="text-center">Tags</span>
                </div>
              )}

              {Object.entries(grouped).map(([provider, providerModels]) => (
                <Command.Group
                  key={provider}
                  heading={provider.charAt(0).toUpperCase() + provider.slice(1)}
                  className="[&_[cmdk-group-heading]]:px-3 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-xs [&_[cmdk-group-heading]]:font-semibold [&_[cmdk-group-heading]]:text-muted-foreground"
                >
                  {providerModels.map((m) => (
                    <Command.Item
                      key={m.id}
                      value={m.id}
                      onSelect={() => handleSelect(m.id)}
                      className="grid cursor-pointer grid-cols-[1fr_70px_80px_80px_auto] items-center gap-1 rounded-md px-3 py-1.5 text-sm data-[selected=true]:bg-accent"
                    >
                      <span className="truncate">
                        {m.name || m.id}
                        {m.id === value && (
                          <svg className="ml-1 inline h-3.5 w-3.5 text-primary" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2.5}>
                            <path strokeLinecap="round" strokeLinejoin="round" d="M5 13l4 4L19 7" />
                          </svg>
                        )}
                      </span>
                      <span className="text-right text-xs text-muted-foreground">
                        {formatContextWindow(m.context_window)}
                      </span>
                      <span className="text-right text-xs text-muted-foreground">
                        {formatPrice(m.pricing.inputPerMillionTokens)}
                      </span>
                      <span className="text-right text-xs text-muted-foreground">
                        {formatPrice(m.pricing.outputPerMillionTokens)}
                      </span>
                      <span className="flex justify-center gap-0.5">
                        {m.tags
                          .filter((t) => TAG_LABELS[t])
                          .map((t) => (
                            <span
                              key={t}
                              title={TAG_TITLES[t] || t}
                              className="inline-flex h-4 w-4 items-center justify-center rounded bg-muted-foreground/15 text-[9px] font-bold text-muted-foreground"
                            >
                              {TAG_LABELS[t]}
                            </span>
                          ))}
                      </span>
                    </Command.Item>
                  ))}
                </Command.Group>
              ))}

              {/* Custom model entry */}
              {search && !searchMatchesAny && (
                <Command.Item
                  value={`custom:${search}`}
                  onSelect={() => handleSelect(search)}
                  className="mt-1 flex cursor-pointer items-center gap-2 rounded-md border-t border-muted-foreground/10 px-3 py-2 text-sm data-[selected=true]:bg-accent"
                >
                  <span className="text-muted-foreground">Use custom model:</span>
                  <span className="font-mono text-xs">{search}</span>
                </Command.Item>
              )}
            </Command.List>
          </Command>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
