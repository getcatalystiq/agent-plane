"use client";

import { useState, useEffect, useMemo } from "react";
import { useAgentPlaneClient } from "../../hooks/use-client";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { FormField } from "../ui/form-field";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogBody,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "../ui/dialog";
import type { SkillDirectoryEntry } from "../../types";

type SkillDirectoryTab = "all" | "trending" | "hot";

function TabButton({ label, active, onClick }: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={onClick}
      className={`relative pb-2 text-sm font-medium transition-colors ${
        active ? "text-foreground" : "text-muted-foreground hover:text-foreground"
      }`}
    >
      {label}
      {active && <span className="absolute inset-x-0 bottom-0 h-0.5 bg-foreground rounded-full" />}
    </button>
  );
}

interface ImportSkillDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImported: (skill: { folder: string; files: Array<{ path: string; content: string }> }) => void;
  existingFolders: string[];
}

export function ImportSkillDialog({ open, onOpenChange, onImported, existingFolders }: ImportSkillDialogProps) {
  const client = useAgentPlaneClient();
  const [tab, setTab] = useState<SkillDirectoryTab>("all");
  const [entries, setEntries] = useState<SkillDirectoryEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [search, setSearch] = useState("");

  const [selected, setSelected] = useState<SkillDirectoryEntry | null>(null);
  const [preview, setPreview] = useState("");
  const [previewLoading, setPreviewLoading] = useState(false);

  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState("");

  const [url, setUrl] = useState("");
  const [urlImporting, setUrlImporting] = useState(false);

  useEffect(() => {
    if (!open) return;
    setLoading(true);
    setError("");
    setSelected(null);
    setPreview("");
    client.skillsDirectory.list(tab)
      .then((data) => setEntries(data))
      .catch((err) => setError(err instanceof Error ? err.message : "Failed to load skills"))
      .finally(() => setLoading(false));
  }, [tab, open, client]);

  const filtered = useMemo(() => {
    if (!search.trim()) return entries;
    const q = search.toLowerCase();
    return entries.filter(
      (e) =>
        e.name.toLowerCase().includes(q) ||
        e.owner.toLowerCase().includes(q) ||
        e.repo.toLowerCase().includes(q),
    );
  }, [entries, search]);

  async function handleSelect(entry: SkillDirectoryEntry) {
    setSelected(entry);
    setPreviewLoading(true);
    setPreview("");
    setImportError("");
    try {
      const content = await client.skillsDirectory.preview(entry.owner, entry.repo, entry.skill);
      setPreview(content);
    } catch (err) {
      setPreview(`Failed to load preview: ${err instanceof Error ? err.message : "Unknown error"}`);
    } finally {
      setPreviewLoading(false);
    }
  }

  async function handleImport() {
    if (!selected) return;
    setImporting(true);
    setImportError("");
    try {
      const result = await client.skillsDirectory.import({
        owner: selected.owner,
        repo: selected.repo,
        skill_name: selected.skill,
      });
      if (existingFolders.includes(result.folder)) {
        setImportError(`Skill folder "${result.folder}" already exists. Remove it first or rename.`);
        return;
      }
      if (result.warnings.length > 0) {
        setImportError(`Imported with warnings: ${result.warnings.join("; ")}`);
      }
      onImported({ folder: result.folder, files: result.files });
      onOpenChange(false);
      resetState();
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Failed to import skill");
    } finally {
      setImporting(false);
    }
  }

  async function handleUrlImport() {
    if (!url.trim()) return;
    setUrlImporting(true);
    setImportError("");
    try {
      const result = await client.skillsDirectory.import({ url: url.trim() });
      if (existingFolders.includes(result.folder)) {
        setImportError(`Skill folder "${result.folder}" already exists. Remove it first or rename.`);
        return;
      }
      onImported({ folder: result.folder, files: result.files });
      onOpenChange(false);
      resetState();
    } catch (err) {
      setImportError(err instanceof Error ? err.message : "Failed to import skill");
    } finally {
      setUrlImporting(false);
    }
  }

  function resetState() {
    setTab("all");
    setSearch("");
    setSelected(null);
    setPreview("");
    setUrl("");
    setError("");
    setImportError("");
  }

  return (
    <Dialog open={open} onOpenChange={(v) => { onOpenChange(v); if (!v) resetState(); }}>
      <DialogContent className="max-w-2xl max-h-[80vh] flex flex-col">
        <DialogHeader>
          <DialogTitle>Import from skills.sh</DialogTitle>
          <DialogDescription>
            Browse the open skills directory and import skills into this agent.
          </DialogDescription>
        </DialogHeader>
        <DialogBody className="flex-1 overflow-hidden flex flex-col gap-4">
          <div className="flex gap-4">
            <TabButton label="All Time" active={tab === "all"} onClick={() => setTab("all")} />
            <TabButton label="Trending" active={tab === "trending"} onClick={() => setTab("trending")} />
            <TabButton label="Hot" active={tab === "hot"} onClick={() => setTab("hot")} />
          </div>

          <Input placeholder="Search skills..." value={search} onChange={(e) => setSearch(e.target.value)} />

          {error && <p className="text-sm text-destructive">{error}</p>}

          <div className="flex-1 overflow-hidden flex gap-4 min-h-0">
            <div className="w-1/2 overflow-y-auto border border-muted-foreground/25 rounded-lg">
              {loading ? (
                <div className="p-4 text-sm text-muted-foreground">Loading skills...</div>
              ) : filtered.length === 0 ? (
                <div className="p-4 text-sm text-muted-foreground">
                  {search ? "No skills match your search" : "No skills found"}
                </div>
              ) : (
                filtered.map((entry) => (
                  <button
                    key={`${entry.owner}/${entry.repo}/${entry.skill}`}
                    onClick={() => handleSelect(entry)}
                    className={`w-full text-left px-3 py-2 border-b border-muted-foreground/10 hover:bg-muted/50 transition-colors ${
                      selected?.skill === entry.skill && selected?.owner === entry.owner ? "bg-muted/50" : ""
                    }`}
                  >
                    <div className="font-medium text-sm truncate">{entry.name}</div>
                    <div className="flex justify-between items-center">
                      <span className="text-xs text-muted-foreground truncate">{entry.owner}/{entry.repo}</span>
                      <span className="text-xs text-muted-foreground font-mono ml-2 shrink-0">{entry.installs}</span>
                    </div>
                  </button>
                ))
              )}
            </div>

            <div className="w-1/2 overflow-y-auto border border-muted-foreground/25 rounded-lg p-3">
              {!selected ? (
                <div className="text-sm text-muted-foreground">Select a skill to preview</div>
              ) : previewLoading ? (
                <div className="text-sm text-muted-foreground">Loading preview...</div>
              ) : (
                <pre className="text-xs whitespace-pre-wrap break-words font-mono">{preview}</pre>
              )}
            </div>
          </div>

          {importError && <p className="text-sm text-destructive">{importError}</p>}

          <div className="border-t border-muted-foreground/25 pt-3">
            <FormField label="Or paste a skills.sh URL">
              <div className="flex gap-2">
                <Input
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  placeholder="skills.sh/owner/repo/skill"
                  onKeyDown={(e) => e.key === "Enter" && handleUrlImport()}
                  className="flex-1"
                />
                <Button size="sm" variant="outline" onClick={handleUrlImport} disabled={urlImporting || !url.trim()}>
                  {urlImporting ? "Importing..." : "Import URL"}
                </Button>
              </div>
            </FormField>
          </div>
        </DialogBody>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button size="sm" onClick={handleImport} disabled={!selected || importing || previewLoading}>
            {importing ? "Importing..." : "Import Selected"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
