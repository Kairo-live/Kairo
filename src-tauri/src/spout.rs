//! Native Spout sender for KAIRO (Windows only) — the Windows equivalent of
//! `syphon.rs`'s macOS sender: same-machine, zero-setup video sharing so any
//! compatible app (OBS's Spout plugin, vMix, Resolume, TouchDesigner, etc.)
//! can pick the source up directly — no capture bridge, no hidden window.
//!
//! Mirrors `syphon.rs`'s design (a single Mutex-guarded handle, the same
//! tiny-skia + cosmic-text render pipeline) but the transport itself is far
//! simpler: `spout2-rs`'s DirectX 11 backend (`Sender`) owns its own D3D11
//! device internally and accepts a plain CPU pixel buffer via
//! `send_image(&pixels, w, h)` — unlike Syphon's OpenGL/CGL path, there's no
//! context to create or GL function table to load here at all. Deliberately
//! built on that crate rather than a hand-rolled FFI binding to Spout's own
//! C++ interface (SpoutLibrary exports a C++ vtable, not flat C functions
//! the way libndi's are) — see Cargo.toml's own comment on this dependency
//! for why a hand-written binding was rejected.

#![cfg(target_os = "windows")]

use std::sync::{Arc, Mutex};

use cosmic_text::{Color as CtColor, FontSystem, SwashCache};
use tiny_skia::{Color as SkColor, Pixmap, Rect, Transform};

use spout2_rs::dx::Sender;

// Same fallback default as ndi.rs/syphon.rs — Output Looks' "add an output"
// flow asks for a real resolution up front, so this only matters when a
// caller passes 0/invalid values.
const DEFAULT_FRAME_W: u32 = 1280;
const DEFAULT_FRAME_H: u32 = 720;

pub struct SpoutHandle {
    sender: Option<Sender>,
    pixmap: Option<Pixmap>,
    // Spout's DirectX 11 backend defaults to B8G8R8A8_UNORM (BGRA) — tiny-skia
    // renders/blends in RGBA (draw_text's blending math assumes that byte
    // order), so this is a persistent scratch buffer we swap channels into
    // right before each send, rather than storing the canonical frame in
    // BGRA and complicating every draw call.
    bgra_scratch: Vec<u8>,
    font_system: Option<FontSystem>,
    swash_cache: Option<SwashCache>,
    // Same reasoning as SyphonHandle's own copy of these fields: each layer
    // (verse/media/timer) arrives via its own separate Tauri command call,
    // synchronously, with no shared loop state to close over — so "the
    // current value of every OTHER layer" has to live on the handle itself.
    latest_verse: String,
    latest_reference: String,
    latest_media: Option<image::RgbaImage>,
    latest_timer: String,
    frame_w: u32,
    frame_h: u32,
}

