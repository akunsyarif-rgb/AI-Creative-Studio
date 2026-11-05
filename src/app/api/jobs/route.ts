import { getJobs, postJob } from "@/lib/api/handlers";
import { getApiDeps } from "@/lib/api/deps";
import { internalError } from "@/lib/api/http";

export const dynamic = "force-dynamic";

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
