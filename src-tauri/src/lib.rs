// KAIRO — Tauri shell
// Spawns the bundled Node.js binary running server/server.js.
// Dev mode: uses system node (beforeDevCommand starts it externally).
// Production: uses the node binary bundled via externalBin.

mod ndi;
#[cfg(target_os = "macos")]
mod syphon;
mod fonts;

use std::process::{Child, Command};
use std::sync::{Arc, Mutex};
use base64::Engine;
use tauri::{AppHandle, Emitter, Manager, RunEvent};
use tauri::menu::{AboutMetadataBuilder, MenuBuilder, MenuItemBuilder, SubmenuBuilder};
use tauri_plugin_shell::ShellExt;
use tauri_plugin_updater::UpdaterExt;

// ── Native app menu ──────────────────────────────────────────────────────
// Previously just Tauri's bare default (File > Close Window and nothing
// else) — no Edit menu at all, which on macOS means Cmd+Z/Cmd+C/Cmd+V/
// Cmd+A don't reliably reach a WKWebView text field: those shortcuts are
// routed through the OS's Edit-menu-backed responder chain (`cut:`/`copy:`/
// `paste:`/`undo:`/`selectAll:` selectors), not just "whatever the browser
// does with the key combo" — an app with no Edit menu items wired to those
// selectors can silently drop them in some inputs. Everything menu-command-
// shaped (New Theme, Import, Export) is dispatched to the frontend as a
// plain window event rather than reimplemented in Rust — app.js already
// owns every one of those flows (file pickers, unsaved-state, toasts), so
// Rust's job here is just "tell the frontend which menu item fired".
fn build_app_menu(app: &AppHandle) -> tauri::Result<tauri::menu::Menu<tauri::Wry>> {
    let about_metadata = AboutMetadataBuilder::new()
        .name(Some("KAIRO"))
        .version(Some(env!("CARGO_PKG_VERSION")))
        .copyright(Some("© 2026 KAIRO"))
        .website(Some("https://github.com/Kairo-live/Kairo"))
        .website_label(Some("GitHub"))
        .build();

    // macOS's own app menu (titled with the app's real name automatically,
    // "KAIRO" here) — About/Services/Hide/Quit live here by OS convention,
    // not under File/Help the way Windows/Linux menus would put them.
    // Standard macOS placement (Preferences… right after About, Cmd+,) —
    // opens the same in-app Settings panel the toolbar gear icon does, via
    // the "menu-settings" window event (see the frontend listener in
    // app.js) rather than Rust knowing anything about that panel itself.
    let settings_item = MenuItemBuilder::with_id("menu-settings", "Settings…")
        .accelerator("CmdOrCtrl+,")
        .build(app)?;

    let app_menu = SubmenuBuilder::new(app, "KAIRO")
        .about(Some(about_metadata))
        .separator()
        .item(&settings_item)
        .separator()
        .services()
        .separator()
        .hide()
        .hide_others()
        .show_all()
        .separator()
        .quit()
        .build()?;

    let file_menu = SubmenuBuilder::new(app, "File")
        .text("menu-new-theme", "New Theme")
        .text("menu-import", "Import…")
        .text("menu-export-theme", "Export Current Theme")
        .separator()
        .close_window()
        .build()?;

    // Standard Cut/Copy/Paste/Select All/Undo/Redo — see the file-level
    // comment above for why this menu existing at all (not just its
    // contents) is the actual fix.
    let edit_menu = SubmenuBuilder::new(app, "Edit")
        .undo()
        .redo()
        .separator()
        .cut()
        .copy()
        .paste()
        .select_all()
        .build()?;

    let view_menu = SubmenuBuilder::new(app, "View")
        .fullscreen()
        .build()?;

    // Operator-facing live controls — everything here has an existing
    // toolbar button already wired up with the real logic (dedup, WS
    // broadcast, etc.); like File's New Theme/Import/Export above, Rust's
    // job is only to tell the frontend which one fired (see
    // initNativeMenuBridge in app.js), not to reimplement any of it.
    // Accelerators picked to avoid the Edit/Window menus' defaults above.
    let toggle_listening_item = MenuItemBuilder::with_id("menu-toggle-listening", "Start/Stop Listening")
        .accelerator("CmdOrCtrl+L")
        .build(app)?;
    let range_next_item = MenuItemBuilder::with_id("menu-range-next", "Next")
        .accelerator("CmdOrCtrl+Right")
        .build(app)?;
    let clear_slide_item = MenuItemBuilder::with_id("menu-clear-slide", "Clear Slide")
        .accelerator("CmdOrCtrl+K")
        .build(app)?;
    let clear_all_item = MenuItemBuilder::with_id("menu-clear-all", "Clear All")
        .accelerator("CmdOrCtrl+Shift+K")
        .build(app)?;

    let controls_menu = SubmenuBuilder::new(app, "Controls")
        .item(&toggle_listening_item)
        .separator()
        .item(&range_next_item)
        .text("menu-range-end", "End Range")
        .separator()
        .item(&clear_slide_item)
        .text("menu-clear-media", "Clear Media")
        // The timer/clock layer's own clear — added once the output grew
        // a third composited layer alongside slide/media (see the Timer
        // tab in service.js and server/segments.js).
        .text("menu-clear-timer", "Clear Timer")
        .item(&clear_all_item)
        .build()?;

    let window_menu = SubmenuBuilder::new(app, "Window")
        .minimize()
        .maximize_with_text("Zoom")
        .separator()
        .bring_all_to_front()
        .close_window()
        .build()?;

    let help_menu = SubmenuBuilder::new(app, "Help")
        .text("menu-learn-more", "KAIRO on GitHub")
        .text("menu-check-updates", "Check for Updates…")
        .build()?;

    MenuBuilder::new(app)
        .item(&app_menu)
        .item(&file_menu)
        .item(&edit_menu)
        .item(&view_menu)
        .item(&controls_menu)
        .item(&window_menu)
        .item(&help_menu)
        .build()
}

