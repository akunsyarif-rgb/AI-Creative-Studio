import type { ApiDeps } from "./handlers";

export const ALICE = "token-for-alice-0000000000";
export const BOB = "token-for-bob-000000000000";
const TOKENS: Record<string, string> = { [ALICE]: "alice", [BOB]: "bob" };

export const verifyToken: ApiDeps["verifyToken"] = async (t) => (TOKENS[t] ? { userId: TOKENS[t] } : null);

export function jsonRequest(url: string, init: { token?: string; method?: string; body?: unknown; raw?: string } = {}) {
  return new Request(`http://localhost${url}`, {
    method: init.method ?? "POST",
    headers: { ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), "content-type": "application/json" },
    body: init.raw ?? (init.body === undefined ? undefined : JSON.stringify(init.body))
  });
}
