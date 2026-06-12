// Runs the shared TranslationEngine conformance suite against BOTH engines
// (#6 AC). Each uses its own real-spawn test double: the CLI adapter replays a
// recorded stream-json fixture via fake-cli; the local engine talks HTTP to the
// fake llama-server.

import { createServer } from "node:net";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { ClaudeCliEngine } from "../src/claude-cli-engine";
import { LocalLlmEngine } from "../src/local-llm-engine";
import { runTranslationEngineConformance } from "./conformance";

const FAKE_CLI = fileURLToPath(new URL("./fake-cli.mjs", import.meta.url));
const FAKE_SERVER = fileURLToPath(new URL("./fake-llama-server.mjs", import.meta.url));
const FIXTURE = fileURLToPath(
  new URL("./fixtures/claude-stream/session-without-partials.jsonl", import.meta.url),
);

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const port = (server.address() as AddressInfo).port;
      server.close(() => resolve(port));
    });
  });
}

runTranslationEngineConformance({
  label: "ClaudeCliEngine",
  makeEngine: async () =>
    new ClaudeCliEngine({
      bin: FAKE_CLI,
      cwd: tmpdir(),
      env: { ...process.env, LIVECAP_FAKE_FIXTURE: FIXTURE },
      includePartialMessages: false,
    }),
});

runTranslationEngineConformance({
  label: "LocalLlmEngine",
  makeEngine: async () =>
    new LocalLlmEngine({
      bin: FAKE_SERVER,
      modelPath: `${tmpdir()}/unused.gguf`,
      port: await freePort(),
      startupTimeoutMs: 8000,
      env: { ...process.env, LLAMA_FAKE_CONTENT: "[decision] ship it\n저희는 전념하고 있습니다." },
    }),
});
