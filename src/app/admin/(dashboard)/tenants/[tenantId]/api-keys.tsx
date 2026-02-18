"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";

interface ApiKey {
  id: string;
  name: string;
  key_prefix: string;
  scopes: string[];
  last_used_at: string | null;
  expires_at: string | null;
  revoked_at: string | null;
  created_at: string;
}

export function ApiKeysSection({ tenantId, initialKeys }: { tenantId: string; initialKeys: ApiKey[] }) {
  const router = useRouter();
  const [creating, setCreating] = useState(false);
  const [newKeyName, setNewKeyName] = useState("default");
  const [showCreate, setShowCreate] = useState(false);
  const [rawKey, setRawKey] = useState<string | null>(null);
  const [revokingId, setRevokingId] = useState<string | null>(null);

  async function handleCreate() {
    setCreating(true);
    try {
      const res = await fetch(`/api/admin/tenants/${tenantId}/keys`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ name: newKeyName }),
      });
      const data = await res.json();
      setRawKey(data.key);
      setShowCreate(false);
      setNewKeyName("default");
      router.refresh();
    } finally {
      setCreating(false);
    }
  }

  async function handleRevoke(keyId: string) {
    if (!confirm("Revoke this API key? This cannot be undone.")) return;
    setRevokingId(keyId);
    try {
      await fetch(`/api/admin/tenants/${tenantId}/keys/${keyId}`, { method: "DELETE" });
      router.refresh();
    } finally {
      setRevokingId(null);
    }
  }

  const activeKeys = initialKeys.filter((k) => !k.revoked_at);
  const revokedKeys = initialKeys.filter((k) => k.revoked_at);

  return (
    <div>
      <div className="flex items-center justify-between mb-3">
        <h2 className="text-lg font-semibold">API Keys</h2>
        <Button size="sm" onClick={() => setShowCreate(!showCreate)}>
          {showCreate ? "Cancel" : "Create Key"}
        </Button>
      </div>

      {rawKey && (
        <div className="mb-4 p-3 rounded-lg border border-yellow-500/50 bg-yellow-500/10">
          <p className="text-sm font-medium mb-1">New API key created — copy it now, it won&apos;t be shown again:</p>
          <code className="block text-xs font-mono bg-black/20 p-2 rounded break-all select-all">{rawKey}</code>
          <Button size="sm" variant="outline" className="mt-2" onClick={() => setRawKey(null)}>
            Dismiss
          </Button>
        </div>
      )}

      {showCreate && (
        <div className="mb-4 flex gap-2 items-end">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Key Name</label>
            <Input
              value={newKeyName}
              onChange={(e) => setNewKeyName(e.target.value)}
              placeholder="default"
              className="w-64"
            />
          </div>
          <Button size="sm" onClick={handleCreate} disabled={creating}>
            {creating ? "Creating..." : "Create"}
          </Button>
        </div>
      )}

      <div className="rounded-lg border border-border">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border bg-muted/50">
              <th className="text-left p-3 font-medium">Name</th>
              <th className="text-left p-3 font-medium">Prefix</th>
              <th className="text-left p-3 font-medium">Status</th>
              <th className="text-left p-3 font-medium">Last Used</th>
              <th className="text-left p-3 font-medium">Created</th>
              <th className="text-right p-3 font-medium"></th>
            </tr>
          </thead>
          <tbody>
            {activeKeys.map((k) => (
              <tr key={k.id} className="border-b border-border hover:bg-muted/30">
                <td className="p-3 font-medium">{k.name}</td>
                <td className="p-3 font-mono text-xs text-muted-foreground">{k.key_prefix}...</td>
                <td className="p-3"><Badge variant="default">active</Badge></td>
                <td className="p-3 text-muted-foreground text-xs">
                  {k.last_used_at ? new Date(k.last_used_at).toLocaleString() : "never"}
                </td>
                <td className="p-3 text-muted-foreground text-xs">{new Date(k.created_at).toLocaleDateString()}</td>
                <td className="p-3 text-right">
                  <Button
                    size="sm"
                    variant="destructive"
                    onClick={() => handleRevoke(k.id)}
                    disabled={revokingId === k.id}
                  >
                    {revokingId === k.id ? "Revoking..." : "Revoke"}
                  </Button>
                </td>
              </tr>
            ))}
            {revokedKeys.map((k) => (
              <tr key={k.id} className="border-b border-border opacity-50">
                <td className="p-3">{k.name}</td>
                <td className="p-3 font-mono text-xs text-muted-foreground">{k.key_prefix}...</td>
                <td className="p-3"><Badge variant="destructive">revoked</Badge></td>
                <td className="p-3 text-muted-foreground text-xs">
                  {k.last_used_at ? new Date(k.last_used_at).toLocaleString() : "never"}
                </td>
                <td className="p-3 text-muted-foreground text-xs">{new Date(k.created_at).toLocaleDateString()}</td>
                <td className="p-3"></td>
              </tr>
            ))}
            {initialKeys.length === 0 && (
              <tr><td colSpan={6} className="p-6 text-center text-muted-foreground">No API keys</td></tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
