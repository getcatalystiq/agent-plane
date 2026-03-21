/**
 * Signed OAuth state parameter for CSRF protection on Composio OAuth callbacks.
 *
 * Uses shared HMAC-SHA256 utilities from hmac-state.ts.
 */

import { signState, verifyState } from "./hmac-state";

interface OAuthStatePayload {
  agentId: string;
  tenantId: string;
  toolkit: string;
}

export async function signOAuthState(payload: OAuthStatePayload): Promise<string> {
  return signState({
    a: payload.agentId,
    t: payload.tenantId,
    k: payload.toolkit,
  });
}

export async function verifyOAuthState(
  state: string,
): Promise<OAuthStatePayload | null> {
  const data = await verifyState(state);
  if (!data) return null;
  return {
    agentId: data.a as string,
    tenantId: data.t as string,
    toolkit: data.k as string,
  };
}
