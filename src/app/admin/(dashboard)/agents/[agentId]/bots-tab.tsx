"use client";

import { useState, useEffect, useCallback } from "react";
import { CopyButton } from "@/components/ui/copy-button";

/**
 * Admin Bots tab — Discord + Slack per-agent bot configuration.
 *
 * Plan reference: U8 in
 * docs/plans/2026-05-06-001-feat-chat-platform-bots-discord-slack-plan.md
 *
 * Six derived connection states:
 *   - Not configured (no row)
 *   - Disabled (enabled=false)
 *   - Connected (last_connected_at set, recent last_event_at, no error)
 *   - Connected — no events received (5 min after connect, no event_at)
 *   - Token rejected (last_error set)
 *   - Pending validation (between save and last_connected_at)
 *
 * Threat-model gate: a confirmation dialog fires on first save requiring
 * the operator to acknowledge the private/trusted-workspace boundary.
 */

type Platform = "discord" | "slack";

interface BotConfig {
  id: string;
  platform: Platform;
  last4: string;
  credentials_version: number;
  platform_identity: Record<string, unknown>;
  attestations: { private_workspace: boolean; attested_at: string | null };
  enabled: boolean;
  last_event_at: string | null;
  last_error: string | null;
  last_connected_at: string | null;
}

type ConnectionState =
  | "not_configured"
  | "disabled"
  | "connected"
  | "no_events"
  | "token_rejected"
  | "pending_validation"
  | "refreshing";

function deriveState(config: BotConfig | null, refreshing: boolean): ConnectionState {
  if (refreshing) return "refreshing";
  if (!config) return "not_configured";
  if (!config.enabled) return "disabled";
  if (config.last_error) return "token_rejected";
  if (!config.last_connected_at) return "pending_validation";
  if (!config.last_event_at) {
    const since = Date.now() - new Date(config.last_connected_at).getTime();
    if (since > 5 * 60 * 1000) return "no_events";
  }
  return "connected";
}

interface BotsTabProps {
  agentId: string;
  webhookBaseUrl: string;
}

export function BotsTab({ agentId, webhookBaseUrl }: BotsTabProps) {
  const [discord, setDiscord] = useState<BotConfig | null>(null);
  const [slack, setSlack] = useState<BotConfig | null>(null);
  const [loading, setLoading] = useState(true);

  const slackWebhookUrl = `${webhookBaseUrl}/api/webhooks/slack`;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [d, s] = await Promise.all([
        fetch(`/api/admin/agents/${agentId}/platforms/discord`).then((r) =>
          r.ok ? r.json() : { config: null },
        ),
        fetch(`/api/admin/agents/${agentId}/platforms/slack`).then((r) =>
          r.ok ? r.json() : { config: null },
        ),
      ]);
      setDiscord(d.config ?? null);
      setSlack(s.config ?? null);
    } finally {
      setLoading(false);
    }
  }, [agentId]);

  useEffect(() => {
    load();
  }, [load]);

  // Auto-refresh while in pending_validation state.
  useEffect(() => {
    const states = [discord, slack].map((c) => deriveState(c, false));
    if (!states.includes("pending_validation")) return;
    const timer = setInterval(load, 30_000);
    return () => clearInterval(timer);
  }, [discord, slack, load]);

  return (
    <div className="space-y-6">
      <ThreatModelBanner />
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <BotCard
          platform="discord"
          config={discord}
          loading={loading}
          agentId={agentId}
          onChange={load}
        />
        <BotCard
          platform="slack"
          config={slack}
          loading={loading}
          agentId={agentId}
          onChange={load}
          slackWebhookUrl={slackWebhookUrl}
        />
      </div>
    </div>
  );
}

function ThreatModelBanner() {
  return (
    <div className="rounded-md border border-yellow-700/40 bg-yellow-900/20 p-4 text-sm text-yellow-100">
      <strong className="font-semibold">Private / trusted workspaces only.</strong>{" "}
      Chat support is gated to workspaces ≤100 members at connect time. Do not
      connect agents with sensitive tool access (database writes, financial
      integrations, customer PII) to public Discord servers or shared Slack
      workspaces. The injection-scanner is deferred; trust boundaries today
      depend on the workspace itself being trusted.
    </div>
  );
}

