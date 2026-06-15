//! LiveCap overlay shell (#10): three glass window modes, capture exclusion,
//! edge snapping, click-through, global hotkeys, and the menu bar item.

mod bridge;
mod config;
mod glyph;
mod modes;
mod overlay;
mod permissions;
mod platform;
mod session;
mod settings;
mod snap;
mod tray;
mod ui_state;

use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Manager, RunEvent, WebviewWindow, WindowEvent};
use tauri_plugin_global_shortcut::{Code, GlobalShortcutExt, Modifiers, Shortcut, ShortcutState};

use modes::Mode;
use overlay::Shell;

/// Feature availability flags the UI reads its disabled states from.
/// #11 flipped `captioning`; #12 flipped `settings` — the shell UI enables
/// the corresponding controls without rewiring.
#[derive(Debug, Clone, Copy, Serialize)]
pub struct Capabilities {
    pub captioning: bool,
    pub settings: bool,
}

pub const CAPABILITIES: Capabilities = Capabilities {
    captioning: true,
    settings: true,
};

fn shortcut_toggle() -> Shortcut {
    Shortcut::new(Some(Modifiers::ALT), Code::Space)
}

fn shortcut_cycle() -> Shortcut {
    Shortcut::new(Some(Modifiers::ALT | Modifiers::SHIFT), Code::Space)
}

/// Run a closure on the main thread and wait for its result (NSWindow state
/// may only be touched there).
fn on_main_thread<T, F>(window: &WebviewWindow, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce(&WebviewWindow) -> T + Send + 'static,
{
    let (tx, rx) = std::sync::mpsc::channel();
    let w = window.clone();
    window
        .run_on_main_thread(move || {
            let _ = tx.send(f(&w));
        })
        .map_err(|e| e.to_string())?;
    rx.recv_timeout(Duration::from_secs(2)).map_err(|e| e.to_string())
}

#[tauri::command]
fn capabilities() -> Capabilities {
    CAPABILITIES
}

#[tauri::command]
fn get_shell_state(app: AppHandle) -> overlay::ShellState {
    overlay::shell_state(&app.state::<Shell>())
}

/// EPIC launch gate check: reads the ACTUAL NSWindow sharingType back from
/// the window, returning true only if it is excluded from screen capture.
#[tauri::command]
fn capture_excluded(window: WebviewWindow) -> Result<bool, String> {
    on_main_thread(&window, platform::capture_excluded)
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "camelCase")]
struct ShellDiagnostics {
    capture_excluded: bool,
    joins_all_spaces_and_fullscreen: bool,
    pinned: bool,
}

/// Read back the overlay's NSWindow flags for manual verification.
#[tauri::command]
fn shell_diagnostics(window: WebviewWindow) -> Result<ShellDiagnostics, String> {
    on_main_thread(&window, |w| ShellDiagnostics {
        capture_excluded: platform::capture_excluded(w),
        joins_all_spaces_and_fullscreen: platform::joins_all_spaces_and_fullscreen(w),
        pinned: platform::pinned(w),
    })
}

#[tauri::command]
fn set_mode(app: AppHandle, mode: String) -> Result<(), String> {
    let mode = Mode::from_id(&mode).ok_or_else(|| format!("unknown mode: {mode}"))?;
    overlay::apply_mode(&app, mode);
    Ok(())
}

#[tauri::command]
fn cycle_mode(app: AppHandle) {
    overlay::cycle_mode(&app);
}

#[tauri::command]
fn set_click_through(app: AppHandle, enabled: bool) {
    overlay::set_click_through(&app, enabled);
}

/// Toggle pin-on-top at runtime (no relaunch): flips the NSWindow level +
/// Spaces/fullscreen behavior and Tauri's always-on-top, persists the choice,
/// and mirrors it to the tray. Pinned floats over every Space; unpinned is a
/// normal window.
#[tauri::command]
fn set_pinned(app: AppHandle, pinned: bool) {
    overlay::set_pinned(&app, pinned);
}

/// Re-apply the persisted pin preference to the window. main.ts calls this once
/// first-run onboarding completes: the app boots unpinned during onboarding (so
/// the overlay can't cover the macOS permission sheets), then restores the saved
/// pin here.
#[tauri::command]
fn reapply_pin(app: AppHandle) {
    let pinned = app
        .state::<Shell>()
        .inner()
        .config
        .lock()
        .expect("config lock")
        .pinned;
    overlay::set_pinned(&app, pinned);
}

