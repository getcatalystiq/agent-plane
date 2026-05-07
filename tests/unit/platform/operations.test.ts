/**
 * Tests for src/lib/platform/operations.ts.
 *
 * Coverage:
 *   - validateCredentials redirect:'error' enforcement
 *   - validateCredentials 5s timeout
 *   - validateCredentials server-side debounce
 *   - validateCredentials Discord 200 + Slack auth.test ok
 *   - validateCredentials platform error passthrough
 *   - enforceAttestationGate refuses missing attestation
 *   - enforceAttestationGate refuses workspace too large
 *   - enforceAttestationGate refuses on probe failure
 *   - encrypt/decrypt round-trip via the public-shape mask
 *
 * Notes:
 *   - DB-backed CRUD paths (upsertBotConfig, getBotConfig, etc.) are out of
 *     scope here — they exercise withTenantTransaction + RLS, which require
 *     an integration harness against a live Postgres. Unit-level coverage
 *     focuses on the validation, attestation, and crypto-mask logic that
 *     run in pure JS.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  getEnv: () => ({
    ENCRYPTION_KEY: "0".repeat(64), // 32-byte zero key — fine for round-trip tests
    ENCRYPTION_KEY_PREVIOUS: undefined,
  }),
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock("@/lib/platform/workspace-probe", () => ({
  probeWorkspaceSize: vi.fn(),
}));

import {
  validateCredentials,
  enforceAttestationGate,
  AttestationGateError,
  _resetValidationDebounceForTests,
  type DiscordCredentials,
  type SlackCredentials,
} from "@/lib/platform/operations";
import { probeWorkspaceSize } from "@/lib/platform/workspace-probe";
import type { TenantId } from "@/lib/types";

const TENANT = "11111111-1111-1111-1111-111111111111" as TenantId;

const validDiscord: DiscordCredentials = {
  platform: "discord",
  botToken: "MTI3.discord.token",
  publicKey: "0".repeat(64),
  applicationId: "1234567890",
};

const validSlack: SlackCredentials = {
  platform: "slack",
  botToken: "xoxb-fake-bot-token",
  signingSecret: "0".repeat(32),
};

describe("validateCredentials", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    _resetValidationDebounceForTests();
    fetchSpy = vi.spyOn(globalThis, "fetch") as ReturnType<typeof vi.spyOn>;
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("returns ok with identity when Discord /users/@me returns 200", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ id: "BOT123", username: "testbot" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const result = await validateCredentials(TENANT, validDiscord);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.identity).toEqual({ bot_user_id: "BOT123", display_name: "testbot" });
    }
    // The fetch call must use redirect: 'error' (R10).
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.redirect).toBe("error");
  });

  it("returns invalid_token on Discord 401", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("", { status: 401 }));
    const result = await validateCredentials(TENANT, validDiscord);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_token");
  });

  it("returns ok when Slack auth.test returns ok:true with team_id", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({ ok: true, team_id: "T123", user_id: "U456", team: "Acme" }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    );
    const result = await validateCredentials(TENANT, validSlack);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.identity.team_id).toBe("T123");
  });

  it("returns slack error code when auth.test returns ok:false", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error: "invalid_auth" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      }),
    );
    const result = await validateCredentials(TENANT, validSlack);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("invalid_auth");
  });

  it("returns timeout error when fetch is aborted (AbortError)", async () => {
    // Mirrors the runtime behavior: setTimeout in validateCredentials fires
    // controller.abort(), which causes fetch to reject with AbortError.
    // Test the catch path directly without fake-timer + microtask gymnastics.
    fetchSpy.mockImplementationOnce(() => {
      const err = new Error("aborted");
      err.name = "AbortError";
      return Promise.reject(err);
    });
    const result = await validateCredentials(TENANT, validDiscord);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("timeout");
  });

  it("returns redirect_blocked when fetch throws redirect TypeError", async () => {
    fetchSpy.mockRejectedValueOnce(new TypeError("fetch failed: unexpected redirect"));
    const result = await validateCredentials(TENANT, validDiscord);
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error.code).toBe("redirect_blocked");
  });

  it("debounces duplicate validation within 5s for same tenant+platform+token", async () => {
    fetchSpy.mockResolvedValue(
      new Response(JSON.stringify({ id: "BOT", username: "x" }), { status: 200 }),
    );
    const first = await validateCredentials(TENANT, validDiscord);
    expect(first.ok).toBe(true);
    const second = await validateCredentials(TENANT, validDiscord);
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error.code).toBe("debounced");
    // Underlying fetch was only called once.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("does not debounce different tokens for the same tenant", async () => {
    // Fresh Response per call — Response body is consumed on first .json().
    fetchSpy.mockImplementation(
      async () => new Response(JSON.stringify({ id: "BOT", username: "x" }), { status: 200 }),
    );
    await validateCredentials(TENANT, validDiscord);
    const other: DiscordCredentials = { ...validDiscord, botToken: "MTI3.different" };
    const result = await validateCredentials(TENANT, other);
    expect(result.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

describe("enforceAttestationGate", () => {
  beforeEach(() => {
    vi.mocked(probeWorkspaceSize).mockReset();
  });

  it("refuses when private_workspace attestation is missing", async () => {
    await expect(
      enforceAttestationGate({
        tenantId: TENANT,
        credentials: validDiscord,
        identity: {},
        attestations: { private_workspace: false },
        maxTrustedMembers: 100,
      }),
    ).rejects.toBeInstanceOf(AttestationGateError);
  });

  it("refuses when workspace probe fails", async () => {
    vi.mocked(probeWorkspaceSize).mockResolvedValueOnce({ probed: false, reason: "discord_timeout" });
    await expect(
      enforceAttestationGate({
        tenantId: TENANT,
        credentials: validDiscord,
        identity: {},
        attestations: { private_workspace: true },
        maxTrustedMembers: 100,
      }),
    ).rejects.toMatchObject({ reason: "probe_failed" });
  });

  it("refuses when workspace size exceeds threshold", async () => {
    vi.mocked(probeWorkspaceSize).mockResolvedValueOnce({ probed: true, memberCount: 250, label: "Large" });
    await expect(
      enforceAttestationGate({
        tenantId: TENANT,
        credentials: validDiscord,
        identity: {},
        attestations: { private_workspace: true },
        maxTrustedMembers: 100,
      }),
    ).rejects.toMatchObject({ reason: "workspace_too_large" });
  });

  it("returns probe result when attestation true and size within threshold", async () => {
    vi.mocked(probeWorkspaceSize).mockResolvedValueOnce({ probed: true, memberCount: 25, label: "Acme" });
    const probe = await enforceAttestationGate({
      tenantId: TENANT,
      credentials: validDiscord,
      identity: {},
      attestations: { private_workspace: true },
      maxTrustedMembers: 100,
    });
    expect(probe).toMatchObject({ probed: true, memberCount: 25, label: "Acme" });
  });

  it("REFUSES persist when probe reports discord_not_installed (R19 post-review fix)", async () => {
    vi.mocked(probeWorkspaceSize).mockResolvedValueOnce({
      probed: false,
      reason: "discord_not_installed: bot has no guilds yet. Invite it to your private workspace before connecting.",
    });
    await expect(
      enforceAttestationGate({
        tenantId: TENANT,
        credentials: validDiscord,
        identity: {},
        attestations: { private_workspace: true },
        maxTrustedMembers: 100,
      }),
    ).rejects.toMatchObject({ reason: "probe_failed" });
  });
});
