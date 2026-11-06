import { checkConfig } from "@/lib/config/health";

export const dynamic = "force-dynamic";

/**
 * Public, unauthenticated configuration check for setup/debugging. It makes no
 * network calls and reveals only which variables are unset or invalid, never values.
 */
export async function GET() {
  const report = checkConfig(process.env);
  return Response.json(report, { status: report.ok ? 200 : 503, headers: { "Cache-Control": "no-store" } });
}
