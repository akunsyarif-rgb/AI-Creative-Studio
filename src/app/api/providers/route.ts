import { getApiDeps } from "@/lib/api/deps";
import { getProviders } from "@/lib/api/handlers";
import { internalError } from "@/lib/api/http";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    return await getProviders(request, getApiDeps());
  } catch (error) {
    return internalError(error);
  }
}
