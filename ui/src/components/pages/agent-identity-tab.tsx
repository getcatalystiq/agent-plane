"use client";

import { useState, useMemo, useCallback } from "react";
import { useAgentPlaneClient } from "../../hooks/use-client";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
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
import type { FlatFile } from "../editor/file-tree-editor";

interface Agent {
  id: string;
  soul_md: string | null;
  identity_md: string | null;
  style_md: string | null;
  agents_md: string | null;
  heartbeat_md: string | null;
  user_template_md: string | null;
  examples_good_md: string | null;
  examples_bad_md: string | null;
}

const FILE_MAP: Array<{ path: string; field: keyof Agent }> = [
  { path: "SOUL.md", field: "soul_md" },
  { path: "IDENTITY.md", field: "identity_md" },
  { path: "STYLE.md", field: "style_md" },
  { path: "AGENTS.md", field: "agents_md" },
  { path: "HEARTBEAT.md", field: "heartbeat_md" },
  { path: "USER_TEMPLATE.md", field: "user_template_md" },
  { path: "examples/good-outputs.md", field: "examples_good_md" },
  { path: "examples/bad-outputs.md", field: "examples_bad_md" },
];

function agentToFiles(agent: Agent): FlatFile[] {
  const files: FlatFile[] = [];
  for (const { path, field } of FILE_MAP) {
    const value = agent[field];
    if (typeof value === "string" && value.length > 0) {
      files.push({ path, content: value });
    }
  }
  return files;
}

function filesToPayload(files: FlatFile[]): Record<string, string | null> {
  const payload: Record<string, string | null> = {};
  for (const { path, field } of FILE_MAP) {
    const file = files.find((f) => f.path === path);
    payload[field] = file ? file.content : null;
  }
  return payload;
}

export interface AgentIdentityTabProps {
  agent: Agent;
  /**
   * The FileTreeEditor component from the /editor entry point.
   * Pass it as a prop to keep CodeMirror out of the core bundle.
   */
  FileTreeEditor: React.ComponentType<{
    initialFiles: FlatFile[];
    onSave: (files: FlatFile[]) => Promise<void>;
    title?: string;
    saveLabel?: string;
    addFolderLabel?: string;
    newFileTemplate?: { filename: string; content: string };
    savedVersion?: number;
  }>;
  /** Called after a successful save so the host can refresh data. */
  onSaved?: () => void;
  /** Generate a SoulSpec for this agent. Returns a map of field-name/path to content. */
  onGenerateSoul?: () => Promise<{ files: Record<string, string> }>;
  /** Import a SoulSpec from the ClawSouls registry. */
  onImportSoul?: (ref: string) => Promise<{ files: Record<string, string> }>;
  /** Export the current SoulSpec as JSON. Returns file map + agent name. */
  onExportSoul?: () => Promise<{ files: Record<string, string>; name: string }>;
  /** Publish the SoulSpec to the ClawSouls registry. */
  onPublishSoul?: (owner: string) => Promise<void>;
}

