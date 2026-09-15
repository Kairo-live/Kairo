// Native NDI sender. Loads libndi at runtime via libloading so we don't have
// to bundle the NewTek SDK or deal with redistribution licensing — users
// install NDI Tools (free, ubiquitous in pro AV) and KAIRO finds the dylib
// at standard install paths.
//
// Frame rendering is done in pure Rust with tiny-skia + cosmic-text (+ the
// `image` crate for Media-layer photos): no webview capture, no platform-
// specific screen-capture APIs. A background thread re-renders only when
// something actually changed (verse/media/timer text) and pushes frames to
// NDI at a low cadence (NDI receivers tolerate any rate; we use 15fps for
// efficiency since this content doesn't need 60fps — see Output Looks'
// plan for why real video playback is a deliberately separate, later
// phase rather than bundled into this same change).

use std::ffi::{c_void, CString};
use std::os::raw::{c_char, c_int};
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use crossbeam_channel::{bounded, Sender};
use libloading::{Library, Symbol};

const FRAME_W: i32 = 1280;
const FRAME_H: i32 = 720;
const SEND_FPS_N: i32 = 15;     // Frame-rate numerator (15/1 = 15 fps)
const SEND_FPS_D: i32 = 1;
// FourCC for BGRA = ('B','G','R','A') little-endian = 0x41524742
const FOURCC_BGRA: u32 = 0x4152_4742;

// ── Minimal NDI C ABI ─────────────────────────────────────────────────────
// We only need the four functions to publish video. All struct field offsets
// must match libndi's headers exactly.

#[repr(C)]
struct NdiSendCreateT {
    p_ndi_name: *const c_char,
    p_groups:   *const c_char,
    clock_video: bool,
    clock_audio: bool,
}

#[repr(C)]
#[derive(Clone, Copy)]
#[allow(dead_code)]
enum NdiFrameFormat {
    Progressive = 1,
}

#[repr(C)]
struct NdiVideoFrameV2T {
    xres: c_int,
    yres: c_int,
    fourcc: u32,
    frame_rate_n: c_int,
    frame_rate_d: c_int,
    picture_aspect_ratio: f32,
    frame_format_type: c_int,    // NdiFrameFormat::Progressive = 1
    timecode: i64,
    p_data: *const u8,
    line_stride_in_bytes: c_int, // we use this when fourcc is uncompressed
    p_metadata: *const c_char,
    timestamp: i64,
}

type NdiInitializeFn      = unsafe extern "C" fn() -> bool;
type NdiDestroyFn         = unsafe extern "C" fn();
type NdiSendCreateFn      = unsafe extern "C" fn(*const NdiSendCreateT) -> *mut c_void;
type NdiSendDestroyFn     = unsafe extern "C" fn(*mut c_void);
type NdiSendSendVideoV2Fn = unsafe extern "C" fn(*mut c_void, *const NdiVideoFrameV2T);

struct LibNdi {
    _lib: Library,
    initialize:   unsafe extern "C" fn() -> bool,
    destroy:      unsafe extern "C" fn(),
    send_create:  unsafe extern "C" fn(*const NdiSendCreateT) -> *mut c_void,
    send_destroy: unsafe extern "C" fn(*mut c_void),
    send_video:   unsafe extern "C" fn(*mut c_void, *const NdiVideoFrameV2T),
}

impl LibNdi {
    /// Try every known NDI install location, return the first one that loads.
    fn try_load() -> Option<Self> {
        for path in candidate_libndi_paths() {
            if let Some(lib) = unsafe { Library::new(&path) }.ok() {
                if let Some(loaded) = Self::resolve_symbols(lib) {
                    eprintln!("[NDI] Loaded libndi from {}", path.display());
                    return Some(loaded);
                }
            }
        }
        None
    }

