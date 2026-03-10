import { NextRequest } from "next/server";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { refreshSdkSnapshot } from "@/lib/sandbox";
import { verifyCronSecret } from "@/lib/cron-auth";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 120;

export const GET = withErrorHandler(async (request: NextRequest) => {
  verifyCronSecret(request);

  const start = Date.now();
  const { snapshotId, cleaned } = await refreshSdkSnapshot();
  const durationMs = Date.now() - start;

  logger.info("SDK snapshot refreshed via cron", {
    snapshot_id: snapshotId,
    cleaned_old_snapshots: cleaned,
    duration_ms: durationMs,
  });

  return jsonResponse({ snapshot_id: snapshotId, cleaned, duration_ms: durationMs });
});
