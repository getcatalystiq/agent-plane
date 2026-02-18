import { NextResponse } from "next/server";
import { checkConnection } from "@/db";

export const dynamic = "force-dynamic";

export async function GET() {
  const postgres = await checkConnection();

  const status = postgres ? "healthy" : "degraded";
  const statusCode = postgres ? 200 : 503;

  return NextResponse.json(
    {
      status,
      checks: {
        postgres,
      },
      timestamp: new Date().toISOString(),
    },
    { status: statusCode },
  );
}
