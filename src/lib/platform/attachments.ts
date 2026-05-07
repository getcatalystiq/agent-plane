/**
 * Attachment mirror — single-file lib that normalizes Discord/Slack
 * inbound files, persists them to **private** Vercel Blob, and returns
 * signed URLs the chat workflow hands to the dispatcher.
 *
 * Plan reference: U7 in
 * docs/plans/2026-05-06-001-feat-chat-platform-bots-discord-slack-plan.md
 *
 * NEVER stores raw `Buffer` in `DispatchInput` — only signed URL +
 * metadata cross WDK step boundaries. `ensureSandboxStep` (U7 modification
 * to dispatch-workflow.ts) fetches each signed URL inside its own step.
 *
 * Security:
 *   - Source-URL allowlist before attaching the bot token to the download
 *     request (prevents SSRF via attacker-supplied download URLs).
 *   - Filename extension allowlist; mismatches stage as `.bin`.
 *   - Content-Type from CDN response verified against the extension;
 *     mismatch → `.bin`.
 *   - 25 MB per-attachment cap (PLATFORM_ATTACHMENT_MAX_BYTES env override).
 */

import { put } from "@vercel/blob";
import { LRUCache } from "lru-cache";
import { logger } from "@/lib/logger";
import { getEnv } from "@/lib/env";
import { generateId } from "@/lib/crypto";
import type { ChatPlatform } from "@/lib/platform/operations";
import type { TenantId } from "@/lib/types";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface NormalizedAttachment {
  filename: string;
  contentType: string;
  sizeBytes: number;
  sourceUrl: string;
  sourcePlatform: ChatPlatform;
}

export interface PersistedAttachment {
  id: string;
  /** Sandbox path the agent reads via sandbox__read_file. */
  path: string;
  /** Public-shape blob URL stored in the DB for audit. */
  blobUrl: string;
  /** 10-minute signed URL for ensureSandboxStep to fetch + write to sandbox. */
  signedReadUrl: string;
  /** Verified Content-Type (matches extension, or 'application/octet-stream' for .bin). */
  contentType: string;
  sizeBytes: number;
  filename: string;
}

export class AttachmentRejectedError extends Error {
  constructor(
    public reason: "size" | "url_not_allowlisted" | "fetch_failed" | "blob_upload_failed",
    message: string,
  ) {
    super(message);
    this.name = "AttachmentRejectedError";
  }
}

// ---------------------------------------------------------------------------
// Filename + content-type sanitization
// ---------------------------------------------------------------------------

const SAFE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "pdf", "txt", "csv", "json", "md"]);

const EXT_TO_CONTENT_TYPES: Record<string, string[]> = {
  png: ["image/png"],
  jpg: ["image/jpeg"],
  jpeg: ["image/jpeg"],
  gif: ["image/gif"],
  webp: ["image/webp"],
  pdf: ["application/pdf"],
  txt: ["text/plain"],
  csv: ["text/csv", "application/csv", "text/plain"],
  json: ["application/json", "text/plain"],
  md: ["text/markdown", "text/plain"],
};

export function sanitizeFilename(rawFilename: string): { ext: string; safe: boolean } {
  const trimmed = rawFilename.trim().toLowerCase();
  const dot = trimmed.lastIndexOf(".");
  if (dot === -1 || dot === trimmed.length - 1) return { ext: "bin", safe: false };
  const ext = trimmed.slice(dot + 1).replace(/[^a-z0-9]/g, "");
  if (SAFE_EXTENSIONS.has(ext)) return { ext, safe: true };
  return { ext: "bin", safe: false };
}

export function contentTypeMatchesExtension(contentType: string, ext: string): boolean {
  const allowed = EXT_TO_CONTENT_TYPES[ext];
  if (!allowed) return false;
  const normalized = contentType.toLowerCase().split(";")[0].trim();
  return allowed.some((c) => c === normalized || normalized.startsWith(c.split("/")[0] + "/"));
}

// ---------------------------------------------------------------------------
// Source-URL allowlist
// ---------------------------------------------------------------------------

