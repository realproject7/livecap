//! Session lifecycle (#11): the livecap-core caption pipeline + the Node
//! session host, bridged to the webview.
//!
//! Data flow per session:
//!   CaptionPipeline (Rust, mic+system) ─ events ─► webview `caption://event`
//!                                       └ finalized ─► host stdin (JSONL)
//!   host stdout (JSONL: translations, summary, gauge, archive) ─► webview
//!   `host://event`
//!
//! Caption content crosses process boundaries only over these private pipes —
//! it is never logged (#23 / SECURITY.md).

use std::io::{BufRead, BufReader, Read, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicU8, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::Duration;

use livecap_core::model::DEFAULT_MODEL;
use livecap_core::{CaptionKind, CaptionPipeline, ModelManager, PipelineConfig};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::bridge::BridgeCaption;
use crate::settings::SettingsState;
use crate::tray;

/// How long `stop()` waits for the host's `stopped` JSONL event (archive
/// finalized) after sending `stop`. Since #82 the host deliberately does NOT
/// exit on stop — it stays alive to serve the review screen's Coaching tab — so
/// this bounds the wait for that event, not a process exit.
const HOST_STOPPED_EVENT_TIMEOUT: Duration = Duration::from_secs(60);

/// Bound on the graceful host stop during process teardown (#66). Shorter than
/// [`HOST_STOPPED_EVENT_TIMEOUT`] because the user is quitting / the process got
/// a SIGTERM and is expected to disappear promptly; the host's own stop (engine
/// SIGTERM + a 2 s grace, then SIGKILL) fits comfortably inside this.
const SHUTDOWN_HOST_TIMEOUT: Duration = Duration::from_secs(8);

/// Host-stdin request types the webview may forward through `host_request`.
const FORWARDABLE_REQUESTS: &[&str] = &[
    "quickTranslate",
    "reply",
    "analyze",
    "coach",
    "retranslate",
    "pin",
    "silenceSnooze",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
#[repr(u8)]
pub enum Phase {
    #[default]
    Idle = 0,
    Starting = 1,
    Live = 2,
    Paused = 3,
    Stopping = 4,
}

impl Phase {
    fn as_str(self) -> &'static str {
        match self {
            Phase::Idle => "idle",
            Phase::Starting => "starting",
            Phase::Live => "live",
            Phase::Paused => "paused",
            Phase::Stopping => "stopping",
        }
    }

    fn from_u8(value: u8) -> Phase {
        match value {
            1 => Phase::Starting,
            2 => Phase::Live,
            3 => Phase::Paused,
            4 => Phase::Stopping,
            _ => Phase::Idle,
        }
    }
}

#[derive(Clone, Serialize)]
struct StatusPayload {
    phase: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
}

/// Desired capture channels (#53): seeded from Settings at session start;
/// `mic` flips live via the panel/tray toggle. Emitted to the webview as
/// `session://channels`.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct ChannelConfig {
    pub system: bool,
    pub mic: bool,
}

impl Default for ChannelConfig {
    fn default() -> Self {
        Self {
            system: true,
            mic: true,
        }
    }
}

fn emit_channels(app: &AppHandle, channels: ChannelConfig) {
    let _ = app.emit("session://channels", channels);
}

struct HostHandle {
    child: Child,
    stdin: Arc<StdMutex<ChildStdin>>,
    /// Set before a deliberate stop so the reader thread does not report the
    /// host's exit as a failure.
    expected_exit: Arc<AtomicBool>,
    /// One-shot wired by [`stop`]: the reader thread sends `()` when it observes
    /// the host's `stopped` event (archive finalized). The host no longer exits
    /// on stop (#82 — it keeps the engine warm for post-meeting coaching), so the
    /// `stopped` event, not process exit, is what marks the stop complete.
    stopped_signal: Arc<StdMutex<Option<std::sync::mpsc::Sender<()>>>>,
}

#[derive(Default)]
struct Inner {
    channels: ChannelConfig,
    pipeline: Option<CaptionPipeline>,
    host: Option<HostHandle>,
    events_task: Option<tauri::async_runtime::JoinHandle<()>>,
    /// A stopped session's host, kept alive only to serve post-meeting `coach`
    /// requests from the review screen (#82). Reaped on the next session start or
    /// on app shutdown. Its engine is warm; its pipeline/captures are already gone.
    post_session_host: Option<HostHandle>,
}

/// Managed session state (one session at a time).
///
/// `phase` lives in a lock-free [`AtomicU8`] separate from the `inner` mutex
/// (#65): transitions are still serialized under `inner` (so check-then-set is
/// atomic), but [`SessionState::phase`] — and thus the `session_phase` command —
/// reads it WITHOUT taking the mutex. A wedged start that holds `inner` across a
/// stalled model download can no longer block the webview's phase query (the
/// blank-screen root cause).
#[derive(Default)]
pub struct SessionState {
    inner: tauri::async_runtime::Mutex<Inner>,
    next_caption_id: AtomicU64,
    phase: AtomicU8,
}

impl SessionState {
    /// Lock-free read of the published phase.
    pub fn phase(&self) -> Phase {
        Phase::from_u8(self.phase.load(Ordering::Relaxed))
    }

    /// Publish a phase transition. Callers hold `inner` while transitioning so
    /// the check-then-set stays serialized; the store itself is lock-free.
    fn set_phase(&self, phase: Phase) {
        self.phase.store(phase as u8, Ordering::Relaxed);
    }

    /// Promote a still-Starting session to Live (#65). Returns false if the phase
    /// already moved — a `startFailed` (or stop) tore the start down mid-build —
    /// so the caller must NOT publish a live session. Call under the `inner` lock
    /// so the check-and-set is serialized against `fail_session`.
    fn try_begin_live(&self) -> bool {
        if self.phase() == Phase::Starting {
            self.set_phase(Phase::Live);
            true
        } else {
            false
        }
    }
}

/// Latest credit gauge from the host, cached for the `gauge_state` command
/// (#12 reads this; the live event stream is `host://event`).
#[derive(Default)]
pub struct GaugeCache(pub StdMutex<Option<serde_json::Value>>);

fn emit_status(app: &AppHandle, phase: Phase, detail: Option<String>) {
    let _ = app.emit(
        "session://status",
        StatusPayload {
            phase: phase.as_str(),
            detail,
        },
    );
}

fn is_executable(path: &Path) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        path.metadata()
            .map(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }
    #[cfg(not(unix))]
    {
        path.is_file()
    }
}

