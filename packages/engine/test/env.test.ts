import { describe, it, expect } from "vitest";

import { sanitizeChildEnv, detectProxy, detectCustomEndpoint } from "../src/env";

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

  it("strips ANTHROPIC_CUSTOM_HEADERS by default — it can smuggle Authorization/x-api-key (#145)", () => {
    const env = sanitizeChildEnv({
      PATH: "/usr/bin",
      ANTHROPIC_CUSTOM_HEADERS: "x-api-key: sk-smuggled",
    });
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
    expect(env.PATH).toBe("/usr/bin");
  });

  it("is case-insensitive about ANTHROPIC_CUSTOM_HEADERS (#145)", () => {
    const env = sanitizeChildEnv({ Anthropic_Custom_Headers: "x-api-key: sk" });
    expect(Object.keys(env)).toEqual(["MAX_THINKING_TOKENS"]);
  });

  it("keeps ANTHROPIC_CUSTOM_HEADERS when ANTHROPIC_BASE_URL is set (custom endpoint is intentional) (#145)", () => {
    const env = sanitizeChildEnv({
      ANTHROPIC_BASE_URL: "https://gateway.example",
      ANTHROPIC_CUSTOM_HEADERS: "x-tenant: acme",
    });
    expect(env.ANTHROPIC_CUSTOM_HEADERS).toBe("x-tenant: acme");
    expect(env.ANTHROPIC_BASE_URL).toBe("https://gateway.example");
  });
});

describe("detectProxy (#145)", () => {
  it("returns null when no proxy var is set", () => {
    expect(detectProxy({ PATH: "/usr/bin" })).toBeNull();
  });

  it("detects HTTPS_PROXY and returns host:port", () => {
    expect(detectProxy({ HTTPS_PROXY: "http://proxy.corp:8080" })).toBe("proxy.corp:8080");
  });

  it("detects the lowercase https_proxy variant", () => {
    expect(detectProxy({ https_proxy: "http://proxy.corp:3128" })).toBe("proxy.corp:3128");
  });

  it("detects HTTP_PROXY and ALL_PROXY", () => {
    expect(detectProxy({ HTTP_PROXY: "http://h.example:8000" })).toBe("h.example:8000");
    expect(detectProxy({ ALL_PROXY: "socks5://s.example:1080" })).toBe("s.example:1080");
  });

  it("never returns the full value — embedded credentials are dropped, host[:port] only", () => {
    const host = detectProxy({ HTTPS_PROXY: "http://user:s3cret@proxy.corp:8080/path" });
    expect(host).toBe("proxy.corp:8080");
    expect(host).not.toContain("s3cret");
    expect(host).not.toContain("user");
  });

  it("accepts a scheme-less host:port value", () => {
    expect(detectProxy({ HTTPS_PROXY: "proxy.corp:8080" })).toBe("proxy.corp:8080");
  });

  it("returns bare host when no port is present", () => {
    expect(detectProxy({ HTTPS_PROXY: "http://proxy.corp" })).toBe("proxy.corp");
  });

  it("ignores empty/whitespace values", () => {
    expect(detectProxy({ HTTPS_PROXY: "", HTTP_PROXY: "   " })).toBeNull();
  });

  it("prefers the transcript-carrying HTTPS_PROXY over HTTP_PROXY", () => {
    expect(detectProxy({ HTTP_PROXY: "http://plain:80", HTTPS_PROXY: "http://secure:443" })).toBe(
      "secure:443",
    );
  });

  it("does not leak the raw value for an unparseable proxy string", () => {
    expect(detectProxy({ HTTPS_PROXY: "://:::bogus" })).toBe("(set)");
  });
});

describe("detectCustomEndpoint (#174)", () => {
  it("returns null when ANTHROPIC_BASE_URL is unset", () => {
    expect(detectCustomEndpoint({ PATH: "/usr/bin" })).toBeNull();
  });

  it("returns null for an empty/whitespace value", () => {
    expect(detectCustomEndpoint({ ANTHROPIC_BASE_URL: "" })).toBeNull();
    expect(detectCustomEndpoint({ ANTHROPIC_BASE_URL: "   " })).toBeNull();
  });

  it("surfaces the host[:port] of a set custom endpoint", () => {
    expect(detectCustomEndpoint({ ANTHROPIC_BASE_URL: "https://gateway.example:8443" })).toBe(
      "gateway.example:8443",
    );
    expect(detectCustomEndpoint({ ANTHROPIC_BASE_URL: "https://relay.corp" })).toBe("relay.corp");
  });

  it("redacts the path/query and any embedded credentials — host[:port] only", () => {
    const host = detectCustomEndpoint({
      ANTHROPIC_BASE_URL: "https://user:s3cret@gateway.example:8443/v1/messages?key=abc",
    });
    expect(host).toBe("gateway.example:8443");
    expect(host).not.toContain("s3cret");
    expect(host).not.toContain("user");
    expect(host).not.toContain("v1");
    expect(host).not.toContain("abc");
  });

  it("accepts a scheme-less host:port value", () => {
    expect(detectCustomEndpoint({ ANTHROPIC_BASE_URL: "gateway.example:8443" })).toBe(
      "gateway.example:8443",
    );
  });

  it("does not leak the raw value for an unparseable base URL", () => {
    expect(detectCustomEndpoint({ ANTHROPIC_BASE_URL: "://:::bogus" })).toBe("(set)");
  });
});
