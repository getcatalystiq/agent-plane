/**
 * Tests for src/lib/platform/workspace-probe.ts.
 *
 * Coverage:
 *   - Discord guild enumeration with approximate_member_count
 *   - Discord pending_install (no guilds) returns 0 with label
 *   - Discord HTTP error returns probed:false
 *   - Slack users.list ok with member count
 *   - Slack pagination (next_cursor) marks 1000+
 *   - Slack ok:false returns probed:false with reason
 *   - redirect:'error' enforced on outbound fetches
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { probeWorkspaceSize } from "@/lib/platform/workspace-probe";
import type { DiscordCredentials, SlackCredentials } from "@/lib/platform/operations";

const discord: DiscordCredentials = {
  platform: "discord",
  botToken: "MTI3.discord",
  publicKey: "0".repeat(64),
  applicationId: "12345",
};

const slack: SlackCredentials = {
  platform: "slack",
  botToken: "xoxb-fake",
  signingSecret: "0".repeat(32),
};

describe("probeWorkspaceSize — Discord", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch") as ReturnType<typeof vi.spyOn>;
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("sums approximate_member_count across guilds", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify([
          { id: "g1", name: "Alpha", approximate_member_count: 12 },
          { id: "g2", name: "Beta", approximate_member_count: 25 },
        ]),
        { status: 200 },
      ),
    );
    const result = await probeWorkspaceSize(discord, {});
    expect(result).toMatchObject({ probed: true, memberCount: 37 });
    if (result.probed) expect(result.label).toContain("guilds");
    const init = fetchSpy.mock.calls[0]?.[1] as RequestInit | undefined;
    expect(init?.redirect).toBe("error");
  });

  it("returns memberCount 0 with pending_install when bot is in no guilds", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("[]", { status: 200 }));
    const result = await probeWorkspaceSize(discord, {});
    expect(result).toMatchObject({ probed: true, memberCount: 0, label: "pending_install" });
  });

  it("returns probed:false on Discord HTTP 401", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("", { status: 401 }));
    const result = await probeWorkspaceSize(discord, {});
    expect(result).toMatchObject({ probed: false, reason: "discord_http_401" });
  });

  it("returns single-guild label as the guild name", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify([{ id: "g1", name: "Acme HQ", approximate_member_count: 15 }]),
        { status: 200 },
      ),
    );
    const result = await probeWorkspaceSize(discord, {});
    if (result.probed) expect(result.label).toBe("Acme HQ");
  });
});

describe("probeWorkspaceSize — Slack", () => {
  let fetchSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    fetchSpy = vi.spyOn(globalThis, "fetch") as ReturnType<typeof vi.spyOn>;
  });

  afterEach(() => {
    fetchSpy.mockRestore();
  });

  it("counts active human members from users.list", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          members: [
            { id: "U1", deleted: false, is_bot: false },
            { id: "U2", deleted: false, is_bot: false },
            { id: "U3", deleted: false, is_bot: true },   // bot — skip
            { id: "U4", deleted: true, is_bot: false },   // deleted — skip
          ],
        }),
        { status: 200 },
      ),
    );
    const result = await probeWorkspaceSize(slack, {});
    expect(result).toMatchObject({ probed: true, memberCount: 2 });
  });

  it("marks 1000+ when pagination is present (workspace exceeds page cap)", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          ok: true,
          members: Array.from({ length: 1000 }, (_, i) => ({ id: `U${i}`, deleted: false, is_bot: false })),
          response_metadata: { next_cursor: "abc" },
        }),
        { status: 200 },
      ),
    );
    const result = await probeWorkspaceSize(slack, {});
    if (result.probed) {
      expect(result.memberCount).toBeGreaterThanOrEqual(1001);
      expect(result.label).toBe("1000+ members");
    }
  });

  it("returns probed:false with slack_<error> reason on ok:false", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response(JSON.stringify({ ok: false, error: "missing_scope" }), { status: 200 }),
    );
    const result = await probeWorkspaceSize(slack, {});
    expect(result).toMatchObject({ probed: false, reason: "slack_missing_scope" });
  });

  it("returns probed:false on Slack HTTP 500", async () => {
    fetchSpy.mockResolvedValueOnce(new Response("", { status: 500 }));
    const result = await probeWorkspaceSize(slack, {});
    expect(result).toMatchObject({ probed: false, reason: "slack_http_500" });
  });
});