impl Default for SpoutHandle {
    fn default() -> Self {
        Self {
            sender: None,
            pixmap: None,
            bgra_scratch: Vec::new(),
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

// SAFETY: all access is serialized through the Mutex the handle is always
// wrapped in — same guarantee SyphonHandle's own Send impl relies on.
unsafe impl Send for SpoutHandle {}

pub fn is_spout_available() -> bool {
    // spout2-rs's DX backend creates its own D3D11 device on demand rather
    // than exposing a separate capability probe — a real availability check
    // would mean creating and immediately tearing down a throwaway sender,
    // which is wasted work for what's meant to be a cheap UI query. D3D11 is
    // part of Windows itself (not an optional runtime install the way NDI
    // Tools is), so unconditionally available is the correct answer here.
    true
}

/// `width`/`height`: this output's own configured resolution (0 or negative
/// falls back to DEFAULT_FRAME_W/H).
pub fn start(source_name: &str, width: u32, height: u32, shared: Arc<Mutex<SpoutHandle>>) -> Result<(), String> {
    let mut h = shared.lock().map_err(|e| e.to_string())?;
    if h.sender.is_some() {
        return Err("Spout already running".into());
    }
    h.frame_w = if width > 0 { width } else { DEFAULT_FRAME_W };
    h.frame_h = if height > 0 { height } else { DEFAULT_FRAME_H };
    let (frame_w, frame_h) = (h.frame_w, h.frame_h);

    h.pixmap = Some(Pixmap::new(frame_w, frame_h).ok_or("pixmap alloc failed")?);
    h.bgra_scratch = vec![0u8; (frame_w * frame_h * 4) as usize];
    h.font_system = Some(FontSystem::new());
    h.swash_cache = Some(SwashCache::new());

    let sender = Sender::new(source_name).map_err(|e| format!("Spout sender create failed: {e}"))?;
    h.sender = Some(sender);

    drop(h);
    update("Nothing on display", "", shared)?;

    eprintln!("[Spout] sender '{}' broadcasting {}x{}", source_name, frame_w, frame_h);
    Ok(())
}

pub fn stop(shared: Arc<Mutex<SpoutHandle>>) -> Result<(), String> {
    let mut h = shared.lock().map_err(|e| e.to_string())?;
    // Sender's own Drop impl releases the D3D11 sender/device — dropping the
    // Option is the whole teardown, same shape as free_native_resources in
    // syphon.rs, just with far less to free by hand.
    h.sender = None;
    h.pixmap = None;
    h.bgra_scratch.clear();
    h.font_system = None;
    h.swash_cache = None;
    h.latest_verse.clear();
    h.latest_reference.clear();
    h.latest_media = None;
    h.latest_timer.clear();
    Ok(())
}

pub fn update(verse: &str, reference: &str, shared: Arc<Mutex<SpoutHandle>>) -> Result<(), String> {
    let mut h = shared.lock().map_err(|e| e.to_string())?;
    if h.sender.is_none() { return Ok(()); } // not running — silent no-op
    h.latest_verse = verse.to_string();
    h.latest_reference = reference.to_string();
    render_and_publish(&mut h)
}

/// `bytes: None` clears the Media layer (mirrors ndi.rs/syphon.rs's own
/// `SetMedia`/`update_media` with `None`).
pub fn update_media(bytes: Option<Vec<u8>>, shared: Arc<Mutex<SpoutHandle>>) -> Result<(), String> {
    let mut h = shared.lock().map_err(|e| e.to_string())?;
    if h.sender.is_none() { return Ok(()); }
    h.latest_media = bytes.and_then(|b| match image::load_from_memory(&b) {
        Ok(img) => Some(img.to_rgba8()),
        Err(e) => { eprintln!("[Spout] Media decode failed: {e}"); None }
    });
    render_and_publish(&mut h)
}

pub fn update_timer(text: &str, shared: Arc<Mutex<SpoutHandle>>) -> Result<(), String> {
    let mut h = shared.lock().map_err(|e| e.to_string())?;
    if h.sender.is_none() { return Ok(()); }
    h.latest_timer = text.to_string();
    render_and_publish(&mut h)
}

/// Shared by update()/update_media()/update_timer() — always re-renders and
/// republishes all four current layers together, regardless of which single
/// layer the calling entry point just changed (see SpoutHandle's own field
/// comment for why the other layers' state has to live on the handle).
fn render_and_publish(h: &mut SpoutHandle) -> Result<(), String> {
    let (frame_w, frame_h) = (h.frame_w, h.frame_h);

    // Same split-borrow reasoning as syphon.rs's render_and_publish: project
    // through one plain `&mut SpoutHandle` first so the mutable pixmap
    // borrow and the immutable-at-this-point other fields don't fight.
    {
        let pixmap      = h.pixmap.as_mut().ok_or("pixmap missing")?;
        let font_system = h.font_system.as_mut().ok_or("font system missing")?;
        let swash_cache = h.swash_cache.as_mut().ok_or("swash cache missing")?;
        render_frame(pixmap, frame_w, frame_h, &h.latest_verse, &h.latest_reference, h.latest_media.as_ref(), &h.latest_timer, font_system, swash_cache);
    }

    // RGBA (tiny-skia's own byte order) → BGRA (Spout DX11's default
    // B8G8R8A8_UNORM) — swap R/B per pixel into the scratch buffer, same
    // shape as ndi.rs's own BGRA conversion for the exact same reason.
    {
        let pixmap = h.pixmap.as_ref().ok_or("pixmap missing")?;
        let src = pixmap.data();
        let dst = &mut h.bgra_scratch;
        for i in (0..src.len()).step_by(4) {
            dst[i]     = src[i + 2];
            dst[i + 1] = src[i + 1];
            dst[i + 2] = src[i];
            dst[i + 3] = src[i + 3];
        }
    }

    let sender = h.sender.as_mut().ok_or("sender missing")?;
    sender.send_image(&h.bgra_scratch, frame_w, frame_h)
        .map_err(|e| format!("Spout send_image failed: {e}"))
}

// ── Frame renderer ──────────────────────────────────────────────────────
// Identical visual style/logic to ndi.rs's and syphon.rs's own copies —
// duplicated rather than shared, matching those two files' own existing
// precedent (no common module between the native senders today).
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
    match media {
        Some(img) => blit_cover_image(pixmap, img),
        None => pixmap.fill(SkColor::from_rgba8(0, 0, 0, 230)),
    }

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
            CtColor::rgb(255, 145, 48),
            frame_w as f32 - badge_w - 8.0, 32.0,
            badge_w - 8.0,
        );
    }
}

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