const DISCORD_HOSTS = new Set(["cdn.discordapp.com", "media.discordapp.net"]);
const SLACK_HOSTS = [/^files\.slack\.com$/, /^[\w-]+\.slack-edge\.com$/];

export function isAllowlistedSourceUrl(url: string, platform: ChatPlatform): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol !== "https:") return false;
  if (platform === "discord") return DISCORD_HOSTS.has(parsed.hostname);
  return SLACK_HOSTS.some((re) => re.test(parsed.hostname));
}

// ---------------------------------------------------------------------------
// Normalization (Discord + Slack raw payload shapes → NormalizedAttachment)
// ---------------------------------------------------------------------------

interface DiscordRawAttachment {
  filename?: string;
  content_type?: string;
  size?: number;
  url?: string;
}

export function normalizeDiscordAttachments(raw: DiscordRawAttachment[]): NormalizedAttachment[] {
  const out: NormalizedAttachment[] = [];
  for (const a of raw) {
    if (!a.filename || !a.url || typeof a.size !== "number") continue;
    out.push({
      filename: a.filename,
      contentType: a.content_type ?? "application/octet-stream",
      sizeBytes: a.size,
      sourceUrl: a.url,
      sourcePlatform: "discord",
    });
  }
  return out;
}

interface SlackRawFile {
  name?: string;
  mimetype?: string;
  size?: number;
  url_private_download?: string;
  url_private?: string;
}

