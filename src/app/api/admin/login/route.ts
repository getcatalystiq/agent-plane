import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "@/lib/crypto";
import { setAdminCookie, clearAdminCookie } from "@/lib/admin-auth";

export const dynamic = "force-dynamic";

export async function POST(request: NextRequest) {
  const body = await request.json();
  const { password } = body;

  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey || !password || !timingSafeEqual(password, adminKey)) {
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }

  const response = NextResponse.json({ ok: true });
  setAdminCookie(response, password);
  return response;
}

export async function DELETE() {
  const response = NextResponse.json({ ok: true });
  clearAdminCookie(response);
  return response;
}
