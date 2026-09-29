#!/usr/bin/env node
// Paints Kairo's bundled background pool (src/backgrounds/) — original, royalty-
// free abstract backgrounds for themes and slides: soft light, stage beams,
// bokeh, stars, paper. Each is drawn in linear light at 1920×1080 from a short
// recipe below, dithered so smooth gradients don't band on a projector, then
// written as PNG and converted to JPEG (and a 320×180 thumbnail) with macOS's
// own `sips`. The list the app shows lives in src/backgrounds/backgrounds.js,
// written from the same recipes.
//
//   node scripts/make-backgrounds.js            all of them
//   node scripts/make-backgrounds.js midnight   just one
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execFileSync } = require('child_process');

const OUT = path.join(__dirname, '..', 'src', 'backgrounds');
const W = 1920, H = 1080;

// ── Colour ─────────────────────────────────────────────────────────────────
const hex = (h) => { const n = parseInt(h.replace('#', ''), 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255].map(v => toLinear(v / 255)); };
const toLinear = (c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
const toSrgb = (c) => (c <= 0.0031308 ? c * 12.92 : 1.055 * Math.pow(c, 1 / 2.4) - 0.055);

// Seeded randomness, so a recipe always paints the same picture.
function rng(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6d2b79f5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

// ── Canvas ─────────────────────────────────────────────────────────────────
function canvas() { return new Float32Array(W * H * 3); }

// Linear gradient between two colours along `angle` (degrees, CSS-style).
function gradient(buf, c1, c2, angle = 180) {
  const a = hex(c1), b = hex(c2);
  const r = (angle - 90) * Math.PI / 180;
  const dx = Math.cos(r), dy = Math.sin(r);
  const half = (Math.abs(dx) * W + Math.abs(dy) * H) / 2;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const t = Math.min(1, Math.max(0, (((x - W / 2) * dx + (y - H / 2) * dy) / half + 1) / 2));
    const s = t * t * (3 - 2 * t);
    const i = (y * W + x) * 3;
    for (let k = 0; k < 3; k++) buf[i + k] = a[k] + (b[k] - a[k]) * s;
  }
}

// A soft Gaussian glow of light, added (screen-like) or mixed over.
function glow(buf, { x, y, r, color, amount = 1, sx = 1, sy = 1, mix = false }) {
  const c = hex(color);
  const cx = x * W, cy = y * H, rr = r * Math.max(W, H);
  const x0 = Math.max(0, Math.floor(cx - rr * 3 * sx)), x1 = Math.min(W, Math.ceil(cx + rr * 3 * sx));
  const y0 = Math.max(0, Math.floor(cy - rr * 3 * sy)), y1 = Math.min(H, Math.ceil(cy + rr * 3 * sy));
  for (let py = y0; py < y1; py++) for (let px = x0; px < x1; px++) {
    const dx = (px - cx) / (rr * sx), dy = (py - cy) / (rr * sy);
    const f = Math.exp(-(dx * dx + dy * dy)) * amount;
    if (f < 0.0005) continue;
    const i = (py * W + px) * 3;
    for (let k = 0; k < 3; k++) buf[i + k] = mix ? buf[i + k] + (c[k] - buf[i + k]) * Math.min(1, f) : buf[i + k] + c[k] * f;
  }
}

// Beams of light fanning down from a point above the frame.
function beams(buf, { x, y, count, spread, color, amount, seed }) {
  const c = hex(color), rand = rng(seed);
  const ox = x * W, oy = y * H;
  const list = Array.from({ length: count }, (_, i) => ({
    a: (-spread / 2 + (spread * (i + 0.5)) / count + (rand() - 0.5) * spread / count * 0.6) * Math.PI / 180,
    w: (0.8 + rand() * 1.4) * Math.PI / 180,
    k: 0.5 + rand() * 0.5,
  }));
  for (let py = 0; py < H; py++) for (let px = 0; px < W; px++) {
    const dx = px - ox, dy = py - oy;
    if (dy <= 0) continue;
    const ang = Math.atan2(dx, dy);
    const dist = Math.hypot(dx, dy) / H;
    let f = 0;
    for (const b of list) { const d = (ang - b.a) / b.w; f += Math.exp(-d * d) * b.k; }
    f *= amount * Math.exp(-dist * 0.9);
    if (f < 0.0005) continue;
    const i = (py * W + px) * 3;
    for (let k = 0; k < 3; k++) buf[i + k] += c[k] * f;
  }
}

// Out-of-focus lights: soft discs with a slightly brighter rim.
function bokeh(buf, { count, colors, rMin, rMax, amount, seed, band = [0, 1] }) {
  const rand = rng(seed);
  for (let n = 0; n < count; n++) {
    const c = hex(colors[n % colors.length]);
    const cx = rand() * W, cy = (band[0] + rand() * (band[1] - band[0])) * H;
    const r = (rMin + rand() * (rMax - rMin)) * H;
    const a = amount * (0.35 + rand() * 0.65);
    for (let py = Math.max(0, Math.floor(cy - r - 2)); py < Math.min(H, cy + r + 2); py++) {
      for (let px = Math.max(0, Math.floor(cx - r - 2)); px < Math.min(W, cx + r + 2); px++) {
        const d = Math.hypot(px - cx, py - cy) / r;
        if (d > 1.02) continue;
        const edge = Math.min(1, Math.max(0, (1.02 - d) / 0.06));
        const f = a * edge * (0.75 + 0.25 * Math.pow(d, 6));
        const i = (py * W + px) * 3;
        for (let k = 0; k < 3; k++) buf[i + k] += c[k] * f;
      }
    }
  }
}

// Stars: small sharp points of different brightness.
function stars(buf, { count, seed, amount = 1 }) {
  const rand = rng(seed);
  for (let n = 0; n < count; n++) {
    const cx = rand() * W, cy = rand() * H;
    const r = 0.6 + Math.pow(rand(), 6) * 2.4;
    const a = amount * (0.25 + Math.pow(rand(), 2) * 0.9);
    const tint = rand() < 0.3 ? [0.8, 0.85, 1] : rand() < 0.5 ? [1, 0.95, 0.85] : [1, 1, 1];
    for (let py = Math.max(0, Math.floor(cy - 4 * r)); py < Math.min(H, cy + 4 * r); py++) {
      for (let px = Math.max(0, Math.floor(cx - 4 * r)); px < Math.min(W, cx + 4 * r); px++) {
        const d = Math.hypot(px - cx, py - cy) / r;
        const f = a * Math.exp(-d * d * 1.6);
        const i = (py * W + px) * 3;
        for (let k = 0; k < 3; k++) buf[i + k] += tint[k] * f;
      }
    }
  }
}

// Low-frequency value noise, for paper and mist.
function valueNoise(seed, cell) {
  const rand = rng(seed);
  const gw = Math.ceil(W / cell) + 2, gh = Math.ceil(H / cell) + 2;
  const g = Float32Array.from({ length: gw * gh }, () => rand());
  return (x, y) => {
    const fx = x / cell, fy = y / cell, ix = Math.floor(fx), iy = Math.floor(fy);
    const tx = fx - ix, ty = fy - iy, sx = tx * tx * (3 - 2 * tx), sy = ty * ty * (3 - 2 * ty);
    const v = (i, j) => g[(iy + j) * gw + (ix + i)];
    return (v(0, 0) * (1 - sx) + v(1, 0) * sx) * (1 - sy) + (v(0, 1) * (1 - sx) + v(1, 1) * sx) * sy;
  };
}
function texture(buf, { seed, amount, cells = [220, 60, 14] }) {
  const layers = cells.map((c, i) => valueNoise(seed + i * 101, c));
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let n = 0;
    layers.forEach((f, i) => { n += (f(x, y) - 0.5) / (i + 1); });
    const m = 1 + n * amount;
    const i = (y * W + x) * 3;
    for (let k = 0; k < 3; k++) buf[i + k] *= m;
  }
}

