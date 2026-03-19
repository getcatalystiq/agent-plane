"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select } from "@/components/ui/select";
import { Dialog, DialogContent, DialogHeader, DialogBody, DialogFooter, DialogTitle } from "@/components/ui/dialog";
import { FormField } from "@/components/ui/form-field";
import { FormError } from "@/components/ui/form-error";

const MODEL_GROUPS = [
  { provider: "Anthropic", models: [
    { value: "claude-sonnet-4-6", label: "Claude Sonnet 4.6" },
    { value: "claude-opus-4-6", label: "Claude Opus 4.6" },
    { value: "claude-haiku-4-5-20251001", label: "Claude Haiku 4.5" },
  ]},
  { provider: "OpenAI", models: [
    { value: "openai/gpt-4o", label: "GPT-4o" },
    { value: "openai/gpt-4o-mini", label: "GPT-4o Mini" },
    { value: "openai/o3", label: "o3" },
  ]},
  { provider: "Google", models: [
    { value: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro" },
    { value: "google/gemini-2.5-flash", label: "Gemini 2.5 Flash" },
  ]},
  { provider: "Other", models: [
    { value: "mistral/mistral-large", label: "Mistral Large" },
    { value: "xai/grok-3", label: "Grok 3" },
    { value: "deepseek/deepseek-chat", label: "DeepSeek Chat" },
  ]},
];

function isClaudeModel(model: string): boolean {
  return !model.includes("/") || model.startsWith("anthropic/");
}

interface Tenant {
  id: string;
  name: string;
}

interface Props {
  tenants: Tenant[];
  defaultTenantId?: string;
}

export function AddAgentForm({ tenants, defaultTenantId }: Props) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState({
    tenant_id: defaultTenantId ?? tenants[0]?.id ?? "",
    name: "",
    description: "",
    model: "claude-sonnet-4-6",
    runner: "" as string, // empty = use default for model
    permission_mode: "bypassPermissions",
    max_turns: "100",
    max_budget_usd: "1.00",
    max_runtime_minutes: "10",
  });

  function resetForm() {
    setForm({
      tenant_id: defaultTenantId ?? tenants[0]?.id ?? "",
      name: "",
      description: "",
      model: "claude-sonnet-4-6",
      runner: "",
      permission_mode: "bypassPermissions",
      max_turns: "100",
      max_budget_usd: "1.00",
      max_runtime_minutes: "10",
    });
    setError("");
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    setSaving(true);
    setError("");
    try {
      const res = await fetch("/api/admin/agents", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          tenant_id: form.tenant_id,
          name: form.name,
          description: form.description || null,
          model: form.model,
          runner: form.runner || null,
          permission_mode: form.permission_mode,
          max_turns: parseInt(form.max_turns),
          max_budget_usd: parseFloat(form.max_budget_usd),
          max_runtime_seconds: parseInt(form.max_runtime_minutes) * 60,
        }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.error?.message ?? `Error ${res.status}`);
        return;
      }
      setOpen(false);
      resetForm();
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unknown error");
    } finally {
      setSaving(false);
    }
  }

  return (
    <>
      <Button size="sm" onClick={() => setOpen(true)}>Add Agent</Button>
      <Dialog open={open} onOpenChange={(v) => { setOpen(v); if (!v) resetForm(); }}>
        <DialogContent className="max-w-md">
          <form onSubmit={handleSubmit}>
            <DialogHeader>
              <DialogTitle>Add Agent</DialogTitle>
            </DialogHeader>
            <DialogBody className="space-y-3">
              {!defaultTenantId && (
                <FormField label="Tenant">
                  <Select
                    value={form.tenant_id}
                    onChange={(e) => setForm((f) => ({ ...f, tenant_id: e.target.value }))}
                    required
                  >
                    {tenants.map((t) => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </Select>
                </FormField>
              )}
              <FormField label="Name">
                <Input
                  value={form.name}
                  onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                  placeholder="my-agent"
                  required
                />
              </FormField>
              <FormField label="Description">
                <Input
                  value={form.description}
                  onChange={(e) => setForm((f) => ({ ...f, description: e.target.value }))}
                  placeholder="What does this agent do?"
                />
              </FormField>
              <FormField label="Model">
                <Select
                  value={form.model}
                  onChange={(e) => setForm((f) => ({
                    ...f,
                    model: e.target.value,
                    runner: isClaudeModel(e.target.value) ? f.runner : "vercel-ai-sdk",
                  }))}
                >
                  {MODEL_GROUPS.map((g) => (
                    <optgroup key={g.provider} label={g.provider}>
                      {g.models.map((m) => (
                        <option key={m.value} value={m.value}>{m.label}</option>
                      ))}
                    </optgroup>
                  ))}
                </Select>
              </FormField>
              <div className="grid grid-cols-2 gap-3">
                <FormField label="Runner">
                  {isClaudeModel(form.model) ? (
                    <Select
                      value={form.runner || "claude-agent-sdk"}
                      onChange={(e) => setForm((f) => ({ ...f, runner: e.target.value === "claude-agent-sdk" ? "" : e.target.value }))}
                    >
                      <option value="claude-agent-sdk">Claude Agent SDK</option>
                      <option value="vercel-ai-sdk">Vercel AI SDK</option>
                    </Select>
                  ) : (
                    <Select value="vercel-ai-sdk" disabled>
                      <option value="vercel-ai-sdk">Vercel AI SDK</option>
                    </Select>
                  )}
                </FormField>
                <FormField label="Permission Mode">
                  <Select
                    value={form.permission_mode}
                    onChange={(e) => setForm((f) => ({ ...f, permission_mode: e.target.value }))}
                    disabled={!isClaudeModel(form.model) || form.runner === "vercel-ai-sdk"}
                  >
                    <option value="default">default</option>
                    <option value="acceptEdits">acceptEdits</option>
                    <option value="bypassPermissions">bypassPermissions</option>
                    <option value="plan">plan</option>
                  </Select>
                </FormField>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <FormField label="Max Turns">
                  <Input
                    type="number"
                    min="1"
                    max="1000"
                    value={form.max_turns}
                    onChange={(e) => setForm((f) => ({ ...f, max_turns: e.target.value }))}
                    required
                  />
                </FormField>
                <FormField label="Max Budget">
                  <div className="relative">
                    <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">$</span>
                    <Input
                      type="number"
                      step="0.01"
                      min="0.01"
                      max="100"
                      value={form.max_budget_usd}
                      onChange={(e) => setForm((f) => ({ ...f, max_budget_usd: e.target.value }))}
                      className="pl-6"
                      required
                    />
                  </div>
                </FormField>
                <FormField label="Max Runtime">
                  <div className="relative">
                    <Input
                      type="number"
                      min="1"
                      max="60"
                      value={form.max_runtime_minutes}
                      onChange={(e) => setForm((f) => ({ ...f, max_runtime_minutes: e.target.value }))}
                      className="pr-10"
                      required
                    />
                    <span className="absolute right-3 top-1/2 -translate-y-1/2 text-sm text-muted-foreground">min</span>
                  </div>
                </FormField>
              </div>
              <FormError error={error} />
            </DialogBody>
            <DialogFooter>
              <Button type="button" variant="outline" size="sm" onClick={() => { setOpen(false); resetForm(); }}>Cancel</Button>
              <Button type="submit" size="sm" disabled={saving}>
                {saving ? "Creating..." : "Create Agent"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}
