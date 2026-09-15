//! Native Syphon sender for KAIRO (macOS only).
//!
//! Publishes verse text frames to the Syphon network so any compatible app
//! (OBS Syphon plugin, ProPresenter, Resolume, MadMapper, etc.) can pick the
//! source up directly — no capture bridge, no hidden window.
//!
//! Mirrors the design of `ndi.rs`: a single Mutex-guarded handle owns the
//! Syphon server, the GL context, and the texture; commands serialize through
//! it. The framework itself is bundled at `Frameworks/Syphon.framework` and
//! linked at build time (see `build.rs`).

#![cfg(target_os = "macos")]
#![allow(non_upper_case_globals, non_snake_case)]

use std::ffi::CString;
use std::os::raw::{c_int, c_uint, c_void};
use std::sync::{Arc, Mutex, Once};

use objc2::encode::{Encode, Encoding, RefEncode};
use objc2::rc::Retained;
use objc2::runtime::{AnyClass, AnyObject, NSObject};
use objc2::{msg_send, sel};
use objc2_foundation::{NSDictionary, NSString};

use cosmic_text::{Color as CtColor, FontSystem, SwashCache};
use tiny_skia::{Color as SkColor, Pixmap, Rect, Transform};

// ── Frame size ──────────────────────────────────────────────────────────
// 1280×720 — same as the NDI sender, gives receivers a familiar dimension.
// Output Looks: resolution is now per-output-configurable (see SyphonHandle's
// own frame_w/frame_h fields) — these two are only the fallback default.
const DEFAULT_FRAME_W: u32 = 1280;
const DEFAULT_FRAME_H: u32 = 720;

// ── CGL bindings ────────────────────────────────────────────────────────
// We only need a tiny subset of CGL to spin up an offscreen OpenGL context
// the Syphon server can publish from. Declared inline rather than pulling
// in a CGL crate just for these five functions.
type CGLContextObj = *mut c_void;
type CGLPixelFormatObj = *mut c_void;
type CGLPixelFormatAttribute = c_uint;
type CGLError = c_int;

#[link(name = "OpenGL", kind = "framework")]
extern "C" {
    fn CGLChoosePixelFormat(
        attribs: *const CGLPixelFormatAttribute,
        pix: *mut CGLPixelFormatObj,
        npix: *mut c_int,
    ) -> CGLError;
    fn CGLCreateContext(
        pix: CGLPixelFormatObj,
        share: CGLContextObj,
        ctx: *mut CGLContextObj,
    ) -> CGLError;
    fn CGLSetCurrentContext(ctx: CGLContextObj) -> CGLError;
    fn CGLDestroyPixelFormat(pix: CGLPixelFormatObj) -> CGLError;
    fn CGLDestroyContext(ctx: CGLContextObj) -> CGLError;
}

const kCGLPFAAccelerated: CGLPixelFormatAttribute = 73;
const kCGLPFAOpenGLProfile: CGLPixelFormatAttribute = 99;
const kCGLOGLPVersion_Legacy: CGLPixelFormatAttribute = 0x1000;
const kCGLPFADoubleBuffer: CGLPixelFormatAttribute = 5;

// dlsym for loading GL function pointers — preferred over creating a real
// CGL context just to query addresses. OpenGL.framework's symbols are in
// the global symbol table so RTLD_DEFAULT (null handle) resolves them.
#[link(name = "c")]
extern "C" {
    fn dlsym(handle: *mut c_void, symbol: *const i8) -> *mut c_void;
}

// ── NS geometry types (need stable ABI for objc2 calls) ─────────────────
// On 64-bit macOS NSRect/NSPoint/NSSize are typedef'd to CGRect/CGPoint/CGSize.
// We declare Encode manually so msg_send! can pass them by value to ObjC.
#[repr(C)]
#[derive(Copy, Clone, Default)]
pub struct NSPoint { pub x: f64, pub y: f64 }
#[repr(C)]
#[derive(Copy, Clone, Default)]
pub struct NSSize  { pub width: f64, pub height: f64 }
#[repr(C)]
#[derive(Copy, Clone, Default)]
pub struct NSRect  { pub origin: NSPoint, pub size: NSSize }

