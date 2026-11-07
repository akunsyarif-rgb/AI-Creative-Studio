import { getApiDeps } from "@/lib/api/deps";
import { recoverJob } from "@/lib/api/handlers";
import { internalError } from "@/lib/api/http";

export const dynamic = "force-dynamic";
// Collecting a finished result downloads and stores the file inside this request.
export const maxDuration = 300;

export async function POST(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    return await recoverJob(request, getApiDeps(), (await params).jobId);
  } catch (error) {
    return internalError(error);
  }
}
