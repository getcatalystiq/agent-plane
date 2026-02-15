import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "./crypto";

const COOKIE_NAME = "admin_token";

export function authenticateAdminFromCookie(request: NextRequest): boolean {
  const token = request.cookies.get(COOKIE_NAME)?.value;
  if (!token) return false;

  const adminKey = process.env.ADMIN_API_KEY;
  if (!adminKey) return false;

  return timingSafeEqual(token, adminKey);
}

export function setAdminCookie(response: NextResponse, token: string): void {
  response.cookies.set(COOKIE_NAME, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7, // 7 days
  });
}

export function clearAdminCookie(response: NextResponse): void {
  response.cookies.delete(COOKIE_NAME);
}