    fn resolve_symbols(lib: Library) -> Option<Self> {
        unsafe {
            let initialize:   Symbol<NdiInitializeFn>      = lib.get(b"NDIlib_initialize\0").ok()?;
            let destroy:      Symbol<NdiDestroyFn>         = lib.get(b"NDIlib_destroy\0").ok()?;
            let send_create:  Symbol<NdiSendCreateFn>      = lib.get(b"NDIlib_send_create\0").ok()?;
            let send_destroy: Symbol<NdiSendDestroyFn>     = lib.get(b"NDIlib_send_destroy\0").ok()?;
            let send_video:   Symbol<NdiSendSendVideoV2Fn> = lib.get(b"NDIlib_send_send_video_v2\0").ok()?;
            Some(LibNdi {
                initialize:   *initialize,
                destroy:      *destroy,
                send_create:  *send_create,
                send_destroy: *send_destroy,
                send_video:   *send_video,
                _lib: lib,
            })
        }
    }
}

/// Standard NDI install locations across platforms. We probe each one and use
/// the first dylib that successfully loads + resolves symbols.
fn candidate_libndi_paths() -> Vec<PathBuf> {
    let mut paths: Vec<PathBuf> = Vec::new();

    #[cfg(target_os = "macos")]
    {
        paths.push("/Library/NDI SDK for Apple/lib/macOS/libndi.dylib".into());
        paths.push("/Library/Application Support/NewTek/NDI Tools/Frameworks/libndi.dylib".into());
        paths.push("/Library/Application Support/NewTek/NDI Tools/NDI Tools.app/Contents/Frameworks/libndi.dylib".into());
        paths.push("/usr/local/lib/libndi.dylib".into());
        paths.push("/opt/homebrew/lib/libndi.dylib".into());
        // Bare name lets dlopen search DYLD_LIBRARY_PATH if user set it.
        paths.push("libndi.dylib".into());
    }
    #[cfg(target_os = "windows")]
    {
        // Default install path uses %ProgramFiles%\NDI\NDI 6 SDK\Bin\x64
        if let Ok(pf) = std::env::var("ProgramFiles") {
            paths.push(format!("{}\\NDI\\NDI 6 SDK\\Bin\\x64\\Processing.NDI.Lib.x64.dll", pf).into());
            paths.push(format!("{}\\NDI\\NDI 5 SDK\\Bin\\x64\\Processing.NDI.Lib.x64.dll", pf).into());
            paths.push(format!("{}\\NewTek\\NDI 6 Runtime\\v6\\Processing.NDI.Lib.x64.dll", pf).into());
            paths.push(format!("{}\\NewTek\\NDI 5 Runtime\\v5\\Processing.NDI.Lib.x64.dll", pf).into());
        }
        paths.push("Processing.NDI.Lib.x64.dll".into());
    }
    #[cfg(target_os = "linux")]
    {
        paths.push("/usr/share/NDI SDK for Linux/lib/x86_64-linux-gnu/libndi.so".into());
        paths.push("/usr/lib/x86_64-linux-gnu/libndi.so".into());
        paths.push("/usr/local/lib/libndi.so".into());
        paths.push("libndi.so".into());
    }
    paths
}

// ── Render-and-send worker ────────────────────────────────────────────────

#[derive(Clone, Debug)]
pub enum NdiCmd {
    SetText { verse: String, reference: String },
    // `None` clears the Media layer (matches display.html's renderMediaStage(null)
    // semantics — Output Looks toggling Media off for this output sends this).
    // Raw encoded bytes (png/jpeg), decoded once on the render thread itself
    // rather than on the caller's thread, so a slow decode never blocks the
    // Tauri command handler.
    SetMedia { bytes: Option<Vec<u8>> },
    SetTimer { text: String },
    Stop,
}