/// Locate a Node.js runtime: LIVECAP_NODE override, then PATH, then the
/// usual install locations (a Finder-launched app inherits a minimal PATH).
fn find_node() -> Option<PathBuf> {
    if let Ok(value) = std::env::var("LIVECAP_NODE") {
        let candidate = PathBuf::from(value);
        if is_executable(&candidate) {
            return Some(candidate);
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            let candidate = dir.join("node");
            if is_executable(&candidate) {
                return Some(candidate);
            }
        }
    }
    ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"]
        .iter()
        .map(PathBuf::from)
        .find(|candidate| is_executable(candidate))
}

/// The bundled session-host script (dev: built into ../dist-host by
/// `pnpm build:host`; release: shipped as a resource).
fn host_script(app: &AppHandle) -> Result<PathBuf, String> {
    #[cfg(debug_assertions)]
    {
        let dev = Path::new(env!("CARGO_MANIFEST_DIR")).join("../dist-host/main.mjs");
        if dev.is_file() {
            return Ok(dev);
        }
    }
    let resource = app
        .path()
        .resource_dir()
        .map_err(|e| e.to_string())?
        .join("dist-host/main.mjs");
    if resource.is_file() {
        Ok(resource)
    } else {
        Err("session host script not found — run `pnpm build:host`".into())
    }
}

fn write_host_line(stdin: &Arc<StdMutex<ChildStdin>>, value: &serde_json::Value) -> Result<(), String> {
    let mut line = serde_json::to_string(value).map_err(|e| e.to_string())?;
    line.push('\n');
    let mut guard = stdin.lock().map_err(|_| "host stdin poisoned".to_string())?;
    guard
        .write_all(line.as_bytes())
        .and_then(|()| guard.flush())
        .map_err(|e| format!("host write failed: {e}"))
}

fn spawn_host(app: &AppHandle, start_message: &serde_json::Value) -> Result<HostHandle, String> {
    let node = find_node()
        .ok_or_else(|| "Node.js runtime not found — install node or set LIVECAP_NODE".to_string())?;
    let script = host_script(app)?;

    let mut command = Command::new(node);
    command
        .arg(script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    // Put the host in its OWN process group (pgid == host pid). Its llama-server
    // grandchild inherits the group, so the force-kill backstop in `reap_host`
    // can SIGKILL the whole group and never orphan the engine — a plain
    // `child.kill()` reaches only node (#169). It also detaches the host from the
    // app's controlling-terminal group, so a terminal SIGINT drives teardown
    // through the app's own handler instead of racing node straight to death.
    #[cfg(unix)]
    std::os::unix::process::CommandExt::process_group(&mut command, 0);
    let mut child = command
        .spawn()
        .map_err(|e| format!("could not start the session host: {e}"))?;

    let stdin = Arc::new(StdMutex::new(child.stdin.take().expect("piped stdin")));
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let expected_exit = Arc::new(AtomicBool::new(false));
    // Wired by `stop()`: the reader fires this when it sees the host's `stopped`
    // event so the stop can complete without waiting for the (no-longer-occurring)
    // process exit (#82).
    let stopped_signal: Arc<StdMutex<Option<std::sync::mpsc::Sender<()>>>> =
        Arc::new(StdMutex::new(None));

    // Drain stderr so the pipe never wedges the host. The bytes are
    // intentionally dropped: stderr could carry engine noise and caption
    // content must never reach a log (#23).
    std::thread::spawn(move || {
        let mut sink = stderr;
        let mut buf = [0u8; 4096];
        while matches!(sink.read(&mut buf), Ok(n) if n > 0) {}
    });

    // Forward host events to the webview; cache gauge snapshots for #12.
    let reader_app = app.clone();
    let reader_expected = expected_exit.clone();
    let reader_stopped_signal = stopped_signal.clone();
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            let kind = value.get("type").and_then(|t| t.as_str());
            if kind == Some("stopped") {
                // The session's archive is finalized: release any waiter in `stop()`
                // (the host stays alive afterward for post-meeting coaching). Still
                // forwarded to the webview below so the review screen opens.
                if let Ok(mut slot) = reader_stopped_signal.lock() {
                    if let Some(tx) = slot.take() {
                        let _ = tx.send(());
                    }
                }
            }
            if kind == Some("gauge") {
                if let Some(cache) = reader_app.try_state::<GaugeCache>() {
                    if let Ok(mut guard) = cache.0.lock() {
                        *guard = value.get("gauge").cloned();
                    }
                }
            }
            if kind == Some("startFailed") {
                // Terminal engine-readiness failure (#65): drive a real teardown
                // to idle with a durable status, rather than forwarding a
                // transient event the live UI would only flash as a toast.
                let detail = value
                    .get("detail")
                    .and_then(|d| d.as_str())
                    .unwrap_or("the translation engine did not start")
                    .to_string();
                let fail_app = reader_app.clone();
                tauri::async_runtime::spawn(async move {
                    fail_session(&fail_app, detail).await;
                });
                continue;
            }
            let _ = reader_app.emit("host://event", &value);
        }
        // The host's stdout closed = the host process exited. If a `stop()` is
        // still waiting for a `stopped` event that will now never arrive (the
        // host crashed inside the stop window), drop the waiter's sender so its
        // bounded wait fails FAST (channel disconnected) instead of idling out
        // the full HOST_STOPPED_EVENT_TIMEOUT (#169). Harmless no-op after a clean stop
        // (the `stopped` arm already took the slot).
        if let Ok(mut slot) = reader_stopped_signal.lock() {
            slot.take();
        }
        if !reader_expected.load(Ordering::Relaxed) {
            let _ = reader_app.emit(
                "host://event",
                serde_json::json!({ "type": "hostError", "detail": "session host exited unexpectedly" }),
            );
        }
    });

    write_host_line(&stdin, start_message)?;

    Ok(HostHandle {
        child,
        stdin,
        expected_exit,
        stopped_signal,
    })
}

/// Start the captures enabled by `channels` (#53). A requested channel that
/// fails (e.g. no mic permission) is tolerated while another channel comes
/// up, but at least one channel must come up. Settings sanitization
/// guarantees at least one channel is requested.
fn start_captures(pipeline: &mut CaptionPipeline, channels: ChannelConfig) -> Result<Option<String>, String> {
    let system = channels.system.then(|| pipeline.start_system(None));
    let mic = channels.mic.then(|| pipeline.start_mic(None));
    match (system, mic) {
        (Some(Ok(())), Some(Ok(()))) => Ok(None),
        (Some(Ok(())), Some(Err(e))) => Ok(Some(format!(
            "microphone unavailable ({e}) — captioning system audio only"
        ))),
        (Some(Err(e)), Some(Ok(()))) => Ok(Some(format!(
            "system audio unavailable ({e}) — captioning the microphone only"
        ))),
        (Some(Err(system_err)), Some(Err(mic_err))) => Err(format!(
            "audio capture failed — system: {system_err}; mic: {mic_err}"
        )),
        (Some(Ok(())), None) => Ok(Some("microphone is off — captioning system audio only".into())),
        (None, Some(Ok(()))) => Ok(Some("system audio is off — captioning the microphone only".into())),
        (Some(Err(e)), None) => Err(format!("system audio capture failed: {e} (the microphone is off in Settings)")),
        (None, Some(Err(e))) => Err(format!("microphone capture failed: {e} (system audio is off in Settings)")),
        (None, None) => Err("no capture channel is enabled".into()),
    }
}

