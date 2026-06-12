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
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex as StdMutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use livecap_core::{CaptionPipeline, PipelineConfig};
use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, State};

use crate::bridge::BridgeCaption;
use crate::settings::SettingsState;
use crate::tray;

const HOST_EXIT_TIMEOUT: Duration = Duration::from_secs(60);

/// Host-stdin request types the webview may forward through `host_request`.
const FORWARDABLE_REQUESTS: &[&str] = &["quickTranslate", "reply", "retranslate", "pin", "silenceSnooze"];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub enum Phase {
    #[default]
    Idle,
    Starting,
    Live,
    Paused,
    Stopping,
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
}

#[derive(Clone, Serialize)]
struct StatusPayload {
    phase: &'static str,
    #[serde(skip_serializing_if = "Option::is_none")]
    detail: Option<String>,
}

struct HostHandle {
    child: Child,
    stdin: Arc<StdMutex<ChildStdin>>,
    /// Set before a deliberate stop so the reader thread does not report the
    /// host's exit as a failure.
    expected_exit: Arc<AtomicBool>,
}

#[derive(Default)]
struct Inner {
    phase: Phase,
    pipeline: Option<CaptionPipeline>,
    host: Option<HostHandle>,
    events_task: Option<tauri::async_runtime::JoinHandle<()>>,
}

/// Managed session state (one session at a time).
#[derive(Default)]
pub struct SessionState {
    inner: tauri::async_runtime::Mutex<Inner>,
    next_caption_id: AtomicU64,
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

fn now_epoch_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
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

    let mut child = Command::new(node)
        .arg(script)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("could not start the session host: {e}"))?;

    let stdin = Arc::new(StdMutex::new(child.stdin.take().expect("piped stdin")));
    let stdout = child.stdout.take().expect("piped stdout");
    let stderr = child.stderr.take().expect("piped stderr");
    let expected_exit = Arc::new(AtomicBool::new(false));

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
    std::thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line in reader.lines() {
            let Ok(line) = line else { break };
            let Ok(value) = serde_json::from_str::<serde_json::Value>(&line) else {
                continue;
            };
            if value.get("type").and_then(|t| t.as_str()) == Some("gauge") {
                if let Some(cache) = reader_app.try_state::<GaugeCache>() {
                    if let Ok(mut guard) = cache.0.lock() {
                        *guard = value.get("gauge").cloned();
                    }
                }
            }
            let _ = reader_app.emit("host://event", &value);
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
    })
}

/// Start mic + system capture; system-only operation is tolerated (mic may
/// lack permission), but at least one channel must come up.
fn start_captures(pipeline: &mut CaptionPipeline) -> Result<Option<String>, String> {
    let system = pipeline.start_system(None);
    let mic = pipeline.start_mic(None);
    match (system, mic) {
        (Ok(()), Ok(())) => Ok(None),
        (Ok(()), Err(e)) => Ok(Some(format!("microphone unavailable ({e}) — captioning system audio only"))),
        (Err(e), Ok(())) => Ok(Some(format!("system audio unavailable ({e}) — captioning the microphone only"))),
        (Err(system_err), Err(mic_err)) => Err(format!(
            "audio capture failed — system: {system_err}; mic: {mic_err}"
        )),
    }
}

pub async fn start(app: AppHandle) -> Result<(), String> {
    let state = app.state::<SessionState>();
    {
        let mut inner = state.inner.lock().await;
        if inner.phase != Phase::Idle {
            return Err(format!("session is {}", inner.phase.as_str()));
        }
        inner.phase = Phase::Starting;
    }
    emit_status(
        &app,
        Phase::Starting,
        Some("preparing the caption model (first run downloads it)…".into()),
    );

    match start_inner(&app).await {
        Ok(detail) => {
            {
                let state = app.state::<SessionState>();
                let mut inner = state.inner.lock().await;
                inner.phase = Phase::Live;
            }
            tray::set_live(&app, true);
            emit_status(&app, Phase::Live, detail);
            Ok(())
        }
        Err(error) => {
            let state = app.state::<SessionState>();
            let mut inner = state.inner.lock().await;
            cleanup(&mut inner).await;
            inner.phase = Phase::Idle;
            drop(inner);
            tray::set_live(&app, false);
            emit_status(&app, Phase::Idle, Some(error.clone()));
            Err(error)
        }
    }
}

