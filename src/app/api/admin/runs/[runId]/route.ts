import { NextRequest, NextResponse } from "next/server";
import { queryOne } from "@/db";
import { RunRow } from "@/lib/validation";
import { withErrorHandler } from "@/lib/api";

export const dynamic = "force-dynamic";

type RouteContext = { params: Promise<{ runId: string }> };

export const GET = withErrorHandler(async (_request: NextRequest, context) => {
  const { runId } = await (context as RouteContext).params;

  const run = await queryOne(RunRow, "SELECT * FROM runs WHERE id = $1", [runId]);
  if (!run) {
    return NextResponse.json({ error: "Run not found" }, { status: 404 });
  }

  // Fetch transcript if available
  let transcript: unknown[] = [];
  if (run.transcript_blob_url) {
    try {
      const res = await fetch(run.transcript_blob_url);
      if (res.ok) {
        const text = await res.text();
        transcript = text
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            try {
              return JSON.parse(line);
            } catch {
              return { type: "raw", data: line };
            }
          });
      }
    } catch {
      // Transcript fetch failed, that's ok
    }
  }

  return NextResponse.json({ run, transcript });
});