// Shared by both the startup background check and the on-demand "Check for
// Updates…" menu item. `announce_up_to_date` distinguishes them: the silent
// startup check should stay silent unless there's actually something to
// show, while a menu click is a direct request that deserves a response
// either way (a "Check for Updates" button that says nothing when there's
// nothing new reads as broken, not reassuring).
fn check_for_updates(app: AppHandle, announce_up_to_date: bool) {
    tauri::async_runtime::spawn(async move {
        match app.updater() {
            Ok(updater) => match updater.check().await {
                Ok(Some(update)) => {
                    println!("[KAIRO] Update available: {}", update.version);
                    let _ = app.emit(
                        "update-available",
                        serde_json::json!({
                            "version": update.version,
                            "notes":   update.body.unwrap_or_default(),
                        }),
                    );
                }
                Ok(None) => {
                    println!("[KAIRO] App is up to date.");
                    if announce_up_to_date {
                        let _ = app.emit("update-check-result", serde_json::json!({ "upToDate": true }));
                    }
                }
                Err(e) => {
                    eprintln!("[KAIRO] Update check error: {e}");
                    if announce_up_to_date {
                        let _ = app.emit("update-check-result", serde_json::json!({ "error": e.to_string() }));
                    }
                }
            },
            Err(e) => {
                eprintln!("[KAIRO] Updater unavailable: {e}");
                if announce_up_to_date {
                    let _ = app.emit("update-check-result", serde_json::json!({ "error": e.to_string() }));
                }
            }
        }
    });
}

struct ServerProcess(Arc<Mutex<Option<Child>>>);

/// Holds the dynamically-allocated server port and auth token. Generated once
/// at startup, passed to the Node sidecar via env vars, and surfaced to the
/// frontend via Tauri IPC. Allows the server to bind to an OS-assigned free
/// loopback port (no hardcoded 7777, no `kill -9` on collision) and requires
/// a shared secret on every HTTP/WS request to prevent other local processes
/// from controlling the live display.
struct ServerConfig {
    port:  u16,
    token: String,
}

