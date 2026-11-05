import { getApiDeps } from "@/lib/api/deps";
import { getAssetDownload } from "@/lib/api/handlers";
import { internalError } from "@/lib/api/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ assetId: string }> }) {
  try {
    return await getAssetDownload(request, getApiDeps(), (await params).assetId);
  } catch (error) {
    return internalError(error);
  }
}
