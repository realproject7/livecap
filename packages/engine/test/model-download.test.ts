import { createHash } from "node:crypto";
import { describe, it, expect } from "vitest";

import { ensureModel, ModelChecksumError, ModelDownloadStallError } from "../src/model-download";
import type { DownloadFs, RangeFetcher } from "../src/model-download";
import type { ModelArtifact } from "../src/pins";

const GOOD = new TextEncoder().encode("GGUF\x00 fake model bytes ".repeat(8));
const GOOD_SHA = createHash("sha256").update(GOOD).digest("hex");

const ARTIFACT: ModelArtifact = {
  repo: "test/repo",
  fileName: "model.gguf",
  url: "https://example/model.gguf",
  sha256: GOOD_SHA,
  sizeBytes: GOOD.length,
  license: "Apache-2.0",
};

const DATA_DIR = "/data/models";

class MemFs implements DownloadFs {
  files = new Map<string, Uint8Array>();
  join(...segments: string[]): string {
    return segments.join("/").replace(/\/+/g, "/");
  }
  exists(path: string): boolean {
    return this.files.has(path);
  }
  size(path: string): number {
    return this.files.get(path)?.length ?? 0;
  }
  async sha256(path: string): Promise<string> {
    return createHash("sha256")
      .update(this.files.get(path) ?? new Uint8Array())
      .digest("hex");
  }
  mkdirp(): void {}
  appendBytes(path: string, data: Uint8Array): void {
    const cur = this.files.get(path) ?? new Uint8Array();
    const merged = new Uint8Array(cur.length + data.length);
    merged.set(cur);
    merged.set(data, cur.length);
    this.files.set(path, merged);
  }
  rename(from: string, to: string): void {
    this.files.set(to, this.files.get(from) as Uint8Array);
    this.files.delete(from);
  }
  unlink(path: string): void {
    this.files.delete(path);
  }
}

/** A fetcher that serves `bytes`, honoring Range, recording the requested start. */
function fetcherFor(bytes: Uint8Array): RangeFetcher & { lastStart: number; calls: number } {
  const f = (async (_url: string, startByte: number) => {
    f.lastStart = startByte;
    f.calls += 1;
    const slice = bytes.slice(startByte);
    async function* chunks(): AsyncIterable<Uint8Array> {
      for (let i = 0; i < slice.length; i += 8) yield slice.slice(i, i + 8);
    }
    return { status: startByte > 0 ? 206 : 200, chunks: chunks() };
  }) as RangeFetcher & { lastStart: number; calls: number };
  f.lastStart = -1;
  f.calls = 0;
  return f;
}

