//! Whisper model management: first-use download with SHA-256 verification.
//!
//! Derived from Meetily `src/whisper_engine/whisper_engine.rs` (MIT) model
//! handling, with checksum verification added: the expected SHA-256 comes
//! from the Hugging Face git-LFS pointer for the same file, so no hash is
//! hardcoded and every supported model is covered.
//!
//! The models directory is always injected by the caller — nothing in this
//! crate decides where model files live.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use futures_util::StreamExt;
use sha2::{Digest, Sha256};
use tokio::fs;
use tokio::io::{AsyncReadExt, AsyncWriteExt};

use crate::error::CoreError;

/// Default model for live captioning (good accuracy/latency balance).
pub const DEFAULT_MODEL: &str = "small";

/// Hugging Face repo hosting the official ggerganov/whisper.cpp models.
const HF_REPO: &str = "https://huggingface.co/ggerganov/whisper.cpp";

/// Env var overriding the BLOB download base URL ONLY (#110): a dev-run knob
/// for exercising the download-failure fallback against an unreachable host
/// (the AC's "point at an unreachable URL" verification). Unset/empty keeps
/// the official repo.
///
/// SECURITY: this override deliberately never applies to the expected-SHA-256
/// source — [`pointer_url`] is pinned to the official [`HF_REPO`] — so an
/// overridden host cannot serve a fake LFS pointer alongside a matching fake
/// blob; any blob that does not match the OFFICIAL digest fails verification.
// Release builds never read this env var (#177), so the const is unused there —
// which is the point: an unused const emits no string, so the release binary
// carries no `LIVECAP_MODEL_BASE_URL` symbol (asserted by the release-invariants
// CI gate). The `allow(dead_code)` only silences the release-profile warning.
#[cfg_attr(not(debug_assertions), allow(dead_code))]
const MODEL_BASE_URL_ENV: &str = "LIVECAP_MODEL_BASE_URL";

/// The effective BLOB download base URL. Debug builds honor the
/// [`MODEL_BASE_URL_ENV`] dev-run knob (#110 download-failure fallback); RELEASE
/// builds ALWAYS use the official [`HF_REPO`] — the env read is compiled out
/// entirely (#177, mirroring #146/#161), so a shipped binary exposes no such knob
/// and its model-download host can't be redirected. The pure
/// [`base_url_or_default`] core stays testable in both profiles.
#[cfg(debug_assertions)]
fn blob_base_url() -> String {
    base_url_or_default(std::env::var(MODEL_BASE_URL_ENV).ok())
}

#[cfg(not(debug_assertions))]
fn blob_base_url() -> String {
    base_url_or_default(None)
}

/// Pure core of [`blob_base_url`]: `None`/blank → the official repo. Trailing
/// slashes are trimmed so the joined download URLs stay well-formed.
fn base_url_or_default(overridden: Option<String>) -> String {
    match overridden {
        Some(url) if !url.trim().is_empty() => url.trim().trim_end_matches('/').to_string(),
        _ => HF_REPO.to_string(),
    }
}

/// Model BLOB download URL under `base` — the ONLY URL the env override moves.
fn blob_url(base: &str, filename: &str) -> String {
    format!("{base}/resolve/main/{filename}")
}

/// Git-LFS pointer URL for the expected SHA-256: ALWAYS the official
/// [`HF_REPO`], deliberately NOT overridable (see [`MODEL_BASE_URL_ENV`]) so
/// the digest source can never move with the download source.
fn pointer_url(filename: &str) -> String {
    format!("{HF_REPO}/raw/main/{filename}")
}

/// Supported model names (same set Meetily downloads).
pub const MODEL_NAMES: &[&str] = &[
    "tiny",
    "base",
    "small",
    "medium",
    "large-v3-turbo",
    "large-v3",
    "tiny-q5_1",
    "base-q5_1",
    "small-q5_1",
    "medium-q5_0",
    "large-v3-turbo-q5_0",
    "large-v3-q5_0",
];

/// `ggml-{name}.bin` for a known model name.
pub fn model_filename(model_name: &str) -> Result<String> {
    if MODEL_NAMES.contains(&model_name) {
        Ok(format!("ggml-{model_name}.bin"))
    } else {
        Err(CoreError::UnknownModel(model_name.to_string()).into())
    }
}

/// Manages whisper model files inside a caller-provided directory.
pub struct ModelManager {
    models_dir: PathBuf,
}

impl ModelManager {
    pub fn new(models_dir: impl Into<PathBuf>) -> Self {
        Self {
            models_dir: models_dir.into(),
        }
    }

    pub fn models_dir(&self) -> &Path {
        &self.models_dir
    }

    /// Local path the model will live at.
    pub fn model_path(&self, model_name: &str) -> Result<PathBuf> {
        Ok(self.models_dir.join(model_filename(model_name)?))
    }