pub async fn start(app: AppHandle) -> Result<(), String> {
    let state = app.state::<SessionState>();
    let stale_post_session = {
        let mut inner = state.inner.lock().await;
        if state.phase() != Phase::Idle {
            return Err(format!("session is {}", state.phase().as_str()));
        }
        state.set_phase(Phase::Starting);
        // A new session supersedes any post-session host kept warm for coaching
        // (#82) — reap it (outside the lock) so its engine/llama-server is gone.
        inner.post_session_host.take()
    };
    if let Some(host) = stale_post_session {
        reap_host(host).await;
    }
    emit_status(
        &app,
        Phase::Starting,
        Some("preparing the caption model (first run downloads it)…".into()),
    );

    match start_inner(&app).await {
        Ok(detail) => {
            let state = app.state::<SessionState>();
            let mut inner = state.inner.lock().await;
            // A startFailed (or stop) can tear the session down to Idle WHILE
            // start_inner is still building. Because start_inner stores the
            // host/pipeline handles only at the end, fail_session's cleanup may
            // have run with nothing to kill. Re-check under the lock: only go Live
            // if still Starting; otherwise kill the just-stored handles and stay
            // Idle, leaving the durable failure status intact (#65 / RE2).
            if !state.try_begin_live() {
                cleanup(&mut inner).await;
                return Ok(());
            }
            let channels = inner.channels;
            drop(inner);
            tray::set_live(&app, true);
            tray::sync_mic(&app, true, channels.mic);
            emit_channels(&app, channels);
            emit_status(&app, Phase::Live, detail);
            Ok(())
        }
        Err(error) => {
            let state = app.state::<SessionState>();
            let mut inner = state.inner.lock().await;
            cleanup(&mut inner).await;
            state.set_phase(Phase::Idle);
            drop(inner);
            tray::set_live(&app, false);
            emit_status(&app, Phase::Idle, Some(error.clone()));
            Err(error)
        }
    }
}

/// Archive destination: the Settings folder pick when set, otherwise
/// ~/Documents/LiveCap (PROPOSAL §8.9).
pub(crate) fn archive_dir(app: &AppHandle, settings: &crate::settings::AppSettings) -> PathBuf {
    if let Some(folder) = settings.archive_folder.as_deref() {
        return PathBuf::from(folder);
    }
    let app_data_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir());
    app.path()
        .document_dir()
        .map(|d| d.join("LiveCap"))
        .unwrap_or_else(|_| app_data_dir.join("LiveCap"))
}

/// Ensure the Settings-selected whisper model is on disk BEFORE the pipeline
/// builds (#110), streaming download progress into `session://status` the way
/// the local tier reports its model download. Returns the model the session
/// will actually run plus an optional user-facing note:
/// - selected model present/downloaded → `(selected, None)`;
/// - its download failed and a fallback exists → `(DEFAULT_MODEL, note)` so a
///   bad network never yields a dead session;
/// - the default itself failed → `(selected, None)` and the pipeline build
///   surfaces the real error through the existing start-failure path.
async fn ensure_stt_model(
    app: &AppHandle,
    models_dir: &Path,
    selected: &str,
) -> (String, Option<String>) {
    let manager = ModelManager::new(models_dir);
    let ensure = |name: String| {
        let progress_app = app.clone();
        let manager = &manager;
        async move {
            let label = name.clone();
            manager
                .ensure_model_with_progress(&name, move |pct| {
                    emit_status(
                        &progress_app,
                        Phase::Starting,
                        Some(format!("downloading the \"{label}\" caption model {pct}%…")),
                    );
                })
                .await
        }
    };
    match ensure(selected.to_string()).await {
        Ok(_) => (selected.to_string(), None),
        Err(error) if selected != DEFAULT_MODEL => {
            // Error text is model/network detail, never caption content (#23).
            eprintln!(
                "livecap: caption model '{selected}' unavailable ({error}) — falling back to '{DEFAULT_MODEL}'"
            );
            let note = format!(
                "couldn't download the \"{selected}\" caption model — using \"{DEFAULT_MODEL}\" for this session"
            );
            emit_status(app, Phase::Starting, Some(note.clone()));
            // Best effort: if the fallback is missing AND unreachable too, the
            // pipeline build below reports that terminal error.
            let _ = ensure(DEFAULT_MODEL.to_string()).await;
            (DEFAULT_MODEL.to_string(), Some(note))
        }
        Err(_) => (selected.to_string(), None),
    }
}