unsafe impl Encode for NSPoint {
    const ENCODING: Encoding = Encoding::Struct("CGPoint", &[f64::ENCODING, f64::ENCODING]);
}
unsafe impl Encode for NSSize {
    const ENCODING: Encoding = Encoding::Struct("CGSize", &[f64::ENCODING, f64::ENCODING]);
}
unsafe impl Encode for NSRect {
    const ENCODING: Encoding = Encoding::Struct("CGRect", &[NSPoint::ENCODING, NSSize::ENCODING]);
}
unsafe impl RefEncode for NSPoint { const ENCODING_REF: Encoding = Encoding::Pointer(&Self::ENCODING); }
unsafe impl RefEncode for NSSize  { const ENCODING_REF: Encoding = Encoding::Pointer(&Self::ENCODING); }
unsafe impl RefEncode for NSRect  { const ENCODING_REF: Encoding = Encoding::Pointer(&Self::ENCODING); }

// ── Handle ──────────────────────────────────────────────────────────────
pub struct SyphonHandle {
    server: Option<Retained<NSObject>>, // SyphonOpenGLServer instance
    ctx: CGLContextObj,
    pix: CGLPixelFormatObj,
    tex_id: u32,
    pixmap: Option<Pixmap>,
    // FontSystem::new() scans and loads every system font (tens to hundreds
    // of ms) — created once in start() and reused across every update()
    // instead of per-frame, which used to add directly to seconds-to-screen
    // latency on every verse change.
    font_system: Option<FontSystem>,
    swash_cache: Option<SwashCache>,
    // Unlike ndi.rs's background-thread loop (which keeps these as plain
    // loop-local variables), each layer here arrives via its own separate
    // Tauri command call (update/update_media/update_timer), synchronously,
    // with no shared loop state to close over — so the "current value of
    // every OTHER layer" has to live on the handle itself, or e.g. calling
    // update_timer() alone would blank out whatever verse text was already
    // showing (render_frame always draws all layers together, every call).
    latest_verse: String,
    latest_reference: String,
    latest_media: Option<image::RgbaImage>,
    latest_timer: String,
    // This output's own configured resolution (Output Looks' "add an
    // output" flow asks for it) — set once in start(), read by every
    // render_and_publish() call after. DEFAULT_FRAME_W/H until start() runs.
    frame_w: u32,
    frame_h: u32,
}

impl Default for SyphonHandle {
    fn default() -> Self {
        Self {
            server: None,
            ctx: std::ptr::null_mut(),
            pix: std::ptr::null_mut(),
            tex_id: 0,
            pixmap: None,
            font_system: None,
            swash_cache: None,
            latest_verse: String::new(),
            latest_reference: String::new(),
            latest_media: None,
            latest_timer: String::new(),
            frame_w: DEFAULT_FRAME_W,
            frame_h: DEFAULT_FRAME_H,
        }
    }
}

// SAFETY: We serialize all access through Mutex; the underlying CGL context
// and SyphonServer object are usable from any thread as long as we don't
// overlap GL calls. The Mutex enforces that.
unsafe impl Send for SyphonHandle {}

// ── Public API ──────────────────────────────────────────────────────────
pub fn is_syphon_available() -> bool {
    // The framework is statically linked; if we got this far the linker
    // already resolved against it. Belt-and-suspenders: confirm the class
    // is reachable via the Obj-C runtime.
    AnyClass::get("SyphonOpenGLServer").is_some()
}

