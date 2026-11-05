import { describe, expect, it } from "vitest";
import { postProviderTest } from "./handlers";
import { ALICE, BOB, createTestWorld, jsonRequest } from "./test-helpers";
import { ProviderError } from "@/lib/providers/types";

const call = (w: ReturnType<typeof createTestWorld>, provider = "fake", token: string = ALICE) =>
  postProviderTest(jsonRequest(`/api/providers/${provider}/test`, { token }), w.deps, provider);

describe("POST /api/providers/:providerId/test", () => {
  it("validates the decrypted key against the provider and records `valid`", async () => {
    const w = createTestWorld();
    w.seedKey("alice", "fake", "good-key");
    const res = await call(w);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ validationStatus: "valid" });
    expect(w.keys.get("alice/fake")!.validationStatus).toBe("valid");
    expect(w.calls.validate).toBe(1);
  });

  it("records `invalid` when the provider rejects the key", async () => {
    const w = createTestWorld();
    w.seedKey("alice", "fake", "bad-key");
    const body = await (await call(w)).json();
    expect(body.validationStatus).toBe("invalid");
    expect(w.keys.get("alice/fake")!.validationStatus).toBe("invalid");
  });

  it("returns 502 and leaves status unchanged when the provider is unreachable", async () => {
    const w = createTestWorld({ adapter: { credentialError: new ProviderError("unavailable", "Could not reach the provider.", false) } });
    w.seedKey("alice", "fake", "good-key");
    const res = await call(w);
    expect(res.status).toBe(502);
    expect(w.keys.get("alice/fake")!.validationStatus).toBe("unvalidated");
  });

  it("404s for unknown providers, missing keys and other users' keys; 401 without auth", async () => {
    const w = createTestWorld();
    w.seedKey("alice", "fake", "good-key");
    expect((await call(w, "nope")).status).toBe(404);
    expect((await call(w, "fake", BOB)).status).toBe(404);
    expect((await call(w, "fake", "")).status).toBe(401);
    expect(w.calls.validate).toBe(0);
  });

  it("never exposes the secret and is tightly rate limited", async () => {
    const w = createTestWorld({ limits: { providerTest: { limit: 1, windowSeconds: 60 }, keys: { limit: 9, windowSeconds: 60 }, uploads: { limit: 9, windowSeconds: 60 }, jobs: { limit: 9, windowSeconds: 60 } } });
    w.seedKey("alice", "fake", "good-key");
    const first = await call(w);
    expect(await first.text()).not.toContain("good-key");
    expect((await call(w)).status).toBe(429);
  });
});
