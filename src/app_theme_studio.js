// KAIRO — Theme Studio (theme + item editing: layers, canvas, properties, undo/redo,
// image layers, theme import/export). Split out of app.js; loaded right after it and
// sharing its global scope, in the same top-level order as before the split.

// ── Theme Studio ──────────────────────────────────────────────────────────

const FONTS = [
  { label: 'Manrope',            value: 'Manrope',            google: true  },
  { label: 'Inter',              value: 'Inter',              google: true  },
  { label: 'Montserrat',         value: 'Montserrat',         google: true  },
  { label: 'Raleway',            value: 'Raleway',            google: true  },
  { label: 'Open Sans',          value: 'Open Sans',          google: true  },
  { label: 'Playfair Display',   value: 'Playfair Display',   google: true  },
  { label: 'Cormorant Garamond', value: 'Cormorant Garamond', google: true  },
  { label: 'EB Garamond',        value: 'EB Garamond',        google: true  },
  { label: 'Cinzel',             value: 'Cinzel',             google: true  },
  { label: 'Bebas Neue',         value: 'Bebas Neue',         google: true  },
  { label: 'Anton',              value: 'Anton',              google: true  },
  { label: 'Archivo Black',      value: 'Archivo Black',      google: true  },
  { label: 'System UI',          value: 'system-ui',          google: false },
];


// Weights named the way a font names them, not raw numbers.
const FONT_WEIGHTS = [
  { label: 'Thin',        value: 100 },
  { label: 'Extra Light', value: 200 },
  { label: 'Light',       value: 300 },
  { label: 'Regular',     value: 400 },
  { label: 'Medium',      value: 500 },
  { label: 'Semi Bold',   value: 600 },
  { label: 'Bold',        value: 700 },
  { label: 'Extra Bold',  value: 800 },
  { label: 'Black',       value: 900 },
];


// Real, installed-on-this-machine font families (fonts.rs, macOS via Core
// Text) merged into the curated Google Fonts list above — an operator's
// own installed font (a church brand font, anything from a design pack)
// had no way to even show up in Theme Studio's font picker before this,
// even though the real output is just a WebKit view that would happily
// render it by name if it were only in the list. Runs once at boot;
// non-macOS (or this file open with no Tauri bridge at all, e.g. a plain
// browser tab for testing) just keeps the curated list exactly as it was.
// Retries with backoff rather than one attempt — same real bug as
// loadAuthToken's own comment above documents: on a fresh/cold launch the
// injected `window.__TAURI__` bridge can attach a tick or two after this
// script starts running, and the original single `if (!inv) return;` check
// treated that race as "not running in Tauri at all", giving up on system
// fonts forever for the rest of the session with nothing to explain why
// they'd sometimes show up and sometimes not, purely depending on load
// timing. That established retry pattern just never got applied here when
// this was added.
async function loadSystemFonts(attempts = 5, delayMs = 200) {
  // Visible outcome either way — this exact class of bug (a command that
  // silently returns nothing, with no error to explain why) is what the
  // display-lifecycle logging elsewhere in this file exists to catch; the
  // same blind spot applied here with no way to tell "the bridge never
  // came up" from "the command ran and genuinely found zero fonts" from
  // "it threw" apart, short of a debugger.
  const report = (outcome, extra) => {
    fetch(`${SERVER}/api/debug-log`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'system-fonts', data: { outcome, ...extra } }),
    }).catch(() => {});
  };
  for (let i = 0; i < attempts; i++) {
    const inv = window.__TAURI__?.core?.invoke || window.__TAURI__?.invoke;
    if (inv) {
      try {
        const names = await inv('list_system_fonts');
        if (Array.isArray(names) && names.length) {
          const known = new Set(FONTS.map(f => f.value));
          let added = 0;
          names.forEach(name => {
            if (!name || known.has(name)) return;
            known.add(name);
            FONTS.push({ label: name, value: name, google: false });
            added++;
          });
          FONTS.sort((a, b) => a.label.localeCompare(b.label));
          report('ok', { returned: names.length, added, attempt: i + 1 });
          // A font picker already open (sitting on the Style tab) just
          // missed these — refresh it in place instead of requiring a
          // re-select.
          if (typeof renderProps === 'function' && activeLayer?.type === 'text') renderProps();
          return;
        }
        report('empty-result', { attempt: i + 1, isArray: Array.isArray(names), length: names?.length });
      } catch (err) {
        report('invoke-threw', { attempt: i + 1, message: err?.message || String(err) });
      }
    } else {
      report('no-bridge-yet', { attempt: i + 1 });
    }
    await new Promise(r => setTimeout(r, delayMs * (i + 1)));
  }
  report('gave-up', { attempts });
}
loadSystemFonts();

// ── Canonical theme variants ──────────────────────────────────────────────
// Deliberately a short, purposeful set rather than a sprawl of near-duplicates:
//   1. Full — Background      opaque canvas, verse centred
//   2. Full — Transparent     same geometry, keyed canvas (chroma / alpha rigs)
//   3. Lower Third            independently coloured verse + reference bands
//   4/5. Split Left / Right   one half filled, the other fully transparent
// Every layer carries an explicit `pos` (1920×1080 design space) so the canvas
// is free-form from the start — drag anything, nothing is locked to a preset.
const LOOKS_KEY = 'kairo-looks-v3';
const TXT_SHADOW_SOFT = { enabled: true,  color: '#000000', opacity: 70, blur: 12, x: 0, y: 3 };
const TXT_SHADOW_NONE = { enabled: false, color: '#000000', opacity: 70, blur: 4,  x: 0, y: 1 };
const NO_OUTLINE      = { enabled: false, color: '#000000', width: 2 };

// Four small placeholder frames (complementary warm/cool gradients, no
// real photos needed) so the "Timer — Pre-Service Split" preset below —
// and Full-scale edit's "Load sample images" button for any Image Cycle
// layer, see renderImageCycleProps — can be seen actually cycling right
// away, without the operator having to source real images first. Declared
// up here (not next to renderImageCycleProps, where it's also used) since
// DEFAULT_LOOKS' own loadLooks() migration runs immediately at script
// load, not later like everything else that forward-references code
// further down this file — it needs this to already exist.
const SAMPLE_CYCLE_IMAGES = [
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxOTIwIiBoZWlnaHQ9IjEwODAiIHZpZXdCb3g9IjAgMCAxOTIwIDEwODAiPgogIDxkZWZzPgogICAgPGxpbmVhckdyYWRpZW50IGlkPSJnIiB4MT0iMCIgeTE9IjAiIHgyPSIxIiB5Mj0iMSI+CiAgICAgIDxzdG9wIG9mZnNldD0iMCIgc3RvcC1jb2xvcj0iIzEyM2IzMiIvPgogICAgICA8c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiMxZjVjNGQiLz4KICAgIDwvbGluZWFyR3JhZGllbnQ+CiAgPC9kZWZzPgogIDxyZWN0IHdpZHRoPSIxOTIwIiBoZWlnaHQ9IjEwODAiIGZpbGw9InVybCgjZykiLz4KICA8Y2lyY2xlIGN4PSIxNjUwIiBjeT0iMTgwIiByPSIyNjAiIGZpbGw9IiNlOGMyN2EiIG9wYWNpdHk9IjAuMDgiLz4KICA8Y2lyY2xlIGN4PSIyMjAiIGN5PSI5MjAiIHI9IjM0MCIgZmlsbD0iI2U4YzI3YSIgb3BhY2l0eT0iMC4wNiIvPgogIDx0ZXh0IHg9Ijk2MCIgeT0iNTAwIiBmb250LWZhbWlseT0iR2VvcmdpYSwgc2VyaWYiIGZvbnQtc2l6ZT0iMTUwIiBmaWxsPSIjZThjMjdhIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmb250LXdlaWdodD0iNzAwIj5XRUxDT01FPC90ZXh0PgogIDx0ZXh0IHg9Ijk2MCIgeT0iNjAwIiBmb250LWZhbWlseT0iQXJpYWwsIHNhbnMtc2VyaWYiIGZvbnQtc2l6ZT0iNDIiIGZpbGw9IiNmZmZmZmZjYyIgdGV4dC1hbmNob3I9Im1pZGRsZSIgbGV0dGVyLXNwYWNpbmc9IjIiPldlIGFyZSBnbGFkIHlvdSBhcmUgaGVyZTwvdGV4dD4KICA8cmVjdCB4PSI4NjAiIHk9IjY2MCIgd2lkdGg9IjIwMCIgaGVpZ2h0PSI0IiBmaWxsPSIjZThjMjdhIi8+Cjwvc3ZnPg==',
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxOTIwIiBoZWlnaHQ9IjEwODAiIHZpZXdCb3g9IjAgMCAxOTIwIDEwODAiPgogIDxkZWZzPgogICAgPGxpbmVhckdyYWRpZW50IGlkPSJnIiB4MT0iMCIgeTE9IjAiIHgyPSIxIiB5Mj0iMSI+CiAgICAgIDxzdG9wIG9mZnNldD0iMCIgc3RvcC1jb2xvcj0iIzVjM2ExZiIvPgogICAgICA8c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiM4YTVhMmMiLz4KICAgIDwvbGluZWFyR3JhZGllbnQ+CiAgPC9kZWZzPgogIDxyZWN0IHdpZHRoPSIxOTIwIiBoZWlnaHQ9IjEwODAiIGZpbGw9InVybCgjZykiLz4KICA8Y2lyY2xlIGN4PSIxNjUwIiBjeT0iMTgwIiByPSIyNjAiIGZpbGw9IiNmNmU4Y2YiIG9wYWNpdHk9IjAuMDgiLz4KICA8Y2lyY2xlIGN4PSIyMjAiIGN5PSI5MjAiIHI9IjM0MCIgZmlsbD0iI2Y2ZThjZiIgb3BhY2l0eT0iMC4wNiIvPgogIDx0ZXh0IHg9Ijk2MCIgeT0iNTAwIiBmb250LWZhbWlseT0iR2VvcmdpYSwgc2VyaWYiIGZvbnQtc2l6ZT0iMTUwIiBmaWxsPSIjZjZlOGNmIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmb250LXdlaWdodD0iNzAwIj5TVEFSVElORyBTT09OPC90ZXh0PgogIDx0ZXh0IHg9Ijk2MCIgeT0iNjAwIiBmb250LWZhbWlseT0iQXJpYWwsIHNhbnMtc2VyaWYiIGZvbnQtc2l6ZT0iNDIiIGZpbGw9IiNmZmZmZmZjYyIgdGV4dC1hbmNob3I9Im1pZGRsZSIgbGV0dGVyLXNwYWNpbmc9IjIiPlBsZWFzZSBmaW5kIHlvdXIgc2VhdDwvdGV4dD4KICA8cmVjdCB4PSI4NjAiIHk9IjY2MCIgd2lkdGg9IjIwMCIgaGVpZ2h0PSI0IiBmaWxsPSIjZjZlOGNmIi8+Cjwvc3ZnPg==',
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxOTIwIiBoZWlnaHQ9IjEwODAiIHZpZXdCb3g9IjAgMCAxOTIwIDEwODAiPgogIDxkZWZzPgogICAgPGxpbmVhckdyYWRpZW50IGlkPSJnIiB4MT0iMCIgeTE9IjAiIHgyPSIxIiB5Mj0iMSI+CiAgICAgIDxzdG9wIG9mZnNldD0iMCIgc3RvcC1jb2xvcj0iIzBmMmQzZCIvPgogICAgICA8c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiMxYzRmNjMiLz4KICAgIDwvbGluZWFyR3JhZGllbnQ+CiAgPC9kZWZzPgogIDxyZWN0IHdpZHRoPSIxOTIwIiBoZWlnaHQ9IjEwODAiIGZpbGw9InVybCgjZykiLz4KICA8Y2lyY2xlIGN4PSIxNjUwIiBjeT0iMTgwIiByPSIyNjAiIGZpbGw9IiNlOGMyN2EiIG9wYWNpdHk9IjAuMDgiLz4KICA8Y2lyY2xlIGN4PSIyMjAiIGN5PSI5MjAiIHI9IjM0MCIgZmlsbD0iI2U4YzI3YSIgb3BhY2l0eT0iMC4wNiIvPgogIDx0ZXh0IHg9Ijk2MCIgeT0iNTAwIiBmb250LWZhbWlseT0iR2VvcmdpYSwgc2VyaWYiIGZvbnQtc2l6ZT0iMTUwIiBmaWxsPSIjZThjMjdhIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmb250LXdlaWdodD0iNzAwIj5QUkUtU0VSVklDRTwvdGV4dD4KICA8dGV4dCB4PSI5NjAiIHk9IjYwMCIgZm9udC1mYW1pbHk9IkFyaWFsLCBzYW5zLXNlcmlmIiBmb250LXNpemU9IjQyIiBmaWxsPSIjZmZmZmZmY2MiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGxldHRlci1zcGFjaW5nPSIyIj5Xb3JzaGlwIGJlZ2lucyBzaG9ydGx5PC90ZXh0PgogIDxyZWN0IHg9Ijg2MCIgeT0iNjYwIiB3aWR0aD0iMjAwIiBoZWlnaHQ9IjQiIGZpbGw9IiNlOGMyN2EiLz4KPC9zdmc+',
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciIHdpZHRoPSIxOTIwIiBoZWlnaHQ9IjEwODAiIHZpZXdCb3g9IjAgMCAxOTIwIDEwODAiPgogIDxkZWZzPgogICAgPGxpbmVhckdyYWRpZW50IGlkPSJnIiB4MT0iMCIgeTE9IjAiIHgyPSIxIiB5Mj0iMSI+CiAgICAgIDxzdG9wIG9mZnNldD0iMCIgc3RvcC1jb2xvcj0iIzNhMWYyZSIvPgogICAgICA8c3RvcCBvZmZzZXQ9IjEiIHN0b3AtY29sb3I9IiM1YzJmNDciLz4KICAgIDwvbGluZWFyR3JhZGllbnQ+CiAgPC9kZWZzPgogIDxyZWN0IHdpZHRoPSIxOTIwIiBoZWlnaHQ9IjEwODAiIGZpbGw9InVybCgjZykiLz4KICA8Y2lyY2xlIGN4PSIxNjUwIiBjeT0iMTgwIiByPSIyNjAiIGZpbGw9IiNmMGM5YTAiIG9wYWNpdHk9IjAuMDgiLz4KICA8Y2lyY2xlIGN4PSIyMjAiIGN5PSI5MjAiIHI9IjM0MCIgZmlsbD0iI2YwYzlhMCIgb3BhY2l0eT0iMC4wNiIvPgogIDx0ZXh0IHg9Ijk2MCIgeT0iNTAwIiBmb250LWZhbWlseT0iR2VvcmdpYSwgc2VyaWYiIGZvbnQtc2l6ZT0iMTUwIiBmaWxsPSIjZjBjOWEwIiB0ZXh0LWFuY2hvcj0ibWlkZGxlIiBmb250LXdlaWdodD0iNzAwIj5BTE1PU1QgVElNRTwvdGV4dD4KICA8dGV4dCB4PSI5NjAiIHk9IjYwMCIgZm9udC1mYW1pbHk9IkFyaWFsLCBzYW5zLXNlcmlmIiBmb250LXNpemU9IjQyIiBmaWxsPSIjZmZmZmZmY2MiIHRleHQtYW5jaG9yPSJtaWRkbGUiIGxldHRlci1zcGFjaW5nPSIyIj5TaWxlbmNlIHlvdXIgcGhvbmVzPC90ZXh0PgogIDxyZWN0IHg9Ijg2MCIgeT0iNjYwIiB3aWR0aD0iMjAwIiBoZWlnaHQ9IjQiIGZpbGw9IiNmMGM5YTAiLz4KPC9zdmc+',
];

// A built-in theme's canvas filled with one of the bundled backgrounds
// (src/backgrounds, see backgrounds/backgrounds.js). Its colour is the
// picture's average — shown while it loads, and kept if the fill is switched
// to Solid; color2/angle are the old default gradient, there for Gradient.
function poolColor(id) {
  return (window.KairoBackgrounds || []).find(b => b.id === id)?.color || '#0b0b0f';
}
function poolCanvas(id) {
  return { id: 'bg', type: 'background', name: 'Canvas', visible: true,
    fill: 'image', src: `backgrounds/${id}.jpg`, color: poolColor(id), opacity: 100, color2: '#1c1c30', angle: 160 };
}

const DEFAULT_LOOKS = [
  {
    id: 'full-bg', name: 'Full — Background', layout: 'fullscreen', animation: 'fade',
    groupId: 'grp-bible', groupName: 'Bible',
    layers: [
      poolCanvas('midnight'),
      // h bumped 440 -> 700 (y unchanged) — owner: "for full screen or block
      // themes, the text area should use a sizable height by default so
      // that text don't cut off due to the constraint." A fixed-height text
      // box centers short verses fine but visibly overflows/clips a long
      // one against the canvas edge once wrapped content exceeds it — this
      // just gives real headroom before that risk, without going fully
      // unconstrained (h:0) and losing the vertical-centering short verses
      // rely on. Reference line's own y moved down to match (was directly
      // under the old, shorter box).
      { id: 'verse', type: 'text', name: 'Verse', visible: true, binding: 'verse', customText: '',
        pos: { x: 210, y: 80, w: 1500, h: 700 },
        font: { family: 'Manrope', size: 64, weight: 500, italic: false, lineHeight: 1.35, letterSpacing: 0, transform: 'none' },
        color: '#ffffff', opacity: 100, align: 'center',
        shadow: { ...TXT_SHADOW_SOFT }, outline: { ...NO_OUTLINE } },
      { id: 'ref', type: 'text', name: 'Reference', visible: true, binding: 'reference', customText: '',
        pos: { x: 210, y: 820, w: 1500, h: 0 },
        font: { family: 'Manrope', size: 28, weight: 600, italic: false, lineHeight: 1.2, letterSpacing: 4, transform: 'uppercase' },
        color: '#ffffff', opacity: 60, align: 'center',
        shadow: { ...TXT_SHADOW_NONE }, outline: { ...NO_OUTLINE } },
    ],
  },
  {
    // Identical geometry to Full — Background, but the canvas is keyed out.
    // Heavier shadow + outline so the text survives over any live source.
    id: 'full-alpha', name: 'Full — Transparent', layout: 'fullscreen', animation: 'fade',
    groupId: 'grp-bible', groupName: 'Bible',
    layers: [
      { id: 'bg', type: 'background', name: 'Canvas', visible: true,
        fill: 'transparent', fillBefore: 'solid', color: '#000000', opacity: 100, color2: '#1c1c30', angle: 160 },
      // Same h/ref-y adjustment as Full — Background, see its own comment.
      { id: 'verse', type: 'text', name: 'Verse', visible: true, binding: 'verse', customText: '',
        pos: { x: 210, y: 80, w: 1500, h: 700 },
        font: { family: 'Manrope', size: 64, weight: 600, italic: false, lineHeight: 1.35, letterSpacing: 0, transform: 'none' },
        color: '#ffffff', opacity: 100, align: 'center',
        shadow: { enabled: true, color: '#000000', opacity: 85, blur: 18, x: 0, y: 4 },
        outline: { enabled: true, color: '#000000', width: 2 } },
      { id: 'ref', type: 'text', name: 'Reference', visible: true, binding: 'reference', customText: '',
        pos: { x: 210, y: 820, w: 1500, h: 0 },
        font: { family: 'Manrope', size: 28, weight: 700, italic: false, lineHeight: 1.2, letterSpacing: 4, transform: 'uppercase' },
        color: '#ffffff', opacity: 85, align: 'center',
        shadow: { enabled: true, color: '#000000', opacity: 85, blur: 10, x: 0, y: 2 },
        outline: { ...NO_OUTLINE } },
    ],
  },
  {
    // Two independent bands so the verse section and the reference section can
    // be recoloured separately — select either band layer and change its fill.
    id: 'lower-third', name: 'Lower Third', layout: 'lower-third', animation: 'slide-up',
    groupId: 'grp-bible', groupName: 'Bible',
    layers: [
      { id: 'bg', type: 'background', name: 'Canvas', visible: true,
        fill: 'transparent', fillBefore: 'solid', color: '#000000', opacity: 100, color2: '#000000', angle: 0 },
      { id: 'band-verse', type: 'background', name: 'Verse Band', visible: true,
        fill: 'solid', color: '#0a0e14', opacity: 95, color2: '#0a0e14', angle: 0, radius: 0,
        pos: { x: 0, y: 754, w: 1920, h: 206 } },
      { id: 'band-ref', type: 'background', name: 'Reference Band', visible: true,
        fill: 'solid', color: '#e8404a', opacity: 100, color2: '#8a2128', angle: 90, radius: 0,
        pos: { x: 0, y: 960, w: 1920, h: 76 } },
      { id: 'verse', type: 'text', name: 'Verse', visible: true, binding: 'verse', customText: '',
        pos: { x: 96, y: 784, w: 1728, h: 150 },
        font: { family: 'Manrope', size: 44, weight: 500, italic: false, lineHeight: 1.3, letterSpacing: 0, transform: 'none' },
        color: '#ffffff', opacity: 100, align: 'left',
        shadow: { ...TXT_SHADOW_NONE }, outline: { ...NO_OUTLINE } },
      { id: 'ref', type: 'text', name: 'Reference', visible: true, binding: 'reference', customText: '',
        pos: { x: 96, y: 980, w: 1728, h: 0 },
        font: { family: 'Manrope', size: 22, weight: 800, italic: false, lineHeight: 1.2, letterSpacing: 6, transform: 'uppercase' },
        color: '#ffffff', opacity: 100, align: 'left',
        shadow: { ...TXT_SHADOW_NONE }, outline: { ...NO_OUTLINE } },
    ],
  },
  {
    // Lyrics default. Transparent canvas so it keys straight over camera or
    // motion backgrounds, and a heavy block face sized for the two-line chunks
    // the playlist produces — big, centred, no panel behind it. The reference
    // line doubles as the song title.
    id: 'lyrics-block', name: 'Lyrics — Block', layout: 'fullscreen', animation: 'fade',
    groupId: 'grp-lyrics', groupName: 'Lyrics',
    layers: [
      { id: 'bg', type: 'background', name: 'Canvas', visible: true,
        fill: 'transparent', fillBefore: 'solid', color: '#000000', opacity: 100, color2: '#000000', angle: 0 },
      // h bumped 380 -> 600, grown symmetrically around its old vertical
      // center (still leaves a real gap before the Song Title line below)
      // — same "sizable height by default" fix as Full — Background/
      // Transparent above; this heavy 96px block face was the tightest of
      // the three named directly ("Lyrics — Block") in the owner's report.
      { id: 'verse', type: 'text', name: 'Lyrics', visible: true, binding: 'verse', customText: '',
        pos: { x: 140, y: 250, w: 1640, h: 600 },
        font: { family: 'Montserrat', size: 96, weight: 800, italic: false, lineHeight: 1.22, letterSpacing: 0, transform: 'uppercase' },
        color: '#ffffff', opacity: 100, align: 'center',
        shadow: { enabled: true, color: '#000000', opacity: 85, blur: 22, x: 0, y: 4 },
        outline: { enabled: true, color: '#000000', width: 2 } },
      { id: 'ref', type: 'text', name: 'Song Title', visible: false, binding: 'reference', customText: '',
        pos: { x: 140, y: 880, w: 1640, h: 0 },
        font: { family: 'Montserrat', size: 26, weight: 600, italic: false, lineHeight: 1.2, letterSpacing: 6, transform: 'uppercase' },
        color: '#ffffff', opacity: 55, align: 'center',
        shadow: { enabled: true, color: '#000000', opacity: 80, blur: 10, x: 0, y: 2 },
        outline: { ...NO_OUTLINE } },
    ],
  },
  {
    // Filled left half, fully transparent right half — the right side keys out
    // so a camera / lyric feed shows through on a chroma or alpha rig.
    id: 'split-left', name: 'Split — Left', layout: 'split-left', animation: 'slide-up',
    groupId: 'grp-bible', groupName: 'Bible',
    layers: [
      { id: 'bg', type: 'background', name: 'Canvas', visible: true,
        fill: 'transparent', fillBefore: 'solid', color: '#000000', opacity: 100, color2: '#000000', angle: 0 },
      { id: 'panel', type: 'background', name: 'Filled Half', visible: true,
        fill: 'image', src: 'backgrounds/midnight.jpg', color: poolColor('midnight'), opacity: 100, color2: '#1c1c30', angle: 160, radius: 0,
        pos: { x: 0, y: 0, w: 960, h: 1080 } },
      { id: 'verse', type: 'text', name: 'Verse', visible: true, binding: 'verse', customText: '',
        pos: { x: 88, y: 300, w: 784, h: 430 },
        font: { family: 'Manrope', size: 44, weight: 500, italic: false, lineHeight: 1.4, letterSpacing: 0, transform: 'none' },
        color: '#ffffff', opacity: 100, align: 'center',
        shadow: { ...TXT_SHADOW_NONE }, outline: { ...NO_OUTLINE } },
      { id: 'ref', type: 'text', name: 'Reference', visible: true, binding: 'reference', customText: '',
        pos: { x: 88, y: 762, w: 784, h: 0 },
        font: { family: 'Manrope', size: 22, weight: 700, italic: false, lineHeight: 1.2, letterSpacing: 5, transform: 'uppercase' },
        color: '#ffffff', opacity: 65, align: 'center',
        shadow: { ...TXT_SHADOW_NONE }, outline: { ...NO_OUTLINE } },
    ],
  },
  {
    // Mirror of Split — Left: filled right half, transparent left half.
    id: 'split-right', name: 'Split — Right', layout: 'split-right', animation: 'slide-up',
    groupId: 'grp-bible', groupName: 'Bible',
    layers: [
      { id: 'bg', type: 'background', name: 'Canvas', visible: true,
        fill: 'transparent', fillBefore: 'solid', color: '#000000', opacity: 100, color2: '#000000', angle: 0 },
      { id: 'panel', type: 'background', name: 'Filled Half', visible: true,
        fill: 'image', src: 'backgrounds/midnight.jpg', color: poolColor('midnight'), opacity: 100, color2: '#1c1c30', angle: 160, radius: 0,
        pos: { x: 960, y: 0, w: 960, h: 1080 } },
      { id: 'verse', type: 'text', name: 'Verse', visible: true, binding: 'verse', customText: '',
        pos: { x: 1048, y: 300, w: 784, h: 430 },
        font: { family: 'Manrope', size: 44, weight: 500, italic: false, lineHeight: 1.4, letterSpacing: 0, transform: 'none' },
        color: '#ffffff', opacity: 100, align: 'center',
        shadow: { ...TXT_SHADOW_NONE }, outline: { ...NO_OUTLINE } },
      { id: 'ref', type: 'text', name: 'Reference', visible: true, binding: 'reference', customText: '',
        pos: { x: 1048, y: 762, w: 784, h: 0 },
        font: { family: 'Manrope', size: 22, weight: 700, italic: false, lineHeight: 1.2, letterSpacing: 5, transform: 'uppercase' },
        color: '#ffffff', opacity: 65, align: 'center',
        shadow: { ...TXT_SHADOW_NONE }, outline: { ...NO_OUTLINE } },
    ],
  },
  {
    // Same left/right split geometry as Split — Left/Right, but both halves
    // are filled (one screen, two languages) instead of one side keying out.
    // One picture runs across the screen; the right panel darkens it more —
    // that's the only visual difference between the two sides, by design —
    // so the source language (left) and translation (right) read as two
    // distinct panels at a glance. Right side text uses the 'verse_translated'
    // / (shared) 'reference' bindings; the item's `translateTo` language code
    // decides what actually fills that binding — see getTranslatedText() in
    // service.js for the resolution + caching logic.
    id: 'multi-language', name: 'Multi-Language', layout: 'multi-language', animation: 'fade',
    groupId: 'grp-bible', groupName: 'Bible',
    layers: [
      poolCanvas('midnight'),
      { id: 'panel-left', type: 'background', name: 'Left Panel', visible: true,
        fill: 'solid', color: '#000000', opacity: 10, color2: '#1c1c30', angle: 160, radius: 0,
        pos: { x: 0, y: 0, w: 960, h: 1080 } },
      { id: 'panel-right', type: 'background', name: 'Right Panel (darker)', visible: true,
        fill: 'solid', color: '#000000', opacity: 45, color2: '#0a0a12', angle: 160, radius: 0,
        pos: { x: 960, y: 0, w: 960, h: 1080 } },
      { id: 'verse', type: 'text', name: 'Verse (source)', visible: true, binding: 'verse', customText: '',
        pos: { x: 88, y: 300, w: 784, h: 430 },
        font: { family: 'Manrope', size: 40, weight: 500, italic: false, lineHeight: 1.4, letterSpacing: 0, transform: 'none' },
        color: '#ffffff', opacity: 100, align: 'center',
        shadow: { ...TXT_SHADOW_NONE }, outline: { ...NO_OUTLINE } },
      { id: 'ref', type: 'text', name: 'Reference (source)', visible: true, binding: 'reference', customText: '',
        pos: { x: 88, y: 762, w: 784, h: 0 },
        font: { family: 'Manrope', size: 20, weight: 700, italic: false, lineHeight: 1.2, letterSpacing: 5, transform: 'uppercase' },
        color: '#ffffff', opacity: 65, align: 'center',
        shadow: { ...TXT_SHADOW_NONE }, outline: { ...NO_OUTLINE } },
      { id: 'verse-translated', type: 'text', name: 'Verse (translated)', visible: true, binding: 'verse_translated', customText: '',
        pos: { x: 1048, y: 300, w: 784, h: 430 },
        font: { family: 'Manrope', size: 40, weight: 500, italic: false, lineHeight: 1.4, letterSpacing: 0, transform: 'none' },
        color: '#ffffff', opacity: 100, align: 'center',
        shadow: { ...TXT_SHADOW_NONE }, outline: { ...NO_OUTLINE } },
      { id: 'ref-translated', type: 'text', name: 'Reference (translated)', visible: true, binding: 'reference', customText: '',
        pos: { x: 1048, y: 762, w: 784, h: 0 },
        font: { family: 'Manrope', size: 20, weight: 700, italic: false, lineHeight: 1.2, letterSpacing: 5, transform: 'uppercase' },
        color: '#ffffff', opacity: 65, align: 'center',
        shadow: { ...TXT_SHADOW_NONE }, outline: { ...NO_OUTLINE } },
    ],
  },
  {
    // Transparent lower-third for keying over a live camera/backdrop, stacked
    // two-language reading: up to two lines of the source language on top,
    // one line of the translated language directly beneath it. Unlike
    // Multi-Language's side-by-side split, both languages share one lower
    // band so a single congregation display can read both at once. The
    // translated line only ever populates when the item's own Multi-Language
    // translateTo is set (see themeNeedsTranslation/getTranslatedText in
    // service.js) — with no target language chosen it just renders empty.
    id: 'lyrics-bilingual', name: 'Lyrics — Bilingual', layout: 'lower-third', animation: 'slide-up',
    groupId: 'grp-lyrics', groupName: 'Lyrics',
    layers: [
      { id: 'bg', type: 'background', name: 'Canvas', visible: true,
        fill: 'transparent', fillBefore: 'solid', color: '#000000', opacity: 100, color2: '#000000', angle: 0 },
      { id: 'verse', type: 'text', name: 'Lyrics (source)', visible: true, binding: 'verse', customText: '',
        pos: { x: 96, y: 750, w: 1728, h: 180 },
        font: { family: 'Manrope', size: 44, weight: 600, italic: false, lineHeight: 1.3, letterSpacing: 0, transform: 'none' },
        color: '#ffffff', opacity: 100, align: 'center',
        shadow: { enabled: true, color: '#000000', opacity: 85, blur: 18, x: 0, y: 4 },
        outline: { enabled: true, color: '#000000', width: 2 } },
      { id: 'verse-translated', type: 'text', name: 'Lyrics (translated)', visible: true, binding: 'verse_translated', customText: '',
        pos: { x: 96, y: 945, w: 1728, h: 90 },
        font: { family: 'Manrope', size: 32, weight: 500, italic: false, lineHeight: 1.25, letterSpacing: 0, transform: 'none' },
        color: '#ffffff', opacity: 85, align: 'center',
        shadow: { enabled: true, color: '#000000', opacity: 85, blur: 14, x: 0, y: 3 },
        outline: { enabled: true, color: '#000000', width: 2 } },
    ],
  },
  {
    // News-style scrolling banner along the bottom — for announcements/
    // prayer requests running continuously under whatever else is on
    // screen, same idea as a news channel's chyron. The band and text sit
    // at the same free-canvas box; speed lives on the text layer itself
    // (Properties panel → Scroll), not the theme, so it's tunable per
    // service without duplicating the whole theme.
    id: 'ticker', name: 'Ticker', layout: 'ticker', animation: 'cut',
    groupId: 'grp-slides', groupName: 'Slides',
    layers: [
      { id: 'bg', type: 'background', name: 'Canvas', visible: true,
        fill: 'transparent', fillBefore: 'solid', color: '#000000', opacity: 100, color2: '#000000', angle: 0 },
      { id: 'band', type: 'background', name: 'Ticker Band', visible: true,
        fill: 'solid', color: '#c0272d', opacity: 100, color2: '#c0272d', angle: 0, radius: 0,
        pos: { x: 0, y: 990, w: 1920, h: 90 } },
      { id: 'text', type: 'text', name: 'Ticker Text', visible: true, binding: 'custom', customText: 'Type your announcement here…',
        pos: { x: 0, y: 990, w: 1920, h: 90 },
        font: { family: 'Manrope', size: 36, weight: 700, italic: false, lineHeight: 1.2, letterSpacing: 1, transform: 'uppercase' },
        color: '#ffffff', opacity: 100, align: 'left',
        shadow: { ...TXT_SHADOW_NONE }, outline: { ...NO_OUTLINE },
        scroll: { enabled: true, speed: 20 } },
    ],
  },
  {
    // Large scrolling text filling most of the screen — a bigger, more
    // dramatic marquee than Ticker's thin strip, for a single bold
    // announcement/alert meant to dominate the display rather than run
    // quietly under something else.
    id: 'scroll-fill', name: 'Scroll — Fill Screen', layout: 'scroll-fill', animation: 'cut',
    groupId: 'grp-slides', groupName: 'Slides',
    layers: [
      poolCanvas('charcoal'),
      { id: 'text', type: 'text', name: 'Scroll Text', visible: true, binding: 'custom', customText: 'Type your announcement here…',
        font: { family: 'Manrope', size: 140, weight: 800, italic: false, lineHeight: 1, letterSpacing: 0, transform: 'none' },
        color: '#ffffff', opacity: 100, align: 'left',
        shadow: { ...TXT_SHADOW_SOFT }, outline: { ...NO_OUTLINE },
        scroll: { enabled: true, speed: 14 } },
    ],
  },
  {
    // The animated/dynamic lyrics option — same transparent, keyable design
    // as Lyrics — Block, but each word of the verse leans in individually,
    // bold and punchy (see word_split.js's buildWordSpans and the
    // @keyframes kairo-word-in reveal in styles.css), instead of the plain
    // whole-block Fade/Slide/Cut every other theme uses — a broadcast/LED-
    // wall style cascade rather than a lower-third-style transition. Speed
    // is adjustable per-theme via the slider next to the Transition chips
    // (scales both each word's own reveal duration and the stagger between
    // words). Multi-part lyrics (verse/chorus/bridge…) need nothing special
    // here — they're just successive sends through the same binding:'verse'
    // text every other lyrics theme already uses, so each new part gets the
    // same word-by-word treatment automatically.
    id: 'lyrics-motion', name: 'Lyrics — Motion', layout: 'fullscreen', animation: 'cut', animationSpeed: 1, textAnimation: 'word-in', textAnimationSpeed: 1,
    groupId: 'grp-lyrics', groupName: 'Lyrics',
    layers: [
      { id: 'bg', type: 'background', name: 'Canvas', visible: true,
        fill: 'transparent', fillBefore: 'solid', color: '#000000', opacity: 100, color2: '#000000', angle: 0 },
      { id: 'verse', type: 'text', name: 'Lyrics', visible: true, binding: 'verse', customText: '',
        pos: { x: 160, y: 700, w: 1600, h: 280 },
        font: { family: 'Manrope', size: 58, weight: 700, italic: false, lineHeight: 1.3, letterSpacing: 0, transform: 'none' },
        color: '#ffffff', opacity: 100, align: 'center',
        shadow: { enabled: true, color: '#000000', opacity: 80, blur: 16, x: 0, y: 4 },
        outline: { enabled: true, color: '#000000', width: 2 } },
      { id: 'ref', type: 'text', name: 'Song Title', visible: false, binding: 'reference', customText: '',
        pos: { x: 160, y: 980, w: 1600, h: 0 },
        font: { family: 'Manrope', size: 24, weight: 700, italic: false, lineHeight: 1.2, letterSpacing: 4, transform: 'uppercase' },
        color: '#ffffff', opacity: 70, align: 'center',
        shadow: { enabled: true, color: '#000000', opacity: 70, blur: 8, x: 0, y: 2 },
        outline: { ...NO_OUTLINE } },
    ],
  },
  {
    // LED-wall preset: the verse box spans nearly the entire 1920×1080
    // canvas (not Lyrics — Motion's lower-anchored band) — for a video wall
    // where the whole screen IS the lyric display, not a caption over a
    // camera feed. Pairs that full-bleed geometry with 'activate' (see
    // @keyframes kairo-word-activate in styles.css): each word flashes from
    // dim to fully lit with a brief glow, inspired by Final Cut Pro's
    // "Activate" title.
    id: 'lyrics-activate', name: 'Lyrics — Activate', layout: 'fullscreen', animation: 'cut', animationSpeed: 1, textAnimation: 'activate', textAnimationSpeed: 1,
    groupId: 'grp-lyrics', groupName: 'Lyrics',
    layers: [
      { id: 'bg', type: 'background', name: 'Canvas', visible: true,
        fill: 'transparent', fillBefore: 'solid', color: '#000000', opacity: 100, color2: '#000000', angle: 0 },
      { id: 'verse', type: 'text', name: 'Lyrics', visible: true, binding: 'verse', customText: '',
        pos: { x: 80, y: 60, w: 1760, h: 900 },
        font: { family: 'Manrope', size: 72, weight: 800, italic: false, lineHeight: 1.25, letterSpacing: 0, transform: 'none' },
        color: '#ffffff', opacity: 100, align: 'center',
        shadow: { enabled: true, color: '#000000', opacity: 80, blur: 20, x: 0, y: 4 },
        outline: { enabled: true, color: '#000000', width: 2 } },
      { id: 'ref', type: 'text', name: 'Song Title', visible: false, binding: 'reference', customText: '',
        pos: { x: 80, y: 990, w: 1760, h: 0 },
        font: { family: 'Manrope', size: 22, weight: 700, italic: false, lineHeight: 1.2, letterSpacing: 4, transform: 'uppercase' },
        color: '#ffffff', opacity: 65, align: 'center',
        shadow: { enabled: true, color: '#000000', opacity: 70, blur: 8, x: 0, y: 2 },
        outline: { ...NO_OUTLINE } },
    ],
  },
  {
    // LED-wall preset, same full-bleed geometry as Lyrics — Activate, paired
    // with 'karaoke' (see @keyframes kairo-word-karaoke in styles.css): each
    // word sits dim ("unsung") until its turn, then snaps instantly to
    // fully lit and stays that way — the classic sing-along chase. Gold
    // reads as the traditional karaoke color at both the dim and lit ends
    // of that opacity range, unlike white (which would look closer to grey
    // scrim than "not yet sung" at 32% opacity).
    id: 'lyrics-karaoke', name: 'Lyrics — Karaoke', layout: 'fullscreen', animation: 'cut', animationSpeed: 1, textAnimation: 'karaoke', textAnimationSpeed: 1,
    groupId: 'grp-lyrics', groupName: 'Lyrics',
    layers: [
      { id: 'bg', type: 'background', name: 'Canvas', visible: true,
        fill: 'transparent', fillBefore: 'solid', color: '#000000', opacity: 100, color2: '#000000', angle: 0 },
      { id: 'verse', type: 'text', name: 'Lyrics', visible: true, binding: 'verse', customText: '',
        pos: { x: 80, y: 60, w: 1760, h: 900 },
        font: { family: 'Manrope', size: 72, weight: 800, italic: false, lineHeight: 1.25, letterSpacing: 0, transform: 'none' },
        color: '#ffd23f', opacity: 100, align: 'center',
        shadow: { enabled: true, color: '#000000', opacity: 80, blur: 20, x: 0, y: 4 },
        outline: { enabled: true, color: '#000000', width: 2 } },
      { id: 'ref', type: 'text', name: 'Song Title', visible: false, binding: 'reference', customText: '',
        pos: { x: 80, y: 990, w: 1760, h: 0 },
        font: { family: 'Manrope', size: 22, weight: 700, italic: false, lineHeight: 1.2, letterSpacing: 4, transform: 'uppercase' },
        color: '#ffffff', opacity: 65, align: 'center',
        shadow: { enabled: true, color: '#000000', opacity: 70, blur: 8, x: 0, y: 2 },
        outline: { ...NO_OUTLINE } },
    ],
  },
  {
    // LED-wall preset, same full-bleed geometry again, paired with
    // 'typewriter' (see @keyframes kairo-char-type/kairo-caret-blink in
    // styles.css): one character at a time, finishing with a blinking
    // caret. Courier Prime (a real monospace Google Font, not just a system
    // fallback) sells the "being typed" read far better than Manrope would —
    // proportional fonts visibly reflow width as each character lands.
    id: 'lyrics-typewriter', name: 'Lyrics — Typewriter', layout: 'fullscreen', animation: 'cut', animationSpeed: 1, textAnimation: 'typewriter', textAnimationSpeed: 1,
    groupId: 'grp-lyrics', groupName: 'Lyrics',
    layers: [
      { id: 'bg', type: 'background', name: 'Canvas', visible: true,
        fill: 'transparent', fillBefore: 'solid', color: '#000000', opacity: 100, color2: '#000000', angle: 0 },
      { id: 'verse', type: 'text', name: 'Lyrics', visible: true, binding: 'verse', customText: '',
        pos: { x: 80, y: 60, w: 1760, h: 900 },
        font: { family: 'Courier Prime', size: 62, weight: 700, italic: false, lineHeight: 1.3, letterSpacing: 0, transform: 'none' },
        color: '#ffffff', opacity: 100, align: 'center',
        shadow: { enabled: true, color: '#000000', opacity: 80, blur: 16, x: 0, y: 4 },
        outline: { enabled: true, color: '#000000', width: 2 } },
      { id: 'ref', type: 'text', name: 'Song Title', visible: false, binding: 'reference', customText: '',
        pos: { x: 80, y: 990, w: 1760, h: 0 },
        font: { family: 'Manrope', size: 22, weight: 700, italic: false, lineHeight: 1.2, letterSpacing: 4, transform: 'uppercase' },
        color: '#ffffff', opacity: 65, align: 'center',
        shadow: { enabled: true, color: '#000000', opacity: 70, blur: 8, x: 0, y: 2 },
        outline: { ...NO_OUTLINE } },
    ],
  },
  {
    // LED-wall preset, same full-bleed geometry again, paired with 'impact'
    // (see @keyframes kairo-word-in / .kairo-word-impact-hit in styles.css)
    // — the "Hormozi preset"/CapCut dynamic-caption look: most words pop in
    // at normal size, a handful of keyword words (picked by isImpactHit in
    // word_split.js) run bigger, bolder, and gold. Base size is smaller
    // than the other Lyrics — * presets since hit words scale up ~1.22×
    // from it — sized so even the enlarged words stay comfortably inside
    // the verse box instead of needing headroom baked into every layout.
    id: 'lyrics-impact', name: 'Lyrics — Impact', layout: 'fullscreen', animation: 'cut', animationSpeed: 1, textAnimation: 'impact', textAnimationSpeed: 1, textHighlightColor: '#ffd23f', textAnimationIntensity: 1,
    groupId: 'grp-lyrics', groupName: 'Lyrics',
    layers: [
      { id: 'bg', type: 'background', name: 'Canvas', visible: true,
        fill: 'transparent', fillBefore: 'solid', color: '#000000', opacity: 100, color2: '#000000', angle: 0 },
      { id: 'verse', type: 'text', name: 'Lyrics', visible: true, binding: 'verse', customText: '',
        pos: { x: 80, y: 60, w: 1760, h: 900 },
        font: { family: 'Manrope', size: 60, weight: 800, italic: false, lineHeight: 1.35, letterSpacing: 0, transform: 'none' },
        color: '#ffffff', opacity: 100, align: 'center',
        shadow: { enabled: true, color: '#000000', opacity: 80, blur: 20, x: 0, y: 4 },
        outline: { enabled: true, color: '#000000', width: 2 } },
      { id: 'ref', type: 'text', name: 'Song Title', visible: false, binding: 'reference', customText: '',
        pos: { x: 80, y: 990, w: 1760, h: 0 },
        font: { family: 'Manrope', size: 22, weight: 700, italic: false, lineHeight: 1.2, letterSpacing: 4, transform: 'uppercase' },
        color: '#ffffff', opacity: 65, align: 'center',
        shadow: { enabled: true, color: '#000000', opacity: 70, blur: 8, x: 0, y: 2 },
        outline: { ...NO_OUTLINE } },
    ],
  },
  {
    // LED-wall preset, same full-bleed geometry again, paired with
    // 'bold-caption' (see @keyframes kairo-word-boldcap-in / .kairo-word-
    // boldcap in styles.css) — the bold-caption style from viral short-form
    // editing: verse text breaks into short stacked lines, every word runs
    // at a flat heavy weight, and an occasional word explodes much bigger
    // with tight kerning. Base size (64px, bigger than the other
    // Lyrics — * presets' ~52-60px) plus buildBoldCapSpans' own
    // space-evenly vertical distribution across the full verse box is what
    // makes this "fill" the box regardless of a verse's length, rather
    // than sitting as a small cluster in the middle. Weight is left at the
    // layer's own default since .kairo-word-boldcap hardcodes 900 anyway.
    id: 'lyrics-bold-caption', name: 'Lyrics — Bold Caption', layout: 'fullscreen', animation: 'cut', animationSpeed: 1, textAnimation: 'bold-caption', textAnimationSpeed: 1, textAnimationIntensity: 1,
    groupId: 'grp-lyrics', groupName: 'Lyrics',
    layers: [
      { id: 'bg', type: 'background', name: 'Canvas', visible: true,
        fill: 'transparent', fillBefore: 'solid', color: '#000000', opacity: 100, color2: '#000000', angle: 0 },
      { id: 'verse', type: 'text', name: 'Lyrics', visible: true, binding: 'verse', customText: '',
        pos: { x: 80, y: 60, w: 1760, h: 900 },
        font: { family: 'Manrope', size: 64, weight: 800, italic: false, lineHeight: 1.35, letterSpacing: 0, transform: 'none' },
        color: '#ffffff', opacity: 100, align: 'center',
        shadow: { enabled: true, color: '#000000', opacity: 80, blur: 20, x: 0, y: 4 },
        outline: { enabled: true, color: '#000000', width: 2 } },
      { id: 'ref', type: 'text', name: 'Song Title', visible: false, binding: 'reference', customText: '',
        pos: { x: 80, y: 990, w: 1760, h: 0 },
        font: { family: 'Manrope', size: 22, weight: 700, italic: false, lineHeight: 1.2, letterSpacing: 4, transform: 'uppercase' },
        color: '#ffffff', opacity: 65, align: 'center',
        shadow: { enabled: true, color: '#000000', opacity: 70, blur: 8, x: 0, y: 2 },
        outline: { ...NO_OUTLINE } },
    ],
  },
  {
    // The default look every timer segment falls back to until an operator
    // assigns something else — the whole point is that opening "Edit" on a
    // brand-new segment (themeId still null) shows a real, centered
    // countdown right away instead of an empty canvas with no text layer
    // to explain what the number will look like (see resolveItemBaseLook's
    // timer-specific branch, which reaches for this by id rather than
    // falling through to whatever the output's own default theme is).
    id: 'timer-big', name: 'Timer — Big Countdown', layout: 'fullscreen', animation: 'cut',
    groupId: 'grp-timer', groupName: 'Timer',
    layers: [
      poolCanvas('stage'),
      { id: 'timer', type: 'text', name: 'Countdown', visible: true, binding: 'timer', customText: '',
        pos: { x: 160, y: 380, w: 1600, h: 320 },
        font: { family: 'Manrope', size: 180, weight: 800, italic: false, lineHeight: 1, letterSpacing: 0, transform: 'none' },
        color: '#ffffff', opacity: 100, align: 'center',
        shadow: { ...TXT_SHADOW_SOFT }, outline: { ...NO_OUTLINE } },
    ],
  },
  {
    // Pre-service: a rotating slideshow (announcements, sponsor slides,
    // event photos — whatever the operator loads into the Image Cycle
    // layer via Theme Studio's "Cycle" button) filling most of the screen,
    // with the countdown held in a fixed panel alongside it rather than
    // floating over the images — legible no matter what's cycling behind
    // it. Ships with the same placeholder frames "Load sample images"
    // uses (renderImageCycleProps) pre-loaded, so this preset actually
    // shows the cycle working the first time it's opened, not an empty
    // slideshow with nothing to demonstrate — swap in real photos any
    // time the same way (Upload… / From Library…).
    id: 'timer-preservice-split', name: 'Timer — Pre-Service Split', layout: 'fullscreen', animation: 'cut',
    groupId: 'grp-timer', groupName: 'Timer',
    layers: [
      poolCanvas('midnight'),
      { id: 'cycle', type: 'image-cycle', name: 'Image Cycle', visible: true,
        sources: [...SAMPLE_CYCLE_IMAGES], fit: 'cover', opacity: 100, radius: 0,
        pos: { x: 0, y: 0, w: 1440, h: 1080 } },
      { id: 'timer', type: 'text', name: 'Countdown', visible: true, binding: 'timer', customText: '',
        pos: { x: 1440, y: 0, w: 480, h: 1080 },
        font: { family: 'Manrope', size: 130, weight: 800, italic: false, lineHeight: 1, letterSpacing: 0, transform: 'none' },
        color: '#ffffff', opacity: 100, align: 'center',
        shadow: { ...TXT_SHADOW_SOFT }, outline: { ...NO_OUTLINE } },
    ],
  },
  {
    // Each piece of the countdown as its OWN layer (timer-h/m/s bindings —
    // see renderTextProps' "Binds to" chips) instead of one fixed "H:MM:SS"
    // string, so they can be laid out however an operator wants — here,
    // Minute stacked directly above Second with a plain separator between,
    // rather than side by side. A layout variant available to any template
    // the same way every other built-in theme is, not a one-off example.
    id: 'timer-stacked-min-sec', name: 'Timer — Stacked Minute/Second', layout: 'fullscreen', animation: 'cut',
    groupId: 'grp-timer', groupName: 'Timer',
    layers: [
      poolCanvas('ember'),
      { id: 'minute', type: 'text', name: 'Minute', visible: true, binding: 'timer-m', customText: '',
        pos: { x: 760, y: 340, w: 400, h: 220 },
        font: { family: 'Manrope', size: 180, weight: 800, italic: false, lineHeight: 1, letterSpacing: 0, transform: 'none' },
        color: '#ffffff', opacity: 100, align: 'center',
        shadow: { ...TXT_SHADOW_SOFT }, outline: { ...NO_OUTLINE } },
      // A plain 'custom' text layer — double-click it on the canvas to
      // change it to anything (":", "MIN", etc.).
      { id: 'sep', type: 'text', name: 'Separator', visible: true, binding: 'custom', customText: '..',
        pos: { x: 760, y: 560, w: 400, h: 80 },
        font: { family: 'Manrope', size: 60, weight: 700, italic: false, lineHeight: 1, letterSpacing: 0, transform: 'none' },
        color: '#ffffff88', opacity: 100, align: 'center',
        shadow: { ...TXT_SHADOW_SOFT }, outline: { ...NO_OUTLINE } },
      { id: 'second', type: 'text', name: 'Second', visible: true, binding: 'timer-s', customText: '',
        pos: { x: 760, y: 640, w: 400, h: 220 },
        font: { family: 'Manrope', size: 180, weight: 800, italic: false, lineHeight: 1, letterSpacing: 0, transform: 'none' },
        color: '#ffffff', opacity: 100, align: 'center',
        shadow: { ...TXT_SHADOW_SOFT }, outline: { ...NO_OUTLINE } },
    ],
  },  // ── Motion themes (motion_graphics.js) ────────────────────────────────
  // Every moving part is a 'motion' layer, so its colours, count, speed and
  // placement are editable like anything else on the canvas.
  {
    // The countdown inside a ring that runs down with it, over slow light.
    id: 'timer-ring', name: 'Timer — Progress Ring', layout: 'fullscreen', animation: 'cut',
    groupId: 'grp-timer', groupName: 'Timer',
    layers: [
      poolCanvas('ocean'),
      { id: 'light', type: 'motion', name: 'Aurora', visible: true, opacity: 100, pos: { x: 0, y: 0, w: 1920, h: 1080 },
        graphic: { kind: 'aurora', colors: ['#4f46e5', '#0ea5e9', '#a855f7'], count: 3, size: 90, intensity: 38, speed: 0.5, blend: 'glow', seed: 42 } },
      { id: 'ring', type: 'motion', name: 'Progress Ring', visible: true, opacity: 100, pos: { x: 600, y: 180, w: 720, h: 720 },
        graphic: { kind: 'ring', colors: ['#ffffff', '#ffffff', '#e8a64a', '#e8404a'], thickness: 3, trackOpacity: 14, direction: 'deplete', caps: 'round', glow: 40, stateColors: true, seed: 1 } },
      { id: 'timer', type: 'text', name: 'Countdown', visible: true, binding: 'timer', customText: '',
        pos: { x: 600, y: 440, w: 720, h: 200 },
        font: { family: 'Manrope', size: 150, weight: 800, italic: false, lineHeight: 1, letterSpacing: 0, transform: 'none' },
        color: '#ffffff', opacity: 100, align: 'center',
        shadow: { ...TXT_SHADOW_SOFT }, outline: { ...NO_OUTLINE } },
    ],
  },
  {
    // A broadcast studio clock: sixty dots, one going dark each second.
    id: 'timer-studio-clock', name: 'Timer — Studio Clock', layout: 'fullscreen', animation: 'cut',
    groupId: 'grp-timer', groupName: 'Timer',
    layers: [
      { id: 'bg', type: 'background', name: 'Canvas', visible: true,
        fill: 'solid', color: '#050507', opacity: 100, color2: '#050507', angle: 0 },
      { id: 'dots', type: 'motion', name: 'Seconds Dots', visible: true, opacity: 100, pos: { x: 540, y: 120, w: 840, h: 840 },
        graphic: { kind: 'dots', colors: ['#ff453a', '#ffffff', '#ffd60a', '#ffffff'], count: 60, size: 55, trackOpacity: 10, shape: 'circle', mode: 'seconds', glow: 45, stateColors: true, seed: 1 } },
      { id: 'timer', type: 'text', name: 'Countdown', visible: true, binding: 'timer', customText: '',
        pos: { x: 560, y: 420, w: 800, h: 240 },
        font: { family: 'Bebas Neue', size: 220, weight: 400, italic: false, lineHeight: 1, letterSpacing: 6, transform: 'none' },
        color: '#ff453a', opacity: 100, align: 'center', warnColor: '#ffd60a', overtimeColor: '#ffffff',
        shadow: { enabled: true, color: '#ff453a', opacity: 45, blur: 24, x: 0, y: 0 }, outline: { ...NO_OUTLINE } },
    ],
  },
  {
    // Pre-service warmth: beams of light, a few sparkles, the countdown and a
    // bar that runs down under it.
    id: 'timer-rays', name: 'Timer — Light Rays', layout: 'fullscreen', animation: 'cut',
    groupId: 'grp-timer', groupName: 'Timer',
    layers: [
      { id: 'bg', type: 'background', name: 'Canvas', visible: true,
        fill: 'gradient', color: '#1d140a', opacity: 100, color2: '#0a0a0d', angle: 180 },
      { id: 'rays', type: 'motion', name: 'Light Rays', visible: true, opacity: 100, pos: { x: 0, y: 0, w: 1920, h: 1080 },
        graphic: { kind: 'rays', colors: ['#ffe7b0'], count: 16, spread: 30, intensity: 26, originX: 50, originY: -12, motion: 'sway', speed: 0.7, seed: 1 } },
      { id: 'sparkles', type: 'motion', name: 'Sparkles', visible: true, opacity: 100, pos: { x: 0, y: 0, w: 1920, h: 1080 },
        graphic: { kind: 'sparkles', colors: ['#fff4d6'], count: 40, size: 2, intensity: 70, speed: 0.8, seed: 77 } },
      { id: 'label', type: 'text', name: 'Label', visible: true, binding: 'custom', customText: 'Service begins in',
        pos: { x: 360, y: 330, w: 1200, h: 80 },
        font: { family: 'Manrope', size: 40, weight: 700, italic: false, lineHeight: 1.2, letterSpacing: 8, transform: 'uppercase' },
        color: '#ffe7b0', opacity: 90, align: 'center',
        shadow: { ...TXT_SHADOW_NONE }, outline: { ...NO_OUTLINE } },
      { id: 'timer', type: 'text', name: 'Countdown', visible: true, binding: 'timer', customText: '',
        pos: { x: 360, y: 420, w: 1200, h: 240 },
        font: { family: 'Manrope', size: 190, weight: 800, italic: false, lineHeight: 1, letterSpacing: 0, transform: 'none' },
        color: '#ffffff', opacity: 100, align: 'center',
        shadow: { ...TXT_SHADOW_SOFT }, outline: { ...NO_OUTLINE } },
      { id: 'bar', type: 'motion', name: 'Progress Bar', visible: true, opacity: 100, pos: { x: 660, y: 720, w: 600, h: 10 },
        graphic: { kind: 'bar', colors: ['#ffe7b0', '#ffffff', '#e8a64a', '#e8404a'], trackOpacity: 16, radius: 100, direction: 'deplete', glow: 30, stateColors: true, seed: 1 } },
    ],
  },
  {
    // Full — Background's layout over slow-moving light.
    id: 'full-aurora', name: 'Full — Aurora', layout: 'fullscreen', animation: 'fade',
    groupId: 'grp-bible', groupName: 'Bible',
    layers: [
      { id: 'bg', type: 'background', name: 'Canvas', visible: true,
        fill: 'gradient', color: '#07070c', opacity: 100, color2: '#10101c', angle: 160 },
      { id: 'light', type: 'motion', name: 'Aurora', visible: true, opacity: 100, pos: { x: 0, y: 0, w: 1920, h: 1080 },
        graphic: { kind: 'aurora', colors: ['#6d28d9', '#0ea5e9', '#db2777'], count: 4, size: 90, intensity: 42, speed: 0.45, blend: 'glow', seed: 5 } },
      { id: 'verse', type: 'text', name: 'Verse', visible: true, binding: 'verse', customText: '',
        pos: { x: 210, y: 80, w: 1500, h: 700 },
        font: { family: 'Manrope', size: 64, weight: 500, italic: false, lineHeight: 1.35, letterSpacing: 0, transform: 'none' },
        color: '#ffffff', opacity: 100, align: 'center',
        shadow: { ...TXT_SHADOW_SOFT }, outline: { ...NO_OUTLINE } },
      { id: 'ref', type: 'text', name: 'Reference', visible: true, binding: 'reference', customText: '',
        pos: { x: 210, y: 820, w: 1500, h: 0 },
        font: { family: 'Manrope', size: 28, weight: 600, italic: false, lineHeight: 1.2, letterSpacing: 4, transform: 'uppercase' },
        color: '#ffffff', opacity: 65, align: 'center',
        shadow: { ...TXT_SHADOW_NONE }, outline: { ...NO_OUTLINE } },
    ],
  },
  {
    // Warm out-of-focus lights rising behind the lyrics.
    id: 'lyrics-bokeh', name: 'Lyrics — Bokeh', layout: 'fullscreen', animation: 'fade',
    groupId: 'grp-lyrics', groupName: 'Lyrics',
    layers: [
      { id: 'bg', type: 'background', name: 'Canvas', visible: true,
        fill: 'gradient', color: '#120c06', opacity: 100, color2: '#060506', angle: 170 },
      { id: 'bokeh', type: 'motion', name: 'Bokeh', visible: true, opacity: 100, pos: { x: 0, y: 0, w: 1920, h: 1080 },
        graphic: { kind: 'bokeh', colors: ['#ffd89b', '#ffb35c', '#ffffff'], count: 28, size: 12, softness: 60, intensity: 42, direction: 'up', speed: 0.55, seed: 21 } },
      { id: 'verse', type: 'text', name: 'Lyrics', visible: true, binding: 'verse', customText: '',
        pos: { x: 140, y: 250, w: 1640, h: 600 },
        font: { family: 'Montserrat', size: 88, weight: 800, italic: false, lineHeight: 1.2, letterSpacing: 0, transform: 'uppercase' },
        color: '#ffffff', opacity: 100, align: 'center',
        shadow: { enabled: true, color: '#000000', opacity: 70, blur: 22, x: 0, y: 4 }, outline: { ...NO_OUTLINE } },
      { id: 'ref', type: 'text', name: 'Song Title', visible: false, binding: 'reference', customText: '',
        pos: { x: 140, y: 880, w: 1640, h: 0 },
        font: { family: 'Montserrat', size: 26, weight: 600, italic: false, lineHeight: 1.2, letterSpacing: 6, transform: 'uppercase' },
        color: '#ffffff', opacity: 55, align: 'center',
        shadow: { ...TXT_SHADOW_NONE }, outline: { ...NO_OUTLINE } },
    ],
  },
  {
    // A night sky of twinkling stars behind the lyrics.
    id: 'lyrics-starlight', name: 'Lyrics — Starlight', layout: 'fullscreen', animation: 'fade',
    groupId: 'grp-lyrics', groupName: 'Lyrics',
    layers: [
      { id: 'bg', type: 'background', name: 'Canvas', visible: true,
        fill: 'gradient', color: '#020412', opacity: 100, color2: '#0b1030', angle: 180 },
      { id: 'stars', type: 'motion', name: 'Sparkles', visible: true, opacity: 100, pos: { x: 0, y: 0, w: 1920, h: 1080 },
        graphic: { kind: 'sparkles', colors: ['#ffffff', '#c7d2fe'], count: 90, size: 3, intensity: 90, speed: 0.8, seed: 8 } },
      { id: 'verse', type: 'text', name: 'Lyrics', visible: true, binding: 'verse', customText: '',
        pos: { x: 160, y: 250, w: 1600, h: 600 },
        font: { family: 'Manrope', size: 76, weight: 700, italic: false, lineHeight: 1.25, letterSpacing: 0, transform: 'none' },
        color: '#ffffff', opacity: 100, align: 'center',
        shadow: { enabled: true, color: '#000000', opacity: 70, blur: 18, x: 0, y: 4 }, outline: { ...NO_OUTLINE } },
      { id: 'ref', type: 'text', name: 'Song Title', visible: false, binding: 'reference', customText: '',
        pos: { x: 160, y: 880, w: 1600, h: 0 },
        font: { family: 'Manrope', size: 24, weight: 700, italic: false, lineHeight: 1.2, letterSpacing: 4, transform: 'uppercase' },
        color: '#ffffff', opacity: 60, align: 'center',
        shadow: { ...TXT_SHADOW_NONE }, outline: { ...NO_OUTLINE } },
    ],
  },
  // The Announcements pack (announcement_pack.js) — the same slides the
  // Timer tab's pre-service loop plays, as themes for a Slides item.
  ...(window.KairoAnnouncements ? window.KairoAnnouncements.themes() : []),
];

// Load saved looks from localStorage and back-fill any NEW default-look IDs
// the user doesn't have yet (so adding new built-in lower-third designs in
// future releases shows up for existing users without nuking their custom themes).
// Ids of the retired v2 built-ins. v3 replaced the sprawling preset list with
// the canonical set above; on first v3 load we drop these stock themes but keep
// anything the operator actually made or imported.
const LEGACY_BUILTIN_IDS = new Set([
  'default', 'lower-third', 'lower-third-broadcast', 'lower-third-ribbon',
  'lower-third-bold', 'lower-third-whisper', 'lower-third-brand',
  'card-bottom-left', 'corner-pop', 'side-rail-rail', 'no-bg',
  'split-left', 'split-right',
]);

let looks = (function loadLooks() {
  const stored = JSON.parse(localStorage.getItem(LOOKS_KEY) || 'null');
  if (Array.isArray(stored) && stored.length) {
    // Renamed BEFORE knownIds/missing below are computed from stored's ids —
    // otherwise the new id ('lyrics-bold-caption') still reads as entirely
    // missing at that point and the back-fill appends a second, fresh copy
    // alongside this renamed one instead of this being an in-place rename.
    stored.forEach(l => {
      if (l.id === 'lyrics-collage') { l.id = 'lyrics-bold-caption'; l.name = 'Lyrics — Bold Caption'; }
    });
    const knownIds = new Set(stored.map(l => l.id));
    const missing  = DEFAULT_LOOKS.filter(d => !knownIds.has(d.id));
    // Built-in themes saved before category grouping (Lyrics/Bible/Slides)
    // was introduced won't carry a groupId/groupName of their own — the
    // back-fill above only adds ids that are entirely missing, so an
    // existing stored copy of e.g. 'lyrics-block' needs those two fields
    // retrofitted from its current DEFAULT_LOOKS entry. Idempotent: once set,
    // this is a no-op on every later load.
    const defaultsById = new Map(DEFAULT_LOOKS.map(d => [d.id, d]));
    const SONGTITLE_MIGRATION_KEY = 'kairo-migrated-songtitle-default-off';
    const runSongTitleMigration = !localStorage.getItem(SONGTITLE_MIGRATION_KEY);
    if (runSongTitleMigration) localStorage.setItem(SONGTITLE_MIGRATION_KEY, '1');
    // split-left/split-right/multi-language's verse+reference used to default
    // to left-aligned (matching their filled half being a narrower column) —
    // now centered under each other, matching full-bg/full-alpha's own
    // convention, so the reference reads as centered under the verse across
    // most Bible themes rather than only the fullscreen ones. Gated (like
    // the Song Title migration above) so a later deliberate operator choice
    // to go back to left-aligned isn't fought forever — but ALSO force-
    // persisted immediately (unlike that migration, which only actually
    // writes back the next time something else happens to call saveLooks()
    // — a real gap: an install that never edits an unrelated theme keeps the
    // old value in storage forever even though the gate key is already set,
    // so the in-memory fix silently never re-applies on the next launch).
    const ALIGN_MIGRATION_KEY = 'kairo-migrated-bible-center-align';
    const runAlignMigration = !localStorage.getItem(ALIGN_MIGRATION_KEY);
    if (runAlignMigration) localStorage.setItem(ALIGN_MIGRATION_KEY, '1');
    let alignMigrated = false;
    // Full — Background/Transparent and Lyrics — Block's verse text box grew
    // (440->700, 380->600) — owner: "the text area should use a sizable
    // height by default so that text don't cut off due to the constraint."
    // Same idiom as the align migration above: gated so it runs exactly
    // once, and only touches a stored theme whose verse box is STILL
    // sitting at the exact old shipped default — an operator who already
    // deliberately resized it keeps their own choice untouched.
    const TEXTHEIGHT_MIGRATION_KEY = 'kairo-migrated-fullscreen-text-height';
    const runTextHeightMigration = !localStorage.getItem(TEXTHEIGHT_MIGRATION_KEY);
    if (runTextHeightMigration) localStorage.setItem(TEXTHEIGHT_MIGRATION_KEY, '1');
    let textHeightMigrated = false;
    // Same idea as the Song Title migration above, for installs that
    // already have their own stored copy of 'timer-preservice-split' from
    // before it shipped with SAMPLE_CYCLE_IMAGES pre-loaded (the back-fill
    // above only ADDS ids that are entirely missing — an id already known
    // keeps its stored copy exactly as saved, empty sources included).
    // Deliberately NOT gated by a one-time key like the migration above —
    // a first version of this WAS, and that was itself the bug: it mutated
    // `stored` in memory but nothing here calls saveLooks() to persist
    // that, so the very next reload read the same still-empty sources
    // back from localStorage — except now the key already existed, so the
    // migration no-opped forever after, and the theme's Image Cycle layer
    // just silently stayed empty (which looks exactly like "the background
    // isn't changing", because there was nothing in it to cycle through).
    // Instead this just re-checks "is it still empty" on every load, which
    // is naturally idempotent once populated, self-heals from that earlier
    // broken state with no manual fix needed, and cycleSampleMigrated
    // (below) makes sure it's saveLooks()'d so it isn't relying on that
    // recheck to run again either.
    let cycleSampleMigrated = false;
    // Built-in themes that shipped on a flat default gradient now ship on a
    // bundled background picture (src/backgrounds). A stored copy whose
    // fills are all STILL exactly the old shipped ones takes the new
    // defaults; a theme the operator recoloured keeps its own. Gated and
    // force-persisted, same as the align migration above.
    const BACKGROUND_MIGRATION_KEY = 'kairo-migrated-builtin-backgrounds';
    const runBackgroundMigration = !localStorage.getItem(BACKGROUND_MIGRATION_KEY);
    if (runBackgroundMigration) localStorage.setItem(BACKGROUND_MIGRATION_KEY, '1');
    let backgroundMigrated = false;
    const OLD_GRADIENT = { fill: 'gradient', color: '#0b0b0f', color2: '#1c1c30', angle: 160, opacity: 100 };
    const OLD_FILLS = {
      'full-bg': { bg: OLD_GRADIENT }, 'scroll-fill': { bg: OLD_GRADIENT },
      'timer-big': { bg: OLD_GRADIENT }, 'timer-preservice-split': { bg: OLD_GRADIENT },
      'timer-stacked-min-sec': { bg: OLD_GRADIENT },
      'split-left': { panel: OLD_GRADIENT }, 'split-right': { panel: OLD_GRADIENT },
      'multi-language': { bg: OLD_GRADIENT, 'panel-left': OLD_GRADIENT,
        'panel-right': { ...OLD_GRADIENT, color: '#020203', color2: '#0a0a12' } },
    };
    stored.forEach(l => {
      const def = defaultsById.get(l.id);
      const oldFills = runBackgroundMigration && def && OLD_FILLS[l.id];
      if (oldFills) {
        const pairs = Object.keys(oldFills).map(id => [
          (l.layers || []).find(ly => ly.id === id && ly.type === 'background'),
          def.layers.find(ly => ly.id === id && ly.type === 'background'),
          oldFills[id],
        ]);
        const untouched = pairs.every(([ly, shipped, was]) => ly && shipped && Object.keys(was).every(k => ly[k] === was[k]));
        if (untouched) {
          pairs.forEach(([ly, shipped]) => {
            ['fill', 'src', 'color', 'color2', 'angle', 'opacity'].forEach(k => {
              if (shipped[k] === undefined) delete ly[k]; else ly[k] = shipped[k];
            });
          });
          backgroundMigrated = true;
        }
      }
      if (def && def.groupId && !l.groupId) { l.groupId = def.groupId; l.groupName = def.groupName; }
      if (l.id === 'timer-preservice-split') {
        const cycle = (l.layers || []).find(ly => ly.type === 'image-cycle');
        if (cycle && !(cycle.sources || []).length) { cycle.sources = [...SAMPLE_CYCLE_IMAGES]; cycleSampleMigrated = true; }
      }
      // Word/Activate/Karaoke/Typewriter/Impact/Bold Caption/Bounce/Highlight Box/
      // Shimmer used to be crammed into the same `animation` field as the
      // real Fade/Slide/Cut transitions — every install saved before that
      // was split into its own `textAnimation` field still has one of those
      // values sitting in `animation`. Migrate in place: move it to
      // textAnimation, carry the old animationSpeed over as
      // textAnimationSpeed (that field WAS controlling the text reveal's
      // pace for these themes), and reset animation to 'cut' — the
      // no-redundant-container-fade pairing every Lyrics — * preset above
      // already uses. Only touches looks that still have the OLD shape; an
      // operator who's since picked a real transition keeps that choice.
      if (window.KairoWordSplit?.isPerElementMotion(l.animation)) {
        l.textAnimation = l.animation;
        l.textAnimationSpeed = l.animationSpeed ?? 1;
        l.animation = 'cut';
        l.animationSpeed = 1;
      }
      // Renamed from 'collage' once the actual chaotic-rotation design was
      // reworked into the bold-caption style it is now — an install saved
      // under the old name during that redesign still needs to resolve.
      if (l.textAnimation === 'collage') l.textAnimation = 'bold-caption';
      // The built-in Lyrics presets' "Song Title" layer used to default on,
      // so it could paint alone (just the song title, no lyric line) on an
      // otherwise-empty canvas — e.g. before any stanza is sent. Now off by
      // default in DEFAULT_LOOKS; an install saved before that still has its
      // own copy of the layer with the old visible:true baked in, so this
      // in-place flip is needed too. Gated on SONGTITLE_MIGRATION_KEY below
      // (checked once, outside this per-look loop) so it runs exactly once —
      // without that gate this would re-run on every load and stomp an
      // operator's own later choice to turn the layer back on.
      if (runSongTitleMigration && def?.groupId === 'grp-lyrics') {
        const ref = (l.layers || []).find(ly => ly.id === 'ref' && ly.binding === 'reference');
        if (ref) ref.visible = false;
      }
      if (runAlignMigration && (l.id === 'split-left' || l.id === 'split-right' || l.id === 'multi-language')) {
        (l.layers || []).forEach(ly => {
          if (ly.type === 'text' && (ly.binding === 'verse' || ly.binding === 'verse_translated' || ly.binding === 'reference') && ly.align === 'left') {
            ly.align = 'center';
            alignMigrated = true;
          }
        });
      }
      if (runTextHeightMigration && (l.id === 'full-bg' || l.id === 'full-alpha')) {
        const verse = (l.layers || []).find(ly => ly.id === 'verse');
        const ref   = (l.layers || []).find(ly => ly.id === 'ref');
        if (verse?.pos?.h === 440) { verse.pos.h = 700; textHeightMigrated = true; }
        if (ref?.pos?.y === 560)   { ref.pos.y = 820;   textHeightMigrated = true; }
      }
      if (runTextHeightMigration && l.id === 'lyrics-block') {
        const verse = (l.layers || []).find(ly => ly.id === 'verse');
        if (verse?.pos?.h === 380 && verse?.pos?.y === 360) {
          verse.pos.y = 250; verse.pos.h = 600; textHeightMigrated = true;
        }
      }
    });
    const result = missing.length ? [...stored, ...missing] : stored;
    // Persist the cycle-sample and align fixes directly (can't call
    // saveLooks() here — it reads the module-level `looks` binding, which
    // doesn't exist yet: this whole function is still IN THE MIDDLE of
    // computing the value that assignment is waiting on). Every other
    // migration above already gets written back out the ordinary way, the
    // next time anything calls saveLooks() for an unrelated reason — these
    // are the two migrations that need to survive even if nothing else ever
    // does (the align one is gated, so without a forced write here it would
    // silently never actually persist on an install that never happens to
    // save an unrelated theme edit — the gate key alone doesn't get you that).
    if (cycleSampleMigrated || alignMigrated || textHeightMigrated || backgroundMigrated) {
      try { localStorage.setItem(LOOKS_KEY, JSON.stringify(result)); } catch {}
    }
    return result;
  }
  // First run on v3 — carry over the operator's own themes from v2, if any.
  // Also mark the Song Title AND align migrations as already applied:
  // DEFAULT_LOOKS already ships with both fixes baked in, so a genuinely
  // fresh install has nothing to retroactively flip — without this, the
  // FIRST save an operator makes (e.g. deliberately choosing left-align)
  // would look like a pre-migration install on the next launch and get
  // silently reverted by the migration above.
  localStorage.setItem('kairo-migrated-songtitle-default-off', '1');
  localStorage.setItem('kairo-migrated-bible-center-align', '1');
  localStorage.setItem('kairo-migrated-fullscreen-text-height', '1');
  localStorage.setItem('kairo-migrated-builtin-backgrounds', '1');
  const legacy = JSON.parse(localStorage.getItem('kairo-looks-v2') || 'null');
  const custom = Array.isArray(legacy) ? legacy.filter(l => l && !LEGACY_BUILTIN_IDS.has(l.id)) : [];
  return [...DEFAULT_LOOKS, ...custom];
})();
let activeLook  = looks[0];
let activeLayer = null; // currently selected (primary) layer object

// The in-progress inline text edit (beginInlineTextEdit), if any — `null`
// otherwise. CONFIRMED root cause of edits not saving: every mousedown
// handler that starts a new selection/drag (tsDecorateLayerEl, tsBeginDrag)
// calls e.preventDefault(), which — per spec — suppresses the browser's
// OWN default "move focus, blur whatever was focused" behavior on
// mousedown. That meant clicking a DIFFERENT layer (or empty canvas) while
// editing never fired 'blur' on the field being edited at all, so the
// commit handler attached to it never ran — the edit just vanished the
// instant the canvas re-rendered out from under it. Tracking the active
// edit here lets every one of those entry points force it to commit
// itself FIRST, instead of relying on a blur event that preventDefault
// was quietly cancelling.
let tsActiveEdit = null; // { layerId, commit }
function tsCommitActiveEdit(exceptLayerId) {
  if (tsActiveEdit && tsActiveEdit.layerId !== exceptLayerId) tsActiveEdit.commit();
}

// Themes imported from one multi-slide bundle (a .protheme file's several
// named theme-slides — HYMN 1, NOTES, CALL TO WORSHIP, etc.) share a
// groupId/groupName rather than becoming unrelated flat entries in the same
// list as every built-in/custom theme. Deliberately NOT a nested container
// object (Theme { slides: [...] }) — each slide stays a normal, independent
// look, so output assignment (outputThemeMap), Full-scale edit's theme
// picker, saveLooks, import/export — none of that needs to know groups
// exist at all. Only the browsing list groups them visually. Session-only;
// resets to "all expanded" on reload, same as the output cards' own
// collapse state elsewhere in this file.
let collapsedThemeGroups = new Set();

// Select-all/copy/paste for layers (Cmd/Ctrl+A/C/V while Theme Studio has
// focus, mirroring the same gesture on native files/text) — lets an operator
// pull layers from one theme into another instead of only ever duplicating
// the whole theme. Also the general multi-selection set — Shift/Cmd/Ctrl+
// click a layer on the canvas (tsToggleMultiSelect) toggles it in here too,
// alongside Select-All's "everything" and the Layers-list row click's own
// handling — one shared set for all three entry points, read by Copy/
// Paste/Delete (whole selection), the canvas highlight + group-drag +
// Align toolbar (tsSelectedLayers/tsAlignSelection), and arrow-key nudging.
// activeLayer is still the single "primary" the props panel edits; a plain
// click always narrows back down to just that one.
let multiSelectedLayerIds = new Set();
let layerClipboard = [];

// "Full Edit" — a second use of this same canvas engine, pointed at a
// specific playlist item's specific slide instead of a real theme, so an
// operator can override that slide's text-layer position/font/color/shadow/
// outline/visibility without touching the theme itself (see item.slideStyles
// in service.js). tsMode gates every place the engine would otherwise assume
// "activeLook is a real theme in the looks array" — Theme Studio's own
// behavior in tsMode === 'theme' must stay byte-for-byte unchanged.
let tsMode = 'theme'; // 'theme' | 'item'
// Set by Play (Animate tab / canvas bar): the next renderPreview replays every
// layer's build-in once.
let tsPlayBuilds = false;
// A drag-a-box selection in progress (tsBeginMarquee).
let tsMarquee = null;   // { startX, startY, stageRect, box, armed, bgLayer }
function tsPlayAnimations() { tsPlayBuilds = true; renderPreview(); }
let tsItemCtx = null; // { item, slideIndex, baseLook } — set only while tsMode === 'item'
let itemUndoStack = [], itemRedoStack = [], itemPendingCheckpoint = null, itemAutosaveTimer = null;

function saveLooks() {
  // A large embedded layer (e.g. an uncapped video data: URI — see
  // loadVideoFile's own size cap) can push `looks` past the origin's
  // storage quota; setItem throws SYNCHRONOUSLY. Uncaught, that used to
  // abort the callers below for THIS edit and, since the quota stays over
  // the limit, every theme edit for the rest of the session — with
  // toast() a deliberate no-op, silently and invisibly.
  try {
    localStorage.setItem(LOOKS_KEY, JSON.stringify(looks));
  } catch (err) {
    console.warn('[KAIRO] saveLooks failed (storage quota?):', err.message);
    return;
  }
  // Keep every live output in step with the edit (by design: an output showing
  // this theme follows it). The Outputs pane itself is only rebuilt while
  // Settings is actually open — rebuilding hidden DOM on every autosave burst
  // was pure waste.
  try {
    if (settingsModal && !settingsModal.classList.contains('hidden')) renderOutputsPane();
    applyOutputThemes();
  } catch (err) { console.warn('[KAIRO] outputs refresh after saveLooks failed:', err); }
}
function deepClone(o) { return JSON.parse(JSON.stringify(o)); }

// hexToRgb/hexOpacity now live in color_utils.js (shared with service.js and
// display.html — see that file for why).

// Small live preview of a look's layers for a theme-list row — see
// renderLookThumbnail in service.js (shared with the Slides/Bible theme
// popovers so every theme picker in the app shows the same thumbnail).
function renderLookThumbnail(container, look) {
  window.KairoService?.renderLookThumbnail(container, look);
}

// ── Render themes list ────────────────────────────────────────────────────
// Renaming and deleting both live here now — there's no top header anymore,
// so the selected theme's own row is the one place both happen. Renaming is
// a double-click (same gesture used throughout the app); delete needs a
// real confirm since there's no undo for losing the WHOLE theme, just for
// edits within one.
function buildLookRow(look, indented) {
  const item = document.createElement('div');
  item.className = 'ts-theme-item' + (look.id === activeLook?.id ? ' active' : '') + (indented ? ' ts-theme-item-grouped' : '');

  const thumb = document.createElement('div');
  thumb.className = 'ts-theme-thumb';
  renderLookThumbnail(thumb, look);

  const name = document.createElement('span');
  name.className = 'ts-theme-name';
  name.textContent = look.name;
  name.title = 'Double-click to rename';
  name.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    startRenamingLook(name, look);
  });

  const dup = document.createElement('button');
  dup.className = 'ts-theme-del';
  dup.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="1.5"/><path d="M5 15H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h10a1 1 0 0 1 1 1v1"/></svg>`;
  dup.title = 'Duplicate theme';
  dup.addEventListener('click', (e) => {
    e.stopPropagation();
    duplicateLook(look);
  });

  item.appendChild(thumb);
  item.appendChild(name);
  item.appendChild(dup);

  // Built-ins have no delete affordance at all — duplicate is the only
  // way to build on one, matching how the Default playlist hides its own
  // delete button rather than just erroring after the fact on click.
  if (!isBuiltInLook(look)) {
    const del = document.createElement('button');
    del.className = 'ts-theme-del';
    del.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;
    del.title = 'Delete theme';
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteLook(look);
    });
    item.appendChild(del);
  }

  item.addEventListener('click', () => selectLook(look));
  return item;
}

// A collapsible header for one imported bundle's set of theme-slides — see
// collapsedThemeGroups above for why this is a visual grouping only, not a
// real container in the data model.
function buildGroupHeader(groupId, groupName, groupLooks) {
  const header = document.createElement('div');
  header.className = 'ts-theme-group-header' + (collapsedThemeGroups.has(groupId) ? ' collapsed' : '');

  const chevron = document.createElement('span');
  chevron.className = 'ts-theme-group-chevron';
  chevron.textContent = '▾';

  const thumb = document.createElement('div');
  thumb.className = 'ts-theme-thumb';
  renderLookThumbnail(thumb, groupLooks[0]);

  const name = document.createElement('span');
  name.className = 'ts-theme-group-name';
  name.textContent = groupName;
  name.title = 'Double-click to rename this theme';
  name.addEventListener('dblclick', (e) => {
    e.stopPropagation();
    startRenamingThemeGroup(name, groupId, groupLooks);
  });

  const count = document.createElement('span');
  count.className = 'ts-theme-group-count';
  count.textContent = String(groupLooks.length);

  header.appendChild(chevron);
  header.appendChild(thumb);
  header.appendChild(name);
  header.appendChild(count);
  // Built-in groups (Lyrics/Bible/Slides) get no delete affordance, same as
  // an individual built-in look's row never getting one — without this, an
  // operator could delete a whole built-in category outright, which the
  // per-look guard was specifically written to prevent for a single look.
  if (!groupLooks.every(isBuiltInLook)) {
    const del = document.createElement('button');
    del.className = 'ts-theme-del';
    del.title = 'Delete this whole theme (all its slides)';
    del.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;
    del.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteThemeGroup(groupId, groupName, groupLooks);
    });
    header.appendChild(del);
  }
  header.addEventListener('click', () => {
    if (collapsedThemeGroups.has(groupId)) collapsedThemeGroups.delete(groupId);
    else collapsedThemeGroups.add(groupId);
    renderLooksList();
  });
  return header;
}

function startRenamingThemeGroup(nameEl, groupId, groupLooks) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'ts-theme-name-input';
  input.value = groupLooks[0]?.groupName || '';
  nameEl.replaceWith(input);
  input.focus();
  input.select();
  let settled = false;
  const commit = () => {
    if (settled) return;
    settled = true;
    const newName = input.value.trim();
    if (newName) groupLooks.forEach(l => { l.groupName = newName; });
    saveLooks();
    renderLooksList();
  };
  input.addEventListener('click', e => e.stopPropagation());
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); settled = true; renderLooksList(); }
  });
}

async function deleteThemeGroup(groupId, groupName, groupLooks) {
  // Same guard as deleteLook's built-in check — the button that calls this
  // is already hidden for an all-built-in group, but guard here too in case
  // this is ever reached another way.
  if (groupLooks.every(isBuiltInLook)) { toast("Default themes can't be deleted — duplicate a slide to make an editable copy.", 'error'); return; }
  if (looks.length <= groupLooks.length) { toast('Cannot delete every theme', 'error'); return; }
  const ok = await confirmDialog(`Delete the theme "${groupName}" and all ${groupLooks.length} of its slides? This can't be undone.`, { title: 'Delete theme', confirmLabel: 'Delete', danger: true });
  if (!ok) return;
  const ids = new Set(groupLooks.map(l => l.id));
  looks = looks.filter(l => !ids.has(l.id));
  if (ids.has(activeLook?.id)) {
    activeLook  = looks[0];
    activeLayer = null; multiSelectedLayerIds.clear();
    resetThemeHistory();
  }
  saveLooks();
  renderLooksList(); renderLayersList(); renderThemeCanvasSizeSelect(); renderPreview(); renderProps();
}

function renderLooksList() {
  const el = document.getElementById('looks-list');
  if (!el) return;
  el.innerHTML = '';
  const renderedGroups = new Set();
  looks.forEach(look => {
    if (look.groupId) {
      if (renderedGroups.has(look.groupId)) return; // this group's block already rendered
      renderedGroups.add(look.groupId);
      const groupLooks = looks.filter(l => l.groupId === look.groupId);
      el.appendChild(buildGroupHeader(look.groupId, look.groupName || 'Imported theme', groupLooks));
      if (!collapsedThemeGroups.has(look.groupId)) {
        groupLooks.forEach(gl => el.appendChild(buildLookRow(gl, true)));
      }
      return;
    }
    el.appendChild(buildLookRow(look, false));
  });
}

function selectLook(look) {
  tsCommitActiveEdit(null);
  activeLook  = look;
  activeLayer = null; multiSelectedLayerIds.clear();
  resetThemeHistory();
  renderLooksList();
  renderLayersList();
  renderThemeCanvasSizeSelect();
  renderPreview();
  renderProps();
}

function startRenamingLook(nameEl, look) {
  const input = document.createElement('input');
  input.type = 'text';
  input.className = 'ts-theme-name-input';
  input.value = look.name;
  nameEl.replaceWith(input);
  input.focus();
  input.select();

  let settled = false;
  const commit = () => {
    if (settled) return;
    settled = true;
    look.name = input.value.trim() || look.name;
    scheduleThemeAutosave();
    renderLooksList();
  };
  input.addEventListener('click', e => e.stopPropagation());
  input.addEventListener('blur', commit);
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); commit(); }
    else if (e.key === 'Escape') { e.preventDefault(); settled = true; renderLooksList(); }
  });
}

// A built-in is any theme whose id matches the canonical DEFAULT_LOOKS set —
// even if the operator has since renamed/restyled it in place, the id never
// changes, so this is the one reliable test regardless of edits.
function isBuiltInLook(look) {
  return DEFAULT_LOOKS.some(d => d.id === look.id);
}

function duplicateLook(look) {
  const copy = deepClone(look);
  copy.id = 'look-' + Date.now();
  copy.name = look.name + ' Copy';
  // A duplicate is a fresh standalone theme, not another slide belonging to
  // the original's imported bundle (if it had one).
  delete copy.groupId;
  delete copy.groupName;
  looks.push(copy);
  activeLook  = copy;
  activeLayer = null; multiSelectedLayerIds.clear();
  resetThemeHistory();
  saveLooks();
  renderLooksList(); renderLayersList(); renderThemeCanvasSizeSelect(); renderPreview(); renderProps();
}

async function deleteLook(look) {
  // Built-ins can't be deleted — duplicate makes an editable copy instead,
  // so "start from a built-in" always has somewhere safe to land back on.
  if (isBuiltInLook(look)) { toast("Default themes can't be deleted — duplicate it to make an editable copy.", 'error'); return; }
  if (looks.length <= 1) { toast('Cannot delete the last theme', 'error'); return; }
  const ok = await confirmDialog(`Delete the theme "${look.name}"? This can't be undone.`, { title: 'Delete theme', confirmLabel: 'Delete', danger: true });
  if (!ok) return;
  looks = looks.filter(l => l.id !== look.id);
  if (activeLook?.id === look.id) {
    activeLook  = looks[0];
    activeLayer = null; multiSelectedLayerIds.clear();
    resetThemeHistory();
  }
  saveLooks();
  renderLooksList();
  renderLayersList();
  renderThemeCanvasSizeSelect();
  renderPreview();
  renderProps();
}

// ── Sync layout + animation + name row ───────────────────────────────────
// A theme's canvas size is purely a preview-shape hint (see renderPreview) —
// layer positions stay percentages of the fixed KAIRO_DESIGN_W/H, so this
// never affects how an existing theme lays out. Defaults to 1920x1080, same
// as ProPresenter's document default, until someone deliberately picks a
// configured output to design against instead.
function themeCanvasSize(look) {
  return (look && look.canvasSize && look.canvasSize.w && look.canvasSize.h)
    ? look.canvasSize : { w: 1920, h: 1080 };
}

// Builds the Size dropdown's options: the 1920x1080 default plus every
// configured display output that has a real physical screen assigned (see
// outputScreenMap) — mirrors ProPresenter's per-slide Size field listing
// configured device resolutions (e.g. "Atem: 1440 x 900") as presets.
function renderThemeCanvasSizeSelect() {
  const sel = document.getElementById('ts-canvas-size-select');
  if (!sel || !activeLook) return;
  const size = themeCanvasSize(activeLook);
  sel.innerHTML = '';
  const def = document.createElement('option');
  def.value = '1920x1080';
  def.textContent = '1920 × 1080 (Default)';
  sel.appendChild(def);

  if (typeof displayOutputs === 'function' && typeof outputScreenMap === 'function') {
    const screens = outputScreenMap();
    displayOutputs().forEach(d => {
      const s = screens[d.id];
      if (!s) return;
      const o = document.createElement('option');
      o.value = `${s.width}x${s.height}`;
      o.textContent = `${d.name}: ${s.width} × ${s.height}`;
      sel.appendChild(o);
    });
  }

  const wantValue = `${size.w}x${size.h}`;
  if (![...sel.options].some(o => o.value === wantValue)) {
    const custom = document.createElement('option');
    custom.value = wantValue;
    custom.textContent = `${size.w} × ${size.h} (Custom)`;
    sel.appendChild(custom);
  }
  sel.value = wantValue;
}

document.getElementById('ts-canvas-size-select')?.addEventListener('change', (e) => {
  if (!activeLook) return;
  const [w, h] = e.target.value.split('x').map(Number);
  if (!w || !h) return;
  activeLook.canvasSize = { w, h };
  scheduleThemeAutosave();
  renderPreview();
});

// The theme's own background: the canvas fill every slide sits on.
function baseBgLayer() {
  return activeLook?.layers?.find(l => l.type === 'background' && !l.pos) || null;
}

// ── Render layers list ────────────────────────────────────────────────────
// Whether `layer` is an item/slide-specific layer the operator added in
// Full-scale edit — i.e. it has no id match in the item's actual base theme
// — as opposed to a real theme layer (text, always overridable per-slide;
// background/image, fixed and read-only per-slide). Only meaningful in item
// mode; always false in theme mode, where every layer belongs to the theme.
function isItemCustomLayer(layer) {
  if (tsMode !== 'item' || !tsItemCtx) return false;
  return !(tsItemCtx.baseLook.layers || []).some(l => l.id === layer.id);
}

// Shared by the layers-list row's own delete button and the keyboard
// Delete/Backspace shortcut (see the keydown handler near selectAllLayers)
// so there's one implementation of "can this layer even be deleted" instead
// of two that could drift. Same guard as the button always had: the base
// canvas background never goes (every theme needs one), and in item mode
// only this slide's own custom layers can be removed, never a theme layer.
function deleteLayer(layer) {
  if (!layer) return;
  const isBg = layer.type === 'background' && !layer.pos;
  const isCustom = isItemCustomLayer(layer);
  if (isBg || (tsMode === 'item' && !isCustom)) return;
  const wasActive = activeLayer?.id === layer.id;
  const idx = activeLook.layers.findIndex(l => l.id === layer.id);
  activeLook.layers = activeLook.layers.filter(l => l.id !== layer.id);
  // Auto-select whatever's left in its place — deleting used to just drop
  // the selection entirely, leaving the props panel empty until the
  // operator clicked something again. Whatever now sits at the deleted
  // layer's own index IS "the next one" (everything after it shifted up
  // one slot); falls back to the new last layer if it was the last one,
  // or null once the list is genuinely empty.
  if (wasActive) {
    activeLayer = activeLook.layers[Math.min(idx, activeLook.layers.length - 1)] || null;
  }
  renderLayersList();
  renderPreview();
  renderProps();
  if (tsMode === 'item') tsSave(); else scheduleThemeAutosave();
}

function renderLayersList() {
  const el = document.getElementById('ts-layers-list');
  if (!el) return;
  el.innerHTML = '';
  if (!activeLook) return;
  // Render in reverse so background is at bottom visually (like PP). Used
  // to filter to text-only (+ custom layers) in item mode, from back when
  // a base theme's own background/image had no drag/resize wiring there
  // at all (nothing to show them for) — now that those persist properly
  // per-slide too (see writeItemSlideStyleFromSynthetic/buildSyntheticLook
  // and tsDecorateLayerEl's call sites), every layer belongs in this list
  // in item mode exactly the same as theme mode, or "the background isn't
  // editable" just moves one step over into "the background isn't even
  // visible in Layers to select".
  const rev = [...activeLook.layers].reverse();
  rev.forEach(layer => {
    const row = document.createElement('div');
    row.className = 'ts-layer-row' + (layer.id === activeLayer?.id ? ' active' : '') + (multiSelectedLayerIds.has(layer.id) ? ' multi-selected' : '');
    row.dataset.layerId = layer.id;

    const isText = layer.type === 'text';
    const isBg   = layer.type === 'background' && !layer.pos;   // base canvas only

    // Visibility icon. The dimmed state uses 'is-off', NOT the app-wide
    // 'hidden' utility class (display:none !important) — that collision
    // used to make the toggle button itself vanish the moment a layer was
    // switched off, leaving no way to turn it back on.
    const visBtn = document.createElement('button');
    visBtn.className = 'ts-layer-vis' + (layer.visible ? '' : ' is-off');
    visBtn.title = layer.visible ? 'Hide' : 'Show';
    visBtn.innerHTML = layer.visible
      ? `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`
      : `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;
    visBtn.addEventListener('click', e => {
      e.stopPropagation();
      layer.visible = !layer.visible;
      renderLayersList();
      renderPreview();
      // Pre-existing gap in theme mode: visibility toggles never called
      // scheduleThemeAutosave() either — out of scope to fix here (see
      // plan's "don't touch theme mode's behavior" note). Item mode needs
      // this, though — it's how a slide's visible:false override gets set.
      if (tsMode === 'item') tsSave();
    });

    // Type icon
    const typeIcon = document.createElement('div');
    typeIcon.className = 'ts-layer-type-icon';
    typeIcon.textContent = layer.type === 'image' ? '▣'
                         : layer.type === 'image-cycle' ? '▤'
                         : layer.type === 'motion' ? '✺'
                         : layer.type === 'background' ? '■'
                         : 'T';

    // Name
    const name = document.createElement('div');
    name.className = 'ts-layer-name';
    name.textContent = layer.name;

    // Delete (text layers only)
    const delBtn = document.createElement('button');
    delBtn.className = 'ts-layer-del';
    delBtn.title = 'Delete layer';
    delBtn.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>`;
    // No add/delete/reorder of a theme's own layers in item mode — an
    // override slide can only ever restyle EXISTING theme layers, never
    // restructure the theme's layer stack. A custom layer the operator
    // added to this slide is the exception — it's the operator's own, not
    // the theme's, so it can be deleted here.
    const isCustom = isItemCustomLayer(layer);
    if (isBg || (tsMode === 'item' && !isCustom)) delBtn.style.display = 'none';
    delBtn.addEventListener('click', e => {
      e.stopPropagation();
      deleteLayer(layer);
    });

    // Drag handle — reordering changes paint order (top of the list paints
    // last / in front, matching how the rows are shown). Works in item mode
    // too — every layer shows as a row there now (see the note above where
    // the old text-only filter used to live), and any reorder there is
    // persisted per-slide via __layerOrder (see writeItemSlideStyleFromSynthetic/
    // buildSyntheticLook) rather than touching the theme's own order.
    const grip = document.createElement('div');
    grip.className = 'ts-layer-grip';
    grip.title = 'Drag to reorder';
    grip.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round"><line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/></svg>`;

    row.appendChild(grip);
    row.appendChild(visBtn);
    row.appendChild(typeIcon);
    row.appendChild(name);
    row.appendChild(delBtn);

    row.draggable = true;
    row.addEventListener('dragstart', (e) => {
      tsDragLayerId = layer.id;
      row.classList.add('ts-layer-dragging');
      e.dataTransfer.effectAllowed = 'move';
      // Firefox requires data to be set for a drag to start.
      try { e.dataTransfer.setData('text/plain', layer.id); } catch {}
    });
    row.addEventListener('dragend', () => {
      tsDragLayerId = null;
      document.querySelectorAll('.ts-layer-row').forEach(r =>
        r.classList.remove('ts-layer-dragging', 'ts-layer-drop-before', 'ts-layer-drop-after'));
    });
    row.addEventListener('dragover', (e) => {
      if (!tsDragLayerId || tsDragLayerId === layer.id) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      const r = row.getBoundingClientRect();
      const after = (e.clientY - r.top) > r.height / 2;
      row.classList.toggle('ts-layer-drop-after', after);
      row.classList.toggle('ts-layer-drop-before', !after);
    });
    row.addEventListener('dragleave', () => {
      row.classList.remove('ts-layer-drop-before', 'ts-layer-drop-after');
    });
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      const after = row.classList.contains('ts-layer-drop-after');
      row.classList.remove('ts-layer-drop-before', 'ts-layer-drop-after');
      reorderLayer(tsDragLayerId, layer.id, after);
    });

    row.addEventListener('click', (e) => {
      tsCommitActiveEdit(layer.id);
      // Same modifier convention as the canvas itself (tsToggleMultiSelect)
      // — the Layers list is a second place to build the same selection,
      // not a separate mechanism with its own rules.
      if (e.shiftKey || e.metaKey || e.ctrlKey) {
        tsToggleMultiSelect(layer);
        return;
      }
      activeLayer = layer;
      multiSelectedLayerIds = new Set(); // a plain click always narrows back to one
      renderLayersList();
      renderProps();
      renderPreview();
    });
    // Right-click menu for the same Select All/Copy/Paste shortcut already
    // wired above — discoverability for an operator who's never found
    // Cmd/Ctrl+A/C/V. Same item-mode restriction: a pasted layer has no
    // counterpart on the base theme to diff into item.slideStyles.
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      if (tsMode === 'item') return;
      const sections = [[
        { label: 'Select All', onClick: selectAllLayers },
        { label: 'Copy', onClick: () => { activeLayer = layer; copyLayers(); } },
      ]];
      if (layerClipboard.length) sections[0].push({ label: 'Paste', onClick: pasteLayers });
      window.KairoService.openContextMenu(e.clientX, e.clientY, sections);
    });

    el.appendChild(row);
  });
}

let tsDragLayerId = null;

// Move `draggedId` next to `targetId`. The list is rendered reversed (front
// layer on top), so a drop "after" a row in the list means *below* it visually,
// i.e. earlier in the underlying paint array.
function reorderLayer(draggedId, targetId, after) {
  if (!activeLook || !draggedId || draggedId === targetId) return;
  const layers = activeLook.layers;
  const from = layers.findIndex(l => l.id === draggedId);
  const to   = layers.findIndex(l => l.id === targetId);
  if (from < 0 || to < 0) return;

  const [moved] = layers.splice(from, 1);
  // Recompute the target index after removal, then convert the visual
  // before/after into array position (array order is back-to-front).
  let idx = layers.findIndex(l => l.id === targetId);
  if (!after) idx += 1;          // visually above → later in paint order
  layers.splice(Math.max(0, Math.min(layers.length, idx)), 0, moved);

  renderLayersList();
  renderPreview();
  // Was a silent no-op before — mutated activeLook.layers in place but never
  // told either save path about it, so a reorder with no other edit
  // afterward quietly reverted on reload/theme-switch. tsSave() routes to
  // scheduleItemStyleAutosave (which now also records __layerOrder, see
  // writeItemSlideStyleFromSynthetic) in item mode, scheduleThemeAutosave otherwise.
  tsSave();
}

// applyLayerOrder — used by buildSyntheticLook to replay a per-slide
// reorder recorded in item.slideStyles[slideIndex].__layerOrder. See
// src/layer_geometry.js for the shared implementation (loaded via
// index.html before this script) — was a byte-identical copy-paste across
// this file, service.js, and display.html.

// ── Render preview ────────────────────────────────────────────────────────
const PREVIEW_TEXT_SAMPLE = 'For God so loved the world, that he gave his only begotten Son.';
const PREVIEW_REF_SAMPLE  = 'John 3:16 (KJV)';
const PREVIEW_TIMER_SAMPLE = '12:34'; // static placeholder while editing — the real value only ever exists live on the actual output
const SCALE = 0.14; // preview is ~14% of full display size

// Same John 3:16 the left panel previews, in each supported language — real
// bundled-Bible wording (databases/i18n/*.json), not a placeholder, so a
// Multi-Language theme's right panel can actually be designed against text
// of the length/shape it will really show, not "[Custom Text]".
const TS_TRANSLATE_LANGUAGES = [
  { code: 'fr', name: 'French' },
  { code: 'es', name: 'Spanish' },
  { code: 'pt', name: 'Portuguese' },
];
const TS_TRANSLATE_SAMPLES = {
  fr: "Car Dieu a tant aimé le monde, qu'il a donné son Fils unique, afin que quiconque croit en lui ne périsse point, mais qu'il ait la vie éternelle.",
  es: 'Porque de tal manera amó Dios al mundo, que haya dado a su Hijo unigénito; para que todo aquel que en él creyere, no se pierda, mas tenga vida eterna.',
  pt: 'Porque Deus amou ao mundo de tal maneira, que deu o seu Filho unigênito; para que todo aquele que nele crê não pereça, mas tenha a vida eterna.',
};

function layerTextContent(layer) {
  // Item mode edits a REAL slide's layout — the canvas has to show that
  // slide's actual text, not Theme Studio's generic sample, or positioning/
  // auto-fit decisions made here wouldn't match what's really being edited.
  if (tsMode === 'item' && tsItemCtx) {
    const slides = window.KairoService?.slidesFor?.(tsItemCtx.item) || [];
    const s = slides[tsItemCtx.slideIndex];
    if (s) {
      if (layer.binding === 'verse') return s.text || '(empty slide)';
      if (layer.binding === 'reference') return s.reference || '';
      if (layer.binding === 'timer') return s.timerText || configuredTimerText(tsItemCtx.item) || PREVIEW_TIMER_SAMPLE;
      if (layer.binding === 'timer-h') return '00';
      if (layer.binding === 'timer-m') return '12';
      if (layer.binding === 'timer-s') return '34';
      if (layer.binding === 'verse_translated') {
        return TS_TRANSLATE_SAMPLES[tsItemCtx.item.translateTo] || '[No translation language set for this item]';
      }
      if (layer.binding === 'custom' && typeof layer.customText === 'string' && layer.customText.includes('{timer}')) {
        return layer.customText.replace('{timer}', s.timerText || configuredTimerText(tsItemCtx.item) || PREVIEW_TIMER_SAMPLE);
      }
      return layer.customText || '[Custom Text]';
    }
  }
  if (layer.binding === 'verse')     return PREVIEW_TEXT_SAMPLE;
  if (layer.binding === 'reference') return PREVIEW_REF_SAMPLE;
  if (layer.binding === 'timer')     return PREVIEW_TIMER_SAMPLE;
  if (layer.binding === 'timer-h')   return '00';
  if (layer.binding === 'timer-m')   return '12';
  if (layer.binding === 'timer-s')   return '34';
  if (layer.binding === 'verse_translated') {
    return TS_TRANSLATE_SAMPLES[activeLook?.translateTo] || '[Pick a language below]';
  }
  // "{timer}" placeholder — lets an operator weave the live countdown INTO a
  // sentence (e.g. "We begin in {timer}") instead of it only existing as its
  // own separate element. Mirrors the same substitution in display.html's
  // buildLayerDOM and service.js's paintLookLayers.
  if (layer.binding === 'custom' && typeof layer.customText === 'string' && layer.customText.includes('{timer}')) {
    return layer.customText.replace('{timer}', PREVIEW_TIMER_SAMPLE);
  }
  return layer.customText || '[Custom Text]';
}

// Computes the largest box matching a w:h ratio that fits inside
// .ts-preview-wrap's real padded content area, and sets it as explicit px
// inline styles on the stage. Two pure-CSS auto-sizing techniques were tried
// first and each failed differently: `position:absolute; inset:0; margin:auto`
// with width/height:auto measured as stretching to fill one axis exactly
// regardless of aspect-ratio/max-width (confirmed via getBoundingClientRect —
// a real 0px gap on that axis, not just visually looking full); switching to
// a single-point anchor (top:50%;left:50%;transform) to avoid that removed
// the stretch but ALSO removed anything driving the box to actually grow —
// with no intrinsic content size (every layer inside renders position:absolute,
// contributing nothing to auto-sizing), it collapsed to near-zero. Measuring
// the real available space and setting explicit pixel dimensions sidesteps
// both failure modes entirely.
function fitPreviewStage(stage, w, h) {
  const wrap = stage.parentElement;
  if (!wrap) return;
  const cs = getComputedStyle(wrap);
  const availW = wrap.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
  const availH = wrap.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom);
  if (availW <= 0 || availH <= 0) return;
  const ratio = w / h;
  let stageW = availW, stageH = stageW / ratio;
  if (stageH > availH) { stageH = availH; stageW = stageH * ratio; }
  stage.style.width  = Math.round(stageW) + 'px';
  stage.style.height = Math.round(stageH) + 'px';
}
// Re-fit on window resize — the stage's size is now computed once per
// render, not left to the browser to keep recomputing on its own the way a
// pure-CSS approach would.
window.addEventListener('resize', () => {
  const stage = document.getElementById('looks-preview-stage');
  if (stage && activeLook) fitPreviewStage(stage, themeCanvasSize(activeLook).w, themeCanvasSize(activeLook).h);
});

// isVideoLayerSrc, applyShapeGeometry — see src/layer_geometry.js for the
// shared implementation (loaded via index.html before this script). Was a
// byte-identical copy-paste across this file, service.js, and
// display.html; applyShapeGeometry's `scale` here is a px scale factor
// (this canvas's own coordinate system) — see that file's own comment for
// how display.html's vh-based coordinate system uses the same function.

// An image layer's picture inside its box in the editor canvas: clipped to
// the box (so Ken Burns can zoom inside it) and carrying the photo look —
// kept off the layer's own element, whose children include the selection
// and rotate handles.
function tsImageArt(layer, src, fit, kenBurns) {
  const clip = document.createElement('div');
  clip.style.cssText = 'position:absolute;inset:0;overflow:hidden;border-radius:inherit;';
  const art = document.createElement('div');
  art.style.cssText = `position:absolute;inset:0;background-repeat:no-repeat;background-position:center;background-image:url('${src}');background-size:${fit === 'fill' ? '100% 100%' : fit};`
    + (kenBurns ? 'animation:kairo-kenburns 18s ease-in-out infinite alternate;' : '');
  clip.appendChild(art);
  applyImageLook(clip, layer);
  return clip;
}

function renderPreview() {
  const stage = document.getElementById('looks-preview-stage');
  if (!stage || !activeLook) return;

  stage.innerHTML = '';
  stage.className = 'ts-preview-stage';
  // Preview-shape only (see themeCanvasSize) — layer positions below still
  // work entirely in percentages of the fixed TS_DESIGN_W/H, unaffected by
  // whatever shape this box actually renders at.
  const size = themeCanvasSize(activeLook);
  stage.style.aspectRatio = `${size.w} / ${size.h}`;
  fitPreviewStage(stage, size.w, size.h);

  const layout = activeLook.layout;
  // Dynamic preview scale — real stage width over design width, so fonts and
  // free positions render at true relative size whatever the modal size is.
  const pxScale = (stage.clientWidth / TS_DESIGN_W) || SCALE;
  // "Play" (tsPlayBuilds) replays every layer's build-in once; any other
  // repaint — every edit is one — shows the finished slide.
  const playing = tsPlayBuilds;
  tsPlayBuilds = false;

  const paintLayer = (layer) => {
    if (!layer.visible) return;

    if (layer.type === 'background') {
      const div = document.createElement('div');
      div.style.cssText = 'position:absolute;inset:0;';

      if (layer.fill === 'transparent') {
        stage.classList.add('ts-transparent-bg');
        // Nothing to paint, but it's still the canvas's own surface: a click
        // selects the background and a drag across it draws a selection box,
        // the same as on a filled canvas.
        if (!layer.pos) { stage.appendChild(div); tsDecorateLayerEl(div, layer, false); }
        return;
      }
      if (layer.fill === 'solid') {
        div.style.background = hexOpacity(layer.color, layer.opacity);
      } else if (layer.fill === 'gradient') {
        const c1 = hexOpacity(layer.color, layer.opacity);
        const c2 = hexOpacity(layer.color2, layer.opacity);
        div.style.background = `linear-gradient(${layer.angle}deg, ${c1}, ${c2})`;
      } else if (layer.fill === 'image') {
        div.style.background = imageFillCss(layer);
        if ((layer.opacity ?? 100) < 100) div.style.opacity = String((layer.opacity ?? 100) / 100);
      } else if (layer.fill === 'blur') {
        div.style.background = hexOpacity(layer.color, layer.opacity);
        div.style.backdropFilter = 'blur(8px)';
        // For lower-third, only cover bottom portion
        if (layout === 'lower-third') {
          div.style.inset = 'auto 0 0 0';
          div.style.height = '38%';
        } else if (layout === 'ticker') {
          div.style.inset = 'auto 0 0 0';
          div.style.height = '18%';
        }
      }

      // Lower-third: bg only covers bottom strip
      if ((layout === 'lower-third' || layout === 'ticker') && layer.fill !== 'blur') {
        div.style.inset = 'auto 0 0 0';
        div.style.height = layout === 'ticker' ? '18%' : '38%';
      }

      // Split: bg covers one half, full height
      if (layout === 'split-left') {
        div.style.inset = '0 auto 0 0';
        div.style.width = '50%';
        div.style.height = '';
      } else if (layout === 'split-right') {
        div.style.inset = '0 0 0 auto';
        div.style.width = '50%';
        div.style.height = '';
      }

      // Free-canvas override (shapes / repositioned backgrounds)
      if (layer.pos) {
        div.style.inset  = '';
        div.style.left   = (layer.pos.x / TS_DESIGN_W * 100) + '%';
        div.style.top    = (layer.pos.y / TS_DESIGN_H * 100) + '%';
        div.style.width  = (layer.pos.w / TS_DESIGN_W * 100) + '%';
        div.style.height = (layer.pos.h / TS_DESIGN_H * 100) + '%';
        div.style.right  = 'auto';
        div.style.bottom = 'auto';
        applyShapeGeometry(div, layer, pxScale);
        if (layer.rotation) div.style.transform = `rotate(${layer.rotation}deg)`;
      }

      stage.appendChild(div);
      // Full-stage backgrounds are select-only; positioned shapes are
      // draggable, in item mode same as theme mode — repositioning a base
      // theme's own layer per-slide now actually persists (see
      // writeItemSlideStyleFromSynthetic/buildSyntheticLook, which used to
      // only diff text layers, the real reason this was item-mode-only
      // before: dragging something that couldn't be saved would just look
      // like it worked and silently revert).
      tsDecorateLayerEl(div, layer, !!layer.pos);
      return;
    }

    if (layer.type === 'image') {
      const p = layer.pos || { x: 0, y: 0, w: TS_DESIGN_W, h: TS_DESIGN_H };
      const fit = layer.fit === 'fill' ? 'fill' : (layer.fit || 'contain');
      const posCss = `
        position:absolute;
        left:${(p.x / TS_DESIGN_W * 100)}%;
        top:${(p.y / TS_DESIGN_H * 100)}%;
        width:${(p.w / TS_DESIGN_W * 100)}%;
        height:${(p.h / TS_DESIGN_H * 100)}%;
        opacity:${(layer.opacity ?? 100) / 100};
        border-radius:${((layer.radius || 0) * pxScale).toFixed(1)}px;
        ${layer.rotation ? `transform: rotate(${layer.rotation}deg);` : ''}
      `;
      // A theme "image" layer's src is occasionally an actual video file —
      // Theme Studio's own file picker doesn't hard-block it (native OS
      // dialogs don't strictly enforce accept="image/*") and drag-and-drop
      // never respected that hint either. background-image can't play a
      // video at all, so this showed as a permanently frozen frame with no
      // error to explain why — same fix as display.html/paintLookLayers.
      const div = isVideoLayerSrc(layer.src) ? document.createElement('video') : document.createElement('div');
      if (div.tagName === 'VIDEO') {
        div.autoplay = true; div.loop = true; div.muted = true; div.playsInline = true;
        div.style.cssText = posCss + `object-fit:${fit};`;
        div.src = layer.src;
        applyImageLook(div, layer);
      } else {
        // The picture is drawn one level in (tsImageArt): clipped for Ken
        // Burns, which moves here too — the whole point of a "does this feel
        // dynamic" judgment call is seeing the motion while picking colors/
        // copy — and carrying the photo look, since the selection and rotate
        // handles are children of `div` and a fade mask on `div` would hide
        // them too.
        div.style.cssText = posCss;
        div.appendChild(tsImageArt(layer, layer.src, fit, layer.motion === 'kenburns'));
      }
      stage.appendChild(div);
      if (div.tagName === 'VIDEO') div.play().catch(() => {});
      // Same as the background branch above — full drag/resize in item
      // mode too, now that it actually persists.
      tsDecorateLayerEl(div, layer, true);
      return;
    }

    // Image Cycle — editing always shows the first frame as a stand-in; the
    // live per-second advance (triggers.js's totalMs/remainingMs) only
    // happens on the real output, not in this canvas. See
    // renderImageCycleProps for the "Images" list that fills `sources`.
    if (layer.type === 'image-cycle') {
      const p = layer.pos || { x: 0, y: 0, w: TS_DESIGN_W, h: TS_DESIGN_H };
      const fit = layer.fit === 'fill' ? 'fill' : (layer.fit || 'cover');
      const first = (layer.sources || [])[0];
      const div = document.createElement('div');
      const kenBurns = layer.motion === 'kenburns' && !!first;
      div.style.cssText = `
        position:absolute;
        left:${(p.x / TS_DESIGN_W * 100)}%;
        top:${(p.y / TS_DESIGN_H * 100)}%;
        width:${(p.w / TS_DESIGN_W * 100)}%;
        height:${(p.h / TS_DESIGN_H * 100)}%;
        opacity:${(layer.opacity ?? 100) / 100};
        border-radius:${((layer.radius || 0) * pxScale).toFixed(1)}px;
        ${first ? '' : 'background:#1a1a1e;'}
        ${layer.rotation ? `transform: rotate(${layer.rotation}deg);` : ''}
      `;
      // The first frame, drawn one level in like the plain 'image' branch.
      if (first) div.appendChild(tsImageArt(layer, first, fit, kenBurns));
      if ((layer.sources || []).length > 1) {
        const badge = document.createElement('span');
        badge.style.cssText = 'position:absolute;top:6px;right:6px;background:rgba(0,0,0,0.6);color:#fff;font-size:10px;font-weight:700;padding:2px 6px;border-radius:4px;pointer-events:none;';
        badge.textContent = `1 / ${layer.sources.length}`;
        div.appendChild(badge);
      }
      stage.appendChild(div);
      // Full drag/resize in item mode too — this is exactly the "the
      // background isn't editable" gap: an Image Cycle layer is a base
      // theme layer, same as any image/background, and those used to have
      // no drag wiring at all in item mode because there was nowhere for
      // the change to persist to (see writeItemSlideStyleFromSynthetic).
      tsDecorateLayerEl(div, layer, true);
      return;
    }

    // Motion graphic (motion_graphics.js) — animated here too, and a timer
    // kind loops a sample countdown ('demo'), so its motion can be judged
    // while picking colours and speed rather than only on the live output.
    if (layer.type === 'motion') {
      const p = layer.pos || { x: 0, y: 0, w: TS_DESIGN_W, h: TS_DESIGN_H };
      const div = document.createElement('div');
      div.style.cssText = `
        position:absolute;
        left:${(p.x / TS_DESIGN_W * 100)}%;
        top:${(p.y / TS_DESIGN_H * 100)}%;
        width:${(p.w / TS_DESIGN_W * 100)}%;
        height:${(p.h / TS_DESIGN_H * 100)}%;
        opacity:${(layer.opacity ?? 100) / 100};
        ${layer.rotation ? `transform: rotate(${layer.rotation}deg);` : ''}
      `;
      if (window.KairoMotion) {
        const delay = playing ? window.KairoMotion.normalizeBuild(layer.build).delay : 0;
        // Held still while something is being dragged: every drag frame
        // repaints the canvas, which would rebuild and restart each moving
        // part on every frame.
        const busy = (tsDrag && tsDrag.armed) || (tsMarquee && tsMarquee.armed);
        div.appendChild(window.KairoMotion.build(layer.graphic, { mode: busy ? 'still' : 'demo', box: { w: p.w, h: p.h }, delay }));
      }
      stage.appendChild(div);
      tsDecorateLayerEl(div, layer, true);
      return;
    }

    if (layer.type === 'text') {
      const div = document.createElement('div');
      div.style.cssText = `
        position: absolute;
        display: flex;
        flex-direction: column;
        justify-content: center;
        color: ${hexOpacity(layer.color, layer.opacity)};
        font-family: '${layer.font.family}', system-ui, sans-serif;
        font-size: ${(layer.font.size * pxScale).toFixed(1)}px;
        font-weight: ${layer.font.weight};
        font-style: ${layer.font.italic ? 'italic' : 'normal'};
        line-height: ${layer.font.lineHeight};
        letter-spacing: ${(layer.font.letterSpacing * pxScale).toFixed(2)}px;
        text-transform: ${layer.font.transform};
        text-align: ${layer.align};
        ${layer.binding === 'custom' ? 'white-space: pre-line;' : ''}
        padding: ${layout === 'fullscreen' ? '8%' : '3% 5%'};
      `;

      // Shadow
      if (layer.shadow.enabled) {
        const sc = hexOpacity(layer.shadow.color, layer.shadow.opacity);
        div.style.textShadow = `${layer.shadow.x}px ${(layer.shadow.y * pxScale).toFixed(1)}px ${(layer.shadow.blur * pxScale).toFixed(1)}px ${sc}`;
      }

      // Position based on layout and binding
      if (layout === 'fullscreen') {
        // Stack verse + ref centered
        div.style.left = '0'; div.style.right = '0';
        if (layer.binding === 'verse')     { div.style.top = '50%'; div.style.transform = 'translateY(-60%)'; }
        if (layer.binding === 'reference') { div.style.top = '50%'; div.style.transform = 'translateY(20%)'; }
        if (layer.binding === 'timer')     { div.style.top = '5%'; div.style.right = '4%'; div.style.left = 'auto'; }
        if (layer.align === 'left') { div.style.textAlign = 'left'; }
      } else if (layout === 'lower-third') {
        div.style.left = '0'; div.style.right = '0'; div.style.bottom = '0';
        if (layer.binding === 'verse')     { div.style.bottom = '10%'; }
        if (layer.binding === 'reference') { div.style.bottom = '3%'; }
        if (layer.binding === 'timer')     { div.style.top = '5%'; div.style.bottom = 'auto'; div.style.right = '4%'; div.style.left = 'auto'; }
        div.style.padding = '0 5%';
      } else if (layout === 'ticker') {
        div.style.left = '0'; div.style.right = '0'; div.style.bottom = '2%';
        div.style.whiteSpace = 'nowrap';
        div.style.overflow = 'hidden';
        div.style.textOverflow = 'ellipsis';
        div.style.padding = '0 3%';
      } else if (layout === 'scroll-fill') {
        // Large scrolling text that fills the whole screen — same marquee
        // mechanism as the ticker layer below, just a taller/bigger band
        // instead of a thin strip at the bottom.
        div.style.left = '0'; div.style.right = '0'; div.style.top = '0'; div.style.bottom = '0';
        div.style.display = 'flex'; div.style.alignItems = 'center';
        div.style.whiteSpace = 'nowrap';
        div.style.overflow = 'hidden';
        div.style.padding = '0';
      } else if (layout === 'split-left' || layout === 'split-right') {
        div.style.width = '50%';
        div.style.padding = '0 4%';
        if (layout === 'split-left') div.style.left = '0'; else div.style.right = '0';
        if (layer.binding === 'verse')     { div.style.top = '50%'; div.style.transform = 'translateY(-58%)'; }
        if (layer.binding === 'reference') { div.style.top = '50%'; div.style.transform = 'translateY(120%)'; }
        if (layer.binding === 'timer')     { div.style.top = '5%'; }
      }

      // Free-canvas override: explicit box wins over every layout rule.
      if (layer.pos) {
        div.style.left      = (layer.pos.x / TS_DESIGN_W * 100) + '%';
        div.style.top       = (layer.pos.y / TS_DESIGN_H * 100) + '%';
        div.style.width     = (layer.pos.w / TS_DESIGN_W * 100) + '%';
        div.style.right     = 'auto';
        div.style.bottom    = 'auto';
        div.style.transform = layer.rotation ? `rotate(${layer.rotation}deg)` : 'none';
        div.style.padding   = '0';
        if (layer.pos.h > 0) div.style.height = (layer.pos.h / TS_DESIGN_H * 100) + '%';
        // Entrance (layer.entrance) only applies to a free-positioned
        // layer — one of the layout presets above may already be using
        // `transform` for its own centering, and a CSS animation on the
        // same property would replace that (not compose with it) for as
        // long as the animation runs and permanently once it ends, which
        // would silently break that positioning. layer.pos always resets
        // transform to 'none' right above, so there's nothing to conflict
        // with here.
        if (layer.entrance === 'fade-up') div.style.animation = 'kairo-text-in 700ms ease-out both';
      }

      if (layer.binding) div.dataset.binding = layer.binding;
      div.dataset.baseSize = (layer.font.size * pxScale).toFixed(1);
      // Marquee scroll — an inner span pushed fully off the right edge
      // (padding-left:100%) and animated to translateX(-100%) so it crosses
      // the whole band and loops, without needing to measure text width.
      // Independent of layout: works on the Ticker preset's bottom strip or
      // a free-canvas "Scroll — Fill Screen" band just as well.
      if (layer.scroll?.enabled) {
        div.style.whiteSpace = 'nowrap';
        div.style.overflow = 'hidden';
        div.style.textOverflow = 'clip';
        const span = document.createElement('span');
        span.style.display = 'inline-block';
        span.style.paddingLeft = '100%';
        span.style.animation = `kairo-marquee ${Math.max(1, layer.scroll.speed || 15)}s linear infinite`;
        span.textContent = layerTextContent(layer);
        div.textContent = '';
        div.appendChild(span);
      } else if (layer.binding === 'verse' && window.KairoWordSplit?.applyMotionText(div, activeLook.textAnimation, layerTextContent(layer), activeLook.textAnimationSpeed || 1, { color: activeLook.textHighlightColor, intensity: activeLook.textAnimationIntensity })) {
        // Theme Studio's own canvas — same per-element motion rendering as
        // the Live Preview panel/real output (see renderPreviewScreen/
        // buildLayerDOM), so a Motion theme actually shows the effect while
        // it's being designed, not just once sent live.
      } else if (hasAccentMarkup(layerTextContent(layer), layer.accentColor)) {
        div.innerHTML = accentHtml(layerTextContent(layer), layer.accentColor);
      } else {
        div.textContent = layerTextContent(layer);
      }
      stage.appendChild(div);

      // Auto-grow a free-canvas box the moment its content no longer fits
      // it — increasing font size (or weight, or letter-spacing, or just
      // typing more) previously left the box exactly as wide as it was,
      // so the text silently overflowed past it with no visual sign the
      // box and the actual rendered text had drifted apart, and no way to
      // tell from the resize handles either (they still framed the OLD,
      // now-wrong box). scrollWidth > clientWidth is specifically the
      // right signal here because normal wrapping doesn't trip it — a
      // genuinely multi-line wrapped block reports scrollWidth <=
      // clientWidth just fine. Only a single run of text that literally
      // can't break onto a new line (one long word, or any text at all
      // once the font is bigger than the box) does — exactly the case
      // that was reported.
      // (Not scrolling text: a marquee runs past its box on purpose — growing
      // it widened the box to the whole screen for good.)
      if (layer.pos && !layer.scroll?.enabled && div.scrollWidth > div.clientWidth + 1) {
        const stageRectNow = stage.getBoundingClientRect();
        if (stageRectNow.width > 0) {
          // Capped at the canvas's own width — growing wasn't meant to be
          // unbounded, just enough to stop a normal size bump from quietly
          // drifting past its box. An absurd font size (some hundreds of
          // px) can still ask for more than 1920 design-px wide; letting
          // the box balloon past the canvas edge to chase that just moved
          // the same "silently wrong" problem onto the BOX instead of the
          // text, and dragged its own x off wherever centering happened to
          // land. Past this cap the box holds still and the text clips
          // (overflow:hidden below) with a warning outline instead —
          // visible and correct, rather than invisibly wrong in a new way.
          const neededW = Math.min(TS_DESIGN_W, Math.ceil(div.scrollWidth / stageRectNow.width * TS_DESIGN_W) + 4);
          if (neededW > layer.pos.w) {
            const grow = neededW - layer.pos.w;
            // Grow from the box's own CENTER for centered text (the
            // overwhelmingly common case), not just widening rightward —
            // pinning x and only extending w drags a centered line's
            // visual center off to the right as it grows, which read as
            // the box growing in a lopsided, unexpected direction. Left/
            // right-aligned text still anchors from its own edge, since
            // that's the edge the text is actually reading from.
            if (layer.align === 'center') layer.pos.x = Math.round(layer.pos.x - grow / 2);
            else if (layer.align === 'right') layer.pos.x = Math.round(layer.pos.x - grow);
            layer.pos.w = neededW;
            div.style.left = (layer.pos.x / TS_DESIGN_W * 100) + '%';
            div.style.width = (layer.pos.w / TS_DESIGN_W * 100) + '%';
          }
          // Still doesn't fit even at the cap — clip instead of spilling
          // past the canvas edge uncontained, and outline it red so it
          // reads as "this needs a smaller size", not a rendering bug.
          const stillOverflows = div.scrollWidth > (layer.pos.w / TS_DESIGN_W * stageRectNow.width) + 1;
          div.style.overflow = stillOverflows ? 'hidden' : '';
          div.style.outline = stillOverflows ? '2px solid var(--red)' : '';
        }
      }

      tsDecorateLayerEl(div, layer, true);

      // Double-click to type directly into the shape on the canvas —
      // matches every other design tool (PowerPoint, Canva, Figma, Keynote)
      // instead of forcing a trip to the props panel's separate "Text"
      // field for a one-word edit. A 'custom' binding always qualifies
      // (customText is the one free-typed string a layer has); a 'verse'
      // binding ALSO qualifies, but only in item mode — there, "verse" is
      // that specific song/slide's own lyric line (real words, backed by
      // commitSlideText), not a live scripture auto-detection with nothing
      // of the operator's own to edit. reference/timer/timer-h/m/s stay
      // computed-only either way.
      const editableInPlace = layer.binding === 'custom'
        || (layer.binding === 'verse' && tsMode === 'item' && tsItemCtx);
      if (editableInPlace) {
        // A SEPARATE mousedown listener, timed by hand (tsHandleLayerDblClick)
        // rather than a 'click'-based double-click helper — this element is
        // draggable, and tsDecorateLayerEl's OWN mousedown (registered just
        // above) always starts a real drag session first, regardless of
        // what this click turns out to be. Whichever listener runs second
        // still fires normally (stopPropagation only blocks bubbling to
        // ancestors, not sibling listeners on the same element/event), so
        // this can reliably detect "that was the second click" and cancel
        // the drag tsBeginDrag already started before handing off to
        // beginInlineTextEdit — without that cancellation, the pending
        // mouseup still fires tsDragEnd's own full re-render a moment
        // later, which destroyed the just-focused editable field before a
        // single keystroke could land (the "looks like it's calling a
        // transition" flash).
        div.addEventListener('mousedown', (e) => tsHandleLayerDblClick(e, div, layer));
      }

      // Load font
      if (layer.font.family !== 'system-ui') loadGoogleFont(layer.font.family);
    }
  };
  // Idle motion runs here too, so it can be judged while editing; build-ins
  // only when Play asked for them.
  const unit = ((stage.clientHeight || TS_DESIGN_H * pxScale) / 100).toFixed(2) + 'px';
  activeLook.layers.forEach(layer => {
    const before = stage.childNodes.length;
    paintLayer(layer);
    if (!window.KairoMotion) return;
    for (let i = before; i < stage.childNodes.length; i++) window.KairoMotion.animateLayer(stage.childNodes[i], layer, { builds: playing, unit });
  });

  // Auto-fit the verse in the preview so long verses (e.g. Esther 8:9) shrink to
  // fit — mirrors the live renderer's fitVerse() so the preview never lies about
  // how a long verse will actually lay out on the output.
  fitPreviewVerse(stage, layout);

  // Alignment guides — only while actively dragging/resizing, so the operator
  // can see exactly what a snap locked onto (a breakpoint or another layer's
  // edge) instead of reading it off the Position/Dimension numbers.
  if (tsDrag) {
    if (tsSnapGuides.x != null) {
      const v = document.createElement('div');
      v.className = 'ts-guide ts-guide-v';
      v.style.left = (tsSnapGuides.x / TS_DESIGN_W * 100) + '%';
      stage.appendChild(v);
    }
    if (tsSnapGuides.y != null) {
      const h = document.createElement('div');
      h.className = 'ts-guide ts-guide-h';
      h.style.top = (tsSnapGuides.y / TS_DESIGN_H * 100) + '%';
      stage.appendChild(h);
    }
    // What the gesture is doing, in numbers, under the layer — position while
    // moving, size (and type size, for a text corner) while resizing, the
    // angle while rotating.
    const l = tsDrag.layer, p = l?.pos;
    if (tsDrag.armed && p && tsDrag.mode !== 'group-scale') {
      const badge = document.createElement('div');
      badge.className = 'ts-drag-badge';
      if (tsDrag.mode === 'move') badge.textContent = `X ${p.x}   Y ${p.y}`;
      else if (tsDrag.mode === 'rotate') badge.textContent = `${l.rotation || 0}°`;
      else {
        const h = p.h > 0 ? p.h : Math.round(tsEffectiveH(l, p));
        badge.textContent = `${p.w} × ${h}` + (l.type === 'text' && l.font && tsDrag.startFont && l.font.size !== tsDrag.startFont.size ? `   ${l.font.size} px type` : '');
      }
      const bottom = p.y + (p.h > 0 ? p.h : tsEffectiveH(l, p));
      badge.style.left = ((p.x + p.w / 2) / TS_DESIGN_W * 100) + '%';
      badge.style.top = (Math.min(bottom + 28, TS_DESIGN_H - 10) / TS_DESIGN_H * 100) + '%';
      stage.appendChild(badge);
    }
  }
  // A multi-selection's own frame, with corner handles to scale the group.
  if (multiSelectedLayerIds.size >= 2) {
    const sel = tsSelectedLayers();
    if (sel.length >= 2) {
      const b = tsGroupBounds(sel, { measureOnly: true });
      const f = document.createElement('div');
      f.className = 'ts-group-frame';
      f.style.left = (b.x / TS_DESIGN_W * 100) + '%';
      f.style.top = (b.y / TS_DESIGN_H * 100) + '%';
      f.style.width = (b.w / TS_DESIGN_W * 100) + '%';
      f.style.height = (b.h / TS_DESIGN_H * 100) + '%';
      ['nw', 'ne', 'se', 'sw'].forEach(dir => {
        const h = document.createElement('div');
        h.className = `ts-handle ts-handle-${dir}`;
        h.addEventListener('mousedown', (e) => tsBeginGroupScale(e, dir));
        f.appendChild(h);
      });
      if (tsDrag && tsDrag.mode === 'group-scale' && tsDrag.scale) {
        const badge = document.createElement('div');
        badge.className = 'ts-drag-badge';
        badge.textContent = `${Math.round(tsDrag.scale * 100)}%`;
        badge.style.left = '50%';
        badge.style.top = 'calc(100% + 14px)';
        f.appendChild(badge);
      }
      stage.appendChild(f);
    }
  }
  // Drag-a-box selection in progress.
  if (tsMarquee && tsMarquee.armed) {
    const m = tsMarquee.box;
    const r = document.createElement('div');
    r.className = 'ts-marquee';
    r.style.left = (m.x / TS_DESIGN_W * 100) + '%';
    r.style.top = (m.y / TS_DESIGN_H * 100) + '%';
    r.style.width = (m.w / TS_DESIGN_W * 100) + '%';
    r.style.height = (m.h / TS_DESIGN_H * 100) + '%';
    stage.appendChild(r);
  }
}

// ── Drag-a-box selection ──────────────────────────────────────────────────
// Dragging across the canvas's own background (not on a layer) draws a
// selection box; every layer it touches is selected, ready to move, align or
// delete together — the artboard gesture from Canva/Figma/Keynote. A plain
// click without dragging still selects the background, as before.
function tsBeginMarquee(e, bgLayer) {
  if (e.button !== 0) return;
  const stage = tsStageEl();
  if (!stage) return;
  e.preventDefault(); e.stopPropagation();
  tsCommitActiveEdit(null);
  tsMarquee = { startX: e.clientX, startY: e.clientY, stageRect: stage.getBoundingClientRect(), box: null, armed: false, bgLayer };
  document.addEventListener('mousemove', tsMarqueeMove);
  document.addEventListener('mouseup', tsMarqueeEnd);
}
function tsMarqueeMove(e) {
  if (!tsMarquee) return;
  const { startX, startY, stageRect } = tsMarquee;
  if (!tsMarquee.armed && Math.hypot(e.clientX - startX, e.clientY - startY) < 4) return;
  tsMarquee.armed = true;
  const toX = (cx) => (cx - stageRect.left) / stageRect.width * TS_DESIGN_W;
  const toY = (cy) => (cy - stageRect.top) / stageRect.height * TS_DESIGN_H;
  const x0 = toX(startX), y0 = toY(startY), x1 = toX(e.clientX), y1 = toY(e.clientY);
  tsMarquee.box = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
  if (!tsMarquee.queued) {
    tsMarquee.queued = true;
    requestAnimationFrame(() => { if (tsMarquee) { tsMarquee.queued = false; renderPreview(); } });
  }
}
function tsMarqueeEnd() {
  document.removeEventListener('mousemove', tsMarqueeMove);
  document.removeEventListener('mouseup', tsMarqueeEnd);
  const m = tsMarquee;
  tsMarquee = null;
  if (!m) return;
  if (!m.armed) {
    // Just a click on the background: select it, as before.
    if (m.bgLayer && activeLayer !== m.bgLayer) { activeLayer = m.bgLayer; multiSelectedLayerIds = new Set(); renderLayersList(); renderProps(); }
    renderPreview();
    return;
  }
  const b = m.box;
  const hit = (activeLook?.layers || []).filter(l => {
    if (l.visible === false || (l.type === 'background' && !l.pos) || tsCoversCanvas(l)) return false;
    const p = l.pos || measurePos(l);
    const h = p.h > 0 ? p.h : tsEffectiveH(l, p);
    return p.x < b.x + b.w && p.x + p.w > b.x && p.y < b.y + b.h && p.y + h > b.y;
  });
  multiSelectedLayerIds = hit.length > 1 ? new Set(hit.map(l => l.id)) : new Set();
  activeLayer = hit[0] || null;
  renderLayersList();
  renderProps();
  renderPreview();
}

// Preview-side counterpart to display.html's fitVerse(). Same per-layout height
// budget, scaled to the preview stage.
function fitPreviewVerse(stage, layout) {
  const el = stage.querySelector('[data-binding="verse"]');
  if (!el) return;
  const stageH = stage.clientHeight || 0;
  if (stageH < 20) return;   // not laid out yet — skip
  const FRAC = {
    'lower-third': 0.30, 'lower-third-card': 0.24, 'corner-card': 0.20,
    'ticker': 0.16, 'side-rail': 0.80, 'split-left': 0.84, 'split-right': 0.84,
  };
  // Free-canvas verse box: budget is its own height, or space to stage bottom.
  const vLayer = (activeLook?.layers || []).find(l => l.type === 'text' && l.binding === 'verse' && l.visible !== false);
  const maxH = (vLayer && vLayer.pos)
    ? stageH * (vLayer.pos.h > 0 ? vLayer.pos.h / TS_DESIGN_H : Math.max(0.08, 1 - vLayer.pos.y / TS_DESIGN_H))
    : stageH * (FRAC[layout] || 0.72);
  let size = parseFloat(el.dataset.baseSize) || parseFloat(el.style.fontSize) || 20;
  el.style.fontSize = size + 'px';
  // Measure unconstrained: a box with an explicit height reports scrollHeight
  // >= that height no matter how small the text gets, so comparing against it
  // would shrink the font to nothing. Release the height while measuring.
  const prevH = el.style.height;
  el.style.height = 'auto';
  let guard = 60;
  while (el.scrollHeight > maxH && size > 6 && guard-- > 0) {
    size = Math.max(6, size * 0.94);
    el.style.fontSize = size.toFixed(1) + 'px';
  }
  el.style.height = prevH;
}

// ── Free-canvas machinery ─────────────────────────────────────────────────
// Layers may carry `pos: {x, y, w, h}` in 1920×1080 design-space pixels (same
// convention as the live renderer in display.html). A layer without pos follows
// its layout preset; the first drag (or a Position/Dimension edit) converts it
// by measuring where the preset actually put it, so nothing jumps.
// Shared with service.js/display.html — see design_space.js.
const TS_DESIGN_W = window.KAIRO_DESIGN_W, TS_DESIGN_H = window.KAIRO_DESIGN_H;

function tsStageEl() { return document.getElementById('looks-preview-stage'); }

// Current design-space box of a layer: explicit pos, or measured from the DOM.
function measurePos(layer) {
  if (layer.pos) return { ...layer.pos };
  const stage = tsStageEl();
  const el = stage?.querySelector(`[data-layer-id="${CSS.escape(layer.id)}"]`);
  if (!el || !stage || !stage.clientWidth) {
    return { x: 560, y: 800, w: 800, h: layer.type === 'background' ? 120 : 0 };
  }
  const s = stage.getBoundingClientRect(), r = el.getBoundingClientRect();
  return {
    x: Math.round((r.left - s.left) / s.width  * TS_DESIGN_W),
    y: Math.round((r.top  - s.top)  / s.height * TS_DESIGN_H),
    w: Math.round(r.width  / s.width  * TS_DESIGN_W),
    h: layer.type === 'background' ? Math.round(r.height / s.height * TS_DESIGN_H) : 0,
  };
}

function ensurePos(layer) {
  if (!layer.pos) layer.pos = measurePos(layer);
  return layer.pos;
}

// Rendered height in design px — for vertical alignment of auto-height text.
// Confirmed root cause of the Align buttons producing garbage (Y:-1398 for
// a "Middle" click, from Math.round((1080 - 3876) / 2) — 3876 is exactly
// what this returned): `stage` and `el` are queried independently, and if
// ANYTHING transient makes `stage`'s measured box shorter than it actually
// is relative to `el` at that exact instant — a stale/duplicate element
// still matching #looks-preview-stage from a just-torn-down previous
// editor, a layout not yet settled — the ratio explodes silently and gets
// written straight into layer.pos.y. A text layer's real rendered height
// can NEVER legitimately exceed the canvas itself, so that's the one
// invariant this can safely clamp to regardless of what caused a bad read.
function tsEffectiveH(layer, p) {
  if (p.h > 0) return Math.min(p.h, TS_DESIGN_H);
  const stage = tsStageEl();
  const el = stage?.querySelector(`[data-layer-id="${CSS.escape(layer.id)}"]`);
  if (!el || !stage || !stage.clientHeight) return 100;
  const raw = Math.round(el.getBoundingClientRect().height / stage.getBoundingClientRect().height * TS_DESIGN_H);
  return Math.min(Math.max(raw, 10), TS_DESIGN_H);
}

let tsDrag = null;   // { layer, mode:'move'|'resize', dir, startX, startY, start, stageRect }

// Active alignment guide, in design px along each axis — null when that axis
// isn't currently snapped. Read by renderPreview() to draw the guide lines;
// only ever non-null while tsDrag is set.
let tsSnapGuides = { x: null, y: null };

const TS_SNAP_TOLERANCE = 14; // design px — same feel as the old center-only snap

// The ONE set of align icons, shared by renderLayoutProps' single-layer
// "align to canvas" row and the multi-select Align panel (renderProps) —
// those used to be two different controls (one icon-based, one plain text
// chips), which read as two different features instead of the same one
// applied to a bigger selection.
const TS_ALIGN_ICONS = {
  left:     { title: 'Left',   svg: '<line x1="4" y1="4" x2="4" y2="20"/><rect x="8" y="9" width="12" height="6"/>' },
  'h-center': { title: 'Center', svg: '<line x1="12" y1="4" x2="12" y2="20"/><rect x="5" y="9" width="14" height="6"/>' },
  right:    { title: 'Right',  svg: '<line x1="20" y1="4" x2="20" y2="20"/><rect x="4" y="9" width="12" height="6"/>' },
  top:      { title: 'Top',    svg: '<line x1="4" y1="4" x2="20" y2="4"/><rect x="9" y="8" width="6" height="12"/>' },
  'v-center': { title: 'Middle', svg: '<line x1="4" y1="12" x2="20" y2="12"/><rect x="9" y="5" width="6" height="14"/>' },
  bottom:   { title: 'Bottom', svg: '<line x1="4" y1="20" x2="20" y2="20"/><rect x="9" y="4" width="6" height="12"/>' },
};
function tsAlignIconBtn(kind, onClick) {
  const { title, svg } = TS_ALIGN_ICONS[kind];
  const btn = document.createElement('button');
  btn.className = 'ts-align-btn';
  btn.type = 'button';
  btn.title = title;
  btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round">${svg}</svg>`;
  btn.addEventListener('click', onClick);
  return btn;
}

// Breakpoints every theme gets for free: canvas edges, quarters, and center —
// the marks a slide deck's safe margins and balanced layouts actually land on.
const TS_BREAKPOINT_FRACTIONS = [0, 0.25, 0.5, 0.75, 1];

// Snap targets along one axis: this theme's breakpoints plus every other
// visible layer's near/center/far edge — so a box can also line up with a
// sibling (e.g. the reference sitting flush under the verse), not just the
// canvas itself.
function tsSnapTargetsX(excludeId) {
  const targets = TS_BREAKPOINT_FRACTIONS.map(f => f * TS_DESIGN_W);
  (activeLook?.layers || []).forEach(l => {
    if (l.id === excludeId || !l.pos || l.visible === false) return;
    targets.push(l.pos.x, l.pos.x + l.pos.w, l.pos.x + l.pos.w / 2);
  });
  return targets;
}
function tsSnapTargetsY(excludeId) {
  const targets = TS_BREAKPOINT_FRACTIONS.map(f => f * TS_DESIGN_H);
  (activeLook?.layers || []).forEach(l => {
    if (l.id === excludeId || !l.pos || l.visible === false) return;
    const h = l.pos.h > 0 ? l.pos.h : tsEffectiveH(l, l.pos);
    targets.push(l.pos.y, l.pos.y + h, l.pos.y + h / 2);
  });
  return targets;
}

// Nearest target within tolerance, or null if nothing is close enough.
function tsClosestSnap(value, targets, tol) {
  let best = null, bestDist = tol;
  for (const t of targets) {
    const d = Math.abs(value - t);
    if (d < bestDist) { bestDist = d; best = t; }
  }
  return best;
}

// Best snap across several candidate edges of the same box (e.g. left/center/
// right while moving) — picks whichever candidate lands closest to any
// target, not just the first one checked, so the box always locks onto the
// single most relevant guide.
function tsBestSnap(candidates, targets, tol) {
  let best = null, bestDist = tol;
  for (const c of candidates) {
    for (const t of targets) {
      const d = Math.abs(c.edge - t);
      if (d < bestDist) { bestDist = d; best = { snap: t, offset: c.offset }; }
    }
  }
  return best;
}

function tsBeginDrag(e, layer, mode, dir) {
  if (e.button !== 0) return;
  e.preventDefault(); e.stopPropagation();
  // Covers resize handles, which call this directly (bypassing
  // tsDecorateLayerEl's own mousedown) — grabbing a DIFFERENT layer's
  // handle while one is being edited must still commit that edit first.
  tsCommitActiveEdit(layer.id);
  // Option/Alt+drag duplicates first, then drags the copy — same gesture
  // as Canva/Figma/PowerPoint/Keynote. Duplicates the WHOLE current
  // selection when dragging a layer that's already part of one, otherwise
  // just this one layer. The clone starts stacked exactly on top of its
  // original (same position/layout-preset either way — deepClone copies
  // `pos` too, or its absence) and this same drag gesture continues on
  // it, so the very next mousemove pulls it away from the original.
  if (e.altKey && mode === 'move') {
    const toDuplicate = (multiSelectedLayerIds.size && multiSelectedLayerIds.has(layer.id))
      ? tsSelectedLayers() : [layer];
    const clones = toDuplicate.map((l, i) => {
      const clone = deepClone(l);
      clone.id = `layer-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 7)}`;
      return clone;
    });
    activeLook.layers.push(...clones);
    layer = clones[toDuplicate.indexOf(layer)];
    multiSelectedLayerIds = clones.length > 1 ? new Set(clones.map(c => c.id)) : new Set();
    activeLayer = layer;
    renderLayersList();
    renderProps();
    renderPreview();
    if (tsMode === 'item') tsSave();
  }
  // renderPreview() tears down and rebuilds every layer's DOM element from
  // scratch — only actually needed here when the SELECTION changes (a
  // freshly-selected layer has no resize handles in the DOM yet). Calling
  // it unconditionally on every mousedown, including a second click on a
  // layer that's already selected, was destroying that exact element mid-
  // gesture — which silently broke double-click-to-edit (beginInlineTextEdit/
  // wireDoubleClickSend): the SECOND click's mousedown fired first, wiped
  // out the div the first click's listener lived on, and replaced it with a
  // brand-new element whose own double-click timer had never seen a first
  // click at all, so the two clicks could never be recognized as a pair.
  if (activeLayer !== layer) { activeLayer = layer; renderLayersList(); renderProps(); renderPreview(); }
  const stage = tsStageEl();
  if (!stage) return;
  const pos = ensurePos(layer);
  // Moving (not resizing — group-resize isn't supported) a layer that's
  // part of the current multi-selection drags every OTHER selected layer
  // along with it, by the same delta. Each one's own starting position is
  // captured up front (ensurePos forces free-canvas positioning for any
  // that were still on a layout preset) so the whole group tracks the
  // cursor together regardless of where each one started from.
  const group = mode === 'move'
    ? tsSelectedLayers().filter(l => l !== layer).map(l => ({ layer: l, start: { ...ensurePos(l) } }))
    : [];
  tsDrag = {
    layer, mode, dir: dir || 'se',
    startX: e.clientX, startY: e.clientY,
    start: { ...pos },
    stageRect: stage.getBoundingClientRect(),
    group,
    // A corner scales a text layer's type with its box (see tsDragMove).
    startFont: layer.font ? { size: layer.font.size, letterSpacing: layer.font.letterSpacing || 0 } : null,
  };
  if (mode === 'rotate') {
    // Rotation turns about the layer's centre, measured on screen.
    const el = stage.querySelector(`[data-layer-id="${CSS.escape(layer.id)}"]`);
    const r = (el || stage).getBoundingClientRect();
    tsDrag.cx = r.left + r.width / 2;
    tsDrag.cy = r.top + r.height / 2;
    tsDrag.startAngle = Math.atan2(e.clientY - tsDrag.cy, e.clientX - tsDrag.cx) * 180 / Math.PI;
    tsDrag.startRot = layer.rotation || 0;
    tsDrag.armed = true;
  }
  document.addEventListener('mousemove', tsDragMove);
  document.addEventListener('mouseup', tsDragEnd);
}

function tsBeginGroupScale(e, dir) {
  if (e.button !== 0) return;
  e.preventDefault(); e.stopPropagation();
  const layers = tsSelectedLayers();
  const stage = tsStageEl();
  if (layers.length < 2 || !stage) return;
  const bounds = tsGroupBounds(layers);
  tsDrag = {
    mode: 'group-scale', dir, layer: layers[0],
    startX: e.clientX, startY: e.clientY, stageRect: stage.getBoundingClientRect(),
    bounds, items: layers.map(l => ({ layer: l, pos: { ...l.pos }, font: l.font ? { ...l.font } : null })),
  };
  document.addEventListener('mousemove', tsDragMove);
  document.addEventListener('mouseup', tsDragEnd);
}

function tsDragMove(e) {
  if (!tsDrag) return;
  // Every mousedown on a draggable layer starts a drag session, even the
  // second click of a double-click — real hands never hold the exact same
  // pixel between two clicks, so that sub-pixel jitter was being applied
  // as an actual position change (a visible flicker/shift) right as
  // beginInlineTextEdit was about to take over. A small dead zone (screen
  // px, before any TS_DESIGN_W/H scaling) means a click — or a double-
  // click — never nudges the layer; a real drag still starts the instant
  // it crosses this, same threshold every design tool uses to tell "click"
  // from "drag" apart.
  if (!tsDrag.armed) {
    if (Math.hypot(e.clientX - tsDrag.startX, e.clientY - tsDrag.startY) < 3) return;
    tsDrag.armed = true;
  }
  const { layer, mode, start, stageRect } = tsDrag;
  const dx = (e.clientX - tsDrag.startX) / stageRect.width  * TS_DESIGN_W;
  const dy = (e.clientY - tsDrag.startY) / stageRect.height * TS_DESIGN_H;
  if (mode === 'group-scale') {
    // A multi-selection's own corner: everything in it scales together from
    // the opposite corner — positions, sizes and type sizes — like dragging
    // the corner of a group in Canva.
    const { bounds: b, dir: d, items } = tsDrag;
    const sx = d.includes('e') ? 1 : -1, sy = d.includes('s') ? 1 : -1;
    const diag = Math.hypot(b.w, b.h) || 1;
    const scale = Math.max(0.1, 1 + ((sx * dx * b.w + sy * dy * b.h) / diag) / diag);
    const ax = sx > 0 ? b.x : b.x + b.w, ay = sy > 0 ? b.y : b.y + b.h;
    items.forEach(({ layer: l, pos: p0, font: f0 }) => {
      l.pos.x = Math.round(ax + (p0.x - ax) * scale);
      l.pos.y = Math.round(ay + (p0.y - ay) * scale);
      l.pos.w = Math.max(4, Math.round(p0.w * scale));
      if (p0.h > 0) l.pos.h = Math.max(4, Math.round(p0.h * scale));
      if (l.font && f0) {
        l.font.size = Math.max(6, Math.round(f0.size * scale));
        l.font.letterSpacing = +((f0.letterSpacing || 0) * scale).toFixed(2);
      }
    });
    tsDrag.scale = scale;
    tsSnapGuides = { x: null, y: null };
    tsScheduleDragRender(layer);
    return;
  }
  const xTargets = tsSnapTargetsX(layer.id);
  const yTargets = tsSnapTargetsY(layer.id);
  let snappedX = null, snappedY = null;

  if (mode === 'move') {
    let nx = Math.round(start.x + dx);
    let ny = Math.round(start.y + dy);
    const eh = tsEffectiveH(layer, layer.pos);

    // Left edge, center, and right edge are all candidate snap points while
    // moving — whichever is closest to a target wins (Figma-style "smart
    // guides"), not just the box's center like the old behavior.
    const xBest = tsBestSnap([
      { edge: nx, offset: 0 },
      { edge: nx + start.w / 2, offset: -start.w / 2 },
      { edge: nx + start.w, offset: -start.w },
    ], xTargets, TS_SNAP_TOLERANCE);
    if (xBest) { nx = Math.round(xBest.snap + xBest.offset); snappedX = xBest.snap; }

    const yBest = tsBestSnap([
      { edge: ny, offset: 0 },
      { edge: ny + eh / 2, offset: -eh / 2 },
      { edge: ny + eh, offset: -eh },
    ], yTargets, TS_SNAP_TOLERANCE);
    if (yBest) { ny = Math.round(yBest.snap + yBest.offset); snappedY = yBest.snap; }

    layer.pos.x = nx; layer.pos.y = ny;

    // Carry the rest of the multi-selection along by the SAME final delta
    // (post-snap, so the whole group still snaps together as one unit
    // rather than each member re-snapping independently against the
    // others' new positions).
    if (tsDrag.group.length) {
      const appliedDx = nx - start.x;
      const appliedDy = ny - start.y;
      tsDrag.group.forEach(({ layer: gl, start: gs }) => {
        gl.pos.x = Math.round(gs.x + appliedDx);
        gl.pos.y = Math.round(gs.y + appliedDy);
      });
    }
  } else if (mode === 'rotate') {
    // Round the centre, like any design tool: the angle follows the pointer;
    // Shift steps in 15°, and it settles onto 0/45/90… when within 3°.
    const a = Math.atan2(e.clientY - tsDrag.cy, e.clientX - tsDrag.cx) * 180 / Math.PI;
    let r = tsDrag.startRot + (a - tsDrag.startAngle);
    if (e.shiftKey) r = Math.round(r / 15) * 15;
    else { const near = Math.round(r / 45) * 45; if (Math.abs(r - near) < 3) r = near; }
    r = ((((r + 180) % 360) + 360) % 360) - 180;
    layer.rotation = Math.round(r);
  } else {
    // Resize from whichever handle was grabbed, the way Canva's artboard
    // does it: the point opposite the handle stays put; a corner scales the
    // layer as a unit — proportions kept, and a text layer's type scales with
    // it (font size, letter spacing) — while a side handle stretches one
    // dimension (a text box just gets wider or narrower and re-wraps). Shift
    // frees a corner; Alt/Option resizes from the centre. A rotated layer
    // resizes along its own sides: the pointer's movement is measured in the
    // layer's axes, and the anchor is held in place in the canvas's.
    const d = tsDrag.dir;
    const MIN_W = 40, MIN_H = 24;
    const baseH = start.h > 0 ? start.h : tsEffectiveH(layer, start);
    const sx = d.includes('e') ? 1 : d.includes('w') ? -1 : 0;
    const sy = d.includes('s') ? 1 : d.includes('n') ? -1 : 0;
    const rot = (layer.rotation || 0) * Math.PI / 180;
    const cos = Math.cos(rot), sin = Math.sin(rot);
    const lx = dx * cos + dy * sin;
    const ly = -dx * sin + dy * cos;
    const k = e.altKey ? 2 : 1;
    const proportional = sx !== 0 && sy !== 0 && !e.shiftKey;
    let nw = sx ? start.w + sx * lx * k : start.w;
    let nh = sy ? baseH + sy * ly * k : baseH;
    if (proportional) {
      // How far the corner moved along the box's own diagonal.
      const diag = Math.hypot(start.w, baseH) || 1;
      const along = (sx * lx * start.w + sy * ly * baseH) / diag;
      const scale = Math.max(MIN_W / start.w, 1 + (along * k) / diag);
      const aspect = layer.type === 'image' && layer.naturalW && layer.naturalH ? layer.naturalW / layer.naturalH : start.w / baseH;
      nw = start.w * scale;
      nh = nw / aspect;
    }
    nw = Math.max(MIN_W, nw);
    nh = Math.max(MIN_H, nh);

    // The anchor (opposite point, or the centre with Alt) stays where it was.
    const c0x = start.x + start.w / 2, c0y = start.y + baseH / 2;
    const ax0 = e.altKey ? 0 : -sx * start.w / 2, ay0 = e.altKey ? 0 : -sy * baseH / 2;
    const ax1 = e.altKey ? 0 : -sx * nw / 2, ay1 = e.altKey ? 0 : -sy * nh / 2;
    const wx = c0x + ax0 * cos - ay0 * sin, wy = c0y + ax0 * sin + ay0 * cos;
    let nx = wx - (ax1 * cos - ay1 * sin) - nw / 2;
    let ny = wy - (ax1 * sin + ay1 * cos) - nh / 2;

    // Snap the dragged edge(s) onto guides — for a straight, free stretch
    // only (snapping one edge of a proportional scale would bend it).
    if (!rot && !proportional && !e.altKey) {
      if (sx > 0) {
        const snap = tsClosestSnap(nx + nw, xTargets, TS_SNAP_TOLERANCE);
        if (snap != null) { nw = snap - nx; snappedX = snap; }
      } else if (sx < 0) {
        const right = start.x + start.w;
        const snap = tsClosestSnap(nx, xTargets, TS_SNAP_TOLERANCE);
        if (snap != null) { nx = snap; nw = right - snap; snappedX = snap; }
      }
      if (sy > 0) {
        const snap = tsClosestSnap(ny + nh, yTargets, TS_SNAP_TOLERANCE);
        if (snap != null) { nh = snap - ny; snappedY = snap; }
      } else if (sy < 0) {
        const bottom = start.y + baseH;
        const snap = tsClosestSnap(ny, yTargets, TS_SNAP_TOLERANCE);
        if (snap != null) { ny = snap; nh = bottom - snap; snappedY = snap; }
      }
    }

    if (layer.type === 'text' && proportional && tsDrag.startFont) {
      const scale = nw / start.w;
      layer.font.size = Math.max(6, Math.round(tsDrag.startFont.size * scale));
      layer.font.letterSpacing = +(tsDrag.startFont.letterSpacing * scale).toFixed(2);
    }
    layer.pos.x = Math.round(nx);
    layer.pos.y = Math.round(ny);
    layer.pos.w = Math.round(nw);
    // An auto-height text box stays auto unless it's stretched vertically.
    layer.pos.h = start.h > 0 || (sy && !proportional) ? Math.round(nh) : 0;
  }
  tsSnapGuides = { x: snappedX, y: snappedY };
  // The position/size math above runs synchronously on every mousemove (it
  // has to — each event's numbers depend on that exact cursor position),
  // but the render it feeds was ALSO running synchronously on every one of
  // those events — a full teardown-and-rebuild of every layer's DOM node
  // and every listener on it, dozens of times a second during a fast drag.
  // That's the "wonky corner controls" feeling: the browser can't keep a
  // full canvas rebuild pinned to every mousemove, so the handle visibly
  // lags and stutters behind the actual cursor. Coalescing to one render
  // per animation frame (still picks up whichever mousemove was most
  // recent when the frame paints) fixes the visual lag without touching
  // the drag math itself.
  tsScheduleDragRender(layer);
}

let tsDragRenderQueued = false;
function tsScheduleDragRender(layer) {
  if (tsDragRenderQueued) return;
  tsDragRenderQueued = true;
  requestAnimationFrame(() => {
    tsDragRenderQueued = false;
    if (!tsDrag) return; // drag ended before this frame painted
    renderPreview();
    tsSyncPosInputs(layer);
  });
}

function tsDragEnd() {
  document.removeEventListener('mousemove', tsDragMove);
  document.removeEventListener('mouseup', tsDragEnd);
  if (tsDrag) {
    tsDrag = null;
    tsSnapGuides = { x: null, y: null };
    renderProps();
    renderPreview();
    // A move/resize drag never called scheduleThemeAutosave() in THEME mode
    // (only item mode did) — every other kind of edit (color, font, a
    // slider) checkpoints itself via up()/tsSave(), but the mutation a drag
    // makes happens entirely inside tsDragMove, with nothing calling tsSave()
    // once the gesture ends. Real, reported consequence: "sometimes when I
    // resize something, undo doesn't work" — the resize itself was never
    // pushed to themeUndoStack, so undo had nothing to revert TO; it only
    // *seemed* to work intermittently when some LATER, properly-checkpointed
    // edit's snapshot happened to capture the state right after an untracked
    // resize, and undoing THAT edit coincidentally looked like it also
    // undid something, while the resize itself silently stuck around. Was
    // previously deliberately left alone here as "out of scope" for an
    // earlier, narrower plan — the owner's own report supersedes that.
    // tsSave() already routes correctly by mode (item vs theme), matching
    // every other mutation's own call site.
    tsSave();
  }
}

// Live-update the Position/Dimension inputs during a drag without a full
// (focus-stealing) renderProps rebuild.
function tsSyncPosInputs(layer) {
  if (!layer.pos) return;
  document.querySelectorAll('#ts-props-panel [data-pos-input]').forEach(inp => {
    const k = inp.dataset.posInput;
    if (document.activeElement === inp) return;
    if (k === 'rotation') inp.value = Math.round(layer.rotation || 0);
    else inp.value = k === 'h' && layer.type === 'text' && !layer.pos.h ? '' : layer.pos[k];
  });
}

// Selection outline + drag/resize wiring for a rendered preview element.
function tsDecorateLayerEl(div, layer, draggable) {
  div.dataset.layerId = layer.id;
  div.style.cursor = draggable ? 'move' : 'pointer';
  div.addEventListener('mousedown', (e) => {
    if (e.target.classList && e.target.classList.contains('ts-handle')) return;
    // A click landing INSIDE the layer currently being edited (beginInlineTextEdit)
    // is normal text interaction — placing the caret, extending a selection
    // to retype a word — not a new canvas selection/drag. Let it through
    // untouched instead of hijacking it into tsBeginDrag, which would both
    // start a pointless drag session AND (via e.preventDefault()) block the
    // browser's own native caret placement.
    if (tsActiveEdit && tsActiveEdit.layerId === layer.id) return;
    // Clicking anywhere ELSE while a DIFFERENT layer is being edited must
    // commit that edit first — see tsActiveEdit's declaration for why the
    // field's own blur event can't be trusted to fire on its own once this
    // handler's own e.preventDefault() runs below.
    tsCommitActiveEdit(layer.id);
    // Shift/Cmd/Ctrl+click toggles this layer into the multi-selection
    // instead of replacing it — the standard modifier across every design
    // tool (Figma, PowerPoint, Keynote, Canva). Never starts a drag by
    // itself; a plain click-and-drag right after is a separate gesture.
    if (e.shiftKey || e.metaKey || e.ctrlKey) {
      e.preventDefault(); e.stopPropagation();
      tsToggleMultiSelect(layer);
      return;
    }
    // A plain click on a layer not already part of the current selection
    // collapses back to single-select, same as everywhere else — only a
    // modifier click extends a selection. Clicking one that's ALREADY
    // in the selection leaves the group intact (so it can be dragged as a
    // group — see tsBeginDrag's own group capture below).
    if (multiSelectedLayerIds.size && !multiSelectedLayerIds.has(layer.id)) {
      multiSelectedLayerIds = new Set();
    }
    if (draggable) {
      tsBeginDrag(e, layer, 'move');
    } else {
      // The canvas background: drag across it to select a box of layers; a
      // plain click selects the background itself.
      tsBeginMarquee(e, layer);
    }
  });
  // multiSelectedLayerIds is the COMPLETE selection whenever 2+ layers are
  // selected (see tsToggleMultiSelect) — every member gets the same
  // outline and NONE get resize handles while in that state (group-resize
  // isn't supported; click one layer alone, with no modifier, to resize
  // it). Below that, it's plain single-select: activeLayer gets the
  // outline + the eight-point resize frame as it always did.
  if (multiSelectedLayerIds.size >= 2) {
    if (multiSelectedLayerIds.has(layer.id)) div.classList.add('ts-el-multi-selected');
    return;
  }
  if (activeLayer === layer) {
    div.classList.add('ts-el-selected');
    // Eight-point selection frame: four corners (scale, proportions kept) +
    // four edge midpoints (stretch), each from the opposite anchor — and a
    // rotate handle under the layer, for anything with its own box.
    ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach(dir => {
      const h = document.createElement('div');
      h.className = `ts-handle ts-handle-${dir}`;
      h.addEventListener('mousedown', (e) => tsBeginDrag(e, layer, 'resize', dir));
      div.appendChild(h);
    });
    if (draggable) {
      const rot = document.createElement('div');
      rot.className = 'ts-handle ts-handle-rot';
      rot.title = 'Rotate (Shift: 15° steps)';
      rot.innerHTML = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12a8 8 0 1 1-2.34-5.66"/><path d="M20 4v5h-5"/></svg>';
      rot.addEventListener('mousedown', (e) => tsBeginDrag(e, layer, 'rotate'));
      div.appendChild(rot);
    }
  } else if (tsCoversCanvas(layer)) {
    // A layer filling the whole canvas (film grain, a moving background)
    // would sit over everything and catch every click: it clicks through
    // until it's picked in the Layers panel.
    div.style.pointerEvents = 'none';
  }
}
function tsCoversCanvas(layer) {
  const p = layer.pos;
  return !!p && p.x <= 0 && p.y <= 0 && p.x + p.w >= TS_DESIGN_W && p.y + p.h >= TS_DESIGN_H;
}

// Toggles one layer's multi-selection membership. activeLayer (the
// "primary") stays whatever every other single-target action already
// reads; this just tracks who else is riding along for group move/align.
function tsToggleMultiSelect(layer) {
  // multiSelectedLayerIds is always the COMPLETE selection when it's in
  // use (same contract Select-All already established) — activeLayer is
  // never a separate "primary" excluded from it. Starting a multi-select
  // from a plain single selection seeds the set with that layer first, so
  // it isn't silently dropped by Copy/Delete/Align the moment a second
  // layer joins.
  if (!multiSelectedLayerIds.size && activeLayer) {
    multiSelectedLayerIds = new Set([activeLayer.id]);
  }
  if (multiSelectedLayerIds.has(layer.id)) {
    multiSelectedLayerIds.delete(layer.id);
  } else {
    multiSelectedLayerIds.add(layer.id);
  }
  // activeLayer just needs to point at SOME member of the selection (the
  // props panel falls back to the Align view whenever 2+ are selected
  // anyway — see renderProps — so which one barely matters until the
  // selection collapses back down to exactly one).
  activeLayer = multiSelectedLayerIds.size
    ? (activeLook.layers || []).find(l => multiSelectedLayerIds.has(l.id)) || null
    : null;
  if (multiSelectedLayerIds.size === 1) multiSelectedLayerIds = new Set();
  renderLayersList();
  renderProps();
  renderPreview();
}

// Every currently-selected layer, in canvas (z-)order — used by group-drag
// and the Align toolbar. multiSelectedLayerIds is the complete selection
// whenever 2+ are selected; otherwise it's just activeLayer alone.
function tsSelectedLayers() {
  if (multiSelectedLayerIds.size) {
    return (activeLook.layers || []).filter(l => multiSelectedLayerIds.has(l.id));
  }
  return activeLayer ? [activeLayer] : [];
}

// Lines up every selected layer against the OUTER bounding box of the
// whole selection — 'left'/'h-center'/'right' set each layer's x, 'top'/
// 'v-center'/'bottom' set y, matching the convention every design tool
// uses for aligning a multi-selection (align to the group, not to
// whichever layer happens to be primary). ensurePos forces free-canvas
// positioning first — a layer still on a layout preset has no explicit
// box to compute or align against.
function tsAlignSelection(kind) {
  const layers = tsSelectedLayers();
  if (layers.length < 2) return;
  const boxes = layers.map(l => { const pos = ensurePos(l); return { layer: l, pos, h: tsEffectiveH(l, pos) }; });
  const minX = Math.min(...boxes.map(b => b.pos.x));
  const maxX = Math.max(...boxes.map(b => b.pos.x + b.pos.w));
  const minY = Math.min(...boxes.map(b => b.pos.y));
  const maxY = Math.max(...boxes.map(b => b.pos.y + b.h));
  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  boxes.forEach(({ pos, h }) => {
    if (kind === 'left') pos.x = Math.round(minX);
    else if (kind === 'h-center') pos.x = Math.round(centerX - pos.w / 2);
    else if (kind === 'right') pos.x = Math.round(maxX - pos.w);
    else if (kind === 'top') pos.y = Math.round(minY);
    else if (kind === 'v-center') pos.y = Math.round(centerY - h / 2);
    else if (kind === 'bottom') pos.y = Math.round(maxY - h);
  });
  up();
}

// The selection's own outer bounding box (design px) — the multi-select
// Transform panel's X/Y/W/H fields (renderProps) read and write against
// this, same as a single layer's own X/Y/W/H reads/writes against its pos.
// opts.measureOnly: just look — a layer still on a layout preset is
// measured where it is instead of being pinned there (ensurePos), for
// drawing the selection's frame rather than acting on it.
function tsGroupBounds(layers, opts = {}) {
  if (!layers.length) return { x: 0, y: 0, w: 0, h: 0 };
  const boxes = layers.map(l => { const pos = opts.measureOnly ? (l.pos || measurePos(l)) : ensurePos(l); return { pos, h: tsEffectiveH(l, pos) }; });
  const minX = Math.min(...boxes.map(b => b.pos.x));
  const minY = Math.min(...boxes.map(b => b.pos.y));
  const maxX = Math.max(...boxes.map(b => b.pos.x + b.pos.w));
  const maxY = Math.max(...boxes.map(b => b.pos.y + b.h));
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

// Moves every selected layer by (dx, dy) and/or scales every layer's own
// position AND size by (sx, sy), all relative to `bounds`'s own top-left
// — the group's own resize handle, in effect: dragging W (or H, with the
// chain link scaling both together) grows or shrinks every member in
// place around the group's corner, instead of only ever being able to
// resize one layer at a time.
function tsTransformSelection(layers, bounds, { dx = 0, dy = 0, sx = 1, sy = 1 } = {}) {
  layers.forEach(l => {
    const p = ensurePos(l);
    const relX = p.x - bounds.x;
    const relY = p.y - bounds.y;
    p.x = Math.round(bounds.x + relX * sx + dx);
    p.y = Math.round(bounds.y + relY * sy + dy);
    if (sx !== 1) p.w = Math.max(4, Math.round(p.w * sx));
    if (sy !== 1 && p.h > 0) p.h = Math.max(4, Math.round(p.h * sy));
  });
}

// Detects two mousedowns on the SAME layer within 500ms — module-level
// state (not a per-div closure) on purpose: a re-render between the two
// clicks (renderPreview rebuilds every layer's DOM node from scratch)
// would otherwise throw away a closure-local timer along with the div it
// lived on, exactly the bug that made this not work at all before
// tsBeginDrag was changed to stop re-rendering an already-selected layer.
// Kept as its own mousedown listener rather than a native 'dblclick' or
// the 'click'-based wireDoubleClickSend helper — see the call site in
// renderPreview for why.
let tsLastLayerClickId = null;
let tsLastLayerClickAt = 0;
function tsHandleLayerDblClick(e, div, layer) {
  if (e.button !== 0 || e.shiftKey || e.metaKey || e.ctrlKey) return;
  const now = Date.now();
  const isDouble = tsLastLayerClickId === layer.id && (now - tsLastLayerClickAt) < 500;
  tsLastLayerClickId = isDouble ? null : layer.id;
  tsLastLayerClickAt = isDouble ? 0 : now;
  if (isDouble) {
    // tsDecorateLayerEl's own mousedown listener (registered before this
    // one, same element/event) already ran tsBeginDrag for this exact
    // click, unconditionally — cancel that drag session before it can run
    // tsDragEnd's own re-render out from under the field this is about to
    // create and focus.
    tsCancelDrag();
    beginInlineTextEdit(div, layer);
  }
}

function tsCancelDrag() {
  document.removeEventListener('mousemove', tsDragMove);
  document.removeEventListener('mouseup', tsDragEnd);
  tsDrag = null;
}

// In-place text editing for a 'custom'-binding text layer — see the
// tsHandleLayerDblClick call site in renderPreview. Turns the on-canvas div
// itself into the input, instead of the separate "Text" field in the props
// panel — that field still exists and stays in sync (renderProps() below),
// it's just no longer the ONLY way to change the words.
function beginInlineTextEdit(div, layer) {
  // A 'verse' layer in item mode is that specific slide's real lyric/text
  // line (backed by commitSlideText — see the wireDoubleClickSend call
  // site above), not a customText string on the layer itself. Everything
  // else (single-line customText, revert-on-Escape) only applies to the
  // plain 'custom' case.
  const isVerseSlide = layer.binding === 'verse' && tsMode === 'item' && !!tsItemCtx;
  const original = isVerseSlide
    ? ((window.KairoService?.slidesFor?.(tsItemCtx.item) || [])[tsItemCtx.slideIndex]?.text || '')
    : (layer.customText || '');
  div.contentEditable = 'true';
  div.spellcheck = false;
  div.classList.add('ts-el-editing');
  // Plain text only — an uncontrolled contentEditable can pick up rich
  // HTML from a paste; both customText and a slide's own text are always
  // plain strings everywhere else they're read/written.
  const onPaste = (e) => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text/plain');
    document.execCommand('insertText', false, text);
  };
  div.addEventListener('paste', onPaste);
  div.focus();
  // Caret at the end, not a select-all — highlighting the whole line on
  // entry looked wrong (a jagged per-wrapped-line block, not a clean box)
  // and meant a single stray keystroke could wipe the entire line. Click
  // or arrow to reposition, the same as opening any other text field.
  const range = document.createRange();
  range.selectNodeContents(div);
  range.collapse(false);
  const sel = window.getSelection();
  sel.removeAllRanges();
  sel.addRange(range);

  let settled = false;
  const commit = () => {
    if (settled) return;
    settled = true;
    tsActiveEdit = null;
    div.removeEventListener('paste', onPaste);
    div.contentEditable = 'false';
    div.classList.remove('ts-el-editing');
    if (isVerseSlide) {
      // A slide's own text is legitimately multi-line (2+ lines per slide
      // is normal — see the "Lines per slide" delimiter), so line breaks
      // are kept, not collapsed. Writes back through the exact same
      // commitSlideText the Flow view's own editable field already uses —
      // a second SURFACE for that one mechanism, not a parallel one.
      const slides = window.KairoService?.slidesFor?.(tsItemCtx.item) || [];
      const slide = slides[tsItemCtx.slideIndex];
      if (slide) window.KairoService?.commitSlideText?.(tsItemCtx.item, tsItemCtx.slideIndex, slide, div.innerText);
      window.KairoService?.refreshThumbnails?.();
      renderPreview();
    } else {
      // customText is single-line everywhere else it's edited (the props
      // panel uses a plain <input>) — collapse any line break a stray
      // Enter or paste introduced instead of silently going multi-line
      // here only.
      layer.customText = div.innerText.replace(/\r?\n/g, ' ').trim();
      up();
    }
    renderProps();
  };
  const cancel = () => {
    if (settled) return;
    settled = true;
    tsActiveEdit = null;
    div.removeEventListener('paste', onPaste);
    div.contentEditable = 'false';
    div.classList.remove('ts-el-editing');
    if (!isVerseSlide) layer.customText = original;
    renderPreview();
  };
  // Registered so every OTHER entry point that starts a new selection/drag
  // (tsDecorateLayerEl, tsBeginDrag) can force this to commit first — see
  // tsCommitActiveEdit and the comment on tsActiveEdit's declaration for
  // why the blur event below can't be relied on alone.
  tsActiveEdit = { layerId: layer.id, commit };
  div.addEventListener('blur', commit, { once: true });
  div.addEventListener('keydown', (e) => {
    // Escape/Enter here must never reach the DOCUMENT-level handlers that
    // also listen for them (Escape closes the whole Theme Studio/Full-
    // scale edit modal — see the keydown listener near closeThemeStudio/
    // closeItemStyleEditor). Without stopping it, exiting an edit with
    // Escape correctly committed/cancelled the text AND, in the same
    // keystroke, closed the entire editor out from under it — which reads
    // exactly like "the edit didn't save", since the panel vanishes before
    // there's any chance to see it did.
    if (isVerseSlide) {
      // Matches the Flow view's own contentEditable convention exactly
      // (renderFlowView/commitSlideText): plain Enter is a new line on
      // THIS slide, not a commit — there's no single-line assumption for
      // real lyric text. Escape commits and exits; there's no "revert" for
      // multi-line text here either, same as the Flow view.
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); div.blur(); }
      return;
    }
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); div.blur(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); div.removeEventListener('blur', commit); cancel(); }
  });
}

// ── Render properties panel ───────────────────────────────────────────────
// Which of the 3 props tabs a layer type actually has content for — a
// background/image layer has nothing under Effects (no shadow/outline/
// scroll), so that tab is hidden rather than shown-but-empty for them.
const PROPS_TABS_BY_LAYER_TYPE = {
  background:  ['layout', 'style', 'animate'],
  image:       ['layout', 'style', 'animate'],
  'image-cycle': ['layout', 'style', 'animate'],
  motion:      ['layout', 'style', 'animate'],
  text:        ['layout', 'style', 'effects', 'animate'],
};
// Persists across layer switches within one Edit/Theme Studio session
// (picking a different layer doesn't jump you back to Layout every time) —
// reset only when it lands on a tab the newly-selected layer doesn't have.
// 'item' is the first tab when editing a playlist item or a countdown: the
// whole thing being edited (#ts-props-item-pane — its theme, or its timer
// and slides). Theme Studio has no such tab: the theme's own settings are
// the slide's (renderSlideLayout) and its verse layer's (revealRows).
let activePropsTab = 'layout';

// Which layer renderProps last drew the panel for — lets it tell "a new
// layer just got selected" apart from "the same layer's props panel is
// re-rendering for some other reason" (an edit, a tab switch), so the
// text-layer tab jump below fires exactly once per selection, not on
// every render.
let lastPropsLayerId = null;

function renderProps() {
  const empty = document.getElementById('ts-props-empty');
  const panel = document.getElementById('ts-props-panel');
  const tabs = document.getElementById('ts-props-tabs');
  const itemPane = document.getElementById('ts-props-item-pane');
  if (!panel || !empty) return;
  // The tabs are always at the top, and nothing sits above them. Editing a
  // playlist item or a countdown, the first names it (its theme, its timer
  // and slides); the layer tabs follow.
  const inItem = tsMode === 'item';
  const itemTab = document.getElementById('ts-props-tab-item');
  if (itemTab) itemTab.textContent = inItem && tsItemCtx?.item?.type === 'timer' ? 'Timer' : 'Look';
  if (!inItem && activePropsTab === 'item') activePropsTab = 'layout';
  const showTabs = (available) => {
    tabs?.classList.remove('hidden');
    tabs?.querySelectorAll('.ts-tab-btn').forEach(btn => {
      btn.classList.toggle('hidden', !available.includes(btn.dataset.tab));
      btn.classList.toggle('active', btn.dataset.tab === activePropsTab);
    });
  };
  const onItemTab = () => {
    itemPane?.classList.toggle('ts-tab-hidden', activePropsTab !== 'item');
    return activePropsTab === 'item';
  };

  // The slide itself — its Canvas selected, or nothing: where the text sits
  // and how the background keys under Layout, the canvas's fill under Style.
  const canvas = baseBgLayer();
  if (!inItem && !multiSelectedLayerIds.size && (!activeLayer || activeLayer === canvas)) {
    lastPropsLayerId = activeLayer?.id ?? null;
    const available = canvas ? ['layout', 'style'] : ['layout'];
    if (!available.includes(activePropsTab)) activePropsTab = 'layout';
    showTabs(available);
    itemPane?.classList.add('ts-tab-hidden');
    empty.style.display = 'none';
    panel.innerHTML = '';
    renderSlideLayout(panel);
    if (canvas) renderBgProps(panel, canvas);
    panel.style.display = 'block';
    panel.querySelectorAll('[data-tab]').forEach(el => el.classList.toggle('ts-tab-hidden', el.dataset.tab !== activePropsTab));
    return;
  }

  if (!activeLayer) {
    lastPropsLayerId = null;
    if (!['item', 'layout', 'style', 'animate'].includes(activePropsTab)) activePropsTab = 'item';
    showTabs(['item', 'layout', 'style', 'animate']);
    const item = onItemTab();
    empty.style.display = item ? 'none' : 'flex';
    panel.style.display = 'none';
    panel.innerHTML = '';
    return;
  }

  // Multiple layers selected (Shift/Cmd/Ctrl+click — multiSelectedLayerIds) —
  // show the Align toolbar instead of one layer's own props. Per-layer
  // editing (font, color, exact position) still only makes sense one at a
  // time; lining several layers up against each other is the one thing
  // that's actually about the GROUP, so it gets its own panel state rather
  // than being squeezed into the single-layer one.
  if (multiSelectedLayerIds.size) {
    empty.style.display = 'none';
    panel.style.display = 'block';
    panel.innerHTML = '';
    tabs?.classList.add('hidden');
    itemPane?.classList.add('ts-tab-hidden');
    lastPropsLayerId = null;
    const count = tsSelectedLayers().length;
    const header = document.createElement('div');
    header.className = 'ts-props-section-label';
    header.textContent = `${count} layers selected`;
    panel.appendChild(header);
    // Same icon set and behavior as a single layer's own "align to canvas"
    // row (renderLayoutProps/TS_ALIGN_ICONS) — this used to be a separate
    // plain-text-chip control, which read as a different feature instead
    // of the same alignment tool just given more than one layer to work on.
    const alignWrap = document.createElement('div');
    alignWrap.className = 'ts-align-group';
    ['left', 'h-center', 'right', 'top', 'v-center', 'bottom'].forEach(kind => {
      alignWrap.appendChild(tsAlignIconBtn(kind, () => tsAlignSelection(kind)));
    });
    panel.appendChild(section(null, 'Align', fieldRow([alignWrap])));

    // Transform — the group's own bounding box as one X/Y/W/H, the same
    // fields a single layer gets. X/Y moves every selected layer by the same
    // delta (same as dragging one of them). W/H, with the chain link locked
    // (default), SCALES every layer's position and size together relative to
    // the group's own top-left, instead of only ever being able to resize
    // members one at a time.
    const bounds = tsGroupBounds(tsSelectedLayers());
    const groupLinked = layerAspectLock.get('__group__') ?? true;
    const groupField = (label, key, min, max, apply) => numField(label, Math.round(bounds[key]), {
      min, max, onChange: (v) => { apply(v ?? 0, tsGroupBounds(tsSelectedLayers())); up(); },
    });
    const linkBtn = document.createElement('button');
    linkBtn.type = 'button';
    linkBtn.className = 'ts-aspect-link ts-row-icon' + (groupLinked ? ' active' : '');
    linkBtn.title = groupLinked ? 'Width/Height are linked — click to unlink' : 'Width/Height are unlinked — click to link';
    linkBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 15l6-6"/><path d="M11 6l1.5-1.5a3.54 3.54 0 0 1 5 5L16 11"/><path d="M13 18l-1.5 1.5a3.54 3.54 0 0 1-5-5L8 13"/></svg>';
    linkBtn.addEventListener('click', () => {
      const now = !(layerAspectLock.get('__group__') ?? true);
      layerAspectLock.set('__group__', now);
      linkBtn.classList.toggle('active', now);
      linkBtn.title = now ? 'Width/Height are linked — click to unlink' : 'Width/Height are unlinked — click to link';
    });
    const linked = () => layerAspectLock.get('__group__') ?? true;
    panel.appendChild(section(null, 'Transform',
      fieldRow([
        groupField('X', 'x', -TS_DESIGN_W, TS_DESIGN_W, (v, b) => tsTransformSelection(tsSelectedLayers(), b, { dx: v - b.x })),
        groupField('Y', 'y', -TS_DESIGN_H, TS_DESIGN_H, (v, b) => tsTransformSelection(tsSelectedLayers(), b, { dy: v - b.y })),
      ]),
      fieldRow([
        groupField('W', 'w', 4, TS_DESIGN_W, (v, b) => { const sx = v / Math.max(1, b.w); tsTransformSelection(tsSelectedLayers(), b, { sx, sy: linked() ? sx : 1 }); renderProps(); }),
        groupField('H', 'h', 4, TS_DESIGN_H, (v, b) => { const sy = v / Math.max(1, b.h); tsTransformSelection(tsSelectedLayers(), b, { sy, sx: linked() ? sy : 1 }); renderProps(); }),
        linkBtn,
      ])));
    return;
  }

  // Text is what an operator almost always opens Full-scale edit/Theme
  // Studio to actually change (a font, a color, a size) — landing on
  // Layout for a freshly-selected text layer meant an extra click to get
  // anywhere useful nearly every time; and a layer picked while the first
  // tab was showing opens on its own Style. Only fires on an actual NEW
  // selection, not every re-render of the panel for the layer already open.
  if (activeLayer.id !== lastPropsLayerId && (activeLayer.type === 'text' || activePropsTab === 'item')) activePropsTab = 'style';
  lastPropsLayerId = activeLayer.id;

  empty.style.display = 'none';
  panel.innerHTML = '';

  if (activeLayer.type === 'background') {
    renderBgProps(panel, activeLayer);
  } else if (activeLayer.type === 'image') {
    renderImageProps(panel, activeLayer);
  } else if (activeLayer.type === 'image-cycle') {
    renderImageCycleProps(panel, activeLayer);
  } else if (activeLayer.type === 'motion') {
    renderMotionProps(panel, activeLayer);
  } else {
    renderTextProps(panel, activeLayer);
  }
  // The canvas fill itself doesn't arrive or move — everything on it can.
  const isCanvasFill = activeLayer.type === 'background' && !activeLayer.pos;
  if (!isCanvasFill) renderAnimateProps(panel, activeLayer);

  let available = PROPS_TABS_BY_LAYER_TYPE[activeLayer.type] || PROPS_TABS_BY_LAYER_TYPE.text;
  // The canvas fill is always the whole screen: nothing to place, nothing to animate.
  if (isCanvasFill) available = available.filter(t => t !== 'animate' && t !== 'layout');
  if (activePropsTab !== 'item' && !available.includes(activePropsTab)) activePropsTab = available[0];
  showTabs(inItem ? ['item', ...available] : available);
  panel.style.display = onItemTab() ? 'none' : 'block';
  // A class, not a direct style write — see the .ts-tab-hidden comment in
  // styles.css for why this has to compose with, not clobber, each
  // section's own enabled/disabled inline display (Shadow/Outline/Scroll).
  panel.querySelectorAll('[data-tab]').forEach(el => {
    el.classList.toggle('ts-tab-hidden', el.dataset.tab !== activePropsTab);
  });
}

document.querySelectorAll('#ts-props-tabs .ts-tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.classList.contains('hidden')) return;
    activePropsTab = btn.dataset.tab;
    renderProps();
  });
});

// A control with its name inside the same box ("Shows  The verse or lyrics ⌄",
// "Name  Verse"), on its own line of the grid — the way the number fields
// carry theirs, so a labelled row lines up with every other row.
function prop(label, content, { cols } = {}) {
  return fieldRow([labeledField(label, content)], { cols });
}
function labeledField(label, content) {
  const f = document.createElement('label');
  f.className = 'ts-field ts-labeled-field';
  const l = document.createElement('span');
  l.className = 'ts-field-label';
  l.textContent = label;
  f.append(l, content);
  return f;
}

// `tab` groups this section under one of the props panel's tabs (see
// PROPS_TABS / renderProps below) — every render*Props function tags each
// section it builds so the panel can show one tab's worth at a time instead
// of every section stacked in one long scroll, which is what "the edit
// controls feel very cluttered" was describing.
function section(tab, label, ...children) {
  const s = document.createElement('div');
  s.className = 'ts-props-section';
  s.dataset.tab = tab;
  if (label) {
    const l = document.createElement('div');
    l.className = 'ts-props-section-label';
    l.textContent = label;
    s.appendChild(l);
  }
  children.forEach(c => s.appendChild(c));
  return s;
}

function makeToggle(checked, onChange) {
  const label = document.createElement('label');
  label.className = 'ts-toggle';
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.checked = checked;
  cb.addEventListener('change', () => onChange(cb.checked));
  const track = document.createElement('span');
  track.className = 'ts-toggle-track';
  label.appendChild(cb);
  label.appendChild(track);
  return label;
}

function makeNumber(val, min, max, step, onChange) {
  const inp = document.createElement('input');
  inp.type = 'number'; inp.className = 'ts-prop-number';
  inp.value = val; inp.min = min; inp.max = max; inp.step = step || 1;
  inp.addEventListener('input', () => onChange(parseFloat(inp.value) || 0));
  return inp;
}

function makeColor(val, onChange) {
  const inp = document.createElement('input');
  inp.type = 'color'; inp.className = 'ts-prop-color';
  inp.value = val;
  inp.addEventListener('input', () => onChange(inp.value));
  return inp;
}

// ── Design-tool fields ────────────────────────────────────────────────────
// The way design tools lay out an inspector: a number is a compact box with
// its name inside ("X 140", "Delay 0.4 s"), two or three to a line, rather
// than a whole row — label, slider, value — for each one.
function numField(label, value, { min = -Infinity, max = Infinity, step = 1, unit = '', title = '', placeholder = '', onChange }) {
  const wrap = document.createElement('label');
  wrap.className = 'ts-field';
  if (title) wrap.title = title;
  if (label) {
    const l = document.createElement('span');
    l.className = 'ts-field-label';
    l.textContent = label;
    wrap.appendChild(l);
  }
  const inp = document.createElement('input');
  inp.type = 'number'; inp.step = step;
  if (Number.isFinite(min)) inp.min = min;
  if (Number.isFinite(max)) inp.max = max;
  inp.value = value ?? '';
  if (placeholder) inp.placeholder = placeholder;
  if (label || title) inp.setAttribute('aria-label', title || label);
  inp.addEventListener('input', () => {
    const v = parseFloat(inp.value);
    if (inp.value === '') onChange(null);
    else if (Number.isFinite(v)) onChange(Math.max(min, Math.min(max, v)));
  });
  wrap.appendChild(inp);
  if (unit) {
    const u = document.createElement('span');
    u.className = 'ts-field-unit';
    u.textContent = unit;
    wrap.appendChild(u);
  }
  return wrap;
}
// Controls side by side on one line of the inspector's grid, sharing it
// equally (`cols` keeps a lone field to its share of a wider line); a control
// marked .ts-row-icon (the W/H link, Play, Italic) takes the row's icon column
// on the right, so every field lines up with the ones above and below.
function fieldRow(children, { cols } = {}) {
  const r = document.createElement('div');
  r.className = 'ts-field-row';
  const kids = children.filter(Boolean);
  r.style.setProperty('--cols', cols || Math.max(1, kids.filter(c => !c.classList.contains('ts-row-icon')).length));
  kids.forEach(c => r.appendChild(c));
  return r;
}
// A button the size of a field, filling its column.
function fieldBtn(text, onClick, title = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ts-field-btn';
  b.textContent = text;
  if (title) b.title = title;
  b.addEventListener('click', onClick);
  return b;
}
// A small on/off button (Italic), pressed when on.
function iconToggle(text, on, title, onChange, { italic = false } = {}) {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = 'ts-icon-toggle' + (on ? ' active' : '');
  b.textContent = text;
  if (italic) b.style.fontStyle = 'italic';
  b.title = title;
  b.setAttribute('aria-pressed', String(!!on));
  b.addEventListener('click', () => {
    const now = !b.classList.contains('active');
    b.classList.toggle('active', now);
    b.setAttribute('aria-pressed', String(now));
    onChange(now);
  });
  return b;
}
// A colour with its name, field-sized ("Overtime ■").
function swatchField(label, color, onChange, title = '') {
  const wrap = document.createElement('label');
  wrap.className = 'ts-field ts-swatch-field';
  if (title) wrap.title = title;
  const l = document.createElement('span');
  l.className = 'ts-field-label';
  l.textContent = label;
  const c = makeColor(color, onChange);
  c.className = 'ts-swatch-mini';
  wrap.append(l, c);
  return wrap;
}
// A switch with its name, field-sized ("Finale ●").
function toggleField(label, on, onChange, title = '') {
  const wrap = document.createElement('div');
  wrap.className = 'ts-field ts-toggle-field';
  if (title) wrap.title = title;
  const l = document.createElement('span');
  l.className = 'ts-field-label';
  l.textContent = label;
  wrap.append(l, makeToggle(on, onChange));
  return wrap;
}
// A colour as design tools show one: its swatch and hex code in one field.
function colorField(color, onChange, title = '') {
  const f = document.createElement('label');
  f.className = 'ts-field ts-color-field';
  if (title) f.title = title;
  const hex = document.createElement('span');
  hex.className = 'ts-hex';
  const show = (v) => { hex.textContent = String(v || '').replace('#', '').toUpperCase(); };
  const c = makeColor(color, v => { show(v); onChange(v); });
  c.className = 'ts-swatch-mini';
  show(color);
  f.append(c, hex);
  return f;
}
// A colour, and its opacity beside it — a design tool's fill line.
function colorOpacityRow(color, onColor, opacity, onOpacity) {
  return fieldRow([
    colorField(color, onColor),
    numField('Opacity', Math.round(opacity ?? 100), { min: 0, max: 100, unit: '%', onChange: v => onOpacity(v ?? 100) }),
  ]);
}

// Chip buttons, one pressed — still used by the Timer tab's own popovers
// (service.js shares this page's globals). The inspector uses dropdowns.
function makeChips(options, current, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'ts-chip-group';
  options.forEach(({ label, value }) => {
    const btn = document.createElement('button');
    btn.className = 'ts-chip' + (current === value ? ' active' : '');
    btn.textContent = label;
    btn.addEventListener('click', () => {
      wrap.querySelectorAll('.ts-chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      onChange(value);
    });
    wrap.appendChild(btn);
  });
  return wrap;
}

function makeFillSelect(current, onChange) {
  return makeSelect([
    { label: 'Solid colour', value: 'solid' },
    { label: 'Gradient', value: 'gradient' },
    { label: 'Picture', value: 'image' },
    { label: 'Blur what\'s behind', value: 'blur' },
    { label: 'None (transparent)', value: 'transparent' },
  ], current || 'solid', onChange);
}

function makeAlignBtns(current, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'ts-align-group';
  [
    { v: 'left',   icon: '<line x1="3" y1="6" x2="15" y2="6"/><line x1="3" y1="12" x2="21" y2="12"/><line x1="3" y1="18" x2="12" y2="18"/>' },
    { v: 'center', icon: '<line x1="3" y1="6" x2="21" y2="6"/><line x1="7" y1="12" x2="17" y2="12"/><line x1="5" y1="18" x2="19" y2="18"/>' },
    { v: 'right',  icon: '<line x1="3" y1="6" x2="21" y2="6"/><line x1="9" y1="12" x2="21" y2="12"/><line x1="12" y1="18" x2="21" y2="18"/>' },
  ].forEach(({ v, icon }) => {
    const btn = document.createElement('button');
    btn.className = 'ts-align-btn' + (current === v ? ' active' : '');
    btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">${icon}</svg>`;
    btn.title = 'Align ' + v;
    btn.addEventListener('click', () => {
      wrap.querySelectorAll('.ts-align-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      onChange(v);
    });
    wrap.appendChild(btn);
  });
  return wrap;
}

function makeWeightSelect(current, onChange) {
  const sel = document.createElement('select');
  sel.className = 'ts-select';
  FONT_WEIGHTS.forEach(w => {
    const opt = document.createElement('option');
    opt.value = w.value;
    opt.textContent = w.label;
    if (Number(w.value) === Number(current)) opt.selected = true;
    sel.appendChild(opt);
  });
  sel.addEventListener('change', () => onChange(parseInt(sel.value, 10)));
  return sel;
}

// A native <select>'s dropdown popup is OS-rendered in WebKit — per-option
// font-family CSS (which was already being set, correctly) is largely
// ignored once the list is actually open, so every row read in the same
// generic UI font regardless. That's "fonts don't render as what they
// look like": the intent was there, native select just can't deliver it.
// A plain HTML dropdown (real DOM rows, not an OS popup) respects it fully
// — and gets a search field for free, which matters once hundreds of real
// system fonts (loadSystemFonts, above) are merged into a list a native
// <select> would otherwise force scrolling through blind.
function makeFontSelect(current, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'ts-font-picker';

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.className = 'ts-font-picker-btn';
  const setBtnLabel = (value) => {
    btn.style.fontFamily = value || '';
    btn.textContent = (FONTS.find(f => f.value === value)?.label) || value || 'Choose a font…';
  };
  setBtnLabel(current);
  wrap.appendChild(btn);

  let panel = null;
  function closePanel() {
    panel?.remove();
    panel = null;
    document.removeEventListener('mousedown', onOutside, true);
  }
  function onOutside(e) {
    if (panel && !panel.contains(e.target) && e.target !== btn) closePanel();
  }
  function openPanel() {
    if (panel) { closePanel(); return; }
    panel = document.createElement('div');
    panel.className = 'ts-font-picker-panel';
    const rect = btn.getBoundingClientRect();
    panel.style.left = rect.left + 'px';
    panel.style.top = (rect.bottom + 4) + 'px';
    panel.style.width = Math.max(240, rect.width) + 'px';

    const search = document.createElement('input');
    search.type = 'text';
    search.placeholder = 'Search fonts…';
    search.className = 'ts-font-picker-search';
    panel.appendChild(search);

    const list = document.createElement('div');
    list.className = 'ts-font-picker-list';
    panel.appendChild(list);

    function renderRows(filter) {
      list.innerHTML = '';
      const q = filter.trim().toLowerCase();
      const matches = FONTS.filter(f => !q || f.label.toLowerCase().includes(q));
      // A saved theme's font isn't necessarily in FONTS (loadSystemFonts
      // loads async and may not have resolved yet, or the font could since
      // have been uninstalled) — show the real stored value as its own row
      // rather than silently hiding what's actually set.
      if (current && !FONTS.some(f => f.value === current) && (!q || current.toLowerCase().includes(q))) {
        matches.unshift({ label: current, value: current, google: false });
      }
      matches.slice(0, 300).forEach(f => {
        const row = document.createElement('button');
        row.type = 'button';
        row.className = 'ts-font-picker-row' + (f.value === current ? ' active' : '');
        // A decorative/display/script font (most of what a real "fonts I have
        // way more than these" system list turns up — dafont.com-style
        // installs) can render its OWN NAME completely illegibly at 14px, and
        // a symbol/dingbat/braille font (Apple Braille, Wingdings-alikes)
        // doesn't draw its name as recognizable Latin text at all — neither
        // is a bug, that's genuinely how the font looks, but a picker that
        // ONLY shows the styled specimen makes such a row impossible to
        // identify. Always keep the plain, always-legible label alongside it
        // (Google Fonts'/Figma's own font pickers do the same) rather than
        // relying on the specimen alone to say what this row even is.
        const label = document.createElement('span');
        label.className = 'ts-font-picker-row-label';
        label.textContent = f.label;
        const sample = document.createElement('span');
        sample.className = 'ts-font-picker-row-sample';
        sample.style.fontFamily = f.value;
        sample.textContent = f.label;
        row.appendChild(label);
        row.appendChild(sample);
        // Fetched on hover, not for the whole list up front — only ever for
        // entries FONTS marked as a Google font; loadSystemFonts' entries
        // are already on the machine and need no network fetch at all.
        row.addEventListener('mouseenter', () => { if (f.google) loadGoogleFont(f.value); }, { once: true });
        row.addEventListener('click', () => {
          current = f.value;
          setBtnLabel(f.value);
          if (f.google) loadGoogleFont(f.value);
          onChange(f.value);
          closePanel();
        });
        list.appendChild(row);
      });
      if (!matches.length) {
        const empty = document.createElement('div');
        empty.className = 'ts-font-picker-empty';
        empty.textContent = 'No fonts match';
        list.appendChild(empty);
      }
    }
    renderRows('');
    search.addEventListener('input', () => renderRows(search.value));
    document.body.appendChild(panel);
    search.focus();
    // Deferred one tick — the SAME click that opened this would otherwise
    // immediately bubble into this listener and close it right back.
    setTimeout(() => document.addEventListener('mousedown', onOutside, true), 0);
  }
  btn.addEventListener('click', openPanel);
  return wrap;
}

// A real <select> for a small fixed set of choices — same shape as
// makeWeightSelect/makeFontSelect, generalized. Chips read fine for a
// handful of options with room to spare (Fit Mode, alignment), but for
// something like text Case, a dropdown reads as the more standard control
// (matches Canva/ProPresenter's own text panels) and takes less width.
function makeSelect(options, current, onChange) {
  const sel = document.createElement('select');
  sel.className = 'ts-select';
  options.forEach(({ label, value, title }) => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    if (title) opt.title = title;
    if (value === current) opt.selected = true;
    sel.appendChild(opt);
  });
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}
// The same, in labelled groups: [{ label, options: [{ label, value }] }].
function makeGroupedSelect(groups, current, onChange) {
  const sel = document.createElement('select');
  sel.className = 'ts-select';
  groups.forEach(g => {
    const og = document.createElement('optgroup');
    og.label = g.label;
    g.options.forEach(({ label, value }) => og.appendChild(new Option(label, value, false, value === current)));
    sel.appendChild(og);
  });
  sel.addEventListener('change', () => onChange(sel.value));
  return sel;
}

// Autosave, debounced — edits already mutate activeLook in place (it's a
// direct reference into the `looks` array), so there's no separate "commit"
// step; this just needs to persist that to localStorage without hammering
// it on every slider-drag tick. Also where undo history gets its
// checkpoints: activeLook is mutated BEFORE this runs (every call site edits
// then calls up()/scheduleThemeAutosave()), so there's no "before" state left
// to grab at commit time — instead, whichever edit is first in a burst is
// captured by snapshotting once at the START of a fresh debounce window
// (see the `pendingCheckpoint` flag), then the checkpoint is pushed once the
// burst actually settles. That groups rapid changes (a slider drag, fast
// typing) into one undo step, the same granularity most editors use.
let autosaveTimer = null;
let pendingCheckpoint = null; // snapshot taken at the start of the current burst, or null between bursts
// The state activeLook was in as of the last committed edit (or theme
// switch/undo/redo) — always taken BEFORE any mutation, unlike
// pendingCheckpoint below which used to be deepClone'd lazily on first call
// here. Every real call site mutates the layer/look in place and only THEN
// calls up()/scheduleThemeAutosave(), so a lazy clone at that point had
// already baked the change in — a single click (the Transparent canvas
// toggle, a chip picker) had no earlier mutation in the same burst to
// "recover" a pre-change state from, so its own undo was a silent no-op.
// Kept in sync by resetThemeHistory() and restoreLookSnapshot() — the only
// two places activeLook's *committed* identity actually changes.
let lastThemeSnapshot = null;
function scheduleThemeAutosave() {
  if (!activeLook) return;
  if (!pendingCheckpoint) pendingCheckpoint = lastThemeSnapshot || deepClone(activeLook);
  clearTimeout(autosaveTimer);
  autosaveTimer = setTimeout(() => {
    if (pendingCheckpoint) {
      themeUndoStack.push(pendingCheckpoint);
      if (themeUndoStack.length > 50) themeUndoStack.shift();
      themeRedoStack = [];
      pendingCheckpoint = null;
    }
    lastThemeSnapshot = deepClone(activeLook); // burst settled — this is now the baseline for the next one
    saveLooks();
    renderLooksList();
    // Live-update the output: if the theme being edited is what's on screen
    // right now (a playlist item's own theme, or the live timer), re-push it
    // so the operator doesn't have to hit Send again. saveLooks() already
    // re-broadcasts look-update for the output-default case.
    try { window.KairoService?.resendLiveForThemeEdit?.(activeLook?.id); } catch {}
  }, 500);
}

function up() { renderPreview(); renderLayersList(); tsSave(); }
function tsSave() { if (tsMode === 'item') scheduleItemStyleAutosave(); else scheduleThemeAutosave(); }

// ── Item-mode save/undo (mirrors scheduleThemeAutosave/themeUndo/themeRedo
// below, but diffs the synthetic look's text layers against the base theme
// and writes only the differences into item.slideStyles, instead of
// persisting a whole theme to `looks`) ──────────────────────────────────────
function diffSubObject(base, cur, keys) {
  if (!cur) return undefined;
  const out = {};
  let any = false;
  keys.forEach(k => {
    if (cur[k] !== undefined && cur[k] !== base?.[k]) { out[k] = cur[k]; any = true; }
  });
  return any ? out : undefined;
}
function diffLayerOverride(baseLayer, curLayer) {
  const ov = {};
  if (curLayer.pos && JSON.stringify(curLayer.pos) !== JSON.stringify(baseLayer?.pos)) ov.pos = { ...curLayer.pos };
  const fontDiff = diffSubObject(baseLayer?.font, curLayer.font, ['size', 'family', 'weight', 'italic', 'lineHeight', 'letterSpacing', 'transform']);
  if (fontDiff) ov.font = fontDiff;
  if (curLayer.align !== baseLayer?.align) ov.align = curLayer.align;
  if (curLayer.color !== baseLayer?.color) ov.color = curLayer.color;
  if (curLayer.opacity !== baseLayer?.opacity) ov.opacity = curLayer.opacity;
  const shadowDiff = diffSubObject(baseLayer?.shadow, curLayer.shadow, ['enabled', 'color', 'opacity', 'blur', 'x', 'y']);
  if (shadowDiff) ov.shadow = shadowDiff;
  const outlineDiff = diffSubObject(baseLayer?.outline, curLayer.outline, ['enabled', 'color', 'width']);
  if (outlineDiff) ov.outline = outlineDiff;
  // fit/radius — image and image-cycle layers only (undefined on a text
  // layer either side, so this stays a no-op for those).
  if (curLayer.fit !== undefined && curLayer.fit !== baseLayer?.fit) ov.fit = curLayer.fit;
  if (curLayer.radius !== undefined && curLayer.radius !== baseLayer?.radius) ov.radius = curLayer.radius;
  // A motion graphic's settings travel whole: its colours, counts and speeds
  // only make sense together. Compared normalized — key order and filled-in
  // defaults aren't a change.
  if (curLayer.graphic && !sameGraphic(curLayer.graphic, baseLayer?.graphic)) ov.graphic = deepClone(curLayer.graphic);
  // Rotation, accent colour and photo look, plus a background's fill (its
  // kind, colours, picture and darkening) — merged back by every renderer
  // through layer_geometry.js's withLayerOverride. null records a setting
  // the slide took away.
  const keys = [...LAYER_OVERRIDE_KEYS, ...(curLayer.type === 'background' ? FILL_OVERRIDE_KEYS : [])];
  keys.forEach(k => {
    if (k === 'color' || k === 'opacity') return;   // covered above
    const cur = curLayer[k] ?? null, base = baseLayer?.[k] ?? null;
    if (JSON.stringify(cur) !== JSON.stringify(base)) ov[k] = cur && typeof cur === 'object' ? deepClone(cur) : cur;
  });
  // Build-in and idle motion (the Animate tab), same way.
  ['build', 'idle'].forEach(k => {
    const cur = curLayer[k] ?? null, base = baseLayer?.[k] ?? null;
    if (JSON.stringify(cur) !== JSON.stringify(base)) ov[k] = cur ? deepClone(cur) : null;
  });
  if (curLayer.visible === false) ov.visible = false; // only the hidden case is ever stored; visible is the assumed default
  return ov;
}
function sameGraphic(a, b) {
  const M = window.KairoMotion;
  if (!a || !b || !M) return JSON.stringify(a) === JSON.stringify(b);
  return JSON.stringify(M.normalize(a)) === JSON.stringify(M.normalize(b));
}
// Recomputes item.slideStyles[slideIndex] from scratch by diffing the
// synthetic look's current text layers against tsItemCtx.baseLook's
// originals — sparse at both levels per the data-model rules (see plan):
// an unchanged layer or slide with zero overrides simply isn't stored. Any
// layer with no id match in baseLook wasn't part of the theme at all — an
// item/slide-specific layer the operator added here — so there's nothing to
// diff it against; it's stored whole under __customLayers instead. A layer
// removed from activeLook (deleted via the Layers panel) simply isn't seen
// by this pass, so it drops out with no separate tombstone needed.
function writeItemSlideStyleFromSynthetic() {
  if (!tsItemCtx || !activeLook) return;
  const { item, slideIndex, baseLook } = tsItemCtx;
  // Scenes save whole, not diffed — see buildSyntheticLook's matching
  // branch for why (no base theme to diff against at all). Persisting
  // itself is service.js's saveTimerScenes, same as every other scene
  // mutation (add/delete/reorder/duration) already goes through.
  if (item.type === 'timer' && item.scenes && item.scenes.length) {
    if (item.scenes[slideIndex]) item.scenes[slideIndex].layers = deepClone(activeLook.layers || []);
    // resend:false — scheduleItemStyleAutosave's caller already re-pushes the
    // live segment right after this returns (resendLiveForSlideStyleEdit);
    // saveTimerScenes's own resend would otherwise double-fire the broadcast.
    window.KairoService?.saveTimerScenes?.(item, { resend: false });
    return;
  }
  // Same whole-save idea for a 'slides' item's own scene blocks (a
  // ProPresenter import preserved as-authored) — see buildSyntheticLook's
  // matching read branch. Without this, editing an imported slide would
  // fall through to the diff-against-base-theme path below, which makes
  // no sense for a slide with no base theme to diff against — the real
  // imported layers would silently never actually update.
  if (item.type === 'slides' && item.blocks?.[slideIndex]?.layers) {
    item.blocks[slideIndex].layers = deepClone(activeLook.layers || []);
    window.KairoService?.saveService?.();
    return;
  }
  const overrides = {};
  // Media Bin background (bgMedia) — buildSyntheticLook prepends a synthetic
  // '__bg-media' layer for it via applyBgMediaOverride, purely for this
  // canvas to render; it's not a real theme/custom layer and was never part
  // of activeLook before that injection, so the diff pass below must skip
  // it entirely (never store it as a "custom layer", never let its id throw
  // off the z-order comparison) and this carries the actual field forward
  // untouched instead, so an unrelated edit here doesn't silently clear it.
  // isItemCustomLayer treats it as deletable like any operator-added layer
  // (nothing in baseLook.layers shares its id) — the operator's own "remove
  // it" affordance is deleting it from the Layers panel, so its absence
  // from activeLook.layers here is read as exactly that, not preserved.
  const stillPresent = (activeLook.layers || []).some(l => l.id === '__bg-media');
  const existingBgMedia = item.slideStyles?.[slideIndex]?.bgMedia;
  if (existingBgMedia && stillPresent) overrides.bgMedia = existingBgMedia;
  const customLayers = [];
  (activeLook.layers || []).forEach(layer => {
    if (layer.id === '__bg-media') return;
    const baseLayer = (baseLook.layers || []).find(l => l.id === layer.id);
    if (!baseLayer) { customLayers.push(deepClone(layer)); return; }
    // Used to only diff text layers — a base theme's own image/image-cycle/
    // background layer could never have its position/fit/etc. overridden
    // per-slide at all, only per-slide text. That's the "the background
    // isn't editable" gap: dragging/resizing an Image Cycle layer (now
    // allowed in item mode, see tsDecorateLayerEl's call site) had nowhere
    // to actually persist to. diffLayerOverride already computes pos/
    // opacity/fit/radius/visible generically (only font/shadow/outline are
    // text-specific, and those diff to nothing when a layer has none of
    // those fields), so the type check here was the only thing narrowing
    // it to text.
    const ov = diffLayerOverride(baseLayer, layer);
    if (Object.keys(ov).length) overrides[layer.id] = ov;
  });
  if (customLayers.length) overrides.__customLayers = customLayers;
  // Layer order (z-order — see reorderLayer) is per-slide too. Sparse like
  // everything else here: only stored when it actually differs from the
  // natural order (base theme layers in their original order, then custom
  // layers in the order they were added), so a slide nobody reordered
  // carries no override at all.
  const naturalOrder = [...(baseLook.layers || []).map(l => l.id), ...customLayers.map(l => l.id)];
  const currentOrder = (activeLook.layers || []).filter(l => l.id !== '__bg-media').map(l => l.id);
  if (currentOrder.join('|') !== naturalOrder.join('|')) overrides.__layerOrder = currentOrder;
  if (Object.keys(overrides).length) {
    item.slideStyles = item.slideStyles || {};
    item.slideStyles[slideIndex] = overrides;
  } else if (item.slideStyles) {
    delete item.slideStyles[slideIndex];
  }
}
function scheduleItemStyleAutosave() {
  if (tsMode !== 'item' || !tsItemCtx) return;
  if (!itemPendingCheckpoint) itemPendingCheckpoint = deepClone(tsItemCtx.item.slideStyles || {});
  clearTimeout(itemAutosaveTimer);
  itemAutosaveTimer = setTimeout(() => {
    if (itemPendingCheckpoint) {
      itemUndoStack.push(itemPendingCheckpoint);
      if (itemUndoStack.length > 50) itemUndoStack.shift();
      itemRedoStack = [];
      itemPendingCheckpoint = null;
    }
    writeItemSlideStyleFromSynthetic();
    window.KairoService?.saveService?.();
    // If the slide being restyled is the one live on the output, re-push it.
    try {
      if (tsItemCtx) window.KairoService?.resendLiveForSlideStyleEdit?.(tsItemCtx.item.id, tsItemCtx.slideIndex);
    } catch {}
    // The Stack/Timer views underneath this modal don't rebuild on their
    // own until next opened — without this, a Full-scale edit looked saved
    // but its thumbnail stayed stale until the operator switched views
    // away and back.
    window.KairoService?.refreshThumbnails?.();
  }, 500);
}
function resetItemHistory() {
  itemUndoStack = [];
  itemRedoStack = [];
  itemPendingCheckpoint = null;
  clearTimeout(itemAutosaveTimer);
}
// Restores a whole item.slideStyles snapshot (not per-slide — matches how
// themeUndo restores the whole look, since a single burst of edits can touch
// more than one layer's override at once) then rebuilds the synthetic look
// so the canvas reflects the restored state immediately.
function itemUndo() {
  if (!tsItemCtx || !itemUndoStack.length) return;
  itemRedoStack.push(deepClone(tsItemCtx.item.slideStyles || {}));
  const snapshot = itemUndoStack.pop();
  tsItemCtx.item.slideStyles = snapshot;
  window.KairoService?.saveService?.();
  activeLook = buildSyntheticLook(tsItemCtx.item, tsItemCtx.slideIndex);
  activeLayer = null; multiSelectedLayerIds.clear();
  renderLayersList(); renderPreview(); renderProps();
}
function itemRedo() {
  if (!tsItemCtx || !itemRedoStack.length) return;
  itemUndoStack.push(deepClone(tsItemCtx.item.slideStyles || {}));
  const snapshot = itemRedoStack.pop();
  tsItemCtx.item.slideStyles = snapshot;
  window.KairoService?.saveService?.();
  activeLook = buildSyntheticLook(tsItemCtx.item, tsItemCtx.slideIndex);
  activeLayer = null; multiSelectedLayerIds.clear();
  renderLayersList(); renderPreview(); renderProps();
}

// ── Undo / redo ────────────────────────────────────────────────────────────
// Scoped to whichever theme is currently open — switching themes, creating
// one, or deleting one all reset this, since "undo" across two different
// themes' edit histories wouldn't mean anything coherent.
let themeUndoStack = [];
let themeRedoStack = [];

function resetThemeHistory() {
  themeUndoStack = [];
  themeRedoStack = [];
  pendingCheckpoint = null;
  lastThemeSnapshot = activeLook ? deepClone(activeLook) : null;
  clearTimeout(autosaveTimer);
}

// Replaces activeLook's contents in place (same object reference — other
// code holds onto `activeLook`/`looks[idx]` as that exact reference) rather
// than swapping in a new object, so nothing downstream goes stale.
function restoreLookSnapshot(snapshot) {
  const idx = looks.findIndex(l => l.id === activeLook.id);
  Object.keys(activeLook).forEach(k => delete activeLook[k]);
  Object.assign(activeLook, deepClone(snapshot));
  if (idx >= 0) looks[idx] = activeLook;
  activeLayer = null; multiSelectedLayerIds.clear();
  lastThemeSnapshot = deepClone(activeLook); // the just-restored state is the new baseline
  saveLooks();
  renderLooksList(); renderLayersList(); renderThemeCanvasSizeSelect(); renderPreview(); renderProps();
}

function themeUndo() {
  if (!activeLook) return;
  clearTimeout(autosaveTimer);
  let prev;
  if (pendingCheckpoint) {
    // An uncommitted burst is still in flight (debounce hasn't fired) — undo
    // reverts to just before THIS burst started, without touching or
    // needing anything already on the committed undo stack.
    prev = pendingCheckpoint;
    pendingCheckpoint = null;
  } else {
    if (!themeUndoStack.length) return;
    prev = themeUndoStack.pop();
  }
  themeRedoStack.push(deepClone(activeLook));
  restoreLookSnapshot(prev);
}

function themeRedo() {
  if (!themeRedoStack.length || !activeLook) return;
  clearTimeout(autosaveTimer);
  themeUndoStack.push(deepClone(activeLook));
  pendingCheckpoint = null;
  const next = themeRedoStack.pop();
  restoreLookSnapshot(next);
}


// Cmd/Ctrl+Z and Cmd/Ctrl+Shift+Z (or Ctrl+Y) — only while Theme Studio is
// open, and never while a text field has focus (its own native undo takes
// that instead, same guard the Escape-to-close handler already uses).
document.addEventListener('keydown', (e) => {
  if (looksModal?.classList.contains('hidden')) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  const mod = e.metaKey || e.ctrlKey;
  // Item mode reuses this same modal but has its own, separately-scoped
  // undo/redo stack (item.slideStyles, not a whole theme) — route there
  // instead whenever it's the one open.
  const undo = tsMode === 'item' ? itemUndo : themeUndo;
  const redo = tsMode === 'item' ? itemRedo : themeRedo;
  if (!mod || e.key.toLowerCase() !== 'z') {
    if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
    return;
  }
  e.preventDefault();
  if (e.shiftKey) redo(); else undo();
});

// ── Layout (free-canvas) props — Alignment / Position / Dimension ─────────
// Chain-link state for the W/H fields (renderLayoutProps) — whether typing
// one dimension scales the other proportionally, same idea as corner-drag
// already locking aspect ratio for an image (tsDragMove), just extended to
// the numeric fields. Transient UI preference, not theme data, so it's
// tracked here by layer id rather than adding a field to the layer object
// itself (which would bloat every saved/exported theme with UI state).
// Defaults locked — unlinking is the deliberate opt-out for "scale just
// this one dimension".
const layerAspectLock = new Map();

function renderLayoutProps(panel, layer) {
  const cur = measurePos(layer);
  const isText = layer.type === 'text';

  // X / Y / W / H as design tools show them: compact boxes, two to a line.
  // (A text box's height of 0 means "as tall as its text": shown as auto.)
  const posField = (key, label, min, max, { aspect = false } = {}) => {
    const autoH = key === 'h' && isText;
    const f = numField(label, autoH && !cur.h ? '' : cur[key], {
      min, max, placeholder: autoH ? 'auto' : '',
      title: autoH ? 'Height — leave empty to fit the text' : '',
      onChange: (v) => {
        const p = ensurePos(layer);
        const before = { w: p.w, h: p.h };
        p[key] = Math.round(v ?? 0);
        if (aspect && (layerAspectLock.get(layer.id) ?? true) && before.w > 0 && before.h > 0) {
          if (key === 'w') p.h = Math.max(1, Math.round(before.h * (p.w / before.w)));
          else p.w = Math.max(1, Math.round(before.w * (p.h / before.h)));
          tsSyncPosInputs(layer);
        }
        renderPreview();
        // Pre-existing gap in theme mode: these inputs never called
        // scheduleThemeAutosave() either — out of scope to fix here. Item
        // mode needs this, additively — typing an exact position is one of
        // the two ways (with drag) to set a position override.
        if (tsMode === 'item') tsSave();
      },
    });
    f.querySelector('input').dataset.posInput = key;
    return f;
  };

  // Alignment: snap the box to canvas edges/center.
  const alignWrap = document.createElement('div');
  alignWrap.className = 'ts-align-group';
  [
    ['left',     p => { p.x = 0; }],
    ['h-center', p => { p.x = Math.round((TS_DESIGN_W - p.w) / 2); }],
    ['right',    p => { p.x = TS_DESIGN_W - p.w; }],
    ['top',      p => { p.y = 0; }],
    ['v-center', p => { p.y = Math.round((TS_DESIGN_H - tsEffectiveH(layer, p)) / 2); }],
    ['bottom',   p => { p.y = TS_DESIGN_H - tsEffectiveH(layer, p); }],
  ].forEach(([kind, act]) => {
    alignWrap.appendChild(tsAlignIconBtn(kind, () => {
      const p = ensurePos(layer);
      act(p);
      renderPreview();
      tsSyncPosInputs(layer);
      if (tsMode === 'item') tsSave(); // same pre-existing-gap note as posField above
    }));
  });

  // Chain link — locked (default) means typing W or H scales the other
  // dimension to keep the box's current proportions; unlinked scales just
  // that one field. Per-layer, not persisted (see layerAspectLock's own
  // comment above).
  const linked = layerAspectLock.get(layer.id) ?? true;
  const linkBtn = document.createElement('button');
  linkBtn.type = 'button';
  linkBtn.className = 'ts-aspect-link ts-row-icon' + (linked ? ' active' : '');
  linkBtn.title = linked ? 'Width/Height are linked — click to unlink' : 'Width/Height are unlinked — click to link';
  linkBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 15l6-6"/><path d="M11 6l1.5-1.5a3.54 3.54 0 0 1 5 5L16 11"/><path d="M13 18l-1.5 1.5a3.54 3.54 0 0 1-5-5L8 13"/></svg>';
  linkBtn.addEventListener('click', () => {
    const now = !(layerAspectLock.get(layer.id) ?? true);
    layerAspectLock.set(layer.id, now);
    linkBtn.classList.toggle('active', now);
    linkBtn.title = now ? 'Width/Height are linked — click to unlink' : 'Width/Height are unlinked — click to link';
  });
  // W under X and H under Y; the link sits in the row's icon column.
  const kids = [
    fieldRow([alignWrap]),
    fieldRow([posField('x', 'X', -TS_DESIGN_W, TS_DESIGN_W), posField('y', 'Y', -TS_DESIGN_H, TS_DESIGN_H)]),
    fieldRow([posField('w', 'W', 40, TS_DESIGN_W, { aspect: true }), posField('h', 'H', 0, TS_DESIGN_H, { aspect: true }), linkBtn]),
  ];

  // Rotation, about the layer's own centre — a countdown running up the side
  // of the screen, a tilted photo, a slanted headline. Turned with the handle
  // under the box on the canvas, as in any editor; this is the exact angle,
  // kept in step while the handle turns (tsSyncPosInputs). Only for a layer
  // with its own box: a layout-preset text layer centres itself with a
  // transform, and the canvas fill is always the whole screen.
  const isCanvasFill = layer.type === 'background' && !layer.pos;
  const rotRow = [];
  if ((layer.pos || !isText) && !isCanvasFill) {
    const rot = numField('↻', Math.round(layer.rotation || 0), {
      min: -180, max: 180, unit: '°', title: 'Rotation — or turn it with the round handle under the box',
      onChange: (v) => { layer.rotation = v || 0; if (isText) ensurePos(layer); up(); },
    });
    rot.querySelector('input').dataset.posInput = 'rotation';
    rotRow.push(rot);
  }
  // Escape hatch back to the layout preset once a layer has been freed — an
  // icon in the row's icon column, as a design tool's small actions are.
  if (layer.pos) {
    const reset = document.createElement('button');
    reset.type = 'button';
    reset.className = 'ts-aspect-link ts-row-icon';
    reset.title = 'Reset to layout — put this layer back where the theme\'s layout places it';
    reset.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="1 4 1 10 7 10"/><path d="M3.51 15a9 9 0 1 0 2.13-9.36L1 10"/></svg>';
    reset.addEventListener('click', () => {
      delete layer.pos;
      up();
      renderProps();
    });
    rotRow.push(reset);
  }
  if (rotRow.length) kids.push(fieldRow(rotRow, { cols: 2 }));

  panel.appendChild(section('layout', 'Position', ...kids));
}

// ── Animate tab ───────────────────────────────────────────────────────────
// How a layer arrives when its slide goes live (build-in: its own animation,
// delay and duration, so a slide's pieces arrive one after another — a text
// layer can come in word by word or letter by letter) and what it keeps
// doing once it's there (idle: float, drift, breathe, sway, pulse). Play
// replays the whole slide's build-ins on the canvas.
function renderAnimateProps(panel, layer) {
  const M = window.KairoMotion;
  if (!M) return;
  const b = M.normalizeBuild(layer.build);
  const isText = layer.type === 'text';
  const builds = M.BUILDS.filter(x => !x.text || isText).map(x => ({ label: x.label, value: x.id }));
  const setBuild = (patch) => {
    layer.build = { ...M.normalizeBuild(layer.build), ...patch };
    if (layer.build.type === 'none') delete layer.build;
    up();
  };
  const play = document.createElement('button');
  play.type = 'button';
  play.className = 'ts-aspect-link ts-row-icon';
  play.innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" width="11" height="11"><path d="M7 5v14l12-7z"/></svg>';
  play.title = 'Play — replay this slide\'s animations';
  play.addEventListener('click', () => tsPlayAnimations());
  // The animation, with Play in the row's icon column; its timing two to a line.
  const arrives = [fieldRow([makeSelect(builds, b.type, v => { setBuild({ type: v }); renderProps(); }), play])];
  if (b.type !== 'none') arrives.push(fieldRow([
    numField('Delay', b.delay, { min: 0, max: 10, step: 0.1, unit: 's', title: 'How long after the slide appears', onChange: v => setBuild({ delay: v ?? 0 }) }),
    numField('Length', b.duration, { min: 0.1, max: 5, step: 0.1, unit: 's', title: 'How long the animation takes', onChange: v => setBuild({ duration: v ?? 0.8 }) }),
  ]));
  panel.appendChild(section('animate', 'Arrives', ...arrives));

  const m = M.normalizeIdle(layer.idle);
  const setIdle = (patch) => {
    layer.idle = { ...M.normalizeIdle(layer.idle), ...patch };
    if (layer.idle.type === 'none') delete layer.idle;
    up();
  };
  // One list of motions for every layer. A picture's slow zoom (layer.motion,
  // the renderers' own Ken Burns animation) is one of them, so a picture never
  // has a second motion control somewhere else.
  const isPicture = layer.type === 'image' || layer.type === 'image-cycle';
  const motions = M.IDLES.map(x => ({ label: x.label, value: x.id }));
  if (isPicture) motions.splice(1, 0, { label: 'Slow zoom', value: 'kenburns' });
  const current = isPicture && layer.motion === 'kenburns' ? 'kenburns' : m.type;
  const moving = [fieldRow([makeSelect(motions, current, v => {
    if (isPicture) layer.motion = v === 'kenburns' ? 'kenburns' : 'none';
    setIdle({ type: v === 'kenburns' ? 'none' : v });
    renderProps();
  })])];
  if (current !== 'none' && current !== 'kenburns') moving.push(fieldRow([
    numField('Amount', m.amount, { min: 1, max: 100, unit: '%', onChange: v => setIdle({ amount: v ?? 20 }) }),
    numField('Speed', m.speed, { min: 0.1, max: 3, step: 0.05, unit: '×', onChange: v => setIdle({ speed: v ?? 1 }) }),
  ]));
  panel.appendChild(section('animate', 'Keeps moving', ...moving));
}

// The slide as a whole — what its Canvas stands for, shown with the Canvas or
// nothing selected: where the verse sits (the theme's layout). Keying the
// background out for a video mixer is each output's (Settings → Outputs), not
// the theme's: one theme serves the projector and the stream overlay alike.
const THEME_LAYOUTS = [
  { label: 'Full screen', value: 'fullscreen' },
  { label: 'Lower third', value: 'lower-third' },
  { label: 'Split, text left', value: 'split-left' },
  { label: 'Split, text right', value: 'split-right' },
];
function renderSlideLayout(panel) {
  if (!activeLook) return;
  const layouts = [...THEME_LAYOUTS];
  // A theme on a layout the list doesn't offer (a lower-third card, two
  // languages…) shows it as it is rather than as something else.
  if (activeLook.layout && !layouts.some(o => o.value === activeLook.layout)) {
    layouts.push({ label: activeLook.layout.replace(/-/g, ' ').replace(/^./, c => c.toUpperCase()), value: activeLook.layout });
  }
  const layoutSel = makeSelect(layouts, activeLook.layout || 'fullscreen', v => { activeLook.layout = v; renderPreview(); scheduleThemeAutosave(); });
  layoutSel.title = 'Where the text sits on the screen';
  panel.appendChild(section('layout', 'Slide', prop('Layout', layoutSel)));
}

// Background layer properties — a shape, or the canvas itself (always the
// whole screen: its layout is the slide's, see renderSlideLayout).
function renderBgProps(panel, layer) {
  if (layer.pos) renderLayoutProps(panel, layer);

  // Shape (a shape layer only — the canvas fill is always the whole screen):
  // which shape, and for a rectangle its corner radius (the other shapes
  // have their own edges and ignore it).
  if (layer.pos) {
    const isRect = (layer.shape || 'rect') === 'rect';
    panel.appendChild(section('style', 'Shape', fieldRow([
      makeSelect([
        { label: 'Rectangle', value: 'rect' },
        { label: 'Ellipse',   value: 'ellipse' },
        { label: 'Pill',      value: 'pill' },
        { label: 'Triangle',  value: 'triangle' },
        { label: 'Diamond',   value: 'diamond' },
      ], layer.shape || 'rect', v => { layer.shape = v; up(); renderProps(); }),
      isRect && numField('Corners', layer.radius || 0, { min: 0, max: 200, unit: 'px', onChange: v => { layer.radius = v ?? 0; up(); } }),
    ])));
  }

  // Fill: its kind, then what that kind needs — a colour and its opacity; a
  // gradient's two colours, angle and opacity; or a picture (the bundled
  // backgrounds or the operator's own), darkened for legible text. Picking
  // Picture with none yet starts on the first bundled background, so the
  // canvas changes the moment it's chosen.
  const rows = [fieldRow([makeFillSelect(layer.fill, v => {
    layer.fill = v;
    if (v === 'image' && !layer.src && (window.KairoBackgrounds || []).length) useBackground(layer, window.KairoBackgrounds[0]);
    up(); renderProps();
  })])];
  const opacityField = () => numField('Opacity', layer.opacity ?? 100, { min: 0, max: 100, unit: '%', onChange: v => { layer.opacity = v ?? 100; up(); } });
  if (layer.fill === 'gradient') {
    rows.push(
      fieldRow([
        colorField(layer.color, v => { layer.color = v; up(); }, 'Where the gradient starts'),
        colorField(layer.color2 || '#1a1a2e', v => { layer.color2 = v; up(); }, 'Where it ends'),
      ]),
      fieldRow([
        numField('Angle', layer.angle ?? 160, { min: 0, max: 360, unit: '°', onChange: v => { layer.angle = v ?? 0; up(); } }),
        opacityField(),
      ]));
  } else if (layer.fill === 'image') {
    rows.push(
      fieldRow([makeBackgroundGrid(layer.src, bg => { useBackground(layer, bg); up(); })]),
      fieldRow([fieldBtn('Your own image…', () => pickOwnBackground(layer))]),
      fieldRow([
        numField('Darken', layer.dim || 0, { min: 0, max: 80, unit: '%', title: 'Darken the picture so text on it reads', onChange: v => { layer.dim = v ?? 0; up(); } }),
        opacityField(),
      ]));
  } else if (layer.fill !== 'transparent') {
    rows.push(colorOpacityRow(layer.color, v => { layer.color = v; up(); }, layer.opacity, v => { layer.opacity = v; up(); }));
  }
  panel.appendChild(section('style', 'Fill', ...rows));
}

// ── Background pool ───────────────────────────────────────────────────────
// The bundled backgrounds (src/backgrounds, listed by backgrounds.js) — any
// background layer can be filled with one, by path, so the pictures ship with
// the app, stay out of the saved themes, and one picture serves any number
// of themes and slides.
function useBackground(layer, bg) {
  layer.fill = 'image';
  layer.src = bg.src;
  if (bg.color) layer.color = bg.color;
}
function makeBackgroundGrid(currentSrc, onPick) {
  const grid = document.createElement('div');
  grid.className = 'ts-bg-grid';
  (window.KairoBackgrounds || []).forEach(bg => {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'ts-bg-swatch' + (bg.src === currentSrc ? ' active' : '');
    b.title = bg.name;
    b.setAttribute('aria-label', bg.name);
    b.style.backgroundImage = `url("${bg.thumb}")`;
    b.addEventListener('click', () => {
      grid.querySelectorAll('.ts-bg-swatch').forEach(x => x.classList.toggle('active', x === b));
      onPick(bg);
    });
    grid.appendChild(b);
  });
  return grid;
}
// Asks for one image file and hands back what loadImageFile makes of it.
function pickImageFile(onLoaded) {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = 'image/*';
  inp.addEventListener('change', async () => {
    const file = inp.files && inp.files[0];
    if (!file) return;
    let img;
    try { img = await loadImageFile(file); } catch { toast('Could not load that image', 'error'); return; }
    onLoaded(img);
  });
  inp.click();
}
function pickOwnBackground(layer, after) {
  pickImageFile(({ src }) => {
    layer.fill = 'image'; layer.src = src;
    up(); renderProps();
    if (after) after();
  });
}

// Image layer properties: the picture (with Replace…), how it fits its box,
// its corners and opacity, and a slow zoom; then its photo look.
const IMAGE_FITS = [
  { label: 'Fill the box (crop)', value: 'cover' },
  { label: 'Fit inside the box', value: 'contain' },
  { label: 'Stretch to the box', value: 'fill' },
];
function layerNameSection(panel, layer) {
  const nameInp = document.createElement('input');
  nameInp.type = 'text'; nameInp.className = 'ts-prop-input';
  nameInp.value = layer.name; nameInp.placeholder = 'Layer name';
  nameInp.addEventListener('input', () => { layer.name = nameInp.value; renderLayersList(); });
  panel.appendChild(section('layout', 'Layer', prop('Name', nameInp)));
}
function renderImageProps(panel, layer) {
  layerNameSection(panel, layer);
  renderLayoutProps(panel, layer);

  // The picture itself, and Replace… — swaps the picture and keeps
  // everything else: its box, fade, animation.
  const thumb = document.createElement('div');
  thumb.className = 'ts-image-thumb';
  thumb.style.backgroundImage = `url("${String(layer.src || '').replace(/["\\\n\r]/g, c => encodeURIComponent(c))}")`;
  const replace = fieldBtn('Replace…', () => pickImageFile(({ src, w, h }) => {
    layer.src = src; layer.naturalW = w; layer.naturalH = h;
    up(); renderProps();
  }));
  // (Its slow zoom is under Animate → Keeps moving, with every other motion.)
  panel.appendChild(section('style', 'Image',
    fieldRow([thumb, replace]),
    fieldRow([makeSelect(IMAGE_FITS, layer.fit || 'contain', v => { layer.fit = v; up(); })]),
    fieldRow([
      numField('Corners', layer.radius || 0, { min: 0, max: 200, unit: 'px', onChange: v => { layer.radius = v ?? 0; up(); } }),
      numField('Opacity', layer.opacity ?? 100, { min: 0, max: 100, unit: '%', onChange: v => { layer.opacity = v ?? 100; up(); } }),
    ])));
  renderPhotoLookProps(panel, layer);

  // The color-key "Remove background" cutout used to live here — pulled per
  // operator report that it doesn't key cleanly (a flat-color-tolerance
  // keyer can't handle a real photo background, only a true flat backdrop),
  // so it did more harm than good. removeImageBackground() itself is gone
  // too; if a real cutout tool comes back, it should be an actual
  // segmentation model, not this.
}

// Black & white, and a soft fade into the slide from one edge — the washed-
// back photo half of an announcement slide. Rendered by applyImageLook
// (layer_geometry.js) everywhere the layer is shown.
function renderPhotoLookProps(panel, layer) {
  const side = layer.fade?.side || 'none';
  const fadeSel = makeSelect([
    { label: 'None', value: 'none' }, { label: 'Left', value: 'left' }, { label: 'Right', value: 'right' },
    { label: 'Top', value: 'top' }, { label: 'Bottom', value: 'bottom' },
  ], side, v => {
    if (v === 'none') delete layer.fade; else layer.fade = { side: v, amount: layer.fade?.amount ?? 45 };
    up(); renderProps();
  });
  fadeSel.title = 'The edge the picture fades in from';
  panel.appendChild(section('style', 'Photo look',
    fieldRow([numField('Black & white', layer.grayscale || 0, { min: 0, max: 100, unit: '%', onChange: v => { layer.grayscale = v ?? 0; up(); } })], { cols: 2 }),
    fieldRow([
      labeledField('Fade', fadeSel),
      side !== 'none' && numField('Length', layer.fade.amount ?? 45, { min: 5, max: 100, unit: '%', title: 'How much of the picture the fade covers', onChange: v => { layer.fade.amount = v ?? 45; up(); } }),
    ], { cols: 2 })));
}

// Image Cycle layer properties — a slideshow of stills that advances on its
// own as a live Timer segment's countdown runs (see triggers.js's
// stage-timer totalMs/remainingMs and display.html's handleActionBadge),
// evenly spacing `sources.length` images across the whole countdown so the
// last one lands right as it hits zero. Built for the "image left / timer
// right" pre-service layout, but positioned/sized like any other layer
// (renderLayoutProps), so it isn't tied to one specific split. Editing here
// (and every static preview: the canvas below, paintLookLayers,
// buildLayerDOM's non-ticking initial paint) always shows sources[0] — the
// live advance only happens against a real running countdown on the actual
// output, not in any preview surface.
function renderImageCycleProps(panel, layer) {
  layerNameSection(panel, layer);
  renderLayoutProps(panel, layer);

  // Timing — "Each": seconds per picture, only meaningful for a scene's own
  // slideshow (a countdown's slides); blank spreads them evenly across the
  // whole countdown instead (see display.html's handleActionBadge for which
  // applies). A continuous slow zoom while each picture is up is the same
  // plain CSS animation the Image layer's has (display.html's
  // startCycleMotion), so it keeps running against a countdown that can be
  // re-timed at any moment.
  const cycleSettings = [
    fieldRow([makeSelect(IMAGE_FITS, layer.fit || 'cover', v => { layer.fit = v; up(); })]),
    fieldRow([
      numField('Each', layer.intervalSec || '', { min: 0, max: 600, unit: 's', placeholder: 'auto', title: 'Seconds per picture — empty spreads them over the countdown', onChange: v => { layer.intervalSec = v > 0 ? v : undefined; up(); } }),
      makeSelect([
        { label: 'Cut', value: 'cut' }, { label: 'Slide across', value: 'slide' }, { label: 'Crossfade', value: 'crossfade' },
      ], layer.transition || 'cut', v => { layer.transition = v; up(); }),
    ]),
    fieldRow([
      numField('Corners', layer.radius || 0, { min: 0, max: 200, unit: 'px', onChange: v => { layer.radius = v ?? 0; up(); } }),
      numField('Opacity', layer.opacity ?? 100, { min: 0, max: 100, unit: '%', onChange: v => { layer.opacity = v ?? 100; up(); } }),
    ]),
  ];

  const listWrap = document.createElement('div');
  listWrap.className = 'ts-cycle-list';
  const fileInp = document.createElement('input');
  fileInp.type = 'file'; fileInp.accept = 'image/*'; fileInp.multiple = true; fileInp.style.display = 'none';
  const uploadBtn = fieldBtn('Upload…', () => fileInp.click());
  const libBtn = fieldBtn('From Library…', () => openCycleImagePicker(layer));
  fileInp.addEventListener('change', async () => {
    for (const file of Array.from(fileInp.files || [])) {
      try {
        const { src } = await loadImageFile(file);
        layer.sources = layer.sources || [];
        layer.sources.push(src);
      } catch { toast('Could not load that image', 'error'); }
    }
    fileInp.value = '';
    up();
    renderProps();
  });
  listWrap.append(fieldRow([uploadBtn, libBtn]), fileInp);

  const grid = document.createElement('div');
  grid.className = 'ts-cycle-grid';
  (layer.sources || []).forEach((src, i) => {
    const card = document.createElement('div');
    card.className = 'ts-cycle-thumb';
    const img = document.createElement('img');
    img.src = src;
    card.appendChild(img);
    const badge = document.createElement('span');
    badge.className = 'ts-cycle-thumb-index';
    badge.textContent = String(i + 1);
    card.appendChild(badge);
    const rm = document.createElement('button');
    rm.className = 'ts-cycle-thumb-remove';
    rm.title = 'Remove';
    rm.innerHTML = '<svg width="10" height="10" viewBox="0 0 16 16"><path d="M3 3l10 10M13 3L3 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg>';
    rm.addEventListener('click', () => { layer.sources.splice(i, 1); up(); renderProps(); });
    card.appendChild(rm);
    grid.appendChild(card);
  });
  if (!(layer.sources || []).length) {
    const empty = document.createElement('div');
    empty.className = 'svc-empty';
    empty.textContent = 'No images yet — add at least 2 to cycle through.';
    grid.appendChild(empty);
  }
  listWrap.appendChild(grid);
  // The pictures first — they are the slideshow — then how they play.
  panel.appendChild(section('style', `Slideshow · ${(layer.sources || []).length} picture${(layer.sources || []).length === 1 ? '' : 's'}`, listWrap, ...cycleSettings));
  renderPhotoLookProps(panel, layer);
}

// Reuses fetchAllMediaItems (Theme Studio's own Media Library browser) but
// appends into layer.sources instead of setting a single image layer's src
// — a separate small overlay rather than generalizing openMediaLibraryPicker,
// since "pick one, replace src, close" and "pick any number, keep the
// picker open, append each" are different enough interactions.
let cycleImagePickerEl = null;
function closeCycleImagePicker() { cycleImagePickerEl?.remove(); cycleImagePickerEl = null; }
async function openCycleImagePicker(layer) {
  closeCycleImagePicker();
  const overlay = document.createElement('div');
  overlay.className = 'ts-media-picker-overlay';
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeCycleImagePicker(); });
  const panel = document.createElement('div');
  panel.className = 'ts-media-picker-panel';
  const header = document.createElement('div');
  header.className = 'ts-media-picker-header';
  header.innerHTML = '<span>Add from Media Library</span>';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'modal-close-btn';
  closeBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16"><path d="M3 3l10 10M13 3L3 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg><span>Close</span>';
  closeBtn.addEventListener('click', closeCycleImagePicker);
  header.appendChild(closeBtn);
  panel.appendChild(header);
  const grid = document.createElement('div');
  grid.className = 'ts-media-picker-grid';
  grid.innerHTML = '<div class="svc-empty">Loading…</div>';
  panel.appendChild(grid);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  cycleImagePickerEl = overlay;

  const items = (await fetchAllMediaItems()).filter(it => it.kind === 'image');
  grid.innerHTML = '';
  if (!items.length) {
    grid.innerHTML = '<div class="svc-empty">No images in your Media Library yet.</div>';
    return;
  }
  items.forEach(item => {
    const card = document.createElement('button');
    card.className = 'media-card';
    const img = document.createElement('img');
    img.src = item.url;
    card.appendChild(img);
    const label = document.createElement('div');
    label.className = 'media-card-label';
    label.textContent = item.name;
    card.appendChild(label);
    // Stays open — appending one image at a time is the whole point of
    // this picker being separate from the single-image one.
    card.addEventListener('click', async () => {
      try {
        const { src } = await loadImageFromUrl(item.url);
        layer.sources = layer.sources || [];
        layer.sources.push(src);
        up();
        renderProps();
      } catch { toast('Could not load that image', 'error'); }
    });
    grid.appendChild(card);
  });
}

// ── Motion graphics ───────────────────────────────────────────────────────
// A 'motion' layer (motion_graphics.js) is drawn from shapes and CSS, so every
// element of it is editable here: which graphic it is, each of its colours
// (add, remove, recolour), and the kind's own controls — count, size, speed,
// softness, direction… — all built from the kind's parameter list, so a new
// kind gets its controls without new UI code. Position and size come from
// Layout like any layer.
function renderMotionProps(panel, layer) {
  const M = window.KairoMotion;
  layerNameSection(panel, layer);
  renderLayoutProps(panel, layer);
  if (!M) return;

  // Edited as a normalized copy, stored back only when something changes —
  // just opening the layer mustn't rewrite it (in Full-scale edit that would
  // pin the theme's graphic to this slide).
  const g = M.normalize(layer.graphic);
  const kind = M.kind(g.kind);
  const changed = () => { layer.graphic = g; up(); };

  // Which graphic — switching keeps the colours the operator already chose
  // where the new kind can use them. A layer still named after its old kind
  // follows the new one; a name the operator typed stays.
  const pickKind = (v) => {
    const wasDefaultName = layer.name === kind.label;
    layer.graphic = M.switchKind(g, v);
    if (wasDefaultName) layer.name = M.kind(v).label;
    up(); renderProps();
  };
  const family = (id, label) => ({ label, options: M.kinds().filter(k => k.family === id).map(k => ({ label: k.label, value: k.id })) });
  const blurb = document.createElement('div');
  blurb.className = 'ts-motion-blurb';
  blurb.textContent = kind.blurb;
  panel.appendChild(section('style', 'Motion',
    fieldRow([makeGroupedSelect([
      family('ambient', 'Moving backgrounds'),
      family('timer', 'Countdown'),
      family('element', 'Hand-drawn'),
    ], g.kind, pickKind)]),
    blurb));

  // Colours — one swatch per element colour, named where the kind names them.
  const colors = document.createElement('div');
  colors.className = 'ts-motion-colors';
  g.colors.forEach((c, i) => {
    const cell = document.createElement('div');
    cell.className = 'ts-motion-color';
    cell.appendChild(makeColor(c, v => { g.colors[i] = v; changed(); }));
    const lbl = document.createElement('span');
    lbl.textContent = kind.colors.labels?.[i] || `Color ${i + 1}`;
    cell.appendChild(lbl);
    if (g.colors.length > kind.colors.min) {
      const rm = document.createElement('button');
      rm.className = 'ts-motion-color-rm';
      rm.title = 'Remove this colour';
      rm.textContent = '×';
      rm.addEventListener('click', () => { g.colors.splice(i, 1); changed(); renderProps(); });
      cell.appendChild(rm);
    }
    colors.appendChild(cell);
  });
  if (g.colors.length < kind.colors.max) {
    const add = document.createElement('button');
    add.className = 'ts-motion-color-add';
    add.title = 'Add a colour';
    add.textContent = '+';
    add.addEventListener('click', () => {
      g.colors.push(kind.colors.def[g.colors.length % kind.colors.def.length]);
      changed(); renderProps();
    });
    colors.appendChild(add);
  }
  if (kind.colors.max > 0) panel.appendChild(section('style', 'Colors', fieldRow([colors])));

  // The kind's own controls: each choice a dropdown with its name inside, on
  // its own line; numbers and switches as fields, two to a line.
  const rows = [], pair = [];
  const flush = () => { if (pair.length) rows.push(fieldRow(pair.splice(0), { cols: 2 })); };
  kind.params.forEach(p => {
    if (p.type === 'chips') { flush(); rows.push(prop(p.label, makeSelect(p.options, g[p.key], v => { g[p.key] = v; changed(); }))); return; }
    pair.push(p.type === 'range'
      ? numField(p.label, +(+g[p.key]).toFixed(p.step < 1 ? 2 : 0), { min: p.min, max: p.max, step: p.step, unit: p.unit || '', onChange: v => { g[p.key] = v ?? p.min; changed(); } })
      : toggleField(p.label, !!g[p.key], v => { g[p.key] = v; changed(); }));
    if (pair.length === 2) flush();
  });
  // …and, last, the layer's opacity with Shuffle (a new arrangement of the
  // same elements, for the kinds scattered at random) beside it.
  pair.push(numField('Opacity', layer.opacity ?? 100, { min: 0, max: 100, unit: '%', onChange: v => { layer.opacity = v ?? 100; up(); } }));
  if (pair.length === 2) flush();
  if (kind.shuffle) pair.push(fieldBtn('Shuffle', () => { g.seed = M.newSeed(); changed(); }, 'A new arrangement of the same elements'));
  flush();
  panel.appendChild(section('style', kind.label, ...rows));
}

// Where a new motion layer lands: a background fills the canvas; a timer or
// element graphic gets a sensible box of its own, centred.
function defaultMotionPos(kindId) {
  const W = TS_DESIGN_W, H = TS_DESIGN_H;
  const box = (w, h, y) => ({ x: Math.round((W - w) / 2), y: Math.round(y ?? (H - h) / 2), w, h });
  switch (kindId) {
    case 'ring':   return box(720, 720);
    case 'dots':   return box(820, 820);
    case 'bar':    return box(1200, 16, 900);
    case 'line':   return box(900, 600);
    case 'doodle': return box(320, 220);
    default:       return { x: 0, y: 0, w: W, h: H };
  }
}

function addMotionLayer(kindId) {
  const M = window.KairoMotion;
  if (!activeLook || !M) return;
  const kind = M.kind(kindId);
  const layer = {
    id: 'motion-' + Date.now(), type: 'motion', name: kind.label, visible: true, opacity: 100,
    pos: defaultMotionPos(kind.id), graphic: M.create(kind.id),
  };
  // A background graphic is a backdrop: it goes right above the canvas fill,
  // behind the theme's shapes, images and text. Timer and element graphics go
  // on top, like any newly added layer.
  if (kind.family === 'ambient') {
    const bgIdx = activeLook.layers.findIndex(l => l.type === 'background' && !l.pos);
    activeLook.layers.splice(bgIdx + 1, 0, layer);
  } else {
    activeLook.layers.push(layer);
  }
  activeLayer = layer;
  up();
  renderProps();
}

// The shell both galleries (Motion, Background) open in: a titled panel over
// the editor that closes on its Close button, a click outside it, or Esc.
// Returns the scrolling body to fill, and a group(label, hint) that adds a
// labelled grid of tiles to it.
let galleryEl = null;
function closeGallery() { galleryEl?.remove(); galleryEl = null; }
function openGalleryShell(title) {
  closeGallery();
  const overlay = document.createElement('div');
  overlay.className = 'ts-media-picker-overlay';
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeGallery(); });
  const panel = document.createElement('div');
  panel.className = 'ts-media-picker-panel ts-motion-gallery';
  const header = document.createElement('div');
  header.className = 'ts-media-picker-header';
  header.innerHTML = '<span></span>';
  header.querySelector('span').textContent = title;
  const closeBtn = document.createElement('button');
  closeBtn.className = 'modal-close-btn';
  closeBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16"><path d="M3 3l10 10M13 3L3 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg><span>Close</span>';
  closeBtn.addEventListener('click', closeGallery);
  header.appendChild(closeBtn);
  panel.appendChild(header);
  const body = document.createElement('div');
  body.className = 'ts-motion-gallery-body';
  panel.appendChild(body);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  galleryEl = overlay;
  const group = (label, hint, gridClass = '') => {
    const h = document.createElement('div');
    h.className = 'ts-motion-family';
    h.innerHTML = '<span></span><em></em>';
    h.querySelector('span').textContent = label;
    h.querySelector('em').textContent = hint;
    body.appendChild(h);
    const grid = document.createElement('div');
    grid.className = 'ts-motion-grid' + (gridClass ? ' ' + gridClass : '');
    body.appendChild(grid);
    return grid;
  };
  return { body, group };
}
// A gallery tile: its picture (art(el) paints it), a name and a line under it.
function galleryTile(grid, { name, blurb, art, active, onPick }) {
  const t = document.createElement('button');
  t.className = 'ts-motion-tile' + (active ? ' active' : '');
  const a = document.createElement('div');
  a.className = 'ts-motion-tile-art';
  art(a);
  const label = document.createElement('div');
  label.className = 'ts-motion-tile-label';
  label.innerHTML = '<strong></strong><span></span>';
  label.querySelector('strong').textContent = name;
  label.querySelector('span').textContent = blurb;
  t.appendChild(a); t.appendChild(label);
  t.addEventListener('click', () => { closeGallery(); onPick(); });
  grid.appendChild(t);
}

// The gallery behind "Motion": every graphic, moving, grouped by what it's
// for. Picking one adds it; everything about it stays editable afterwards.
function openMotionGallery() {
  const M = window.KairoMotion;
  if (!M) return;
  const { group } = openGalleryShell('Add motion');
  const FAMILIES = [
    { id: 'ambient', label: 'Backgrounds', hint: 'Fill the screen, behind everything else' },
    { id: 'element', label: 'Elements', hint: 'Hand-drawn accents that draw themselves on' },
    { id: 'timer', label: 'Timer', hint: 'Follow the live countdown' },
  ];
  FAMILIES.forEach(fam => {
    const kinds = M.kinds().filter(k => k.family === fam.id);
    if (!kinds.length) return;
    const grid = group(fam.label, fam.hint);
    kinds.forEach(k => galleryTile(grid, {
      name: k.label, blurb: k.blurb,
      art: (a) => {
        // Elements are shown bigger and bolder here than they're added, so a
        // hand-drawn line reads at tile size.
        const tileBox = { line: { x: 280, y: 140, w: 1360, h: 800 }, doodle: { x: 610, y: 190, w: 700, h: 700 } }[k.id];
        const p = tileBox || defaultMotionPos(k.id);
        const graphic = M.create(k.id);
        if (tileBox) graphic.thickness = 22;
        const box = document.createElement('div');
        box.style.cssText = `position:absolute;left:${p.x / TS_DESIGN_W * 100}%;top:${p.y / TS_DESIGN_H * 100}%;width:${p.w / TS_DESIGN_W * 100}%;height:${p.h / TS_DESIGN_H * 100}%;`;
        box.appendChild(M.build(graphic, { mode: 'demo', box: { w: p.w, h: p.h } }));
        a.appendChild(box);
      },
      onPick: () => addMotionLayer(k.id),
    }));
  });
}
document.getElementById('ts-add-motion-btn')?.addEventListener('click', () => { if (activeLook) openMotionGallery(); });

// The theme's (or slide's) canvas fill, made if it has none.
function canvasFillLayer() {
  let bg = baseBgLayer();
  if (!bg && activeLook) {
    const id = activeLook.layers.some(l => l.id === 'bg') ? 'bg-' + Date.now() : 'bg';
    bg = { id, type: 'background', name: 'Canvas', visible: true, fill: 'transparent', color: '#000000', opacity: 100, color2: '#000000', angle: 0 };
    activeLook.layers.unshift(bg);
  }
  return bg;
}
function afterCanvasFill(bg) {
  activeLayer = bg; multiSelectedLayerIds.clear();
  activePropsTab = 'style';
  up(); renderLayersList(); renderProps(); renderThemeCanvasSizeSelect();
}

// The gallery behind "Background": the bundled backgrounds, plus none and the
// operator's own image. Picking one fills the canvas — the theme's, or in
// Full-scale edit just this slide's — and selects it, so Darken and Opacity
// are right there in the panel.
function openBgGallery() {
  const current = baseBgLayer();
  const { group } = openGalleryShell('Background');
  const pool = group('Backgrounds', 'Ship with Kairo — any theme or slide can use them', 'ts-bg-gallery-grid');
  (window.KairoBackgrounds || []).forEach(bg => galleryTile(pool, {
    name: bg.name,
    blurb: bg.tone === 'light' ? 'Light — use dark text' : bg.tags.join(' · ').replace(/^./, c => c.toUpperCase()),
    art: a => { a.style.background = `url("${bg.thumb}") center / cover no-repeat ${bg.color || '#000'}`; },
    active: current?.fill === 'image' && current.src === bg.src,
    onPick: () => { const c = canvasFillLayer(); if (!c) return; useBackground(c, bg); delete c.fillBefore; afterCanvasFill(c); },
  }));
  const other = group('Other', 'Your own picture, or nothing behind the content', 'ts-bg-gallery-grid');
  galleryTile(other, {
    name: 'Your own image…', blurb: 'Fills the canvas, cropped to fit',
    art: a => { a.classList.add('ts-bg-tile-own'); a.textContent = '+'; },
    active: current?.fill === 'image' && !!current.src && !/^backgrounds\//.test(current.src),
    onPick: () => { const c = canvasFillLayer(); if (c) pickOwnBackground(c, () => { delete c.fillBefore; afterCanvasFill(c); }); },
  });
  galleryTile(other, {
    name: 'None', blurb: 'Transparent — for keying over cameras',
    art: a => a.classList.add('ts-bg-tile-none'),
    active: current?.fill === 'transparent',
    onPick: () => {
      const c = canvasFillLayer(); if (!c) return;
      if (c.fill !== 'transparent') { c.fillBefore = c.fill; c.fill = 'transparent'; }
      afterCanvasFill(c);
    },
  });
}
document.getElementById('ts-add-bg-btn')?.addEventListener('click', () => { if (activeLook) openBgGallery(); });
document.getElementById('ts-play-anim-btn')?.addEventListener('click', () => { if (activeLook) tsPlayAnimations(); });

// How the verse text reveals as it goes up (KairoWordSplit), separate from the
// transition between slides — the theme's setting, shown with the type of the
// layer it moves (one showing the verse or lyrics). Its speed, and the colour
// and intensity only the reveals that use them get.
const TEXT_REVEALS = [
  { label: 'None', value: 'none' },
  { label: 'Word', value: 'word-in', title: 'Bold per-word reveal' },
  { label: 'Activate', value: 'activate', title: 'Each word flashes from dim to fully lit' },
  { label: 'Karaoke', value: 'karaoke', title: 'Sing-along chase: each word snaps lit in turn' },
  { label: 'Typewriter', value: 'typewriter', title: 'Types out one character at a time' },
  { label: 'Impact', value: 'impact', title: 'Captions where keywords pop bigger, bolder, highlighted' },
  { label: 'Bold Caption', value: 'bold-caption', title: 'Stacked short lines; an occasional word pops much bigger' },
  { label: 'Bounce', value: 'bounce', title: 'Springy pop-on, higher-energy than Word' },
  { label: 'Highlight Box', value: 'highlight-box', title: 'A highlight-coloured box slides under each word in turn' },
  { label: 'Shimmer', value: 'shimmer', title: 'A soft sheen sweeps across the line once' },
];
function revealRows() {
  const anim = activeLook.textAnimation || 'none';
  const set = (key, v) => { activeLook[key] = v; scheduleThemeAutosave(); renderPreview(); };
  const rows = [prop('Reveal', makeSelect(TEXT_REVEALS, anim, v => {
    activeLook.textAnimation = v === 'none' ? null : v;
    scheduleThemeAutosave(); renderPreview(); renderProps();
  }))];
  if (anim === 'none') return rows;
  const kids = [numField('Speed', activeLook.textAnimationSpeed || 1, { min: 0.3, max: 2.5, step: 0.1, unit: '×', onChange: v => set('textAnimationSpeed', v ?? 1) })];
  if (['impact', 'karaoke', 'highlight-box'].includes(anim)) kids.push(swatchField('Highlight', activeLook.textHighlightColor || '#ffd23f', v => set('textHighlightColor', v)));
  if (['impact', 'bold-caption'].includes(anim)) kids.push(numField('Intensity', activeLook.textAnimationIntensity ?? 1, { min: 0.5, max: 2, step: 0.1, unit: '×', onChange: v => set('textAnimationIntensity', v ?? 1) }));
  rows.push(fieldRow(kids, { cols: Math.max(2, kids.length) }));
  return rows;
}

// Text layer properties — laid out as a design tool's text inspector: what the
// layer shows (Layout tab), then the type — family; weight and size; line and
// letter spacing; alignment, italic and case — and its colour (Style), its
// shadow and outline (Effects).
function renderTextProps(panel, layer) {
  const nameInp = document.createElement('input');
  nameInp.type = 'text'; nameInp.className = 'ts-prop-input';
  nameInp.value = layer.name; nameInp.placeholder = 'Layer name';
  nameInp.addEventListener('input', () => { layer.name = nameInp.value; renderLayersList(); });

  const customInp = document.createElement('input');
  customInp.type = 'text'; customInp.className = 'ts-prop-input';
  customInp.value = layer.customText || ''; customInp.placeholder = 'Type the text — or double-click it on the canvas';
  customInp.addEventListener('input', () => { layer.customText = customInp.value; up(); });
  const customRow = prop('Text', customInp);
  customRow.style.display = layer.binding === 'custom' ? '' : 'none';

  panel.appendChild(section('layout', 'Layer', ...[
    prop('Name', nameInp),
    prop('Shows', makeSelect([
      { label: 'The verse or lyrics', value: 'verse' },
      { label: 'The reference', value: 'reference' },
      { label: 'The countdown', value: 'timer' },
      // Hour/Minute/Second — the individual zero-padded pieces (see
      // display.html's timeParts) instead of one fixed "H:MM:SS" string,
      // so the countdown can be laid out as separately positioned/sized/
      // styled elements — e.g. the hour stacked directly above the
      // minute — rather than only ever one text box with no layout
      // control over its own pieces.
      { label: 'Countdown hours', value: 'timer-h' },
      { label: 'Countdown minutes', value: 'timer-m' },
      { label: 'Countdown seconds', value: 'timer-s' },
      { label: 'The verse, translated', value: 'verse_translated' },
      { label: 'Text you type', value: 'custom' },
    ], layer.binding, v => { layer.binding = v; up(); renderProps(); })),
    customRow,
    // The language a translated verse shows in — the theme's, set on the
    // layer that shows it (a playlist item or the Bible tab can still pick
    // another). A whole-theme setting, so not in a slide's own editor.
    tsMode !== 'item' && layer.binding === 'verse_translated' && prop('Language', makeSelect([
      { label: 'None', value: '' }, { label: 'French', value: 'fr' }, { label: 'Spanish', value: 'es' }, { label: 'Portuguese', value: 'pt' },
    ], activeLook.translateTo || '', v => { activeLook.translateTo = v || null; renderPreview(); scheduleThemeAutosave(); }))
  ].filter(Boolean)));

  renderLayoutProps(panel, layer);

  // Type: the family on its own line, then weight and size, then line and
  // letter spacing (exact numbers — 1.15, -0.5 — are what people reach for),
  // then alignment with italic and case.
  const caseSel = makeSelect([
    { label: 'Aa  As typed', value: 'none' }, { label: 'AA  Uppercase', value: 'uppercase' }, { label: 'aa  Lowercase', value: 'lowercase' },
  ], layer.font.transform || 'none', v => { layer.font.transform = v; up(); });
  caseSel.title = 'Letter case';
  const italic = iconToggle('I', layer.font.italic, 'Italic', v => { layer.font.italic = v; up(); }, { italic: true });
  italic.classList.add('ts-row-icon');
  panel.appendChild(section('style', 'Text',
    fieldRow([makeFontSelect(layer.font.family, v => { layer.font.family = v; up(); })]),
    fieldRow([
      makeWeightSelect(layer.font.weight, v => { layer.font.weight = v; up(); }),
      numField('Size', layer.font.size, { min: 8, max: 300, unit: 'px', onChange: v => { layer.font.size = v ?? layer.font.size; up(); } }),
    ]),
    fieldRow([
      numField('Line', layer.font.lineHeight, { min: 0.5, max: 4, step: 0.05, title: 'Line spacing', onChange: v => { layer.font.lineHeight = parseFloat((v ?? 1.2).toFixed(2)); up(); } }),
      numField('Letter', layer.font.letterSpacing, { min: -5, max: 30, step: 0.5, unit: 'px', title: 'Letter spacing', onChange: v => { layer.font.letterSpacing = parseFloat((v ?? 0).toFixed(1)); up(); } }),
    ]),
    fieldRow([makeAlignBtns(layer.align, v => { layer.align = v; up(); }), caseSel, italic]),
    // How the verse reveals — the theme's, so not in a slide's own editor.
    ...(tsMode !== 'item' && layer.binding === 'verse' ? revealRows() : [])));

  // Colour: the text's, with its opacity; and — for text typed in, not a
  // verse or the countdown — highlighted words: words wrapped in
  // *asterisks* show in the highlight colour, a two-tone headline
  // ("*FIRST TIME* / WITH US?") in one layer.
  const colorKids = [colorOpacityRow(layer.color, v => { layer.color = v; up(); }, layer.opacity, v => { layer.opacity = v; up(); })];
  if (layer.binding === 'custom') {
    colorKids.push(fieldRow([
      toggleField('Highlight', !!layer.accentColor, v => {
        if (v) layer.accentColor = layer.accentColor || '#e3cf6c'; else delete layer.accentColor;
        up(); renderProps();
      }, 'Colour chosen words differently — put *asterisks* around them'),
      layer.accentColor && colorField(layer.accentColor, v => { layer.accentColor = v; up(); }, 'The highlight colour'),
    ], { cols: 2 }));
    if (layer.accentColor) {
      const hint = document.createElement('div');
      hint.className = 'ts-motion-blurb';
      hint.textContent = 'Put *asterisks* around the words to highlight.';
      colorKids.push(hint);
    }
  }
  panel.appendChild(section('style', 'Color', ...colorKids));

  // Effects — each an on/off row (its name and a switch), with its settings
  // under it while on, in one section.
  function effectSection(name, enabled, onToggle, detailChildren) {
    const header = document.createElement('div');
    header.className = 'ts-prop-row ts-effect-header';
    const label = document.createElement('span');
    label.className = 'ts-props-section-label'; label.style.margin = '0'; label.textContent = name;
    const toggle = makeToggle(enabled, v => { onToggle(v); details.style.display = v ? '' : 'none'; up(); });
    header.appendChild(label); header.appendChild(toggle);
    const details = document.createElement('div');
    details.className = 'ts-effect-details';
    details.style.display = enabled ? '' : 'none';
    detailChildren.forEach(c => details.appendChild(c));
    return section('effects', null, header, details);
  }

  // Shadow: its colour and opacity, then blur and offset.
  panel.appendChild(effectSection('Shadow', layer.shadow.enabled, v => { layer.shadow.enabled = v; }, [
    colorOpacityRow(layer.shadow.color, v => { layer.shadow.color = v; up(); }, layer.shadow.opacity, v => { layer.shadow.opacity = v; up(); }),
    fieldRow([
      numField('Blur', layer.shadow.blur, { min: 0, max: 60, onChange: v => { layer.shadow.blur = v ?? 0; up(); } }),
      numField('X', layer.shadow.x, { min: -50, max: 50, title: 'Horizontal offset', onChange: v => { layer.shadow.x = v ?? 0; up(); } }),
      numField('Y', layer.shadow.y, { min: -50, max: 50, title: 'Vertical offset', onChange: v => { layer.shadow.y = v ?? 0; up(); } }),
    ]),
  ]));

  // Outline: its colour and width.
  panel.appendChild(effectSection('Outline', layer.outline.enabled, v => { layer.outline.enabled = v; }, [
    fieldRow([
      colorField(layer.outline.color, v => { layer.outline.color = v; up(); }),
      numField('Width', layer.outline.width, { min: 1, max: 10, unit: 'px', onChange: v => { layer.outline.width = v ?? 2; up(); } }),
    ]),
  ]));

  // Scroll — continuous horizontal marquee (news-ticker / large-scroll
  // layers, see the Ticker and Scroll — Fill Screen presets). Independent of
  // layout: works on the Ticker preset's bottom strip or a free-canvas box
  // just as well. Its speed is the seconds one full loop takes.
  if (!layer.scroll) layer.scroll = { enabled: false, speed: 15 };
  panel.appendChild(effectSection('Scroll', layer.scroll.enabled, v => { layer.scroll.enabled = v; }, [
    fieldRow([numField('One loop', layer.scroll.speed, { min: 3, max: 60, unit: 's', title: 'Seconds for one full loop — lower is faster', onChange: v => { layer.scroll.speed = v ?? 15; up(); } })], { cols: 2 }),
  ]));

  // Entrance — the one-time fade + rise older themes used before build-ins
  // (Animate → Arrives) existed. Shown only on a layer that still has it, so
  // it can be switched off; new layers use Arrives.
  if ((layer.entrance || 'none') !== 'none') {
    panel.appendChild(effectSection('Entrance (fade + rise)', true, v => { layer.entrance = v ? 'fade-up' : 'none'; }, []));
  }
}

// ── Wire modal open/close ─────────────────────────────────────────────────
const looksBtn     = document.getElementById('looks-btn');
const looksModal   = document.getElementById('looks-modal');
const newLookBtn   = document.getElementById('new-look-btn');
// (No global "apply" button — themes are assigned per output in Settings.
// No delete button here either — deleting a theme happens on its own row
// in the themes list now, see renderLooksList/deleteLook.)
const tsAddLayerBtn = document.getElementById('ts-add-layer-btn');

// Theme Studio is a full in-window view, not an overlay: opening it swaps the
// dashboard out so the canvas gets the whole content region.
function openThemeStudio() {
  // The top-nav "Theme Studio" tab stays clickable even while item mode's
  // modal is showing (same modal, both reachable independent of each
  // other) — without this, tsMode would stay 'item' while the left panel
  // switched back to the themes list below, desyncing every mode-aware
  // check (renderLayersList's text-only filter, undo/redo routing, etc.)
  // from what's actually on screen.
  // Leaving it also puts back what closeItemStyleEditor does — a theme on the
  // canvas, not the item's slide, and nothing selected.
  if (tsMode === 'item') {
    tsMode = 'theme'; tsItemCtx = null; toggleItemModeChrome(false);
    activeLook = looks[0];
    activeLayer = null; multiSelectedLayerIds.clear();
  }
  activePropsTab = 'layout';
  document.querySelector('.main-layout')?.classList.add('hidden-el');
  // Only one full-window view at a time.
  document.getElementById('service-view')?.classList.add('hidden');
  looksModal?.classList.remove('hidden');
  looksBtn?.classList.add('active');
  resetThemeHistory();
  // Every group starts collapsed on each fresh visit to Theme Studio — a
  // long theme list (Bible/Lyrics/Slides plus every imported bundle) reading
  // as one tall wall of slides otherwise. Toggling a group back open still
  // sticks for the rest of this Theme Studio session (renderLooksList's own
  // re-renders, e.g. after import/delete, don't touch this set).
  collapsedThemeGroups = new Set(looks.filter(l => l.groupId).map(l => l.groupId));
  renderLooksList();
  renderLayersList();
  renderThemeCanvasSizeSelect();
  renderProps();
  // Render after layout settles so the stage has real dimensions — the preview
  // scale and verse auto-fit both measure the stage.
  requestAnimationFrame(() => renderPreview());
}

function closeThemeStudio() {
  tsCommitActiveEdit(null);
  looksModal?.classList.add('hidden');
  looksBtn?.classList.remove('active');
  document.querySelector('.main-layout')?.classList.remove('hidden-el');
}

// Item mode reuses this same modal shell (left/center/right three-pane
// layout) but has no use for whole-theme concerns: creating/importing/
// exporting/renaming/deleting themes, and the theme's own settings (its
// layout, reveal and language — renderProps leaves those out in item mode).
// Hiding these wholesale (plain classList toggles, no per-control changes) is
// simpler and safer than threading tsMode checks into each of those unrelated
// render paths. Adding new layers IS supported in item mode (per-slide custom
// text/shape/image layers, stored on the item) — Text, Shape, Image and
// Library all stay visible.
function toggleItemModeChrome(isItem) {
  document.querySelector('#ts-pane-themes .ts-col-header')?.classList.toggle('hidden', isItem);
  document.getElementById('ts-item-mode-header')?.classList.toggle('hidden', !isItem);
  document.getElementById('ts-item-theme-header')?.classList.toggle('hidden', !isItem);
  // Canvas size is a whole-theme concern too — floats over the preview
  // instead of living among the others, so it needs its own toggle here.
  document.querySelector('.ts-canvas-size-group')?.classList.toggle('hidden', isItem);
  const hint = document.querySelector('.ts-layers-hint');
  if (hint) hint.style.visibility = isItem ? 'hidden' : '';
  if (isItem) updateItemThemeLabel();
  renderItemTimerControls();   // hides itself outside a countdown's editor
  activePropsTab = isItem ? 'item' : 'layout';
  renderProps();
}
document.getElementById('ts-item-back-btn')?.addEventListener('click', () => closeItemStyleEditor());

// Shows which theme this item is currently resolving to (its own override,
// or the output default) on the right-panel theme picker button — same
// label text openThemePopover's own rows use ("Output default" vs a theme's
// name).
function updateItemThemeLabel() {
  const label = document.getElementById('ts-item-theme-picker-label');
  if (!label || !tsItemCtx) return;
  const resolved = window.KairoService.themeForItem(tsItemCtx.item);
  label.textContent = tsItemCtx.item.themeId ? (resolved?.name || 'Theme') : 'Output default';
}

// resolveFlexibleTime — "Ends at" used to require strict 24-hour HH:MM;
// see src/layer_geometry.js for the shared, relaxed parser (loaded via
// index.html before this script) — was a byte-identical copy-paste shared
// with service.js's openSegmentTimePopover.

// "HH:MM" (24-hour, as stored) the way this computer shows a time.
function clockTime(hhmm) {
  const [h, m] = String(hhmm).split(':').map(Number);
  const d = new Date(); d.setHours(h, m, 0, 0);
  return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

// The countdown a timer segment will start from — its length, or the time
// left until its end time — formatted as the output shows it, so the editor
// shows the real number rather than a sample. '' when nothing is set yet.
function configuredTimerText(item) {
  const p = item?.trigger?.params || {};
  let sec = 0;
  if (p.mode === 'duration') sec = p.durationSec || 0;
  else if (/^\d{2}:\d{2}$/.test(p.endAtTime || '')) {
    const [h, m] = p.endAtTime.split(':').map(Number);
    const end = new Date(); end.setHours(h, m, 0, 0);
    sec = Math.max(0, Math.ceil((end.getTime() - Date.now()) / 1000));
  }
  if (!(sec > 0)) return '';
  const hh = Math.floor(sec / 3600), mm = Math.floor((sec % 3600) / 60), ss = sec % 60;
  return hh > 0 ? `${hh}:${String(mm).padStart(2, '0')}:${String(ss).padStart(2, '0')}` : `${mm}:${String(ss).padStart(2, '0')}`;
}

// The countdown's actual target — this is the thing that makes a timer
// segment a timer, and it used to live ONLY behind the separate Quick-edit
// popover on the card, with nothing about it visible from inside Edit
// itself ("I don't see any controls for the user to set the timer"). Lives
// in the item-mode header rather than the per-layer props panel below
// because it's a property of the SEGMENT, not of whichever text/image
// layer happens to be selected (or unselected) on the canvas right now.
function renderItemTimerControls() {
  const host = document.getElementById('ts-item-timer-header');
  if (!host) return;
  const item = tsItemCtx?.item;
  const isTimer = item?.type === 'timer';
  host.classList.toggle('hidden', !isTimer);
  host.innerHTML = '';
  if (!isTimer) return;

  const params = item.trigger?.params || {};
  const mode = params.mode === 'duration' ? 'duration' : 'endAt';

  // One label and one control per row, as in any inspector: how it counts
  // down, then its length or its end time, then the colours it turns.
  const modeSel = makeSelect([
    { label: 'For a length of time', value: 'duration' },
    { label: 'To a time of day', value: 'endAt' },
  ], mode, (v) => {
    // A countdown with no length yet starts at ten minutes, so choosing a
    // length always leaves a timer that runs.
    const unset = !(item.trigger?.params?.durationSec > 0);
    save(v === 'duration' && unset ? { mode: v, durationSec: 600 } : { mode: v });
    renderItemTimerControls(); renderPreview();
  });

  let valueRow;
  if (mode === 'duration') {
    // Saved when the number is done ('change'), not on each keystroke — a
    // live countdown would otherwise be re-timed to "1" on the way to "15".
    const length = numField('Length', params.durationSec ? Math.round(params.durationSec / 60) : '', {
      min: 1, max: 600, unit: 'min', placeholder: '10', title: 'Minutes', onChange: () => {},
    });
    length.querySelector('input').addEventListener('change', (e) => {
      const min = parseFloat(e.target.value);
      if (min > 0) { save({ mode: 'duration', durationSec: Math.round(min * 60) }); renderPreview(); }
    });
    valueRow = fieldRow([length], { cols: 2 });
  } else {
    // Plain validated text, not <input type="time"> — WebKit's native time
    // control (Tauri's real webview on macOS) can show a complete-looking
    // value while .value still reads back empty until every sub-segment is
    // explicitly confirmed, which silently defeated this exact field. Same
    // fix as the Quick-edit popover in service.js — which now also accepts
    // 12-hour input (see resolveFlexibleTime there for the full reasoning);
    // duplicated here rather than imported, per this codebase's usual
    // per-file convention.
    const timeInp = document.createElement('input');
    timeInp.type = 'text'; timeInp.placeholder = 'e.g. 9:30 AM'; timeInp.maxLength = 11;
    timeInp.className = 'ts-prop-input';
    timeInp.setAttribute('aria-label', 'Ends at');
    // Shown the way this computer shows times ("9:30 AM", or "09:30").
    timeInp.value = params.endAtTime ? clockTime(params.endAtTime) : '';
    timeInp.addEventListener('input', () => {
      if (/^[0-9:]*$/.test(timeInp.value)) {
        const digits = timeInp.value.replace(/\D/g, '').slice(0, 4);
        timeInp.value = digits.length > 2 ? `${digits.slice(0, 2)}:${digits.slice(2)}` : digits;
      }
    });
    timeInp.addEventListener('change', () => {
      const resolved = resolveFlexibleTime(timeInp.value);
      if (resolved) { save({ mode: 'endAt', endAtTime: resolved }); timeInp.value = clockTime(resolved); renderPreview(); }
    });
    valueRow = prop('Ends at', timeInp, { cols: 2 });
  }

  // Warning / overtime colours — the countdown recolours through these as it
  // runs down (last minute → warning, past zero → overtime). The base colour
  // is the timer text layer's own colour, edited on the canvas like any layer.
  const timerLayer = (resolveItemBaseLook(item)?.layers || []).find(l => l.binding === 'timer');
  const colors = fieldRow([
    swatchField('Last minute', params.warnColor || timerLayer?.warnColor || '#e8a64a', (v) => save({ warnColor: v }), 'The countdown turns this colour for its final minute'),
    swatchField('Overtime', params.overtimeColor || timerLayer?.overtimeColor || '#e8404a', (v) => save({ overtimeColor: v }), 'The colour once it passes zero and counts up'),
  ]);
  host.appendChild(section('item', 'Timer', prop('Counts down', modeSel), valueRow, colors));

  // Scenes (segment.scenes — a storyboard, see segments.js) are managed
  // as real SLIDES in the Slides panel to the left (renderItemSlidesList/
  // addTimerSlide) — one thumbnail per scene, click to edit its layers,
  // "+ Add Slide" to add another; how they share the countdown is here.
  if (item.scenes && item.scenes.length) renderScenePaceControls(host, item);

  // Local echo so the field reflects the change immediately even before
  // the PUT round-trips — item.trigger is the same live segmentList
  // reference getTimerItem handed out, so this mutation is visible to
  // anything else reading item.trigger.params too (e.g. re-opening Quick
  // edit on this same segment without a full reload in between).
  function save(patch) {
    item.trigger = item.trigger || { params: {} };
    item.trigger.params = { ...item.trigger.params, ...patch };
    window.KairoService.updateSegmentParams(item.id, item.trigger.params);
    // If this segment is the one live on the output, push the change now
    // (warn/overtime colour, or a re-timed countdown) instead of making the
    // operator stop and restart it.
    if (patch.warnColor || patch.overtimeColor) {
      setTimeout(() => window.KairoService?.resendLiveTimer?.(), 150);
    }
  }
}
// How a timer's slides share its countdown (segment.scenePace — see
// KairoMotion.sceneAt). "Countdown sets the pace": every slide gets an equal
// share of the time, so a shorter countdown moves faster; a long one repeats
// the set so no slide outstays "Longest on screen"; the finale holds the last
// slide for the final minute. "Each slide's own time" is the original
// behaviour: the seconds on each slide's row, in order, then hold.
function renderScenePaceControls(host, item) {
  const M = window.KairoMotion;
  if (!M) return;
  const pace = M.normalizePace(item.scenePace);
  // Sliders save without rebuilding the panel (it would drop the drag);
  // chips and toggles rebuild it so dependent rows appear or go.
  const savePace = (patch, rerender) => {
    item.scenePace = { ...M.normalizePace(item.scenePace), ...patch };
    window.KairoService?.saveScenePace?.(item);
    if (rerender) { renderItemTimerControls(); renderItemSlidesList(); }
    else readout.textContent = paceReadout();
  };
  const totalSec = item.trigger?.params?.mode === 'duration' ? Number(item.trigger.params.durationSec) || 0 : 0;
  const paceReadout = () => {
    const p = M.normalizePace(item.scenePace);
    if (p.mode !== 'countdown') return 'Each slide stays for the seconds on its own row.';
    if (!totalSec) return 'Paced by the time left when the countdown starts.';
    const first = M.sceneAt(item.scenes, p, 0, totalSec * 1000);
    const per = Math.round(first.slotMs / 1000);
    const finale = p.finaleSec > 0 && item.scenes.length > 1;
    return `About ${per} s per slide on this ${Math.round(totalSec / 60)}-minute countdown`
      + (finale ? `, then “${item.scenes[item.scenes.length - 1].name || 'the last slide'}” to finish.` : '.');
  };
  const note = document.createElement('p');
  note.className = 'setting-hint';
  note.style.margin = '0';
  note.textContent = `${item.scenes.length} slide${item.scenes.length === 1 ? '' : 's'}, in order — add, remove and reorder them in the list on the left.`;
  const rows = [note, prop('Pace', makeSelect([
    { label: 'The countdown sets it', value: 'countdown' },
    { label: 'Each slide\'s own time', value: 'fixed' },
  ], pace.mode, v => savePace({ mode: v }, true)))];
  if (pace.mode === 'countdown') {
    rows.push(fieldRow([
      numField('Longest', pace.maxSec, { min: 5, max: 120, unit: 's', title: 'The longest any slide stays up', onChange: v => { if (v) savePace({ maxSec: v }); } }),
      toggleField('Finale', pace.finaleSec > 0, v => savePace({ finaleSec: v ? 60 : 0 }, true), 'The last slide holds the final minute'),
    ]));
  }
  rows.push(fieldRow([makeSelect([
    { label: 'Blur between slides', value: 'blur' }, { label: 'Fade between slides', value: 'fade' }, { label: 'Cut between slides', value: 'cut' },
  ], pace.transition, v => savePace({ transition: v }, true))]));
  const readout = document.createElement('p');
  readout.className = 'setting-hint';
  readout.style.margin = '0';
  readout.textContent = paceReadout();
  rows.push(readout);
  host.appendChild(section('item', 'Slides', ...rows));
}

document.getElementById('ts-item-theme-picker-btn')?.addEventListener('click', (e) => {
  if (!tsItemCtx) return;
  window.KairoService.openThemePopover(e.currentTarget, tsItemCtx.item);
});

// Small duplicate of service.js's themeForItem resolution logic (item.themeId
// lookup, else the primary output's assigned theme, else the first theme) —
// matches this codebase's existing precedent of each context owning its own
// small layer-renderer/resolver rather than cross-file exporting one.
function resolveItemBaseLook(item) {
  const explicit = item.themeId ? looks.find(l => l.id === item.themeId) : null;
  if (explicit) return explicit;
  // A fresh timer segment has no themeId yet, and falling through to the
  // output's own assigned theme (built for verse/reference bindings) meant
  // Edit opened on a blank canvas with nothing showing what the countdown
  // would even look like. 'timer-big' always exists (a DEFAULT_LOOKS
  // entry, never deletable) so this never itself falls through to null.
  if (item.type === 'timer') return looks.find(l => l.id === 'timer-big') || primaryOutputLook() || looks[0] || null;
  return primaryOutputLook() || looks[0] || null;
}

// Builds the synthetic "look" item mode points activeLook at: a deep clone
// of the item's real base theme, namespaced so it can never collide with an
// actual theme id, with this specific slide's stored overrides (if any)
// merged field-by-field onto each text layer — a partial override (say, just
// font.size) must not blow away the rest of the base theme's settings.
// Media Bin support (index.html/service.js) — "set as background" doesn't
// touch the theme itself, it stores {src,kind} in the SAME per-slide
// override bag slideStyles already is (bgMedia is just one more field
// alongside __customLayers), then this prepends a real layer for it at
// render time and drops the theme's own flat background so the media
// actually shows instead of being covered by an opaque canvas fill drawn
// after it. Reuses the video-aware image-layer rendering already built for
// theme "image" layers (isVideoLayerSrc) — a background picked from the
// bin can be a video just as validly as a static image.
function applyBgMediaOverride(layers, bgMedia) {
  if (!bgMedia?.src) return layers;
  const synthetic = {
    id: '__bg-media', type: 'image', name: 'Background (Media Bin)', visible: true,
    src: bgMedia.src, fit: 'cover', opacity: 100, radius: 0,
    pos: { x: 0, y: 0, w: TS_DESIGN_W, h: TS_DESIGN_H },
  };
  return [synthetic, ...layers.filter(l => l.type !== 'background')];
}

function buildSyntheticLook(item, slideIndex) {
  // A timer item's scenes (segment.scenes — its slide storyboard) have no
  // shared base theme to diff against at all: each one IS a whole,
  // standalone layer set, same as a real theme is. So this is a straight
  // clone of that scene's own layers, not the base-theme-plus-per-slide-
  // override merge below — writeItemSlideStyleFromSynthetic's own scenes
  // branch is the reciprocal save path.
  if (item.type === 'timer' && item.scenes && item.scenes.length) {
    const scene = item.scenes[slideIndex] || item.scenes[0];
    return { id: `scene:${item.id}:${slideIndex}`, layers: deepClone(scene?.layers || []) };
  }
  // Same idea for a 'slides' item's own scene blocks (a ProPresenter
  // import preserved as-authored — see slidesFor's 'slides' case) — its
  // layers live directly on the block, not a separate item.scenes array.
  if (item.type === 'slides' && item.blocks?.[slideIndex]?.layers) {
    return { id: `scene:${item.id}:${slideIndex}`, layers: deepClone(item.blocks[slideIndex].layers) };
  }
  const base = resolveItemBaseLook(item);
  const clone = deepClone(base) || { layers: [] };
  clone.id = `item-edit:${item.id}:${slideIndex}`;
  const overrides = item.slideStyles?.[slideIndex] || {};
  clone.layers = applyBgMediaOverride(clone.layers || [], overrides.bgMedia);
  (clone.layers || []).forEach(layer => {
    const ov = overrides[layer.id];
    if (!ov) return;
    // Was gated to text-only, same reason/fix as writeItemSlideStyleFromSynthetic's
    // matching guard above it (see that comment) — pos/opacity/fit/radius/
    // visible now apply to any layer type; font/shadow/outline/align/color
    // stay meaningful only for text since that's the only override shape
    // that ever gets computed for a non-text layer to begin with.
    if (ov.pos) layer.pos = { ...ov.pos };
    if (ov.font) layer.font = { ...layer.font, ...ov.font };
    if (ov.align) layer.align = ov.align;
    if (ov.color) layer.color = ov.color;
    if (ov.opacity !== undefined) layer.opacity = ov.opacity;
    if (ov.shadow) layer.shadow = { ...layer.shadow, ...ov.shadow };
    if (ov.outline) layer.outline = { ...layer.outline, ...ov.outline };
    if (ov.fit) layer.fit = ov.fit;
    if (ov.radius !== undefined) layer.radius = ov.radius;
    if (ov.graphic) layer.graphic = deepClone(ov.graphic);
    // Rotation, accent colour, photo look, a background's fill, build-in and
    // idle motion — the same merge every renderer does (layer_geometry.js).
    Object.assign(layer, withLayerOverride(layer, ov, [...LAYER_OVERRIDE_KEYS, ...(layer.type === 'background' ? FILL_OVERRIDE_KEYS : [])]));
    LAYER_OVERRIDE_KEYS.forEach(k => { if (ov[k] === null) delete layer[k]; });
    ['build', 'idle'].forEach(k => {
      if (ov[k] === null) delete layer[k];
      else if (ov[k] !== undefined) layer[k] = deepClone(ov[k]);
    });
    if (ov.visible === false) layer.visible = false;
  });
  // Item/slide-specific layers the operator added in Full-scale edit — not
  // part of the theme, so they're stored whole (see writeItemSlideStyleFromSynthetic)
  // rather than diffed. Appended last so they paint on top, matching Theme
  // Studio's own "new layer always goes on top" convention — reordered next
  // if this slide has its own saved z-order.
  (overrides.__customLayers || []).forEach(l => clone.layers.push(deepClone(l)));
  if (overrides.__layerOrder) clone.layers = applyLayerOrder(clone.layers, overrides.__layerOrder);
  return clone;
}

// ── Item mode's left panel: this item's slides instead of the themes list ──
// Renders into the same #looks-list container renderLooksList() uses — the
// two are mutually exclusive by mode, never both rendered for the same open
// modal, so reusing the element is simpler than adding a parallel one.
function renderItemSlidesList() {
  const el = document.getElementById('looks-list');
  if (!el || !tsItemCtx || !window.KairoService) return;
  el.innerHTML = '';
  const { item, slideIndex, baseLook } = tsItemCtx;
  const slides = window.KairoService.slidesFor(item);
  const isScenes = item.type === 'timer' && item.scenes && item.scenes.length;
  slides.forEach((s, i) => {
    const row = document.createElement('div');
    row.className = 'ts-item-slide-row'
      + (i === slideIndex ? ' active' : '')
      + (window.KairoService.isSlideSelected(i) ? ' selected' : '');

    const thumb = document.createElement('div');
    thumb.className = 'ts-item-slide-thumb';
    if (s.image) {
      thumb.style.backgroundImage = `url('${s.image}')`;
      thumb.style.backgroundSize = 'cover';
      thumb.style.backgroundPosition = 'center';
    } else {
      // paintLookLayers reads host.clientWidth to compute its scale — thumb
      // is still detached here, so clientWidth would read 0 and fall back
      // to a hardcoded 640px guess, rendering text far too large for this
      // 64px-wide thumbnail (same bug already fixed for stack-card previews
      // via __pendingPaint). Tag it and paint in one pass after every row is
      // attached below, instead of forcing a per-thumb synchronous reflow.
      thumb.__pendingPaint = { s, i };
    }
    row.appendChild(thumb);

    // A scene slide's "player" setting — how long the live countdown shows
    // it before advancing to the next one — lives right on its own row,
    // the same place PowerPoint keeps a slide's advance timing next to the
    // slide itself rather than in a separate list somewhere else. Timer-
    // specific: a 'slides' item's own scene slides (a ProPresenter import
    // preserved as-authored, see slidesFor's 'slides' case) have no
    // item.scenes array or duration concept at all — s.isScene alone isn't
    // enough to gate this, item.type must be 'timer' too.
    const isTimerScene = item.type === 'timer' && s.isScene;
    if (isTimerScene) {
      const durRow = document.createElement('div');
      durRow.className = 'ts-item-slide-duration';
      // When the countdown sets the pace, a slide's own seconds don't apply.
      const countdownPaced = item.scenePace?.mode === 'countdown';
      if (countdownPaced) durRow.style.display = 'none';
      const durInp = document.createElement('input');
      durInp.type = 'number'; durInp.min = '1';
      durInp.value = s.durationSec || '';
      durInp.title = 'Seconds this slide stays on screen';
      durInp.addEventListener('click', (e) => e.stopPropagation());
      durInp.addEventListener('change', () => {
        const n = parseFloat(durInp.value);
        if (n > 0) { item.scenes[s.sceneIndex].durationSec = Math.round(n); window.KairoService.saveTimerScenes(item); }
      });
      durRow.appendChild(durInp);
      const durLbl = document.createElement('span');
      durLbl.textContent = 's';
      durRow.appendChild(durLbl);
      row.appendChild(durRow);

      const delBtn = document.createElement('button');
      delBtn.className = 'ts-item-slide-delete';
      delBtn.title = 'Delete slide';
      delBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';
      delBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        if (item.scenes.length <= 1) return; // a timer slide with scenes always keeps at least one
        item.scenes.splice(s.sceneIndex, 1);
        window.KairoService.saveTimerScenes(item);
        if (slideIndex >= item.scenes.length) tsItemCtx.slideIndex = item.scenes.length - 1;
        selectItemSlide(tsItemCtx.slideIndex);
      });
      row.appendChild(delBtn);
    }

    // Cmd/Ctrl+Click toggle / Shift+Click range-select — same gesture as
    // Quick Edit and the Stack/Grid view, via the shared selection state
    // service.js owns. A plain click clears the selection and picks this
    // slide, same as always.
    row.addEventListener('click', (e) => {
      if (e.metaKey || e.ctrlKey || e.shiftKey) {
        window.KairoService.handleSlideRowClick(i, e, renderItemSlidesList);
        return;
      }
      window.KairoService.clearSlideSelection();
      selectItemSlide(i);
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      const sections = [];
      const editGroup = [];
      if (isTimerScene) {
        editGroup.push({ label: 'Duplicate', onClick: () => duplicateTimerScene(item, s.sceneIndex) });
      } else if (window.KairoService.canDuplicateSlide(item, s)) {
        editGroup.push({ label: 'Duplicate', onClick: () => window.KairoService.duplicateSlide(item, i) });
      }
      const selection = window.KairoService.selectedSlideIndices.size
        ? window.KairoService.selectedSlideIndices : new Set([i]);
      if (!isTimerScene && window.KairoService.anySlidesDuplicable(item, selection)) {
        editGroup.push({
          label: selection.size > 1 ? `Copy ${selection.size} slides` : 'Copy',
          onClick: () => window.KairoService.copySlides(item, selection),
        });
      }
      if (!isTimerScene && window.KairoService.slideClipboard && item.type === 'slides') {
        editGroup.push({ label: 'Paste', onClick: () => window.KairoService.pasteSlides(item, i) });
      }
      if (editGroup.length) sections.push(editGroup);
      // Delete was missing entirely from this menu — the Stack/Grid view's
      // own slide right-click (slideCard, service.js) already has it as
      // its own danger-styled section; this thumbnail list had nothing
      // beyond the scene case's small standalone X button, so a regular
      // (non-timer) slide couldn't be deleted from Full-scale edit's own
      // Slides panel at all without leaving to the Stack view first.
      if (isTimerScene) {
        sections.push([{
          label: 'Delete', danger: true, disabled: item.scenes.length <= 1,
          onClick: () => {
            if (item.scenes.length <= 1) return; // always keep at least one
            item.scenes.splice(s.sceneIndex, 1);
            window.KairoService.saveTimerScenes(item);
            if (slideIndex >= item.scenes.length) tsItemCtx.slideIndex = item.scenes.length - 1;
            selectItemSlide(tsItemCtx.slideIndex);
          },
        }]);
      } else {
        sections.push([{
          label: selection.size > 1 ? `Delete ${selection.size} slides` : 'Delete this slide',
          danger: true,
          onClick: () => window.KairoService.bulkDeleteSlides(item, selection),
        }]);
      }
      if (sections.length) window.KairoService.openContextMenu(e.clientX, e.clientY, sections);
    });
    el.appendChild(row);
  });

  el.querySelectorAll('.ts-item-slide-thumb').forEach(thumb => {
    const pending = thumb.__pendingPaint;
    if (!pending) return;
    const { s, i } = pending;
    // A scene slide has no shared base theme to diff against — its own
    // layers are the whole thing, same as a real theme's are (see
    // buildSyntheticLook's own scenes branch for why editing works the
    // same way). Every other item type keeps the base-theme + per-slide-
    // override painting it always had. `s.layers` (a 'slides' item's own
    // scene slide — see slidesFor's 'slides' case — carries its layers
    // directly, no separate item.scenes array to index into the way Timer
    // needs) is checked first; Timer's own item.scenes lookup is the
    // fallback for its differently-shaped isScene slides.
    const look = s.isScene ? { layers: s.layers || item.scenes?.[s.sceneIndex]?.layers || [] } : baseLook;
    const style = s.isScene ? {} : (item.slideStyles?.[i] || {});
    window.KairoService.paintLookLayers(thumb, look, style, {
      verseText: s.text, referenceText: s.reference || '', translatedText: '',
    }, { hideReference: true });
  });

  // Added last, after paintLookLayers' host.innerHTML = '' pass above — doing
  // this any earlier would just get wiped out along with everything else it
  // clears on text slides (image slides don't hit that path, but running
  // this uniformly afterward for every thumb is simpler than branching).
  el.querySelectorAll('.ts-item-slide-thumb').forEach((thumb, i) => {
    const label = document.createElement('span');
    label.className = 'ts-item-slide-label';
    label.textContent = String(i + 1) + '.';
    thumb.appendChild(label);
  });

  // "+ Add Slide" — a Timer segment's own affordance for building a
  // storyboard, right where the slides it creates will actually show up.
  // Available on every timer item, not just ones already using scenes:
  // the first click converts today's single placeholder slide into
  // scene 0 (carrying over whatever theme/background it already had, so
  // nothing already configured is lost) and adds a fresh scene 1 after it.
  if (item.type === 'timer') {
    const addBtn = document.createElement('button');
    addBtn.className = 'ts-item-add-slide-btn';
    addBtn.textContent = '+ Add Slide';
    // A blank countdown slide, or one of the Announcements designs with the
    // countdown on it (the pre-service loop's own slides, Ways to Give and
    // Bible Study included — the built-in Preservice leaves out the ones
    // that need the church's own details until someone adds them here).
    addBtn.addEventListener('click', () => {
      const pack = window.KairoAnnouncements;
      const r = addBtn.getBoundingClientRect();
      const designs = pack ? pack.slides().map(s => ({ label: s.name, onClick: () => addTimerSlide(item, pack.preserviceScene(s.id)) })) : [];
      window.KairoService.openContextMenu(r.left, r.bottom + 4, [
        [{ label: 'Blank slide with the countdown', onClick: () => addTimerSlide(item) }],
        ...(designs.length ? [designs] : []),
      ]);
    });
    el.appendChild(addBtn);
  }
}

// A fresh slide starts with one full-bleed background (a bundled picture) and
// a centered Countdown, matching timer-big's own defaults — a real, visible
// starting point rather than a blank canvas with nothing to select. The
// operator's own Image Cycle layer(s)/captions get added from inside the
// slide editor the same way any theme's do (the "Cycle"/Text/Image
// buttons in Theme Studio's add-content bar).
function defaultSceneLayers() {
  return [
    poolCanvas('midnight'),
    { id: 'timer', type: 'text', name: 'Countdown', visible: true, binding: 'timer', customText: '',
      pos: { x: 160, y: 380, w: 1600, h: 320 },
      font: { family: 'Manrope', size: 180, weight: 800, italic: false, lineHeight: 1, letterSpacing: 0, transform: 'none' },
      color: '#ffffff', opacity: 100, align: 'center',
      shadow: { ...TXT_SHADOW_SOFT }, outline: { ...NO_OUTLINE } },
  ];
}
function addTimerSlide(item, template = null) {
  if (!item.scenes || !item.scenes.length) {
    // Carry over whatever the segment's single slide already had (a real
    // theme, custom layers) as scene 0, rather than discarding it the
    // moment scenes mode turns on.
    const base = resolveItemBaseLook(item);
    const first = deepClone(base?.layers || defaultSceneLayers());
    // The item's own custom text-layer overrides (position/font/etc.,
    // stored in slideStyles[0] up to now) apply on top, same field-by-field
    // merge buildSyntheticLook already does for the diff-based case —
    // otherwise anything already customized here would silently vanish
    // the moment this becomes scene 0's own standalone layers.
    const overrides = item.slideStyles?.[0] || {};
    first.forEach(layer => {
      if (layer.type !== 'text') return;
      const ov = overrides[layer.id];
      if (!ov) return;
      if (ov.pos) layer.pos = { ...ov.pos };
      if (ov.font) layer.font = { ...layer.font, ...ov.font };
      if (ov.align) layer.align = ov.align;
      if (ov.color) layer.color = ov.color;
      if (ov.opacity !== undefined) layer.opacity = ov.opacity;
      if (ov.shadow) layer.shadow = { ...layer.shadow, ...ov.shadow };
      if (ov.outline) layer.outline = { ...layer.outline, ...ov.outline };
      if (ov.visible === false) layer.visible = false;
    });
    item.scenes = [{ id: 'scene-' + Date.now(), name: item.name || 'Slide 1', durationSec: 60, layers: first }];
  }
  const scene = template
    ? { ...deepClone(template), id: 'scene-' + (Date.now() + 1) }
    : { id: 'scene-' + (Date.now() + 1), name: `Slide ${item.scenes.length + 1}`, durationSec: 60, layers: defaultSceneLayers() };
  // The pre-service loop ends on Service Begins, which holds the final
  // minute — a new slide goes in before it, so it stays the finale. (Loops
  // made before scenes carried `finale` are known by the finale's id.)
  const isFinale = (sc) => !!sc && (sc.finale || /^scene-begins-/.test(sc.id || ''));
  const last = item.scenes[item.scenes.length - 1];
  const beforeFinale = isFinale(last) && !isFinale(template);
  const at = beforeFinale ? item.scenes.length - 1 : item.scenes.length;
  item.scenes.splice(at, 0, scene);
  window.KairoService.saveTimerScenes(item);
  renderItemSlidesList();
  selectItemSlide(at);
}
function duplicateTimerScene(item, index) {
  const src = item.scenes[index];
  if (!src) return;
  const copy = deepClone(src);
  copy.id = 'scene-' + Date.now();
  copy.name = `${src.name || 'Slide'} copy`;
  item.scenes.splice(index + 1, 0, copy);
  window.KairoService.saveTimerScenes(item);
  renderItemSlidesList();
  selectItemSlide(index + 1);
}

// Mirrors selectLook()'s fan-out (swap the data-source, reset history, then
// the same five renders) — the established idiom in this file for "point
// the whole engine at something else."
function selectItemSlide(index) {
  if (!tsItemCtx) return;
  tsCommitActiveEdit(null);
  tsItemCtx.slideIndex = index;
  resetItemHistory();
  activeLayer = null; multiSelectedLayerIds.clear();
  activeLook = buildSyntheticLook(tsItemCtx.item, index);
  renderItemSlidesList(); renderLayersList(); renderPreview(); renderProps();
}

// ── Item mode open/close (mirrors openThemeStudio/closeThemeStudio above) ──
function openItemStyleEditor(itemId, slideIndex = 0) {
  // Timer segments aren't playlist items — they live in server/segments.js,
  // not service.items — so they don't show up in the normal lookup at all.
  // getTimerItem adapts one into the same {id, type, themeId, slideStyles}
  // shape a real item has (see service.js), which is all this editor and
  // slidesFor/themeForItem actually require; everything downstream (undo,
  // autosave, theme resolution) then runs completely unmodified.
  const item = window.KairoService?.service?.items.find(i => i.id === itemId)
    || window.KairoService?.getTimerItem?.(itemId);
  if (!item) return;
  tsMode = 'item';
  tsItemCtx = { item, slideIndex, baseLook: resolveItemBaseLook(item) };
  document.querySelector('.main-layout')?.classList.add('hidden-el');
  document.getElementById('service-view')?.classList.add('hidden');
  looksModal?.classList.remove('hidden');
  toggleItemModeChrome(true);
  resetItemHistory();
  activeLayer = null; multiSelectedLayerIds.clear();
  activeLook = buildSyntheticLook(item, slideIndex);
  renderItemSlidesList(); renderLayersList(); renderProps();
  // Render after layout settles so the stage has real dimensions — same
  // reason openThemeStudio defers its own first paint.
  requestAnimationFrame(() => renderPreview());
}
function closeItemStyleEditor() {
  // Called unconditionally from showCenterView() on every top-nav tab
  // switch (mirroring window.KairoThemeStudio.close's own call site) — must
  // be a safe no-op when item mode isn't actually open, otherwise it would
  // reset activeLook/activeLayer and clobber whatever theme the operator
  // has open in ordinary Theme Studio.
  if (tsMode !== 'item') return;
  looksModal?.classList.add('hidden');
  toggleItemModeChrome(false);
  document.querySelector('.main-layout')?.classList.remove('hidden-el');
  tsMode = 'theme';
  tsItemCtx = null;
  activeLook = looks[0];
  activeLayer = null; multiSelectedLayerIds.clear();
  resetThemeHistory(); // otherwise item mode's undo stack would carry over onto whichever theme this lands back on
}

// Exposed so service.js's sectionCard() icon and showCenterView() (top-nav
// tab switch) can open/close this — same pattern as window.KairoThemeStudio.
// Called by service.js's refreshAfterSlideEdit after any slide-level
// duplicate/copy/paste/bulk-delete — item.blocks may have shifted under
// whichever slide index was open, so the synthetic look and both left/right
// panels need rebuilding from scratch, same as switching slides normally.
// A safe no-op when Full-scale edit isn't open, or open for a different item.
function refreshItemStyleEditorSlides(itemId) {
  if (tsMode !== 'item' || !tsItemCtx || tsItemCtx.item.id !== itemId) return;
  const slides = window.KairoService.slidesFor(tsItemCtx.item);
  tsItemCtx.slideIndex = Math.max(0, Math.min(tsItemCtx.slideIndex, slides.length - 1));
  activeLayer = null; multiSelectedLayerIds.clear();
  activeLook = buildSyntheticLook(tsItemCtx.item, tsItemCtx.slideIndex);
  renderItemSlidesList(); renderLayersList(); renderPreview(); renderProps();
}
// Called by service.js's openThemePopover after the operator picks a new
// theme (or "Output default") for this item from the right-panel button
// above — item.themeId changing means resolveItemBaseLook(item) now
// resolves differently, so baseLook itself needs re-resolving too, not just
// the slide/synthetic-look rebuild refreshItemStyleEditorSlides already does.
function refreshItemStyleEditorTheme(itemId) {
  if (tsMode !== 'item' || !tsItemCtx || tsItemCtx.item.id !== itemId) return;
  tsItemCtx.baseLook = resolveItemBaseLook(tsItemCtx.item);
  updateItemThemeLabel();
  refreshItemStyleEditorSlides(itemId);
}
window.KairoItemStyleEditor = {
  open: openItemStyleEditor,
  close: closeItemStyleEditor,
  isOpen: () => tsMode === 'item',
  getItem: () => tsItemCtx?.item || null,
  refreshSlides: refreshItemStyleEditorSlides,
  refreshTheme: refreshItemStyleEditorTheme,
  addMediaToCurrentSlide,
};

// A tab like Bible/Slides/Songs/Media, not a toggle — leaving happens by
// clicking a different top-nav tab (which calls closeThemeStudio via
// window.KairoThemeStudio, see service.js's showCenterView), not by
// re-clicking this same button or a separate "Back" control.
looksBtn?.addEventListener('click', openThemeStudio);

// Exposed so service.js's showCenterView() can close this out when the
// operator switches to Bible/Slides/Songs/Media — the top nav is the one
// master controller for the whole body, Theme Studio included.
window.KairoThemeStudio = {
  close: closeThemeStudio,
  isOpen: () => !looksModal?.classList.contains('hidden'),
};

// Esc steps back one level, like a design tool: an open Motion or Background
// gallery closes, then a selection is let go (the way out from under a
// full-canvas layer picked in the Layers panel), and only with nothing
// selected does it return to the dashboard. Not while a text field has
// focus. Item mode reuses this same modal, so it routes to its own close
// function.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || looksModal?.classList.contains('hidden')) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  if (galleryEl) { e.preventDefault(); closeGallery(); return; }
  if (activeLayer || multiSelectedLayerIds.size) {
    e.preventDefault();
    activeLayer = null;
    multiSelectedLayerIds = new Set();
    renderLayersList();
    renderProps();
    renderPreview();
    return;
  }
  if (tsMode === 'item') closeItemStyleEditor(); else closeThemeStudio();
});

// Select-all/copy/paste for layers — the same gesture as copying files or
// text, applied to a theme's layer stack. Copy works on whatever's selected
// (select-all's whole set, or otherwise just the single clicked layer);
// paste always lands in whichever theme is currently open, so this is how a
// layer moves from one theme into another — build a look from pieces of
// others instead of only ever duplicating a whole theme.
// Disabled entirely in item mode: a pasted layer has no counterpart on the
// base theme to diff against, so it could never be written into
// item.slideStyles — there's nothing sensible for paste to do there.
// Extracted into standalone functions so both the keydown shortcut below and
// the layer row's right-click menu (renderLayersList) call one
// implementation each, not two.
function selectAllLayers() {
  multiSelectedLayerIds = new Set(activeLook.layers.map(l => l.id));
  renderLayersList();
}
function copyLayers() {
  const toCopy = multiSelectedLayerIds.size
    ? activeLook.layers.filter(l => multiSelectedLayerIds.has(l.id))
    : (activeLayer ? [activeLayer] : []);
  if (!toCopy.length) return;
  layerClipboard = deepClone(toCopy);
  toast(`Copied ${toCopy.length} layer${toCopy.length === 1 ? '' : 's'}`, 'success');
}
function pasteLayers() {
  if (!layerClipboard.length) return;
  const pasted = deepClone(layerClipboard).map((l, i) => {
    l.id = `layer-${Date.now()}-${i}-${Math.random().toString(36).slice(2, 7)}`;
    return l;
  });
  activeLook.layers.push(...pasted);
  multiSelectedLayerIds = new Set(pasted.map(l => l.id));
  activeLayer = pasted[pasted.length - 1];
  saveLooks();
  renderLayersList(); renderPreview(); renderProps(); renderThemeCanvasSizeSelect();
  toast(`Pasted ${pasted.length} layer${pasted.length === 1 ? '' : 's'}`, 'success');
}
document.addEventListener('keydown', (e) => {
  if (looksModal?.classList.contains('hidden') || !activeLook || tsMode === 'item') return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  if (!(e.metaKey || e.ctrlKey)) return;
  const key = e.key.toLowerCase();

  if (key === 'a') { e.preventDefault(); selectAllLayers(); }
  else if (key === 'c') { if (multiSelectedLayerIds.size || activeLayer) { e.preventDefault(); copyLayers(); } }
  else if (key === 'v') { if (layerClipboard.length) { e.preventDefault(); pasteLayers(); } }
  // Cmd/Ctrl+D — duplicate in place (Canva/Figma/Keynote's own shortcut for
  // this), same result as copy-then-paste but one keystroke: copyLayers
  // already snapshots the whole current selection, pasteLayers already
  // clones with fresh ids and selects the new copies.
  else if (key === 'd') { if (multiSelectedLayerIds.size || activeLayer) { e.preventDefault(); copyLayers(); pasteLayers(); } }
});

// Delete/Backspace for the selected layer(s) — same gesture as removing a
// file in Finder or a shape in Figma. Not folded into the Cmd/Ctrl block
// above since this needs no modifier key, and (unlike select-all/copy/paste)
// works in item mode too — deleteLayer already only allows that for a
// slide's own custom layers, never a theme layer, so no separate item-mode
// exclusion is needed here.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Delete' && e.key !== 'Backspace') return;
  if (looksModal?.classList.contains('hidden') || !activeLook) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  if (multiSelectedLayerIds.size) {
    e.preventDefault();
    const ids = [...multiSelectedLayerIds];
    multiSelectedLayerIds = new Set();
    activeLayer = null;
    ids.forEach(id => deleteLayer(activeLook.layers.find(l => l.id === id)));
  } else if (activeLayer) {
    e.preventDefault();
    deleteLayer(activeLayer);
  }
});

// Arrow keys nudge the current selection (single or multi — tsSelectedLayers)
// by 1 design px, Shift+Arrow by 10 — the same increments (and the same
// gesture) as PowerPoint/Keynote/Figma/Canva, for the exact positioning a
// drag alone can't reliably do. Works in item mode too, same as Delete —
// nudging is just a position edit, no different from typing into X/Y.
document.addEventListener('keydown', (e) => {
  const arrowDelta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
  if (!arrowDelta) return;
  if (looksModal?.classList.contains('hidden') || !activeLook) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  const layers = tsSelectedLayers();
  if (!layers.length) return;
  e.preventDefault();
  const step = e.shiftKey ? 10 : 1;
  const [dx, dy] = arrowDelta;
  layers.forEach(l => {
    const p = ensurePos(l);
    p.x += dx * step;
    p.y += dy * step;
  });
  up();
});

// Deselect on a click that lands outside any layer — the grey margin around
// the stage, or empty space within the stage itself not covered by a layer
// (e.g. padding around a text box). .ts-preview-wrap is a static element
// (not recreated per render, only the stage's own children are), so this is
// wired once here rather than re-attached on every renderPreview() call.
// Checks the click's literal target rather than relying on stopPropagation
// timing — layer elements stop propagation on 'mousedown', not 'click', so
// a same-type 'mousedown' listener here would still fire (a separate click
// event isn't blocked by a mousedown-phase stopPropagation) unless gated on
// exactly which element was actually hit.
document.querySelector('.ts-preview-wrap')?.addEventListener('mousedown', (e) => {
  const stage = tsStageEl();
  if (!activeLayer && !multiSelectedLayerIds.size && !tsActiveEdit) return;
  if (e.target !== e.currentTarget && e.target !== stage) return;
  tsCommitActiveEdit(null);
  activeLayer = null;
  multiSelectedLayerIds = new Set();
  renderLayersList();
  renderProps();
  renderPreview();
});

// Keep the preview honest when the window resizes — pxScale is derived from
// the live stage width.
window.addEventListener('resize', () => {
  if (!looksModal?.classList.contains('hidden')) renderPreview();
});

// ── Settings split view ───────────────────────────────────────────────────
// Left nav selects which category pane is shown on the right. Always opens
// on the FIRST nav item — previously remembered whichever pane was last
// viewed (persisted to localStorage), which meant Settings could open
// showing something like Content Studio at the far bottom of the list
// with no visible indication of where you actually were, instead of a
// predictable, consistent landing spot.
function showSettingsPane(key) {
  const nav = document.getElementById('settings-nav');
  const panes = document.getElementById('settings-panes');
  if (!nav || !panes) return;
  let matched = false;
  nav.querySelectorAll('.settings-nav-item').forEach(b => {
    const on = b.dataset.pane === key;
    b.classList.toggle('active', on);
    if (on) matched = true;
  });
  if (!matched) return;
  panes.querySelectorAll('.settings-pane').forEach(p =>
    p.classList.toggle('active', p.dataset.pane === key));
  panes.scrollTop = 0;
}

function showFirstSettingsPane() {
  const firstKey = document.querySelector('#settings-nav .settings-nav-item')?.dataset.pane;
  if (firstKey) showSettingsPane(firstKey);
}

(function initSettingsNav() {
  const nav = document.getElementById('settings-nav');
  if (!nav) return;
  nav.addEventListener('click', (e) => {
    const btn = e.target.closest('.settings-nav-item');
    if (btn) showSettingsPane(btn.dataset.pane);
  });
  showFirstSettingsPane();
})();

// ── Resizable vertical splitters (drag a divider to trade height between two
// stacked panes, size persisted per-splitter) ─────────────────────────────
// Shared by the Playlist/Transcript split (left sidebar) and the Theme
// Studio Themes/Layers split — same drag-resize behavior, only the target
// element, size bounds, and storage key differ.
function initVerticalSplitter({ splitterId, paneSelector, minTop, minBottom, storageKey }) {
  const splitter = document.getElementById(splitterId);
  const pane      = typeof paneSelector === 'string' && paneSelector.startsWith('#')
    ? document.getElementById(paneSelector.slice(1))
    : document.querySelector(paneSelector);
  if (!splitter || !pane) return;

  const saved = parseInt(localStorage.getItem(storageKey) || '', 10);
  if (saved > 0) pane.style.height = saved + 'px';

  let startY = 0, startH = 0, col = null;

  const onMove = (e) => {
    const maxH = col.clientHeight - splitter.offsetHeight - minBottom;
    const h = Math.max(minTop, Math.min(maxH, startH + (e.clientY - startY)));
    pane.style.height = h + 'px';
  };
  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    splitter.classList.remove('dragging');
    document.body.style.userSelect = '';
    localStorage.setItem(storageKey, String(pane.offsetHeight));
  };

  splitter.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return;
    e.preventDefault();
    col = splitter.parentElement;
    startY = e.clientY;
    startH = pane.offsetHeight;
    splitter.classList.add('dragging');
    document.body.style.userSelect = 'none';
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// Same trade-off as the Theme Studio panes: a long running order and a long
// transcript want opposite amounts of room, so let the operator decide.
initVerticalSplitter({
  splitterId: 'ls-splitter', paneSelector: '.ls-playlist-section',
  minTop: 110, minBottom: 140, storageKey: 'kairo-ls-playlist-h',
});

// Drag the divider to trade height between the two left-column panes. The
// chosen size persists so the operator's working layout survives a restart.
initVerticalSplitter({
  splitterId: 'ts-splitter', paneSelector: '#ts-pane-themes',
  minTop: 90, minBottom: 120, storageKey: 'kairo-ts-themes-h',
});

// Transition (Fade/Slide/Cut + speed) moved from a per-theme setting here
// to a display-level one — see the Monitoring panel's own quick picker
// (service.js) and display.html's outputAnimation. activeLook.animation/
// animationSpeed are no longer read anywhere; left as harmless unused
// fields on already-saved themes rather than migrating every stored look
// just to strip them.

// Add text layer
tsAddLayerBtn?.addEventListener('click', () => {
  if (!activeLook) return;
  const id = 'layer-' + Date.now();
  const newLayer = {
    id, type: 'text', name: 'Text', visible: true,
    binding: 'custom', customText: 'New text layer',
    font: { family: 'Manrope', size: 36, weight: 500, italic: false, lineHeight: 1.3, letterSpacing: 0, transform: 'none' },
    color: '#ffffff', opacity: 100, align: 'center',
    shadow: { enabled: false, color: '#000000', opacity: 70, blur: 8, x: 0, y: 2 },
    outline: { enabled: false, color: '#000000', width: 2 },
    // Explicit free-canvas box from the moment it's created — every OTHER
    // new layer (Add Shape, Add Image) already gets one; this was the one
    // left to fall back to a layout-preset rule instead (full canvas
    // width, centered, per the 'fullscreen' branch), which rendered and
    // dragged/resized completely differently from every other layer type
    // and from what its own selection handles implied.
    pos: { x: 460, y: 480, w: 1000, h: 0 },
  };
  activeLook.layers.push(newLayer);
  activeLayer = newLayer;
  // up() (not a bare render) so a brand-new layer is actually persisted
  // immediately — in item mode, switching slides right after adding one
  // must not silently drop it before any other edit triggers the first save.
  up();
  renderProps();
});

// Add shape layer — a positioned background rect (bar, panel, badge…)
document.getElementById('ts-add-shape-btn')?.addEventListener('click', () => {
  if (!activeLook) return;
  const newLayer = {
    id: 'shape-' + Date.now(), type: 'background', name: 'Shape', visible: true,
    fill: 'solid', color: '#e8404a', opacity: 90, color2: '#8a2128', angle: 135,
    radius: 8,
    pos: { x: 560, y: 800, w: 800, h: 120 },
  };
  activeLook.layers.push(newLayer);
  activeLayer = newLayer;
  // up() (not a bare render), same reason as the Text button — persist
  // immediately so switching slides right after adding one in Full-scale
  // edit doesn't silently drop it before any other edit triggers a save.
  up();
  renderProps();
});

// ── Image layers ──────────────────────────────────────────────────────────
// Images are stored inline as data URLs so a theme stays a single portable
// JSON file (export/import carries the artwork with it). Source files are
// downscaled to at most IMG_MAX_W so a 4000px photo can't blow past the
// settings-storage budget. PNG/WebP keep their alpha; everything else is
// re-encoded as JPEG, which is far smaller for photographs.
const IMG_MAX_W = 1920;

// The native file dialog behind "Add Image" (ts-image-file) is
// accept="image/*", but that's a hint, not an enforced filter — the
// operator can and does pick an actual video file through "All Files".
// Worse than the frozen-background bug this session already fixed
// (display.html rendering a real video src as a static background-image):
// here the file went through loadImageFile below, which decodes via
// `new Image()` — and WebKit (Tauri's renderer on macOS) will silently
// decode SOME video containers (.mov especially) as their first frame
// instead of firing img.onerror like a real image-only engine would. The
// canvas step then re-encodes just that one frame as a JPEG and the layer
// is saved as a genuinely still image — no error anywhere, no video data
// left to ever play. Real incident: a segment's "video" background turned
// out to be exactly this — a JPEG snapshot of frame 1. Checking file.type
// (the OS-reported MIME type, reliable even though accept="image/*" isn't
// enforced) BEFORE ever touching the image-decode path avoids this
// entirely, by routing an actual video file to loadVideoFile instead.
function isVideoFile(file) {
  if (file.type) return file.type.startsWith('video/');
  return /\.(mp4|webm|mov|m4v|ogv)$/i.test(file.name || '');
}

// Stores the file's own bytes untouched (no canvas re-encode — a canvas
// can only ever capture one still frame, which is exactly the bug this
// exists to avoid) as a data: URI, so isVideoLayerSrc (display.html/
// service.js/app.js's canvas) recognizes it and renders a real <video>
// element instead of a background-image div. Dimensions come from loading
// it into an offscreen <video> just long enough to read
// videoWidth/videoHeight — same reason loadImageFile captures w/h, so
// corner-drag resize has a real aspect ratio to lock onto.
// Unlike loadImageFile (downscaled to IMG_MAX_W below), a video can't be
// shrunk client-side without a real re-encode — so this caps raw file size
// instead. Without a cap, the base64 data: URI lands straight in `looks`
// and can push localStorage past quota on the next saveLooks() (see its
// own comment), silently breaking every future theme edit for the session.
const VIDEO_MAX_MB = 20;
function loadVideoFile(file) {
  return new Promise((resolve, reject) => {
    if (file.size > VIDEO_MAX_MB * 1024 * 1024) {
      reject(new Error(`Video too large (max ${VIDEO_MAX_MB}MB) — use a shorter clip or the Media Bin instead`));
      return;
    }
    const fr = new FileReader();
    fr.onerror = () => reject(new Error('read failed'));
    fr.onload = () => {
      const src = fr.result;
      const v = document.createElement('video');
      v.preload = 'metadata';
      v.onerror = () => resolve({ src, w: 0, h: 0 }); // still usable without a known aspect ratio
      v.onloadedmetadata = () => resolve({ src, w: v.videoWidth || 0, h: v.videoHeight || 0 });
      v.src = src;
    };
    fr.readAsDataURL(file);
  });
}

function loadImageFile(file) {
  return new Promise((resolve, reject) => {
    const fr = new FileReader();
    fr.onerror = () => reject(new Error('read failed'));
    fr.onload = () => {
      const img = new Image();
      img.onerror = () => reject(new Error('decode failed'));
      img.onload = () => {
        const scale = Math.min(1, IMG_MAX_W / img.naturalWidth);
        const w = Math.max(1, Math.round(img.naturalWidth  * scale));
        const h = Math.max(1, Math.round(img.naturalHeight * scale));
        const c = document.createElement('canvas');
        c.width = w; c.height = h;
        c.getContext('2d').drawImage(img, 0, 0, w, h);
        const keepAlpha = /png|webp|gif|svg/i.test(file.type);
        resolve({
          src: keepAlpha ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.86),
          w, h,
        });
      };
      img.src = fr.result;
    };
    fr.readAsDataURL(file);
  });
}

// Same decode/downscale/re-encode as loadImageFile, just sourced from a URL
// (the Media tab's library, e.g. /api/media/bin/file/xxx.jpg) instead of a
// freshly-picked File — used by the media-card "Add to Slide" context menu
// item. Re-encoding to a data URI (rather than storing item.url directly)
// keeps this consistent with every other image source in the app: the
// layer survives the source file later being renamed/moved/deleted from its
// smart folder or the bin, same as a picked file already does.
function loadImageFromUrl(url) {
  return fetch(url).then(r => {
    if (!r.ok) throw new Error('fetch failed');
    return r.blob();
  }).then(blob => new Promise((resolve, reject) => {
    const objectUrl = URL.createObjectURL(blob);
    const img = new Image();
    img.onerror = () => { URL.revokeObjectURL(objectUrl); reject(new Error('decode failed')); };
    img.onload = () => {
      URL.revokeObjectURL(objectUrl);
      const scale = Math.min(1, IMG_MAX_W / img.naturalWidth);
      const w = Math.max(1, Math.round(img.naturalWidth  * scale));
      const h = Math.max(1, Math.round(img.naturalHeight * scale));
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      c.getContext('2d').drawImage(img, 0, 0, w, h);
      const keepAlpha = /png|webp|gif|svg/i.test(blob.type);
      resolve({ src: keepAlpha ? c.toDataURL('image/png') : c.toDataURL('image/jpeg', 0.86), w, h });
    };
    img.src = objectUrl;
  }));
}

// Pushes a new image layer sourced from a media-library URL onto whatever
// activeLook currently is — identical to the Add Image button above (theme
// mode: the open theme; item mode: the current slide), just sourced from
// the media library instead of a file picker. No tsMode branching needed:
// up() already dispatches the right autosave for whichever mode is active,
// same as every other layer mutation in this file.
async function addMediaToCurrentSlide(url, nameHint) {
  if (!activeLook) return false;
  try {
    const { src, w, h } = await loadImageFromUrl(url);
    // True original pixel size whenever it actually fits the canvas — only
    // scale down if it wouldn't (a photo bigger than the whole 1920x1080
    // design canvas), never just because it's bigger than some arbitrary
    // "half the canvas" box. The ,1 cap still means never scaling UP past
    // 100% for a small image.
    const fit = Math.min(TS_DESIGN_W / w, TS_DESIGN_H / h, 1);
    const pw = Math.round(w * fit), ph = Math.round(h * fit);
    const layer = {
      id: 'image-' + Date.now(), type: 'image', name: (nameHint || 'Image').replace(/\.[^.]+$/, '').slice(0, 24),
      visible: true, src, fit: 'contain', opacity: 100, radius: 0,
      // The image's real aspect ratio (w/h already downscaled together by
      // loadImageFromUrl if huge, so the RATIO is still the true one even
      // though absolute pixels may be capped) — nothing on the layer used
      // to remember this after the initial box size, so a corner-drag
      // resize had nothing to lock onto and let the box's aspect drift
      // away from the image's own, which is what made a contain-fit image
      // look like it was zooming while being resized (see tsDragMove).
      naturalW: w, naturalH: h,
      pos: { x: Math.round((TS_DESIGN_W - pw) / 2), y: Math.round((TS_DESIGN_H - ph) / 2), w: pw, h: ph },
    };
    activeLook.layers.push(layer);
    activeLayer = layer;
    up();
    renderProps();
    return true;
  } catch {
    toast('Could not load that image', 'error');
    return false;
  }
}

// "Library" button — a lightweight thumbnail picker over the Media tab's
// bin + smart folders, so an operator can add one of their own church media
// files as a layer without leaving Theme Studio / Full-scale edit (the
// Media tab is a separate top-level view — switching to it would close this
// editor first, per showCenterView's "close it out rather than leaving it
// showing underneath" — so browsing has to happen from in here instead).
async function fetchAllMediaItems() {
  const items = [];
  try {
    const bin = await fetch('/api/media/bin').then(r => r.json());
    (bin.items || []).forEach(it => items.push(it));
  } catch {}
  try {
    const foldersRes = await fetch('/api/media/folders').then(r => r.json());
    for (const folder of (foldersRes.folders || [])) {
      try {
        const res = await fetch(`/api/media/folders/${folder.id}/items`).then(r => r.json());
        (res.items || []).forEach(it => items.push(it));
      } catch {}
    }
  } catch {}
  return items;
}

let mediaLibPickerEl = null;
function closeMediaLibraryPicker() { mediaLibPickerEl?.remove(); mediaLibPickerEl = null; }

async function openMediaLibraryPicker() {
  closeMediaLibraryPicker();
  const overlay = document.createElement('div');
  overlay.className = 'ts-media-picker-overlay';
  overlay.addEventListener('click', (e) => { if (e.target === overlay) closeMediaLibraryPicker(); });

  const panel = document.createElement('div');
  panel.className = 'ts-media-picker-panel';
  const header = document.createElement('div');
  header.className = 'ts-media-picker-header';
  header.innerHTML = '<span>Add from Media Library</span>';
  const closeBtn = document.createElement('button');
  closeBtn.className = 'modal-close-btn';
  closeBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 16 16"><path d="M3 3l10 10M13 3L3 13" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/></svg><span>Close</span>';
  closeBtn.addEventListener('click', closeMediaLibraryPicker);
  header.appendChild(closeBtn);
  panel.appendChild(header);

  const grid = document.createElement('div');
  grid.className = 'ts-media-picker-grid';
  grid.innerHTML = '<div class="svc-empty">Loading…</div>';
  panel.appendChild(grid);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  mediaLibPickerEl = overlay;

  const items = (await fetchAllMediaItems()).filter(it => it.kind === 'image');
  grid.innerHTML = '';
  if (!items.length) {
    grid.innerHTML = '<div class="svc-empty">No images in your Media Library yet.</div>';
    return;
  }
  items.forEach(item => {
    const card = document.createElement('button');
    card.className = 'media-card';
    const img = document.createElement('img');
    img.src = item.url;
    card.appendChild(img);
    const label = document.createElement('div');
    label.className = 'media-card-label';
    label.textContent = item.name;
    card.appendChild(label);
    card.addEventListener('click', async () => {
      card.disabled = true;
      const ok = await addMediaToCurrentSlide(item.url, item.name);
      if (ok) closeMediaLibraryPicker(); else card.disabled = false;
    });
    grid.appendChild(card);
  });
}

document.getElementById('ts-add-media-lib-btn')?.addEventListener('click', () => {
  if (!activeLook) return;
  openMediaLibraryPicker();
});

const tsImageFile = document.getElementById('ts-image-file');
// Image ▾ — a picture from the computer or the Media Library. (A slideshow is
// slides — a countdown's "+ Add Slide" — each fully editable.)
document.getElementById('ts-add-image-btn')?.addEventListener('click', (e) => {
  const r = e.currentTarget.getBoundingClientRect();
  window.KairoService.openContextMenu(r.left, r.bottom + 4, [[
    { label: 'From your computer…', onClick: () => tsImageFile?.click() },
    { label: 'From your Media Library…', onClick: () => document.getElementById('ts-add-media-lib-btn')?.click() },
  ]]);
});
tsImageFile?.addEventListener('change', async () => {
  const file = tsImageFile.files?.[0];
  tsImageFile.value = '';
  if (!file || !activeLook) return;
  const isVideo = isVideoFile(file);
  try {
    const { src, w, h } = isVideo ? await loadVideoFile(file) : await loadImageFile(file);
    // True original pixel size whenever it fits the canvas at all — same
    // reasoning as addMediaToCurrentSlide. A video with unknown dimensions
    // (loadVideoFile's onerror fallback) still gets a sensible default box
    // instead of a divide-by-zero.
    const fit = (w && h) ? Math.min(TS_DESIGN_W / w, TS_DESIGN_H / h, 1) : 1;
    const pw = (w && h) ? Math.round(w * fit) : Math.round(TS_DESIGN_W * 0.5);
    const ph = (w && h) ? Math.round(h * fit) : Math.round(TS_DESIGN_H * 0.5);
    const layer = {
      id: 'image-' + Date.now(), type: 'image', name: file.name.replace(/\.[^.]+$/, '').slice(0, 24) || (isVideo ? 'Video' : 'Image'),
      visible: true, src, fit: 'contain', opacity: 100, radius: 0,
      // See the matching comment in addMediaToCurrentSlide — same reason.
      naturalW: w, naturalH: h,
      pos: { x: Math.round((TS_DESIGN_W - pw) / 2), y: Math.round((TS_DESIGN_H - ph) / 2), w: pw, h: ph },
    };
    activeLook.layers.push(layer);
    activeLayer = layer;
    // up() (not a bare render) — see the Add Text handler above for why.
    up();
    renderProps();
  } catch {
    toast(isVideo ? 'Could not load that video' : 'Could not load that image', 'error');
  }
});

// ── Theme import / export ─────────────────────────────────────────────────
// .kairotheme is KAIRO's own real, distinct file type — a small envelope
// (format marker + version) wrapping a theme, rather than a bare .json blob
// with a naming convention pretending to be an extension. Bumping
// KAIROTHEME_FORMAT_VERSION only ever matters if the envelope shape itself
// changes; the theme payload inside can evolve without it.
const KAIROTHEME_FORMAT_VERSION = 1;

document.getElementById('export-look-btn')?.addEventListener('click', () => {
  if (!activeLook) return;
  const envelope = {
    kairoTheme: true,
    formatVersion: KAIROTHEME_FORMAT_VERSION,
    app: 'KAIRO',
    exportedAt: new Date().toISOString(),
    theme: activeLook,
  };
  const blob = new Blob([JSON.stringify(envelope, null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = (activeLook.name || 'kairo-theme').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() + '.kairotheme';
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  toast('Theme exported', 'success');
});

// Adds one imported look to the list and selects it — shared by every import
// path below (.kairotheme, plain .json, and each theme pulled out of a
// .protheme bundle) so they all land the same way.
function addImportedLook(look, nameSuffix = ' (imported)') {
  look.id   = 'imported-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7);
  look.name = (look.name || 'Imported theme') + nameSuffix;
  looks.push(look);
  return look;
}

function finishLookImport(look) {
  activeLook  = look;
  activeLayer = null; multiSelectedLayerIds.clear();
  resetThemeHistory(); // a freshly-imported theme has no undo history of its own to inherit
  saveLooks();
  renderLooksList(); renderLayersList(); renderThemeCanvasSizeSelect(); renderPreview(); renderProps();
}

// In-app replacement for window.confirm() — Tauri's webview doesn't
// reliably show native JS dialogs (confirm/alert just resolve instantly
// with no UI), which silently broke every delete confirmation that used to
// call confirm() directly. Same overlay-click-to-cancel convention as
// #add-confirm-modal / confirmProthemeSizeConversion below.
function confirmDialog(message, { title = 'Confirm', confirmLabel = 'Confirm', cancelLabel = 'Cancel', danger = false } = {}) {
  return new Promise(resolve => {
    const modal = document.getElementById('generic-confirm-modal');
    const confirmBtn = document.getElementById('gc-confirm');
    document.getElementById('gc-title').textContent = title;
    document.getElementById('gc-message').textContent = message;
    confirmBtn.textContent = confirmLabel;
    document.getElementById('gc-cancel').textContent = cancelLabel;
    confirmBtn.style.cssText = danger ? 'background:var(--red);' : '';
    modal.classList.remove('hidden');
    const close = (result) => { modal.classList.add('hidden'); cleanup(); resolve(result); };
    const onConfirm = () => close(true);
    const onCancel  = () => close(false);
    function cleanup() {
      confirmBtn.removeEventListener('click', onConfirm);
      document.getElementById('gc-cancel').removeEventListener('click', onCancel);
      modal.querySelector('.modal-overlay').removeEventListener('click', onCancel);
    }
    confirmBtn.addEventListener('click', onConfirm);
    document.getElementById('gc-cancel').addEventListener('click', onCancel);
    modal.querySelector('.modal-overlay').addEventListener('click', onCancel);
  });
}

// In-app replacement for the native confirm() previously used to ask whether
// a .protheme bundle's non-default slide size should convert to 1920x1080 or
// stay as-is — same overlay-click-to-cancel convention as #add-confirm-modal.
function confirmProthemeSizeConversion(bundleName, sizes) {
  return new Promise(resolve => {
    const modal = document.getElementById('protheme-size-modal');
    document.getElementById('pts-message').textContent =
      `"${bundleName}" includes slide size(s) other than the default 1920×1080 (${sizes}). Convert those to 1920×1080, or keep their original size?`;
    modal.classList.remove('hidden');
    const close = (result) => { modal.classList.add('hidden'); cleanup(); resolve(result); };
    const onConvert = () => close(true);
    const onKeep = () => close(false);
    const onOverlay = () => close(false);
    function cleanup() {
      document.getElementById('pts-convert').removeEventListener('click', onConvert);
      document.getElementById('pts-keep-original').removeEventListener('click', onKeep);
      modal.querySelector('.modal-overlay').removeEventListener('click', onOverlay);
    }
    document.getElementById('pts-convert').addEventListener('click', onConvert);
    document.getElementById('pts-keep-original').addEventListener('click', onKeep);
    modal.querySelector('.modal-overlay').addEventListener('click', onOverlay);
  });
}

const importLookFile = document.getElementById('import-look-file');
document.getElementById('import-look-btn')?.addEventListener('click', () => importLookFile?.click());
importLookFile?.addEventListener('change', async () => {
  const file = importLookFile.files?.[0];
  importLookFile.value = '';
  if (!file) return;
  const ext = file.name.toLowerCase().split('.').pop();

  // .protheme is a binary (zip + protobuf) ProPresenter theme bundle — needs
  // the server's zip/protobuf reader, so it's parsed there rather than here.
  // Base64-encoded over the same JSON transport /api/service/import already
  // uses for binary presentation files, rather than a one-off raw-body route.
  if (ext === 'protheme') {
    try {
      const buf = await file.arrayBuffer();
      const bytes = new Uint8Array(buf);
      let bin = '';
      for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
      const dataBase64 = btoa(bin);
      const res = await fetch(`${SERVER}/api/theme/import-protheme`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ dataBase64 }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data?.error || 'import failed');
      if (!Array.isArray(data.themes) || !data.themes.length) throw new Error('no theme slides found');
      const bundleName = file.name.replace(/\.protheme$/i, '');

      // Layer positions are always rescaled into KAIRO's fixed 1920x1080
      // design space regardless of canvasSize (see boundsFromFields in
      // theme_import.js) — that part isn't optional, it's how every layer
      // renders correctly at all. canvasSize itself, though, is just the
      // Size-picker/preview-shape hint (see themeCanvasSize), and a slide
      // that wasn't authored at 1920x1080 gets a real, meaningful choice
      // there: preview it as its own original shape (useful if there's an
      // actual matching-shaped screen), or fold it into the plain 16:9
      // default like every built-in theme.
      const nonDefaultSizes = data.themes.some(t => t.canvasSize && (t.canvasSize.w !== 1920 || t.canvasSize.h !== 1080));
      if (nonDefaultSizes) {
        const sizes = [...new Set(data.themes
          .filter(t => t.canvasSize && (t.canvasSize.w !== 1920 || t.canvasSize.h !== 1080))
          .map(t => `${t.canvasSize.w}×${t.canvasSize.h}`))].join(', ');
        const convert = await confirmProthemeSizeConversion(bundleName, sizes);
        if (convert) data.themes.forEach(t => { t.canvasSize = { w: 1920, h: 1080 }; });
      }

      // Every slide from this one bundle shares a group so Theme Studio's
      // list browses them together (see collapsedThemeGroups) instead of as
      // unrelated flat entries — matches how the bundle itself is one named
      // theme containing several slides, not several independent themes.
      const groupId = 'ptheme-' + Date.now();
      let last = null;
      data.themes.forEach(look => {
        look.groupId = groupId;
        look.groupName = bundleName;
        last = addImportedLook(look, '');
      });
      finishLookImport(last);
      toast(`Imported ${data.themes.length} theme${data.themes.length > 1 ? 's' : ''} from "${bundleName}"` +
        (data.warnings?.length ? ' — some details are best-effort, see console' : ''), 'success');
      if (data.warnings?.length) console.warn('[Theme import]', data.warnings);
    } catch (err) {
      toast(`Could not import that ProPresenter theme: ${err.message}`, 'error');
    }
    return;
  }

  try {
    const parsed = JSON.parse(await file.text());
    // .kairotheme wraps the theme in an envelope; a bare .json (the old
    // export shape, still readable) IS the theme.
    const look = (parsed && parsed.kairoTheme && parsed.theme) ? parsed.theme : parsed;
    if (!look || !Array.isArray(look.layers)) throw new Error('not a theme file');
    finishLookImport(addImportedLook(look));
    toast('Theme imported', 'success');
  } catch {
    toast('Not a valid theme file', 'error');
  }
});


// New theme — lands straight into rename mode on its own row, since that's
// the only place a theme gets named now.
newLookBtn?.addEventListener('click', () => {
  const base = deepClone(DEFAULT_LOOKS[0]);
  base.id   = 'look-' + Date.now();
  base.name = 'New Theme';
  // A new theme's canvas starts transparent, with nothing behind the
  // content; Background picks a picture, a colour or a gradient for it.
  const canvasFill = base.layers.find(l => l.type === 'background' && !l.pos);
  if (canvasFill) {
    canvasFill.fillBefore = 'solid';
    Object.assign(canvasFill, { fill: 'transparent', color: '#000000', color2: '#1c1c30', angle: 160 });
    delete canvasFill.src;
  }
  looks.push(base);
  activeLook  = base;
  activeLayer = null; multiSelectedLayerIds.clear();
  resetThemeHistory();
  saveLooks();
  renderLooksList();
  renderLayersList();
  renderThemeCanvasSizeSelect();
  renderPreview();
  renderProps();
  document.querySelector('.ts-theme-item.active .ts-theme-name')?.dispatchEvent(new Event('dblclick', { bubbles: true }));
});