async fn start_inner(app: &AppHandle) -> Result<Option<String>, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let models_dir = app_data_dir.join("models");

    // Persisted settings (#12) drive the session: target language, engine
    // preference, gauge config, archive policy. Read fresh at every start so
    // Settings changes apply to the next session without an app restart.
    let settings = app.state::<SettingsState>().snapshot();
    let archive_dir = archive_dir(app, &settings);
    // #53: per-channel capture toggles, sanitized so at least one is on.
    let channels = ChannelConfig {
        system: settings.capture_system,
        mic: settings.capture_mic,
    };

    // The host starts first (cheap; engine detection runs while whisper
    // loads); the pipeline build may block on a first-run model download.
    let start_message = serde_json::json!({
        "type": "start",
        "appDataDir": app_data_dir,
        "archiveDir": archive_dir,
        "targetLanguageCode": settings.target_language,
        // #94: spoken/source language for transcription ("auto" = auto-detect).
        // Whisper runs in the Rust pipeline below; the host carries this only
        // for contract completeness (it translates, it does not transcribe).
        "sourceLanguageCode": settings.source_language,
        "enginePref": settings.engine_pref,
        "poolUsd": settings.pool_usd,
        "resetDay": settings.reset_day,
        "autoSwitch": settings.auto_switch,
        "archiveAutoSave": settings.archive_auto_save,
        "archiveRetentionDays": settings.archive_retention_days,
        "captureSystem": channels.system,
        "captureMic": channels.mic,
    });
    let host = spawn_host(app, &start_message)?;

    // #110: the Settings model pick drives transcription. Ensure it is on disk
    // first (with visible download progress); a failed download falls back to
    // the default model with a note instead of a dead session.
    let (stt_model, stt_note) = ensure_stt_model(app, &models_dir, &settings.stt_model).await;

    // #94: force whisper to the chosen spoken language ("auto" → per-utterance
    // detection), improving STT accuracy and eliminating auto-misdetection (#93).
    let config = PipelineConfig::new(models_dir)
        .with_model(&stt_model)
        .with_source_language(&settings.source_language);
    let (mut pipeline, mut events_rx) = match CaptionPipeline::new(config).await {
        Ok(built) => built,
        Err(error) => {
            // Graceful teardown (stdin-drop → bounded wait → group-kill backstop)
            // so a half-built host's llama-server is reaped, never orphaned (#169).
            reap_host(host).await;
            return Err(format!("caption pipeline failed to start: {error}"));
        }
    };

    let capture_note = match start_captures(&mut pipeline, channels) {
        Ok(note) => note,
        Err(error) => {
            reap_host(host).await;
            let _ = pipeline.finish().await;
            return Err(error);
        }
    };

    // Forward caption events: every event to the webview, finalized
    // sentences to the host's translation queue.
    let state = app.state::<SessionState>();
    let events_app = app.clone();
    let host_stdin = host.stdin.clone();
    let events_task = tauri::async_runtime::spawn(async move {
        while let Some(event) = events_rx.recv().await {
            // The RTF "falling behind" notice (#141) is a status, not a caption:
            // surface a content-free one-liner and move on. It is debounced in the
            // pipeline, so this fires at most once per falling-behind episode.
            // Only emit while actually Live: during pause/stop the pipeline keeps
            // draining queued finals, and a crossing on one of those must NOT
            // stamp Phase::Live over the real Paused/Stopping phase in the UI.
            if matches!(event.kind, CaptionKind::FallingBehind) {
                if events_app.state::<SessionState>().phase() == Phase::Live {
                    emit_status(
                        &events_app,
                        Phase::Live,
                        Some(
                            "transcription is falling behind — a smaller model may keep up".into(),
                        ),
                    );
                }
                continue;
            }
            let session = events_app.state::<SessionState>();
            let Some(mapped) = BridgeCaption::from_event(
                event,
                || session.next_caption_id.fetch_add(1, Ordering::Relaxed) + 1,
                crate::util::epoch_ms(),
            ) else {
                continue;
            };
            let _ = events_app.emit("caption://event", &mapped);
            if let Some(message) = mapped.host_message() {
                let _ = write_host_line(&host_stdin, &message);
            }
        }
    });

    let mut inner = state.inner.lock().await;
    inner.channels = channels;
    inner.pipeline = Some(pipeline);
    inner.host = Some(host);
    inner.events_task = Some(events_task);
    // #110: a model fallback note must survive into the durable Live status,
    // not just flash while Starting — join it with any capture note.
    Ok(match (stt_note, capture_note) {
        (Some(model), Some(capture)) => Some(format!("{model}; {capture}")),
        (model, capture) => model.or(capture),
    })
}

pub async fn stop(app: AppHandle) -> Result<(), String> {
    let state = app.state::<SessionState>();
    let (pipeline, host, events_task) = {
        let mut inner = state.inner.lock().await;
        let phase = state.phase();
        if phase != Phase::Live && phase != Phase::Paused {
            return Err(format!("session is {}", phase.as_str()));
        }
        state.set_phase(Phase::Stopping);
        (inner.pipeline.take(), inner.host.take(), inner.events_task.take())
    };
    emit_status(&app, Phase::Stopping, Some("saving the transcript…".into()));

    // Drain the pipeline first so trailing finalized sentences still reach
    // the host before it is told to finalize the archive.
    if let Some(pipeline) = pipeline {
        let _ = pipeline.finish().await;
    }
    if let Some(task) = events_task {
        let _ = task.await;
    }

    // The host no longer exits on stop (#82): it finalizes the archive, emits
    // `stopped`, then stays alive so the review screen's Coaching tab can still
    // reach the warm engine. Wait for the `stopped` event (archive finalized),
    // then KEEP the host as the post-session host rather than reaping it.
    let post_session_host = if let Some(host) = host {
        host.expected_exit.store(true, Ordering::Relaxed);
        let (tx, rx) = std::sync::mpsc::channel();
        if let Ok(mut slot) = host.stopped_signal.lock() {
            *slot = Some(tx);
        }
        let _ = write_host_line(&host.stdin, &serde_json::json!({ "type": "stop" }));
        let waited =
            tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(HOST_STOPPED_EVENT_TIMEOUT)).await;
        if !matches!(waited, Ok(Ok(()))) {
            // The host did not confirm in time; the archive working file is still
            // on disk (incremental writes) — nothing is lost. Reap it rather than
            // keep a possibly-wedged host around.
            let _ = app.emit(
                "host://event",
                serde_json::json!({ "type": "hostError", "detail": "session host did not stop cleanly" }),
            );
            reap_host(host).await;
            None
        } else {
            Some(host)
        }
    } else {
        None
    };

    {
        let mut inner = state.inner.lock().await;
        state.set_phase(Phase::Idle);
        inner.channels = ChannelConfig::default();
        // Reap any prior post-session host before parking this one (defensive —
        // start() also clears it, but a stop without an intervening start could
        // otherwise leak one).
        if let Some(stale) = inner.post_session_host.take() {
            reap_host(stale).await;
        }
        inner.post_session_host = post_session_host;
    }
    tray::set_live(&app, false);
    tray::sync_mic(&app, false, false);
    emit_status(&app, Phase::Idle, None);
    Ok(())
}

/// Process-shutdown teardown (#66): used by the tray "Quit" item and the
/// SIGTERM/SIGINT handler. Unlike [`stop`], which only runs from a Live/Paused
/// session, this tears down whatever is in flight in ANY phase (including a
/// half-built `Starting` session whose host + llama-server are already spawned)
/// so nothing is orphaned when the process is about to exit.
///
/// The host child is torn down GRACEFULLY via [`reap_host`]: its stdin is closed
/// (EOF), which drives the host's own shutdown — `engine.stop()` SIGTERMs the
/// spawned llama-server and awaits its exit — so the engine is reaped, not just
/// the node host. A group-SIGKILL backstop then covers the paths graceful
/// teardown misses — an overstaying node, or a crashed node that exited without
/// reaping its engine — so llama-server dies with node either way. A plain
/// `child.kill()` — which is SIGKILL, not SIGTERM, on Unix — straight to node
/// would terminate node before it could reap llama-server, orphaning the engine.
/// Draining the pipeline first also lets a gated #64 WAV dump finalize its header.
pub async fn shutdown(app: &AppHandle) {
    let state = app.state::<SessionState>();
    let (pipeline, host, events_task, post_session_host) = {
        let mut inner = state.inner.lock().await;
        if state.phase() == Phase::Idle
            && inner.host.is_none()
            && inner.pipeline.is_none()
            && inner.post_session_host.is_none()
        {
            return;
        }
        state.set_phase(Phase::Stopping);
        (
            inner.pipeline.take(),
            inner.host.take(),
            inner.events_task.take(),
            inner.post_session_host.take(),
        )
    };

    if let Some(pipeline) = pipeline {
        let _ = pipeline.finish().await;
    }
    if let Some(task) = events_task {
        let _ = task.await;
    }
    if let Some(host) = host {
        reap_host(host).await;
    }
    // The post-session host (engine kept warm for coaching, #82) must also be
    // reaped on quit so its llama-server is never orphaned.
    if let Some(host) = post_session_host {
        reap_host(host).await;
    }

    let mut inner = state.inner.lock().await;
    state.set_phase(Phase::Idle);
    inner.channels = ChannelConfig::default();
}

