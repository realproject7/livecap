import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // Backstop sweep of any fake-llama-server child a rare missed-kill path
    // leaves alive — runs once in the main process after all suites finish.
    globalSetup: ["./test/global-teardown.mjs"],
  },
});
