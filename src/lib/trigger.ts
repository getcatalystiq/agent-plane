import type { RunTriggeredBy } from "./types";

export type TriggerAuthSource = "tenant" | "admin";

/**
 * Derive a `triggered_by` value for a session_message row from the
 * authentication context and whether this is the first message on a fresh
 * session.
 *
 * - Tenant API key auth          → `'api'`
 * - Admin JWT, first message     → `'playground'`
 * - Admin JWT, follow-up message → `'chat'`
 *
 * Internal triggers (`'schedule'`, `'webhook'`, `'a2a'`) don't go through
 * this helper — their handlers set the value directly when they call the
 * dispatcher.
 */
export function deriveTriggeredBy(args: {
  authSource: TriggerAuthSource;
  isFirstMessage: boolean;
}): RunTriggeredBy {
  if (args.authSource === "admin") {
    return args.isFirstMessage ? "playground" : "chat";
  }
  return "api";
}
