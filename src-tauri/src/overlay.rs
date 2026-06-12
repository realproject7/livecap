//! Overlay window runtime: mode switching, geometry persistence, magnetic
//! drag, and the click-through edge-regain watcher.

use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::Mutex;
use std::time::Duration;

use serde::Serialize;
use tauri::{AppHandle, Emitter, Manager, Monitor, PhysicalPosition, PhysicalSize, WebviewWindow};

use crate::config::{self, Geometry, ShellConfig};
use crate::modes::Mode;
use crate::platform;
use crate::snap;

pub const WINDOW_LABEL: &str = "main";

/// Events pushed to the webview.
pub const EVENT_MODE: &str = "shell://mode";
pub const EVENT_CHROME: &str = "shell://chrome";

/// Magnetic capture distance and snapped edge gap (logical px).
const SNAP_THRESHOLD: f64 = 18.0;
const SNAP_MARGIN: f64 = 12.0;
/// Strip's default gap above the bottom edge (logical px).
const STRIP_BOTTOM_MARGIN: f64 = 24.0;
/// Width of the click-through regain zone along window edges (logical px).
const EDGE_ZONE: f64 = 16.0;
/// Extra hysteresis once interactive, so the zone boundary doesn't flicker.
const EDGE_ZONE_STICKY: f64 = 32.0;

const DRAG_TICK: Duration = Duration::from_millis(12);
const WATCH_TICK: Duration = Duration::from_millis(80);
const SAVE_TICK: Duration = Duration::from_millis(500);

pub struct Shell {
    pub config_path: PathBuf,
    pub config: Mutex<ShellConfig>,
    pub mode: Mutex<Mode>,
    pub live: AtomicBool,
    pub click_through: AtomicBool,
    drag_generation: AtomicU64,
    dirty: AtomicBool,
    transitioning: AtomicBool,
    ignoring_cursor: AtomicBool,
}

impl Shell {
    pub fn new(config_path: PathBuf, config: ShellConfig, mode: Mode) -> Self {
        let click_through = config.click_through;
        Shell {
            config_path,
            config: Mutex::new(config),
            mode: Mutex::new(mode),
            live: AtomicBool::new(false),
            click_through: AtomicBool::new(click_through),
            drag_generation: AtomicU64::new(0),
            dirty: AtomicBool::new(false),
            // Starts true so window-creation Moved/Resized events cannot
            // record geometry before the launch restore in `apply_mode`
            // (which clears the flag) has positioned the window.
            transitioning: AtomicBool::new(true),
            ignoring_cursor: AtomicBool::new(false),
        }
    }

    pub fn mode(&self) -> Mode {
        *self.mode.lock().expect("mode lock")
    }

    pub fn mark_dirty(&self) {
        self.dirty.store(true, Ordering::Relaxed);
    }