/// `width`/`height`: this output's own configured resolution (0 or negative
/// falls back to DEFAULT_FRAME_W/H).
pub fn start(source_name: &str, width: u32, height: u32, shared: Arc<Mutex<SyphonHandle>>) -> Result<(), String> {
    let mut h = shared.lock().map_err(|e| e.to_string())?;
    if h.server.is_some() {
        return Err("Syphon already running".into());
    }
    h.frame_w = if width > 0 { width } else { DEFAULT_FRAME_W };
    h.frame_h = if height > 0 { height } else { DEFAULT_FRAME_H };
    let (frame_w, frame_h) = (h.frame_w, h.frame_h);

    // 1. Create CGL context — accelerated, legacy GL profile, double-buffered.
    //    Legacy is enough for our 2D upload-and-publish flow and avoids the
    //    extra hoops Core Profile needs (VAOs, shaders) to draw a textured quad.
    let mut pix: CGLPixelFormatObj = std::ptr::null_mut();
    let mut npix: c_int = 0;
    let attrs: [CGLPixelFormatAttribute; 6] = [
        kCGLPFAAccelerated,
        kCGLPFAOpenGLProfile, kCGLOGLPVersion_Legacy,
        kCGLPFADoubleBuffer,
        0, 0, // null-terminated
    ];
    unsafe {
        let err = CGLChoosePixelFormat(attrs.as_ptr(), &mut pix, &mut npix);
        if err != 0 || pix.is_null() {
            return Err(format!("CGLChoosePixelFormat failed: {err}"));
        }
        let mut ctx: CGLContextObj = std::ptr::null_mut();
        let err = CGLCreateContext(pix, std::ptr::null_mut(), &mut ctx);
        if err != 0 || ctx.is_null() {
            CGLDestroyPixelFormat(pix);
            return Err(format!("CGLCreateContext failed: {err}"));
        }
        CGLSetCurrentContext(ctx);
        h.ctx = ctx;
        h.pix = pix;
    }

    // 2. Resolve GL function pointers once. Subsequent calls are no-ops.
    static GL_LOADED: Once = Once::new();
    GL_LOADED.call_once(|| unsafe {
        gl::load_with(|name| {
            let cs = CString::new(name).unwrap();
            dlsym(std::ptr::null_mut(), cs.as_ptr()) as *const _
        });
    });

    // 3. Create the texture Syphon will publish from. We re-upload pixels
    //    into it on every `update` instead of allocating per frame.
    unsafe {
        let mut tex: u32 = 0;
        gl::GenTextures(1, &mut tex);
        gl::BindTexture(gl::TEXTURE_2D, tex);
        gl::TexParameteri(gl::TEXTURE_2D, gl::TEXTURE_MIN_FILTER, gl::LINEAR as i32);
        gl::TexParameteri(gl::TEXTURE_2D, gl::TEXTURE_MAG_FILTER, gl::LINEAR as i32);
        gl::TexParameteri(gl::TEXTURE_2D, gl::TEXTURE_WRAP_S,    gl::CLAMP_TO_EDGE as i32);
        gl::TexParameteri(gl::TEXTURE_2D, gl::TEXTURE_WRAP_T,    gl::CLAMP_TO_EDGE as i32);
        gl::TexImage2D(
            gl::TEXTURE_2D, 0, gl::RGBA as i32,
            frame_w as i32, frame_h as i32, 0,
            gl::RGBA, gl::UNSIGNED_BYTE, std::ptr::null(),
        );
        h.tex_id = tex;
    }

    // 4. Allocate a reusable tiny-skia pixmap.
    h.pixmap = match Pixmap::new(frame_w, frame_h) {
        Some(p) => Some(p),
        None => {
            free_native_resources(&mut h);
            return Err("pixmap alloc failed".into());
        }
    };

    // 4b. FontSystem::new() scans and loads every system font — created once
    // here (not per-frame in render_frame, see update()) since that used to
    // add directly to seconds-to-screen latency on every verse change.
    h.font_system = Some(FontSystem::new());
    h.swash_cache = Some(SwashCache::new());

    // 5. Spin up SyphonOpenGLServer.
    // Every failure path below frees whatever native resources steps 1-4
    // already allocated (CGL context, pixel format, texture) — previously a
    // failure here returned early via `?` and leaked them.
    unsafe {
        let cls = match AnyClass::get("SyphonOpenGLServer") {
            Some(c) => c,
            None => {
                free_native_resources(&mut h);
                return Err("SyphonOpenGLServer class not found — is Syphon.framework linked?".into());
            }
        };
        let name = NSString::from_str(source_name);
        let alloc: *mut AnyObject = msg_send![cls, alloc];
        let server: *mut AnyObject = msg_send![
            alloc,
            initWithName: &*name,
            context: h.ctx,
            options: std::ptr::null::<NSDictionary<NSString, AnyObject>>(),
        ];
        if server.is_null() {
            free_native_resources(&mut h);
            return Err("SyphonOpenGLServer init returned nil".into());
        }
        h.server = match Retained::from_raw(server.cast::<NSObject>()) {
            Some(s) => Some(s),
            None => {
                free_native_resources(&mut h);
                return Err("Retained::from_raw failed".into());
            }
        };
    }

    // 6. Push an initial blank frame so receivers see something on connect.
    drop(h);
    update("Nothing on display", "", shared)?;

    eprintln!("[Syphon] server '{}' broadcasting {}x{}", source_name, frame_w, frame_h);
    Ok(())
}