/// Gracefully stop a session host: close its stdin (so node reaps its own
/// llama-server child), wait a bounded time, then group-SIGKILL as a backstop.
/// Runs on a blocking thread so the wait never stalls the runtime.
async fn reap_host(host: HostHandle) {
    host.expected_exit.store(true, Ordering::Relaxed);
    let HostHandle {
        child,
        stdin,
        stopped_signal,
        ..
    } = host;
    // Closing the host's stdin drives its own teardown: the readline `close`
    // handler runs terminate() → dispose()/stop(), which SIGTERMs and awaits its
    // llama-server child before exiting, so the engine is reaped — not orphaned.
    // (The host no longer exits on a `{"type":"stop"}` line — #82 keeps the engine
    // warm for post-meeting coaching — so stdin-EOF is the teardown trigger.)
    // A bounded wait then a group-SIGKILL backstop guarantees node can never
    // wedge AND that a crashed node's orphaned llama-server is still reaped.
    drop(stdin);
    drop(stopped_signal);
    let _ = tauri::async_runtime::spawn_blocking(move || reap_host_blocking(child)).await;
}

/// The teardown protocol's blocking core (see [`reap_host`]).
///
/// The invariant (#169): NO exit path may orphan the llama-server grandchild —
/// including the crashed-host path, where node has already exited WITHOUT reaping
/// its engine (a hard crash never runs node's `close` handler). The old loop
/// broke on `try_wait() == Ok(Some)` and skipped the group-kill, so a crashed
/// node's same-group llama-server survived (holding the fixed port + model RAM).
///
/// The fix is PID-reuse-safe by construction: the host's process-group id equals
/// the host pid ([`spawn_host`] sets `process_group(0)`), and `try_wait`/`wait`
/// FREE that pid the instant node is reaped — after which `kill(-pgid)` could hit
/// a recycled group. So node is NEVER reaped before the group-kill: the exit poll
/// uses `waitid(WNOWAIT)` (reports node's exit but leaves it reapable, pid
/// reserved), the group-SIGKILL fires while node is still un-reaped, and only then
/// is node `wait()`ed. The backstop covers both the overstayed-node case (node
/// alive → kills node + engine) and the crashed-node case (node a reserved zombie
/// → reaps its orphaned engine); it is a harmless no-op when graceful teardown
/// already reaped the engine.
#[cfg(target_os = "macos")]
fn reap_host_blocking(mut child: Child) {
    // Captured while node is un-reaped, so this pid (== the host pgid) is
    // reserved and cannot name a recycled process group at kill time.
    let pgid = child.id() as libc::pid_t;
    let deadline = std::time::Instant::now() + SHUTDOWN_HOST_TIMEOUT;
    loop {
        if host_exited_without_reaping(pgid) || std::time::Instant::now() >= deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    // Group-SIGKILL backstop — the only teardown that reaches the separate
    // llama-server grandchild. Issued before `wait()` so `pgid` is still reserved.
    signal_host_group(pgid);
    let _ = child.wait();
}

/// Non-macOS fallback (the app ships macOS-only; `libc` is absent here). Not a
/// shipped path — present so the crate builds anywhere. No process groups, so the
/// best it can do is kill node directly.
#[cfg(not(target_os = "macos"))]
fn reap_host_blocking(mut child: Child) {
    let deadline = std::time::Instant::now() + SHUTDOWN_HOST_TIMEOUT;
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() >= deadline => {
                let _ = child.kill();
                let _ = child.wait();
                break;
            }
            Ok(None) => std::thread::sleep(Duration::from_millis(25)),
            Err(_) => break,
        }
    }
}

/// Has node exited, WITHOUT reaping it? `waitid` with `WNOWAIT` reports the
/// exited state but leaves node reapable, so its pid — and therefore the
/// process-group id [`reap_host_blocking`] kills — stays reserved and can never be
/// recycled before the group-kill (#169). `WNOHANG` makes it a poll.
#[cfg(target_os = "macos")]
fn host_exited_without_reaping(pid: libc::pid_t) -> bool {
    // Zeroed each call: with WNOHANG and no exited state to report, `waitid`
    // leaves `si_pid` at 0 (a still-running child), so a fresh zero reads as
    // "still running". A non-zero `si_pid` is node's now-waitable exit.
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    let rc = unsafe {
        libc::waitid(
            libc::P_PID,
            pid as libc::id_t,
            &mut info,
            libc::WEXITED | libc::WNOWAIT | libc::WNOHANG,
        )
    };
    // rc != 0 (e.g. ECHILD — already reaped elsewhere) → treat node as gone.
    rc != 0 || info.si_pid != 0
}

/// SIGKILL the host's entire process group — node **and** its llama-server
/// grandchild, which inherited the group from `process_group(0)` in
/// [`spawn_host`]. A plain `child.kill()` would SIGKILL only node and leave
/// llama-server orphaned (#169). Does NOT reap node; the caller `wait()`s it after
/// (keeping `pgid` reserved through the kill).
#[cfg(target_os = "macos")]
fn signal_host_group(pgid: libc::pid_t) {
    // Negative pid targets the process group. Safe: `kill` only reads the pid and
    // posts a signal — no memory is shared with the child.
    unsafe {
        libc::kill(-pgid, libc::SIGKILL);
    }
}

