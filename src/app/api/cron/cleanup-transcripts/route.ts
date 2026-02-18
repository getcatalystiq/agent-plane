import { NextRequest } from "next/server";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { query, execute } from "@/db";
import { deleteTranscript } from "@/lib/transcripts";
import { logger } from "@/lib/logger";
import { z } from "zod";

export const dynamic = "force-dynamic";

const TRANSCRIPT_TTL_DAYS = 30;
const BATCH_SIZE = 100;

export const GET = withErrorHandler(async (request: NextRequest) => {
  // Verify CRON_SECRET — reject if not configured or mismatched
  const cronSecret = process.env.CRON_SECRET;
  const authHeader = request.headers.get("authorization");
  if (!cronSecret || authHeader !== `Bearer ${cronSecret}`) {
    return jsonResponse(
      { error: { code: "unauthorized", message: "Invalid cron secret" } },
      401,
    );
  }

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - TRANSCRIPT_TTL_DAYS);

  // Find expired transcripts in batches
  const expiredRuns = await query(
    z.object({ id: z.string(), transcript_blob_url: z.string() }),
    `SELECT id, transcript_blob_url FROM runs
     WHERE transcript_blob_url IS NOT NULL
       AND completed_at < $1
     LIMIT $2`,
    [cutoff.toISOString(), BATCH_SIZE],
  );

  let deleted = 0;
  for (const run of expiredRuns) {
    await deleteTranscript(run.transcript_blob_url);
    await execute(
      "UPDATE runs SET transcript_blob_url = NULL WHERE id = $1",
      [run.id],
    );
    deleted++;
  }

  logger.info("Transcript cleanup completed", {
    deleted,
    cutoff: cutoff.toISOString(),
    had_more: expiredRuns.length === BATCH_SIZE,
  });

  return jsonResponse({
    deleted,
    cutoff: cutoff.toISOString(),
  });
});
