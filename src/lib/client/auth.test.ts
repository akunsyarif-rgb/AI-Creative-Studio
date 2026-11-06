import { describe, expect, it } from "vitest";
import { authErrorMessage } from "./auth";

describe("authErrorMessage", () => {
  it("names an unregistered site address (the usual first-deploy problem)", () => {
    expect(authErrorMessage({ code: 403, type: "general_unknown_origin" }, "signup")).toMatch(/Apps → Web/);
    expect(authErrorMessage({ code: 403, type: "general_unknown_origin" }, "signin")).toMatch(/not registered/);
  });

  it("names a still-active session instead of calling the password wrong", () => {
    expect(authErrorMessage({ code: 401, type: "user_session_already_exists" }, "signin")).toMatch(/Sign out first/);
  });

  it("names a disabled sign-in method", () => {
    expect(authErrorMessage({ code: 501, type: "user_auth_method_unsupported" }, "signup")).toMatch(/Auth → Settings/);
  });

  it("explains network failures", () => {
    expect(authErrorMessage(new TypeError("Load failed"), "signup")).toMatch(/Could not reach Appwrite/);
    expect(authErrorMessage({ code: 0 }, "signin")).toMatch(/Could not reach Appwrite/);
  });

  it("keeps sign-in failures generic so account existence is not revealed", () => {
    for (const code of [400, 401]) expect(authErrorMessage({ code, type: "user_invalid_credentials" }, "signin")).toBe("Email or password is incorrect.");
  });

  it("keeps the existing sign-up messages", () => {
    expect(authErrorMessage({ code: 409 }, "signup")).toMatch(/Try signing in instead/);
    expect(authErrorMessage({ code: 400 }, "signup")).toMatch(/strong password/);
    expect(authErrorMessage({ code: 429 }, "signup")).toMatch(/Too many attempts/);
  });

  it("shows code and type for anything else, without secrets", () => {
    expect(authErrorMessage({ code: 500, type: "general_server_error", message: "secret detail" }, "signup")).toBe(
      "Something went wrong (Appwrite 500: general_server_error). Please try again."
    );
    expect(authErrorMessage({ code: 503 }, "signin")).toBe("Something went wrong (Appwrite 503). Please try again.");
  });

  it("shows Appwrite's own reason for a rejected sign-up (password policy, invalid email)", () => {
    expect(
      authErrorMessage({ code: 400, type: "password_dictionary", message: "Invalid `password` param: Password must not be one of the commonly used passwords." }, "signup")
    ).toBe("The account could not be created: Invalid `password` param: Password must not be one of the commonly used passwords.");
    expect(authErrorMessage({ code: 400, message: "Password must not contain your email or name." }, "signup")).toMatch(/not contain your email/);
  });

  it("ignores absurdly long or empty messages and never uses them for sign-in", () => {
    expect(authErrorMessage({ code: 400, message: "x".repeat(500) }, "signup")).toMatch(/strong password/);
    expect(authErrorMessage({ code: 400, message: "Password must not contain your email." }, "signin")).toBe("Email or password is incorrect.");
  });
});
