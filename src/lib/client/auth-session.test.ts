import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const calls: string[] = [];
let failDelete = false;
let failCreate: unknown = null;

vi.mock("appwrite", () => {
  class Client {
    setEndpoint() { return this; }
    setProject() { return this; }
  }
  class Account {
    async deleteSession() { calls.push("deleteSession"); if (failDelete) throw new Error("no session"); return {}; }
    async createEmailPasswordSession() { calls.push("createSession"); if (failCreate) throw failCreate; return {}; }
    async create() { calls.push("create"); return {}; }
    async get() { return { $id: "u1", email: "me@example.com" }; }
    async createJWT() { return { jwt: "j" }; }
  }
  return { Account, Client, ID: { unique: () => "uid" } };
});

describe("sign-in with an existing session", () => {
  beforeEach(() => {
    calls.length = 0;
    failDelete = false;
    failCreate = null;
    vi.resetModules();
    vi.stubEnv("NEXT_PUBLIC_APPWRITE_ENDPOINT", "https://appwrite.test/v1");
    vi.stubEnv("NEXT_PUBLIC_APPWRITE_PROJECT_ID", "proj");
  });
  afterEach(() => vi.unstubAllEnvs());

  it("clears any active session before creating a new one", async () => {
    const { signIn } = await import("./auth");
    await signIn("me@example.com", "pw-12345678");
    expect(calls).toEqual(["deleteSession", "createSession"]);
  });

  it("still signs in when there was no session to clear", async () => {
    failDelete = true;
    const { signIn } = await import("./auth");
    await signIn("me@example.com", "pw-12345678");
    expect(calls).toEqual(["deleteSession", "createSession"]);
  });

  it("surfaces real sign-in failures", async () => {
    failCreate = Object.assign(new Error("bad"), { code: 401, type: "user_invalid_credentials" });
    const { signIn } = await import("./auth");
    await expect(signIn("me@example.com", "wrong-password")).rejects.toMatchObject({ code: 401 });
  });

  it("sign-up creates the account and then signs in on a clean session", async () => {
    const { signUp } = await import("./auth");
    await signUp("me@example.com", "pw-12345678");
    expect(calls).toEqual(["create", "deleteSession", "createSession"]);
  });
});
