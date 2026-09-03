// KAIRO — Shared hex-color helpers
//
// Previously copy-pasted with three slightly divergent implementations
// (app.js's hexToRgb/hexOpacity, display.html's hexToRgb/hexOpacity, and
// service.js's hexA) — a fix to one (e.g. 3-digit hex support) silently
// didn't propagate to the others. This is the single canonical version,
// loaded before app.js/service.js/display.html's inline script.
'use strict';

function hexToRgb(hex) {
  const h = String(hex || '#000000').replace('#', '');
  const full = h.length === 3 ? h.split('').map(c => c + c).join('') : h;
  const n = parseInt(full, 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function hexOpacity(hex, opacity) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r},${g},${b},${((opacity ?? 100) / 100).toFixed(2)})`;
}

window.hexToRgb   = hexToRgb;
window.hexOpacity = hexOpacity;
window.hexA       = hexOpacity; // alias — service.js's existing call sites use this name