/// Frees whatever native resources are currently held on `h` — safe to call
/// with any subset already unset/null, since each is checked before being
/// freed. Shared by stop() and by start()'s failure paths (a partial init
/// that failed partway through used to leak the CGL context/pixel format/
/// texture already allocated by earlier steps).
fn free_native_resources(h: &mut SyphonHandle) {
    if let Some(server) = h.server.take() {
        unsafe {
            let _: () = msg_send![&*server, stop];
        }
    }
    unsafe {
        if h.tex_id != 0 {
            gl::DeleteTextures(1, &h.tex_id);
            h.tex_id = 0;
        }
        if !h.ctx.is_null() {
            CGLSetCurrentContext(std::ptr::null_mut());
            CGLDestroyContext(h.ctx);
            h.ctx = std::ptr::null_mut();
        }
        if !h.pix.is_null() {
            CGLDestroyPixelFormat(h.pix);
            h.pix = std::ptr::null_mut();
        }
    }
    h.pixmap = None;
    h.font_system = None;
    h.swash_cache = None;
    h.latest_verse.clear();
    h.latest_reference.clear();
    h.latest_media = None;
    h.latest_timer.clear();
}

pub fn stop(shared: Arc<Mutex<SyphonHandle>>) -> Result<(), String> {
    let mut h = shared.lock().map_err(|e| e.to_string())?;
    free_native_resources(&mut h);
    Ok(())
}

pub fn update(verse: &str, reference: &str, shared: Arc<Mutex<SyphonHandle>>) -> Result<(), String> {
    let mut h = shared.lock().map_err(|e| e.to_string())?;
    if h.server.is_none() { return Ok(()); } // not running — silent no-op
    h.latest_verse = verse.to_string();
    h.latest_reference = reference.to_string();
    render_and_publish(&mut h)
}

/// `bytes: None` clears the Media layer (mirrors display.html's
/// renderMediaStage(null) / ndi.rs's `SetMedia { bytes: None }`).
pub fn update_media(bytes: Option<Vec<u8>>, shared: Arc<Mutex<SyphonHandle>>) -> Result<(), String> {
    let mut h = shared.lock().map_err(|e| e.to_string())?;
    if h.server.is_none() { return Ok(()); }
    h.latest_media = bytes.and_then(|b| match image::load_from_memory(&b) {
        Ok(img) => Some(img.to_rgba8()),
        Err(e) => { eprintln!("[Syphon] Media decode failed: {e}"); None }
    });
    render_and_publish(&mut h)
}

pub fn update_timer(text: &str, shared: Arc<Mutex<SyphonHandle>>) -> Result<(), String> {
    let mut h = shared.lock().map_err(|e| e.to_string())?;
    if h.server.is_none() { return Ok(()); }
    h.latest_timer = text.to_string();
    render_and_publish(&mut h)
}

/// Shared by update()/update_media()/update_timer() — always re-renders and
/// republishes ALL FOUR current layers together (verse/reference/media/timer
/// live on the handle itself, see its own field comment for why), regardless
/// of which single layer the calling entry point just changed.
fn render_and_publish(h: &mut SyphonHandle) -> Result<(), String> {
    // Snapshot scalar fields up front so we can split the borrow between the
    // mutable pixmap (rendering) and the immutable server reference (publish).
    let ctx    = h.ctx;
    let tex_id = h.tex_id;
    let (frame_w, frame_h) = (h.frame_w, h.frame_h);

    // Render via tiny-skia + cosmic-text (same look as ndi.rs). font_system/
    // swash_cache are created once in start() and reused here rather than
    // per-frame (see the SyphonHandle field comments).
    // Deref to a plain `&mut SyphonHandle` first — borrowing multiple Option
    // fields via repeated `h.field.as_mut()` calls directly on a MutexGuard
    // doesn't borrow-check as disjoint (each goes through DerefMut), but
    // field projections through one plain reference do.
    let pixels_ptr = {
        let pixmap      = h.pixmap.as_mut().ok_or("pixmap missing")?;
        let font_system = h.font_system.as_mut().ok_or("font system missing")?;
        let swash_cache = h.swash_cache.as_mut().ok_or("swash cache missing")?;
        render_frame(pixmap, frame_w, frame_h, &h.latest_verse, &h.latest_reference, h.latest_media.as_ref(), &h.latest_timer, font_system, swash_cache);
        pixmap.data().as_ptr()
    };

    unsafe {
        // Make our context current, push the bytes into the texture.
        CGLSetCurrentContext(ctx);
        gl::BindTexture(gl::TEXTURE_2D, tex_id);
        gl::TexSubImage2D(
            gl::TEXTURE_2D, 0, 0, 0,
            frame_w as i32, frame_h as i32,
            gl::RGBA, gl::UNSIGNED_BYTE,
            pixels_ptr as *const _,
        );
        gl::Flush();

        // Hand the texture to Syphon. Region == full texture; flipped=NO
        // because tiny-skia draws origin-top-left and that's what GL wants
        // when imageRegion matches textureDimensions exactly.
        let server = h.server.as_ref().unwrap();
        let region = NSRect {
            origin: NSPoint { x: 0.0, y: 0.0 },
            size: NSSize { width: frame_w as f64, height: frame_h as f64 },
        };
        let size = NSSize { width: frame_w as f64, height: frame_h as f64 };
        let _: () = msg_send![
            &**server,
            publishFrameTexture: tex_id,
            textureTarget: 0x0DE1u32, // GL_TEXTURE_2D
            imageRegion: region,
            textureDimensions: size,
            flipped: false,
        ];
    }
    Ok(())
}