#[derive(Default)]
pub struct NdiHandle {
    tx: Option<Sender<NdiCmd>>,
    // Set while a start() call has been accepted but the background thread
    // hasn't reached the point of installing `tx` yet. Without this, two
    // near-simultaneous ndi_start calls could both see `tx.is_none()` and
    // both spawn a sender thread — the second overwrites `tx`, orphaning the
    // first thread with no way to stop it.
    starting: bool,
    // Join handle for the background sender thread — lets stop_and_join()
    // (used on app quit) actually wait for NDIlib_send_destroy/NDIlib_destroy
    // to run before the process exits, instead of firing NdiCmd::Stop and
    // hoping the thread gets to it in time.
    thread_handle: Option<thread::JoinHandle<()>>,
}

impl NdiHandle {
    pub fn update(&self, verse: String, reference: String) {
        if let Some(tx) = &self.tx {
            let _ = tx.send(NdiCmd::SetText { verse, reference });
        }
    }
    /// `bytes: None` clears the Media layer. A no-op (silently dropped, same
    /// as `update()` above) when the sender isn't running — Output Looks'
    /// client-side call sites already only invoke this when NDI is actually
    /// enabled, but this stays defensive rather than assuming that.
    pub fn update_media(&self, bytes: Option<Vec<u8>>) {
        if let Some(tx) = &self.tx {
            let _ = tx.send(NdiCmd::SetMedia { bytes });
        }
    }
    pub fn update_timer(&self, text: String) {
        if let Some(tx) = &self.tx {
            let _ = tx.send(NdiCmd::SetTimer { text });
        }
    }
    pub fn stop(&mut self) {
        self.starting = false;
        if let Some(tx) = self.tx.take() {
            let _ = tx.send(NdiCmd::Stop);
        }
    }
    /// Same as stop(), but also waits (up to `timeout`) for the background
    /// thread to actually finish — used on app quit so the native
    /// NDIlib_send_destroy/NDIlib_destroy calls run before the process exits
    /// rather than being merely requested. Never blocks past `timeout`: a
    /// native call that hangs shouldn't hang app shutdown right along with it.
    pub fn stop_and_join(&mut self, timeout: Duration) {
        self.stop();
        if let Some(handle) = self.thread_handle.take() {
            let start = std::time::Instant::now();
            while !handle.is_finished() && start.elapsed() < timeout {
                thread::sleep(Duration::from_millis(10));
            }
            if handle.is_finished() {
                let _ = handle.join();
            }
        }
    }
    pub fn is_running(&self) -> bool { self.starting || self.tx.is_some() }

    /// Atomically checks-and-reserves: returns true (and marks `starting`)
    /// only if nothing is currently running or already starting. The caller
    /// must hold the lock across this call for the reservation to actually
    /// close the race — see ndi_start in lib.rs.
    pub fn try_reserve_start(&mut self) -> bool {
        if self.is_running() { return false; }
        self.starting = true;
        true
    }

    /// Clears a reservation made by try_reserve_start without ever starting
    /// — used when the caller's start() attempt fails before reaching the
    /// point where it would install `tx` (e.g. libndi not found), so a retry
    /// isn't permanently blocked.
    pub fn clear_starting(&mut self) {
        self.starting = false;
    }
}

pub fn is_libndi_available() -> bool {
    LibNdi::try_load().is_some()
}

