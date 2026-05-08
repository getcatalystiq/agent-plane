"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { FormField } from "@/components/ui/form-field";
import { adminFetch } from "@/app/admin/lib/api";

interface SlackAlertsSectionProps {
  tenantId: string;
  hasWebhook: boolean;
}

type TestState =
  | { kind: "idle" }
  | { kind: "running" }
  | { kind: "ok" }
  | { kind: "error"; message: string };

export function SlackAlertsSection({
  tenantId,
  hasWebhook: initialHasWebhook,
}: SlackAlertsSectionProps) {
  const router = useRouter();
  const [url, setUrl] = useState("");
  const [hasWebhook, setHasWebhook] = useState(initialHasWebhook);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [testState, setTestState] = useState<TestState>({ kind: "idle" });

  async function handleSave() {
    if (!url.trim()) return;
    setSaving(true);
    setError("");
    setTestState({ kind: "idle" });
    try {
      await adminFetch(`/tenants/${tenantId}`, {
        method: "PATCH",
        body: JSON.stringify({ slack_alert_webhook_url: url.trim() }),
      });
      setHasWebhook(true);
      setUrl("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save webhook URL");
    } finally {
      setSaving(false);
    }
  }

  async function handleClear() {
    setSaving(true);
    setError("");
    setTestState({ kind: "idle" });
    try {
      await adminFetch(`/tenants/${tenantId}`, {
        method: "PATCH",
        body: JSON.stringify({ slack_alert_webhook_url: "" }),
      });
      setHasWebhook(false);
      setUrl("");
      router.refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to clear webhook URL");
    } finally {
      setSaving(false);
    }
  }

  async function handleSendTest() {
    setTestState({ kind: "running" });
    try {
      const result = (await adminFetch(
        `/tenants/${tenantId}/slack-alerts/test`,
        { method: "POST" },
      )) as { ok: boolean; status?: number | string; message?: string };
      if (result.ok) {
        setTestState({ kind: "ok" });
      } else {
        setTestState({
          kind: "error",
          message:
            result.message ?? `Slack returned ${result.status ?? "unknown"}`,
        });
      }
    } catch (err) {
      setTestState({
        kind: "error",
        message: err instanceof Error ? err.message : "Test alert failed",
      });
    } finally {
      setTimeout(() => setTestState({ kind: "idle" }), 5000);
    }
  }

  return (
    <div className="rounded-lg border border-muted-foreground/25 p-5">
      <div className="flex items-center gap-2 mb-3">
        <h2 className="text-lg font-semibold">Slack Alerts</h2>
        {hasWebhook && <Badge variant="default">Connected</Badge>}
      </div>
      <p className="text-sm text-muted-foreground mb-4">
        Receive a Slack notification when a custom MCP connection fails. We
        only alert on the transition from active to failed — not on every
        retry.
      </p>
      {error && <p className="text-sm text-destructive mb-3">{error}</p>}
      {testState.kind === "ok" && (
        <p className="text-sm text-emerald-600 mb-3">
          Test alert sent. Check your Slack channel.
        </p>
      )}
      {testState.kind === "error" && (
        <p className="text-sm text-destructive mb-3">
          Test failed: {testState.message}
        </p>
      )}
      <div className="max-w-md">
        <FormField label="Incoming Webhook URL">
          <div className="flex gap-2">
            <Input
              type="password"
              placeholder={
                hasWebhook
                  ? "https://hooks.slack.com/services/T•••/B•••/•••"
                  : "https://hooks.slack.com/services/..."
              }
              value={url}
              onChange={(e) => setUrl(e.target.value)}
            />
            {hasWebhook && (
              <Button
                size="sm"
                variant="outline"
                onClick={handleClear}
                disabled={saving || testState.kind === "running"}
              >
                Clear
              </Button>
            )}
          </div>
        </FormField>
      </div>
      <div className="mt-3 flex gap-2">
        {url.trim() && (
          <Button size="sm" onClick={handleSave} disabled={saving}>
            {saving ? "Saving..." : "Save URL"}
          </Button>
        )}
        {hasWebhook && !url.trim() && (
          <Button
            size="sm"
            variant="outline"
            onClick={handleSendTest}
            disabled={testState.kind === "running" || saving}
          >
            {testState.kind === "running" ? "Sending..." : "Send test alert"}
          </Button>
        )}
      </div>
    </div>
  );
}