#[tauri::command]
fn begin_drag(app: AppHandle) {
    overlay::begin_drag(&app);
}

#[tauri::command]
fn end_drag(app: AppHandle) {
    overlay::end_drag(&app);
}

#[tauri::command]
fn hide_overlay(window: WebviewWindow) {
    let _ = window.hide();
}

/// Captioning live state (the session lifecycle in session.rs drives this);
/// drives the amber menu bar glyph. Kept as a command for manual diagnostics.
#[tauri::command]
fn set_live(app: AppHandle, live: bool) {
    tray::set_live(&app, live);
}

/// Shared clean-shutdown path for both the tray "Quit" item and a received
/// SIGTERM/SIGINT (#66). Stopping the session drains the caption pipeline (so a
/// gated #64 WAV dump finalizes its header), tells the session host to stop —
/// which reaps the spawned llama-server, not just the node host — and waits for
/// it to exit. The overlay window is then destroyed so no frozen webview is
/// left on screen, and the process exits. Without this, a SIGTERM left a zombie
/// overlay + orphaned children behind.
async fn teardown(app: AppHandle) {
    // shutdown() tears down a session in ANY phase — including a half-built
    // `Starting` one whose host + llama-server are already spawned — so a
    // SIGTERM mid-startup can never orphan them.
    session::shutdown(&app).await;
    if let Some(window) = overlay::overlay_window(&app) {
        let _ = window.destroy();
    }
    app.state::<Shell>().save_now();
    app.exit(0);
}

/// Run [`teardown`] from a synchronous context (tray click, signal thread):
/// drive it on the async runtime and block until it returns, so the process is
/// not killed out from under an in-flight session stop.
pub(crate) fn teardown_blocking(app: &AppHandle) {
    tauri::async_runtime::block_on(teardown(app.clone()));
}

/// Block SIGTERM/SIGINT for the calling (main) thread BEFORE any other threads
/// are spawned (#66). Because threads inherit the signal mask, every later
/// thread — Tauri's runtime workers, our watchers — also blocks these signals,
/// so the disposition is decided solely by the dedicated `sigwait` thread
/// instead of the default "terminate the process now" behavior.
#[cfg(unix)]
fn block_termination_signals() {
    // SAFETY: standard libc sigset construction + mask install on the current
    // thread; no aliasing, and the mask is plain POD.
    unsafe {
        let mut set: libc::sigset_t = std::mem::zeroed();
        libc::sigemptyset(&mut set);
        libc::sigaddset(&mut set, libc::SIGTERM);
        libc::sigaddset(&mut set, libc::SIGINT);
        libc::pthread_sigmask(libc::SIG_BLOCK, &set, std::ptr::null_mut());
    }
}

#[cfg(not(unix))]
fn block_termination_signals() {}

/// Install a SIGTERM/SIGINT handler that runs the SAME teardown as Quit (#66).
/// A dedicated thread blocks in `sigwait` so the teardown — which awaits async
/// session shutdown — runs on a normal thread rather than in an async-signal
/// unsafe handler. Pairs with [`block_termination_signals`], which must have
/// already masked these signals on every thread. On macOS `pkill -TERM` /
/// Ctrl-C therefore reaps children and removes the overlay instead of leaving a
/// zombie window.
#[cfg(unix)]
fn install_signal_handler(app: AppHandle) {
    use std::sync::atomic::{AtomicBool, Ordering};

    // Guard against a second teardown if both signals arrive (or one arrives
    // while Quit is already tearing down).
    static HANDLING: AtomicBool = AtomicBool::new(false);

    std::thread::spawn(move || {
        let mut set: libc::sigset_t = unsafe { std::mem::zeroed() };
        // SAFETY: libc sigset construction + sigwait on the dedicated handler
        // thread; the signals are already process-wide blocked so sigwait owns
        // their delivery.
        unsafe {
            libc::sigemptyset(&mut set);
            libc::sigaddset(&mut set, libc::SIGTERM);
            libc::sigaddset(&mut set, libc::SIGINT);
        }
        let mut signum: libc::c_int = 0;
        let waited = unsafe { libc::sigwait(&set, &mut signum) };
        if waited == 0 && !HANDLING.swap(true, Ordering::SeqCst) {
            teardown_blocking(&app);
        }
    });
}

