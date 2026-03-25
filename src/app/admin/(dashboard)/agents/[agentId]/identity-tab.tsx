"use client";

import { useState, useMemo, useCallback } from "react";
import { useRouter } from "next/navigation";
import { Download, Upload, Sparkles, Globe } from "lucide-react";
import { FileTreeEditor } from "@/components/file-tree-editor";
import type { FlatFile } from "@/components/file-tree-editor";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogBody, DialogFooter } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { Input } from "@/components/ui/input";
import { adminFetch } from "@/app/admin/lib/api";
import { ImportSoulDialog } from "./import-soul-dialog";

interface Agent {
  id: string;
  name: string;
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

export function IdentityTab({ agent }: { agent: Agent }) {
  const router = useRouter();
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

  const handleSave = useCallback(async (files: FlatFile[]) => {
    setSaving(true);
    setError("");
    try {
      const payload = filesToPayload(files);
      await adminFetch(`/agents/${agent.id}`, {
        method: "PATCH",
        body: JSON.stringify(payload),
      });
      setOverrideFiles(null);
      setSavedVersion((v) => v + 1);
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save");
      throw err; // Let FileTreeEditor know the save failed
    } finally {
      setSaving(false);
    }
  }, [agent.id, router]);

  async function handleGenerate() {
    setGenerating(true);
    setError("");
    try {
      const data = await adminFetch<{ files: Record<string, string> }>(
        `/agents/${agent.id}/generate-soul`,
        { method: "POST" },
      );
      applyFilesFromResponse(data.files);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate");
    } finally {
      setGenerating(false);
    }
  }

  function applyFilesFromResponse(responseFiles: Record<string, string>) {
    const newFiles: FlatFile[] = [];
    for (const { path, field } of FILE_MAP) {
      const content = responseFiles[field] ?? responseFiles[path];
      newFiles.push({ path, content: content ?? "" });
    }
    if (newFiles.length > 0) {
      setOverrideFiles(newFiles);
      setSavedVersion((v) => v + 1);
    }
  }

  function handleImported(responseFiles: Record<string, string>) {
    applyFilesFromResponse(responseFiles);
  }

  async function handleExport() {
    setError("");
    try {
      const data = await adminFetch<{ manifest: { name?: string }; files: Record<string, string> }>(
        `/agents/${agent.id}/export-soul`,
      );
      const slug = (data.manifest?.name || agent.name || "soulspec").toLowerCase().replace(/[^a-z0-9]+/g, "-");
      const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${slug}-soul.json`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to export");
    }
  }

  async function handlePublish() {
    if (!publishOwner.trim()) return;
    setPublishing(true);
    setError("");
    setPublishResult(null);
    try {
      const data = await adminFetch<{ published: boolean; url?: string }>(
        `/agents/${agent.id}/publish-soul`,
        { method: "POST", body: JSON.stringify({ owner: publishOwner.trim() }) },
      );
      setPublishResult(data.url ?? "Published successfully");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to publish");
      setPublishOpen(false);
    } finally {
      setPublishing(false);
    }
  }

  // Validation warnings
  const warnings: string[] = [];
  const hasSoul = editorFiles.some((f) => f.path === "SOUL.md" && f.content.trim().length > 0);
  const hasIdentity = editorFiles.some((f) => f.path === "IDENTITY.md" && f.content.trim().length > 0);
  if (!hasSoul) warnings.push("SOUL.md is empty -- this is the core identity file");
  if (!hasIdentity) warnings.push("IDENTITY.md is empty -- consider adding behavioral traits");

  return (
    <div className="space-y-4">
      {/* Action buttons */}
      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={handleGenerate}
          disabled={generating}
        >
          <Sparkles className="size-4 mr-1.5" />
          {generating ? "Generating..." : "Generate Soul"}
        </Button>
        <Button variant="outline" size="sm" onClick={() => setImportOpen(true)}>
          <Download className="size-4 mr-1.5" />
          Import
        </Button>
        <Button variant="outline" size="sm" onClick={handleExport}>
          <Upload className="size-4 mr-1.5" />
          Export
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={() => { setPublishOpen(true); setPublishResult(null); setPublishOwner(""); }}
        >
          <Globe className="size-4 mr-1.5" />
          Publish
        </Button>
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
          newFileTemplate={{ filename: "CUSTOM.md", content: "# Custom\n\nAdd custom identity content...\n" }}
          savedVersion={savedVersion}
        />
      </div>

      {/* Validation warnings */}
      {warnings.length > 0 && (
        <div className="rounded-md border border-yellow-600 bg-yellow-50 dark:bg-yellow-950/40 p-3">
          <p className="text-xs font-medium text-yellow-800 dark:text-yellow-400 mb-1">Validation Warnings</p>
          <ul className="text-xs text-yellow-700 dark:text-yellow-300 space-y-0.5">
            {warnings.map((w) => (
              <li key={w}>- {w}</li>
            ))}
          </ul>
        </div>
      )}

      <ImportSoulDialog
        open={importOpen}
        onOpenChange={setImportOpen}
        agentId={agent.id}
        onImported={handleImported}
      />

      <Dialog open={publishOpen} onOpenChange={setPublishOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Publish to ClawSouls Registry</DialogTitle>
          </DialogHeader>
          <DialogBody>
            <div className="space-y-4">
              <div className="rounded-md border border-muted-foreground/25 bg-muted/50 p-3 text-xs text-muted-foreground space-y-2">
                <p>Publishing uploads your agent&apos;s SoulSpec identity to the <a href="https://clawsouls.ai/souls" target="_blank" rel="noopener noreferrer" className="underline text-foreground">ClawSouls registry</a> where others can discover and install it.</p>
                <p><strong>Requirements:</strong></p>
                <ul className="list-disc pl-4 space-y-0.5">
                  <li>A ClawSouls API token (set in Settings &rarr; ClawSouls Registry)</li>
                  <li>SOUL.md with required sections (Personality, Tone, Principles)</li>
                  <li>IDENTITY.md with Name, Role, and Creature fields</li>
                </ul>
                <p>Your soul will be validated by SoulScan before publishing. The owner name is your ClawSouls username.</p>
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
                  Published successfully!{" "}
                  {publishResult.startsWith("http") && (
                    <a href={publishResult} target="_blank" rel="noopener noreferrer" className="underline">
                      View on ClawSouls &rarr;
                    </a>
                  )}
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
    </div>
  );
}
