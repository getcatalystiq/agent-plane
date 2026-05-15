import { NextRequest } from "next/server";
import { Sandbox } from "@vercel/sandbox";
import { queryOne } from "@/db";
import { withErrorHandler } from "@/lib/api";
import { SessionRow, SessionMessageRow } from "@/lib/validation";
import { ndjsonHeaders } from "@/lib/streaming";
import { NotFoundError } from "@/lib/errors";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

type RouteContext = { params: Promise<{ sessionId: string; messageId: string }> };

/** Admin variant: same shape as the public stream reconnect, but no RLS. */
export const GET = withErrorHandler(async (request: NextRequest, context) => {
  const { sessionId, messageId } = await (context as RouteContext).params;
  const offset = parseInt(request.nextUrl.searchParams.get("offset") ?? "0", 10);

  const message = await queryOne(
    SessionMessageRow,
    `SELECT m.*, a.name AS agent_name, a.model AS agent_model, s.agent_id
     FROM session_messages m
     LEFT JOIN sessions s ON m.session_id = s.id
     LEFT JOIN agents a ON s.agent_id = a.id
     WHERE m.id = $1 AND m.session_id = $2`,
    [messageId, sessionId],
  );
  if (!message) throw new NotFoundError("Message not found");

  if (message.status !== "running" && message.status !== "queued") {
    logger.info("Admin stream: message terminal at request time", {
      session_id: sessionId,
      message_id: messageId,
      message_status: message.status,
      has_blob: !!message.transcript_blob_url,
      offset,
    });
    if (message.transcript_blob_url) {
      const res = await fetch(message.transcript_blob_url);
      if (res.ok) {
        const text = await res.text();
        const allLines = text.split("\n").filter(Boolean);
        const newLines = allLines.slice(offset);
        const body = newLines.join("\n") + (newLines.length > 0 ? "\n" : "");
        return new Response(body, { status: 200, headers: ndjsonHeaders() });
      }
    }
    // Empty body — page reader sees done=true immediately, isStreaming flips
    // false, "No transcript available" until lazy-load resolves the blob.
    // PR #56 falls back to liveEvents in this window; this branch logs the
    // case so we know when it fires.
    logger.warn("Admin stream: returning empty body (terminal, no blob yet)", {
      session_id: sessionId,
      message_id: messageId,
      message_status: message.status,
    });
    return new Response("", { status: 200, headers: ndjsonHeaders() });
  }

  const initialSession = await queryOne(
    SessionRow,
    "SELECT * FROM sessions WHERE id = $1",
    [sessionId],
  );
  if (!initialSession) throw new NotFoundError("Session not found");
  // NOTE: do not 409 on null sandbox_id. The chat-workflow path reserves
  // the message row in `running` before the inner dispatchWorkflow's
  // prepareSandboxAndLaunchStep populates session.sandbox_id, so the admin
  // page can land in a window where status='running' but sandbox_id is
  // still null. A 409 made the page bail (no `Streaming…` pill, no events,
  // "No transcript available" stuck until manual refresh). Stream a 200
  // and poll for sandbox_id inside the loop.

  const encoder = new TextEncoder();
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();

  const DETACH_MS = (maxDuration - 15) * 1000;
  const POLL_INTERVAL_MS = 2000;
  const HEARTBEAT_MS = 15_000;
  const transcriptPath = `/vercel/sandbox/transcript-${messageId}.ndjson`;

  logger.info("Admin stream: opening polling loop", {
    session_id: sessionId,
    message_id: messageId,
    message_status: message.status,
    initial_sandbox_id: initialSession.sandbox_id,
    initial_session_status: initialSession.status,
    offset,
  });

  (async () => {
    let sandbox: Sandbox | null = null;
    let attachedSandboxId: string | null = null;
    let lastLineCount = offset;
    let detached = false;
    let iterations = 0;
    let totalLinesWritten = 0;

    const detachTimer = setTimeout(async () => {
      detached = true;
      try {
        await writer.write(
          encoder.encode(
            JSON.stringify({
              type: "stream_detached",
              session_id: sessionId,
              message_id: messageId,
              poll_url: `/api/admin/sessions/${sessionId}/messages/${messageId}`,
              stream_url: `/api/admin/sessions/${sessionId}/messages/${messageId}/stream`,
              offset: lastLineCount,
              timestamp: new Date().toISOString(),
            }) + "\n",
          ),
        );
      } catch {
        /* writer closed */
      }
      await writer.close().catch(() => {});
    }, DETACH_MS);

    const heartbeatTimer = setInterval(async () => {
      try {
        await writer.write(
          encoder.encode(
            JSON.stringify({
              type: "heartbeat",
              timestamp: new Date().toISOString(),
            }) + "\n",
          ),
        );
      } catch {
        /* writer closed */
      }
    }, HEARTBEAT_MS);

    const cleanup = () => {
      clearTimeout(detachTimer);
      clearInterval(heartbeatTimer);
    };

    try {
      while (!detached) {
        iterations++;
        // Re-read the session row each iteration. Picks up a sandbox_id
        // that gets populated mid-stream (chat-workflow's runner-launch
        // step lags reserve), and lets us bail cleanly if the session is
        // stopped underneath us.
        const session = await queryOne(
          SessionRow,
          "SELECT * FROM sessions WHERE id = $1",
          [sessionId],
        );

        if (!session || session.status === "stopped") {
          logger.info("Admin stream: exiting loop — session gone or stopped", {
            session_id: sessionId,
            message_id: messageId,
            session_present: !!session,
            session_status: session?.status,
            iterations,
            total_lines_written: totalLinesWritten,
          });
          break;
        }

        if (!session.sandbox_id) {
          // Sandbox not provisioned yet (or was cleared by stop/reset).
          // Stay connected and let the heartbeat keep the page alive.
          if (iterations === 1 || iterations % 10 === 0) {
            logger.info("Admin stream: waiting for sandbox_id", {
              session_id: sessionId,
              message_id: messageId,
              session_status: session.status,
              iterations,
            });
          }
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
          continue;
        }

        // (Re)attach to the current sandbox. If sandbox_id changed since
        // last attach (cold-start respawn), drop the cached handle and
        // reconnect against the new id. lastLineCount stays valid because
        // each runner spawn writes to a fresh `transcript-<messageId>.ndjson`
        // — the same messageId the admin route is polling.
        if (sandbox === null || attachedSandboxId !== session.sandbox_id) {
          logger.info("Admin stream: attaching to sandbox", {
            session_id: sessionId,
            message_id: messageId,
            sandbox_id: session.sandbox_id,
            previous_sandbox_id: attachedSandboxId,
            iterations,
          });
          sandbox = await Sandbox.get({ sandboxId: session.sandbox_id });
          attachedSandboxId = session.sandbox_id;
        }

        const buf = await sandbox.readFileToBuffer({ path: transcriptPath });
        if (buf) {
          const text = buf.toString("utf-8");
          const lines = text.split("\n").filter(Boolean);

          if (lines.length > lastLineCount) {
            const newLines = lines.slice(lastLineCount);
            for (const line of newLines) {
              try {
                const parsed = JSON.parse(line);
                if (parsed.type === "heartbeat") continue;
              } catch {
                /* not JSON */
              }
              await writer.write(encoder.encode(line + "\n"));
              totalLinesWritten++;
            }
            lastLineCount = lines.length;

            const lastLine = lines[lines.length - 1];
            try {
              const parsed = JSON.parse(lastLine);
              if (parsed.type === "result" || parsed.type === "error") {
                logger.info("Admin stream: terminal event in transcript — closing", {
                  session_id: sessionId,
                  message_id: messageId,
                  terminal_type: parsed.type,
                  total_lines_written: totalLinesWritten,
                  iterations,
                });
                break;
              }
            } catch {
              /* not JSON */
            }
          }
        } else if (iterations === 1 || iterations % 10 === 0) {
          // File doesn't exist yet (runner hasn't spawned / first write
          // hasn't landed). Log periodically so we can spot a runner that
          // never writes.
          logger.info("Admin stream: transcript file not found yet", {
            session_id: sessionId,
            message_id: messageId,
            sandbox_id: session.sandbox_id,
            transcript_path: transcriptPath,
            iterations,
          });
        }

        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
    } catch (err) {
      logger.error("Admin stream reconnect error", {
        message_id: messageId,
        session_id: sessionId,
        error: err instanceof Error ? err.message : String(err),
      });
      try {
        await writer.write(
          encoder.encode(
            JSON.stringify({
              type: "error",
              error: "Lost connection to sandbox",
              timestamp: new Date().toISOString(),
            }) + "\n",
          ),
        );
      } catch {
        /* writer closed */
      }
    } finally {
      cleanup();
      if (!detached) {
        await writer.close().catch(() => {});
      }
    }
  })();

  return new Response(readable, { status: 200, headers: ndjsonHeaders() });
});