/// Start the NDI sender on a background thread. Returns Err if libndi can't
/// be loaded — the caller surfaces this to the UI as a friendly install hint.
pub fn start(source_name: &str, shared: Arc<Mutex<NdiHandle>>) -> Result<(), String> {
    let lib = LibNdi::try_load()
        .ok_or_else(|| "NDI runtime not found. Install NDI Tools from ndi.video/tools (free) and try again.".to_string())?;

    let (tx, rx) = bounded::<NdiCmd>(64);

    let name = source_name.to_string();
    let handle = thread::spawn(move || {
        unsafe {
            if !(lib.initialize)() {
                eprintln!("[NDI] NDIlib_initialize() returned false — aborting sender thread.");
                return;
            }

            let cname = match CString::new(name.as_str()) {
                Ok(c) => c,
                Err(_) => CString::new("KAIRO Scripture").unwrap(),
            };
            let create = NdiSendCreateT {
                p_ndi_name: cname.as_ptr(),
                p_groups:   std::ptr::null(),
                clock_video: true,
                clock_audio: false,
            };
            let sender = (lib.send_create)(&create);
            if sender.is_null() {
                eprintln!("[NDI] send_create returned null — aborting.");
                (lib.destroy)();
                return;
            }
            eprintln!("[NDI] Sender '{}' created — broadcasting {}x{} @ {}fps", name, FRAME_W, FRAME_H, SEND_FPS_N);

            // Persistent BGRA buffer we re-render into.
            let mut buf: Vec<u8> = vec![0u8; (FRAME_W * FRAME_H * 4) as usize];
            let mut latest_verse = String::new();
            let mut latest_ref   = String::new();
            let mut latest_timer = String::new();
            // Decoded once when SetMedia arrives (not per frame) — decoding a
            // real 2-15MB photo every 15fps tick would be wasted work for
            // content that only changes when the operator actually changes
            // slides. `None` = no Media-layer content active right now.
            let mut latest_media: Option<image::RgbaImage> = None;
            // FontSystem::new() scans and loads every system font — tens to
            // hundreds of ms. Created once here rather than per render_frame
            // call, since that used to happen on every verse update and added
            // directly to seconds-to-screen latency.
            use cosmic_text::{FontSystem, SwashCache};
            let mut font_system = FontSystem::new();
            let mut swash_cache = SwashCache::new();
            // Render initial empty/idle frame
            render_frame(&mut buf, &latest_verse, &latest_ref, latest_media.as_ref(), &latest_timer, &mut font_system, &mut swash_cache);

            let frame_period = Duration::from_millis(1000 / SEND_FPS_N as u64);
            loop {
                // Drain pending commands (latest update wins; stop terminates).
                let mut should_stop = false;
                let mut got_update  = false;
                while let Ok(cmd) = rx.try_recv() {
                    match cmd {
                        NdiCmd::Stop => { should_stop = true; break; }
                        NdiCmd::SetText { verse, reference } => {
                            latest_verse = verse;
                            latest_ref   = reference;
                            got_update   = true;
                        }
                        NdiCmd::SetMedia { bytes } => {
                            latest_media = bytes.and_then(|b| {
                                match image::load_from_memory(&b) {
                                    Ok(img) => Some(img.to_rgba8()),
                                    Err(e) => {
                                        eprintln!("[NDI] Media decode failed: {e}");
                                        None
                                    }
                                }
                            });
                            got_update = true;
                        }
                        NdiCmd::SetTimer { text } => {
                            latest_timer = text;
                            got_update   = true;
                        }
                    }
                }
                if should_stop { break; }
                if got_update {
                    render_frame(&mut buf, &latest_verse, &latest_ref, latest_media.as_ref(), &latest_timer, &mut font_system, &mut swash_cache);
                }

                // Send the current frame.
                let frame = NdiVideoFrameV2T {
                    xres: FRAME_W,
                    yres: FRAME_H,
                    fourcc: FOURCC_BGRA,
                    frame_rate_n: SEND_FPS_N,
                    frame_rate_d: SEND_FPS_D,
                    picture_aspect_ratio: FRAME_W as f32 / FRAME_H as f32,
                    frame_format_type: 1, // progressive
                    timecode: i64::MIN,    // NDI_SEND_TIMECODE_SYNTHESIZE
                    p_data: buf.as_ptr(),
                    line_stride_in_bytes: FRAME_W * 4,
                    p_metadata: std::ptr::null(),
                    timestamp: 0,
                };
                (lib.send_video)(sender, &frame);

                thread::sleep(frame_period);
            }

            eprintln!("[NDI] Stopping sender '{}'", name);
            (lib.send_destroy)(sender);
            (lib.destroy)();
        }
    });

    if let Ok(mut g) = shared.lock() {
        if g.starting {
            // Still the same start attempt that was reserved — install the
            // sender and mark it running.
            g.tx = Some(tx);
            g.thread_handle = Some(handle);
            g.starting = false;
        } else {
            // ndi_stop() ran concurrently while we were loading libndi and
            // spawning the thread above (try_load + thread::spawn happen
            // without holding the lock) — stop() found `tx` still None at
            // that point, so it had nothing to signal and just reset
            // `starting`. Left alone, we'd now install `tx` anyway and the
            // thread we just spawned would broadcast indefinitely with no
            // way left to reach it. Cancel it directly via our own local
            // `tx` instead of ever handing it to the shared handle.
            let _ = tx.send(NdiCmd::Stop);
        }
    } else {
        // Lock poisoned — same cancellation as above rather than leaking a
        // broadcasting thread nobody can reach through the shared handle.
        let _ = tx.send(NdiCmd::Stop);
    }
    Ok(())
}

