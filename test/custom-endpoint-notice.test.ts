// #174: prove the VISIBLE HostSession notice, not just the detector. `start()`
// spawns real CLI/llama-server children (no headless harness — see
// session-accounting.test.ts), so the status string + its redaction are factored
// into the pure, exported `customEndpointNotice`, which is exactly what the CLI
// path emits: `if (endpointNotice) emit({ type: "status", detail: endpointNotice })`.
// These assert the emitted status when ANTHROPIC_BASE_URL is set (redacted to the
// safe host) and that NO endpoint status is produced when it is unset.

import { describe, expect, it } from "vitest";

import { customEndpointNotice } from "../src/host/session";

describe("customEndpointNotice (#174 visible endpoint status)", () => {
  it("produces NO endpoint status when ANTHROPIC_BASE_URL is unset", () => {
    expect(customEndpointNotice({ PATH: "/usr/bin" })).toBeNull();
  });

  it("produces NO endpoint status for an empty/whitespace value", () => {
    expect(customEndpointNotice({ ANTHROPIC_BASE_URL: "" })).toBeNull();
    expect(customEndpointNotice({ ANTHROPIC_BASE_URL: "   " })).toBeNull();
  });

  it("emits exactly the redacted endpoint status when ANTHROPIC_BASE_URL is set", () => {
    expect(customEndpointNotice({ ANTHROPIC_BASE_URL: "https://gateway.example:8443" })).toBe(
      "translation traffic is routing to a custom Anthropic endpoint: gateway.example:8443",
    );
    // Bare host when no port is present.
    expect(customEndpointNotice({ ANTHROPIC_BASE_URL: "https://relay.corp" })).toBe(
      "translation traffic is routing to a custom Anthropic endpoint: relay.corp",
    );
  });

  it("carries ONLY the safe host — credentials, path, and query never reach the status", () => {
    const notice = customEndpointNotice({
      ANTHROPIC_BASE_URL: "https://user:s3cret@gateway.example:8443/v1/messages?key=abc",
    });
    expect(notice).toBe(
      "translation traffic is routing to a custom Anthropic endpoint: gateway.example:8443",
    );
    expect(notice).not.toContain("s3cret");
    expect(notice).not.toContain("user");
    expect(notice).not.toContain("v1");
    expect(notice).not.toContain("abc");
  });
});
