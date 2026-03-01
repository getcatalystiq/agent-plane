import { NextRequest } from "next/server";
import { authenticateApiKey } from "@/lib/auth";
import { withErrorHandler } from "@/lib/api";
import { getRun } from "@/lib/runs";
import { NotFoundError } from "@/lib/errors";

export const dynamic = "force-dynamic";

export const GET = withErrorHandler(async (request: NextRequest, context) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const { runId } = await context!.params;

  const run = await getRun(runId, auth.tenantId);

  if (!run.transcript_blob_url) {
    throw new NotFoundError("Transcript not available yet");
  }

  // Proxy the transcript from Blob storage
  const response = await fetch(run.transcript_blob_url);
  if (!response.ok) {
    throw new NotFoundError("Transcript not found in storage");
  }

  return new Response(response.body, {
    status: 200,
    headers: {
      "Content-Type": "application/x-ndjson",
      "Cache-Control": "private, max-age=3600",
    },
  });
});