// ── Frame renderer ──────────────────────────────────────────────────────
// Same visual style as the NDI sender: black background, lower-third band,
// red brand-colored reference, white verse text. Rendered fresh every
// `update`, but the pixmap allocation is reused.
fn render_frame(
    pixmap: &mut Pixmap,
    frame_w: u32,
    frame_h: u32,
    verse: &str,
    reference: &str,
    media: Option<&image::RgbaImage>,
    timer: &str,
    font_system: &mut FontSystem,
    swash_cache: &mut SwashCache,
) {
    // Media layer is the base (cover fit), same convention as display.html's
    // own image layers and ndi.rs's own copy of this same change — see its
    // comment for the full reasoning. Falls back to the original plain black
    // fill when Media isn't active.
    match media {
        Some(img) => blit_cover_image(pixmap, img),
        None => pixmap.fill(SkColor::from_rgba8(0, 0, 0, 230)),
    }

    // Subtle bottom 38% darker band — lower-third look. Only drawn when
    // there's verse/reference text to sit on; skipped for a bare Media-only
    // frame so a plain background image shows completely clean.
    let band_h = (frame_h as f32 * 0.38) as f32;
    if !verse.is_empty() || !reference.is_empty() {
        let mut band_paint = tiny_skia::Paint::default();
        band_paint.set_color(SkColor::from_rgba8(10, 14, 20, if media.is_some() { 190 } else { 255 }));
        band_paint.anti_alias = false;
        if let Some(band) = Rect::from_xywh(0.0, frame_h as f32 - band_h, frame_w as f32, band_h) {
            pixmap.fill_rect(band, &band_paint, Transform::identity(), None);
        }
    }

    if !reference.is_empty() {
        draw_text(
            pixmap, font_system, swash_cache,
            reference,
            28.0, 700,
            CtColor::rgb(232, 64, 74),
            72.0, frame_h as f32 - band_h + 32.0,
            frame_w as f32 - 144.0,
        );
    }
    if !verse.is_empty() {
        draw_text(
            pixmap, font_system, swash_cache,
            verse,
            40.0, 500,
            CtColor::rgb(255, 255, 255),
            72.0, frame_h as f32 - band_h + 90.0,
            frame_w as f32 - 144.0,
        );
    }

    // Timer — top-right corner badge, independent of the verse/media layers
    // (mirrors display.html's own always-on-top timer badge, and ndi.rs's
    // own copy of this same addition).
    if !timer.is_empty() {
        let mut badge_paint = tiny_skia::Paint::default();
        badge_paint.set_color(SkColor::from_rgba8(10, 14, 20, 210));
        badge_paint.anti_alias = false;
        let badge_w = 150.0;
        let badge_h = 52.0;
        if let Some(badge) = Rect::from_xywh(frame_w as f32 - badge_w - 24.0, 24.0, badge_w, badge_h) {
            pixmap.fill_rect(badge, &badge_paint, Transform::identity(), None);
        }
        draw_text(
            pixmap, font_system, swash_cache,
            timer,
            30.0, 700,
            CtColor::rgb(255, 145, 48), // brand orange
            frame_w as f32 - badge_w - 8.0, 32.0,
            badge_w - 8.0,
        );
    }
    // Note: Syphon publishes the texture as RGBA, and tiny-skia produces RGBA
    // premultiplied — receivers handle premul correctly. No byte swap needed
    // (unlike the NDI sender which uses BGRA).
}

