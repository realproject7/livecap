//! Menu bar item (design/screens/08-menubar.png): template glyph, live
//! (amber) state, and the dropdown menu.

use std::sync::atomic::Ordering;

use tauri::image::Image;
use tauri::menu::{CheckMenuItem, Menu, MenuItem, PredefinedMenuItem, Submenu};
use tauri::tray::{TrayIcon, TrayIconBuilder};
use tauri::{AppHandle, Emitter, Manager, Wry};

use crate::glyph;
use crate::modes::Mode;
use crate::overlay::{self, Shell, EVENT_MODE};

const TRAY_ID: &str = "livecap-tray";

struct TrayHandles {
    tray: TrayIcon,
    mode_items: Vec<(Mode, CheckMenuItem<Wry>)>,
    captioning: MenuItem<Wry>,
    mic: CheckMenuItem<Wry>,
    pinned: CheckMenuItem<Wry>,
}

fn icon(live: bool) -> Image<'static> {
    Image::new_owned(glyph::menubar_icon(live), glyph::SIZE, glyph::SIZE)
}

pub fn create(app: &AppHandle, initial_mode: Mode, initial_pinned: bool) -> tauri::Result<()> {
    let caps = crate::CAPABILITIES;

    let toggle = MenuItem::with_id(app, "toggle", "Show/Hide LiveCap", true, Some("Alt+Space"))?;

    let mode_items: Vec<(Mode, CheckMenuItem<Wry>)> = Mode::ALL
        .iter()
        .map(|&mode| {
            CheckMenuItem::with_id(
                app,
                format!("mode-{}", mode.id()),
                mode.label(),
                true,
                mode == initial_mode,
                None::<&str>,
            )
            .map(|item| (mode, item))
        })
        .collect::<Result<_, _>>()?;
    let mode_refs: Vec<&dyn tauri::menu::IsMenuItem<Wry>> = mode_items
        .iter()
        .map(|(_, item)| item as &dyn tauri::menu::IsMenuItem<Wry>)
        .collect();
    let mode_menu = Submenu::with_id_and_items(app, "mode", "Mode", true, &mode_refs)?;

    // Pin-on-top toggle, mirrored with the panel's 📌 button. Checked = the
    // overlay floats over every Space; unchecked = ordinary window.
    let pinned = CheckMenuItem::with_id(
        app,
        "pinned",
        "Pin on top",
        true,
        initial_pinned,
        None::<&str>,
    )?;

    // Real capability gating: captioning is live (#11); settings enables
    // when #12 flips its flag — no UI rewiring needed.
    let captioning = MenuItem::with_id(
        app,
        "captioning",
        "Start Captioning",
        caps.captioning,
        None::<&str>,
    )?;
    // #53: mirrors the panel's mic toggle — enabled only during a session.
    let mic = CheckMenuItem::with_id(app, "mic", "Microphone", false, false, None::<&str>)?;
    let settings = MenuItem::with_id(app, "settings", "Settings…", caps.settings, None::<&str>)?;
    let quit = MenuItem::with_id(app, "quit", "Quit LiveCap", true, Some("Cmd+Q"))?;

    let menu = Menu::with_items(
        app,
        &[
            &toggle,
            &PredefinedMenuItem::separator(app)?,
            &mode_menu,
            &pinned,
            &PredefinedMenuItem::separator(app)?,
            &captioning,
            &mic,
            &PredefinedMenuItem::separator(app)?,
            &settings,
            &quit,
        ],
    )?;

    let tray = TrayIconBuilder::with_id(TRAY_ID)
        .icon(icon(false))
        // #95: NON-template gray glyph — the black template icon rendered
        // invisibly in the menu bar. Gray reads on light and dark bars.
        .icon_as_template(false)
        .tooltip("LiveCap")
        .menu(&menu)
        .show_menu_on_left_click(true)
        .on_menu_event(|app, event| match event.id().as_ref() {
            "toggle" => overlay::toggle_visibility(app),
            "captioning" => {
                // Session start/stop (#11) — async: starting loads the
                // whisper model and spawns the session host.
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    crate::session::toggle(app).await;
                });
            }
            "mic" => {
                // #53: mid-session mic pause/resume; no-op without a session.
                let app = app.clone();
                tauri::async_runtime::spawn(async move {
                    crate::session::toggle_mic(app).await;
                });
            }
            "pinned" => {
                // Toggle pin-on-top; read the desired state from the new check
                // mark and apply it (the panel button + tray stay in sync via
                // sync_pinned / the shell://mode event).
                if let Some(handles) = app.try_state::<TrayHandles>() {
                    let want = handles.pinned.is_checked().unwrap_or(true);
                    overlay::set_pinned(app, want);
                }
            }
            "settings" => overlay::open_settings(app),
            "quit" => {
                // Full clean teardown (#66): stop the session (reaping the host
                // and the spawned llama-server, finalizing any #64 WAV dump),
                // destroy the overlay, persist shell state, then exit. Runs the
                // SAME path as the SIGTERM/SIGINT handler. Spawned off the menu
                // callback so the async stop is not driven on the menu thread.
                let app = app.clone();
                std::thread::spawn(move || crate::teardown_blocking(&app));
            }
            id => {
                if let Some(mode) = id.strip_prefix("mode-").and_then(Mode::from_id) {
                    overlay::apply_mode(app, mode);
                }
            }
        })
        .build(app)?;

    app.manage(TrayHandles {
        tray,
        mode_items,
        captioning,
        mic,
        pinned,
    });
    Ok(())
}

/// Mirror the pin-on-top state in the tray check item (driven by the panel
/// button or a tray click round-tripping through `overlay::set_pinned`).
pub fn sync_pinned(app: &AppHandle, pinned: bool) {
    if let Some(handles) = app.try_state::<TrayHandles>() {
        let _ = handles.pinned.set_checked(pinned);
    }
}

/// Mirror the session's mic state (#53): enabled while a session is running,
/// check mark = mic capturing. Driven by session.rs.
pub fn sync_mic(app: &AppHandle, enabled: bool, checked: bool) {
    if let Some(handles) = app.try_state::<TrayHandles>() {
        let _ = handles.mic.set_enabled(enabled);
        let _ = handles.mic.set_checked(checked);
    }
}

/// Reflect the active mode in the Mode submenu check marks.
pub fn sync_mode(app: &AppHandle, mode: Mode) {
    if let Some(handles) = app.try_state::<TrayHandles>() {
        for (m, item) in &handles.mode_items {
            let _ = item.set_checked(*m == mode);
        }
    }
}

/// Live state: amber glyph while captioning, gray otherwise.
/// Driven by the session lifecycle (#11, session.rs).
pub fn set_live(app: &AppHandle, live: bool) {
    let shell = app.state::<Shell>();
    shell.live.store(live, Ordering::Relaxed);
    if let Some(handles) = app.try_state::<TrayHandles>() {
        // #95: both states are non-template (idle gray, live amber) so the
        // glyph stays visible — the black template idle icon was invisible.
        let _ = handles.tray.set_icon_as_template(false);
        let _ = handles.tray.set_icon(Some(icon(live)));
        let _ = handles
            .captioning
            .set_text(if live { "Stop Captioning" } else { "Start Captioning" });
    }
    if let Some(window) = overlay::overlay_window(app) {
        let _ = window.emit(EVENT_MODE, overlay::shell_state(&shell));
    }
}
