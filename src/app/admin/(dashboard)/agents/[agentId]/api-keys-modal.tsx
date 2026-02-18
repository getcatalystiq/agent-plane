"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  last_used_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

interface Props {
  tenantId: string;
  open: boolean;
  onClose: () => void;
}

export function ApiKeysModal({ tenantId, open, onClose }: Props) {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(false);
  const [newKeyName, setNewKeyName] = useState("");
  const [creating, setCreating] = useState(false);
  const [newKeyValue, setNewKeyValue] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [revoking, setRevoking] = useState<Record<string, boolean>>({});

  async function load() {
    setLoading(true);
    try {
      const res = await fetch(`/api/admin/tenants/${tenantId}/keys`);
      const data = await res.json();
      setKeys(data.data ?? []);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (open) {
      load();
      setNewKeyName("");
      setNewKeyValue(null);
      setCopied(false);
    }
  }, [open, tenantId]);

  async function handleCreate() {
    if (!newKeyName.trim()) return;
    setCreating(true);
    try {
      const res = await fetch(`/api/admin/tenants/${tenantId}/keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newKeyName.trim() }),
      });
      const data = await res.json();
      if (res.ok) {
        setNewKeyValue(data.key);
        setNewKeyName("");
        await load();
      }
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(keyId: string) {
    setRevoking((r) => ({ ...r, [keyId]: true }));
    try {
      await fetch(`/api/admin/tenants/${tenantId}/keys/${keyId}`, { method: "DELETE" });
      await load();
    } finally {
      setRevoking((r) => ({ ...r, [keyId]: false }));
    }
  }

  function handleCopy() {
    if (newKeyValue) {
      navigator.clipboard.writeText(newKeyValue);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  const activeKeys = keys.filter((k) => !k.revoked_at);
  const revokedKeys = keys.filter((k) => k.revoked_at);

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>API Keys</DialogTitle>
        </DialogHeader>

        <div className="space-y-5">
          {/* New key reveal */}
          {newKeyValue && (
            <div className="rounded-md bg-green-950 border border-green-800 p-3 space-y-2">
              <p className="text-sm font-medium text-green-400">
                New key created — copy it now, it won&apos;t be shown again.
              </p>
              <div className="flex items-center gap-2">
                <code className="flex-1 text-xs font-mono bg-background rounded px-2 py-1 truncate select-all">
                  {newKeyValue}
                </code>
                <Button size="sm" variant="outline" className="h-7 text-xs flex-shrink-0" onClick={handleCopy}>
                  {copied ? "Copied!" : "Copy"}
                </Button>
              </div>
            </div>
          )}

          {/* Create new key */}
          <div className="flex items-center gap-2">
            <Input
              placeholder="Key name (e.g. production)"
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
              className="h-8 text-sm"
              onKeyDown={(e) => e.key === "Enter" && handleCreate()}
            />
            <Button
              size="sm"
              disabled={!newKeyName.trim() || creating}
              onClick={handleCreate}
              className="flex-shrink-0"
            >
              {creating ? "Creating…" : "Create Key"}
            </Button>
          </div>

          {/* Active keys */}
          {loading ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : (
            <div className="space-y-2">
              {activeKeys.length === 0 && !newKeyValue && (
                <p className="text-sm text-muted-foreground">No active keys.</p>
              )}
              {activeKeys.map((key) => (
                <div key={key.id} className="flex items-center gap-3 py-2 border-b border-border last:border-0">
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium truncate">{key.name}</p>
                    <p className="text-xs text-muted-foreground font-mono">
                      {key.key_prefix}…
                      {key.last_used_at
                        ? ` · Last used ${new Date(key.last_used_at).toLocaleDateString()}`
                        : " · Never used"}
                      {" · Created "}
                      {new Date(key.created_at).toLocaleDateString()}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="h-7 text-xs text-red-500 hover:text-red-600 hover:bg-red-50 dark:hover:bg-red-950 flex-shrink-0"
                    disabled={revoking[key.id]}
                    onClick={() => handleRevoke(key.id)}
                  >
                    {revoking[key.id] ? "Revoking…" : "Revoke"}
                  </Button>
                </div>
              ))}

              {revokedKeys.length > 0 && (
                <details className="pt-2">
                  <summary className="text-xs text-muted-foreground cursor-pointer hover:text-foreground">
                    {revokedKeys.length} revoked key{revokedKeys.length !== 1 ? "s" : ""}
                  </summary>
                  <div className="mt-2 space-y-1">
                    {revokedKeys.map((key) => (
                      <div key={key.id} className="flex items-center gap-3 py-1 opacity-50">
                        <div className="flex-1 min-w-0">
                          <p className="text-sm line-through truncate">{key.name}</p>
                          <p className="text-xs text-muted-foreground font-mono">
                            {key.key_prefix}… · Revoked {new Date(key.revoked_at!).toLocaleDateString()}
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </details>
              )}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
