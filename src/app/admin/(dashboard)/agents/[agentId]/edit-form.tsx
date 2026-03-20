"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { SectionHeader } from "@/components/ui/section-header";
import { FormField } from "@/components/ui/form-field";
import { ModelSelector } from "@/components/model-selector";
import { supportsClaudeRunner } from "@/lib/models";

interface Agent {
  id: string;
  name: string;
  description: string | null;
  model: string;
  runner: string | null;
  permission_mode: string;
  max_turns: number;
  max_budget_usd: number;
  max_runtime_seconds: number;
}

export function AgentEditForm({ agent }: { agent: Agent }) {
  const router = useRouter();
  const [name, setName] = useState(agent.name);
  const [description, setDescription] = useState(agent.description ?? "");
  const [model, setModel] = useState(agent.model);
  const [runner, setRunner] = useState(agent.runner ?? "");
  const [permissionMode, setPermissionMode] = useState(agent.permission_mode);
  const [maxTurns, setMaxTurns] = useState(agent.max_turns.toString());
  const [maxBudget, setMaxBudget] = useState(agent.max_budget_usd.toString());
  const [maxRuntime, setMaxRuntime] = useState(Math.floor(agent.max_runtime_seconds / 60).toString());
  const [saving, setSaving] = useState(false);

  const isDirty =
    name !== agent.name ||
    description !== (agent.description ?? "") ||
    model !== agent.model ||
    runner !== (agent.runner ?? "") ||
    permissionMode !== agent.permission_mode ||
    maxTurns !== agent.max_turns.toString() ||
    maxBudget !== agent.max_budget_usd.toString() ||
    maxRuntime !== Math.floor(agent.max_runtime_seconds / 60).toString();

  async function handleSave() {
    setSaving(true);
    try {
      await fetch(`/api/admin/agents/${agent.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name,
          description: description || null,
          model,
          runner: runner || null,
          permission_mode: permissionMode,
          max_turns: parseInt(maxTurns),
          max_budget_usd: parseFloat(maxBudget),
          max_runtime_seconds: parseInt(maxRuntime) * 60,
        }),
      });
      router.refresh();
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="rounded-lg border border-muted-foreground/25 p-5">
      <SectionHeader title="Details">
        <Button onClick={handleSave} disabled={saving || !isDirty} size="sm">
          {saving ? "Saving..." : "Save Changes"}
        </Button>
      </SectionHeader>
      <div>
        <div className="grid grid-cols-12 gap-4">
          <div className="col-span-2">
            <FormField label="Name">
              <Input value={name} onChange={(e) => setName(e.target.value)} disabled={saving} />
            </FormField>
          </div>
          <div className="col-span-3">
            <FormField label="Description">
              <Input
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What does this agent do?"
                disabled={saving}
              />
            </FormField>
          </div>
          <div className="col-span-2">
            <FormField label="Model">
              <ModelSelector
                value={model}
                disabled={saving}
                onChange={(modelId) => {
                  setModel(modelId);
                  if (!supportsClaudeRunner(modelId)) {
                    setRunner("vercel-ai-sdk");
                    setPermissionMode("bypassPermissions");
                  }
                }}
              />
            </FormField>
          </div>
          <div className="col-span-1">
            <FormField label="Runner">
              {supportsClaudeRunner(model) ? (
                <Select value={runner || "claude-agent-sdk"} onChange={(e) => setRunner(e.target.value === "claude-agent-sdk" ? "" : e.target.value)} disabled={saving}>
                  <option value="claude-agent-sdk">Claude SDK</option>
                  <option value="vercel-ai-sdk">AI SDK</option>
                </Select>
              ) : (
                <Select value="vercel-ai-sdk" disabled>
                  <option value="vercel-ai-sdk">AI SDK</option>
                </Select>
              )}
            </FormField>
          </div>
          <div className="col-span-1">
            <FormField label="Max Turns">
              <Input type="number" min="1" max="1000" value={maxTurns} onChange={(e) => setMaxTurns(e.target.value)} disabled={saving} />
            </FormField>
          </div>
          <div className="col-span-1">
            <FormField label="Max Budget">
              <div className="relative">
                <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
                <Input type="number" step="0.01" min="0.01" max="100" value={maxBudget} onChange={(e) => setMaxBudget(e.target.value)} className="pl-6" disabled={saving} />
              </div>
            </FormField>
          </div>
          <div className="col-span-1">
            <FormField label="Max Runtime">
              <div className="relative">
                <Input type="number" min="1" max="60" value={maxRuntime} onChange={(e) => setMaxRuntime(e.target.value)} className="pr-10" disabled={saving} />
                <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">min</span>
              </div>
            </FormField>
          </div>
          {(supportsClaudeRunner(model) && (runner === "" || runner === "claude-agent-sdk")) && (
            <div className="col-span-2">
              <FormField label="Permission Mode">
                <Select value={permissionMode} onChange={(e) => setPermissionMode(e.target.value)} disabled={saving}>
                  <option value="default">default</option>
                  <option value="acceptEdits">acceptEdits</option>
                  <option value="bypassPermissions">bypassPermissions</option>
                  <option value="plan">plan</option>
                </Select>
              </FormField>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
