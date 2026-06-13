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

/**
 * Fetch `url`, requesting bytes from `startByte` onward (Range) when > 0. The
 * optional `signal` lets the downloader abort a stalled connection (#65) so the
 * underlying socket is torn down before a retry; a fetcher may ignore it.
 */
export type RangeFetcher = (
  url: string,
  startByte: number,
  signal?: AbortSignal,
) => Promise<RangeResponse>;

export interface EnsureModelOptions {
  fs: DownloadFs;
  fetch: RangeFetcher;
  /** App data dir (injected — never resolved inside the package). */
  dataDir: string;
  artifact: ModelArtifact;
  /** Optional progress callback: bytes downloaded so far / total. */
  onProgress?: (downloadedBytes: number, totalBytes: number) => void;
  /**
   * Stall timeout (#65): if no chunk (or the initial response) arrives within
   * this many ms the connection is aborted and the download retried from the
   * `.part` offset. Default 30_000.
   */
  stallTimeoutMs?: number;
  /** Max download attempts before giving up (#65). Default 5. */
  maxAttempts?: number;
  /** Base backoff between retries (ms); doubles each attempt (#65). Default 1_000. */
  retryBackoffMs?: number;
  /** Notified before each retry with the attempt number that just failed and why
   *  (so the consumer can surface a content-free "retrying…" status). */
  onRetry?: (failedAttempt: number, error: unknown) => void;
  /** Injected delay (testing). Default real `setTimeout`. */
  sleep?: (ms: number) => Promise<void>;
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

/** Thrown when a download makes no progress within the stall timeout (#65). */
export class ModelDownloadStallError extends Error {
  constructor(readonly stallMs: number) {
    super(`model download stalled (no data for ${stallMs}ms)`);
    this.name = "ModelDownloadStallError";
  }
}

/**
 * Resolve `promise`, but reject with a [`ModelDownloadStallError`] if it has not
 * settled within `stallMs` — calling `onStall` first so the caller can abort the
 * underlying connection (#65). The timer is cleared as soon as `promise` settles.
 */
function withStallGuard<T>(promise: Promise<T>, stallMs: number, onStall: () => void): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      onStall();
      reject(new ModelDownloadStallError(stallMs));
    }, stallMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error: unknown) => {
        clearTimeout(timer);
        reject(error as Error);
      },
    );
  });
}

/**
 * Ensure the pinned model is present and verified at `<dataDir>/<fileName>`,
 * downloading (with resume) if needed. Returns the verified absolute path.
 */
export async function ensureModel(options: EnsureModelOptions): Promise<string> {
  const { fs, fetch, dataDir, artifact, onProgress } = options;
  const stallTimeoutMs = options.stallTimeoutMs ?? 30_000;
  const maxAttempts = Math.max(1, options.maxAttempts ?? 5);
  const retryBackoffMs = options.retryBackoffMs ?? 1_000;
  const sleep = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const finalPath = fs.join(dataDir, artifact.fileName);
  const partPath = `${finalPath}.part`;

  // Already downloaded and intact? Done.
  if (fs.exists(finalPath)) {
    if ((await fs.sha256(finalPath)) === artifact.sha256) return finalPath;
    fs.unlink(finalPath); // corrupt — re-download
  }

  fs.mkdirp(dataDir);

  // One download attempt, resuming from the current `.part`. A stall (no data
  // within `stallTimeoutMs`) or transient network error throws so the caller can
  // back off and retry — the next attempt resumes from the bytes already on disk.
  const attempt = async (): Promise<string> => {
    let startByte = fs.exists(partPath) ? fs.size(partPath) : 0;
    if (startByte >= artifact.sizeBytes) {
      // A full-size (or larger) partial: a crash after the last byte but before
      // the rename. Verify it instead of sending Range:bytes=<size>- (which the
      // server answers 416 → would brick every retry). Rename if valid, else reset.
      if (startByte === artifact.sizeBytes && (await fs.sha256(partPath)) === artifact.sha256) {
        fs.rename(partPath, finalPath);
        return finalPath;
      }
      fs.unlink(partPath);
      startByte = 0;
    }

    const controller = new AbortController();
    const abort = (): void => controller.abort();
    const response = await withStallGuard(
      fetch(artifact.url, startByte, controller.signal),
      stallTimeoutMs,
      abort,
    );
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
    // Drive the stream by hand so each chunk is raced against the stall timeout;
    // a frozen connection (HuggingFace throttle, #13) aborts instead of hanging.
    const iterator = response.chunks[Symbol.asyncIterator]();
    for (;;) {
      const next = await withStallGuard(iterator.next(), stallTimeoutMs, abort);
      if (next.done) break;
      fs.appendBytes(partPath, next.value);
      downloaded += next.value.length;
      onProgress?.(downloaded, artifact.sizeBytes);
    }

    const actual = await fs.sha256(partPath);
    if (actual !== artifact.sha256) {
      fs.unlink(partPath); // discard corrupt download
      throw new ModelChecksumError(artifact.sha256, actual);
    }

    fs.rename(partPath, finalPath);
    return finalPath;
  };

  let lastError: unknown;
  for (let n = 1; n <= maxAttempts; n++) {
    try {
      return await attempt();
    } catch (error) {
      // A checksum mismatch means the bytes the server served are wrong —
      // retrying cannot fix that, so surface it immediately.
      if (error instanceof ModelChecksumError) throw error;
      lastError = error;
      options.onRetry?.(n, error);
      if (n < maxAttempts) await sleep(retryBackoffMs * 2 ** (n - 1));
    }
  }
  throw lastError ?? new Error("model download failed");
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
  return async (url, startByte, signal) => {
    const headers: Record<string, string> = {};
    if (startByte > 0) headers.Range = `bytes=${startByte}-`;
    const res = await fetch(url, { headers, signal });
    const body = res.body;
    if (!body) throw new Error(`no response body for ${url}`);
    return { status: res.status, chunks: body as unknown as AsyncIterable<Uint8Array> };
  };
}
