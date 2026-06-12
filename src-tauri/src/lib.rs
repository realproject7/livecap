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
}

/// Read back the overlay's NSWindow flags for manual verification.
#[tauri::command]
fn shell_diagnostics(window: WebviewWindow) -> Result<ShellDiagnostics, String> {
    on_main_thread(&window, |w| ShellDiagnostics {
        capture_excluded: platform::capture_excluded(w),
        joins_all_spaces_and_fullscreen: platform::joins_all_spaces_and_fullscreen(w),
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

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
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
            begin_drag,
            end_drag,
            hide_overlay,
            set_live,
            session::session_start,
            session::session_stop,
            session::session_pause,
            session::session_resume,
            session::session_phase,
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
            app.manage(Shell::new(config_path, cfg, initial_mode));

            // Screen-capture exclusion (EPIC launch gate) + Spaces/fullscreen
            // behavior + window level. Setup runs on the main thread.
            window.set_content_protected(true)?;
            platform::configure_overlay(&window);

            tray::create(app.handle(), initial_mode)?;
            overlay::apply_mode(app.handle(), initial_mode);
            window.show()?;

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
