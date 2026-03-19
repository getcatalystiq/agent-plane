"use client";

import { useState, useRef, KeyboardEvent } from "react";
import { SectionHeader } from "@/components/ui/section-header";
import { CopyButton } from "@/components/ui/copy-button";
import { Button } from "@/components/ui/button";

export function A2aInfoSection({
  agentId,
  tenantSlug,
  agentSlug,
  baseUrl,
  initialEnabled,
  initialTags,
}: {
  agentId: string;
  tenantSlug: string;
  agentSlug: string;
  baseUrl: string;
  initialEnabled: boolean;
  initialTags: string[];
}) {
  const [enabled, setEnabled] = useState(initialEnabled);
  const [toggling, setToggling] = useState(false);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [cardPreview, setCardPreview] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [tags, setTags] = useState<string[]>(initialTags);
  const [tagInput, setTagInput] = useState("");
  const [savingTags, setSavingTags] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const endpointUrl = `${baseUrl}/api/a2a/${tenantSlug}/${agentSlug}`;
  const jsonRpcUrl = `${baseUrl}/api/a2a/${tenantSlug}/${agentSlug}/jsonrpc`;
  const agentCardUrl = `${baseUrl}/api/a2a/${tenantSlug}/${agentSlug}/.well-known/agent-card.json`;

  async function toggleA2a() {
    setToggling(true);
    try {
      const next = !enabled;
      await fetch(`/api/admin/agents/${agentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ a2a_enabled: next }),
      });
      setEnabled(next);
    } finally {
      setToggling(false);
    }
  }

  async function saveTags(nextTags: string[]) {
    setSavingTags(true);
    try {
      await fetch(`/api/admin/agents/${agentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ a2a_tags: nextTags }),
      });
    } finally {
      setSavingTags(false);
    }
  }

  function addTag(value: string) {
    const tag = value.trim();
    if (!tag || tags.includes(tag)) return;
    const next = [...tags, tag];
    setTags(next);
    setTagInput("");
    saveTags(next);
  }

  function removeTag(tag: string) {
    const next = tags.filter((t) => t !== tag);
    setTags(next);
    saveTags(next);
  }

  function onTagKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addTag(tagInput);
    } else if (e.key === "Backspace" && tagInput === "" && tags.length > 0) {
      removeTag(tags[tags.length - 1]);
    }
  }

  async function fetchAgentCard() {
    if (cardPreview) {
      setCardPreview(null);
      return;
    }
    setLoading(true);
    try {
      const res = await fetch(agentCardUrl);
      const data = await res.json();
      setCardPreview(JSON.stringify(data, null, 2));
    } catch {
      setCardPreview("Failed to fetch Agent Card");
    } finally {
      setLoading(false);
    }
  }

  return (
    <div className="rounded-lg border border-muted-foreground/25 p-5">
      <div className="flex items-center justify-between mb-4">
        <SectionHeader title="A2A Protocol" className="mb-0" />
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          disabled={toggling}
          onClick={toggleA2a}
          className={`relative inline-flex h-6 w-11 shrink-0 cursor-pointer rounded-full border-2 border-transparent transition-colors duration-200 ease-in-out focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background disabled:cursor-not-allowed disabled:opacity-50 ${enabled ? "bg-indigo-500" : "bg-muted-foreground/30"}`}
        >
          <span
            className={`pointer-events-none inline-block h-5 w-5 transform rounded-full bg-white shadow-lg ring-0 transition duration-200 ease-in-out ${enabled ? "translate-x-5" : "translate-x-0"}`}
          />
        </button>
      </div>
      {enabled && <div className="space-y-3">
        <div className="grid grid-cols-2 gap-4 items-start">
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">URL</label>
            <div className="flex items-center gap-2">
              <code className="flex-1 rounded bg-muted px-3 py-1.5 text-xs font-mono text-foreground break-all">
                {endpointUrl}
              </code>
              <CopyButton text={endpointUrl} />
            </div>
          </div>
          <div>
            <label className="text-xs text-muted-foreground mb-1 block">Tags</label>
            <div
              className="flex flex-wrap items-center gap-1.5 rounded border border-input bg-muted px-2 py-1.5 min-h-[32px] cursor-text"
              onClick={() => inputRef.current?.focus()}
            >
              {tags.map((tag) => (
                <span key={tag} className="flex items-center gap-1 rounded bg-indigo-500/20 text-indigo-300 text-xs px-2 py-0.5">
                  {tag}
                  <button
                    type="button"
                    onClick={(e) => { e.stopPropagation(); removeTag(tag); }}
                    className="hover:text-white leading-none"
                    disabled={savingTags}
                  >
                    ×
                  </button>
                </span>
              ))}
              <input
                ref={inputRef}
                value={tagInput}
                onChange={(e) => setTagInput(e.target.value)}
                onKeyDown={onTagKeyDown}
                onBlur={() => tagInput.trim() && addTag(tagInput)}
                placeholder={tags.length === 0 ? "Add tags…" : ""}
                className="flex-1 min-w-[80px] bg-transparent text-xs outline-none placeholder:text-muted-foreground"
                disabled={savingTags}
              />
            </div>
          </div>
        </div>
        <button
          onClick={() => setDetailsOpen((v) => !v)}
          className="flex items-center gap-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
        >
          <span>{detailsOpen ? "▾" : "▸"}</span>
          <span>Details</span>
        </button>
        {detailsOpen && (
          <div className="space-y-3 pl-1">
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">JSON-RPC Endpoint</label>
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded bg-muted px-3 py-1.5 text-xs font-mono text-foreground break-all">
                  {jsonRpcUrl}
                </code>
                <CopyButton text={jsonRpcUrl} />
              </div>
            </div>
            <div>
              <label className="text-xs text-muted-foreground mb-1 block">Agent Card URL</label>
              <div className="flex items-center gap-2">
                <code className="flex-1 rounded bg-muted px-3 py-1.5 text-xs font-mono text-foreground break-all">
                  {agentCardUrl}
                </code>
                <CopyButton text={agentCardUrl} />
              </div>
            </div>
            <div>
              <Button variant="outline" size="sm" onClick={fetchAgentCard} disabled={loading}>
                {loading ? "Loading..." : cardPreview ? "Hide Agent Card" : "Agent Card"}
              </Button>
              {cardPreview && (
                <div className="mt-3 relative">
                  <pre className="rounded bg-muted p-4 text-xs font-mono text-foreground overflow-x-auto max-h-96">
                    {cardPreview}
                  </pre>
                  <CopyButton text={cardPreview} className="absolute top-2 right-2" />
                </div>
              )}
            </div>
          </div>
        )}
      </div>}
    </div>
  );
}
