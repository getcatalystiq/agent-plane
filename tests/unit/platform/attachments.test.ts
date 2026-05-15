/**
 * Tests for src/lib/platform/attachments.ts.
 *
 * Coverage:
 *   - sanitizeFilename — extension allowlist, .bin fallback, traversal-proof
 *   - contentTypeMatchesExtension — strict matching + family fallback
 *   - isAllowlistedSourceUrl — Discord CDN, Slack edge, https-only
 *   - normalizeDiscordAttachments / normalizeSlackFiles — shape extraction
 *   - inboundAttachmentsCache — stash/take semantics
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({
  getEnv: () => ({
    PLATFORM_ATTACHMENT_MAX_BYTES: 25 * 1024 * 1024,
  }),
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import {
  sanitizeFilename,
  contentTypeMatchesExtension,
  isAllowlistedSourceUrl,
  normalizeDiscordAttachments,
  normalizeSlackFiles,
  stashInboundAttachments,
  takeInboundAttachments,
  type NormalizedAttachment,
} from "@/lib/platform/attachments";

describe("sanitizeFilename", () => {
  it("accepts safe extensions in the allowlist", () => {
    for (const ext of ["png", "jpg", "jpeg", "gif", "webp", "pdf", "txt", "csv", "json", "md"]) {
      expect(sanitizeFilename(`file.${ext}`)).toEqual({ ext, safe: true });
      expect(sanitizeFilename(`FILE.${ext.toUpperCase()}`)).toEqual({ ext, safe: true });
    }
  });

  it("falls back to .bin for unknown extensions", () => {
    expect(sanitizeFilename("payload.exe")).toEqual({ ext: "bin", safe: false });
    expect(sanitizeFilename("script.sh")).toEqual({ ext: "bin", safe: false });
    expect(sanitizeFilename("archive.tar.gz")).toEqual({ ext: "bin", safe: false });
  });

  it("falls back to .bin when no extension is present", () => {
    expect(sanitizeFilename("README")).toEqual({ ext: "bin", safe: false });
    expect(sanitizeFilename("file.")).toEqual({ ext: "bin", safe: false });
  });

  it("strips non-alphanumeric chars from the extension", () => {
    // Bogus extension with control chars / quotes — gets sanitized to "bin"
    // because the cleaned form isn't in the allowlist.
    expect(sanitizeFilename("file.txt;rm -rf").ext).toBe("bin");
    expect(sanitizeFilename("file.png\";").ext).toBe("png");
  });
});

describe("contentTypeMatchesExtension", () => {
  it("matches exact image/png for png", () => {
    expect(contentTypeMatchesExtension("image/png", "png")).toBe(true);
    expect(contentTypeMatchesExtension("image/png; charset=utf-8", "png")).toBe(true);
  });

  it("matches family-prefix (image/* for image extensions)", () => {
    expect(contentTypeMatchesExtension("image/jpeg", "jpg")).toBe(true);
    expect(contentTypeMatchesExtension("image/svg+xml", "png")).toBe(true);
  });

  it("rejects mismatched family", () => {
    expect(contentTypeMatchesExtension("application/x-msdownload", "png")).toBe(false);
    expect(contentTypeMatchesExtension("image/png", "pdf")).toBe(false);
  });

  it("returns false for unknown extension", () => {
    expect(contentTypeMatchesExtension("image/png", "exe")).toBe(false);
  });
});

describe("isAllowlistedSourceUrl", () => {
  it("accepts Discord CDN hosts", () => {
    expect(isAllowlistedSourceUrl("https://cdn.discordapp.com/attachments/1/2/file.png", "discord")).toBe(true);
    expect(isAllowlistedSourceUrl("https://media.discordapp.net/attachments/1/2/file.png", "discord")).toBe(true);
  });

  it("rejects Discord URLs on other hosts", () => {
    expect(isAllowlistedSourceUrl("https://cdn.example.com/file.png", "discord")).toBe(false);
    expect(isAllowlistedSourceUrl("https://discordapp.com/attachments/1/2/file.png", "discord")).toBe(false);
  });

  it("accepts Slack file hosts", () => {
    expect(isAllowlistedSourceUrl("https://files.slack.com/files/T1/F1/file.png", "slack")).toBe(true);
    expect(isAllowlistedSourceUrl("https://acme.slack-edge.com/files-pri/T1/F1/file.png", "slack")).toBe(true);
  });

  it("rejects http (non-TLS) URLs", () => {
    expect(isAllowlistedSourceUrl("http://cdn.discordapp.com/attachments/1/2/file.png", "discord")).toBe(false);
    expect(isAllowlistedSourceUrl("http://files.slack.com/files/T1/F1/file.png", "slack")).toBe(false);
  });

  it("rejects malformed URLs", () => {
    expect(isAllowlistedSourceUrl("not-a-url", "discord")).toBe(false);
    expect(isAllowlistedSourceUrl("", "slack")).toBe(false);
  });

  it("rejects look-alike subdomains", () => {
    expect(isAllowlistedSourceUrl("https://cdn-discordapp.com/attachments/1/2/file.png", "discord")).toBe(false);
    expect(isAllowlistedSourceUrl("https://files-slack.com/files/T1/F1/file.png", "slack")).toBe(false);
    expect(isAllowlistedSourceUrl("https://attacker-slack-edge.com/files/F1/file.png", "slack")).toBe(false);
  });
});

describe("normalizeDiscordAttachments", () => {
  it("extracts canonical fields", () => {
    const raw = [
      { filename: "screenshot.png", content_type: "image/png", size: 1024, url: "https://cdn.discordapp.com/x.png" },
    ];
    const out = normalizeDiscordAttachments(raw);
    expect(out).toEqual([
      {
        filename: "screenshot.png",
        contentType: "image/png",
        sizeBytes: 1024,
        sourceUrl: "https://cdn.discordapp.com/x.png",
        sourcePlatform: "discord",
      },
    ]);
  });

  it("skips entries missing required fields", () => {
    const raw = [
      { filename: "good.png", content_type: "image/png", size: 1024, url: "https://cdn.discordapp.com/x.png" },
      { filename: "noUrl.png", content_type: "image/png", size: 1024 },
      { url: "https://cdn.discordapp.com/y.png", size: 1024 },
      { filename: "noSize.png", url: "https://cdn.discordapp.com/z.png" },
    ];
    const out = normalizeDiscordAttachments(raw);
    expect(out.length).toBe(1);
    expect(out[0].filename).toBe("good.png");
  });

  it("defaults contentType to application/octet-stream when missing", () => {
    const out = normalizeDiscordAttachments([
      { filename: "x.png", size: 1, url: "https://cdn.discordapp.com/x.png" },
    ]);
    expect(out[0].contentType).toBe("application/octet-stream");
  });
});

describe("normalizeSlackFiles", () => {
  it("prefers url_private_download over url_private", () => {
    const out = normalizeSlackFiles([
      {
        name: "report.pdf",
        mimetype: "application/pdf",
        size: 4096,
        url_private: "https://files.slack.com/private",
        url_private_download: "https://files.slack.com/download",
      },
    ]);
    expect(out[0].sourceUrl).toBe("https://files.slack.com/download");
  });

  it("falls back to url_private when download URL absent", () => {
    const out = normalizeSlackFiles([
      {
        name: "report.pdf",
        mimetype: "application/pdf",
        size: 4096,
        url_private: "https://files.slack.com/private",
      },
    ]);
    expect(out[0].sourceUrl).toBe("https://files.slack.com/private");
  });

  it("skips entries without name/url/size", () => {
    const out = normalizeSlackFiles([
      { mimetype: "application/pdf", size: 1, url_private_download: "https://files.slack.com/x" },
      { name: "noUrl.pdf", mimetype: "application/pdf", size: 1 },
    ]);
    expect(out.length).toBe(0);
  });
});

describe("inboundAttachmentsCache", () => {
  beforeEach(() => {
    // Reset by taking everything and discarding.
    takeInboundAttachments("test-msg-1");
    takeInboundAttachments("test-msg-2");
  });

  afterEach(() => {
    takeInboundAttachments("test-msg-1");
    takeInboundAttachments("test-msg-2");
  });

  it("stash + take returns the stashed attachments", () => {
    const att: NormalizedAttachment[] = [
      {
        filename: "x.png",
        contentType: "image/png",
        sizeBytes: 1024,
        sourceUrl: "https://cdn.discordapp.com/x.png",
        sourcePlatform: "discord",
      },
    ];
    stashInboundAttachments("test-msg-1", att);
    expect(takeInboundAttachments("test-msg-1")).toEqual(att);
  });

  it("take returns [] for unknown id", () => {
    expect(takeInboundAttachments("nonexistent")).toEqual([]);
  });

  it("take is one-shot — second call returns []", () => {
    const att: NormalizedAttachment[] = [
      {
        filename: "x.png",
        contentType: "image/png",
        sizeBytes: 1024,
        sourceUrl: "https://cdn.discordapp.com/x.png",
        sourcePlatform: "discord",
      },
    ];
    stashInboundAttachments("test-msg-2", att);
    expect(takeInboundAttachments("test-msg-2").length).toBe(1);
    expect(takeInboundAttachments("test-msg-2")).toEqual([]);
  });
});
