// Local-LLM tier wiring (PROPOSAL §4 tier 2). The engine package supplies the
// LocalLlmEngine, the pinned artifacts, and the verified model downloader;
// this glue resolves where they live on THIS machine (app data dir), acquires
// the pinned llama-server build on first use, and defers all of it until the
// engine is actually started (CLI-less start or mid-meeting fallback).

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { chmodSync, createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

import {
  ensureModel,
  LLAMA_CPP_RELEASE,
  LocalLlmEngine,
  nodeDownloadFs,
  nodeRangeFetcher,
  QWEN3_4B_Q4_K_M,
} from "@livecap/engine";
import type {
  Completion,
  CompletionRequest,
  EngineHealth,
  MeetingBrief,
  RollingContext,
  Sentence,
  Translation,
  TranslationEngine,
  Usage,
} from "@livecap/engine";

export interface LazyLocalEngineOptions {
  /** App data dir; artifacts live under `<dataDir>/llm`. */
  dataDir: string;
  targetLanguage: string;
  /** Content-free progress notices ("downloading local model 41%…"). */
  onStatus: (detail: string) => void;
}

async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

function findFile(root: string, name: string): string | null {
  for (const entry of readdirSync(root)) {
    const candidate = join(root, entry);
    const stat = statSync(candidate);
    if (stat.isDirectory()) {
      const found = findFile(candidate, name);
      if (found) return found;
    } else if (entry === name) {
      return candidate;
    }
  }
  return null;
}

function untar(archive: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("/usr/bin/tar", ["-xzf", archive, "-C", destDir], { stdio: ["ignore", "ignore", "ignore"] });
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve() : reject(new Error(`tar exited with code ${code ?? "null"}`)),
    );
  });
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

/**
 * Ensure the pinned llama-server build is present under `llmDir`, downloading
 * and SHA-256-verifying the release asset on first use. Returns the absolute
 * binary path (kept inside the extracted tree so its dylibs resolve).
 */
export async function ensureLlamaServer(llmDir: string, onStatus: (detail: string) => void): Promise<string> {
  const platformKey = process.platform === "darwin" ? "macos-arm64" : "linux-x64";
  const asset = LLAMA_CPP_RELEASE.assets[platformKey];
  const extractDir = join(llmDir, `llama-cpp-${LLAMA_CPP_RELEASE.tag}`);

  const existing = existsSync(extractDir) ? findFile(extractDir, "llama-server") : null;
  if (existing) return existing;

  mkdirSync(llmDir, { recursive: true });
  const archivePath = join(llmDir, asset.name);
  if (!existsSync(archivePath) || (await sha256File(archivePath)) !== asset.sha256) {
    if (existsSync(archivePath)) unlinkSync(archivePath);
    onStatus("downloading local inference runtime…");
    const url = `https://github.com/${LLAMA_CPP_RELEASE.repo}/releases/download/${LLAMA_CPP_RELEASE.tag}/${asset.name}`;
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`llama.cpp download failed: HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body as import("node:stream/web").ReadableStream), createWriteStream(archivePath));
    const actual = await sha256File(archivePath);
    if (actual !== asset.sha256) {
      unlinkSync(archivePath);
      throw new Error(`llama.cpp checksum mismatch: expected ${asset.sha256}, got ${actual}`);
    }
  }

  mkdirSync(extractDir, { recursive: true });
  await untar(archivePath, extractDir);
  const bin = findFile(extractDir, "llama-server");
  if (!bin) throw new Error("llama-server missing from the extracted release");
  chmodSync(bin, 0o755);
  return bin;
}

/**
 * A TranslationEngine that materializes the LocalLlmEngine on first start():
 * verified model download (resumable), pinned llama-server acquisition, free
 * port. Until then it reports "stopped" and buffers usage subscriptions so
 * FallbackRouter can wire accounting before the engine exists.
 */
export class LazyLocalEngine implements TranslationEngine {
  private engine: LocalLlmEngine | null = null;
  private readonly usageListeners = new Set<(usage: Usage) => void>();
  private starting: Promise<void> | null = null;

  constructor(private readonly options: LazyLocalEngineOptions) {}

  health(): EngineHealth {
    return this.engine ? this.engine.health() : { status: "stopped" };
  }

  onUsage(listener: (usage: Usage) => void): () => void {
    this.usageListeners.add(listener);
    return () => this.usageListeners.delete(listener);
  }

  async start(): Promise<void> {
    this.starting ??= this.materializeAndStart().catch((error: unknown) => {
      this.starting = null; // a failed start may be retried
      throw error;
    });
    await this.starting;
  }

  private async materializeAndStart(): Promise<void> {
    if (!this.engine) {
      const llmDir = join(this.options.dataDir, "llm");
      let lastPct = -1;
      const modelPath = await ensureModel({
        fs: nodeDownloadFs(),
        fetch: nodeRangeFetcher(),
        dataDir: llmDir,
        artifact: QWEN3_4B_Q4_K_M,
        onProgress: (downloaded, total) => {
          const pct = Math.floor((downloaded / total) * 100);
          if (pct !== lastPct && pct % 5 === 0) {
            lastPct = pct;
            this.options.onStatus(`downloading local model ${pct}%…`);
          }
        },
        // Surface a stalled download recovering (#65) — content-free.
        onRetry: (attempt) => {
          lastPct = -1; // force the next progress tick to re-announce
          this.options.onStatus(`download stalled — retrying (attempt ${attempt + 1})…`);
        },
      });
      const bin = await ensureLlamaServer(llmDir, this.options.onStatus);
      const port = await freePort();
      this.options.onStatus("starting local model…");
      const engine = new LocalLlmEngine({
        bin,
        modelPath,
        port,
        env: process.env,
        targetLanguage: this.options.targetLanguage,
      });
      engine.onUsage((usage) => {
        for (const listener of this.usageListeners) listener(usage);
      });
      this.engine = engine;
    }
    await this.engine.start();
  }

  async stop(): Promise<void> {
    this.starting = null;
    await this.engine?.stop();
  }

  translate(batch: Sentence[], ctx: RollingContext): AsyncIterable<Translation> {
    return this.required().translate(batch, ctx);
  }

  summarize(transcript: string): Promise<MeetingBrief> {
    return this.required().summarize(transcript);
  }

  complete(request: CompletionRequest): Promise<Completion> {
    return this.required().complete(request);
  }

  private required(): LocalLlmEngine {
    if (!this.engine) throw new Error("local engine not started");
    return this.engine;
  }
}
