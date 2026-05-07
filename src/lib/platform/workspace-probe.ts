/**
 * Workspace size probe — R19 attestation gate.
 *
 * Plan reference: U2 in
 * docs/plans/2026-05-06-001-feat-chat-platform-bots-discord-slack-plan.md
 *
 * For a freshly validated bot token, count the size of the workspace it can
 * reach. The R19 gate refuses to persist credentials when the count exceeds
 * `tenants.max_trusted_members` (default 100).
 *
 *   Discord: enumerate the application's guilds via `GET /users/@me/guilds`
 *            (with_counts=true). Sum `approximate_member_count` across
 *            guilds the bot is in. If the bot has not been added to any
 *            guild yet, returns memberCount=0 with a `pending_install` note.
 *   Slack:   call `users.list?limit=1000` and read the result page; for the
 *            common case of small workspaces this returns the full member
 *            count in one round trip.
 *
 * Failures (HTTP errors, rate limits, parse errors) return
 * `{ probed: false, reason }` so the caller can surface a retry-able error
 * rather than silently accepting the connect.
 */

import type { PlatformCredentials } from "@/lib/platform/operations";

const PROBE_TIMEOUT_MS = 5_000;

export type WorkspaceProbeResult =
  | { probed: true; memberCount: number; label: string | null }
  | { probed: false; reason: string };

interface DiscordGuild {
  id: string;
  name: string;
  approximate_member_count?: number;
}

interface SlackUser {
  id: string;
  deleted: boolean;
  is_bot: boolean;
}

async function fetchWithTimeout(url: string, init: RequestInit & { signal?: AbortSignal } = {}): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    return await fetch(url, { ...init, redirect: "error", signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }
}

async function probeDiscord(token: string): Promise<WorkspaceProbeResult> {
  let res: Response;
  try {
    res = await fetchWithTimeout("https://discord.com/api/v10/users/@me/guilds?with_counts=true&limit=200", {
      headers: { Authorization: `Bot ${token}` },
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return { probed: false, reason: "discord_timeout" };
    return { probed: false, reason: `discord_fetch_error:${err instanceof Error ? err.message : String(err)}` };
  }
  if (!res.ok) {
    return { probed: false, reason: `discord_http_${res.status}` };
  }
  const guilds = (await res.json()) as DiscordGuild[];
  if (!Array.isArray(guilds) || guilds.length === 0) {
    // Bot validated successfully but isn't in any guild yet — operator
    // hasn't completed the OAuth install. Treat as 0 members; the gate
    // accepts this (user must install AFTER connect, but the threshold
    // check is moot until they do).
    return { probed: true, memberCount: 0, label: "pending_install" };
  }
  const memberCount = guilds.reduce((sum, g) => sum + (g.approximate_member_count ?? 0), 0);
  const label = guilds.length === 1
    ? guilds[0]!.name
    : `${guilds.length} guilds: ${guilds.map((g) => g.name).slice(0, 3).join(", ")}${guilds.length > 3 ? ", …" : ""}`;
  return { probed: true, memberCount, label };
}

async function probeSlack(token: string): Promise<WorkspaceProbeResult> {
  let res: Response;
  try {
    res = await fetchWithTimeout("https://slack.com/api/users.list?limit=1000", {
      method: "GET",
      headers: { Authorization: `Bearer ${token}` },
    });
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") return { probed: false, reason: "slack_timeout" };
    return { probed: false, reason: `slack_fetch_error:${err instanceof Error ? err.message : String(err)}` };
  }
  if (!res.ok) {
    return { probed: false, reason: `slack_http_${res.status}` };
  }
  const body = (await res.json()) as { ok: boolean; error?: string; members?: SlackUser[]; response_metadata?: { next_cursor?: string } };
  if (!body.ok) {
    return { probed: false, reason: `slack_${body.error ?? "users_list_failed"}` };
  }
  // Count active human members. Bots and deactivated accounts don't count
  // toward the trusted-member threshold; the threshold is "humans who can
  // mention the bot in a channel".
  const members = (body.members ?? []).filter((u) => !u.deleted && !u.is_bot);
  // If pagination is present, the workspace is plausibly larger than the
  // page cap (1000). Pessimistically treat as 1000+ — this trips the
  // default 100 threshold and forces explicit operator override.
  const hasMorePages = Boolean(body.response_metadata?.next_cursor);
  const memberCount = hasMorePages ? Math.max(members.length, 1001) : members.length;
  return { probed: true, memberCount, label: hasMorePages ? "1000+ members" : `${memberCount} members` };
}

export async function probeWorkspaceSize(
  credentials: PlatformCredentials,
  identity: Record<string, unknown>,
): Promise<WorkspaceProbeResult> {
  // identity is reserved for future probes that can derive workspace size
  // from the validate-credentials response (e.g., Slack `team` field) without
  // a second round trip. Today we always probe.
  void identity;
  if (credentials.platform === "discord") {
    return probeDiscord(credentials.botToken);
  }
  return probeSlack(credentials.botToken);
}