/// Prefer the historical port 7777 (so `frontendDist` in tauri.conf.json keeps
/// working in the common case and the existing dev workflow is untouched). If
/// 7777 is already in use, fall back to an OS-assigned free port. The window
/// is then navigated to the actual URL after the server comes up — see the
/// post-health-check navigation step in `setup`.
///
/// The probe listener is dropped immediately; Node re-binds a moment later.
/// There is a tiny race window (~ms) but no other process is realistically
/// going to grab that exact port in between.
fn pick_free_port() -> u16 {
    // Dev builds never spawn their own Node sidecar (see the
    // `#[cfg(not(debug_assertions))]` gate around `start_server` in `run`
    // below) — the real, only server is the one `beforeDevCommand` already
    // started (`npm run server`, always port 7777) before this process even
    // launches. That means the 7777-probe below deterministically fails
    // every single dev run (the port is legitimately taken, by the server
    // this app is actually supposed to use), silently falling back to a
    // random port nothing is listening on — every consumer of this value
    // (the health-check poll, the post-splash `navigate()`, and the
    // `get_server_port`/`get_server_config` IPC commands the frontend and
    // the display window both rely on) would then all point at that dead
    // port instead of the real server. Concretely: the window would
    // navigate away from the correctly-loaded page to a connection that
    // refuses, the frontend's JS would never run, and the app would appear
    // to hang on the splash screen or show a blank window — indistinguishable
    // from "not running". Always use 7777 in dev; only probe/fall back to a
    // random free port in a release build, where this process's own sidecar
    // spawn (below) is what's actually claiming that port.
    #[cfg(debug_assertions)]
    {
        return 7777;
    }
    #[cfg(not(debug_assertions))]
    {
        if std::net::TcpListener::bind("127.0.0.1:7777").is_ok() {
            return 7777;
        }
        std::net::TcpListener::bind("127.0.0.1:0")
            .ok()
            .and_then(|l| l.local_addr().ok())
            .map(|a| a.port())
            .unwrap_or(7777)
    }
}

/// 32 bytes of OS entropy → URL-safe base64. ~43 chars, ~256 bits of entropy.
fn generate_auth_token() -> String {
    let mut bytes = [0u8; 32];
    if getrandom::getrandom(&mut bytes).is_err() {
        // Fallback: never happens on supported platforms, but if the OS RNG
        // is unavailable we'd rather start with a weak token than refuse to boot.
        let nanos = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_nanos())
            .unwrap_or(0);
        for (i, b) in bytes.iter_mut().enumerate() {
            *b = ((nanos >> (i % 16)) as u8) ^ (i as u8);
        }
    }
    base64::engine::general_purpose::URL_SAFE_NO_PAD.encode(bytes)
}

#[cfg(target_os = "macos")]
struct SyphonState(Arc<Mutex<syphon::SyphonHandle>>);

/// Shared NDI sender state. The frontend manipulates this through the
/// ndi_* Tauri commands; the actual sender thread runs inside the ndi module.
struct NdiState(Arc<Mutex<ndi::NdiHandle>>);

// ── Node.js binary resolution ─────────────────────────────────────────────

/// In dev, search common system paths for Node.js.
fn find_system_node() -> Option<std::path::PathBuf> {
    let candidates = [
        "node",
        "/usr/local/bin/node",
        "/opt/homebrew/bin/node",
        "/usr/bin/node",
        "/usr/local/bin/node",
    ];
    for c in &candidates {
        if Command::new(c).arg("--version").output().is_ok() {
            return Some(std::path::PathBuf::from(c));
        }
    }
    None
}

/// In production, Node is bundled alongside the app binary via externalBin.
#[allow(dead_code)]
/// Tauri strips the target-triple suffix at bundle time, so at runtime it's
/// just "node" (or "node.exe" on Windows) next to the main executable.
fn find_bundled_node() -> Option<std::path::PathBuf> {
    let exe_dir = std::env::current_exe().ok()?.parent()?.to_path_buf();

    #[cfg(target_os = "windows")]
    let name = "node.exe";
    #[cfg(not(target_os = "windows"))]
    let name = "node";

    let path = exe_dir.join(name);
    if path.exists() { Some(path) } else { None }
}

// ── Server launcher ───────────────────────────────────────────────────────

