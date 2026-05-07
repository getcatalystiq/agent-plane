/**
 * Vercel function plan-tier preflight.
 *
 * Plan reference: U4 in
 * docs/plans/2026-05-06-001-feat-chat-platform-bots-discord-slack-plan.md
 *
 * Sleeps 60s and reports whether the function timed out. Used during U4
 * setup to confirm the deployment supports `maxDuration: 800` (Pro
 * extended-duration or Enterprise tier). Hobby caps at 60s so the request
 * is killed before the response writes.
 */

import { NextResponse } from "next/server";
import { withErrorHandler } from "@/lib/api";

export const dynamic = "force-dynamic";
export const maxDuration = 90;

export const GET = withErrorHandler(async () => {
  const start = Date.now();
  await new Promise<void>((resolve) => setTimeout(resolve, 65_000));
  const elapsed = Date.now() - start;
  return NextResponse.json({
    timedOut: false,
    elapsedMs: elapsed,
    note: "If this response did not arrive, the deployment is on Hobby tier (60s function cap). The Discord ingress requires Pro extended-duration or Enterprise.",
  });
});
