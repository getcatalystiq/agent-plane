import { NextRequest, NextResponse } from "next/server";
import { authenticateApiKey } from "@/lib/auth";
import { Sandbox } from "@vercel/sandbox";
import { withErrorHandler } from "@/lib/api";
import { getRun } from "@/lib/runs";
import { ndjsonHeaders } from "@/lib/streaming";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type RouteContext = { params: Promise<{ runId: string }> };

/**
 * Reconnect to a running sandbox and stream its transcript file.
 * Used by SDK clients after a stream_detached event.
 * Query params:
 *   - offset: number of transcript lines already received (to skip duplicates)
 */
export const GET = withErrorHandler(async (request: NextRequest, context) => {
  const auth = await authenticateApiKey(request.headers.get("authorization"));
  const { runId } = await (context as RouteContext).params;
  const offset = parseInt(request.nextUrl.searchParams.get("offset") ?? "0", 10);

  const run = await getRun(runId, auth.tenantId);

  // If the run already completed, return the transcript from blob
  if (run.status !== "running" && run.status !== "pending") {
    if (run.transcript_blob_url) {
      const res = await fetch(run.transcript_blob_url);
      if (res.ok) {
        const text = await res.text();
        const allLines = text.split("\n").filter(Boolean);
        const newLines = allLines.slice(offset);
        const body = newLines.join("\n") + (newLines.length > 0 ? "\n" : "");
        return new Response(body, { status: 200, headers: ndjsonHeaders() });
      }
    }
    return new Response("", { status: 200, headers: ndjsonHeaders() });
  }

  if (!run.sandbox_id) {
    return NextResponse.json({ error: "No sandbox for this run" }, { status: 409 });
  }

  // Connect to sandbox and poll the transcript file for new events
  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  const DETACH_MS = (maxDuration - 15) * 1000;
  const POLL_INTERVAL_MS = 2000;
  const HEARTBEAT_MS = 15_000;

  (async () => {
    let sandbox: Sandbox | null = null;
    let lastLineCount = offset;
    let detached = false;

    const detachTimer = setTimeout(async () => {
      detached = true;
      try {
        await writer.write(encoder.encode(JSON.stringify({
          type: "stream_detached",
          poll_url: `/api/runs/${runId}/stream`,
          offset: lastLineCount,
          timestamp: new Date().toISOString(),
        }) + "\n"));
      } catch { /* writer closed */ }
      await writer.close().catch(() => {});
    }, DETACH_MS);

    const heartbeatTimer = setInterval(async () => {
      try {
        await writer.write(encoder.encode(JSON.stringify({
          type: "heartbeat",
          timestamp: new Date().toISOString(),
        }) + "\n"));
      } catch { /* writer closed */ }
    }, HEARTBEAT_MS);

    const cleanup = () => {
      clearTimeout(detachTimer);
      clearInterval(heartbeatTimer);
    };

    try {
      sandbox = await Sandbox.get({ sandboxId: run.sandbox_id! });

      while (!detached) {
        const buf = await sandbox.readFileToBuffer({ path: "/vercel/sandbox/transcript.ndjson" });
        if (buf) {
          const text = buf.toString("utf-8");
          const lines = text.split("\n").filter(Boolean);

          if (lines.length > lastLineCount) {
            const newLines = lines.slice(lastLineCount);
            for (const line of newLines) {
              try {
                const parsed = JSON.parse(line);
                if (parsed.type === "heartbeat") continue;
              } catch { /* not JSON, send as-is */ }
              await writer.write(encoder.encode(line + "\n"));
            }
            lastLineCount = lines.length;

            // Check if we hit a terminal event
            const lastLine = lines[lines.length - 1];
            try {
              const parsed = JSON.parse(lastLine);
              if (parsed.type === "result" || parsed.type === "error") {
                break;
              }
            } catch { /* not JSON */ }
          }
        }

        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
    } catch (err) {
      logger.error("Stream reconnect error", {
        run_id: runId,
        error: err instanceof Error ? err.message : String(err),
      });
      try {
        await writer.write(encoder.encode(JSON.stringify({
          type: "error",
          error: "Lost connection to sandbox",
          timestamp: new Date().toISOString(),
        }) + "\n"));
      } catch { /* writer closed */ }
    } finally {
      cleanup();
      if (!detached) {
        await writer.close().catch(() => {});
      }
    }
  })();

  return new Response(readable, { status: 200, headers: ndjsonHeaders() });
});