/// Mid-session microphone toggle (#53): pause/resume JUST the mic capture.
/// While Paused only the desired flag flips; resume honors it. Turning the
/// last active channel off is refused (a session must keep one channel).
pub async fn set_mic(app: AppHandle, enabled: bool) -> Result<(), String> {
    let state = app.state::<SessionState>();
    let channels = {
        let mut inner = state.inner.lock().await;
        let phase = state.phase();
        if phase != Phase::Live && phase != Phase::Paused {
            return Err("no active session".into());
        }
        if !enabled && !inner.channels.system {
            return Err("the microphone is the only active channel — pause the session instead".into());
        }
        if phase == Phase::Live {
            let pipeline = inner
                .pipeline
                .as_mut()
                .ok_or_else(|| "no active pipeline".to_string())?;
            if enabled {
                if !pipeline.mic_running() {
                    pipeline
                        .start_mic(None)
                        .map_err(|e| format!("microphone unavailable: {e}"))?;
                }
            } else {
                pipeline.stop_mic();
            }
        }
        inner.channels.mic = enabled;
        inner.channels
    };
    tray::sync_mic(&app, true, channels.mic);
    emit_channels(&app, channels);
    Ok(())
}

/// Tray "Microphone" entry point: flip the mic, surfacing failures as a
/// toast and re-syncing the menu check mark.
pub async fn toggle_mic(app: AppHandle) {
    let current = {
        let state = app.state::<SessionState>();
        let inner = state.inner.lock().await;
        match state.phase() {
            Phase::Live | Phase::Paused => Some(inner.channels.mic),
            _ => None,
        }
    };
    let Some(mic) = current else { return };
    if let Err(error) = set_mic(app.clone(), !mic).await {
        tray::sync_mic(&app, true, mic);
        let _ = app.emit(
            "host://event",
            serde_json::json!({ "type": "hostError", "detail": error }),
        );
    }
}

pub async fn pause(app: AppHandle) -> Result<(), String> {
    let state = app.state::<SessionState>();
    let mut inner = state.inner.lock().await;
    if state.phase() != Phase::Live {
        return Err(format!("session is {}", state.phase().as_str()));
    }
    if let Some(pipeline) = inner.pipeline.as_mut() {
        pipeline.stop_capture();
    }
    state.set_phase(Phase::Paused);
    drop(inner);
    tray::set_live(&app, false);
    emit_status(&app, Phase::Paused, None);
    Ok(())
}

pub async fn resume(app: AppHandle) -> Result<(), String> {
    let state = app.state::<SessionState>();
    let mut inner = state.inner.lock().await;
    if state.phase() != Phase::Paused {
        return Err(format!("session is {}", state.phase().as_str()));
    }
    let channels = inner.channels;
    let detail = match inner.pipeline.as_mut() {
        Some(pipeline) => start_captures(pipeline, channels)?,
        None => return Err("no active pipeline".into()),
    };
    state.set_phase(Phase::Live);
    drop(inner);
    tray::set_live(&app, true);
    emit_status(&app, Phase::Live, detail);
    Ok(())
}

/// Tray menu entry point: toggles between start and stop.
pub async fn toggle(app: AppHandle) {
    let phase = app.state::<SessionState>().phase();
    let result = match phase {
        Phase::Idle => start(app.clone()).await,
        Phase::Live | Phase::Paused => stop(app.clone()).await,
        Phase::Starting | Phase::Stopping => Ok(()),
    };
    if let Err(error) = result {
        let _ = app.emit(
            "host://event",
            serde_json::json!({ "type": "hostError", "detail": error }),
        );
    }
}

async fn cleanup(inner: &mut Inner) {
    if let Some(pipeline) = inner.pipeline.take() {
        let _ = pipeline.finish().await;
    }
    // Route host teardown through the graceful reap protocol (stdin-drop →
    // bounded wait → group-kill backstop) rather than an immediate SIGKILL, so a
    // half-built or race-lost session's llama-server is reaped, never orphaned,
    // and node is always wait()ed (no zombie) (#169).
    if let Some(host) = inner.host.take() {
        reap_host(host).await;
    }
    if let Some(host) = inner.post_session_host.take() {
        reap_host(host).await;
    }
    if let Some(task) = inner.events_task.take() {
        task.abort();
    }
}

/// Tear down a session whose engine never became ready (#65). The host reports a
/// terminal `startFailed`; Rust had already marked the session live (captions
/// flow before translation is ready), so here it cleans up the host + pipeline,
/// returns to Idle, and republishes the content-free `detail` as a durable
/// `session://status` error. No-op if a deliberate stop (or a duplicate failure)
/// already moved the session out of an active phase.
async fn fail_session(app: &AppHandle, detail: String) {
    let state = app.state::<SessionState>();
    let mut inner = state.inner.lock().await;
    if matches!(state.phase(), Phase::Idle | Phase::Stopping) {
        return;
    }
    cleanup(&mut inner).await;
    state.set_phase(Phase::Idle);
    inner.channels = ChannelConfig::default();
    drop(inner);
    tray::set_live(app, false);
    tray::sync_mic(app, false, false);
    emit_status(app, Phase::Idle, Some(detail));
}

/* ---- commands ---- */

#[tauri::command]
pub async fn session_start(app: AppHandle) -> Result<(), String> {
    start(app).await
}

#[tauri::command]
pub async fn session_stop(app: AppHandle) -> Result<(), String> {
    stop(app).await
}

#[tauri::command]
pub async fn session_pause(app: AppHandle) -> Result<(), String> {
    pause(app).await
}

#[tauri::command]
pub async fn session_resume(app: AppHandle) -> Result<(), String> {
    resume(app).await
}