#[cfg(not(unix))]
fn install_signal_handler(_app: AppHandle) {}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Mask SIGTERM/SIGINT before any threads spawn so the dedicated sigwait
    // thread owns their delivery and can run a clean teardown (#66).
    block_termination_signals();

    tauri::Builder::default()
        // Single-instance guard (#66): registered FIRST per the plugin's docs.
        // A second launch hands its argv/cwd to this callback in the EXISTING
        // process instead of spawning a second overlay; we just surface the one
        // window (restore mode to Panel if it was wedged, show, focus).
        .plugin(tauri_plugin_single_instance::init(|app, _args, _cwd| {
            if let Some(window) = overlay::overlay_window(app) {
                let _ = window.unminimize();
                let _ = window.show();
                let _ = window.set_focus();
            }
        }))
        .plugin(
            tauri_plugin_global_shortcut::Builder::new()
                .with_handler(|app, shortcut, event| {
                    if event.state() != ShortcutState::Pressed {
                        return;
                    }
                    if shortcut == &shortcut_toggle() {
                        overlay::toggle_visibility(app);
                    } else if shortcut == &shortcut_cycle() {
                        overlay::cycle_mode(app);
                    }
                })
                .build(),
        )
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .invoke_handler(tauri::generate_handler![
            capabilities,
            get_shell_state,
            capture_excluded,
            shell_diagnostics,
            set_mode,
            cycle_mode,
            set_click_through,
            set_pinned,
            reapply_pin,
            begin_drag,
            end_drag,
            hide_overlay,
            set_live,
            session::session_start,
            session::session_stop,
            session::session_pause,
            session::session_resume,
            session::session_phase,
            session::session_set_mic,
            session::session_channels,
            session::host_request,
            session::gauge_state,
            ui_state::ui_beat,
            ui_state::ui_snapshot,
            session::host_probe,
            settings::get_settings,
            settings::set_settings,
            permissions::mic_permission_status,
            permissions::request_audio_access,
            permissions::probe_system_audio,
            permissions::open_privacy_settings,
        ])
        .setup(|app| {
            #[cfg(target_os = "macos")]
            app.set_activation_policy(tauri::ActivationPolicy::Accessory);

            let window = app
                .get_webview_window(overlay::WINDOW_LABEL)
                .expect("overlay window declared in tauri.conf.json");

            app.manage(session::SessionState::default());
            app.manage(session::GaugeCache::default());
            app.manage(ui_state::UiState::default());

            // Persisted app settings (#12): onboarding state + the Settings
            // sheet values, loaded once and managed for the whole app.
            let settings_path = settings::settings_path(app.handle())?;
            app.manage(settings::SettingsState::new(settings_path));

            let config_path = app.path().app_data_dir()?.join(config::FILE_NAME);
            let cfg = config::load(&config_path);
            let initial_mode = overlay::initial_mode(&window, &cfg);
            // Pin-on-top preference restored from disk (default true). The
            // window's tauri.conf.json declares alwaysOnTop/visibleOnAllWorkspaces
            // = true; if the operator left it unpinned last run we flip both
            // off below so the restored state matches.
            //
            // BUT never boot pinned into first-run onboarding: a pinned overlay
            // (always-on-top) sits above the macOS audio-permission sheets and
            // hides them, so "Grant audio access" appears to do nothing. While
            // onboarding is pending the window stays a normal, non-floating
            // window; main.ts re-applies the saved pin via `reapply_pin` once
            // setup finishes. The persisted preference (cfg.pinned) is untouched.
            let onboarding_done = app
                .state::<settings::SettingsState>()
                .snapshot()
                .onboarding_complete;
            let initial_pinned = cfg.pinned && onboarding_done;
            app.manage(Shell::new(config_path, cfg, initial_mode));

            // Screen-capture exclusion (EPIC launch gate) + Spaces/fullscreen
            // behavior + window level. Setup runs on the main thread.
            // LIVECAP_CAPTURE_VISIBLE=1 disables BOTH exclusion mechanisms
            // (Tauri content-protection here + NSWindow sharingType in
            // platform::configure_overlay) — DEV/VERIFICATION ONLY (#54).
            if std::env::var("LIVECAP_CAPTURE_VISIBLE").as_deref() != Ok("1") {
                window.set_content_protected(true)?;
            }
            platform::configure_overlay(&window, initial_pinned);
            // Keep Tauri's own always-on-top flag in sync with the restored pin
            // state (the conf default is true; flip it off if unpinned).
            if !initial_pinned {
                let _ = window.set_always_on_top(false);
            }

            tray::create(app.handle(), initial_mode, initial_pinned)?;
            overlay::apply_mode(app.handle(), initial_mode);
            window.show()?;

            // #54 debug probe: LIVECAP_UI_PROBE=1 makes Rust eval() a JS
            // snippet inside the webview every 3s that reports page state via
            // the ui_beat IPC command — works even when the app's own module
            // failed to evaluate. If no heartbeat file appears, IPC itself is
            // broken (e.g. CSP).
            if std::env::var("LIVECAP_UI_PROBE").as_deref() == Ok("1") {
                let probe_window = window.clone();
                tauri::async_runtime::spawn(async move {
                    let js = r##"(function(){
                        try {
                            var beat = {
                                ts: Date.now(),
                                mode: "probe",
                                feedBlocks: document.querySelectorAll("#feed > *").length,
                                domBlocks: document.querySelectorAll("#feed .cap").length,
                                latestSource: "readyState=" + document.readyState,
                                latestTranslation: "bodyBytes=" + (document.body ? document.body.innerHTML.length : -1),
                                capsuleText: "scripts=" + document.scripts.length,
                                bootError: (window.__lcBootError || null)
                            };
                            window.__TAURI_INTERNALS__.invoke("ui_beat", { beat: beat });
                        } catch (e) {
                            try { window.__TAURI_INTERNALS__.invoke("ui_beat", { beat: { ts: Date.now(), mode: "probe-error", feedBlocks: 0, latestSource: String(e), latestTranslation: "", capsuleText: "", bootError: String(e) } }); } catch (_) {}
                        }
                    })()"##;
                    loop {
                        let _ = probe_window.eval(js);
                        tokio::time::sleep(std::time::Duration::from_secs(3)).await;
                    }
                });
            }

            // Headless E2E support (also used by #13): start a captioning
            // session at launch when LIVECAP_AUTOSTART=1 — same code path as
            // the tray/chrome start, just triggered without UI.
            if std::env::var("LIVECAP_AUTOSTART").as_deref() == Ok("1") {
                let handle = app.handle().clone();
                tauri::async_runtime::spawn(async move {
                    if let Err(e) = session::start(handle).await {
                        eprintln!("autostart session failed: {e}");
                    }
                });
            }

            for (name, shortcut) in [("Alt+Space", shortcut_toggle()), ("Alt+Shift+Space", shortcut_cycle())]
            {
                if let Err(e) = app.global_shortcut().register(shortcut) {
                    eprintln!("livecap: could not register global hotkey {name}: {e}");
                }
            }

            overlay::spawn_click_through_watcher(app.handle().clone());
            overlay::spawn_config_saver(app.handle().clone());

            // Clean teardown on SIGTERM/SIGINT (#66): same path as tray Quit.
            install_signal_handler(app.handle().clone());
            Ok(())
        })
        .on_window_event(|window, event| {
            if window.label() != overlay::WINDOW_LABEL {
                return;
            }
            match event {
                WindowEvent::Moved(_) | WindowEvent::Resized(_) => {
                    // Window-creation events can fire before setup manages
                    // the Shell state, hence try_state.
                    if let (Some(webview), Some(shell)) = (
                        overlay::overlay_window(window.app_handle()),
                        window.try_state::<Shell>(),
                    ) {
                        overlay::record_geometry(&webview, &shell);
                    }
                }
                WindowEvent::CloseRequested { api, .. } => {
                    // The overlay hides; the app lives in the menu bar.
                    api.prevent_close();
                    let _ = window.hide();
                }
                _ => {}
            }
        })
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            if let RunEvent::Exit = event {
                app.state::<Shell>().save_now();
            }
        });
}
