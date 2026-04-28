import { NextRequest } from "next/server";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { query, execute } from "@/db";
import { deleteTranscript } from "@/lib/transcripts";
import { logger } from "@/lib/logger";
import { z } from "zod";
import { verifyCronSecret } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";

const TRANSCRIPT_TTL_DAYS = 30;
const BATCH_SIZE = 100;

export const GET = withErrorHandler(async (request: NextRequest) => {
  verifyCronSecret(request);

  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - TRANSCRIPT_TTL_DAYS);

  // Find expired transcripts in batches
  const expiredMessages = await query(
    z.object({ id: z.string(), transcript_blob_url: z.string() }),
    `SELECT id, transcript_blob_url FROM session_messages
     WHERE transcript_blob_url IS NOT NULL
       AND completed_at < $1
     LIMIT $2`,
    [cutoff.toISOString(), BATCH_SIZE],
  );

  let deleted = 0;
  for (const message of expiredMessages) {
    await deleteTranscript(message.transcript_blob_url);
    await execute(
      "UPDATE session_messages SET transcript_blob_url = NULL WHERE id = $1",
      [message.id],
    );
    deleted++;
  }

  logger.info("Transcript cleanup completed", {
    deleted,
    cutoff: cutoff.toISOString(),
    had_more: expiredMessages.length === BATCH_SIZE,
  });

  return jsonResponse({
    deleted,
    cutoff: cutoff.toISOString(),
  });
});
