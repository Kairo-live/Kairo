// KAIRO — motion graphics: animated layers for themes and timers.
//
// A 'motion' layer is drawn from shapes and CSS, not a video file, so every
// element of it stays editable in Theme Studio: its colours, how many there
// are, their size, speed, softness, direction. The layer itself is placed and
// sized like any other (pos, opacity, rotation).
//
//   { type: 'motion', pos, opacity, graphic: { kind, colors: [...], ...params, seed } }
//
// Two families:
//   ambient — Aurora, Bokeh, Light Rays, Waves, Sparkles, Gradient Flow, Pulse.
//             They loop on their own.
//   timer   — Progress Ring, Progress Bar, Seconds Dots. They follow the live
//             countdown: tick() runs on every stage-timer tick.
//
// Three render modes:
//   'live'  — the real output and the operator's Live Preview. Timer kinds wait
//             for ticks and start full.
//   'demo'  — the Theme Studio canvas and the Motion gallery. Timer kinds loop a
//             sample countdown so their motion can be judged while editing.
//   'still' — theme thumbnails. Everything is paused on a representative frame,
//             so a list of thumbnails costs nothing to keep on screen.
//
// Everything moves by transform or opacity, which the compositor animates
// without repainting — cheap over a long service on a modest Mac. Big soft
// shapes are laid out at half size and scaled up (a soft gradient loses
// nothing), which keeps each one's GPU texture a quarter of the size. Random
// placement comes from a seeded generator (graphic.seed), so a layer looks the
// same in the editor, every preview and the output, and after a reload;
// "Shuffle" just picks a new seed.
//
// Shared by display.html, service.js (previews and thumbnails), Theme Studio
// and the Node tests.
(function (root) {
  'use strict';

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const isNum = (v) => typeof v === 'number' && isFinite(v);

  // mulberry32: small, fast, and the same sequence for the same seed anywhere.
  function rng(seed) {
    let a = (seed >>> 0) || 0x9e3779b9;
    return function next() {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  const newSeed = () => (Math.floor(Math.random() * 0xffffffff) >>> 0) || 1;

  // '#rgb', '#rrggbb' (and their alpha forms) → rgba() with an extra alpha.
  function rgba(hex, alpha = 1) {
    let h = String(hex || '#ffffff').trim().replace('#', '');
    if (h.length === 3 || h.length === 4) h = h.split('').map(c => c + c).join('');
    const n = parseInt(h.slice(0, 6), 16);
    if (!isFinite(n)) return `rgba(255,255,255,${alpha})`;
    const a0 = h.length === 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1;
    const a = clamp(a0 * alpha, 0, 1);
    return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${+a.toFixed(3)})`;
  }

  // ── Kinds ─────────────────────────────────────────────────────────────────
  // Each parameter: { key, label, type: 'range'|'chips'|'toggle', min, max,
  // step, unit, options, def }. colors: { min, max, labels?, def }. Timer kinds
  // have fixed colour slots: the colour in use, the track/unlit colour, and the
  // two end-of-countdown colours (the same amber and red a timer's text turns).
  // Hand-drawn strokes, in a 100×100 box. Lines stretch to their layer's box
  // (so a circle can ring a word, an underline can run under a headline);
  // arrows keep their proportions.
  const LINE_SHAPES = [
    { id: 'loop', label: 'Loop', d: 'M 0 82 C 16 80, 28 62, 40 55 C 56 46, 68 58, 60 68 C 52 78, 40 64, 50 50 C 62 33, 80 28, 100 14' },
    { id: 'swoosh', label: 'Swoosh', d: 'M 0 72 C 22 98, 38 22, 60 40 S 84 72, 100 30' },
    { id: 'wave', label: 'Wave', d: 'M 0 50 C 12 25, 25 25, 37 50 S 62 75, 75 50 S 92 28, 100 36' },
    { id: 'spiral', label: 'Spiral', d: 'M 52 52 C 52 44, 62 44, 62 52 C 62 62, 44 62, 44 50 C 44 36, 70 34, 72 52 C 74 72, 36 76, 32 52 C 29 30, 64 20, 84 32' },
    { id: 'circle', label: 'Circle', d: 'M 24 60 C 18 34, 46 18, 72 24 C 96 30, 96 66, 66 76 C 40 85, 10 72, 16 50 C 20 36, 38 26, 58 25' },
    { id: 'underline', label: 'Underline', d: 'M 2 62 C 28 50, 70 46, 98 56' },
  ];
  const ARROW_SHAPES = [
    { id: 'curve', label: 'Curve', d: 'M 8 82 C 22 40, 52 18, 86 28', head: 'M 72 17 L 87 28 L 73 41' },
    { id: 'loop', label: 'Loop', d: 'M 6 74 C 22 44, 50 38, 46 58 C 42 76, 18 62, 36 44 C 54 26, 74 32, 90 48', head: 'M 79 40 L 91 49 L 80 60' },
    { id: 'straight', label: 'Straight', d: 'M 8 52 C 32 49, 60 53, 88 50', head: 'M 76 40 L 89 50 L 76 61' },
    { id: 'down', label: 'Curl', d: 'M 18 10 C 52 4, 72 30, 58 52 C 48 68, 56 86, 78 90', head: 'M 67 82 L 79 90 L 67 97' },
    { id: 'bounce', label: 'Bounce', d: 'M 6 70 C 18 30, 32 30, 40 60 C 48 86, 62 86, 70 56 C 74 44, 80 38, 90 36', head: 'M 79 29 L 91 36 L 81 46' },
  ];
  const MIRRORS = [{ label: 'None', value: 'none' }, { label: 'Across', value: 'h' }, { label: 'Down', value: 'v' }, { label: 'Both', value: 'hv' }];
  const SPEED = { key: 'speed', label: 'Speed', type: 'range', min: 0.1, max: 3, step: 0.05, unit: '×', def: 1 };
  const TIMER_COLOR_LABELS = ['Progress', 'Track', 'Last minute', 'Overtime'];
  const STATE_COLORS = { key: 'stateColors', label: 'Change colour near the end', type: 'toggle', def: true };
  const KINDS = [
    { id: 'aurora', label: 'Aurora', family: 'ambient', blurb: 'Soft light drifting across the screen', shuffle: true,
      colors: { min: 2, max: 5, def: ['#7c5cff', '#22d3ee', '#f472b6'] },
      params: [
        { key: 'count', label: 'Glows', type: 'range', min: 2, max: 8, step: 1, def: 4 },
        { key: 'size', label: 'Size', type: 'range', min: 30, max: 150, step: 1, unit: '%', def: 85 },
        { key: 'intensity', label: 'Intensity', type: 'range', min: 10, max: 100, step: 1, unit: '%', def: 65 },
        SPEED,
        { key: 'blend', label: 'Blend', type: 'chips', options: [{ label: 'Glow', value: 'glow' }, { label: 'Normal', value: 'normal' }], def: 'glow' },
      ] },
    { id: 'bokeh', label: 'Bokeh', family: 'ambient', blurb: 'Out-of-focus lights floating by', shuffle: true,
      colors: { min: 1, max: 4, def: ['#ffd89b', '#ffffff', '#ffb35c'] },
      params: [
        { key: 'count', label: 'Lights', type: 'range', min: 4, max: 60, step: 1, def: 26 },
        { key: 'size', label: 'Size', type: 'range', min: 1, max: 30, step: 1, def: 10 },
        { key: 'softness', label: 'Softness', type: 'range', min: 0, max: 100, step: 1, unit: '%', def: 55 },
        { key: 'intensity', label: 'Intensity', type: 'range', min: 10, max: 100, step: 1, unit: '%', def: 45 },
        { key: 'direction', label: 'Direction', type: 'chips', options: [{ label: 'Rise', value: 'up' }, { label: 'Fall', value: 'down' }, { label: 'Drift', value: 'drift' }], def: 'up' },
        SPEED,
      ] },
    { id: 'rays', label: 'Light Rays', family: 'ambient', blurb: 'Beams of light from one point',
      colors: { min: 1, max: 2, def: ['#fff1c9'] },
      params: [
        { key: 'count', label: 'Rays', type: 'range', min: 4, max: 36, step: 1, def: 14 },
        { key: 'spread', label: 'Width', type: 'range', min: 5, max: 90, step: 1, unit: '%', def: 35 },
        { key: 'intensity', label: 'Intensity', type: 'range', min: 5, max: 100, step: 1, unit: '%', def: 32 },
        { key: 'originX', label: 'Source across', type: 'range', min: 0, max: 100, step: 1, unit: '%', def: 50 },
        { key: 'originY', label: 'Source down', type: 'range', min: -50, max: 150, step: 1, unit: '%', def: -10 },
        { key: 'motion', label: 'Motion', type: 'chips', options: [{ label: 'Sway', value: 'sway' }, { label: 'Rotate', value: 'rotate' }], def: 'sway' },
        SPEED,
      ] },
    { id: 'waves', label: 'Waves', family: 'ambient', blurb: 'Layered waves rolling along the bottom',
      colors: { min: 1, max: 4, def: ['#38bdf8', '#6366f1', '#0ea5e9'] },
      params: [
        { key: 'count', label: 'Waves', type: 'range', min: 1, max: 4, step: 1, def: 3 },
        { key: 'amplitude', label: 'Swell', type: 'range', min: 5, max: 100, step: 1, unit: '%', def: 45 },
        { key: 'depth', label: 'Height', type: 'range', min: 10, max: 100, step: 1, unit: '%', def: 40 },
        { key: 'intensity', label: 'Intensity', type: 'range', min: 10, max: 100, step: 1, unit: '%', def: 50 },
        { key: 'direction', label: 'Direction', type: 'chips', options: [{ label: 'Left', value: 'left' }, { label: 'Right', value: 'right' }], def: 'left' },
        SPEED,
      ] },
    { id: 'sparkles', label: 'Sparkles', family: 'ambient', blurb: 'Stars twinkling in place', shuffle: true,
      colors: { min: 1, max: 3, def: ['#ffffff', '#fde68a'] },
      params: [
        { key: 'count', label: 'Sparkles', type: 'range', min: 10, max: 150, step: 1, def: 70 },
        { key: 'size', label: 'Size', type: 'range', min: 1, max: 10, step: 1, def: 3 },
        { key: 'intensity', label: 'Intensity', type: 'range', min: 10, max: 100, step: 1, unit: '%', def: 90 },
        SPEED,
      ] },
    { id: 'flow', label: 'Gradient Flow', family: 'ambient', blurb: 'A slowly shifting colour field', shuffle: true,
      colors: { min: 3, max: 4, labels: ['Base', 'Base 2', 'Light', 'Light 2'], def: ['#0b1026', '#1f1147', '#1d6f8a', '#6d28d9'] },
      params: [
        { key: 'angle', label: 'Angle', type: 'range', min: 0, max: 360, step: 1, unit: '°', def: 135 },
        { key: 'intensity', label: 'Light', type: 'range', min: 10, max: 100, step: 1, unit: '%', def: 70 },
        SPEED,
      ] },
    { id: 'grain', label: 'Film Grain', family: 'ambient', blurb: 'A fine moving texture over everything',
      colors: { min: 0, max: 0, def: [] },
      params: [
        { key: 'intensity', label: 'Intensity', type: 'range', min: 2, max: 40, step: 1, unit: '%', def: 9 },
        { key: 'size', label: 'Grain size', type: 'range', min: 1, max: 4, step: 1, def: 2 },
        { key: 'blend', label: 'Blend', type: 'chips', options: [{ label: 'Overlay', value: 'overlay' }, { label: 'Soft light', value: 'soft-light' }, { label: 'Normal', value: 'normal' }], def: 'overlay' },
        SPEED,
      ] },
    { id: 'line', label: 'Flowing Line', family: 'element', blurb: 'A hand-drawn line that draws itself on',
      colors: { min: 1, max: 1, def: ['#f4c6dd'] },
      params: [
        { key: 'shape', label: 'Shape', type: 'chips', options: LINE_SHAPES.map(s => ({ label: s.label, value: s.id })), def: 'loop' },
        { key: 'thickness', label: 'Pen width', type: 'range', min: 1, max: 40, step: 1, unit: 'px', def: 7 },
        { key: 'draw', label: 'Draw time', type: 'range', min: 0.3, max: 6, step: 0.1, unit: 's', def: 2.2 },
        { key: 'mirror', label: 'Mirror', type: 'chips', options: MIRRORS, def: 'none' },
        { key: 'drift', label: 'Drift', type: 'range', min: 0, max: 100, step: 1, unit: '%', def: 30 },
        SPEED,
      ] },
    { id: 'doodle', label: 'Doodle Arrow', family: 'element', blurb: 'A hand-drawn arrow pointing the way',
      colors: { min: 1, max: 1, def: ['#e3cf6c'] },
      params: [
        { key: 'shape', label: 'Arrow', type: 'chips', options: ARROW_SHAPES.map(s => ({ label: s.label, value: s.id })), def: 'curve' },
        { key: 'thickness', label: 'Pen width', type: 'range', min: 1, max: 40, step: 1, unit: 'px', def: 9 },
        { key: 'draw', label: 'Draw time', type: 'range', min: 0.3, max: 4, step: 0.1, unit: 's', def: 1.1 },
        { key: 'mirror', label: 'Mirror', type: 'chips', options: MIRRORS, def: 'none' },
        { key: 'drift', label: 'Wobble', type: 'range', min: 0, max: 100, step: 1, unit: '%', def: 20 },
        SPEED,
      ] },
    { id: 'pulse', label: 'Pulse', family: 'ambient', blurb: 'Rings pulsing out from the centre',
      colors: { min: 1, max: 2, def: ['#ffffff', '#7dd3fc'] },
      params: [
        { key: 'count', label: 'Rings', type: 'range', min: 1, max: 5, step: 1, def: 3 },
        { key: 'thickness', label: 'Thickness', type: 'range', min: 1, max: 20, step: 1, def: 3 },
        { key: 'intensity', label: 'Intensity', type: 'range', min: 10, max: 100, step: 1, unit: '%', def: 45 },
        { key: 'glow', label: 'Soft glow', type: 'toggle', def: true },
        SPEED,
      ] },
    { id: 'ring', label: 'Progress Ring', family: 'timer', blurb: 'A ring that runs down with the countdown',
      colors: { min: 4, max: 4, labels: TIMER_COLOR_LABELS, def: ['#ffffff', '#ffffff', '#e8a64a', '#e8404a'] },
      params: [
        { key: 'thickness', label: 'Thickness', type: 'range', min: 1, max: 25, step: 1, def: 4 },
        { key: 'trackOpacity', label: 'Track', type: 'range', min: 0, max: 100, step: 1, unit: '%', def: 18 },
        { key: 'direction', label: 'As time runs', type: 'chips', options: [{ label: 'Empties', value: 'deplete' }, { label: 'Fills', value: 'fill' }], def: 'deplete' },
        { key: 'caps', label: 'Ends', type: 'chips', options: [{ label: 'Round', value: 'round' }, { label: 'Flat', value: 'butt' }], def: 'round' },
        { key: 'glow', label: 'Glow', type: 'range', min: 0, max: 100, step: 1, unit: '%', def: 35 },
        STATE_COLORS,
      ] },
    { id: 'bar', label: 'Progress Bar', family: 'timer', blurb: 'A bar that runs down with the countdown',
      colors: { min: 4, max: 4, labels: TIMER_COLOR_LABELS, def: ['#ffffff', '#ffffff', '#e8a64a', '#e8404a'] },
      params: [
        { key: 'trackOpacity', label: 'Track', type: 'range', min: 0, max: 100, step: 1, unit: '%', def: 18 },
        { key: 'radius', label: 'Rounding', type: 'range', min: 0, max: 100, step: 1, unit: '%', def: 100 },
        { key: 'direction', label: 'As time runs', type: 'chips', options: [{ label: 'Empties', value: 'deplete' }, { label: 'Fills', value: 'fill' }], def: 'deplete' },
        { key: 'glow', label: 'Glow', type: 'range', min: 0, max: 100, step: 1, unit: '%', def: 25 },
        STATE_COLORS,
      ] },
    { id: 'dots', label: 'Seconds Dots', family: 'timer', blurb: 'A studio clock: one dot per second',
      colors: { min: 4, max: 4, labels: ['Lit', 'Unlit', 'Last minute', 'Overtime'], def: ['#ffffff', '#ffffff', '#e8a64a', '#e8404a'] },
      params: [
        { key: 'count', label: 'Dots', type: 'range', min: 12, max: 120, step: 1, def: 60 },
        { key: 'size', label: 'Dot size', type: 'range', min: 10, max: 100, step: 1, unit: '%', def: 45 },
        { key: 'trackOpacity', label: 'Unlit', type: 'range', min: 0, max: 100, step: 1, unit: '%', def: 15 },
        { key: 'shape', label: 'Layout', type: 'chips', options: [{ label: 'Circle', value: 'circle' }, { label: 'Line', value: 'line' }], def: 'circle' },
        { key: 'mode', label: 'Counts', type: 'chips', options: [{ label: 'Seconds', value: 'seconds' }, { label: 'Whole countdown', value: 'countdown' }], def: 'seconds' },
        { key: 'glow', label: 'Glow', type: 'range', min: 0, max: 100, step: 1, unit: '%', def: 30 },
        STATE_COLORS,
      ] },
  ];
  const KIND_BY_ID = new Map(KINDS.map(k => [k.id, k]));
  const kindOf = (id) => KIND_BY_ID.get(id) || KIND_BY_ID.get('aurora');
  const isTimerKind = (id) => kindOf(id).family === 'timer' && KIND_BY_ID.has(id);

  function defaults(kind) {
    const k = kindOf(kind);
    const g = { kind: k.id, colors: [...k.colors.def] };
    k.params.forEach(p => { g[p.key] = p.def; });
    return g;
  }

  // A fresh graphic of this kind, with its own arrangement.
  function create(kind) { return { ...defaults(kind), seed: newSeed() }; }

  // Fills anything missing, clamps every value to its range and keeps the
  // colour list within the kind's bounds — so a hand-edited or older theme
  // can never throw a renderer.
  function normalize(graphic) {
    const src = graphic && typeof graphic === 'object' ? graphic : {};
    const k = kindOf(src.kind);
    const d = defaults(k.id);
    const g = { kind: k.id, seed: (src.seed >>> 0) || 1 };
    let colors = Array.isArray(src.colors) ? src.colors.filter(c => typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c.trim())) : [];
    if (colors.length < k.colors.min) colors = [...colors, ...d.colors.slice(colors.length, k.colors.min)];
    while (colors.length < k.colors.min) colors.push(d.colors[colors.length % d.colors.length]);
    g.colors = colors.slice(0, k.colors.max);
    k.params.forEach(p => {
      const v = src[p.key];
      if (p.type === 'range') g[p.key] = isNum(v) ? clamp(v, p.min, p.max) : p.def;
      else if (p.type === 'toggle') g[p.key] = typeof v === 'boolean' ? v : p.def;
      else g[p.key] = p.options.some(o => o.value === v) ? v : p.def;
    });
    return g;
  }

  // Switching kind keeps the colours the operator already chose where the new
  // kind can use them, and its own defaults for everything else.
  function switchKind(graphic, kind) {
    const k = kindOf(kind);
    const next = { ...defaults(k.id), seed: (graphic && graphic.seed) || newSeed() };
    const old = Array.isArray(graphic && graphic.colors) ? graphic.colors : [];
    if (k.family !== 'timer' && old.length && !isTimerKind(graphic && graphic.kind)) {
      next.colors = old.slice(0, k.colors.max);
    }
    return normalize(next);
  }

  // ── Styles ────────────────────────────────────────────────────────────────
  const CSS = `
.km-root{position:absolute;inset:0;overflow:hidden;pointer-events:none;container-type:size;}
.km-root *{box-sizing:border-box;}
.km-still,.km-still *{animation-play-state:paused!important;}
.km-blob{position:absolute;border-radius:50%;will-change:transform;}
.km-dot{position:absolute;border-radius:50%;will-change:transform,opacity;}
@keyframes km-drift{0%{transform:translate3d(-50%,-50%,0) scale(var(--k,1))}50%{transform:translate3d(calc(-50% + var(--dx)),calc(-50% + var(--dy)),0) scale(calc(var(--k,1) * var(--ds,1)))}100%{transform:translate3d(-50%,-50%,0) scale(var(--k,1))}}
@keyframes km-travel{from{transform:translate3d(0,0,0)}to{transform:translate3d(var(--sway),var(--travel),0)}}
@keyframes km-life{0%{opacity:0}15%{opacity:var(--o)}85%{opacity:var(--o)}100%{opacity:0}}
@keyframes km-breathe-o{0%,100%{opacity:calc(var(--o) * .35)}50%{opacity:var(--o)}}
@keyframes km-spin{from{transform:translate(-50%,-50%) scale(2) rotate(0deg)}to{transform:translate(-50%,-50%) scale(2) rotate(360deg)}}
@keyframes km-sway{from{transform:translate(-50%,-50%) scale(2) rotate(-14deg)}to{transform:translate(-50%,-50%) scale(2) rotate(14deg)}}
@keyframes km-wave-l{from{transform:translate3d(0,0,0)}to{transform:translate3d(-50%,0,0)}}
@keyframes km-wave-r{from{transform:translate3d(-50%,0,0)}to{transform:translate3d(0,0,0)}}
@keyframes km-twinkle{0%,100%{opacity:0;transform:scale(.3)}50%{opacity:var(--o);transform:scale(1)}}
@keyframes km-pulse{0%{transform:translate(-50%,-50%) scale(.12);opacity:0}12%{opacity:var(--o)}100%{transform:translate(-50%,-50%) scale(1);opacity:0}}
@keyframes km-glow{0%,100%{transform:translate(-50%,-50%) scale(1.7);opacity:calc(var(--o) * .55)}50%{transform:translate(-50%,-50%) scale(2.05);opacity:var(--o)}}
@keyframes km-ring-demo{from{stroke-dashoffset:0}to{stroke-dashoffset:100}}
@keyframes km-ring-demo-fill{from{stroke-dashoffset:100}to{stroke-dashoffset:0}}
@keyframes km-bar-demo{from{width:100%}to{width:0%}}
@keyframes km-bar-demo-fill{from{width:0%}to{width:100%}}
@keyframes km-barv-demo{from{height:100%}to{height:0%}}
@keyframes km-barv-demo-fill{from{height:0%}to{height:100%}}
@keyframes km-over{0%,100%{opacity:1}50%{opacity:.5}}
@keyframes km-draw{to{stroke-dashoffset:0}}
@keyframes km-wander{0%,100%{transform:translate(0,0) rotate(0deg)}33%{transform:translate(var(--dx1),var(--dy1)) rotate(var(--r1))}66%{transform:translate(var(--dx2),var(--dy2)) rotate(var(--r2))}}
@keyframes km-grain{0%{transform:translate(0,0)}10%{transform:translate(-4%,-7%)}20%{transform:translate(-9%,3%)}30%{transform:translate(5%,-9%)}40%{transform:translate(-3%,8%)}50%{transform:translate(-9%,6%)}60%{transform:translate(9%,0)}70%{transform:translate(0,9%)}80%{transform:translate(2%,-5%)}90%{transform:translate(-6%,4%)}100%{transform:translate(0,0)}}
@keyframes kb-fade{from{opacity:0}}
@keyframes kb-unblur{from{filter:var(--km-filter,) blur(var(--kb-blur,12px))}}
@keyframes kb-rise{from{translate:0 12%}}
@keyframes kb-drop{from{translate:0 -12%}}
@keyframes kb-left{from{translate:-8% 0}}
@keyframes kb-right{from{translate:8% 0}}
@keyframes kb-settle{from{scale:1.08}}
@keyframes kb-pop{0%{scale:.72}62%{scale:1.04}82%{scale:.99}100%{scale:1}}
@keyframes kb-wipe{from{clip-path:inset(0 100% 0 0)}}
@keyframes kb-word{from{translate:0 .45em}}
@keyframes kb-letter{from{translate:0 .3em;scale:.8}}
@keyframes kb-type{from{opacity:0}to{opacity:1}}
.kb-piece{display:inline-block;white-space:pre;}
.kb-word-wrap{display:inline-block;white-space:nowrap;}
@keyframes ki-float{from{translate:0 0}to{translate:0 calc(var(--ku,1vh) * var(--ka,1) * -2.4)}}
@keyframes ki-drift{0%{translate:0 0;animation-timing-function:ease-out}25%{translate:calc(var(--ku,1vh) * var(--ka,1) * -2.6) 0;animation-timing-function:ease-in-out}75%{translate:calc(var(--ku,1vh) * var(--ka,1) * 2.6) 0;animation-timing-function:ease-in}100%{translate:0 0}}
@keyframes ki-breathe{from{scale:1}to{scale:calc(1 + .045 * var(--ka,1))}}
@keyframes ki-sway{0%{rotate:0deg;animation-timing-function:ease-out}25%{rotate:calc(-2.5deg * var(--ka,1));animation-timing-function:ease-in-out}75%{rotate:calc(2.5deg * var(--ka,1));animation-timing-function:ease-in}100%{rotate:0deg}}
@keyframes ki-pulse{from{filter:var(--km-filter,) brightness(1)}to{filter:var(--km-filter,) brightness(calc(1 + .45 * var(--ka,1)))}}
@keyframes ki-tilt{0%{rotate:0deg}25%{rotate:calc(.8deg * var(--ka,1))}75%{rotate:calc(-.8deg * var(--ka,1))}100%{rotate:0deg}}
.km-timer.km-is-over .km-progress{animation:km-over 1.2s ease-in-out infinite;}
.km-ring-fill{transition:stroke-dashoffset 1s linear,stroke .5s ease;}
.km-bar-fill{transition:width 1s linear,height 1s linear,background-color .5s ease;}
.km-timer-still .km-ring-fill,.km-timer-still .km-bar-fill{transition:none!important;}
.km-dots circle{transition:fill .35s ease,opacity .35s ease;}
`;
  function ensureStyles(doc) {
    doc = doc || (typeof document !== 'undefined' ? document : null);
    if (!doc || doc.getElementById('kairo-motion-css')) return;
    const style = doc.createElement('style');
    style.id = 'kairo-motion-css';
    style.textContent = CSS;
    (doc.head || doc.documentElement).appendChild(style);
  }

  // ── Renderers ─────────────────────────────────────────────────────────────
  // Every renderer draws into `el` (the .km-root, filling its layer's box).
  // `rand` is this graphic's seeded generator; durations divide by speed.
  const pick = (arr, i) => arr[i % arr.length];

  function anim(name, seconds, delay, extra) {
    return `${name} ${seconds.toFixed(2)}s ${extra || 'ease-in-out'} ${(-delay).toFixed(2)}s infinite`;
  }

  const RENDER = {
    aurora(el, g, rand, doc) {
      const blend = g.blend === 'glow' ? 'screen' : 'normal';
      for (let i = 0; i < g.count; i++) {
        const b = doc.createElement('div');
        b.className = 'km-blob';
        const size = g.size * (0.75 + rand() * 0.5);      // % of the box's longer side
        const c = pick(g.colors, i);
        // Laid out at half size, drawn at double (--k: 2): see the header.
        b.style.width = b.style.height = (size / 2) + 'cqmax';
        b.style.left = (8 + rand() * 84) + '%';
        b.style.top = (8 + rand() * 84) + '%';
        b.style.background = `radial-gradient(circle at 50% 50%, ${rgba(c, g.intensity / 100)} 0%, ${rgba(c, g.intensity / 250)} 38%, ${rgba(c, 0)} 70%)`;
        b.style.mixBlendMode = blend;
        b.style.setProperty('--k', '2');
        b.style.setProperty('--dx', ((rand() - 0.5) * 50).toFixed(1) + 'cqw');
        b.style.setProperty('--dy', ((rand() - 0.5) * 40).toFixed(1) + 'cqh');
        b.style.setProperty('--ds', (0.8 + rand() * 0.5).toFixed(2));
        const dur = (22 + rand() * 18) / g.speed;
        b.style.animation = anim('km-drift', dur, rand() * dur);
        el.appendChild(b);
      }
    },

    bokeh(el, g, rand, doc) {
      const hard = 1 - g.softness / 100;                  // 1 = crisp disc, 0 = pure glow
      for (let i = 0; i < g.count; i++) {
        const d = doc.createElement('div');
        d.className = 'km-dot';
        const size = g.size * (0.35 + rand() * 0.65);     // cqmin
        const c = pick(g.colors, Math.floor(rand() * 97));
        const o = (g.intensity / 100) * (0.45 + rand() * 0.55);
        const edge = 40 + hard * 28;
        d.style.width = d.style.height = size.toFixed(2) + 'cqmin';
        d.style.left = (rand() * 100).toFixed(2) + '%';
        d.style.background = `radial-gradient(circle, ${rgba(c, 1)} 0%, ${rgba(c, 0.85)} ${(edge - 12).toFixed(0)}%, ${rgba(c, 0.35 * hard + 0.1)} ${edge.toFixed(0)}%, ${rgba(c, 0)} 71%)`;
        d.style.setProperty('--o', o.toFixed(3));
        if (g.direction === 'drift') {
          d.style.top = (rand() * 100).toFixed(2) + '%';
          d.style.setProperty('--k', '1');
          d.style.setProperty('--dx', ((rand() - 0.5) * 30).toFixed(1) + 'cqmin');
          d.style.setProperty('--dy', ((rand() - 0.5) * 30).toFixed(1) + 'cqmin');
          d.style.setProperty('--ds', (0.7 + rand() * 0.6).toFixed(2));
          const dur = (14 + rand() * 16) / g.speed;
          d.style.animation = `${anim('km-drift', dur, rand() * dur)}, ${anim('km-breathe-o', dur / 2, rand() * dur)}`;
        } else {
          const up = g.direction !== 'down';
          d.style.top = up ? '100%' : `-${size.toFixed(2)}cqmin`;
          d.style.setProperty('--travel', `calc(${up ? '-' : ''}100cqh ${up ? '-' : '+'} ${(size * 2).toFixed(2)}cqmin)`);
          d.style.setProperty('--sway', ((rand() - 0.5) * 16).toFixed(1) + 'cqw');
          const dur = (16 + rand() * 18) / g.speed;
          const delay = rand() * dur;
          d.style.animation = `${anim('km-travel', dur, delay, 'linear')}, ${anim('km-life', dur, delay, 'linear')}`;
        }
        el.appendChild(d);
      }
    },

    rays(el, g, rand, doc) {
      const r = doc.createElement('div');
      const period = 360 / g.count;
      const width = period * g.spread / 100;
      const stops = [];
      // Two colours alternate ray by ray, so the gradient repeats every two.
      const n = g.colors.length > 1 ? 2 : 1;
      for (let i = 0; i < n; i++) {
        const c = g.colors[i];
        const a0 = i * period;
        stops.push(`${rgba(c, 0)} ${a0.toFixed(2)}deg`, `${rgba(c, g.intensity / 100)} ${(a0 + width / 2).toFixed(2)}deg`,
          `${rgba(c, 0)} ${(a0 + width).toFixed(2)}deg`, `${rgba(c, 0)} ${(a0 + period).toFixed(2)}deg`);
      }
      r.style.cssText = 'position:absolute;border-radius:50%;will-change:transform;';
      // Half size, drawn at double (scale(2) in the keyframes).
      r.style.width = r.style.height = '120cqmax';
      r.style.left = g.originX + '%';
      r.style.top = g.originY + '%';
      r.style.background = `repeating-conic-gradient(from 0deg at 50% 50%, ${stops.join(', ')})`;
      const mask = 'radial-gradient(circle closest-side, #000 0%, rgba(0,0,0,.55) 35%, rgba(0,0,0,0) 100%)';
      r.style.webkitMaskImage = mask;
      r.style.maskImage = mask;
      if (g.motion === 'rotate') r.style.animation = anim('km-spin', 140 / g.speed, rand() * 140, 'linear');
      else r.style.animation = `km-sway ${(20 / g.speed).toFixed(2)}s ease-in-out ${(-rand() * 20).toFixed(2)}s infinite alternate`;
      el.appendChild(r);
    },

    waves(el, g, rand, doc) {
      const NS = 'http://www.w3.org/2000/svg';
      for (let i = 0; i < g.count; i++) {
        const front = (i + 1) / g.count;                  // later waves sit in front
        const wrap = doc.createElement('div');
        wrap.style.cssText = 'position:absolute;left:0;bottom:0;width:200%;will-change:transform;';
        wrap.style.height = (g.depth * (0.65 + 0.35 * (1 - front) + 0.1)).toFixed(1) + '%';
        const svg = doc.createElementNS(NS, 'svg');
        svg.setAttribute('viewBox', '0 0 1600 200');
        svg.setAttribute('preserveAspectRatio', 'none');
        svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;display:block;';
        // Wavelengths that divide 800 exactly, so sliding half the strip loops
        // seamlessly.
        const lambda = 800 / (1 + ((i + Math.floor(rand() * 3)) % 3));
        const amp = 8 + (g.amplitude / 100) * 70 * (0.6 + rand() * 0.4);
        const phase = rand() * Math.PI * 2;
        let dpath = '';
        for (let x = 0; x <= 1600; x += 10) {
          const y = 100 - amp * Math.sin((2 * Math.PI * x) / lambda + phase);
          dpath += (x ? 'L' : 'M') + x + ' ' + y.toFixed(1) + ' ';
        }
        dpath += 'L1600 200 L0 200 Z';
        const path = doc.createElementNS(NS, 'path');
        path.setAttribute('d', dpath);
        path.setAttribute('fill', rgba(pick(g.colors, i), (g.intensity / 100) * (0.35 + 0.65 * front)));
        svg.appendChild(path);
        wrap.appendChild(svg);
        const dur = (26 - 10 * front + rand() * 6) / g.speed;
        wrap.style.animation = anim(g.direction === 'right' ? 'km-wave-r' : 'km-wave-l', dur, rand() * dur, 'linear');
        el.appendChild(wrap);
      }
    },

    sparkles(el, g, rand, doc) {
      for (let i = 0; i < g.count; i++) {
        const s = doc.createElement('div');
        s.className = 'km-dot';
        const size = g.size * (0.4 + rand() * 0.8) * 0.35; // cqmin
        const c = pick(g.colors, Math.floor(rand() * 89));
        s.style.width = s.style.height = size.toFixed(2) + 'cqmin';
        s.style.left = (rand() * 100).toFixed(2) + '%';
        s.style.top = (rand() * 100).toFixed(2) + '%';
        s.style.background = rgba(c, 1);
        s.style.boxShadow = `0 0 ${(size * 2.5).toFixed(2)}cqmin ${(size * 0.6).toFixed(2)}cqmin ${rgba(c, 0.55)}`;
        s.style.setProperty('--o', ((g.intensity / 100) * (0.5 + rand() * 0.5)).toFixed(3));
        const dur = (2.2 + rand() * 4.5) / g.speed;
        s.style.animation = anim('km-twinkle', dur, rand() * dur);
        // One in five also gets a four-point glint.
        if (rand() < 0.2) {
          for (const rot of [0, 90]) {
            const bar = doc.createElement('div');
            bar.style.cssText = `position:absolute;left:50%;top:50%;width:${(size * 9).toFixed(2)}cqmin;height:${Math.max(0.12, size * 0.28).toFixed(2)}cqmin;`
              + `transform:translate(-50%,-50%) rotate(${rot}deg);background:linear-gradient(90deg, ${rgba(c, 0)}, ${rgba(c, 0.9)}, ${rgba(c, 0)});border-radius:50%;`;
            s.appendChild(bar);
          }
        }
        el.appendChild(s);
      }
    },

    flow(el, g, rand, doc) {
      el.style.background = `linear-gradient(${g.angle}deg, ${g.colors[0]}, ${g.colors[1]})`;
      const lights = g.colors.slice(2);
      const n = lights.length === 1 ? 2 : 3;
      for (let i = 0; i < n; i++) {
        const b = doc.createElement('div');
        b.className = 'km-blob';
        const c = pick(lights, i);
        b.style.width = b.style.height = (55 + rand() * 25).toFixed(1) + 'cqmax';
        b.style.left = (15 + rand() * 70).toFixed(1) + '%';
        b.style.top = (15 + rand() * 70).toFixed(1) + '%';
        b.style.background = `radial-gradient(circle, ${rgba(c, g.intensity / 100)} 0%, ${rgba(c, g.intensity / 280)} 40%, ${rgba(c, 0)} 70%)`;
        b.style.setProperty('--k', '2');
        b.style.setProperty('--dx', ((rand() - 0.5) * 60).toFixed(1) + 'cqw');
        b.style.setProperty('--dy', ((rand() - 0.5) * 50).toFixed(1) + 'cqh');
        b.style.setProperty('--ds', (0.85 + rand() * 0.4).toFixed(2));
        const dur = (30 + rand() * 20) / g.speed;
        b.style.animation = anim('km-drift', dur, rand() * dur);
        el.appendChild(b);
      }
    },

    pulse(el, g, rand, doc) {
      const period = 3.2 / g.speed;
      const c0 = g.colors[0], c1 = g.colors[1] || g.colors[0];
      if (g.glow) {
        const glow = doc.createElement('div');
        glow.className = 'km-blob';
        glow.style.cssText += 'left:50%;top:50%;width:40cqmin;height:40cqmin;';
        glow.style.background = `radial-gradient(circle, ${rgba(c1, 0.55)} 0%, ${rgba(c1, 0.18)} 40%, ${rgba(c1, 0)} 70%)`;
        glow.style.setProperty('--o', (g.intensity / 100).toFixed(3));
        glow.style.animation = anim('km-glow', period, 0);
        el.appendChild(glow);
      }
      for (let i = 0; i < g.count; i++) {
        const r = doc.createElement('div');
        r.style.cssText = 'position:absolute;left:50%;top:50%;width:96cqmin;height:96cqmin;border-radius:50%;will-change:transform,opacity;';
        r.style.border = `${(g.thickness * 0.25).toFixed(2)}cqmin solid ${rgba(i % 2 ? c1 : c0, 1)}`;
        r.style.setProperty('--o', (g.intensity / 100).toFixed(3));
        r.style.animation = anim('km-pulse', period, (i * period) / g.count, 'cubic-bezier(.2,.6,.35,1)');
        el.appendChild(r);
      }
    },

    grain(el, g, rand, doc) {
      const n = doc.createElement('div');
      // Oversized so its random jumps (km-grain, at most 9% each way) never
      // show an edge; the tile scales with the box so previews match.
      n.style.cssText = 'position:absolute;left:-15%;top:-15%;width:130%;height:130%;will-change:transform;';
      n.style.backgroundImage = `url("${NOISE}")`;
      n.style.backgroundSize = (g.size * 14) + 'cqmin';
      n.style.opacity = (g.intensity / 100).toFixed(3);
      n.style.mixBlendMode = g.blend;
      n.style.animation = `km-grain ${(0.9 / g.speed).toFixed(2)}s steps(1, end) infinite`;
      el.appendChild(n);
    },

    line(el, g, rand, doc, mode, opts) {
      const s = LINE_SHAPES.find(x => x.id === g.shape) || LINE_SHAPES[0];
      strokeGraphic(el, g, rand, doc, mode, opts, [s.d], 'none');
    },

    doodle(el, g, rand, doc, mode, opts) {
      const s = ARROW_SHAPES.find(x => x.id === g.shape) || ARROW_SHAPES[0];
      strokeGraphic(el, g, rand, doc, mode, opts, [s.d, s.head], 'xMidYMid meet');
    },

    ring(el, g, rand, doc, mode) {
      const NS = 'http://www.w3.org/2000/svg';
      const svg = doc.createElementNS(NS, 'svg');
      svg.setAttribute('viewBox', '0 0 100 100');
      svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;overflow:visible;';
      const t = g.thickness;
      const r = 50 - t / 2 - (g.glow ? 1.5 : 0);
      const track = doc.createElementNS(NS, 'circle');
      track.setAttribute('cx', '50'); track.setAttribute('cy', '50'); track.setAttribute('r', r.toFixed(2));
      track.setAttribute('fill', 'none'); track.setAttribute('stroke', rgba(g.colors[1], g.trackOpacity / 100));
      track.setAttribute('stroke-width', String(t));
      const fill = doc.createElementNS(NS, 'circle');
      fill.setAttribute('class', 'km-ring-fill km-progress');
      fill.setAttribute('cx', '50'); fill.setAttribute('cy', '50'); fill.setAttribute('r', r.toFixed(2));
      fill.setAttribute('fill', 'none'); fill.setAttribute('stroke', g.colors[0]);
      fill.setAttribute('stroke-width', String(t));
      fill.setAttribute('stroke-linecap', g.caps);
      fill.setAttribute('pathLength', '100');
      fill.setAttribute('stroke-dasharray', '100 100');
      fill.setAttribute('transform', 'rotate(-90 50 50)');
      fill.style.strokeDashoffset = mode === 'still' ? (g.direction === 'fill' ? '66' : '34') : (g.direction === 'fill' ? '100' : '0');
      if (mode === 'demo') fill.style.animation = `${g.direction === 'fill' ? 'km-ring-demo-fill' : 'km-ring-demo'} 12s linear infinite`;
      if (g.glow > 0) svg.style.filter = `drop-shadow(0 0 ${(g.glow / 25).toFixed(2)}cqmin ${rgba(g.colors[0], 0.8)})`;
      svg.appendChild(track);
      svg.appendChild(fill);
      el.appendChild(svg);
    },

    bar(el, g, rand, doc, mode) {
      const track = doc.createElement('div');
      track.style.cssText = 'position:absolute;inset:0;overflow:hidden;';
      track.style.background = rgba(g.colors[1], g.trackOpacity / 100);
      // cqmin is a hundredth of the bar's short side, so 50cqmin rounds it fully.
      track.style.borderRadius = (g.radius / 2).toFixed(1) + 'cqmin';
      const fill = doc.createElement('div');
      fill.className = 'km-bar-fill km-progress';
      fill.style.cssText = 'position:absolute;left:0;bottom:0;';
      fill.style.borderRadius = 'inherit';
      fill.style.background = g.colors[0];
      if (g.glow > 0) fill.style.boxShadow = `0 0 ${(g.glow / 8).toFixed(1)}cqmin ${rgba(g.colors[0], 0.7)}`;
      el.appendChild(track);
      track.appendChild(fill);
      const startFrac = mode === 'still' ? 0.66 : 1;
      const shown = g.direction === 'fill' ? 1 - startFrac : startFrac;
      setBarFill(el, fill, shown, mode === 'demo' ? g.direction : null);
    },

    dots(el, g, rand, doc, mode) {
      const NS = 'http://www.w3.org/2000/svg';
      const svg = doc.createElementNS(NS, 'svg');
      svg.setAttribute('class', 'km-dots');
      const n = g.count;
      const line = g.shape === 'line';
      if (line) svg.setAttribute('viewBox', `0 0 ${n * 10} 10`);
      else svg.setAttribute('viewBox', '0 0 100 100');
      svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
      svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;overflow:visible;';
      const ringR = 46;
      const spacing = line ? 10 : (2 * Math.PI * ringR) / n;
      const dotR = Math.max(0.3, (spacing / 2) * (g.size / 100));
      for (let i = 0; i < n; i++) {
        const c = doc.createElementNS(NS, 'circle');
        if (line) { c.setAttribute('cx', (i * 10 + 5).toFixed(2)); c.setAttribute('cy', '5'); }
        else {
          const a = -Math.PI / 2 + (i * 2 * Math.PI) / n;
          c.setAttribute('cx', (50 + ringR * Math.cos(a)).toFixed(2));
          c.setAttribute('cy', (50 + ringR * Math.sin(a)).toFixed(2));
        }
        c.setAttribute('r', dotR.toFixed(2));
        svg.appendChild(c);
      }
      if (g.glow > 0) svg.style.filter = `drop-shadow(0 0 ${(g.glow / 30).toFixed(2)}cqmin ${rgba(g.colors[0], 0.8)})`;
      el.appendChild(svg);
      const lit = mode === 'live' ? n : Math.round(n * 0.66);
      setDots(svg, g, lit, g.colors[0]);
    },
  };

  const NOISE = 'data:image/svg+xml;utf8,' + encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' width='256' height='256'><filter id='n'>"
    + "<feTurbulence type='fractalNoise' baseFrequency='0.8' numOctaves='3' stitchTiles='stitch'/>"
    + "<feColorMatrix type='saturate' values='0'/></filter><rect width='256' height='256' filter='url(#n)'/></svg>");

  // A path's absolute coordinates, stretched: every number is an x or a y in
  // turn (M, C, S and L only take coordinate pairs).
  function stretchPath(d, ax, ay) {
    let i = 0;
    return d.replace(/-?\d+(\.\d+)?/g, (n) => (i++ % 2 === 0 ? +n * ax : +n * ay).toFixed(2));
  }

  // A hand-drawn stroke (line or arrow): each path draws itself on in turn —
  // an arrow's shaft, then its head — starting after the layer's own build
  // delay (opts.delay), then the whole drawing wanders a little (drift).
  // A line stretches to its box by rewriting its path in the box's own
  // proportions rather than scaling the drawing, so the pen keeps an even
  // width. (WebKit mis-draws a dashed draw-on with non-scaling strokes.)
  // opts.box is the layer's size in design pixels (1920×1080 space): the short
  // side is 100 units, so the pen width, given in design pixels, comes out the
  // same on a thin underline as on a full-screen swoosh, and scales with the
  // output like everything else.
  function strokeGraphic(el, g, rand, doc, mode, opts, paths, aspect) {
    const NS = 'http://www.w3.org/2000/svg';
    const box = opts && opts.box && opts.box.w > 0 && opts.box.h > 0 ? opts.box : { w: 600, h: 600 };
    const a = aspect === 'none' ? box.w / box.h : 1;
    const unitsPerPx = 100 / Math.min(box.w, box.h);
    const ax = a >= 1 ? a : 1, ay = a >= 1 ? 1 : 1 / a;
    if (aspect === 'none') paths = paths.map(d => stretchPath(d, ax, ay));
    const wander = doc.createElement('div');
    wander.style.cssText = 'position:absolute;inset:0;';
    const mirror = doc.createElement('div');
    mirror.style.cssText = 'position:absolute;inset:0;';
    const sx = g.mirror.includes('h') ? -1 : 1, sy = g.mirror.includes('v') ? -1 : 1;
    if (sx < 0 || sy < 0) mirror.style.transform = `scale(${sx}, ${sy})`;
    const svg = doc.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', aspect === 'none' ? `0 0 ${(100 * ax).toFixed(2)} ${(100 * ay).toFixed(2)}` : '0 0 100 100');
    svg.setAttribute('preserveAspectRatio', aspect === 'none' ? 'none' : aspect);
    svg.style.cssText = 'position:absolute;inset:0;width:100%;height:100%;overflow:visible;';
    const delay = Math.max(0, Number(opts && opts.delay) || 0);
    paths.forEach((d, i) => {
      const p = doc.createElementNS(NS, 'path');
      p.setAttribute('d', d);
      p.setAttribute('fill', 'none');
      p.setAttribute('stroke', g.colors[0]);
      p.setAttribute('stroke-linecap', 'round');
      p.setAttribute('stroke-linejoin', 'round');
      p.setAttribute('pathLength', '100');
      p.setAttribute('stroke-dasharray', '100 100');
      p.setAttribute('stroke-width', (g.thickness * unitsPerPx).toFixed(3));
      if (mode === 'still') p.style.strokeDashoffset = '0';
      else {
        const shaft = paths.length > 1 ? 0.78 : 1;
        const dur = i === 0 ? g.draw * shaft : g.draw * (1 - shaft);
        const start = i === 0 ? 0 : g.draw * shaft;
        p.style.strokeDashoffset = '100';
        p.style.animation = `km-draw ${dur.toFixed(2)}s cubic-bezier(.45,.05,.25,1) ${(delay + start).toFixed(2)}s forwards`;
      }
      svg.appendChild(p);
    });
    mirror.appendChild(svg);
    wander.appendChild(mirror);
    if (g.drift > 0) {
      const a = g.drift / 100;
      wander.style.setProperty('--dx1', ((rand() - 0.5) * 6 * a).toFixed(2) + 'cqmin');
      wander.style.setProperty('--dy1', ((rand() - 0.5) * 6 * a).toFixed(2) + 'cqmin');
      wander.style.setProperty('--dx2', ((rand() - 0.5) * 6 * a).toFixed(2) + 'cqmin');
      wander.style.setProperty('--dy2', ((rand() - 0.5) * 6 * a).toFixed(2) + 'cqmin');
      wander.style.setProperty('--r1', ((rand() - 0.5) * 6 * a).toFixed(2) + 'deg');
      wander.style.setProperty('--r2', ((rand() - 0.5) * 6 * a).toFixed(2) + 'deg');
      const dur = 9 / g.speed;
      wander.style.animation = anim('km-wander', dur, rand() * dur);
    }
    el.appendChild(wander);
  }

  function setBarFill(root, fill, shown, demoDirection) {
    // A bar taller than it is wide runs vertically (from the bottom).
    const vertical = root.clientHeight > root.clientWidth && root.clientWidth > 0;
    fill.style.left = '0'; fill.style.bottom = '0';
    fill.style.top = vertical ? 'auto' : '0';
    fill.style.width = vertical ? '100%' : (shown * 100).toFixed(3) + '%';
    fill.style.height = vertical ? (shown * 100).toFixed(3) + '%' : '100%';
    if (demoDirection) {
      const name = (vertical ? 'km-barv-demo' : 'km-bar-demo') + (demoDirection === 'fill' ? '-fill' : '');
      fill.style.animation = `${name} 12s linear infinite`;
    }
  }

  // The first `lit` dots clockwise from the top stay lit, so the lit arc
  // retreats the way a ring empties.
  function setDots(svg, g, lit, color) {
    const unlit = rgba(g.colors[1], g.trackOpacity / 100);
    svg.querySelectorAll('circle').forEach((c, i) => c.setAttribute('fill', i < lit ? color : unlit));
  }

  // ── Build ─────────────────────────────────────────────────────────────────
  // Returns the .km-root element for a graphic, filling whatever box the
  // caller puts it in (the caller owns the layer's position, opacity and
  // rotation, the same as for every other layer type).
  function build(graphic, opts = {}) {
    const doc = opts.document || (typeof document !== 'undefined' ? document : null);
    ensureStyles(doc);
    const g = normalize(graphic);
    const mode = opts.mode === 'demo' || opts.mode === 'still' ? opts.mode : 'live';
    const el = doc.createElement('div');
    el.className = `km-root km-${g.kind}` + (mode === 'still' ? ' km-still' : '');
    el._km = g;
    RENDER[g.kind](el, g, rng(g.seed), doc, mode, opts);
    if (isTimerKind(g.kind)) {
      el.classList.add('km-timer');
      if (mode === 'live') el.dataset.kmFresh = '1';
      if (mode !== 'live') el.classList.add('km-timer-demo');
    }
    // The bar's orientation depends on its box, known only once it's laid out.
    if (g.kind === 'bar' && typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(() => {
        const fill = el.querySelector('.km-bar-fill');
        if (!fill || !el.isConnected) return;
        const cur = el._kmShown ?? (mode === 'still' ? (g.direction === 'fill' ? 0.34 : 0.66) : (g.direction === 'fill' ? 0 : 1));
        setBarFill(el, fill, cur, mode === 'demo' ? g.direction : null);
      });
    }
    return el;
  }

  // ── Live countdown ────────────────────────────────────────────────────────
  // One stage-timer tick: { remainingMs, totalMs, cleared }. Applies to every
  // live timer graphic under `scope`. Past zero the countdown keeps running
  // (overtime), so the graphic shows full in the overtime colour and pulses.
  function timerState({ remainingMs = 0, totalMs = 0, cleared = false } = {}) {
    const overtime = !cleared && remainingMs < 0;
    const warning = !cleared && !overtime && remainingMs <= 60000;
    const remaining = cleared || !(totalMs > 0) ? 1 : clamp(remainingMs / totalMs, 0, 1);
    return { overtime, warning, remaining, cleared };
  }

  function applyTick(el, t) {
    const g = el._km;
    if (!g) return;
    const s = timerState(t);
    const instant = el.dataset.kmFresh === '1';
    if (instant) { delete el.dataset.kmFresh; el.classList.add('km-timer-still'); }
    const color = g.stateColors && s.overtime ? g.colors[3] : g.stateColors && s.warning ? g.colors[2] : g.colors[0];
    el.classList.toggle('km-is-over', !!(g.stateColors && s.overtime));
    let shown = s.overtime ? 1 : (g.direction === 'fill' ? 1 - s.remaining : s.remaining);
    if (s.cleared) shown = g.direction === 'fill' ? 0 : 1;
    el._kmShown = shown;
    if (g.kind === 'ring') {
      const fill = el.querySelector('.km-ring-fill');
      if (fill) {
        fill.style.strokeDashoffset = (100 * (1 - shown)).toFixed(3);
        fill.setAttribute('stroke', color);
      }
    } else if (g.kind === 'bar') {
      const fill = el.querySelector('.km-bar-fill');
      if (fill) { setBarFill(el, fill, shown, null); fill.style.background = color; }
    } else if (g.kind === 'dots') {
      const svg = el.querySelector('svg');
      const n = g.count;
      let litFrac;
      if (s.overtime || s.cleared) litFrac = 1;
      else if (g.mode === 'seconds') {
        const sec = Math.ceil(Math.max(0, t.remainingMs || 0) / 1000) % 60;
        litFrac = sec === 0 && (t.remainingMs || 0) > 0 ? 1 : sec / 60;
      } else litFrac = s.remaining;
      if (svg) setDots(svg, g, Math.round(litFrac * n), color);
    }
    if (instant) {
      // Let the jump land first; animate from the next tick on.
      const done = () => el.classList.remove('km-timer-still');
      if (typeof requestAnimationFrame === 'function') requestAnimationFrame(() => requestAnimationFrame(done));
      else done();
    }
  }

  function tick(scope, t) {
    if (!scope || typeof scope.querySelectorAll !== 'function') return;
    scope.querySelectorAll('.km-timer:not(.km-timer-demo)').forEach(el => applyTick(el, t || {}));
  }

  // ── Build-in animations ───────────────────────────────────────────────────
  // How any layer (text, image, shape, motion) arrives when its slide goes
  // live: its own animation, delay and duration, so a slide's pieces can
  // arrive one after another. Each keyframe gives only the starting state, so
  // an element animates into whatever opacity/position its layer already has,
  // and 'backwards' holds that starting state through the delay. Built on
  // opacity, filter, clip-path and the individual translate/scale properties,
  // never `transform`, so it composes with a layer's own rotation/offsets.
  // 'words', 'letters' and 'type' are for text: the layer arrives piece by
  // piece (splitText) instead of all at once.
  const BUILDS = [
    { id: 'none', label: 'None' },
    { id: 'fade', label: 'Fade' },
    { id: 'rise', label: 'Rise' },
    { id: 'drop', label: 'Drop' },
    { id: 'left', label: 'From left' },
    { id: 'right', label: 'From right' },
    { id: 'blur', label: 'Blur in' },
    { id: 'pop', label: 'Pop' },
    { id: 'wipe', label: 'Wipe' },
    { id: 'words', label: 'Word by word', text: true },
    { id: 'letters', label: 'Letter by letter', text: true },
    { id: 'type', label: 'Typewriter', text: true },
  ];
  const TEXT_BUILDS = new Set(BUILDS.filter(b => b.text).map(b => b.id));
  function normalizeBuild(b) {
    const type = b && BUILDS.some(x => x.id === b.type) ? b.type : 'none';
    return {
      type,
      delay: clamp(isNum(b && b.delay) ? b.delay : 0, 0, 20),
      duration: clamp(isNum(b && b.duration) ? b.duration : 0.8, 0.1, 5),
    };
  }
  // How each arrival moves — timed the way a motion designer lands a title:
  // the element is visible within the first stretch (its fade, a separate,
  // shorter animation that ends at the layer's own opacity), any blur clears
  // by about half-way, and the movement itself settles long on an
  // exponential ease-out. A pop overshoots and settles like a spring; a wipe
  // eases in and out. [keyframes, share of the duration, curve]
  const EXPO = 'cubic-bezier(.16,1,.3,1)';
  const FADE = ['kb-fade', 0.45, 'cubic-bezier(.33,1,.68,1)'];
  const BUILD_MOTION = {
    fade: [['kb-fade', 1, 'cubic-bezier(.33,1,.68,1)']],
    rise: [['kb-rise', 1, EXPO], FADE],
    drop: [['kb-drop', 1, EXPO], FADE],
    left: [['kb-left', 1, EXPO], FADE],
    right: [['kb-right', 1, EXPO], FADE],
    blur: [['kb-settle', 1, EXPO], ['kb-unblur', 0.55, 'ease-out'], FADE],
    pop: [['kb-pop', 1, 'cubic-bezier(.22,1,.36,1)'], ['kb-fade', 0.35, 'ease-out']],
    wipe: [['kb-wipe', 1, 'cubic-bezier(.65,0,.35,1)']],
    words: [['kb-word', 1, EXPO], ['kb-unblur', 0.5, 'ease-out'], FADE],
    letters: [['kb-letter', 1, EXPO], ['kb-unblur', 0.5, 'ease-out'], FADE],
    type: [['kb-type', 0.01, 'linear']],
  };
  const motionOf = (type, duration, at) => BUILD_MOTION[type]
    .map(([name, share, curve]) => `${name} ${Math.max(0.01, duration * share).toFixed(3)}s ${curve} ${at.toFixed(3)}s backwards`)
    .join(', ');

  // Returns when the element has fully arrived, in seconds from now.
  function applyBuild(el, build) {
    const b = normalizeBuild(build);
    if (!el || b.type === 'none' || el.nodeType !== 1) return 0;
    ensureStyles(el.ownerDocument);
    // A text build splits the words/letters already in the element; one
    // with nothing to split (an image, a shape) just fades in instead.
    if (TEXT_BUILDS.has(b.type)) {
      const span = splitText(el, b);
      if (span !== null) return b.delay + b.duration + span;
      el.style.animation = appendAnim(el.style.animation, motionOf('fade', b.duration, b.delay));
      return b.delay + b.duration;
    }
    if (b.type === 'blur') el.style.setProperty('--kb-blur', '18px');
    el.style.animation = appendAnim(el.style.animation, motionOf(b.type, b.duration, b.delay));
    return b.delay + b.duration;
  }
  // How far apart the pieces of a text build start — but a long verse never
  // takes more than MAX_STAGGER to lay down: the steps shrink instead.
  const PIECE_STEP = { words: 0.09, letters: 0.035, type: 0.05 };
  const MAX_STAGGER = { words: 1.4, letters: 1.1, type: 3 };
  const appendAnim = (cur, a) => (cur && cur !== 'none' ? `${cur}, ${a}` : a);

  // Wraps each word (or letter) of an element's text in its own span and
  // staggers them in. Walks text nodes, so accent spans ("*word*") and line
  // breaks survive; a letter-by-letter build keeps each word together so a
  // line never wraps mid-word. The whole layer takes about `duration` plus
  // the stagger. Returns the stagger (seconds from the first piece to the
  // last), or null with nothing to split.
  function splitText(el, b) {
    const doc = el.ownerDocument;
    // A text layer's box is a flex column: loose words would each become a
    // row. Everything goes into one flowing span first (unless it already is
    // one — accentHtml's), keeping line breaks.
    const only = el.childNodes.length === 1 ? el.firstChild : null;
    if (!(only && only.nodeType === 1 && only.classList.contains('kairo-rich'))) {
      const flow = doc.createElement('span');
      flow.className = 'kairo-rich';
      flow.style.whiteSpace = 'pre-line';
      while (el.firstChild) flow.appendChild(el.firstChild);
      el.appendChild(flow);
    }
    const walker = doc.createTreeWalker(el, 4 /* NodeFilter.SHOW_TEXT */);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    const pieces = [];
    const piece = (text) => {
      const s = doc.createElement('span');
      s.className = 'kb-piece';
      s.textContent = text;
      pieces.push(s);
      return s;
    };
    nodes.forEach(node => {
      const frag = doc.createDocumentFragment();
      node.nodeValue.split(/(\s+)/).forEach(part => {
        if (!part) return;
        if (/^\s+$/.test(part)) { frag.appendChild(doc.createTextNode(part)); return; }
        if (b.type === 'words') { frag.appendChild(piece(part)); return; }
        const word = doc.createElement('span');
        word.className = 'kb-word-wrap';
        for (const ch of part) word.appendChild(piece(ch));
        frag.appendChild(word);
      });
      node.parentNode.replaceChild(frag, node);
    });
    if (!pieces.length) return null;
    // A typewriter keeps an even rhythm. Words and letters start close
    // together and spread out towards the end — the wave of arrivals itself
    // eases out, so the line lands rather than ticking in like a metronome.
    const n = pieces.length;
    const span = Math.min(PIECE_STEP[b.type] * (n - 1), MAX_STAGGER[b.type]);
    const spread = b.type === 'type' ? (t) => t : (t) => 1 - Math.pow(1 - t, 0.75);
    if (b.type !== 'type') el.style.setProperty('--kb-blur', b.type === 'words' ? '8px' : '5px');
    pieces.forEach((s, k) => {
      s.style.animation = motionOf(b.type, b.duration, b.delay + (n > 1 ? span * spread(k / (n - 1)) : 0));
    });
    return span;
  }

  // ── Idle motion ───────────────────────────────────────────────────────────
  // What a layer keeps doing once it has arrived: a slow float, drift,
  // breathe, sway or pulse, so a held slide never sits dead still. amount is
  // 1-100; `unit` is one percent of the stage's height as a CSS length
  // (the output uses 1vh, a small preview its own pixels), so a float covers
  // the same share of the screen at any size. Starts after `delay` (the
  // layer's build) so the two never fight over the same property, and from
  // where the layer is at rest: float, breathe and pulse go out and back
  // (alternate); drift and sway swing both ways from the middle in one
  // cycle, so neither snaps sideways the moment it starts.
  const IDLES = [
    { id: 'none', label: 'None' },
    { id: 'float', label: 'Float' },
    { id: 'drift', label: 'Drift' },
    { id: 'breathe', label: 'Breathe' },
    { id: 'sway', label: 'Sway' },
    { id: 'pulse', label: 'Pulse' },
  ];
  function normalizeIdle(m) {
    const type = m && IDLES.some(x => x.id === m.type) ? m.type : 'none';
    return {
      type,
      amount: clamp(isNum(m && m.amount) ? m.amount : 40, 1, 100),
      speed: clamp(isNum(m && m.speed) ? m.speed : 1, 0.1, 3),
    };
  }
  function applyIdle(el, idle, opts = {}) {
    const m = normalizeIdle(idle);
    if (!el || m.type === 'none' || el.nodeType !== 1) return;
    ensureStyles(el.ownerDocument);
    el.style.setProperty('--ku', opts.unit || '1vh');
    el.style.setProperty('--ka', (m.amount / 50).toFixed(3));
    const base = { float: 5, drift: 11, breathe: 6, sway: 7, pulse: 3.2 }[m.type];
    const swing = m.type === 'drift' || m.type === 'sway';   // one iteration = there and back
    const dur = (swing ? base * 2 : base) / m.speed;
    const delay = Math.max(0, Number(opts.delay) || 0);
    // A sine ease — the one for breathing and floating loops: soft at every
    // turn. A float also tilts, very slightly, on its own longer cycle (the
    // golden ratio of the float's): the two never line up, so it never
    // repeats exactly and reads as alive rather than looped.
    const SINE = 'cubic-bezier(.37,0,.63,1)';
    el.style.animation = appendAnim(el.style.animation, `ki-${m.type} ${dur.toFixed(2)}s ${SINE} ${delay.toFixed(2)}s infinite${swing ? '' : ' alternate'}`);
    if (m.type === 'float') el.style.animation = appendAnim(el.style.animation, `ki-tilt ${(dur * 2 * 1.618).toFixed(2)}s ${SINE} ${delay.toFixed(2)}s infinite`);
  }

  // ── Scene pacing ──────────────────────────────────────────────────────────
  // Which of a timer segment's scenes is on screen, `elapsedMs` into a
  // countdown of `totalMs`. Two paces (segment.scenePace):
  //   'fixed'     — each scene runs its own durationSec in order; the last one
  //                 holds for whatever time is left (the original behaviour).
  //   'countdown' — the countdown sets the pace: the scenes share the time
  //                 equally, so a shorter countdown moves faster. On a long
  //                 countdown the set repeats so no scene stays up longer than
  //                 maxSec. With finaleSec, the last scene is held back for
  //                 the final stretch ("Service begins") — never more than a
  //                 quarter of a short countdown — and holds through overtime.
  // Returns { index, sceneElapsedMs, slotMs, slot } — `slot` counts every
  // change, so a scene coming round again still counts as a new showing.
  function normalizePace(p) {
    const mode = p && p.mode === 'countdown' ? 'countdown' : 'fixed';
    return {
      mode,
      maxSec: clamp(isNum(p && p.maxSec) ? p.maxSec : 30, 5, 600),
      finaleSec: clamp(isNum(p && p.finaleSec) ? p.finaleSec : 60, 0, 600),
      transition: p && ['blur', 'fade', 'cut'].includes(p.transition) ? p.transition : 'blur',
    };
  }
  function sceneAt(scenes, pace, elapsedMs, totalMs) {
    const n = Array.isArray(scenes) ? scenes.length : 0;
    const e = Math.max(0, Number(elapsedMs) || 0);
    if (!n) return { index: 0, sceneElapsedMs: e, slotMs: 0, slot: 0 };
    const p = normalizePace(pace);
    if (p.mode !== 'countdown' || !(totalMs > 0)) {
      let cum = 0;
      for (let i = 0; i < n; i++) {
        const durMs = Math.max(0, Number(scenes[i].durationSec) || 0) * 1000;
        if (i === n - 1 || e < cum + durMs) return { index: i, sceneElapsedMs: Math.max(0, e - cum), slotMs: durMs, slot: i };
        cum += durMs;
      }
      return { index: n - 1, sceneElapsedMs: 0, slotMs: 0, slot: n - 1 };
    }
    const finale = p.finaleSec > 0 && n >= 2;
    const finaleMs = finale ? Math.min(p.finaleSec * 1000, totalMs * 0.25) : 0;
    const rotation = finale ? n - 1 : n;
    const spanMs = totalMs - finaleMs;
    const passes = Math.max(1, Math.ceil(spanMs / (rotation * p.maxSec * 1000)));
    const slotMs = spanMs / (rotation * passes);
    const slots = rotation * passes;
    if (e >= spanMs) {
      if (finale) return { index: n - 1, sceneElapsedMs: e - spanMs, slotMs: finaleMs, slot: slots };
      return { index: (slots - 1) % rotation, sceneElapsedMs: e - (slots - 1) * slotMs, slotMs, slot: slots - 1 };
    }
    const slot = Math.floor(e / slotMs);
    return { index: slot % rotation, sceneElapsedMs: e - slot * slotMs, slotMs, slot };
  }

  const api = {
    KINDS, kinds: () => KINDS.slice(), kind: kindOf, isTimerKind, defaults, create, normalize, switchKind,
    build, tick, ensureStyles, timerState, rgba, rng, newSeed,
    BUILDS, normalizeBuild, applyBuild, splitText, IDLES, normalizeIdle, applyIdle, LINE_SHAPES, ARROW_SHAPES,
    normalizePace, sceneAt,
    // Build first, then idle motion from the moment the build has landed —
    // the one call every renderer makes per layer element.
    animateLayer(el, layer, opts = {}) {
      const settle = opts.builds ? applyBuild(el, layer && layer.build) : 0;
      applyIdle(el, layer && layer.idle, { unit: opts.unit, delay: settle });
    },
  };
  root.KairoMotion = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