#[cfg_attr(debug_assertions, allow(dead_code))]
fn start_server(app: &AppHandle, port: u16, token: &str) -> Option<Child> {
    // Resolve Node.js binary
    #[cfg(debug_assertions)]
    let node_bin = find_system_node();

    #[cfg(not(debug_assertions))]
    let node_bin = find_bundled_node().or_else(|| find_system_node());

    let node_bin = match node_bin {
        Some(p) => p,
        None => {
            eprintln!("[KAIRO] ERROR: Node.js not found — cannot start server.");
            return None;
        }
    };

    // Resolve server.js. A packaging/permissions quirk (sandboxed install,
    // moved bundle) making resource_dir unavailable used to panic and kill
    // the whole process at launch — fall back to the same cwd-relative dev
    // path the bundled-vs-dev branches below already use instead.
    let cwd = || std::env::current_dir().unwrap_or_else(|_| std::path::PathBuf::from("."));
    let resource_dir = match app.path().resource_dir() {
        Ok(dir) => dir,
        Err(e) => {
            eprintln!("[KAIRO] WARNING: Tauri resource dir unavailable ({e}) — falling back to cwd-relative paths.");
            cwd()
        }
    };

    let server_js = {
        // Production: bundled at resource_dir/server/server.js
        let bundled = resource_dir.join("server").join("server.js");
        if bundled.exists() {
            bundled
        } else {
            // Dev: relative to project root
            cwd().join("server").join("server.js")
        }
    };

    // Database dir — bundled map.json lives at resource_dir/databases/bibles/
    let db_dir = {
        let bundled = resource_dir.join("databases").join("bibles");
        if bundled.exists() {
            bundled
        } else {
            // Dev: project root databases/bibles
            cwd().join("databases").join("bibles")
        }
    };

    println!("[KAIRO] node:       {}", node_bin.display());
    println!("[KAIRO] server.js:  {}", server_js.display());
    println!("[KAIRO] databases:  {}", db_dir.display());

    let working_dir = server_js.parent().unwrap().to_path_buf();

    // App-data dir — writable by the user; settings.json lives here in production.
    let app_data_dir = app
        .path()
        .app_data_dir()
        .unwrap_or_else(|_| std::env::temp_dir().join("kairo"));
    std::fs::create_dir_all(&app_data_dir).ok();

    match Command::new(&node_bin)
        .arg(&server_js)
        .current_dir(&working_dir)
        // Pass resource dir so server.js can resolve bundled database files
        .env("KAIRO_RESOURCE_DIR", resource_dir.to_str().unwrap_or(""))
        .env("KAIRO_DB_DIR", db_dir.to_str().unwrap_or(""))
        // Writable dir for settings.json (read-only bundle path won't work in production)
        .env("KAIRO_APP_DATA_DIR", app_data_dir.to_str().unwrap_or(""))
        // Dynamic port + shared-secret token. The Node server reads these and
        // binds to 127.0.0.1:<port>, rejecting any HTTP/WS request without
        // the matching token.
        .env("KAIRO_SERVER_PORT", port.to_string())
        .env("KAIRO_AUTH_TOKEN",  token)
        .spawn()
    {
        Ok(child) => {
            println!("[KAIRO] Server started (pid {})", child.id());
            Some(child)
        }
        Err(e) => {
            eprintln!("[KAIRO] Failed to start server: {}", e);
            None
        }
    }
}

// ── Tauri commands ────────────────────────────────────────────────────────

#[tauri::command]
fn get_server_port(state: tauri::State<'_, ServerConfig>) -> u16 {
    state.port
}

#[tauri::command]
fn get_server_token(state: tauri::State<'_, ServerConfig>) -> String {
    state.token.clone()
}

#[tauri::command]
fn get_server_config(state: tauri::State<'_, ServerConfig>) -> serde_json::Value {
    serde_json::json!({ "port": state.port, "token": state.token })
}

