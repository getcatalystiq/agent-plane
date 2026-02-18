import { put } from "@vercel/blob";
import { randomUUID } from "crypto";
import { logger } from "./logger";

// Matches Composio temporary R2 pre-signed URLs (expire after X-Amz-Expires seconds)
const COMPOSIO_TEMP_URL_REGEX =
  /https:\/\/temp\.[a-f0-9]+\.r2\.cloudflarestorage\.com\/[^\s"'<>\])},]+/g;

const MIME_TO_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
  "application/pdf": "pdf",
};

/**
 * Download a file from a temporary URL and store it in Vercel Blob.
 * Returns the permanent Blob URL, or null on failure.
 */
async function downloadAndStoreAsset(
  url: string,
  tenantId: string,
  runId: string,
): Promise<string | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      logger.warn("Failed to download asset", {
        url: url.slice(0, 120),
        status: response.status,
      });
      return null;
    }

    const contentType =
      response.headers.get("content-type") || "application/octet-stream";
    const ext = MIME_TO_EXT[contentType] || "bin";
    const path = `assets/${tenantId}/${runId}/${randomUUID()}.${ext}`;

    const buffer = Buffer.from(await response.arrayBuffer());

    const blob = await put(path, buffer, {
      access: "public",
      contentType,
      addRandomSuffix: true,
    });

    logger.info("Asset stored", {
      run_id: runId,
      tenant_id: tenantId,
      blob_url: blob.url,
      content_type: contentType,
      size: buffer.length,
    });

    return blob.url;
  } catch (err) {
    logger.warn("Failed to store asset", {
      url: url.slice(0, 120),
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  }
}

/**
 * Scan an NDJSON line for Composio temporary URLs, download each asset,
 * store it in Vercel Blob, and replace the URL in the line.
 * Returns the (possibly modified) line. On any failure, the original URL is kept.
 */
export async function processLineAssets(
  line: string,
  tenantId: string,
  runId: string,
): Promise<string> {
  // Fast path: skip lines that can't contain Composio URLs
  if (!line.includes("r2.cloudflarestorage.com")) {
    return line;
  }

  const urls = [...new Set(line.match(COMPOSIO_TEMP_URL_REGEX) || [])];
  if (urls.length === 0) return line;

  let result = line;
  for (const url of urls) {
    const blobUrl = await downloadAndStoreAsset(url, tenantId, runId);
    if (blobUrl) {
      result = result.replaceAll(url, blobUrl);
    }
  }

  return result;
}
