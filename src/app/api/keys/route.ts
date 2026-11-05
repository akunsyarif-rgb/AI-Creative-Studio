import { getApiDeps } from "@/lib/api/deps";
import { internalError } from "@/lib/api/http";
import { getKeys, postKey } from "@/lib/api/keys-handlers";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    return await postKey(request, getApiDeps());
  } catch (error) {
    return internalError(error);
  }
}

export async function GET(request: Request) {
  try {
    return await getKeys(request, getApiDeps());
  } catch (error) {
    return internalError(error);
  }
}
