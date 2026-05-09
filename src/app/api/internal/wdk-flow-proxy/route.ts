/**
 * WDK queue-callback proxy for `/.well-known/workflow/v1/flow`. See
 * the sibling `wdk-step-proxy/route.ts` for the full rationale; same
 * pattern applied to the flow endpoint.
 */

import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface OriginalRouteModule {
  POST: (req: Request) => Promise<Response>;
}

function isQueueDedupError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return (
    err.name === "MessageNotAvailableError" ||
    err.message?.includes("MessageNotAvailableError") ||
    err.message?.includes("not available for processing")
  );
}

const QUEUE_DEDUP_RESPONSE = (): Response =>
  new Response(JSON.stringify({ status: "queue_dedup" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

export const POST = async (req: Request): Promise<Response> => {
  const original = (await import(
    "@/app/.well-known/workflow/v1/flow/route" as string
  )) as OriginalRouteModule;

  // Two error shapes — see `wdk-step-proxy/route.ts` for full rationale.
  // (1) handler returns 500-status Response, (2) handler throws.
  let res: Response;
  try {
    res = await original.POST(req);
  } catch (err) {
    if (isQueueDedupError(err)) {
      logger.info("wdk-flow-proxy: swallowed MessageNotAvailableError throw as 200 (queue dedup)", {
        error_name: err instanceof Error ? err.name : "unknown",
      });
      return QUEUE_DEDUP_RESPONSE();
    }
    throw err;
  }

  if (res.status !== 500) return res;

  let bodyText: string;
  try {
    bodyText = await res.clone().text();
  } catch {
    return res;
  }

  if (!bodyText.includes("MessageNotAvailableError")) return res;

  logger.info("wdk-flow-proxy: swallowed MessageNotAvailableError 500 as 200 (queue dedup)", {
    body_len: bodyText.length,
  });

  return QUEUE_DEDUP_RESPONSE();
};
