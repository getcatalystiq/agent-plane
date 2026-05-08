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

export const POST = async (req: Request): Promise<Response> => {
  const original = (await import(
    "@/app/.well-known/workflow/v1/flow/route" as string
  )) as OriginalRouteModule;
  const res = await original.POST(req);

  if (res.status !== 500) return res;

  let bodyText: string;
  try {
    bodyText = await res.clone().text();
  } catch {
    return res;
  }

  if (!bodyText.includes("MessageNotAvailableError")) return res;

  logger.info("wdk-flow-proxy: swallowed MessageNotAvailableError as 200 (queue dedup)", {
    body_len: bodyText.length,
  });

  return new Response(JSON.stringify({ status: "queue_dedup" }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
};
