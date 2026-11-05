import { getApiDeps } from "@/lib/api/deps";
import { getJobById } from "@/lib/api/handlers";
import { internalError } from "@/lib/api/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ jobId: string }> }) {
  try {
    return await getJobById(request, getApiDeps(), (await params).jobId);
  } catch (error) {
    return internalError(error);
  }
}