/// Real, OS-level connected-display enumeration for the External Display /
/// extra-output pickers. The frontend previously relied ENTIRELY on the
/// browser's Window Management API (`getScreenDetails()` / `screen.
/// isExtended`) to detect connected monitors — that API is Chromium-only;
/// WebKit (the engine behind Tauri's WKWebView on macOS) has never
/// implemented it, so `getScreenDetails` is simply `undefined` and
/// `isExtended` is unsupported too. On macOS this meant a newly connected
/// display was silently never detected — not a permission issue, not a
/// timing issue, the API the whole feature depended on doesn't exist in
/// this webview at all. Tauri's own monitor APIs go through the OS
/// directly (winit → Cocoa NSScreen on macOS, Win32 on Windows), so they
/// work regardless of what the webview engine exposes to JS. Same field
/// shape the frontend's Window-Management-API path already produces
/// (index/width/height/left/top/isPrimary) so both paths are interchangeable.
// macOS's NSScreen (what tao's available_monitors() reads on this platform)
// only reflects a hotplugged display once the run loop has actually
// processed NSApplicationDidChangeScreenParametersNotification — a query
// issued off the main thread (which is where #[tauri::command] handlers
// run by default) can read a stale, cached screen count indefinitely, even
// polled repeatedly, even minutes after the display was connected. Real
// incident this caused: a genuinely connected second monitor never showed
// up no matter how often the frontend re-polled this command, because the
// polling itself was never the problem — every single call was reading
// the same stale off-main-thread snapshot. run_on_main_thread forces the
// actual query onto the thread where the run loop (and therefore NSScreen's
// notification-driven cache) is live.
#[tauri::command]
fn list_monitors(app: AppHandle) -> Result<Vec<serde_json::Value>, String> {
    let (tx, rx) = std::sync::mpsc::channel();
    let app_for_thread = app.clone();
    app.run_on_main_thread(move || {
        let result = (|| -> Result<Vec<serde_json::Value>, String> {
            let win = app_for_thread
                .get_webview_window("main")
                .ok_or_else(|| "main window not available".to_string())?;
            let monitors = win.available_monitors().map_err(|e| e.to_string())?;
            let primary_pos = win
                .primary_monitor()
                .ok()
                .flatten()
                .map(|m| *m.position());
            Ok(monitors
                .iter()
                .enumerate()
                .map(|(i, m)| {
                    let pos = m.position();
                    let size = m.size();
                    // available_monitors()/Monitor::size()/position() are PHYSICAL
                    // pixels — but WebviewWindowBuilder's x/y/width/height (what
                    // openDisplayOutput/openDisplayWindow feed straight from this
                    // command's output) are LOGICAL pixels. On any monitor with a
                    // scale factor != 1 (any Retina display), using physical values
                    // unconverted places the window at the wrong coordinates
                    // entirely — on a 3-monitor span this can easily land off
                    // every actual screen, so the window opens and content renders
                    // into it correctly, just somewhere nothing is ever watching.
                    // Real incident this caused: "I see the displays but nothing
                    // is sending" — detection was working and content WAS being
                    // pushed to the window, it was just invisible off-screen.
                    let scale = m.scale_factor();
                    let logical_size = size.to_logical::<i32>(scale);
                    let logical_pos  = pos.to_logical::<i32>(scale);
                    serde_json::json!({
                        "index": i,
                        "width": logical_size.width,
                        "height": logical_size.height,
                        "left": logical_pos.x,
                        "top": logical_pos.y,
                        "isPrimary": primary_pos.map(|p| p == *pos).unwrap_or(i == 0),
                    })
                })
                .collect())
        })();
        // Channel send failing just means the caller already gave up
        // waiting (e.g. dropped rx) — nothing to do about that here.
        let _ = tx.send(result);
    })
    .map_err(|e| e.to_string())?;
    rx.recv().map_err(|e| e.to_string())?
}

/// Called by the frontend once it has actually painted the real app (auth
/// token loaded, styles applied) — this is the signal to reveal the main
/// window. Showing the window immediately after dispatching `navigate()`
/// (the old approach) raced the new page's own load/paint: the window
/// could become visible while WebKit was still mid-navigation, showing its
/// default white document background before our dark CSS applied — a
/// visible white flash. Letting the frontend decide "ready" removes the
/// race entirely; see the health-check thread's fallback timer in `run()`
/// for what happens if this is never called (JS error, etc).
#[tauri::command]
fn signal_main_ready(app: AppHandle) {
    if let Some(win) = app.get_webview_window("main") {
        let _ = win.show();
        let _ = win.set_focus();
    }
}

/// Called from the frontend when the user clicks "Update & Restart".
/// Re-fetches the update (already confirmed available) and installs it.
#[tauri::command]
async fn install_update(app: AppHandle) -> Result<(), String> {
    let update = app
        .updater()
        .map_err(|e| e.to_string())?
        .check()
        .await
        .map_err(|e| e.to_string())?;

    if let Some(update) = update {
        update
            .download_and_install(|_chunk, _total| {}, || {})
            .await
            .map_err(|e| e.to_string())?;
        app.restart();
    }
    Ok(())
}

// ── NDI commands ──────────────────────────────────────────────────────────
// The frontend calls these to drive the native NDI sender. We don't bundle
// libndi; the user's NDI Tools install (or NDI SDK) provides it.

