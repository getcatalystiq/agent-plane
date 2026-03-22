export class AdminApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "AdminApiError";
  }
}

function extractErrorMessage(body: unknown, fallback: string): string {
  if (body && typeof body === "object" && "error" in body) {
    const err = (body as Record<string, unknown>).error;
    if (typeof err === "string") return err;
    if (err && typeof err === "object" && "message" in err) {
      const msg = (err as Record<string, unknown>).message;
      if (typeof msg === "string") return msg;
    }
  }
  return fallback;
}

function buildHeaders(init?: RequestInit): Record<string, string> {
  const headers: Record<string, string> = { ...init?.headers as Record<string, string> };
  if (init?.body) {
    headers["Content-Type"] ??= "application/json";
  }
  return headers;
}

export async function adminFetch<T = void>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/admin${path}`, { ...init, headers: buildHeaders(init) });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new AdminApiError(res.status, extractErrorMessage(body, res.statusText));
  }
  const text = await res.text();
  if (!text) return undefined as unknown as T;
  return JSON.parse(text) as T;
}

export async function adminStream(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`/api/admin${path}`, { ...init, headers: buildHeaders(init) });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new AdminApiError(res.status, extractErrorMessage(body, res.statusText));
  }
  return res;
}