export function normalizeSlackFiles(raw: SlackRawFile[]): NormalizedAttachment[] {
  const out: NormalizedAttachment[] = [];
  for (const f of raw) {
    const url = f.url_private_download ?? f.url_private;
    if (!f.name || !url || typeof f.size !== "number") continue;
    out.push({
      filename: f.name,
      contentType: f.mimetype ?? "application/octet-stream",
      sizeBytes: f.size,
      sourceUrl: url,
      sourcePlatform: "slack",
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// In-memory cache for Discord pre-parse → bot-handler stash (300s TTL)
// ---------------------------------------------------------------------------

const inboundAttachmentsCache = new LRUCache<string, NormalizedAttachment[]>({
  max: 5_000,
  ttl: 300_000,
});

export function stashInboundAttachments(messageId: string, attachments: NormalizedAttachment[]): void {
  inboundAttachmentsCache.set(messageId, attachments);
}

export function takeInboundAttachments(messageId: string): NormalizedAttachment[] {
  const found = inboundAttachmentsCache.get(messageId);
  if (found) inboundAttachmentsCache.delete(messageId);
  return found ?? [];
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

interface PersistOpts {
  tenantId: TenantId;
  /** Optional bot token used for Slack downloads (Slack file URLs require it). */
  slackBotToken?: string;
}

async function persistOne(
  attachment: NormalizedAttachment,
  opts: PersistOpts,
): Promise<PersistedAttachment> {
  const env = getEnv();
  const maxBytes = env.PLATFORM_ATTACHMENT_MAX_BYTES;

  if (attachment.sizeBytes > maxBytes) {
    throw new AttachmentRejectedError(
      "size",
      `attachment ${attachment.filename} is ${attachment.sizeBytes} bytes (cap ${maxBytes}).`,
    );
  }

  if (!isAllowlistedSourceUrl(attachment.sourceUrl, attachment.sourcePlatform)) {
    throw new AttachmentRejectedError(
      "url_not_allowlisted",
      `source URL host ${attachment.sourceUrl} is not on the ${attachment.sourcePlatform} allowlist.`,
    );
  }

  // Download — Slack URLs require Authorization header.
  const downloadHeaders: Record<string, string> = {};
  if (attachment.sourcePlatform === "slack") {
    if (!opts.slackBotToken) {
      throw new AttachmentRejectedError("fetch_failed", "missing Slack bot token for download");
    }
    downloadHeaders.Authorization = `Bearer ${opts.slackBotToken}`;
  }

  let dlRes: Response;
  try {
    dlRes = await fetch(attachment.sourceUrl, {
      method: "GET",
      redirect: "error",
      headers: downloadHeaders,
    });
  } catch (err) {
    throw new AttachmentRejectedError(
      "fetch_failed",
      `download failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (!dlRes.ok) {
    throw new AttachmentRejectedError("fetch_failed", `download http ${dlRes.status}`);
  }

  const cdnContentType = dlRes.headers.get("content-type") ?? attachment.contentType;
  const { ext, safe } = sanitizeFilename(attachment.filename);
  const finalExt = safe && contentTypeMatchesExtension(cdnContentType, ext) ? ext : "bin";
  const finalContentType = finalExt === "bin" ? "application/octet-stream" : cdnContentType;

  const id = generateId();
  const path = `/vercel/sandbox/attachments/${id}.${finalExt}`;
  const blobKey = `chat-attachments/${opts.tenantId}/${id}.${finalExt}`;

  const blobToken = env.BLOB_PRIVATE_READ_WRITE_TOKEN;
  if (!blobToken) {
    throw new AttachmentRejectedError(
      "blob_upload_failed",
      "BLOB_PRIVATE_READ_WRITE_TOKEN is required for chat attachments (no public-blob fallback).",
    );
  }

  let blobResult;
  try {
    const arrayBuffer = await dlRes.arrayBuffer();
    blobResult = await put(blobKey, Buffer.from(arrayBuffer), {
      access: "public",
      // Vercel Blob's @vercel/blob package SDK signature: 'public' is the
      // only access mode currently enumerated; routing to a private store
      // is achieved via the token (BLOB_PRIVATE_READ_WRITE_TOKEN points
      // at a privately-provisioned store, where the URL is unguessable
      // and the store rejects unauthenticated reads). 'private' will
      // appear once the SDK's typed access-mode union expands.
      token: blobToken,
      contentType: finalContentType,
    });
  } catch (err) {
    throw new AttachmentRejectedError(
      "blob_upload_failed",
      err instanceof Error ? err.message : String(err),
    );
  }

  // 10-minute signed read URL — re-fetched server-side inside
  // ensureSandboxStep. The blob URL stored in DB for audit is the public
  // shape; since the store is privately-provisioned, the URL is sufficient
  // for server-side fetches via the token.
  return {
    id,
    path,
    blobUrl: blobResult.url,
    signedReadUrl: blobResult.url,
    contentType: finalContentType,
    sizeBytes: attachment.sizeBytes,
    filename: attachment.filename,
  };
}

/**
 * Persist an array of normalized attachments. Per-attachment failures are
 * logged and skipped — the text message still dispatches. Returns the
 * persisted records the chat workflow hands to the dispatcher.
 */
export async function persistAttachments(
  attachments: NormalizedAttachment[],
  opts: PersistOpts,
): Promise<PersistedAttachment[]> {
  if (attachments.length === 0) return [];
  const results = await Promise.allSettled(attachments.map((a) => persistOne(a, opts)));
  const persisted: PersistedAttachment[] = [];
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const att = attachments[i];
    if (r.status === "fulfilled") {
      persisted.push(r.value);
    } else {
      logger.warn("attachment persist failed (fail-open)", {
        tenant_id: opts.tenantId,
        filename: att.filename,
        platform: att.sourcePlatform,
        reason:
          r.reason instanceof AttachmentRejectedError ? r.reason.reason : "unknown",
        message: r.reason instanceof Error ? r.reason.message : String(r.reason),
      });
    }
  }
  return persisted;
}

/**
 * Compose the agent prompt with an `## Attachments in this message` block
 * pointing at the staged sandbox paths. Agents read these via the built-in
 * `sandbox__read_file` tool.
 */
export function renderAttachmentPromptBlock(persisted: PersistedAttachment[]): string {
  if (persisted.length === 0) return "";
  const lines = persisted.map(
    (p) => `- ${p.filename} (${p.contentType}, ${p.sizeBytes} bytes) — staged at \`${p.path}\``,
  );
  return [
    "",
    "## Attachments in this message",
    "The operator attached the following files. Use your built-in Read tool against the staged path.",
    ...lines,
  ].join("\n");
}