    /// Ensure `model_name` exists locally with a verified SHA-256, downloading
    /// it on first use. Returns the model file path.
    pub async fn ensure_model(&self, model_name: &str) -> Result<PathBuf> {
        self.ensure_model_with_progress(model_name, |_| {}).await
    }

    /// Like [`Self::ensure_model`], reporting whole-percent download progress
    /// (1–100) to `on_progress` while the model streams down (#110). A model
    /// that is already present reports nothing.
    pub async fn ensure_model_with_progress(
        &self,
        model_name: &str,
        on_progress: impl FnMut(u64),
    ) -> Result<PathBuf> {
        let filename = model_filename(model_name)?;
        let path = self.models_dir.join(&filename);
        let marker = self.models_dir.join(format!("{filename}.sha256"));

        if path.exists() {
            validate_ggml_magic(&path).await.with_context(|| {
                format!(
                    "{} exists but is not a valid GGML/GGUF file — delete it and retry",
                    path.display()
                )
            })?;

            // Fast path: hash was verified after a previous download.
            if marker.exists() {
                return Ok(path);
            }

            // Pre-existing file without a verification marker: hash it once
            // against the upstream pointer.
            let expected = fetch_expected_sha256(&filename).await?;
            let actual = sha256_of_file(&path).await?;
            if actual == expected.sha256 {
                fs::write(&marker, &actual).await?;
                return Ok(path);
            }
            log::warn!(
                "Model {} failed checksum verification (expected {}, got {}) — re-downloading",
                filename,
                expected.sha256,
                actual
            );
            fs::remove_file(&path).await?;
        }

        self.download_and_verify(model_name, &filename, &path, &marker, on_progress)
            .await?;
        Ok(path)
    }

    async fn download_and_verify(
        &self,
        model_name: &str,
        filename: &str,
        path: &Path,
        marker: &Path,
        mut on_progress: impl FnMut(u64),
    ) -> Result<()> {
        fs::create_dir_all(&self.models_dir).await.with_context(|| {
            format!("Failed to create models directory {}", self.models_dir.display())
        })?;

        let expected = fetch_expected_sha256(filename).await?;
        let url = blob_url(&blob_base_url(), filename);
        log::info!(
            "Downloading whisper model '{}' ({:.1} MB) from {}",
            model_name,
            expected.size as f64 / (1024.0 * 1024.0),
            url
        );

        let response = reqwest::get(&url)
            .await
            .with_context(|| format!("Failed to start download of {url}"))?;
        if !response.status().is_success() {
            return Err(anyhow!(
                "Download of {} failed with HTTP status {}",
                url,
                response.status()
            ));
        }

        // Download to a temp file, hashing as we stream, then rename.
        let partial = path.with_extension("bin.partial");
        let mut file = fs::File::create(&partial).await?;
        let mut hasher = Sha256::new();
        let mut downloaded: u64 = 0;
        let mut last_reported_pct: u64 = 0;
        let mut last_logged_pct: u64 = 0;

        let mut stream = response.bytes_stream();
        while let Some(chunk) = stream.next().await {
            let chunk = chunk.context("Failed to read download chunk")?;
            hasher.update(&chunk);
            file.write_all(&chunk).await?;
            downloaded += chunk.len() as u64;

            if let Some(pct) = (downloaded * 100).checked_div(expected.size) {
                // #110: whole-percent callback for UI progress; log every 10%.
                if pct > last_reported_pct {
                    last_reported_pct = pct;
                    on_progress(pct.min(100));
                }
                if pct >= last_logged_pct + 10 {
                    log::info!(
                        "Model download progress: {}% ({:.1} MB / {:.1} MB)",
                        pct,
                        downloaded as f64 / (1024.0 * 1024.0),
                        expected.size as f64 / (1024.0 * 1024.0)
                    );
                    last_logged_pct = pct;
                }
            }
        }
        file.flush().await?;
        drop(file);

        let actual = hex::encode(hasher.finalize());
        if actual != expected.sha256 {
            let _ = fs::remove_file(&partial).await;
            return Err(CoreError::ModelChecksumMismatch {
                model: model_name.to_string(),
                expected: expected.sha256,
                actual,
            }
            .into());
        }

        fs::rename(&partial, path).await?;
        fs::write(marker, &actual).await?;
        log::info!(
            "Model '{}' downloaded and SHA-256 verified ({})",
            model_name,
            actual
        );
        Ok(())
    }
}

/// Expected hash and size parsed from the Hugging Face git-LFS pointer.
struct ExpectedDigest {
    sha256: String,
    size: u64,
}