#[tauri::command]
fn ndi_available() -> bool {
    ndi::is_libndi_available()
}

#[tauri::command]
fn ndi_start(app: AppHandle, source_name: String) -> Result<(), String> {
    let state = app.state::<NdiState>();
    {
        // Check-and-reserve happens under one lock acquisition so two
        // near-simultaneous calls can't both pass the check before either's
        // background thread has actually installed its sender — see
        // try_reserve_start's doc comment.
        let mut h = state.0.lock().map_err(|e| e.to_string())?;
        if !h.try_reserve_start() {
            return Ok(()); // idempotent — already broadcasting or starting
        }
    }
    let result = ndi::start(&source_name, state.0.clone());
    if result.is_err() {
        // start() failed before ever reaching the point where it would clear
        // the reservation itself — clear it here so a retry isn't blocked.
        if let Ok(mut h) = state.0.lock() { h.clear_starting(); }
    }
    result
}

#[tauri::command]
fn ndi_stop(app: AppHandle) -> Result<(), String> {
    let state = app.state::<NdiState>();
    let mut h = state.0.lock().map_err(|e| e.to_string())?;
    h.stop();
    Ok(())
}

#[tauri::command]
fn ndi_update(app: AppHandle, verse: String, reference: String) -> Result<(), String> {
    let state = app.state::<NdiState>();
    let h = state.0.lock().map_err(|e| e.to_string())?;
    h.update(verse, reference);
    Ok(())
}

