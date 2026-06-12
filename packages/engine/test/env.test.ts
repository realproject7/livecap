import { describe, it, expect } from "vitest";

import { sanitizeChildEnv } from "../src/env";

describe("sanitizeChildEnv", () => {
  it("strips ANTHROPIC_API_KEY and ANTHROPIC_AUTH_TOKEN by default", () => {
    const env = sanitizeChildEnv({
      PATH: "/usr/bin",
      ANTHROPIC_API_KEY: "sk-secret",
      ANTHROPIC_AUTH_TOKEN: "tok-secret",
    });
    expect(env.ANTHROPIC_API_KEY).toBeUndefined();
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  it("is case-insensitive about the credential names", () => {
    const env = sanitizeChildEnv({ anthropic_api_key: "x", Anthropic_Auth_Token: "y" });
    expect(Object.keys(env)).toEqual(["MAX_THINKING_TOKENS"]);
  });

  it("keeps credentials when ANTHROPIC_BASE_URL is set (custom gateway is intentional)", () => {
    const env = sanitizeChildEnv({
      ANTHROPIC_BASE_URL: "https://gateway.example",
      ANTHROPIC_API_KEY: "sk-keep",
    });
    expect(env.ANTHROPIC_API_KEY).toBe("sk-keep");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://gateway.example");
  });

  it("pins MAX_THINKING_TOKENS=0 and drops undefined values", () => {
    const env = sanitizeChildEnv({ FOO: "bar", BAZ: undefined });
    expect(env.MAX_THINKING_TOKENS).toBe("0");
    expect("BAZ" in env).toBe(false);
  });
});
