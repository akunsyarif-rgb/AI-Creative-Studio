import { NextResponse } from "next/server";

export const runtime = "nodejs";

export function GET() {
  return NextResponse.json({
    ok: true,
    service: "ai-creative-studio",
    status: "foundation",
    timestamp: new Date().toISOString(),
  });
}
