import { put, del, get } from "@vercel/blob";
import type { SessionSandboxInstance } from "./sandbox";
import { logger } from "./logger";
import { getEnv } from "./env";
import type { TenantId } from "./types";

// SDK stores session files under HOME, with cwd encoded as a single
// dash-separated key (verified empirically via fallback discovery on
// 2026-04-27). The fallback in sandbox.ts still handles other layouts.
const SESSION_FILE_DIR = "/home/vercel-sandbox/.claude/projects/-vercel-sandbox";

function privateBlobToken(): string | undefined {
  return getEnv().BLOB_PRIVATE_READ_WRITE_TOKEN ?? getEnv().BLOB_READ_WRITE_TOKEN;
}

/**
 * Back up the SDK session file from sandbox to Vercel Blob.
 * Called SYNCHRONOUSLY after each message completes — must complete before
 * response ends to prevent TOCTOU race with cleanup cron.
 *
 * Uses { multipart: true } because server uploads are limited to 4.5MB
 * and session files for long conversations can exceed this.
 */
export async function backupSessionFile(
  sandbox: SessionSandboxInstance,
  tenantId: TenantId,
  sessionId: string,
  sdkSessionId: string,
): Promise<string | null> {
  const sessionFilePath = `${SESSION_FILE_DIR}/${sdkSessionId}.jsonl`;

  try {
    const content = await sandbox.readSessionFile(sdkSessionId);
    if (!content || content.length === 0) {
      logger.warn("Session file empty or not found", {
        session_id: sessionId,
        sdk_session_id: sdkSessionId,
        path: sessionFilePath,
      });
      return null;
    }

    const blobPath = `sessions/${tenantId}/${sessionId}/${sdkSessionId}.jsonl`;
    const blob = await put(blobPath, content, {
      access: "private",
      contentType: "application/x-ndjson",
      addRandomSuffix: false,
      allowOverwrite: true,
      multipart: true,
      token: privateBlobToken(),
    });

    logger.info("Session file backed up", {
      session_id: sessionId,
      sdk_session_id: sdkSessionId,
      blob_url: blob.url,
      size: content.length,
    });

    return blob.url;
  } catch (err) {
    logger.error("Failed to back up session file", {
      session_id: sessionId,
      sdk_session_id: sdkSessionId,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Restore a session file from Vercel Blob into a new sandbox.
 * Called during cold start when sandbox was destroyed but session is active.
 * The SDK's `resume` option will automatically find the session file on disk.
 */
export async function restoreSessionFile(
  sandbox: SessionSandboxInstance,
  blobUrl: string,
  sdkSessionId: string,
): Promise<void> {
  try {
    const result = await get(blobUrl, { access: "private", token: privateBlobToken() });
    if (!result) {
      throw new Error("Session file not found in blob storage");
    }

    const content = Buffer.from(await new Response(result.stream).arrayBuffer());
    const sessionFilePath = `${SESSION_FILE_DIR}/${sdkSessionId}.jsonl`;

    await sandbox.sandboxRef.writeFiles([
      { path: sessionFilePath, content },
    ]);

    logger.info("Session file restored", {
      sdk_session_id: sdkSessionId,
      blob_url: blobUrl,
      size: content.length,
    });
  } catch (err) {
    logger.error("Failed to restore session file", {
      sdk_session_id: sdkSessionId,
      blob_url: blobUrl,
      error: err instanceof Error ? err.message : String(err),
    });
    throw err;
  }
}

/**
 * Delete session file backup from Vercel Blob.
 * Called when session is stopped or cleaned up.
 */
export async function deleteSessionFile(blobUrl: string): Promise<void> {
  try {
    await del(blobUrl, { token: privateBlobToken() });
    logger.info("Session file deleted", { blob_url: blobUrl });
  } catch (err) {
    logger.warn("Failed to delete session file", {
      blob_url: blobUrl,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
