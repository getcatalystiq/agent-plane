"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { FormField } from "@/components/ui/form-field";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogBody,
  DialogFooter,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { adminFetch } from "@/app/admin/lib/api";

interface ImportSoulDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  agentId: string;
  onImported: (files: Record<string, string>) => void;
}

export function ImportSoulDialog({ open, onOpenChange, agentId, onImported }: ImportSoulDialogProps) {
  const [ref, setRef] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");

  async function handleImport() {
    if (!ref.trim()) return;
    setLoading(true);
    setError("");
    try {
      const data = await adminFetch<{ files: Record<string, string> }>(
        `/agents/${agentId}/import-soul`,
        {
          method: "POST",
          body: JSON.stringify({ ref: ref.trim() }),
        },
      );
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
          <Button variant="outline" size="sm" onClick={() => onOpenChange(false)} disabled={loading}>
            Cancel
          </Button>
          <Button size="sm" onClick={handleImport} disabled={loading || !ref.trim()}>
            {loading ? "Importing..." : "Import"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