// ── Frame renderer ────────────────────────────────────────────────────────
// Pure Rust 2D rendering with tiny-skia + cosmic-text. Black background,
// red brand accent on the reference, white verse below. Lower-third style.

fn render_frame(
    buf: &mut [u8],
    verse: &str,
    reference: &str,
    media: Option<&image::RgbaImage>,
    timer: &str,
    font_system: &mut cosmic_text::FontSystem,
    swash_cache: &mut cosmic_text::SwashCache,
) {
    use cosmic_text::Color as CtColor;
    use tiny_skia::{Color as SkColor, Pixmap, Rect, Transform};

    // Skia pixmap that aliases our shared buffer. We re-use the same allocation
    // every frame to avoid GC churn.
    let mut pixmap = Pixmap::new(FRAME_W as u32, FRAME_H as u32).unwrap();
    // Media layer is the base: a real photo/graphic fills the whole frame
    // (cover fit, same convention as display.html's default image `fit`)
    // when active, exactly like it would sit BEHIND the slide/timer layers
    // on a real display window. Falls back to the original plain black fill
    // when Media isn't active — zero visual change from before this feature.
    match media {
        Some(img) => blit_cover_image(&mut pixmap, img),
        None => pixmap.fill(SkColor::from_rgba8(0, 0, 0, 230)),
    }

    // A subtle bottom 38% darker band for lower-third feel — only when
    // there's actual verse/reference text to put on it; skip it over a bare
    // Media-only frame (nothing to letterbox) so a plain background image
    // shows completely clean.
    let band_h = (FRAME_H as f32 * 0.38) as f32;
    if !verse.is_empty() || !reference.is_empty() {
        let mut band_paint = tiny_skia::Paint::default();
        band_paint.set_color(SkColor::from_rgba8(10, 14, 20, if media.is_some() { 190 } else { 255 }));
        band_paint.anti_alias = false;
        let band = Rect::from_xywh(0.0, FRAME_H as f32 - band_h, FRAME_W as f32, band_h).unwrap();
        pixmap.fill_rect(band, &band_paint, Transform::identity(), None);
    }

    // Text: render with cosmic-text into the pixmap. We treat each glyph as
    // an alpha mask drawn with the layer's color. font_system/swash_cache are
    // owned by the caller (created once, not per frame — see the sender
    // thread setup above).

    // Reference — small, uppercase-style (caller should pass uppercase).
    if !reference.is_empty() {
        draw_text(
            &mut pixmap, font_system, swash_cache,
            reference,
            "sans-serif", 28.0, 700,
            CtColor::rgb(232, 64, 74), // brand red
            72.0, FRAME_H as f32 - band_h + 32.0,
            FRAME_W as f32 - 144.0,
        );
    }
    // Verse — larger, white.
    if !verse.is_empty() {
        draw_text_wrapped(
            &mut pixmap, font_system, swash_cache,
            verse,
            "sans-serif", 40.0, 500,
            CtColor::rgb(255, 255, 255),
            72.0, FRAME_H as f32 - band_h + 90.0,
            FRAME_W as f32 - 144.0,
        );
    }

    // Timer — top-right corner badge, independent of the verse/media layers
    // below it (matches display.html's own timer badge being a separate,
    // always-on-top overlay, not part of the slide layer it sits above).
    if !timer.is_empty() {
        let mut badge_paint = tiny_skia::Paint::default();
        badge_paint.set_color(SkColor::from_rgba8(10, 14, 20, 210));
        badge_paint.anti_alias = false;
        let badge_w = 150.0;
        let badge_h = 52.0;
        let badge = Rect::from_xywh(FRAME_W as f32 - badge_w - 24.0, 24.0, badge_w, badge_h).unwrap();
        pixmap.fill_rect(badge, &badge_paint, Transform::identity(), None);
        draw_text(
            &mut pixmap, font_system, swash_cache,
            timer,
            "sans-serif", 30.0, 700,
            CtColor::rgb(255, 145, 48), // brand orange
            FRAME_W as f32 - badge_w - 8.0, 32.0,
            badge_w - 8.0,
        );
    }

    // Skia stores RGBA premul; NDI BGRA expects byte-order B,G,R,A. Swap.
    // chunks_exact + zip over 4-byte pixels (rather than indexing scalar
    // r/g/b/a one at a time) gives the compiler a much better shot at
    // auto-vectorizing this per-frame pass.
    let src = pixmap.data();
    let n   = (FRAME_W * FRAME_H) as usize * 4;
    let copy_len = n.min(src.len()).min(buf.len());
    for (dst_px, src_px) in buf[..copy_len].chunks_exact_mut(4).zip(src[..copy_len].chunks_exact(4)) {
        dst_px[0] = src_px[2];
        dst_px[1] = src_px[1];
        dst_px[2] = src_px[0];
        dst_px[3] = src_px[3];
    }
    // Cover-fit a decoded image into the whole frame (scale to fill both
    // dimensions, crop the overflow, centered) — same "cover" convention
    // display.html's own image layers default to. Writes premultiplied RGBA
    // directly into the pixmap's base layer since this always runs first
    // (before the band/text draws), so there's nothing underneath yet to
    // blend against.
    fn blit_cover_image(pixmap: &mut tiny_skia::Pixmap, img: &image::RgbaImage) {
        let (iw, ih) = (img.width(), img.height());
        if iw == 0 || ih == 0 { return; }
        let scale = (FRAME_W as f32 / iw as f32).max(FRAME_H as f32 / ih as f32);
        let (sw, sh) = (
            (iw as f32 * scale).round().max(1.0) as u32,
            (ih as f32 * scale).round().max(1.0) as u32,
        );
        let resized = image::imageops::resize(img, sw, sh, image::imageops::FilterType::Triangle);
        let crop_x = (sw.saturating_sub(FRAME_W as u32)) / 2;
        let crop_y = (sh.saturating_sub(FRAME_H as u32)) / 2;
        let pw = pixmap.width();
        let data = pixmap.data_mut();
        for y in 0..(FRAME_H as u32).min(sh.saturating_sub(crop_y)) {
            for x in 0..(FRAME_W as u32).min(sw.saturating_sub(crop_x)) {
                let px = resized.get_pixel(x + crop_x, y + crop_y).0;
                let (r, g, b, a) = (px[0] as u16, px[1] as u16, px[2] as u16, px[3] as u16);
                // tiny-skia Pixmap data is premultiplied RGBA — straight-alpha
                // source values need premultiplying (a no-op when a == 255,
                // the overwhelming common case for a background image).
                let idx = ((y * pw + x) * 4) as usize;
                if idx + 3 >= data.len() { continue; }
                data[idx + 0] = (r * a / 255) as u8;
                data[idx + 1] = (g * a / 255) as u8;
                data[idx + 2] = (b * a / 255) as u8;
                data[idx + 3] = a as u8;
            }
        }
    }

    // Helpers for text drawing
    fn draw_text(
        pixmap: &mut tiny_skia::Pixmap,
        font_system: &mut cosmic_text::FontSystem,
        swash: &mut cosmic_text::SwashCache,
        text: &str,
        family: &str,
        size: f32,
        weight: u16,
        color: cosmic_text::Color,
        x: f32, y: f32, max_w: f32,
    ) {
        let metrics = cosmic_text::Metrics::new(size, size * 1.2);
        let mut buffer = cosmic_text::Buffer::new(font_system, metrics);
        let mut buffer_borrow = buffer.borrow_with(font_system);
        buffer_borrow.set_size(Some(max_w), None);
        let mut attrs = cosmic_text::Attrs::new()
            .family(cosmic_text::Family::Name(family))
            .weight(cosmic_text::Weight(weight));
        // SansSerif fallback if the named family isn't present
        attrs = attrs.family(cosmic_text::Family::SansSerif);
        buffer_borrow.set_text(text, attrs, cosmic_text::Shaping::Advanced);
        buffer_borrow.shape_until_scroll(true);
        rasterize_buffer(pixmap, font_system, swash, &buffer, x, y, color);
    }

    fn draw_text_wrapped(
        pixmap: &mut tiny_skia::Pixmap,
        font_system: &mut cosmic_text::FontSystem,
        swash: &mut cosmic_text::SwashCache,
        text: &str,
        family: &str,
        size: f32,
        weight: u16,
        color: cosmic_text::Color,
        x: f32, y: f32, max_w: f32,
    ) {
        // Same as draw_text but multi-line via cosmic-text's natural wrap.
        let metrics = cosmic_text::Metrics::new(size, size * 1.35);
        let mut buffer = cosmic_text::Buffer::new(font_system, metrics);
        let mut buffer_borrow = buffer.borrow_with(font_system);
        buffer_borrow.set_size(Some(max_w), None);
        let mut attrs = cosmic_text::Attrs::new()
            .family(cosmic_text::Family::Name(family))
            .weight(cosmic_text::Weight(weight));
        attrs = attrs.family(cosmic_text::Family::SansSerif);
        buffer_borrow.set_text(text, attrs, cosmic_text::Shaping::Advanced);
        buffer_borrow.shape_until_scroll(true);
        rasterize_buffer(pixmap, font_system, swash, &buffer, x, y, color);
    }

    fn rasterize_buffer(
        pixmap: &mut tiny_skia::Pixmap,
        font_system: &mut cosmic_text::FontSystem,
        swash: &mut cosmic_text::SwashCache,
        buffer: &cosmic_text::Buffer,
        ox: f32, oy: f32,
        color: cosmic_text::Color,
    ) {
        buffer.draw(font_system, swash, color, |gx, gy, _gw, _gh, c| {
            let px = (ox as i32) + gx;
            let py = (oy as i32) + gy;
            if px < 0 || py < 0 || px >= pixmap.width() as i32 || py >= pixmap.height() as i32 {
                return;
            }
            let alpha = c.a();
            if alpha == 0 { return; }
            let idx = ((py as u32) * pixmap.width() + px as u32) as usize * 4;
            let pixmap_data = pixmap.data_mut();
            // Premultiplied alpha blend src over dst (same convention skia uses)
            let src_r = c.r();
            let src_g = c.g();
            let src_b = c.b();
            let dst_r = pixmap_data[idx + 0];
            let dst_g = pixmap_data[idx + 1];
            let dst_b = pixmap_data[idx + 2];
            let dst_a = pixmap_data[idx + 3];
            let inv_a = 255 - alpha as u16;
            pixmap_data[idx + 0] = ((src_r as u16 * alpha as u16 + dst_r as u16 * inv_a) / 255) as u8;
            pixmap_data[idx + 1] = ((src_g as u16 * alpha as u16 + dst_g as u16 * inv_a) / 255) as u8;
            pixmap_data[idx + 2] = ((src_b as u16 * alpha as u16 + dst_b as u16 * inv_a) / 255) as u8;
            pixmap_data[idx + 3] = (alpha as u16 + (dst_a as u16 * inv_a) / 255).min(255) as u8;
        });
    }
}
