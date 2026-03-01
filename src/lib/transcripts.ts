import { put } from "@vercel/blob";
import { logger } from "./logger";

export async function uploadTranscript(
  tenantId: string,
  runId: string,
  content: string,
): Promise<string> {
  const path = `transcripts/${tenantId}/${runId}.ndjson`;

  const blob = await put(path, content, {
    access: "public",
    contentType: "application/x-ndjson",
    addRandomSuffix: false,
  });

  logger.info("Transcript uploaded", {
    run_id: runId,
    tenant_id: tenantId,
    blob_url: blob.url,
    size: content.length,
  });

  return blob.url;
}

export async function deleteTranscript(url: string): Promise<void> {
  try {
    const { del } = await import("@vercel/blob");
    await del(url);
    logger.info("Transcript deleted", { url });
  } catch (err) {
    logger.warn("Failed to delete transcript", {
      url,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