interface BotCardProps {
  platform: Platform;
  config: BotConfig | null;
  loading: boolean;
  agentId: string;
  onChange: () => void;
  slackWebhookUrl?: string;
}

function BotCard({ platform, config, loading, agentId, onChange, slackWebhookUrl }: BotCardProps) {
  const [refreshing, setRefreshing] = useState(false);
  const [showForm, setShowForm] = useState(false);
  const state = deriveState(config, refreshing);

  return (
    <div className="rounded-md border border-border bg-card p-5 space-y-4">
      <div className="flex items-center justify-between">
        <h3 className="text-base font-medium capitalize">{platform}</h3>
        <ConnectionChip state={state} />
      </div>

      {platform === "slack" && slackWebhookUrl && (
        <div className="space-y-3">
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">Slack Events API webhook URL</label>
            <div className="flex gap-2 items-center">
              <code className="text-xs bg-muted px-2 py-1 rounded flex-1 overflow-x-auto whitespace-nowrap">
                {slackWebhookUrl}
              </code>
              <CopyButton text={slackWebhookUrl} />
            </div>
          </div>
          <details className="text-xs space-y-2 rounded-md border border-border bg-muted/30 p-3" open={!config}>
            <summary className="cursor-pointer font-medium text-foreground">
              Slack app setup checklist
            </summary>
            <ol className="space-y-2 mt-2 ml-4 list-decimal text-muted-foreground">
              <li>
                <a href="https://api.slack.com/apps" target="_blank" rel="noopener noreferrer" className="underline hover:text-foreground">
                  api.slack.com/apps
                </a>
                {" "}→ your app → <strong className="text-foreground">Event Subscriptions</strong> →
                paste the URL above into <strong className="text-foreground">Request URL</strong>. Wait for ✓ Verified.
              </li>
              <li>
                Same page → <strong className="text-foreground">Subscribe to bot events</strong> →
                add these (without them, Slack sends no events to your webhook):
                <ul className="ml-5 mt-1 list-disc space-y-0.5">
                  <li><code className="text-foreground">app_mention</code> — required, fires on @mentions</li>
                  <li><code className="text-foreground">message.channels</code> — public-channel thread follow-ups</li>
                  <li><code className="text-foreground">message.groups</code> — private-channel thread follow-ups</li>
                  <li><code className="text-foreground">message.im</code> — optional, DMs to the bot</li>
                </ul>
              </li>
              <li>
                <strong className="text-foreground">OAuth & Permissions</strong> → Bot Token Scopes must include:
                <code className="ml-1 text-foreground">app_mentions:read</code>,
                <code className="ml-1 text-foreground">chat:write</code>,
                <code className="ml-1 text-foreground">channels:history</code>,
                <code className="ml-1 text-foreground">groups:history</code>
                {", "}<code className="text-foreground">im:history</code> (if using DMs).
              </li>
              <li>
                <strong className="text-foreground">Reinstall to Workspace</strong> after adding scopes or events.
                Without reinstall, scopes show in the UI but Slack fires no events.
              </li>
              <li>
                In your Slack channel: <code className="text-foreground">/invite @YourBot</code>, then
                {" "}<strong className="text-foreground">@mention</strong> the bot — type <code className="text-foreground">@</code> and select the bot from the autocomplete (plain text won't fire <code className="text-foreground">app_mention</code>).
              </li>
            </ol>
          </details>
        </div>
      )}

      {config && (
        <dl className="text-sm space-y-1">
          <div className="flex justify-between">
            <dt className="text-muted-foreground">Bot token</dt>
            <dd>
              <code className="text-xs">{config.last4}</code>
            </dd>
          </div>
          {config.last_connected_at && (
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Last connected</dt>
              <dd>{new Date(config.last_connected_at).toLocaleString()}</dd>
            </div>
          )}
          {config.last_event_at && (
            <div className="flex justify-between">
              <dt className="text-muted-foreground">Last event</dt>
              <dd>{new Date(config.last_event_at).toLocaleString()}</dd>
            </div>
          )}
        </dl>
      )}

      {state === "no_events" && (
        <NoEventsHint platform={platform} />
      )}

      {state === "token_rejected" && config?.last_error && (
        <div className="rounded border border-red-700/40 bg-red-900/20 p-3 text-sm">
          <strong>Token rejected:</strong> {config.last_error}
        </div>
      )}

      <div className="flex gap-2 flex-wrap">
        {!config && (
          <button
            type="button"
            onClick={() => setShowForm(true)}
            className="px-3 py-1.5 text-sm rounded bg-primary text-primary-foreground hover:opacity-90"
          >
            Connect
          </button>
        )}
        {config && config.enabled && (
          <>
            <button
              type="button"
              onClick={() => setShowForm(true)}
              className="px-3 py-1.5 text-sm rounded bg-secondary text-secondary-foreground"
            >
              Rotate Token
            </button>
            <button
              type="button"
              onClick={async () => {
                if (!confirm("Disable this bot? It will stop receiving messages until re-enabled.")) return;
                setRefreshing(true);
                await fetch(`/api/admin/agents/${agentId}/platforms/${platform}`, { method: "DELETE" });
                await onChange();
                setRefreshing(false);
              }}
              className="px-3 py-1.5 text-sm rounded border border-border"
            >
              Disable
            </button>
          </>
        )}
        {config && !config.enabled && (
          <button
            type="button"
            onClick={() => setShowForm(true)}
            className="px-3 py-1.5 text-sm rounded bg-secondary text-secondary-foreground"
          >
            Re-enable
          </button>
        )}
      </div>

      {showForm && (
        <ConnectForm
          platform={platform}
          agentId={agentId}
          onClose={() => setShowForm(false)}
          onSuccess={async () => {
            setShowForm(false);
            setRefreshing(true);
            await onChange();
            // Brief refreshing window covers the cache eviction.
            setTimeout(() => setRefreshing(false), 1500);
          }}
        />
      )}

      {loading && <p className="text-xs text-muted-foreground">Loading...</p>}
    </div>
  );
}

function ConnectionChip({ state }: { state: ConnectionState }) {
  const colors: Record<ConnectionState, string> = {
    not_configured: "bg-muted text-muted-foreground",
    disabled: "bg-muted text-muted-foreground border border-dashed border-border",
    connected: "bg-green-900/30 text-green-300",
    no_events: "bg-yellow-900/30 text-yellow-300",
    token_rejected: "bg-red-900/30 text-red-300",
    pending_validation: "bg-blue-900/30 text-blue-300",
    refreshing: "bg-blue-900/30 text-blue-300",
  };
  const labels: Record<ConnectionState, string> = {
    not_configured: "Not configured",
    disabled: "Disabled",
    connected: "Connected",
    no_events: "Connected — no events received",
    token_rejected: "Token rejected",
    pending_validation: "Pending validation (within 9 min)",
    refreshing: "Refreshing…",
  };
  return (
    <span className={`text-xs px-2 py-0.5 rounded-full ${colors[state]}`}>
      {labels[state]}
    </span>
  );
}

function NoEventsHint({ platform }: { platform: Platform }) {
  const text = platform === "discord"
    ? {
        msg: "Bot connected but no events received. Enable the MESSAGE_CONTENT privileged intent in the Discord Developer Portal under Bot → Privileged Gateway Intents.",
        href: "https://discord.com/developers/applications",
        label: "Open Discord Developer Portal",
      }
    : {
        msg: "Bot connected but no events received. Make sure the bot is invited to a channel and your Events API endpoint is configured at api.slack.com.",
        href: "https://api.slack.com/apps",
        label: "Open Slack app config",
      };
  return (
    <div className="rounded border border-yellow-700/40 bg-yellow-900/15 p-3 text-sm space-y-1">
      <p>{text.msg}</p>
      <a
        href={text.href}
        target="_blank"
        rel="noreferrer"
        className="text-yellow-200 underline text-xs"
      >
        {text.label} →
      </a>
    </div>
  );
}

function ConnectForm({
  platform,
  agentId,
  onClose,
  onSuccess,
}: {
  platform: Platform;
  agentId: string;
  onClose: () => void;
  onSuccess: () => Promise<void>;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [attest, setAttest] = useState(false);

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (!attest) {
      setError("You must attest that this is a private/trusted workspace.");
      return;
    }
    setError(null);
    setSubmitting(true);
    const fd = new FormData(e.currentTarget);
    const credentials = platform === "discord"
      ? {
          platform: "discord" as const,
          botToken: String(fd.get("botToken") ?? ""),
          publicKey: String(fd.get("publicKey") ?? ""),
          applicationId: String(fd.get("applicationId") ?? ""),
        }
      : {
          platform: "slack" as const,
          botToken: String(fd.get("botToken") ?? ""),
          signingSecret: String(fd.get("signingSecret") ?? ""),
        };
    try {
      const res = await fetch(`/api/admin/agents/${agentId}/platforms/${platform}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ credentials, attestations: { private_workspace: true } }),
      });
      if (!res.ok) {
        // Round-5 review #7: read the structured error code so cap-exceeded
        // (409) renders an actionable hint instead of just the message.
        const body = (await res.json().catch(() => ({}))) as {
          error?: { code?: string; message?: string; platform?: string; limit?: number };
        };
        if (body.error?.code === "tenant_bot_cap_exceeded" && body.error.limit != null) {
          setError(
            `${body.error.message} You're at ${body.error.limit}/${body.error.limit} ${body.error.platform ?? ""} bots — disable one in the list above before connecting another.`,
          );
        } else {
          setError(body.error?.message ?? `HTTP ${res.status}`);
        }
        return;
      }
      await onSuccess();
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form onSubmit={handleSubmit} className="space-y-3 border-t border-border pt-3">
      <div className="space-y-1">
        <label className="text-xs text-muted-foreground">Bot Token</label>
        <input
          name="botToken"
          required
          type="password"
          autoComplete="off"
          placeholder={platform === "discord" ? "MTI3..." : "xoxb-..."}
          className="w-full px-2 py-1 text-sm bg-background border border-border rounded font-mono"
        />
      </div>
      {platform === "discord" && (
        <>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">
              Application ID — Developer Portal → General Information
            </label>
            <input
              name="applicationId"
              required
              type="text"
              className="w-full px-2 py-1 text-sm bg-background border border-border rounded font-mono"
            />
          </div>
          <div className="space-y-1">
            <label className="text-xs text-muted-foreground">
              Public Key — Developer Portal → General Information
            </label>
            <input
              name="publicKey"
              required
              type="text"
              className="w-full px-2 py-1 text-sm bg-background border border-border rounded font-mono"
            />
          </div>
        </>
      )}
      {platform === "slack" && (
        <div className="space-y-1">
          <label className="text-xs text-muted-foreground">
            Signing Secret — Slack app config → Basic Information → App Credentials
          </label>
          <input
            name="signingSecret"
            required
            type="password"
            autoComplete="off"
            className="w-full px-2 py-1 text-sm bg-background border border-border rounded font-mono"
          />
        </div>
      )}
      <label className="flex items-start gap-2 text-xs text-muted-foreground">
        <input type="checkbox" checked={attest} onChange={(e) => setAttest(e.target.checked)} className="mt-0.5" />
        <span>
          I attest this is a private / trusted workspace (≤100 members) and
          I will not connect agents with sensitive tool access to public
          channels.
        </span>
      </label>
      {error && (
        <div className="text-xs text-red-300 bg-red-900/20 border border-red-700/40 p-2 rounded">{error}</div>
      )}
      <div className="flex gap-2">
        <button
          type="submit"
          disabled={submitting}
          className="px-3 py-1.5 text-sm rounded bg-primary text-primary-foreground disabled:opacity-50"
        >
          {submitting ? "Validating…" : "Save"}
        </button>
        <button
          type="button"
          onClick={onClose}
          className="px-3 py-1.5 text-sm rounded border border-border"
        >
          Cancel
        </button>
      </div>
    </form>
  );
}