function vignette(buf, amount) {
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const dx = (x / W - 0.5) * 1.1, dy = (y / H - 0.5) * 1.35;
    const m = 1 - amount * Math.min(1, Math.pow(dx * dx + dy * dy, 1.25) * 2.2);
    const i = (y * W + x) * 3;
    for (let k = 0; k < 3; k++) buf[i + k] *= m;
  }
}

// ── Output ─────────────────────────────────────────────────────────────────
// sRGB, 8-bit, with fine film grain + dither so dark gradients never band.
function toRgb8(buf, grain, seed) {
  const rand = rng(seed ^ 0x5eed);
  const out = Buffer.alloc(W * H * 3);
  for (let i = 0; i < W * H; i++) {
    const g = (rand() - 0.5) * grain;
    for (let k = 0; k < 3; k++) {
      const v = toSrgb(Math.max(0, Math.min(1, buf[i * 3 + k]))) * 255 + g * 255 + (rand() - 0.5);
      out[i * 3 + k] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }
  return out;
}

const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(buf) { let c = 0xffffffff; for (const b of buf) c = CRC[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; }
function chunk(type, data) {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type), data]);
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function png(rgb) {
  const raw = Buffer.alloc((W * 3 + 1) * H);
  for (let y = 0; y < H; y++) { raw[y * (W * 3 + 1)] = 0; rgb.copy(raw, y * (W * 3 + 1) + 1, y * W * 3, (y + 1) * W * 3); }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(W, 0); ihdr.writeUInt32BE(H, 4); ihdr[8] = 8; ihdr[9] = 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 6 })), chunk('IEND', Buffer.alloc(0))]);
}