describe("ensureModel", () => {
  it("downloads, verifies SHA-256, and returns the final path", async () => {
    const fs = new MemFs();
    const fetch = fetcherFor(GOOD);
    const path = await ensureModel({ fs, fetch, dataDir: DATA_DIR, artifact: ARTIFACT });

    expect(path).toBe("/data/models/model.gguf");
    expect(fs.exists(path)).toBe(true);
    expect(fs.exists(`${path}.part`)).toBe(false); // .part renamed away
  });

  it("throws ModelChecksumError and discards the partial on a bad checksum", async () => {
    const fs = new MemFs();
    const corrupt = new TextEncoder().encode("totally different bytes");
    const fetch = fetcherFor(corrupt);

    await expect(ensureModel({ fs, fetch, dataDir: DATA_DIR, artifact: ARTIFACT })).rejects.toBeInstanceOf(
      ModelChecksumError,
    );
    expect(fs.exists("/data/models/model.gguf")).toBe(false);
    expect(fs.exists("/data/models/model.gguf.part")).toBe(false);
  });

  it("resumes from a partial download using a Range request", async () => {
    const fs = new MemFs();
    const half = Math.floor(GOOD.length / 2);
    fs.files.set("/data/models/model.gguf.part", GOOD.slice(0, half));
    const fetch = fetcherFor(GOOD);

    const path = await ensureModel({ fs, fetch, dataDir: DATA_DIR, artifact: ARTIFACT });

    expect(fetch.lastStart).toBe(half); // resumed, did not restart from 0
    expect(await fs.sha256(path)).toBe(GOOD_SHA);
  });

  it("renames a verified complete partial instead of bricking on a 416", async () => {
    // Crash after the last byte but before the rename: <file>.part is full-size.
    const fs = new MemFs();
    fs.files.set("/data/models/model.gguf.part", GOOD);
    const fetch: RangeFetcher = async () => {
      throw new Error("must not fetch a complete, valid partial");
    };
    const path = await ensureModel({ fs, fetch, dataDir: DATA_DIR, artifact: ARTIFACT });
    expect(path).toBe("/data/models/model.gguf");
    expect(await fs.sha256(path)).toBe(GOOD_SHA);
    expect(fs.exists("/data/models/model.gguf.part")).toBe(false);
  });

  it("restarts from zero when a full-size partial is corrupt", async () => {
    const fs = new MemFs();
    fs.files.set("/data/models/model.gguf.part", new Uint8Array(GOOD.length)); // right size, wrong bytes
    const fetch = fetcherFor(GOOD);
    const path = await ensureModel({ fs, fetch, dataDir: DATA_DIR, artifact: ARTIFACT });
    expect(fetch.lastStart).toBe(0);
    expect(await fs.sha256(path)).toBe(GOOD_SHA);
  });

  it("skips the download when the file is already present and valid", async () => {
    const fs = new MemFs();
    fs.files.set("/data/models/model.gguf", GOOD);
    const fetch = fetcherFor(GOOD);

    const path = await ensureModel({ fs, fetch, dataDir: DATA_DIR, artifact: ARTIFACT });
    expect(path).toBe("/data/models/model.gguf");
    expect(fetch.calls).toBe(0); // never hit the network
  });

  it("re-downloads when an existing file is corrupt", async () => {
    const fs = new MemFs();
    fs.files.set("/data/models/model.gguf", new TextEncoder().encode("corrupt"));
    const fetch = fetcherFor(GOOD);

    const path = await ensureModel({ fs, fetch, dataDir: DATA_DIR, artifact: ARTIFACT });
    expect(fetch.calls).toBe(1);
    expect(await fs.sha256(path)).toBe(GOOD_SHA);
  });

  // --- stall detection + retry/backoff (#65) -------------------------------

  const NO_WAIT = (): Promise<void> => Promise.resolve();
  const hangForever = (): Promise<never> => new Promise<never>(() => {});

  /**
   * A fetcher whose first `stallCalls` streams yield one chunk and then freeze
   * (no more data, connection open) — the #13 HuggingFace-throttle shape. Later
   * calls serve the rest normally, resuming from the Range offset.
   */
  function stallingFetcher(
    bytes: Uint8Array,
    stallCalls: number,
  ): RangeFetcher & { calls: number } {
    const f = (async (_url: string, startByte: number) => {
      f.calls += 1;
      const thisCall = f.calls;
      const slice = bytes.slice(startByte);
      async function* chunks(): AsyncIterable<Uint8Array> {
        if (slice.length > 0) yield slice.slice(0, 8); // one chunk of progress
        if (thisCall <= stallCalls) {
          await hangForever(); // then the connection freezes → stall guard fires
        }
        for (let i = 8; i < slice.length; i += 8) yield slice.slice(i, i + 8);
      }
      return { status: startByte > 0 ? 206 : 200, chunks: chunks() };
    }) as RangeFetcher & { calls: number };
    f.calls = 0;
    return f;
  }

  it("aborts a stalled stream and retries from the .part offset until it completes (#65)", async () => {
    const fs = new MemFs();
    const fetch = stallingFetcher(GOOD, 2); // stall twice, then succeed
    const retries: number[] = [];

    const path = await ensureModel({
      fs,
      fetch,
      dataDir: DATA_DIR,
      artifact: ARTIFACT,
      stallTimeoutMs: 20,
      retryBackoffMs: 0,
      sleep: NO_WAIT,
      onRetry: (n) => retries.push(n),
    });

    expect(retries).toEqual([1, 2]); // two stalls surfaced before success
    expect(fetch.calls).toBe(3);
    expect(await fs.sha256(path)).toBe(GOOD_SHA);
    expect(fs.exists("/data/models/model.gguf.part")).toBe(false);
  });

  it("gives up with a ModelDownloadStallError after maxAttempts of no progress (#65)", async () => {
    const fs = new MemFs();
    const fetch = stallingFetcher(GOOD, Number.POSITIVE_INFINITY); // never recovers

    await expect(
      ensureModel({
        fs,
        fetch,
        dataDir: DATA_DIR,
        artifact: ARTIFACT,
        stallTimeoutMs: 20,
        maxAttempts: 3,
        retryBackoffMs: 0,
        sleep: NO_WAIT,
      }),
    ).rejects.toBeInstanceOf(ModelDownloadStallError);
    expect(fetch.calls).toBe(3); // all attempts used
  });

  it("aborts a fetch that never responds and retries (#65)", async () => {
    const fs = new MemFs();
    let calls = 0;
    const fetch: RangeFetcher = async (_url, startByte) => {
      calls += 1;
      if (calls === 1) return hangForever(); // the connection itself hangs
      const slice = GOOD.slice(startByte);
      async function* chunks(): AsyncIterable<Uint8Array> {
        for (let i = 0; i < slice.length; i += 8) yield slice.slice(i, i + 8);
      }
      return { status: startByte > 0 ? 206 : 200, chunks: chunks() };
    };

    const path = await ensureModel({
      fs,
      fetch,
      dataDir: DATA_DIR,
      artifact: ARTIFACT,
      stallTimeoutMs: 20,
      retryBackoffMs: 0,
      sleep: NO_WAIT,
    });
    expect(calls).toBe(2);
    expect(await fs.sha256(path)).toBe(GOOD_SHA);
  });

  it("reports progress as bytes arrive", async () => {
    const fs = new MemFs();
    const fetch = fetcherFor(GOOD);
    let lastDownloaded = 0;
    let lastTotal = 0;
    await ensureModel({
      fs,
      fetch,
      dataDir: DATA_DIR,
      artifact: ARTIFACT,
      onProgress: (downloaded, total) => {
        lastDownloaded = downloaded;
        lastTotal = total;
      },
    });
    expect(lastDownloaded).toBe(GOOD.length);
    expect(lastTotal).toBe(ARTIFACT.sizeBytes);
  });
});
