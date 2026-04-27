/**
 * Signed OAuth state parameter for CSRF protection on Composio OAuth callbacks.
 *
 * Uses shared HMAC-SHA256 utilities from hmac-state.ts.
 */

import { signState, verifyState } from "./hmac-state";
import type { AuthMethod } from "./types";

interface OAuthStatePayload {
  agentId: string;
  tenantId: string;
  toolkit: string;
  authMethod?: AuthMethod;
}

export async function signOAuthState(payload: OAuthStatePayload): Promise<string> {
  return signState({
    a: payload.agentId,
    t: payload.tenantId,
    k: payload.toolkit,
    ...(payload.authMethod ? { m: payload.authMethod } : {}),
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
    authMethod: (data.m as AuthMethod | undefined) ?? undefined,
  };
}