export function AgentIdentityTab({
  agent,
  FileTreeEditor,
  onSaved,
  onGenerateSoul,
  onImportSoul,
  onExportSoul,
  onPublishSoul,
}: AgentIdentityTabProps) {
  const client = useAgentPlaneClient();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [generating, setGenerating] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [publishOpen, setPublishOpen] = useState(false);
  const [publishOwner, setPublishOwner] = useState("");
  const [publishResult, setPublishResult] = useState<string | null>(null);
  const [savedVersion, setSavedVersion] = useState(0);
  const [overrideFiles, setOverrideFiles] = useState<FlatFile[] | null>(null);

  const initialFiles = useMemo(() => agentToFiles(agent), [agent]);

  // Use override files when generated/imported, otherwise use agent data
  const editorFiles = overrideFiles ?? initialFiles;

  const handleSave = useCallback(
    async (files: FlatFile[]) => {
      setSaving(true);
      setError("");
      try {
        const payload = filesToPayload(files);
        await client.agents.update(agent.id, payload);
        setOverrideFiles(null);
        setSavedVersion((v) => v + 1);
        onSaved?.();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to save");
        throw err; // Let FileTreeEditor know the save failed
      } finally {
        setSaving(false);
      }
    },
    [agent.id, client, onSaved],
  );

  function applyFilesFromResponse(responseFiles: Record<string, string>) {
    const newFiles: FlatFile[] = [];
    for (const { path, field } of FILE_MAP) {
      const content = responseFiles[field] ?? responseFiles[path];
      newFiles.push({ path, content: content ?? "" });
    }
    if (newFiles.length > 0) {
      setOverrideFiles(newFiles);
      // Bump savedVersion so FileTreeEditor re-initializes with new content and sees it as dirty
      setSavedVersion((v) => v + 1);
    }
  }

  async function handleGenerate() {
    if (!onGenerateSoul) return;
    setGenerating(true);
    setError("");
    try {
      const data = await onGenerateSoul();
      applyFilesFromResponse(data.files);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate");
    } finally {
      setGenerating(false);
    }
  }

  function handleImported(responseFiles: Record<string, string>) {
    applyFilesFromResponse(responseFiles);
  }

  async function handleExport() {
    if (!onExportSoul) return;
    setError("");
    try {
      const data = await onExportSoul();
      const blob = new Blob([JSON.stringify(data, null, 2)], {
        type: "application/json",
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${data.name || "soulspec"}.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to export");
    }
  }

  async function handlePublish() {
    if (!onPublishSoul || !publishOwner.trim()) return;
    setPublishing(true);
    setError("");
    setPublishResult(null);
    try {
      await onPublishSoul(publishOwner.trim());
      setPublishResult("Published successfully");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to publish");
      setPublishOpen(false);
    } finally {
      setPublishing(false);
    }
  }

  // Validation warnings
  const warnings: string[] = [];
  const hasSoul = editorFiles.some(
    (f) => f.path === "SOUL.md" && f.content.trim().length > 0,
  );
  const hasIdentity = editorFiles.some(
    (f) => f.path === "IDENTITY.md" && f.content.trim().length > 0,
  );
  if (!hasSoul) warnings.push("SOUL.md is empty -- this is the core identity file");
  if (!hasIdentity)
    warnings.push("IDENTITY.md is empty -- consider adding behavioral traits");

  return (
    <div className="space-y-4">
      {/* Action buttons */}
      <div className="flex items-center gap-2">
        {onGenerateSoul && (
          <Button
            variant="outline"
            size="sm"
            onClick={handleGenerate}
            disabled={generating}
          >
            <svg className="size-4 mr-1.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="m12 3-1.9 5.8a2 2 0 0 1-1.3 1.3L3 12l5.8 1.9a2 2 0 0 1 1.3 1.3L12 21l1.9-5.8a2 2 0 0 1 1.3-1.3L21 12l-5.8-1.9a2 2 0 0 1-1.3-1.3Z" /></svg>
            {generating ? "Generating..." : "Generate Soul"}
          </Button>
        )}
        {onImportSoul && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => setImportOpen(true)}
          >
            <svg className="size-4 mr-1.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="7 10 12 15 17 10" /><line x1="12" x2="12" y1="15" y2="3" /></svg>
            Import
          </Button>
        )}
        {onExportSoul && (
          <Button variant="outline" size="sm" onClick={handleExport}>
            <svg className="size-4 mr-1.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><polyline points="17 8 12 3 7 8" /><line x1="12" x2="12" y1="3" y2="15" /></svg>
            Export
          </Button>
        )}
        {onPublishSoul && (
          <Button
            variant="outline"
            size="sm"
            onClick={() => { setPublishOpen(true); setPublishResult(null); setPublishOwner(""); }}
          >
            <svg className="size-4 mr-1.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="10" /><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" /><path d="M2 12h20" /></svg>
            Publish
          </Button>
        )}
        {overrideFiles && (
          <Badge variant="destructive" className="text-xs">
            Unsaved generated content
          </Badge>
        )}
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}

      {/* File editor */}
      <div className="rounded-lg border border-muted-foreground/25 p-5">
        <FileTreeEditor
          initialFiles={editorFiles}
          onSave={handleSave}
          title="SoulSpec"
          saveLabel={saving ? "Saving..." : "Save Identity"}
          addFolderLabel="Folder"
          newFileTemplate={{
            filename: "CUSTOM.md",
            content: "# Custom\n\nAdd custom identity content...\n",
          }}
          savedVersion={savedVersion}
        />
      </div>

      {/* Validation warnings */}
      {warnings.length > 0 && (
        <div className="rounded-md border border-yellow-600 bg-yellow-50 dark:bg-yellow-950/40 p-3">
          <p className="text-xs font-medium text-yellow-800 dark:text-yellow-400 mb-1">
            Validation Warnings
          </p>
          <ul className="text-xs text-yellow-700 dark:text-yellow-300 space-y-0.5">
            {warnings.map((w) => (
              <li key={w}>- {w}</li>
            ))}
          </ul>
        </div>
      )}

      {onImportSoul && (
        <ImportSoulDialog
          open={importOpen}
          onOpenChange={setImportOpen}
          onImport={onImportSoul}
          onImported={handleImported}
        />
      )}

      {/* Publish dialog */}
      {onPublishSoul && (
        <Dialog open={publishOpen} onOpenChange={setPublishOpen}>
          <DialogContent className="max-w-md">
            <DialogHeader>
              <DialogTitle>Publish to ClawSouls Registry</DialogTitle>
              <DialogDescription>
                Upload your agent&apos;s SoulSpec identity to the ClawSouls registry.
              </DialogDescription>
            </DialogHeader>
            <DialogBody>
              <div className="space-y-4">
                <div className="rounded-md border border-muted-foreground/25 bg-muted/50 p-3 text-xs text-muted-foreground space-y-2">
                  <p>Publishing uploads your agent&apos;s identity to the <a href="https://clawsouls.ai/souls" target="_blank" rel="noopener noreferrer" className="underline text-foreground">ClawSouls registry</a> where others can discover and install it.</p>
                  <p><strong>Requirements:</strong></p>
                  <ul className="list-disc pl-4 space-y-0.5">
                    <li>A ClawSouls API token (set in Settings)</li>
                    <li>SOUL.md with required sections (Personality, Tone, Principles)</li>
                    <li>IDENTITY.md with Name, Role, and Creature fields</li>
                  </ul>
                  <p>Your soul will be validated by SoulScan before publishing.</p>
                </div>
                <FormField label="Owner (your ClawSouls username)">
                  <Input
                    value={publishOwner}
                    onChange={(e) => setPublishOwner(e.target.value)}
                    placeholder="e.g. myusername"
                    disabled={publishing}
                  />
                </FormField>
                {publishResult && (
                  <div className="rounded-md border border-green-600 bg-green-500/10 p-3 text-xs text-green-400">
                    {publishResult}
                  </div>
                )}
              </div>
            </DialogBody>
            <DialogFooter>
              <Button variant="outline" size="sm" onClick={() => setPublishOpen(false)}>
                Cancel
              </Button>
              <Button size="sm" onClick={handlePublish} disabled={publishing || !publishOwner.trim()}>
                {publishing ? "Publishing..." : "Publish"}
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */
/*  Import Soul Dialog (inline sub-component)                         */
/* ------------------------------------------------------------------ */

interface ImportSoulDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onImport: (ref: string) => Promise<{ files: Record<string, string> }>;
  onImported: (files: Record<string, string>) => void;
}

function ImportSoulDialog({
  open,
  onOpenChange,
  onImport,
  onImported,
}: ImportSoulDialogProps) {
  const [ref, setRef] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleImport() {
    if (!ref.trim()) return;
    setLoading(true);
    setError("");
    try {
      const data = await onImport(ref.trim());
      onImported(data.files);
      onOpenChange(false);
      setRef("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to import");
    } finally {
      setLoading(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle>Import SoulSpec</DialogTitle>
          <DialogDescription>
            Import a SoulSpec from the ClawSouls registry.
          </DialogDescription>
        </DialogHeader>
        <DialogBody>
          {error && <p className="text-sm text-destructive mb-3">{error}</p>}
          <FormField label="Registry Reference">
            <Input
              value={ref}
              onChange={(e) => setRef(e.target.value)}
              placeholder="owner/name (e.g. clawsouls/surgical-coder)"
              onKeyDown={(e) => e.key === "Enter" && handleImport()}
              autoFocus
            />
          </FormField>
        </DialogBody>
        <DialogFooter>
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={loading}
          >
            Cancel
          </Button>
          <Button
            size="sm"
            onClick={handleImport}
            disabled={loading || !ref.trim()}
          >
            {loading ? "Importing..." : "Import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