// ── The pool ───────────────────────────────────────────────────────────────
// tone: which text reads on it — 'dark' backgrounds take light text.
const RECIPES = [
  { id: 'midnight', name: 'Midnight', tone: 'dark', tags: ['blue', 'soft light'], paint(b) {
    gradient(b, '#070a18', '#101a3a', 160);
    glow(b, { x: 0.18, y: 0.2, r: 0.32, color: '#3b5bdb', amount: 0.17 });
    glow(b, { x: 0.82, y: 0.78, r: 0.36, color: '#6741d9', amount: 0.14 });
    glow(b, { x: 0.55, y: 0.45, r: 0.22, color: '#1c7ed6', amount: 0.06 });
    vignette(b, 0.35);
  } },
  { id: 'aurora', name: 'Aurora', tone: 'dark', tags: ['teal', 'violet'], paint(b) {
    gradient(b, '#03070d', '#0a1420', 180);
    glow(b, { x: 0.3, y: 0.3, r: 0.3, sx: 2.2, sy: 0.6, color: '#12b886', amount: 0.2 });
    glow(b, { x: 0.64, y: 0.38, r: 0.28, sx: 2.4, sy: 0.55, color: '#7048e8', amount: 0.17 });
    glow(b, { x: 0.5, y: 0.22, r: 0.2, sx: 3, sy: 0.45, color: '#22b8cf', amount: 0.1 });
    vignette(b, 0.4);
  } },
  { id: 'teal-studio', name: 'Teal Studio', tone: 'dark', tags: ['teal', 'announcements'], paint(b) {
    gradient(b, '#1d3b3f', '#0b1e21', 160);
    glow(b, { x: 0.28, y: 0.12, r: 0.38, color: '#6aa3a8', amount: 0.22 });
    glow(b, { x: 0.8, y: 0.85, r: 0.3, color: '#0f3a40', amount: 0.3 });
    vignette(b, 0.3);
  } },
  { id: 'ember', name: 'Ember', tone: 'dark', tags: ['warm', 'amber'], paint(b) {
    gradient(b, '#0a0705', '#140b06', 180);
    glow(b, { x: 0.5, y: 1.08, r: 0.42, sx: 1.6, color: '#e8590c', amount: 0.14 });
    glow(b, { x: 0.25, y: 1.0, r: 0.24, color: '#f59f00', amount: 0.08 });
    glow(b, { x: 0.78, y: 0.96, r: 0.22, color: '#c2410c', amount: 0.09 });
    vignette(b, 0.35);
  } },
  { id: 'royal', name: 'Royal', tone: 'dark', tags: ['purple', 'magenta'], paint(b) {
    gradient(b, '#0e0618', '#1f0b2e', 150);
    glow(b, { x: 0.22, y: 0.3, r: 0.34, color: '#9c36b5', amount: 0.15 });
    glow(b, { x: 0.8, y: 0.7, r: 0.34, color: '#c2255c', amount: 0.11 });
    vignette(b, 0.35);
  } },
  { id: 'emerald', name: 'Emerald', tone: 'dark', tags: ['green'], paint(b) {
    gradient(b, '#03110b', '#082117', 165);
    glow(b, { x: 0.7, y: 0.25, r: 0.36, color: '#2b8a3e', amount: 0.24 });
    glow(b, { x: 0.2, y: 0.8, r: 0.3, color: '#0ca678', amount: 0.16 });
    vignette(b, 0.35);
  } },
  { id: 'crimson', name: 'Crimson', tone: 'dark', tags: ['red', 'velvet'], paint(b) {
    gradient(b, '#140306', '#2a0710', 170);
    glow(b, { x: 0.5, y: 0.35, r: 0.4, sx: 1.4, color: '#a51d2d', amount: 0.13 });
    glow(b, { x: 0.15, y: 0.9, r: 0.26, color: '#6b0f1a', amount: 0.3 });
    vignette(b, 0.45);
  } },
  { id: 'charcoal', name: 'Charcoal', tone: 'dark', tags: ['neutral', 'grey'], paint(b) {
    gradient(b, '#111214', '#1c1e22', 165);
    glow(b, { x: 0.3, y: 0.18, r: 0.4, color: '#868e96', amount: 0.1 });
    texture(b, { seed: 7, amount: 0.12 });
    vignette(b, 0.4);
  } },
  { id: 'stage', name: 'Stage Lights', tone: 'dark', tags: ['worship', 'beams'], paint(b) {
    gradient(b, '#07080c', '#12141c', 180);
    beams(b, { x: 0.5, y: -0.12, count: 9, spread: 70, color: '#dbe4ff', amount: 0.2, seed: 3 });
    glow(b, { x: 0.5, y: -0.05, r: 0.2, color: '#edf2ff', amount: 0.35 });
    glow(b, { x: 0.5, y: 1.1, r: 0.4, sx: 2, color: '#364fc7', amount: 0.14 });
    vignette(b, 0.35);
  } },
  { id: 'golden-bokeh', name: 'Golden Bokeh', tone: 'dark', tags: ['warm', 'bokeh'], paint(b) {
    gradient(b, '#0b0806', '#171009', 175);
    glow(b, { x: 0.5, y: 0.6, r: 0.4, sx: 1.6, color: '#7a4a12', amount: 0.14 });
    bokeh(b, { count: 34, colors: ['#ffd8a8', '#ffc078', '#fff3bf'], rMin: 0.015, rMax: 0.06, amount: 0.08, seed: 11, band: [0.1, 0.95] });
    vignette(b, 0.4);
  } },
  { id: 'starfield', name: 'Starfield', tone: 'dark', tags: ['night', 'stars'], paint(b) {
    gradient(b, '#02030a', '#070b1d', 180);
    glow(b, { x: 0.65, y: 0.35, r: 0.3, sx: 2, sy: 0.6, color: '#4c3d9b', amount: 0.12 });
    glow(b, { x: 0.35, y: 0.55, r: 0.24, sx: 1.8, sy: 0.5, color: '#1864ab', amount: 0.1 });
    stars(b, { count: 900, seed: 21, amount: 0.9 });
    vignette(b, 0.3);
  } },
  { id: 'ocean', name: 'Ocean', tone: 'dark', tags: ['blue', 'calm'], paint(b) {
    gradient(b, '#021120', '#041c31', 180);
    glow(b, { x: 0.35, y: -0.05, r: 0.4, sx: 1.8, color: '#1c7ed6', amount: 0.14 });
    glow(b, { x: 0.75, y: 1.05, r: 0.34, sx: 1.6, color: '#0b7285', amount: 0.12 });
    vignette(b, 0.4);
  } },
  { id: 'dawn', name: 'Dawn', tone: 'light', tags: ['pastel', 'sunrise'], paint(b) {
    gradient(b, '#fde2d4', '#d9d3f5', 160);
    glow(b, { x: 0.2, y: 0.85, r: 0.34, color: '#ffc9a9', amount: 0.35, mix: true });
    glow(b, { x: 0.85, y: 0.15, r: 0.3, color: '#cfd8ff', amount: 0.3, mix: true });
    glow(b, { x: 0.55, y: 0.5, r: 0.25, color: '#fff4e6', amount: 0.25, mix: true });
  } },
  { id: 'linen', name: 'Linen', tone: 'light', tags: ['paper', 'warm'], paint(b) {
    gradient(b, '#f4efe6', '#e9e1d3', 170);
    texture(b, { seed: 31, amount: 0.06, cells: [260, 40, 6] });
    glow(b, { x: 0.3, y: 0.2, r: 0.4, color: '#fffaf0', amount: 0.25, mix: true });
    vignette(b, 0.12);
  } },
  { id: 'mist', name: 'Mist', tone: 'light', tags: ['cool', 'grey-blue'], paint(b) {
    gradient(b, '#e7edf3', '#c9d6e3', 180);
    texture(b, { seed: 41, amount: 0.07, cells: [420, 160] });
    glow(b, { x: 0.5, y: 0.35, r: 0.4, sx: 1.8, color: '#f8fbff', amount: 0.35, mix: true });
    vignette(b, 0.1);
  } },
];