/// Fetch the git-LFS pointer for `filename` and parse `oid sha256:...` and
/// `size ...` from it. The pointer lives in the repo's git tree, while
/// `resolve/` serves the actual blob — so this is an authoritative,
/// non-hardcoded source for the expected digest. The pointer URL is PINNED to
/// the official repo (never the env override) so the digest stays authentic
/// even when the blob download host is redirected.
async fn fetch_expected_sha256(filename: &str) -> Result<ExpectedDigest> {
    let url = pointer_url(filename);
    let body = reqwest::get(&url)
        .await
        .with_context(|| format!("Failed to fetch LFS pointer {url}"))?
        .error_for_status()
        .with_context(|| format!("LFS pointer request rejected for {url}"))?
        .text()
        .await?;

    let mut sha256 = None;
    let mut size = 0u64;
    for line in body.lines() {
        if let Some(oid) = line.strip_prefix("oid sha256:") {
            sha256 = Some(oid.trim().to_string());
        } else if let Some(s) = line.strip_prefix("size ") {
            size = s.trim().parse().unwrap_or(0);
        }
    }

    let sha256 = sha256.ok_or_else(|| {
        anyhow!(
            "No sha256 oid found in LFS pointer for {} — response was: {:.200}",
            filename,
            body
        )
    })?;
    Ok(ExpectedDigest { sha256, size })
}

/// Validate the GGML/GGUF magic number at the start of a model file
/// (covers both endiannesses, as in Meetily).
async fn validate_ggml_magic(model_path: &Path) -> Result<()> {
    let mut file = fs::File::open(model_path)
        .await
        .map_err(|e| anyhow!("Failed to open model file: {}", e))?;

    let mut buffer = [0u8; 8];
    file.read_exact(&mut buffer)
        .await
        .map_err(|e| anyhow!("Failed to read model file header: {}", e))?;

    if buffer.starts_with(b"ggml")
        || buffer.starts_with(b"GGUF")
        || buffer.starts_with(b"ggmf")
        || buffer.starts_with(b"lmgg")
        || buffer.starts_with(b"FUGU")
        || buffer.starts_with(b"fmgg")
    {
        Ok(())
    } else {
        Err(anyhow!(
            "Invalid model file: missing GGML/GGUF magic number. Found: {:?}",
            String::from_utf8_lossy(&buffer[..4])
        ))
    }
}

/// Stream a file through SHA-256.
async fn sha256_of_file(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path).await?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; 1024 * 1024];
    loop {
        let n = file.read(&mut buf).await?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex::encode(hasher.finalize()))
}

/// Minimal lowercase-hex encoding (avoids an extra dependency).
mod hex {
    pub fn encode(bytes: impl AsRef<[u8]>) -> String {
        bytes
            .as_ref()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_models_map_to_ggml_filenames() {
        assert_eq!(model_filename("small").unwrap(), "ggml-small.bin");
        assert_eq!(model_filename("tiny").unwrap(), "ggml-tiny.bin");
        assert_eq!(
            model_filename("large-v3-turbo-q5_0").unwrap(),
            "ggml-large-v3-turbo-q5_0.bin"
        );
    }

    #[test]
    fn unknown_model_is_a_typed_error() {
        let err = model_filename("gigantic-v9").unwrap_err();
        assert!(matches!(
            err.downcast_ref::<CoreError>(),
            Some(CoreError::UnknownModel(_))
        ));
    }

    #[test]
    fn hex_encodes_lowercase() {
        assert_eq!(hex::encode([0u8, 255, 16]), "00ff10");
    }

    #[test]
    fn base_url_override_defaults_to_the_official_repo() {
        // #110: unset/blank keeps the official repo; a dev override is used
        // verbatim (minus trailing slashes) so the fallback path is testable.
        assert_eq!(base_url_or_default(None), HF_REPO);
        assert_eq!(base_url_or_default(Some("".into())), HF_REPO);
        assert_eq!(base_url_or_default(Some("   ".into())), HF_REPO);
        assert_eq!(
            base_url_or_default(Some("http://127.0.0.1:1/".into())),
            "http://127.0.0.1:1"
        );
    }

    #[test]
    fn override_moves_only_the_blob_url_never_the_digest_source() {
        // SECURITY (#110 review): the base-URL override must affect ONLY the
        // blob download URL. The expected-SHA-256 LFS-pointer URL is pinned to
        // the official repo, so an overridden host cannot serve a fake pointer
        // with a matching fake blob and have it "verify".
        let overridden = base_url_or_default(Some("http://127.0.0.1:1".into()));
        assert_eq!(
            blob_url(&overridden, "ggml-small.bin"),
            "http://127.0.0.1:1/resolve/main/ggml-small.bin"
        );
        // pointer_url takes no base at all — the digest source CANNOT move.
        assert_eq!(
            pointer_url("ggml-small.bin"),
            format!("{HF_REPO}/raw/main/ggml-small.bin")
        );
        // And without an override, the blob URL is the official repo too.
        assert_eq!(
            blob_url(&base_url_or_default(None), "ggml-small.bin"),
            format!("{HF_REPO}/resolve/main/ggml-small.bin")
        );
    }
}
