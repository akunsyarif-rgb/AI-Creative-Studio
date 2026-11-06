import { getApiDeps } from "@/lib/api/deps";
import { deleteJob, getJobById } from "@/lib/api/handlers";
import { internalError } from "@/lib/api/http";

export const dynamic = "force-dynamic";
// Collecting a finished video downloads and stores the file inside this request.
export const maxDuration = 300;

export async function GET(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    return await getJobById(request, getApiDeps(), (await params).jobId);
  } catch (error) {
    return internalError(error);
  }
}

export async function DELETE(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    return await deleteJob(request, getApiDeps(), (await params).jobId);
  } catch (error) {
    return internalError(error);
  }
}
