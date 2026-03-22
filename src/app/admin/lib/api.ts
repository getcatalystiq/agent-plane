export class AdminApiError extends Error {
  constructor(
    public readonly status: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
    this.name = "AdminApiError";
  }
}

export async function adminFetch<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api/admin${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const err = body?.error;
    throw new AdminApiError(res.status, err?.message ?? res.statusText, err?.code);
  }
  const text = await res.text();
  if (!text) return undefined as T;
  return JSON.parse(text) as T;
}

export async function adminStream(path: string, init?: RequestInit): Promise<Response> {
  const res = await fetch(`/api/admin${path}`, init);
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const err = body?.error;
    throw new AdminApiError(res.status, err?.message ?? res.statusText, err?.code);
  }
  return res;
}
