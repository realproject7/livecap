// Root app-glue tests (feed state reducer, host translation runner, event
// adapters). Headless — no Tauri, no audio, no CLI.
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["test/**/*.test.ts"],
    environment: "node",
  },
});
