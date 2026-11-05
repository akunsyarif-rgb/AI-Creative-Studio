import { getApiDeps } from "@/lib/api/deps";
import { postConfirmUpload } from "@/lib/api/handlers";
import { internalError } from "@/lib/api/http";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ assetId: string }> }) {
  try {
    const { assetId } = await params;
    return await postConfirmUpload(request, getApiDeps(), assetId);
  } catch (error) {
    return internalError(error);
  }
}