// Cover-fit a decoded image into the whole frame — see ndi.rs's own copy of
// this exact function for the full reasoning (identical logic, duplicated
// rather than shared since these two files have no common module today).
// Reads the pixmap's OWN actual dimensions (already allocated at this
// output's real configured resolution) rather than a fixed frame-size const.
fn blit_cover_image(pixmap: &mut Pixmap, img: &image::RgbaImage) {
    let (pix_w, pix_h) = (pixmap.width(), pixmap.height());
    let (iw, ih) = (img.width(), img.height());
    if iw == 0 || ih == 0 { return; }
    let scale = (pix_w as f32 / iw as f32).max(pix_h as f32 / ih as f32);
    let (sw, sh) = (
        (iw as f32 * scale).round().max(1.0) as u32,
        (ih as f32 * scale).round().max(1.0) as u32,
    );
    let resized = image::imageops::resize(img, sw, sh, image::imageops::FilterType::Triangle);
    let crop_x = (sw.saturating_sub(pix_w)) / 2;
    let crop_y = (sh.saturating_sub(pix_h)) / 2;
    let pw = pixmap.width();
    let data = pixmap.data_mut();
    for y in 0..pix_h.min(sh.saturating_sub(crop_y)) {
        for x in 0..pix_w.min(sw.saturating_sub(crop_x)) {
            let px = resized.get_pixel(x + crop_x, y + crop_y).0;
            let (r, g, b, a) = (px[0] as u16, px[1] as u16, px[2] as u16, px[3] as u16);
            let idx = ((y * pw + x) * 4) as usize;
            if idx + 3 >= data.len() { continue; }
            data[idx + 0] = (r * a / 255) as u8;
            data[idx + 1] = (g * a / 255) as u8;
            data[idx + 2] = (b * a / 255) as u8;
            data[idx + 3] = a as u8;
        }
    }
}

fn draw_text(
    pixmap: &mut Pixmap,
    font_system: &mut FontSystem,
    swash_cache: &mut SwashCache,
    text: &str,
    size_px: f32,
    weight: u16,
    color: CtColor,
    x: f32, y: f32,
    max_w: f32,
) {
    use cosmic_text::{Attrs, Buffer, Family, Metrics, Shaping, Weight};

    let metrics = Metrics::new(size_px, size_px * 1.25);
    let mut buf = Buffer::new(font_system, metrics);
    buf.set_size(font_system, Some(max_w), Some(2_000.0));
    let attrs = Attrs::new().family(Family::SansSerif).weight(Weight(weight));
    buf.set_text(font_system, text, attrs, Shaping::Advanced);
    buf.shape_until_scroll(font_system, false);

    // Capture the pixmap's own real dimensions before the mutable borrow
    // below — same reasoning as blit_cover_image's own copy of this.
    let (pix_w, pix_h) = (pixmap.width(), pixmap.height());
    let pixels: &mut [u8] = pixmap.data_mut();
    let stride = (pix_w * 4) as usize;
    let r = color.r();
    let g = color.g();
    let b = color.b();

    buf.draw(font_system, swash_cache, color, |gx, gy, _w, _h, gc| {
        let px = (x as i32) + gx;
        let py = (y as i32) + gy;
        if px < 0 || py < 0 || px >= pix_w as i32 || py >= pix_h as i32 {
            return;
        }
        // Alpha blend the glyph onto the pixmap.
        let a = gc.a() as u32;
        if a == 0 { return; }
        let off = py as usize * stride + px as usize * 4;
        let dr = pixels[off    ] as u32;
        let dg = pixels[off + 1] as u32;
        let db = pixels[off + 2] as u32;
        let inv = 255 - a;
        pixels[off    ] = ((r as u32 * a + dr * inv) / 255) as u8;
        pixels[off + 1] = ((g as u32 * a + dg * inv) / 255) as u8;
        pixels[off + 2] = ((b as u32 * a + db * inv) / 255) as u8;
        pixels[off + 3] = 255;
    });
}

// silence unused-import warnings for `sel` if the macro path drifts
#[allow(dead_code)]
fn _keep_sel() { let _ = sel!(stop); }
