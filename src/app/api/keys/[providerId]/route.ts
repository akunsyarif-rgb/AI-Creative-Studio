import { getApiDeps } from "@/lib/api/deps";
import { internalError } from "@/lib/api/http";
import { deleteKey, getKey, putKey } from "@/lib/api/keys-handlers";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ providerId: string }> };

export async function GET(request: Request, { params }: Ctx) {
  try {
    return await getKey(request, getApiDeps(), (await params).providerId);
  } catch (error) {
    return internalError(error);
  }
}

export async function PUT(request: Request, { params }: Ctx) {
  try {
    return await putKey(request, getApiDeps(), (await params).providerId);
  } catch (error) {
    return internalError(error);
  }
}

export async function DELETE(request: Request, { params }: Ctx) {
  try {
    return await deleteKey(request, getApiDeps(), (await params).providerId);
  } catch (error) {
    return internalError(error);
  }
}