function main() {
  const only = process.argv[2];
  fs.mkdirSync(path.join(OUT, 'thumbs'), { recursive: true });
  const list = RECIPES.filter(r => !only || r.id === only);
  // Each picture's average colour — what a theme shows while it loads, and
  // the colour its layer keeps if the fill is switched back to Solid. A
  // partial run keeps the others' from the last full one.
  const colors = {};
  try { (require(path.join(OUT, 'backgrounds.js')) || []).forEach(e => { if (e.color) colors[e.id] = e.color; }); } catch {}
  for (const r of list) {
    const t0 = Date.now();
    const b = canvas();
    r.paint(b);
    const tmp = path.join(OUT, `${r.id}.png`);
    const rgb = toRgb8(b, r.tone === 'light' ? 0.012 : 0.018, r.id.length * 977);
    const sum = [0, 0, 0];
    for (let i = 0; i < rgb.length; i += 3) { sum[0] += rgb[i]; sum[1] += rgb[i + 1]; sum[2] += rgb[i + 2]; }
    colors[r.id] = '#' + sum.map(v => Math.round(v / (W * H)).toString(16).padStart(2, '0')).join('');
    fs.writeFileSync(tmp, png(rgb));
    const jpg = path.join(OUT, `${r.id}.jpg`);
    execFileSync('sips', ['-s', 'format', 'jpeg', '-s', 'formatOptions', '86', tmp, '--out', jpg], { stdio: 'ignore' });
    execFileSync('sips', ['-Z', '320', '-s', 'format', 'jpeg', '-s', 'formatOptions', '80', jpg, '--out', path.join(OUT, 'thumbs', `${r.id}.jpg`)], { stdio: 'ignore' });
    fs.unlinkSync(tmp);
    console.log(`${r.id}: ${(fs.statSync(jpg).size / 1024).toFixed(0)} KB in ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  }
  // The list the app reads.
  const entries = RECIPES.map(r => ({ id: r.id, name: r.name, tone: r.tone, tags: r.tags, color: colors[r.id],
    src: `backgrounds/${r.id}.jpg`, thumb: `backgrounds/thumbs/${r.id}.jpg` }));
  fs.writeFileSync(path.join(OUT, 'backgrounds.js'),
    `// KAIRO — the bundled background pool: original abstract backgrounds that ship\n`
    + `// with the app (src/backgrounds/), reusable by any theme or slide. Written by\n`
    + `// scripts/make-backgrounds.js — edit the recipes there and re-run it rather\n`
    + `// than editing this list by hand. tone: which text reads on it ('dark' takes\n`
    + `// light text); color: the picture's average colour.\n`
    + `(function (root) {\n  'use strict';\n  const BACKGROUNDS = ${JSON.stringify(entries, null, 2).replace(/\n/g, '\n  ')};\n`
    + `  root.KairoBackgrounds = BACKGROUNDS;\n  if (typeof module !== 'undefined' && module.exports) module.exports = BACKGROUNDS;\n`
    + `})(typeof globalThis !== 'undefined' ? globalThis : this);\n`);
}
main();
