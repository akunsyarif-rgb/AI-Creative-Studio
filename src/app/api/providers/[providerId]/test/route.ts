import { getApiDeps } from "@/lib/api/deps";
import { postProviderTest } from "@/lib/api/handlers";
import { internalError } from "@/lib/api/http";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ providerId: string }> }) {
  try {
    return await postProviderTest(request, getApiDeps(), (await params).providerId);
  } catch (error) {
    return internalError(error);
  }
}