/// Archive destination: the Settings folder pick when set, otherwise
/// ~/Documents/LiveCap (PROPOSAL §8.9).
fn archive_dir(app: &AppHandle, settings: &crate::settings::AppSettings) -> PathBuf {
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

async fn start_inner(app: &AppHandle) -> Result<Option<String>, String> {
    let app_data_dir = app.path().app_data_dir().map_err(|e| e.to_string())?;
    let models_dir = app_data_dir.join("models");

    // Persisted settings (#12) drive the session: target language, engine
    // preference, gauge config, archive policy. Read fresh at every start so
    // Settings changes apply to the next session without an app restart.
    let settings = app.state::<SettingsState>().snapshot();
    let archive_dir = archive_dir(app, &settings);

    // The host starts first (cheap; engine detection runs while whisper
    // loads); the pipeline build may block on a first-run model download.
    let start_message = serde_json::json!({
        "type": "start",
        "appDataDir": app_data_dir,
        "archiveDir": archive_dir,
        "targetLanguageCode": settings.target_language,
        "enginePref": settings.engine_pref,
        "poolUsd": settings.pool_usd,
        "resetDay": settings.reset_day,
        "autoSwitch": settings.auto_switch,
        "archiveAutoSave": settings.archive_auto_save,
        "archiveRetentionDays": settings.archive_retention_days,
    });
    let mut host = spawn_host(app, &start_message)?;

    let abort_host = |host: &mut HostHandle| {
        host.expected_exit.store(true, Ordering::Relaxed);
        let _ = write_host_line(&host.stdin, &serde_json::json!({ "type": "stop" }));
        let _ = host.child.kill();
    };

    let config = PipelineConfig::new(models_dir);
    let (mut pipeline, mut events_rx) = match CaptionPipeline::new(config).await {
        Ok(built) => built,
        Err(error) => {
            abort_host(&mut host);
            return Err(format!("caption pipeline failed to start: {error}"));
        }
    };

    let capture_note = match start_captures(&mut pipeline) {
        Ok(note) => note,
        Err(error) => {
            abort_host(&mut host);
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
            let session = events_app.state::<SessionState>();
            let mapped = BridgeCaption::from_event(
                event,
                || session.next_caption_id.fetch_add(1, Ordering::Relaxed) + 1,
                now_epoch_ms(),
            );
            let _ = events_app.emit("caption://event", &mapped);
            if let Some(message) = mapped.host_message() {
                let _ = write_host_line(&host_stdin, &message);
            }
        }
    });

    let mut inner = state.inner.lock().await;
    inner.pipeline = Some(pipeline);
    inner.host = Some(host);
    inner.events_task = Some(events_task);
    Ok(capture_note)
}

pub async fn stop(app: AppHandle) -> Result<(), String> {
    let state = app.state::<SessionState>();
    let (pipeline, host, events_task) = {
        let mut inner = state.inner.lock().await;
        if inner.phase != Phase::Live && inner.phase != Phase::Paused {
            return Err(format!("session is {}", inner.phase.as_str()));
        }
        inner.phase = Phase::Stopping;
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

    if let Some(mut host) = host {
        host.expected_exit.store(true, Ordering::Relaxed);
        let _ = write_host_line(&host.stdin, &serde_json::json!({ "type": "stop" }));
        let (tx, rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || {
            let _ = host.child.wait();
            let _ = tx.send(());
        });
        let waited = tauri::async_runtime::spawn_blocking(move || rx.recv_timeout(HOST_EXIT_TIMEOUT))
            .await;
        if !matches!(waited, Ok(Ok(()))) {
            // The host did not finish in time; the archive working file is
            // still on disk (incremental writes) — nothing is lost.
            let _ = app.emit(
                "host://event",
                serde_json::json!({ "type": "hostError", "detail": "session host did not exit cleanly" }),
            );
        }
    }

    {
        let mut inner = state.inner.lock().await;
        inner.phase = Phase::Idle;
    }
    tray::set_live(&app, false);
    emit_status(&app, Phase::Idle, None);
    Ok(())
}

pub async fn pause(app: AppHandle) -> Result<(), String> {
    let state = app.state::<SessionState>();
    let mut inner = state.inner.lock().await;
    if inner.phase != Phase::Live {
        return Err(format!("session is {}", inner.phase.as_str()));
    }
    if let Some(pipeline) = inner.pipeline.as_mut() {
        pipeline.stop_capture();
    }
    inner.phase = Phase::Paused;
    drop(inner);
    tray::set_live(&app, false);
    emit_status(&app, Phase::Paused, None);
    Ok(())
}

pub async fn resume(app: AppHandle) -> Result<(), String> {
    let state = app.state::<SessionState>();
    let mut inner = state.inner.lock().await;
    if inner.phase != Phase::Paused {
        return Err(format!("session is {}", inner.phase.as_str()));
    }
    let detail = match inner.pipeline.as_mut() {
        Some(pipeline) => start_captures(pipeline)?,
        None => return Err("no active pipeline".into()),
    };
    inner.phase = Phase::Live;
    drop(inner);
    tray::set_live(&app, true);
    emit_status(&app, Phase::Live, detail);
    Ok(())
}

/// Tray menu entry point: toggles between start and stop.
pub async fn toggle(app: AppHandle) {
    let phase = {
        let state = app.state::<SessionState>();
        let inner = state.inner.lock().await;
        inner.phase
    };
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
    if let Some(mut host) = inner.host.take() {
        host.expected_exit.store(true, Ordering::Relaxed);
        let _ = host.child.kill();
        let _ = host.child.wait();
    }
    if let Some(task) = inner.events_task.take() {
        task.abort();
    }
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
    Ok(state.inner.lock().await.phase.as_str())
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
    match (&inner.host, inner.phase) {
        (Some(host), Phase::Live | Phase::Paused) => write_host_line(&host.stdin, &message),
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
