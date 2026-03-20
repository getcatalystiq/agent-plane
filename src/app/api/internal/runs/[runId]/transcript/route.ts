import { NextRequest } from "next/server";
import { queryOne } from "@/db";
import { withErrorHandler, jsonResponse } from "@/lib/api";
import { verifyRunToken } from "@/lib/crypto";
import { getEnv } from "@/lib/env";
import { uploadTranscript } from "@/lib/transcripts";
import { transitionRunStatus } from "@/lib/runs";
import { parseResultEvent } from "@/lib/transcript-utils";
import { processLineAssets } from "@/lib/assets";
import { logger } from "@/lib/logger";
import { z } from "zod";
import type { RunId, TenantId } from "@/lib/types";

export const dynamic = "force-dynamic";

const RunRow = z.object({
  id: z.string(),
  tenant_id: z.string(),
  status: z.string(),
  max_budget_usd: z.coerce.number().optional(),
});

type RouteContext = { params: Promise<{ runId: string }> };

/**
 * Internal endpoint called by the sandbox runner to upload transcripts
 * for long-running or detached runs. Authenticated via HMAC-based run token.
 */
export const POST = withErrorHandler(async (request: NextRequest, context) => {
  const { runId } = await (context as RouteContext).params;

  // Verify run token
  const authHeader = request.headers.get("authorization");
  if (!authHeader?.startsWith("Bearer ")) {
    return jsonResponse({ error: "Missing authorization" }, 401);
  }
  const token = authHeader.slice(7);
  const env = getEnv();
  const valid = await verifyRunToken(token, runId, env.ENCRYPTION_KEY);
  if (!valid) {
    return jsonResponse({ error: "Invalid run token" }, 401);
  }

  // Look up the run
  const run = await queryOne(
    RunRow,
    `SELECT r.id, r.tenant_id, r.status, a.max_budget_usd
     FROM runs r JOIN agents a ON a.id = r.agent_id
     WHERE r.id = $1`,
    [runId],
  );
  if (!run) {
    return jsonResponse({ error: "Run not found" }, 404);
  }
  if (run.status !== "running") {
    return jsonResponse({ error: `Run is ${run.status}, not running` }, 409);
  }

  const tenantId = run.tenant_id as TenantId;
  const typedRunId = runId as RunId;

  // Read NDJSON body
  const body = await request.text();
  const lines = body.split("\n").filter((l) => l.trim());

  if (lines.length === 0) {
    return jsonResponse({ error: "Empty transcript" }, 400);
  }

  try {
    // Replace ephemeral asset URLs (e.g. Composio/R2) with permanent Blob URLs
    const processedLines = await Promise.all(
      lines.map((line) => processLineAssets(line, tenantId, typedRunId)),
    );
    const transcript = processedLines.join("\n") + "\n";
    const blobUrl = await uploadTranscript(tenantId, typedRunId, transcript);
    const resultData = await parseResultEvent(lines[lines.length - 1]);

    await transitionRunStatus(
      typedRunId,
      tenantId,
      "running",
      resultData?.status ?? "completed",
      {
        completed_at: new Date().toISOString(),
        transcript_blob_url: blobUrl,
        ...resultData?.updates,
      },
      { expectedMaxBudgetUsd: run.max_budget_usd },
    );

    logger.info("Internal transcript uploaded", { run_id: runId, lines: lines.length });
    return jsonResponse({ status: "ok" });
  } catch (err) {
    logger.error("Internal transcript upload failed", {
      run_id: runId,
      error: err instanceof Error ? err.message : String(err),
    });
    await transitionRunStatus(typedRunId, tenantId, "running", "failed", {
      completed_at: new Date().toISOString(),
      error_type: "transcript_persist_error",
      error_messages: [err instanceof Error ? err.message : String(err)],
    });
    return jsonResponse({ error: "Failed to persist transcript" }, 500);
  }
});