// ── Syphon commands (macOS only) ──────────────────────────────────────────
// Syphon.framework is bundled with the app, so unlike NDI there's no SDK to
// install. The framework requires a CGL context — the syphon module handles
// that internally.
#[cfg(target_os = "macos")]
#[tauri::command]
fn syphon_available() -> bool {
    syphon::is_syphon_available()
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn syphon_start(app: AppHandle, source_name: String) -> Result<(), String> {
    let state = app.state::<SyphonState>();
    syphon::start(&source_name, state.0.clone())
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn syphon_stop(app: AppHandle) -> Result<(), String> {
    let state = app.state::<SyphonState>();
    syphon::stop(state.0.clone())
}

#[cfg(target_os = "macos")]
#[tauri::command]
fn syphon_update(app: AppHandle, verse: String, reference: String) -> Result<(), String> {
    let state = app.state::<SyphonState>();
    syphon::update(&verse, &reference, state.0.clone())
}

// Stubs for non-macOS platforms — frontend calls these unconditionally and
// expects a clean `false` / no-op rather than an "unknown command" error.
#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn syphon_available() -> bool { false }
#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn syphon_start(_source_name: String) -> Result<(), String> {
    Err("Syphon is macOS-only".into())
}
#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn syphon_stop() -> Result<(), String> { Ok(()) }
#[cfg(not(target_os = "macos"))]
#[tauri::command]
fn syphon_update(_verse: String, _reference: String) -> Result<(), String> { Ok(()) }

// ── App entry ─────────────────────────────────────────────────────────────

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    // Allocate the server's port + auth token ONCE, up front, so the same
    // values are visible to the Node sidecar (via env) and to the frontend
    // (via the get_server_config IPC command).
    let server_config = ServerConfig {
        port:  pick_free_port(),
        token: generate_auth_token(),
    };
    println!("[KAIRO] Server will bind to 127.0.0.1:{}", server_config.port);

    let mut builder = tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        // "Paste from clipboard" imports (service.js's quickImportClipboard)
        // — see the Cargo.toml comment next to this dependency.
        .plugin(tauri_plugin_clipboard_manager::init())
        // See the Cargo.toml comment next to this dependency: only the
        // native right-click menu is suppressed, so the app's own
        // JS-based context menus (Timer/Slides/Songs/Media cards) are
        // what the operator actually sees on right-click, in dev builds
        // too — not just release builds where WRY's devtools menu never
        // gets compiled in to begin with.
        .plugin(
            tauri_plugin_prevent_default::Builder::new()
                .with_flags(tauri_plugin_prevent_default::Flags::CONTEXT_MENU)
                .build(),
        )
        .manage(ServerProcess(Arc::new(Mutex::new(None))))
        .manage(server_config)
        .manage(NdiState(Arc::new(Mutex::new(ndi::NdiHandle::default()))));

    #[cfg(target_os = "macos")]
    {
        builder = builder.manage(SyphonState(Arc::new(Mutex::new(syphon::SyphonHandle::default()))));
    }

    builder
        .invoke_handler(tauri::generate_handler![
            get_server_port,
            get_server_token,
            get_server_config,
            list_monitors,
            signal_main_ready,
            fonts::list_system_fonts,
            install_update,
            ndi_available,
            ndi_start,
            ndi_stop,
            ndi_update,
            syphon_available,
            syphon_start,
            syphon_stop,
            syphon_update,
        ])
        .menu(|handle| build_app_menu(handle))
        .on_menu_event(|app, event| {
            let id = event.id().as_ref();
            // Everything here just forwards to the frontend as a plain window
            // event — app.js already owns New Theme/Import/Export (file
            // pickers, unsaved-state handling, toasts) via their existing
            // toolbar buttons, so the menu should trigger the exact same
            // code path rather than a second, divergent implementation in
            // Rust. "Check for Updates…"/"Learn More" are the only two menu
            // items handled entirely natively, since neither has (or needs)
            // a frontend counterpart.
            match id {
                "menu-check-updates" => check_for_updates(app.clone(), true),
                "menu-learn-more" => { let _ = app.shell().open("https://github.com/Kairo-live/Kairo", None); }
                "menu-new-theme" | "menu-import" | "menu-export-theme" | "menu-settings"
                | "menu-toggle-listening" | "menu-range-next" | "menu-range-end"
                | "menu-clear-slide" | "menu-clear-media" | "menu-clear-timer" | "menu-clear-all" => {
                    let _ = app.emit(id, ());
                }
                _ => {}
            }
        })
        .setup(|app| {
            let handle = app.handle().clone();

            // Owner: "can we remove this splash?" — the dedicated splash
            // window (branded loading screen shown while the Node sidecar
            // boots, ~2-4s cold start) is gone. The main window already only
            // reveals itself once the frontend calls signal_main_ready() —
            // real paint confirmed, so no white-flash regression from that —
            // it just means there's a real few-second gap on a cold launch
            // where NOTHING is visible yet (no splash, no window) before the
            // main window appears. Accepted tradeoff per the owner's explicit
            // ask, not an oversight.

            // Start the bundled Node.js server.
            // In dev, the server is started by `beforeDevCommand` in tauri.conf.json
            // so we don't spawn a second one (which would collide on the same port).
            #[cfg(not(debug_assertions))]
            {
                let cfg = app.state::<ServerConfig>();
                let child = start_server(&handle, cfg.port, &cfg.token);
                // Recover rather than panic if the mutex was ever poisoned —
                // losing the child handle here would leak the Node sidecar
                // process on shutdown, which matters more than a clean panic.
                // Bound to its own `let` first — chaining straight off
                // `app.state::<ServerProcess>()` made the State a temporary
                // that got dropped at the end of the statement while the
                // MutexGuard borrowed from it was still in use (E0716); this
                // block only compiles in release builds (debug_assertions
                // off), so `cargo build` never caught it during dev.
                let server_process = app.state::<ServerProcess>();
                let mut guard = server_process.0.lock().unwrap_or_else(|p| p.into_inner());
                *guard = child;
            }
            #[cfg(debug_assertions)]
            {
                println!("[KAIRO] Dev mode — server started externally via beforeDevCommand.");
                let _ = &handle; // keep handle alive for use below
            }

            // Poll /health until the server responds, then show the main
            // window. Max wait: 20 seconds (40 × 500ms).
            let handle2 = handle.clone();
            let health_url = {
                let cfg = handle.state::<ServerConfig>();
                format!("http://127.0.0.1:{}/health", cfg.port)
            };
            std::thread::spawn(move || {
                let client = reqwest::blocking::Client::builder()
                    .timeout(std::time::Duration::from_secs(1))
                    .build()
                    .unwrap_or_default();

                let mut server_ready = false;
                for attempt in 0..40 {
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    // `/health` answers as soon as Express binds (~500ms), but the
                    // detection worker (map load, anchor trie, fingerprints) needs a
                    // couple more seconds. Wait for `workerBasicReady` to flip true
                    // so the user never lands on a half-initialised app.
                    if let Ok(resp) = client.get(&health_url).send() {
                        let body = resp.text().unwrap_or_default();
                        if body.contains("\"workerBasicReady\":true") {
                            println!("[KAIRO] Server + worker ready after ~{}ms", attempt * 500);
                            server_ready = true;
                            break;
                        }
                    }
                }
                if !server_ready {
                    eprintln!("[KAIRO] Server/worker not ready within 20s — showing main window anyway.");
                }

                // Navigate to the real server URL, but do NOT show the window
                // yet — showing it here raced the new page's own load/paint
                // (navigate() only dispatches the load; it doesn't wait for
                // it), so the window could become visible while WebKit was
                // still mid-navigation and briefly show its default white
                // background before our dark CSS applied. The frontend now
                // calls `signal_main_ready` once it has actually painted, and
                // THAT reveals the window instead. This fallback timer just
                // guarantees the window isn't stuck invisible forever if that
                // signal never arrives (JS error, non-Tauri edge case, etc).
                if let Some(win) = handle2.get_webview_window("main") {
                    // ALWAYS (re)navigate now that the server is confirmed up.
                    // The window auto-loads `frontendDist` (localhost:7777) at
                    // creation time — which is at app launch, BEFORE the Node
                    // sidecar is listening — so that first navigation fails
                    // (connection refused → blank page) and must be retried.
                    //
                    // We use the NATIVE `navigate()` (Rust → webview command)
                    // rather than `eval("location.replace(...)")`. After a
                    // failed initial load the page has no live JS context, so
                    // an in-page `eval` silently no-ops and leaves a white
                    // screen — exactly what happened on a cold /Applications
                    // launch where the server takes a few seconds to bind.
                    // `navigate()` reloads the webview regardless of its state.
                    let cfg = handle2.state::<ServerConfig>();
                    match format!("http://127.0.0.1:{}/", cfg.port).parse::<tauri::Url>() {
                        Ok(url) => { let _ = win.navigate(url); }
                        Err(e)  => eprintln!("[KAIRO] invalid frontend URL: {e}"),
                    }
                }
                let handle_fallback = handle2.clone();
                std::thread::spawn(move || {
                    std::thread::sleep(std::time::Duration::from_secs(12));
                    if let Some(win) = handle_fallback.get_webview_window("main") {
                        if !win.is_visible().unwrap_or(false) {
                            eprintln!("[KAIRO] Frontend never signalled ready within 12s — showing main window anyway.");
                            let _ = win.show();
                            let _ = win.set_focus();
                        }
                    }
                });

                // Check for updates in the background after the window is visible.
                // Only runs in release builds — updater endpoint won't resolve in dev.
                // Silent unless something's actually found (announce_up_to_date:
                // false) — unlike the menu's on-demand "Check for Updates…", a
                // background check the user didn't ask for shouldn't ever pop up
                // just to say "you're fine".
                #[cfg(not(debug_assertions))]
                {
                    let handle3 = handle2.clone();
                    tauri::async_runtime::spawn(async move {
                        // Small delay so the UI settles before we show a banner.
                        tokio::time::sleep(std::time::Duration::from_secs(5)).await;
                        check_for_updates(handle3, false);
                    });
                }
            });

            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("Error building KAIRO")
        .run(|app, event| {
            if matches!(event, RunEvent::Exit | RunEvent::ExitRequested { .. }) {
                // Recover from a poisoned mutex instead of panicking — this is
                // shutdown-time child-process cleanup; a panic here would
                // skip it entirely and leak the Node sidecar.
                if let Some(mut child) = app
                    .state::<ServerProcess>()
                    .0
                    .lock()
                    .unwrap_or_else(|p| p.into_inner())
                    .take()
                {
                    let _ = child.kill();
                    let _ = child.wait();
                    println!("[KAIRO] Server stopped.");
                }
                // NDI/Syphon hold native resources (CGL context, GL texture,
                // background sender thread) that were previously never
                // released on quit — only the Node child was cleaned up.
                // stop_and_join (not plain stop) actually waits for the
                // background thread's NDIlib_send_destroy/NDIlib_destroy to
                // run, bounded so a hung native call can't hang shutdown.
                app.state::<NdiState>().0.lock().unwrap_or_else(|p| p.into_inner())
                    .stop_and_join(std::time::Duration::from_millis(500));
                #[cfg(target_os = "macos")]
                {
                    let _ = syphon::stop(app.state::<SyphonState>().0.clone());
                }
            }
        });
}
