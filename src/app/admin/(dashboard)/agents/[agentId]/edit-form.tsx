"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardHeader, CardTitle, CardContent } from "@/components/ui/card";

interface Agent {
  id: string;
  name: string;
  model: string;
  permission_mode: string;
  max_turns: number;
  max_budget_usd: number;
}

export function AgentEditForm({ agent }: { agent: Agent }) {
  const router = useRouter();
  const [name, setName] = useState(agent.name);
  const [model, setModel] = useState(agent.model);
  const [permissionMode, setPermissionMode] = useState(agent.permission_mode);
  const [maxTurns, setMaxTurns] = useState(agent.max_turns.toString());
  const [maxBudget, setMaxBudget] = useState(agent.max_budget_usd.toString());
  const [saving, setSaving] = useState(false);

  async function handleSave() {
    setSaving(true);
    try {
      await fetch(`/api/admin/agents/${agent.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          model,
          permission_mode: permissionMode,
          max_turns: parseInt(maxTurns),
          max_budget_usd: parseFloat(maxBudget),
        }),
      });
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Edit Agent</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="grid grid-cols-5 gap-4">
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Name</label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Model</label>
            <select
              value={model}
              onChange={(e) => setModel(e.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
            >
              <option value="claude-opus-4-6">claude-opus-4-6</option>
              <option value="claude-sonnet-4-5-20250929">claude-sonnet-4-5-20250929</option>
              <option value="claude-haiku-4-5-20251001">claude-haiku-4-5-20251001</option>
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Permission Mode</label>
            <select
              value={permissionMode}
              onChange={(e) => setPermissionMode(e.target.value)}
              className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm"
            >
              <option value="default">default</option>
              <option value="acceptEdits">acceptEdits</option>
              <option value="bypassPermissions">bypassPermissions</option>
              <option value="plan">plan</option>
            </select>
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Max Turns</label>
            <Input type="number" min="1" max="1000" value={maxTurns} onChange={(e) => setMaxTurns(e.target.value)} />
          </div>
          <div className="space-y-1">
            <label className="text-xs font-medium text-muted-foreground">Max Budget (USD)</label>
            <Input type="number" step="0.01" min="0.01" max="100" value={maxBudget} onChange={(e) => setMaxBudget(e.target.value)} />
          </div>
        </div>
        <div className="mt-4">
          <Button onClick={handleSave} disabled={saving} size="sm">
            {saving ? "Saving..." : "Save Changes"}
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
