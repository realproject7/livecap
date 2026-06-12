// Supply-chain pins (issue #6 amendments). The local-LLM tier ships in MVP as
// policy insurance (PROPOSAL §4 tier 2, §10 Risk 1). Both the model GGUF and
// the llama.cpp binaries are resolved at runtime and NEVER committed; what is
// committed here is their exact identity + checksum so the consumer can verify
// any download. Provenance is recorded in the repo-root NOTICE (Apache-2.0).

export interface ModelArtifact {
  /** Hugging Face repo id (official Qwen org — no third-party re-quantizations). */
  repo: string;
  fileName: string;
  /** Canonical download URL. */
  url: string;
  /** Lowercase hex SHA-256 of the file contents (HF LFS oid). */
  sha256: string;
  sizeBytes: number;
  license: string;
}

/**
 * Qwen3-4B (Apache-2.0), Q4_K_M GGUF from the official `Qwen/Qwen3-4B-GGUF`
 * repo. SHA-256 + size verified against the Hugging Face LFS metadata
 * (2026-06-12). ~2.5 GB on disk, ~3 GB RAM alongside Whisper (PROPOSAL §4).
 */
export const QWEN3_4B_Q4_K_M: ModelArtifact = {
  repo: "Qwen/Qwen3-4B-GGUF",
  fileName: "Qwen3-4B-Q4_K_M.gguf",
  url: "https://huggingface.co/Qwen/Qwen3-4B-GGUF/resolve/main/Qwen3-4B-Q4_K_M.gguf",
  sha256: "7485fe6f11af29433bc51cab58009521f205840f5b4ae3a32fa7f92e8534fdf5",
  sizeBytes: 2497280256,
  license: "Apache-2.0",
};

export interface LlamaCppAsset {
  name: string;
  /** Lowercase hex SHA-256 of the release asset (GitHub asset digest). */
  sha256: string;
}

export interface LlamaCppReleasePin {
  repo: string;
  tag: string;
  assets: Record<"linux-x64" | "macos-arm64", LlamaCppAsset>;
}

/**
 * llama.cpp prebuilt server, pinned to a release tag (MIT). Per-platform asset
 * digests verified against the GitHub release `b9601` (2026-06-12). The
 * consumer downloads, verifies, and extracts `llama-server` from these.
 */
export const LLAMA_CPP_RELEASE: LlamaCppReleasePin = {
  repo: "ggml-org/llama.cpp",
  tag: "b9601",
  assets: {
    "linux-x64": {
      name: "llama-b9601-bin-ubuntu-x64.tar.gz",
      sha256: "16d7cd9e190c63d0355a2eb751333fb806f32b9a0ba30f8a52255f0a9de407fd",
    },
    "macos-arm64": {
      name: "llama-b9601-bin-macos-arm64.tar.gz",
      sha256: "8e26998a6a47f68142a42006247ecd0a4c6b9a72accc67d88834c851b4703e1f",
    },
  },
};
