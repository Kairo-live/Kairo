// KAIRO — Shared layer-rendering helpers
//
// Previously copy-pasted byte-identically (apart from indentation) across
// app.js (Theme Studio's editing canvas), service.js (the operator's live
// preview/thumbnails), and display.html (the actual output window) — same
// problem color_utils.js already fixed for hexToRgb/hexOpacity: a fix to
// one copy silently didn't propagate to the others. Confirmed drift had
// already started (service.js's applyShapeGeometry omitted the .toFixed(1)
// rounding app.js's copy had). This is the single canonical version, loaded
// before app.js/service.js/display.html's inline script.
'use strict';

// A theme "image" layer's src is occasionally an actual video file — Theme
// Studio's file picker doesn't hard-block it (native OS dialogs don't
// strictly enforce accept="image/*") and drag-and-drop never respected
// that hint either. data: URIs carry their real MIME type; http(s)/blob
// URLs fall back to the file extension.
function isVideoLayerSrc(src) {
  if (!src) return false;
  if (/^data:video\//i.test(src)) return true;
  return /\.(mp4|webm|mov|m4v|ogv)(\?|#|$)/i.test(src);
}

// Shape rendering for free-canvas background/shape layers. `radius` is
// either a plain number (treated as a px scale factor, the editor
// canvas's and live-preview's own unit) or a function `(radius) => cssValue`
// for callers using a different unit system (display.html's output stage
// works in vh off its own DESIGN_H, not px, so it passes a closure instead).
function applyShapeGeometry(div, layer, radius) {
  const shape = layer.shape || 'rect';
  div.style.clipPath = '';
  if (shape === 'ellipse') {
    div.style.borderRadius = '50%';
  } else if (shape === 'pill') {
    div.style.borderRadius = '999px';
  } else if (shape === 'triangle') {
    div.style.borderRadius = '0';
    div.style.clipPath = 'polygon(50% 0%, 0% 100%, 100% 100%)';
  } else if (shape === 'diamond') {
    div.style.borderRadius = '0';
    div.style.clipPath = 'polygon(50% 0%, 100% 50%, 50% 100%, 0% 50%)';
  } else if (layer.radius) {
    div.style.borderRadius = typeof radius === 'function'
      ? radius(layer.radius)
      : (layer.radius * radius).toFixed(1) + 'px';
  }
}

// Reconciles a stored layer id order against the layers actually present —
// a layer deleted since the order was saved is simply skipped, and any
// layer not mentioned in `orderIds` (added after the order was last saved)
// keeps its original relative position, appended at the end.
function applyLayerOrder(layers, orderIds) {
  if (!orderIds || !orderIds.length) return layers;
  const byId = new Map(layers.map(l => [l.id, l]));
  const ordered = [];
  orderIds.forEach(id => {
    const l = byId.get(id);
    if (l) { ordered.push(l); byId.delete(id); }
  });
  layers.forEach(l => { if (byId.has(l.id)) ordered.push(l); });
  return ordered;
}

// Parses a loosely-typed clock-time string ("9", "930", "9:30", "9:30pm",
// "21:30") into a canonical "HH:MM" (24h). Returns null for anything it
// can't confidently resolve. A bare hour with no am/pm (e.g. "9:30") is
// disambiguated to whichever of the two 12h readings is soonest from now —
// the common case ("set the timer to end at 9:30") almost always means the
// next such time, not one that already passed twelve hours ago today.
function resolveFlexibleTime(raw) {
  // "9:30 a.m." (how some locales write it, and the editor shows it) reads
  // as "9:30am".
  const s = (raw || '').trim().toLowerCase().replace(/[\s.]+/g, '');
  const m = s.match(/^(\d{1,2}):?(\d{2})(am|pm)?$/);
  if (!m) return null;
  let h = parseInt(m[1], 10);
  const min = parseInt(m[2], 10);
  const ampm = m[3];
  if (min > 59) return null;
  const fmt = (hh) => `${String(hh).padStart(2, '0')}:${String(min).padStart(2, '0')}`;
  if (ampm) {
    if (h < 1 || h > 12) return null;
    if (ampm === 'pm' && h !== 12) h += 12;
    if (ampm === 'am' && h === 12) h = 0;
    return fmt(h);
  }
  if (h > 23) return null;
  if (h === 0 || h > 12) return fmt(h); // already unambiguous
  const now = new Date();
  const candidates = h === 12 ? [12, 0] : [h, h + 12];
  let best = null, bestDelta = Infinity;
  candidates.forEach(hh => {
    const d = new Date(now);
    d.setHours(hh, min, 0, 0);
    let delta = d.getTime() - now.getTime();
    if (delta < 0) delta += 24 * 60 * 60 * 1000; // that reading's already passed today — compare against tomorrow's instead
    if (delta < bestDelta) { bestDelta = delta; best = hh; }
  });
  return fmt(best);
}

// Simulates a text outline as a ring of sharp (0-blur) text-shadows instead
// of -webkit-text-stroke. Confirmed on real hardware: this WebKit build
// (macOS 27, a pre-release version) corrupts glyph rendering the moment
// -webkit-text-stroke is applied to bold/large text — fragments of the
// stroke's own triangulated outline bleed into the visible glyphs — even
// with NO text-shadow involved at all. A plain text-shadow (any blur, any
// count) renders perfectly clean on the same build, so this sidesteps the
// broken code path entirely rather than working around it. `steps` scales
// with width so a thicker outline still reads as a smooth ring rather than
// a visible octagon of dots.
function outlineShadows(width, color) {
  const steps = Math.max(8, Math.round(width * 6));
  const shadows = [];
  for (let i = 0; i < steps; i++) {
    const angle = (i / steps) * 2 * Math.PI;
    shadows.push(`${(Math.cos(angle) * width).toFixed(2)}px ${(Math.sin(angle) * width).toFixed(2)}px 0 ${color}`);
  }
  return shadows;
}

// A text layer with an accent colour shows "*word*" in that colour, without
// the asterisks — how a two-tone headline ("FIRST TIME / *WITH US?*") is
// written as one editable layer. Only when the layer has an accent colour
// and the text actually carries the markup; otherwise text renders as-is.
function hasAccentMarkup(text, color) {
  return !!color && typeof text === 'string' && /\*[^*\n]+\*/.test(text);
}
// One wrapping span: a text layer's box is a flex column, where loose runs of
// text and spans would each become a row of their own.
function accentHtml(text, color) {
  const esc = String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const safe = /^#[0-9a-f]{3,8}$/i.test(color || '') ? color : '#e3cf6c';
  return '<span class="kairo-rich" style="white-space:pre-line">'
    + esc.replace(/\*([^*\n]+)\*/g, (_, w) => `<span class="kairo-accent" style="color:${safe}">${w}</span>`)
    + '</span>';
}

// Photo treatments for image and image-cycle layers: black & white
// (layer.grayscale, 0-100) and a soft fade into whatever is behind it from
// one edge (layer.fade: { side: 'left'|'right'|'top'|'bottom', amount: 0-100,
// the share of the image the fade covers}) — the washed-back photo half of an
// announcement slide. The grayscale also goes in --km-filter, which the
// animations that animate `filter` (motion_graphics.js: Blur in, Pulse) keep
// in their own filter lists — an animated filter replaces the element's own
// for as long as it runs.
function applyImageLook(el, layer) {
  if (!el || !layer) return;
  const gs = Math.max(0, Math.min(100, Number(layer.grayscale) || 0));
  if (gs > 0) {
    el.style.filter = `grayscale(${gs}%)`;
    el.style.setProperty('--km-filter', `grayscale(${gs}%)`);
  }
  const f = layer.fade;
  const dir = f && { left: 'to right', right: 'to left', top: 'to bottom', bottom: 'to top' }[f.side];
  const amount = Math.max(0, Math.min(100, Number(f && f.amount) || 0));
  if (dir && amount > 0) {
    const mask = `linear-gradient(${dir}, rgba(0,0,0,0) 0%, #000 ${amount}%)`;
    el.style.webkitMaskImage = mask;
    el.style.maskImage = mask;
  }
}

// A background layer (the canvas fill or a shape) can be filled with a
// picture: one of the bundled backgrounds (src 'backgrounds/<id>.jpg', listed
// in backgrounds/backgrounds.js) or the operator's own. `dim` (0-90) darkens
// it so white text stays legible; `color` shows while it loads. Small renders
// (theme cards, slide lists) take the bundled picture's thumbnail — WebKit
// decodes an image at full size however small it's drawn.
function imageFillCss(layer, opts = {}) {
  let src = String(layer.src || '');
  if (opts.small) src = src.replace(/^backgrounds\/([\w-]+)\.jpg$/, 'backgrounds/thumbs/$1.jpg');
  const url = 'url("' + src.replace(/["\\\n\r]/g, c => encodeURIComponent(c)) + '")';
  const dim = Math.max(0, Math.min(90, Number(layer.dim) || 0)) / 100;
  const shade = dim > 0 ? `linear-gradient(rgba(0,0,0,${dim}), rgba(0,0,0,${dim})), ` : '';
  const base = /^#[0-9a-f]{3,8}$/i.test(layer.color || '') ? layer.color : '#000';
  return `${shade}${url} center / cover no-repeat ${base}`;
}

// A slide's own values for some of a layer's settings (Full-scale edit stores
// them per slide, by layer id — app_theme_studio.js's diffLayerOverride),
// merged over its theme's, so the output and previews paint what the editor
// shows. null means the slide took the setting away (no build-in, say).
// FILL_OVERRIDE_KEYS: a background layer's fill. LAYER_OVERRIDE_KEYS: any
// layer's rotation, accent colour, photo look and blend mode. (Build-in and idle motion
// travel the same way — see animOverride.)
const FILL_OVERRIDE_KEYS = ['fill', 'color', 'color2', 'angle', 'opacity', 'src', 'dim'];
const LAYER_OVERRIDE_KEYS = ['rotation', 'accentColor', 'grayscale', 'fade', 'blendMode'];
function withLayerOverride(layer, ov, keys = LAYER_OVERRIDE_KEYS) {
  if (!ov) return layer;
  let out = layer;
  keys.forEach(k => {
    if (ov[k] === undefined || ov[k] === layer[k]) return;
    if (out === layer) out = { ...layer };
    if (ov[k] === null) delete out[k]; else out[k] = ov[k];
  });
  return out;
}
function withFillOverride(layer, ov) { return withLayerOverride(layer, ov, FILL_OVERRIDE_KEYS); }
// A layer's build-in and idle motion, with the slide's own when it has one.
function animOverride(layer, ov) {
  const has = (k) => !!ov && ov[k] !== undefined;
  return { build: has('build') ? ov.build : layer.build, idle: has('idle') ? ov.idle : layer.idle };
}

// Photoshop's blend modes, grouped and ordered as Photoshop (and Compositor)
// list them — darkening, lightening, contrast, comparative, component — named
// as they and PSD files name them. Only the ones a browser draws (CSS
// mix-blend-mode); "Linear Dodge (Add)" is CSS's plus-lighter.
const BLEND_MODE_GROUPS = [
  [['Normal', 'normal']],
  [['Darken', 'darken'], ['Multiply', 'multiply'], ['Color Burn', 'color-burn']],
  [['Lighten', 'lighten'], ['Screen', 'screen'], ['Color Dodge', 'color-dodge'], ['Linear Dodge (Add)', 'plus-lighter']],
  [['Overlay', 'overlay'], ['Soft Light', 'soft-light'], ['Hard Light', 'hard-light']],
  [['Difference', 'difference'], ['Exclusion', 'exclusion']],
  [['Hue', 'hue'], ['Saturation', 'saturation'], ['Color', 'color'], ['Luminosity', 'luminosity']],
];
const BLEND_MODES = BLEND_MODE_GROUPS.flat().map(([name]) => name);
// Gives a layer's element its blend mode (the slide's own, when it has one).
// Every renderer calls it on each layer's top element; each isolates its
// slide, so layers blend with the slide under them and never with the page.
function applyBlendMode(el, layer, ov) {
  if (!el || el.nodeType !== 1) return;
  const mode = ov && ov.blendMode !== undefined ? ov.blendMode : layer && layer.blendMode;
  const css = (BLEND_MODE_GROUPS.flat().find(([name]) => name === mode) || [])[1];
  if (css && css !== 'normal') el.style.mixBlendMode = css;
}

window.BLEND_MODE_GROUPS = BLEND_MODE_GROUPS;
window.BLEND_MODES       = BLEND_MODES;
window.applyBlendMode    = applyBlendMode;
window.imageFillCss      = imageFillCss;
window.withFillOverride  = withFillOverride;
window.withLayerOverride = withLayerOverride;
window.animOverride      = animOverride;
window.FILL_OVERRIDE_KEYS = FILL_OVERRIDE_KEYS;
window.LAYER_OVERRIDE_KEYS = LAYER_OVERRIDE_KEYS;
window.hasAccentMarkup   = hasAccentMarkup;
window.accentHtml        = accentHtml;
window.applyImageLook    = applyImageLook;
window.isVideoLayerSrc   = isVideoLayerSrc;
window.applyShapeGeometry = applyShapeGeometry;
window.applyLayerOrder    = applyLayerOrder;
window.resolveFlexibleTime = resolveFlexibleTime;
window.outlineShadows     = outlineShadows;
