// KAIRO — helpers shared by every window (main app, display outputs).
// Loaded first by index.html and display.html, so each page gets ONE
// implementation instead of a copy per file (display.html's auth-token loader
// had drifted to a version with no retry, which loses the token permanently if
// the Tauri bridge attaches a tick late on a cold launch).
'use strict';

let AUTH_TOKEN = '';

// Retries with backoff rather than a single attempt: the packaged app runs
// with AUTH_REQUIRED on (dev mode never sets KAIRO_AUTH_TOKEN, so this whole
// path went untested all the way through this build), and a cold ad-hoc-signed
// launch is exactly the scenario where the injected `window.__TAURI__` bridge
// might not be fully ready on the very first task-queue turn. A silent,
// permanent failure here means EVERY authenticated request 401s for the rest
// of the session — Start Listening surfaces it, but so would verse search,
// settings, everything else, just without an obvious toast.
async function loadAuthToken(attempts = 5, delayMs = 200) {
  for (let i = 0; i < attempts; i++) {
    // `window.__TAURI__` missing here does NOT mean "plain-browser dev, give
    // up forever" — on a fresh navigation the IPC bridge can attach a tick or
    // two after our script starts running, which is exactly the race this
    // retry loop exists to survive. Returning here (as this used to do) exited
    // the whole function on the very first check, before the backoff below
    // ever got a chance — AUTH_TOKEN stayed '' permanently and every request
    // for the rest of the session silently dropped its Authorization header
    // and 401'd. Skip this attempt instead and let the loop keep retrying;
    // only a plain browser with no Tauri bridge at all pays the full ~3s of
    // backoff before giving up.
    const inv = window.__TAURI__?.core?.invoke || window.__TAURI__?.invoke;
    if (inv) {
      try {
        AUTH_TOKEN = await inv('get_server_token');
        // The bridge answered. An empty token means the server runs without
        // auth (dev) — retrying just delayed every window's connect by ~3s.
        return;
      } catch (err) {
        if (i === attempts - 1) {
          console.error('[KAIRO] Could not load auth token from Tauri after retries:', err?.message || err);
        }
      }
    }
    await new Promise(r => setTimeout(r, delayMs * (i + 1)));
  }
  console.error('[KAIRO] No auth token after ' + attempts + ' attempts — every API/WS request will 401 for this session.');
}

// Append ?token=… to a WS URL so the server can authenticate the upgrade.
function authedWsUrl(base) {
  if (!AUTH_TOKEN) return base;
  return base + (base.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(AUTH_TOKEN);
}

// HTML escape for safe interpolation into innerHTML or attributes. Same map
// in either context, so we don't keep two lookalike helpers.
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

const SECTION_TYPE_RE = /^(verse|chorus|refrain|solo|pre-?chorus|bridge|tag|intro|outro|ending)/i;
function sectionTypeClass(label) {
  const m = SECTION_TYPE_RE.exec(String(label || '').trim());
  if (!m) return null;
  const t = m[1].toLowerCase().replace(/-/g, '');
  if (t === 'prechorus') return 'sec-prechorus';
  if (t === 'ending') return 'sec-outro';
  return `sec-${t}`;
}

const loadedFonts = new Set(['Manrope', 'system-ui']);
function loadGoogleFont(family) {
  if (!family || loadedFonts.has(family)) return;
  loadedFonts.add(family);
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@100;200;300;400;500;600;700;800;900&display=swap`;
  document.head.appendChild(link);
}