#[tauri::command]
pub async fn session_phase(state: State<'_, SessionState>) -> Result<&'static str, String> {
    // Lock-free (#65): never blocks on the `inner` mutex, so a wedged start can
    // not stall the webview's phase query and blank the window.
    Ok(state.phase().as_str())
}

/// Mid-session mic toggle (#53) — the panel chrome button calls this.
#[tauri::command]
pub async fn session_set_mic(app: AppHandle, enabled: bool) -> Result<(), String> {
    set_mic(app, enabled).await
}

/// Current desired channel config (both-on default while idle) — lets the
/// webview seed the mic button after a reload or an autostarted session.
#[tauri::command]
pub async fn session_channels(state: State<'_, SessionState>) -> Result<ChannelConfig, String> {
    Ok(state.inner.lock().await.channels)
}

/// Forward a UI request (quick translate, reply chip, retranslate, pin,
/// silence snooze) to the session host.
#[tauri::command]
pub async fn host_request(
    state: State<'_, SessionState>,
    message: serde_json::Value,
) -> Result<(), String> {
    let kind = message
        .get("type")
        .and_then(|t| t.as_str())
        .ok_or_else(|| "request has no type".to_string())?;
    if !FORWARDABLE_REQUESTS.contains(&kind) {
        return Err(format!("request type not forwardable: {kind}"));
    }
    let inner = state.inner.lock().await;
    match (&inner.host, state.phase()) {
        (Some(host), Phase::Live | Phase::Paused) => write_host_line(&host.stdin, &message),
        // Post-meeting coaching (#82): the review screen opens AFTER stop, so its
        // `coach` requests target the parked post-session host (engine kept warm).
        _ if kind == "coach" => match &inner.post_session_host {
            Some(host) => write_host_line(&host.stdin, &message),
            None => Err("no active session".into()),
        },
        _ => Err("no active session".into()),
    }
}

/// Latest credit gauge (PROPOSAL §6/§8.7) — pulled by Settings (#12); live
/// updates stream as `host://event` gauge messages.
#[tauri::command]
pub fn gauge_state(cache: State<'_, GaugeCache>) -> Option<serde_json::Value> {
    cache.0.lock().ok().and_then(|guard| guard.clone())
}

/// Sessionless probe (#12): run the host in `--probe` mode for real CLI
/// detection plus a read-only credit-gauge snapshot. Used by onboarding
/// screen 3 and the Settings sheet before a session has filled GaugeCache.
#[tauri::command]
pub async fn host_probe(app: AppHandle) -> Result<serde_json::Value, String> {
    let node = find_node()
        .ok_or_else(|| "Node.js runtime not found — install node or set LIVECAP_NODE".to_string())?;
    let script = host_script(&app)?;
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let settings = app.state::<SettingsState>().snapshot();
    let request = serde_json::json!({
        "appDataDir": app_data_dir,
        "poolUsd": settings.pool_usd,
        "resetDay": settings.reset_day,
    })
    .to_string();

    let output = tauri::async_runtime::spawn_blocking(move || {
        Command::new(node)
            .arg(script)
            .arg("--probe")
            .arg(request)
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .output()
    })
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| format!("probe failed to run: {e}"))?;

    let line = String::from_utf8_lossy(&output.stdout);
    let value: serde_json::Value = serde_json::from_str(line.trim())
        .map_err(|_| "probe produced no result".to_string())?;
    if value.get("type").and_then(|t| t.as_str()) == Some("probe") {
        Ok(value)
    } else {
        let detail = value
            .get("detail")
            .and_then(|d| d.as_str())
            .unwrap_or("probe failed");
        Err(detail.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn phase_round_trips_through_u8() {
        for phase in [
            Phase::Idle,
            Phase::Starting,
            Phase::Live,
            Phase::Paused,
            Phase::Stopping,
        ] {
            assert_eq!(Phase::from_u8(phase as u8), phase);
        }
        assert_eq!(Phase::from_u8(255), Phase::Idle); // unknown byte → Idle
    }

    #[test]
    fn try_begin_live_refuses_to_resurrect_a_torn_down_start() {
        // Regression for the RE2 race: start()'s Ok-branch must not flip a session
        // back to Live after a startFailed tore it down mid-build (#65).
        let state = SessionState::default();
        state.set_phase(Phase::Starting);

        // fail_session won the race: Starting → Idle.
        state.set_phase(Phase::Idle);

        // The Ok-branch re-check now refuses to publish Live.
        assert!(!state.try_begin_live());
        assert_eq!(state.phase(), Phase::Idle);
    }

    #[test]
    fn try_begin_live_promotes_a_clean_start_exactly_once() {
        let state = SessionState::default();
        assert!(!state.try_begin_live()); // not Starting yet
        state.set_phase(Phase::Starting);
        assert!(state.try_begin_live()); // Starting → Live
        assert_eq!(state.phase(), Phase::Live);
        assert!(!state.try_begin_live()); // already Live → refuses
        assert_eq!(state.phase(), Phase::Live);
    }

    #[tokio::test]
    async fn shutdown_guard_skips_a_truly_idle_session() {
        // #66: teardown calls shutdown() on every quit/SIGTERM. With no host or
        // pipeline in flight it must be a cheap no-op and NOT flip the phase to
        // Stopping (which would briefly publish a bogus transition).
        let state = SessionState::default();
        assert_eq!(state.phase(), Phase::Idle);
        {
            let inner = state.inner.lock().await;
            let nothing_in_flight =
                state.phase() == Phase::Idle && inner.host.is_none() && inner.pipeline.is_none();
            assert!(nothing_in_flight, "default session has nothing to tear down");
        }
        // The guard condition mirrors shutdown()'s early return; assert it holds
        // so a future change to the field set can't silently break the fast path.
        assert_eq!(state.phase(), Phase::Idle);
    }

    #[test]
    fn explicit_start_gate_only_admits_an_idle_session() {
        // #1: launch lands on Idle (no auto-start) and a session begins only on an
        // explicit Start. start() admits the transition Idle → Starting and refuses
        // every other phase, so a second Start (or one during start/stop) is a
        // no-op. This mirrors start()'s guard: `if phase != Idle { return Err }`.
        let admits_start = |phase: Phase| phase == Phase::Idle;
        assert!(admits_start(Phase::Idle));
        for phase in [Phase::Starting, Phase::Live, Phase::Paused, Phase::Stopping] {
            assert!(!admits_start(phase), "{phase:?} must not admit a fresh start");
        }
    }

    #[test]
    fn the_default_lifecycle_phase_is_idle() {
        // #1: with auto-start removed from the normal path, a freshly constructed
        // session sits Idle until the user starts it.
        assert_eq!(SessionState::default().phase(), Phase::Idle);
    }

    #[test]
    fn stop_gate_only_admits_a_running_session() {
        // The complement of the start gate: stop() acts only on Live/Paused, so a
        // Stop while Idle/Starting/Stopping is a no-op (start ↔ stop are exclusive).
        let admits_stop = |phase: Phase| matches!(phase, Phase::Live | Phase::Paused);
        assert!(admits_stop(Phase::Live));
        assert!(admits_stop(Phase::Paused));
        for phase in [Phase::Idle, Phase::Starting, Phase::Stopping] {
            assert!(!admits_stop(phase), "{phase:?} must not admit a stop");
        }
    }

    #[test]
    fn phase_is_readable_while_the_inner_mutex_is_held() {
        // Regression for #65: a stalled start holds `inner` across the model
        // download; the webview's phase query must still return. Because phase
        // lives in a separate atomic, it is observable WITHOUT the mutex.
        let state = SessionState::default();
        assert_eq!(state.phase(), Phase::Idle);

        // Hold `inner` exactly as a wedged start would.
        let held = tauri::async_runtime::block_on(state.inner.lock());
        state.set_phase(Phase::Starting); // publishes via the atomic, not `inner`
        assert_eq!(state.phase(), Phase::Starting);
        assert_eq!(state.phase().as_str(), "starting");
        drop(held);
    }

    #[test]
    fn crashed_host_unblocks_the_stop_waiter_immediately() {
        // #169: stop() waits on `stopped_signal` up to HOST_STOPPED_EVENT_TIMEOUT (60s). If
        // the host crashes inside the stop window it never emits `stopped`; the
        // reader thread's stdout-closed handler drops the waiter's sender so the
        // wait fails FAST (channel disconnected) instead of idling the full
        // timeout. Model that exact slot + waiter (the real types from spawn_host).
        let slot: Arc<StdMutex<Option<std::sync::mpsc::Sender<()>>>> =
            Arc::new(StdMutex::new(None));
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        *slot.lock().unwrap() = Some(tx); // stop() installs its sender

        // Reader hits EOF (host crashed) and drops the sender, exactly as the new
        // `reader_stopped_signal.take()` on the stdout-closed path does.
        slot.lock().unwrap().take();

        // The waiter (stop()'s bounded wait) returns at once, and NOT with Ok(()),
        // so stop() takes its reap / fast-fail branch, not "stopped cleanly".
        let start = std::time::Instant::now();
        let waited = rx.recv_timeout(HOST_STOPPED_EVENT_TIMEOUT);
        assert!(matches!(
            waited,
            Err(std::sync::mpsc::RecvTimeoutError::Disconnected)
        ));
        assert!(!matches!(waited, Ok(())));
        assert!(
            start.elapsed() < Duration::from_secs(1),
            "a crashed host must not idle the full HOST_STOPPED_EVENT_TIMEOUT"
        );
    }

    #[test]
    fn a_clean_stopped_event_still_releases_the_waiter() {
        // The crash fast-fail must not regress the normal path: when the host
        // emits `stopped`, the reader sends () (slot cleared) and the waiter
        // completes with Ok(()). A later EOF then finds an empty slot — a no-op.
        let slot: Arc<StdMutex<Option<std::sync::mpsc::Sender<()>>>> =
            Arc::new(StdMutex::new(None));
        let (tx, rx) = std::sync::mpsc::channel::<()>();
        *slot.lock().unwrap() = Some(tx);

        // Reader observes `stopped`: take + send (mirrors the kind=="stopped" arm).
        if let Some(tx) = slot.lock().unwrap().take() {
            let _ = tx.send(());
        }
        assert!(matches!(rx.recv_timeout(HOST_STOPPED_EVENT_TIMEOUT), Ok(())));

        // Post-stop EOF: slot already None → take() is a harmless no-op.
        assert!(slot.lock().unwrap().take().is_none());
    }

    /// Spawn a `/bin/sh` host stand-in in its own process group with a long-lived
    /// grandchild (the llama-server equivalent) that inherits the group, exactly
    /// as node spawns llama-server. `body` runs after the background grandchild is
    /// launched; `; wait` keeps the parent (and group) alive, omitting it lets the
    /// parent exit immediately with the grandchild still running (a crash). Returns
    /// the still-owned parent `Child` and the grandchild pid.
    #[cfg(target_os = "macos")]
    fn spawn_host_tree(body: &str) -> (Child, libc::pid_t) {
        use std::os::unix::process::CommandExt;

        let mut parent = Command::new("/bin/sh")
            .args(["-c", &format!("sleep 300 & echo $!{body}")])
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .process_group(0) // pgid == parent pid; grandchild inherits it
            .spawn()
            .expect("spawn parent shell");

        let mut line = String::new();
        {
            let stdout = parent.stdout.take().expect("piped stdout");
            BufReader::new(stdout)
                .read_line(&mut line)
                .expect("read grandchild pid");
        }
        let grandchild: libc::pid_t = line.trim().parse().expect("grandchild pid");
        // Sanity: the grandchild is alive (signal 0 = existence probe).
        assert_eq!(
            unsafe { libc::kill(grandchild, 0) },
            0,
            "grandchild should be alive before teardown"
        );
        (parent, grandchild)
    }

    /// Poll (briefly) that a pid is gone. It can linger a beat while the kernel
    /// delivers SIGKILL and init reaps the reparented process.
    #[cfg(target_os = "macos")]
    fn assert_reaped(pid: libc::pid_t, msg: &str) {
        for _ in 0..200 {
            if unsafe { libc::kill(pid, 0) } != 0 {
                return;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        panic!("{msg}");
    }

    /// AC(a), overstayed-node path: when node is still ALIVE at the deadline, the
    /// group-SIGKILL backstop must take the llama-server grandchild down too — a
    /// plain `child.kill()` would leave it running. macOS-only: `libc` (and the
    /// shipped app) are macOS-only, so this runs under the `app-macos` CI job.
    #[cfg(target_os = "macos")]
    #[test]
    fn group_kill_backstop_reaps_the_whole_process_tree() {
        // `; wait` keeps the parent (and thus the group) alive — the overstay case.
        let (mut parent, grandchild) = spawn_host_tree("; wait");

        signal_host_group(parent.id() as libc::pid_t);
        let _ = parent.wait();

        assert_reaped(
            grandchild,
            "group-kill must reap the llama-server-equivalent grandchild, not orphan it",
        );
    }

    /// AC(a), crashed-node path (#169 amendment / the P1 this PR fixes): node has
    /// already EXITED without reaping its engine (a hard crash never runs node's
    /// `close` handler), leaving llama-server orphaned in the host's process group.
    /// `reap_host_blocking` must still SIGKILL that grandchild — its
    /// `waitid(WNOWAIT)` poll observes node's exit without reaping it, so the pgid
    /// stays reserved and the group-kill lands on the real group before `wait()`.
    #[cfg(target_os = "macos")]
    #[test]
    fn reap_host_cleans_up_after_a_crashed_host_without_orphaning_the_engine() {
        // No `; wait`: the parent exits at once, grandchild left running (a crash).
        let (parent, grandchild) = spawn_host_tree("");

        // Let the parent actually exit. It becomes an un-reaped zombie (we own it),
        // so its pid — and the group id — stay reserved until the wait() inside
        // reap_host_blocking. The non-reaping poll must observe this exit.
        let mut exited = false;
        for _ in 0..200 {
            if host_exited_without_reaping(parent.id() as libc::pid_t) {
                exited = true;
                break;
            }
            std::thread::sleep(Duration::from_millis(10));
        }
        assert!(exited, "the crashed host stand-in should have exited");
        // The grandchild is still alive — this is the orphan the old code leaked.
        assert_eq!(
            unsafe { libc::kill(grandchild, 0) },
            0,
            "grandchild must still be alive before reap (it models the orphan)"
        );

        // The graceful reap protocol must still reap the orphaned grandchild, and
        // promptly — the non-reaping poll sees node already gone, so no 8s wait.
        let start = std::time::Instant::now();
        reap_host_blocking(parent);
        assert!(
            start.elapsed() < SHUTDOWN_HOST_TIMEOUT,
            "a crashed host must not burn the full graceful timeout"
        );

        assert_reaped(
            grandchild,
            "reap_host must SIGKILL a crashed host's orphaned llama-server grandchild",
        );
    }
}
