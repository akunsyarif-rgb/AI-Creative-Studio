import { getJobs, postJob } from "@/lib/api/handlers";
import { getApiDeps } from "@/lib/api/deps";
import { internalError } from "@/lib/api/http";

export const dynamic = "force-dynamic";
// Job execution runs after the response via `after()` and counts against this limit.
// 300s needs Vercel Fluid Compute (default for new projects). If a deploy rejects it
// on an older plan, lower it to 60; long jobs will then be cut off and left "Running".
export const maxDuration = 300;

export async function POST(request: Request) {
  try {
    return await postJob(request, getApiDeps());
  } catch (error) {
    return internalError(error);
  }
}

export async function GET(request: Request) {
  try {
    return await getJobs(request, getApiDeps());
  } catch (error) {
    return internalError(error);
  }
}
