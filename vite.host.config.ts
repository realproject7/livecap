// Build config for the Node session host (src/host). The host runs the
// Node-only @livecap/engine and @livecap/archive packages (child processes,
// fs) outside the webview; the Rust shell spawns `node dist-host/main.mjs`
// per session and bridges it to the UI over stdio (see src-tauri/src/session.rs).
import { defineConfig } from "vite";

export default defineConfig({
  build: {
    ssr: "src/host/main.ts",
    outDir: "dist-host",
    target: "node20",
    emptyOutDir: true,
    minify: false,
    rollupOptions: {
      output: { entryFileNames: "main.mjs" },
    },
  },
  ssr: {
    // Bundle the workspace packages (they ship TS sources); node: builtins
    // stay external automatically.
    noExternal: true,
  },
});
