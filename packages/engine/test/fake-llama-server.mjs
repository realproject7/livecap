#!/usr/bin/env node
// fake-llama-server — a test-only stand-in for llama.cpp's `llama-server`. It
// is NOT a mock of the engine: it is a real HTTP server, spawned through the
// real spawn path, that speaks the two endpoints the LocalLlmEngine uses
// (/health and POST /v1/chat/completions). This exercises the engine's
// lifecycle + HTTP client + translation guard end-to-end, headless, with no
// real llama.cpp or model.
//
// Config via flags/env (matching how the engine launches it):
//   --port <n>                 port to listen on (the engine passes this)
//   LLAMA_FAKE_CONTENT         assistant content to return (default Korean line)
//   LLAMA_FAKE_STDERR          if set, written to stderr at startup
//   LLAMA_FAKE_HEALTH_DELAY_MS delay before /health reports ok (default 0)

import http from "node:http";
import process from "node:process";

const args = process.argv.slice(2);
const portIndex = args.indexOf("--port");
const port = portIndex >= 0 ? Number(args[portIndex + 1]) : 0;

const content = process.env.LLAMA_FAKE_CONTENT ?? "안녕하세요, 잘 지내세요?";
const stderrNoise = process.env.LLAMA_FAKE_STDERR;
const healthDelayMs = Number(process.env.LLAMA_FAKE_HEALTH_DELAY_MS ?? "0");
// Accept the /health connection but never respond — simulates a server wedged
// during model load (the #34 hang case).
const healthHang = process.env.LLAMA_FAKE_HEALTH_HANG === "1";

if (stderrNoise) process.stderr.write(stderrNoise + "\n");

const startedAt = Date.now();
let lastChatRequest = null;

const server = http.createServer((req, res) => {
  if (req.method === "GET" && req.url === "/last-request") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(lastChatRequest));
    return;
  }

  if (req.method === "GET" && req.url === "/health") {
    if (healthHang) return; // hold the socket open, never respond
    if (Date.now() - startedAt < healthDelayMs) {
      res.writeHead(503, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "loading" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ status: "ok" }));
    return;
  }

  if (req.method === "POST" && req.url === "/v1/chat/completions") {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        lastChatRequest = JSON.parse(body);
      } catch {
        lastChatRequest = { parseError: true };
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message: { role: "assistant", content } }],
          usage: { prompt_tokens: 42, completion_tokens: 17 },
        }),
      );
    });
    return;
  }

  res.writeHead(404);
  res.end();
});

server.listen(port, "127.0.0.1");
