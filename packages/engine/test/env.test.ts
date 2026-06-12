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

  it("strips the Bedrock/Vertex billing-redirect activation flags by default (#25)", () => {
    const env = sanitizeChildEnv({
      CLAUDE_CODE_USE_BEDROCK: "1",
      CLAUDE_CODE_USE_VERTEX: "1",
      PATH: "/usr/bin",
    });
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBeUndefined();
    expect(env.CLAUDE_CODE_USE_VERTEX).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  it("strips the region/base-url companions by default (#25)", () => {
    const env = sanitizeChildEnv({
      ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock.example",
      ANTHROPIC_VERTEX_BASE_URL: "https://vertex.example",
      ANTHROPIC_VERTEX_PROJECT_ID: "proj-123",
      CLOUD_ML_REGION: "us-east5",
      AWS_REGION: "us-east-1",
      AWS_DEFAULT_REGION: "us-west-2",
      VERTEX_REGION_CLAUDE_3_5_HAIKU: "us-central1",
    });
    expect(Object.keys(env)).toEqual(["MAX_THINKING_TOKENS"]);
  });

  it("is case-insensitive about the redirect var names", () => {
    const env = sanitizeChildEnv({ claude_code_use_bedrock: "1", Aws_Region: "us-east-1" });
    expect(Object.keys(env)).toEqual(["MAX_THINKING_TOKENS"]);
  });

  it("preserves all redirect vars when ANTHROPIC_BASE_URL is set (custom-endpoint exception)", () => {
    const env = sanitizeChildEnv({
      ANTHROPIC_BASE_URL: "https://gateway.example",
      CLAUDE_CODE_USE_BEDROCK: "1",
      AWS_REGION: "us-east-1",
      ANTHROPIC_API_KEY: "sk-keep",
    });
    expect(env.CLAUDE_CODE_USE_BEDROCK).toBe("1");
    expect(env.AWS_REGION).toBe("us-east-1");
    expect(env.ANTHROPIC_API_KEY).toBe("sk-keep");
  });

  it("does not over-strip unrelated AWS/region-like vars", () => {
    const env = sanitizeChildEnv({
      AWS_PROFILE: "default",
      AWS_REGIONAL_THING: "x",
      MY_REGION: "eu",
    });
    expect(env.AWS_PROFILE).toBe("default");
    expect(env.AWS_REGIONAL_THING).toBe("x");
    expect(env.MY_REGION).toBe("eu");
  });
});
