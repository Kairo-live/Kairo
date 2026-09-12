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
  const s = (raw || '').trim().toLowerCase().replace(/\s+/g, '');
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

window.isVideoLayerSrc   = isVideoLayerSrc;
window.applyShapeGeometry = applyShapeGeometry;
window.applyLayerOrder    = applyLayerOrder;
window.resolveFlexibleTime = resolveFlexibleTime;
window.outlineShadows     = outlineShadows;