    pub fn save_now(&self) {
        let snapshot = self.config.lock().expect("config lock").clone();
        if let Err(e) = config::save_atomic(&self.config_path, &snapshot) {
            eprintln!("livecap: failed to persist shell state: {e}");
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ShellState {
    pub mode: &'static str,
    pub click_through: bool,
    pub live: bool,
}

pub fn shell_state(shell: &Shell) -> ShellState {
    ShellState {
        mode: shell.mode().id(),
        click_through: shell.click_through.load(Ordering::Relaxed),
        live: shell.live.load(Ordering::Relaxed),
    }
}

#[derive(Clone, Serialize)]
struct ChromePayload {
    interactive: bool,
}

/// Mode to restore at launch: the last mode used on the window's display.
pub fn initial_mode(window: &WebviewWindow, config: &ShellConfig) -> Mode {
    let key = display_key(window);
    config
        .display(&key)
        .and_then(|d| d.mode)
        .unwrap_or(Mode::Panel)
}

pub fn overlay_window(app: &AppHandle) -> Option<WebviewWindow> {
    app.get_webview_window(WINDOW_LABEL)
}

fn display_key(window: &WebviewWindow) -> String {
    window
        .current_monitor()
        .ok()
        .flatten()
        .and_then(|m| m.name().cloned())
        .unwrap_or_else(|| "default".to_string())
}

fn work_area(monitor: &Monitor) -> snap::Rect {
    let area = monitor.work_area();
    snap::Rect {
        x: area.position.x as f64,
        y: area.position.y as f64,
        w: area.size.width as f64,
        h: area.size.height as f64,
    }
}

/// Default geometry for a mode on a monitor (physical px), per §8.1:
/// Panel centered, Strip docked bottom-center, Capsule top-right.
fn default_geometry(mode: Mode, monitor: &Monitor) -> Geometry {
    let scale = monitor.scale_factor();
    let (lw, lh) = mode.default_size();
    let (w, h) = (lw * scale, lh * scale);
    let area = work_area(monitor);
    let (x, y) = match mode {
        Mode::Panel => (area.x + (area.w - w) / 2.0, area.y + (area.h - h) / 2.0),
        Mode::Strip => (
            area.x + (area.w - w) / 2.0,
            area.y + area.h - h - STRIP_BOTTOM_MARGIN * scale,
        ),
        Mode::Capsule => (
            area.x + area.w - w - SNAP_MARGIN * scale,
            area.y + SNAP_MARGIN * scale,
        ),
    };
    Geometry { x, y, w, h }
}

fn current_geometry(window: &WebviewWindow) -> Option<Geometry> {
    let pos = window.outer_position().ok()?;
    let size = window.outer_size().ok()?;
    Some(Geometry {
        x: pos.x as f64,
        y: pos.y as f64,
        w: size.width as f64,
        h: size.height as f64,
    })
}

fn geometry_visible_on(geometry: Geometry, area: snap::Rect) -> bool {
    let right = geometry.x + geometry.w;
    let bottom = geometry.y + geometry.h;
    right > area.x && geometry.x < area.x + area.w && bottom > area.y && geometry.y < area.y + area.h
}

/// Record the current window rect under the active mode for the current
/// display. Skipped while a mode transition is repositioning the window.
pub fn record_geometry(window: &WebviewWindow, shell: &Shell) {
    if shell.transitioning.load(Ordering::Relaxed) {
        return;
    }
    if let Some(geometry) = current_geometry(window) {
        let mode = shell.mode();
        let display = display_key(window);
        shell
            .config
            .lock()
            .expect("config lock")
            .remember_geometry(&display, mode, geometry);
        shell.mark_dirty();
    }
}

/// Switch the overlay to `new_mode`: persist the old rect, restore (or
/// default) the new one, swap the glass radius, and notify webview + tray.
pub fn apply_mode(app: &AppHandle, new_mode: Mode) {
    let Some(window) = overlay_window(app) else {
        return;
    };
    let shell = app.state::<Shell>();
    let shell = shell.inner();

    // Remember the outgoing mode's rect. When re-applying the current mode
    // (launch restore, menu re-select) skip it, so the stored geometry is
    // not clobbered by the not-yet-restored window rect.
    if shell.mode() != new_mode {
        record_geometry(&window, shell);
    }
    shell.transitioning.store(true, Ordering::Relaxed);
    *shell.mode.lock().expect("mode lock") = new_mode;

    let display = display_key(&window);
    let stored = {
        let mut cfg = shell.config.lock().expect("config lock");
        cfg.display_mut(&display).mode = Some(new_mode);
        cfg.geometry_for(&display, new_mode)
    };
    shell.mark_dirty();

    let monitor = window.current_monitor().ok().flatten();
    let geometry = match (&monitor, stored) {
        (Some(m), Some(g)) if geometry_visible_on(g, work_area(m)) => g,
        (Some(m), _) => default_geometry(new_mode, m),
        (None, Some(g)) => g,
        (None, None) => {
            let (lw, lh) = new_mode.default_size();
            Geometry {
                x: 0.0,
                y: 0.0,
                w: lw,
                h: lh,
            }
        }
    };

    let _ = window.set_resizable(new_mode.resizable());
    let _ = window.set_size(PhysicalSize::new(geometry.w as u32, geometry.h as u32));
    let _ = window.set_position(PhysicalPosition::new(geometry.x as i32, geometry.y as i32));

    // Glass material must change radius with the mode; main-thread only.
    {
        let win = window.clone();
        let _ = window.run_on_main_thread(move || platform::apply_glass(&win, new_mode));
    }

    // Panel is always interactive.
    if !new_mode.supports_click_through() {
        set_cursor_ignored(&window, shell, false);
    }

    let _ = window.emit(EVENT_MODE, shell_state(shell));
    crate::tray::sync_mode(app, new_mode);

    // Let the Moved/Resized events from this transition drain before
    // geometry recording resumes.
    let app2 = app.clone();
    std::thread::spawn(move || {
        std::thread::sleep(Duration::from_millis(250));
        let shell = app2.state::<Shell>();
        shell.transitioning.store(false, Ordering::Relaxed);
    });
}

pub fn cycle_mode(app: &AppHandle) {
    let next = app.state::<Shell>().mode().next();
    apply_mode(app, next);
}

pub fn toggle_visibility(app: &AppHandle) {
    if let Some(window) = overlay_window(app) {
        if window.is_visible().unwrap_or(false) {
            let _ = window.hide();
        } else {
            let _ = window.show();
        }
    }
}

pub fn set_click_through(app: &AppHandle, enabled: bool) {
    let shell = app.state::<Shell>();
    let shell = shell.inner();
    shell.click_through.store(enabled, Ordering::Relaxed);
    shell.config.lock().expect("config lock").click_through = enabled;
    shell.mark_dirty();
    if let Some(window) = overlay_window(app) {
        if !enabled {
            set_cursor_ignored(&window, shell, false);
        }
        let _ = window.emit(EVENT_MODE, shell_state(shell));
    }
}

fn set_cursor_ignored(window: &WebviewWindow, shell: &Shell, ignored: bool) {
    if shell.ignoring_cursor.swap(ignored, Ordering::Relaxed) != ignored {
        let _ = window.set_ignore_cursor_events(ignored);
        let _ = window.emit(
            EVENT_CHROME,
            ChromePayload {
                interactive: !ignored,
            },
        );
    }
}

/// Start a magnetic drag: a thread follows the global cursor, applies edge
/// snapping live, and moves the window until `end_drag` bumps the
/// generation. Driven from Rust (not native dragging) so snapping is
/// magnetic *while* dragging.
pub fn begin_drag(app: &AppHandle) {
    let Some(window) = overlay_window(app) else {
        return;
    };
    let shell = app.state::<Shell>();
    let generation = shell.drag_generation.fetch_add(1, Ordering::SeqCst) + 1;
    let Ok(cursor_start) = app.cursor_position() else {
        return;
    };
    let Some(window_start) = current_geometry(&window) else {
        return;
    };

    let app = app.clone();
    std::thread::spawn(move || {
        loop {
            {
                let shell = app.state::<Shell>();
                if shell.drag_generation.load(Ordering::SeqCst) != generation {
                    break;
                }
            }
            let Ok(cursor) = app.cursor_position() else {
                break;
            };
            let x = window_start.x + (cursor.x - cursor_start.x);
            let y = window_start.y + (cursor.y - cursor_start.y);
            let monitor = app
                .monitor_from_point(cursor.x, cursor.y)
                .ok()
                .flatten()
                .or_else(|| window.current_monitor().ok().flatten());
            let (x, y) = if let Some(m) = monitor {
                let scale = m.scale_factor();
                snap::snap_position(
                    x,
                    y,
                    window_start.w,
                    window_start.h,
                    work_area(&m),
                    SNAP_THRESHOLD * scale,
                    SNAP_MARGIN * scale,
                )
            } else {
                (x, y)
            };
            let _ = window.set_position(PhysicalPosition::new(x as i32, y as i32));
            std::thread::sleep(DRAG_TICK);
        }
    });
}

pub fn end_drag(app: &AppHandle) {
    let shell = app.state::<Shell>();
    shell.drag_generation.fetch_add(1, Ordering::SeqCst);
    if let Some(window) = overlay_window(app) {
        record_geometry(&window, shell.inner());
    }
}

/// Background watcher: while click-through is active in Strip/Capsule, keep
/// the window ignoring mouse events except when the cursor hovers the edge
/// zone, which temporarily regains interactivity (PROPOSAL §7.3).
pub fn spawn_click_through_watcher(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(WATCH_TICK);
        let Some(window) = overlay_window(&app) else {
            continue;
        };
        let shell = app.state::<Shell>();
        let shell = shell.inner();
        let active = shell.click_through.load(Ordering::Relaxed)
            && shell.mode().supports_click_through()
            && window.is_visible().unwrap_or(false);
        if !active {
            set_cursor_ignored(&window, shell, false);
            continue;
        }
        let Ok(cursor) = app.cursor_position() else {
            continue;
        };
        let Some(rect) = current_geometry(&window) else {
            continue;
        };
        let scale = window
            .current_monitor()
            .ok()
            .flatten()
            .map(|m| m.scale_factor())
            .unwrap_or(1.0);
        let zone = if shell.ignoring_cursor.load(Ordering::Relaxed) {
            EDGE_ZONE * scale
        } else {
            EDGE_ZONE_STICKY * scale
        };
        let inside = cursor.x >= rect.x
            && cursor.x <= rect.x + rect.w
            && cursor.y >= rect.y
            && cursor.y <= rect.y + rect.h;
        let near_edge = inside
            && ((cursor.x - rect.x).min(rect.x + rect.w - cursor.x) <= zone
                || (cursor.y - rect.y).min(rect.y + rect.h - cursor.y) <= zone);
        set_cursor_ignored(&window, shell, !near_edge);
    });
}

/// Background saver: flush the config at most twice a second when dirty.
pub fn spawn_config_saver(app: AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(SAVE_TICK);
        let shell = app.state::<Shell>();
        if shell.dirty.swap(false, Ordering::Relaxed) {
            shell.save_now();
        }
    });
}
