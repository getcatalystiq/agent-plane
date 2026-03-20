import { cookies } from "next/headers";

export async function getActiveTenantId(): Promise<string | null> {
  const c = (await cookies()).get("ap-active-tenant");
  return c?.value ?? null;
}
