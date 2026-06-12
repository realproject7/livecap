// First-use model acquisition (issue #6): download a pinned GGUF into the app
// data dir with SHA-256 verification and resume. Filesystem and HTTP are
// injected so the package never hardcodes platform paths and stays
// headless-testable; the node-backed implementations are provided for the
// consumer to wire in.

import { createHash } from "node:crypto";
import {
  appendFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";

import type { ModelArtifact } from "./pins";

/** Filesystem surface the downloader needs (injected). */
export interface DownloadFs {
  join(...segments: string[]): string;
  exists(path: string): boolean;
  /** Size in bytes of an existing file. */
  size(path: string): number;
  /** Lowercase hex SHA-256 of a file's contents. */
  sha256(path: string): Promise<string>;
  mkdirp(dir: string): void;
  appendBytes(path: string, data: Uint8Array): void;
  rename(from: string, to: string): void;
  unlink(path: string): void;
}

export interface RangeResponse {
  /** HTTP status (200 full, 206 partial). */
  status: number;
  /** Body as an async stream of byte chunks. */
  chunks: AsyncIterable<Uint8Array>;
}

/** Fetch `url`, requesting bytes from `startByte` onward (Range) when > 0. */
export type RangeFetcher = (url: string, startByte: number) => Promise<RangeResponse>;

export interface EnsureModelOptions {
  fs: DownloadFs;
  fetch: RangeFetcher;
  /** App data dir (injected — never resolved inside the package). */
  dataDir: string;
  artifact: ModelArtifact;
  /** Optional progress callback: bytes downloaded so far / total. */
  onProgress?: (downloadedBytes: number, totalBytes: number) => void;
}

/** Thrown when the completed download fails SHA-256 verification. */
export class ModelChecksumError extends Error {
  constructor(
    readonly expected: string,
    readonly actual: string,
  ) {
    super(`model checksum mismatch: expected ${expected}, got ${actual}`);
    this.name = "ModelChecksumError";
  }
}

/**
 * Ensure the pinned model is present and verified at `<dataDir>/<fileName>`,
 * downloading (with resume) if needed. Returns the verified absolute path.
 */
export async function ensureModel(options: EnsureModelOptions): Promise<string> {
  const { fs, fetch, dataDir, artifact, onProgress } = options;
  const finalPath = fs.join(dataDir, artifact.fileName);
  const partPath = `${finalPath}.part`;

  // Already downloaded and intact? Done.
  if (fs.exists(finalPath)) {
    if ((await fs.sha256(finalPath)) === artifact.sha256) return finalPath;
    fs.unlink(finalPath); // corrupt — re-download
  }

  fs.mkdirp(dataDir);

  // Resume from a prior partial file if present.
  let startByte = fs.exists(partPath) ? fs.size(partPath) : 0;
  if (startByte > artifact.sizeBytes) {
    // Partial is larger than the target (stale/corrupt) — start over.
    fs.unlink(partPath);
    startByte = 0;
  }

  const response = await fetch(artifact.url, startByte);
  if (startByte > 0 && response.status === 200) {
    // Server ignored the Range request and is sending the whole file — reset.
    fs.unlink(partPath);
    startByte = 0;
  } else if (startByte > 0 && response.status !== 206) {
    throw new Error(`resume failed: expected 206, got HTTP ${response.status}`);
  } else if (startByte === 0 && response.status !== 200 && response.status !== 206) {
    throw new Error(`download failed: HTTP ${response.status}`);
  }

  let downloaded = startByte;
  for await (const chunk of response.chunks) {
    fs.appendBytes(partPath, chunk);
    downloaded += chunk.length;
    onProgress?.(downloaded, artifact.sizeBytes);
  }

  const actual = await fs.sha256(partPath);
  if (actual !== artifact.sha256) {
    fs.unlink(partPath); // discard corrupt download
    throw new ModelChecksumError(artifact.sha256, actual);
  }

  fs.rename(partPath, finalPath);
  return finalPath;
}

/** A node-backed DownloadFs for production use. */
export function nodeDownloadFs(): DownloadFs {
  return {
    join: (...segments) => segments.join("/").replace(/\/+/g, "/"),
    exists: (path) => existsSync(path),
    size: (path) => statSync(path).size,
    sha256: (path) =>
      new Promise((resolve, reject) => {
        const hash = createHash("sha256");
        const stream = createReadStream(path);
        stream.on("data", (chunk) => hash.update(chunk));
        stream.on("end", () => resolve(hash.digest("hex")));
        stream.on("error", reject);
      }),
    mkdirp: (dir) => void mkdirSync(dir, { recursive: true }),
    appendBytes: (path, data) => appendFileSync(path, data),
    rename: (from, to) => renameSync(from, to),
    unlink: (path) => unlinkSync(path),
  };
}

/** A node fetch-backed RangeFetcher (uses global fetch). */
export function nodeRangeFetcher(): RangeFetcher {
  return async (url, startByte) => {
    const headers: Record<string, string> = {};
    if (startByte > 0) headers.Range = `bytes=${startByte}-`;
    const res = await fetch(url, { headers });
    const body = res.body;
    if (!body) throw new Error(`no response body for ${url}`);
    return { status: res.status, chunks: body as unknown as AsyncIterable<Uint8Array> };
  };
}
