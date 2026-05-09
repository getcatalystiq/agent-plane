/**
 * WDK queue-callback proxy for `/.well-known/workflow/v1/step`.
 *
 * The WDK-generated route at `/.well-known/workflow/v1/step/route.js`
 * returns 500 with `MessageNotAvailableError` when its at-least-once
 * queue delivers a message that has already been consumed by another
 * worker (e.g., a retry that lost the ticket race). The framework
 * itself classifies this as a "client error that should stop retries"
 * (see `node_modules/@workflow/web/.../server-build-…js:119215`), so
 * the 500 doesn't reflect a failed workflow run — it's purely the
 * framework's own queue-dedup signal returning to its own queue layer.
 *
 * The downside: every one of these surfaces as a red error in Vercel
 * runtime logs, drowning out actual problems. Translate it to a 200
 * with a clear `queue_dedup` body so the queue still treats it as
 * delivered (terminal-not-retry), but Vercel's log feed stays clean.
 *
 * Implementation: a `next.config.ts` rewrite maps
 * `/.well-known/workflow/v1/step` → `/api/internal/wdk-step-proxy`,
 * so the WDK queue's external POST hits this proxy. The proxy
 * dynamically imports the generated route's POST handler, calls it,
 * and intercepts the MessageNotAvailableError 500 case before the
 * response leaves the function. Sits under `/api/internal/` because
 * `src/middleware.ts` whitelists that prefix as public — the queue
 * call carries its own auth, no API-key check applies here.
 */

import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

interface OriginalRouteModule {
  POST: (req: Request) => Promise<Response>;
}

function isQueueDedupError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  // Framework error class is `MessageNotAvailableError`. Match by name
  // and by message-substring so we catch it regardless of how the
  // bundled error class chain looks at runtime (the queue worker
  // wraps and rethrows in a few places).
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
  // Dynamic import so Next.js doesn't bundle the WDK-generated route
  // into the proxy's chunk at build time. Node caches the module after
  // the first call.
  const original = (await import(
    "@/app/.well-known/workflow/v1/step/route" as string
  )) as OriginalRouteModule;

  // Two error shapes from the WDK queue worker, both observed in
  // production logs:
  //   1. The handler returns Response { status: 500, body: "...
  //      MessageNotAvailableError ..." } — caught below by the
  //      status-500 + body-substring check.
  //   2. The handler THROWS the MessageNotAvailableError directly —
  //      `e.receiveMessageById` rejects, the consume() chain re-throws,
  //      and the route handler propagates it. Without the try/catch,
  //      Next.js converts the throw to a 500 with stack trace and the
  //      proxy never sees the response — which is what was happening
  //      until 2026-05-09.
  let res: Response;
  try {
    res = await original.POST(req);
  } catch (err) {
    if (isQueueDedupError(err)) {
      logger.info("wdk-step-proxy: swallowed MessageNotAvailableError throw as 200 (queue dedup)", {
        error_name: err instanceof Error ? err.name : "unknown",
      });
      return QUEUE_DEDUP_RESPONSE();
    }
    throw err;
  }

  if (res.status !== 500) return res;

  // Peek at the body to confirm this is the framework's queue-dedup
  // path. We clone() so the original body stream is still readable
  // (in case we decide to pass through).
  let bodyText: string;
  try {
    bodyText = await res.clone().text();
  } catch {
    return res;
  }

  if (!bodyText.includes("MessageNotAvailableError")) return res;

  logger.info("wdk-step-proxy: swallowed MessageNotAvailableError 500 as 200 (queue dedup)", {
    body_len: bodyText.length,
  });

  return QUEUE_DEDUP_RESPONSE();
};
