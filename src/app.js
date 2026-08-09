// KAIRO v2 — Frontend App
// Communicates with the Node.js server via WebSocket (live events)
// and fetch (commands). No Electron IPC.
'use strict';

// The frontend is served BY the Node sidecar, so window.location is always
// the right origin — no need to hardcode the port. Tauri picks a free port
// at launch and may not be 7777.
const SERVER = `${location.protocol}//${location.host}`;
const WS_URL = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`;

// Auth token shared between Tauri and the Node sidecar. Fetched once at boot
// via Tauri IPC, then injected into every fetch (Authorization header) and
// WebSocket URL (?token=…). In a non-Tauri context (e.g. opening index.html
// in a stock browser during dev) the IPC call fails and we run unauthenticated
// — the server also treats auth as optional when its env var is absent.
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
        if (AUTH_TOKEN) return;
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

// Wrap fetch so every call automatically carries the token. All existing
// `fetch(${SERVER}/api/...)` call sites work unchanged.
const _origFetch = window.fetch.bind(window);
window.fetch = (input, init = {}) => {
  if (!AUTH_TOKEN) return _origFetch(input, init);
  const headers = new Headers(init.headers || (typeof input !== 'string' && input?.headers) || {});
  if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${AUTH_TOKEN}`);
  return _origFetch(input, { ...init, headers });
};

// Append ?token=… to a WS URL so the server can authenticate the upgrade.
function authedWsUrl(base) {
  if (!AUTH_TOKEN) return base;
  return base + (base.includes('?') ? '&' : '?') + 'token=' + encodeURIComponent(AUTH_TOKEN);
}

// ── Helpers ────────────────────────────────────────────────────────────────
// HTML escape for safe interpolation into innerHTML or attributes. Same map
// in either context, so we don't keep two lookalike helpers.
function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// Strip KJV annotation markers: {note} {word: alt} [Header text]
function cleanVerseText(text) {
  return (text || '')
    .replace(/\[[^\]]*\]/g, '')   // remove [A Psalm of David…] headers
    .replace(/\{[^}]*\}/g, '')    // remove {art} {thirsty: Heb. weary} etc.
    .replace(/\s{2,}/g, ' ')      // collapse double spaces left behind
    .trim();
}

// "Matthew 17:21" → "MT·17"   |   "1 Chronicles 6:18" → "1CH·6"   |   "Song of Solomon 2:1" → "SO·2"
// The badge pill has a fixed width; returning the full book name overflows it.
function refToBadgeAbbr(reference) {
  const parts = (reference || '').split(' ');
  if (!parts.length) return '??';
  const isNumbered = /^[123]$/.test(parts[0] || '');
  const bookWord   = parts[isNumbered ? 1 : 0] || '';
  const bookAbbr   = (isNumbered ? parts[0] : '') + bookWord.slice(0, 2).toUpperCase();
  // Chapter always lives in the last whitespace-separated token (C:V form).
  const chapNum    = (parts[parts.length - 1] || '').split(':')[0];
  return bookAbbr + (chapNum ? '·' + chapNum : '');
}

// ── State ──────────────────────────────────────────────────────────────────
let ws             = null;
let wsReconnectTimer = null;
let wsReconnectAttempts = 0;
let isListening    = false;
let mediaStream    = null;
let audioContext   = null;
let audioProcessor = null;
let workerReady    = false;
let settings       = {};
let elapsedInterval = null;
let startTime      = null;
let wordCount      = 0;
let verseCount     = 0;
let sessionVerses  = [];
let sessionTranscriptParts = [];   // [{ time: HH:MM:SS, text }] — final fragments only
// Running sum/count rather than an ever-growing array of every confidence
// score — this is only ever used for the live average display, so an array
// just meant recomputing an O(n) reduce (over a growing n) on every single
// verse detection for the whole service.
let confidenceSum   = 0;
let confidenceCount = 0;
let rangeRefs      = new Set(); // references belonging to the active verse range

// ── DOM ────────────────────────────────────────────────────────────────────
const listenBtn          = document.getElementById('listen-btn');
const listenText         = listenBtn?.querySelector('.listen-text');
const micDisplay         = document.getElementById('mic-display');
const elapsedTimeEl      = document.getElementById('elapsed-time');
const transcriptContent  = document.getElementById('transcript-content');
const proPresenterStatus = document.getElementById('propresenter-status');
const propresenterDot    = document.getElementById('propresenter-dot');
const settingsBtn        = document.getElementById('settings-btn');
const settingsModal      = document.getElementById('settings-modal');
const closeSettingsBtn   = document.getElementById('close-settings');
const cancelSettingsBtn  = document.getElementById('cancel-settings');
const saveSettingsBtn    = document.getElementById('save-settings');
const testPPBtn          = document.getElementById('test-propresenter-btn');
const autoSendCheckbox   = document.getElementById('auto-send-checkbox');
const autoSendSettings   = document.getElementById('auto-send-settings');
const toastContainer     = document.getElementById('toast-container');
const workerStatusEl     = document.getElementById('worker-status');
const verseCountEl       = document.getElementById('verse-count');
const wordCountEl        = document.getElementById('word-count');
const avgConfidenceEl    = document.getElementById('avg-confidence');
const elapsedMetricEl    = document.getElementById('elapsed-time-metric');
const exportBtn          = document.getElementById('export-btn');
const clearLockedBtn     = document.getElementById('clear-locked-btn');
const clearSuggestionsBtn = document.getElementById('clear-suggestions-btn');
const clearTranscriptBtn = document.getElementById('clear-transcript');
const previewVerseText   = document.getElementById('preview-verse-text');
const previewVerseRef    = document.getElementById('preview-verse-ref');

// ── Native NDI bridge ────────────────────────────────────────────────────
// Whenever the live preview verse changes, push it to the native Rust NDI
// sender so the broadcast frame stays in sync. Coalesce rapid changes via
// requestAnimationFrame so we don't issue redundant invokes during multi-
// step UI updates (e.g. clear → new verse fires two mutations in one tick).
(function wireNdiBridge() {
  const tauriInvoke = window.__TAURI__?.core?.invoke || window.__TAURI__?.invoke;
  if (!tauriInvoke || !previewVerseText) return;
  let scheduled = false;
  let lastSent = '';
  function pushToOutputs() {
    scheduled = false;
    const verse = (previewVerseText.textContent || '').trim();
    const ref   = (previewVerseRef?.textContent || '').trim();
    const blank = !verse || verse === 'Nothing on display';
    const sig   = blank ? '' : (ref + '' + verse);
    if (sig === lastSent) return;
    lastSent = sig;
    const v = blank ? '' : verse;
    const r = blank ? '' : ref;
    // Each output's _update is a no-op if that output isn't running, so we
    // can fire unconditionally to both NDI and Syphon without checking state.
    tauriInvoke('ndi_update',    { verse: v, reference: r }).catch(() => {});
    tauriInvoke('syphon_update', { verse: v, reference: r }).catch(() => {});
  }
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(pushToOutputs);
  }
  new MutationObserver(schedule).observe(previewVerseText, { characterData: true, childList: true, subtree: true });
  if (previewVerseRef) {
    new MutationObserver(schedule).observe(previewVerseRef, { characterData: true, childList: true, subtree: true });
  }
})();
const currentDisplayCard = document.getElementById('current-display-card');
const queueList          = document.getElementById('queue-list');
const suggestionCount    = document.getElementById('suggestion-count');

// Search
const scriptureSearchInput = document.getElementById('scripture-search-input');
const scriptureSearchBtn   = document.getElementById('scripture-search-btn');
const scriptureSearchClear = document.getElementById('scripture-search-clear');
const translationSelect    = document.getElementById('translation-select');

// Settings inputs
const deepgramKeyInput    = document.getElementById('deepgram-key');
const ppUrlInput          = document.getElementById('propresenter-url');
const translationSettings = document.getElementById('translation-select-settings');
const swapPPBtn           = document.getElementById('swap-pp-tokens-btn');
const ppTokenOrderLabel   = document.getElementById('pp-token-order-label');
const showConfSettings    = document.getElementById('show-confidence-settings');
const audioSourceSettings = document.getElementById('audio-source-settings');
const refreshDevicesBtn   = document.getElementById('refresh-devices-settings');
const obsEnabledToggle   = document.getElementById('obs-enabled-toggle');
const obsUrlInput        = document.getElementById('obs-url');
const obsPasswordInput   = document.getElementById('obs-password');
const obsTextSourceInput = document.getElementById('obs-text-source');
const testObsBtn         = document.getElementById('test-obs-btn');
const obsStatusEl        = document.getElementById('obs-status');
const ppEnabledToggle    = document.getElementById('pp-enabled-toggle');

// ── WebSocket ──────────────────────────────────────────────────────────────
function connectWS() {
  if (ws && ws.readyState < 2) return;
  ws = new WebSocket(authedWsUrl(WS_URL));

  ws.onopen = () => {
    console.log('[WS] Connected');
    clearTimeout(wsReconnectTimer);
    wsReconnectAttempts = 0;
    updatePPStatus('Checking…', '');
    loadSettings();
    initCustomSelects();
    checkPP();
  };

  ws.onmessage = (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch { return; }
    try { handleServerMessage(m); } catch (err) { console.warn('[WS] handler error:', err); }
  };

  ws.onclose = () => {
    // Exponential backoff with jitter, capped low — this is a local sidecar
    // process, not a remote network hop, so a long ceiling would just make a
    // brief server restart feel sluggish to recover from. The cap mainly
    // exists so a genuinely dead server doesn't get hammered by a reconnect
    // every 2s indefinitely.
    const delay = Math.min(1000 * 1.6 ** wsReconnectAttempts, 8000) + Math.random() * 300;
    wsReconnectAttempts++;
    console.warn(`[WS] Disconnected — reconnecting in ${Math.round(delay / 1000)}s…`);
    // Drop any prior timer so back-to-back close events can't stack reconnects.
    clearTimeout(wsReconnectTimer);
    wsReconnectTimer = setTimeout(connectWS, delay);
  };

  ws.onerror = () => ws.close();
}

function handleServerMessage(msg) {
  switch (msg.type) {

    case 'worker-ready':
      workerReady = true;
      if (workerStatusEl) { workerStatusEl.textContent = 'Engine ready'; workerStatusEl.style.color = 'var(--green)'; }
      break;

    case 'content-progress': {
      // Map/reduce generation reports per-chunk progress; reflect it on the
      // Content Studio generate button if a generation is in flight.
      const lbl = document.getElementById('cs-generate-label');
      if (lbl && lbl.textContent.startsWith('Generating')) {
        lbl.textContent = `Generating… ${msg.done}/${msg.total}`;
      }
      break;
    }

    case 'worker-error':
      workerReady = false;
      if (workerStatusEl) { workerStatusEl.textContent = 'Engine error'; workerStatusEl.style.color = 'var(--red)'; }
      toast('Detection engine error: ' + msg.error, 'error');
      break;

    case 'worker-status':
      workerReady = msg.ready || false;
      if (workerStatusEl) {
        workerStatusEl.textContent = msg.ready ? 'Engine ready' : 'Engine loading…';
        workerStatusEl.style.color = msg.ready ? 'var(--green)' : 'var(--text-2)';
      }
      break;

    case 'connection-state':
      handleConnectionState(msg.state, msg.error);
      break;

    case 'transcript':
      handleTranscript(msg);
      break;

    case 'detection':
      handleDetection(msg);
      break;

    case 'propresenter-success':
      handlePPSuccess(msg.verse);
      break;

    case 'propresenter-error':
      updatePPStatus('Error', 'error');
      break;

    case 'range-state':
      handleRangeState(msg);
      break;

    case 'range-verses':
      handleRangeVerses(msg);
      break;

    case 'range-active':
      handleRangeActive(msg.activeRef);
      break;

    // Display window reporting media <video> playback state back up, and
    // a watched smart folder's contents having changed on disk — both just
    // forward into service.js, which owns the Media tab's DOM.
    case 'media-status':
      window.KairoService?.onMediaStatus?.(msg);
      break;

    case 'media-folder-changed':
      window.KairoService?.onMediaFolderChanged?.(msg.folderId);
      break;

    // Same broadcast the real output window renders (see display.html) —
    // mirroring it in this window's own preview so a media send has some
    // visible confirmation here too, not just on the actual output.
    case 'media':
      if (msg.target === 'viewer') renderMediaPreview(msg.src, msg.kind);
      break;

    case 'clear-layer':
      if (msg.layer === 'media' || msg.layer === 'all') clearMediaPreview();
      break;

  }
}

// ── Connection state ───────────────────────────────────────────────────────
function handleConnectionState(state, error) {
  const micPill = document.querySelector('.pill-green');
  const micLabel = micPill?.querySelector('.pill-dot');
  // Left sidebar broadcasting indicator
  const lsBcastDot = document.getElementById('ls-bcast-dot');
  const lsBcastLbl = document.getElementById('ls-bcast-label');

  if (state === 'connected') {
    isListening = true;
    if (listenText) listenText.textContent = 'Stop Listening';
    listenBtn?.classList.add('active');
    listenBtn?.querySelector('svg rect')?.setAttribute('fill', 'currentColor');
    if (micLabel) micLabel.classList.add('pulse');
    if (lsBcastDot) lsBcastDot.classList.add('broadcasting');
    if (lsBcastLbl) { lsBcastLbl.classList.add('broadcasting'); lsBcastLbl.textContent = 'Broadcasting'; }
    if (!startTime) {
      startTime = Date.now();
      elapsedInterval = setInterval(updateElapsed, 1000);
    }
    showEmptyTranscript(false);
  } else if (state === 'disconnected' || state === 'error') {
    isListening = false;
    if (listenText) listenText.textContent = 'Start Listening';
    listenBtn?.classList.remove('active');
    if (micLabel) micLabel.classList.remove('pulse');
    if (lsBcastDot) lsBcastDot.classList.remove('broadcasting');
    if (lsBcastLbl) { lsBcastLbl.classList.remove('broadcasting'); lsBcastLbl.textContent = 'Idle'; }
    stopAudioCapture();
    if (state === 'error' && error) toast(error, 'error');
  } else if (state === 'connecting') {
    if (listenText) listenText.textContent = 'Connecting…';
    if (lsBcastLbl) lsBcastLbl.textContent = 'Connecting…';
  }
}

// ── Transcript ─────────────────────────────────────────────────────────────
let transcriptDiv = null;
let interimSpan   = null;

function showEmptyTranscript(show) {
  if (!transcriptContent) return;
  if (show) {
    transcriptContent.innerHTML = '<div class="empty-state-sm"><p>Click <strong>Start</strong> to begin live transcription</p></div>';
    transcriptDiv = null; interimSpan = null;
  } else if (!transcriptDiv) {
    transcriptContent.innerHTML = '';
    transcriptDiv = document.createElement('div');
    transcriptDiv.className = 'transcript-text';
    transcriptContent.appendChild(transcriptDiv);
    interimSpan = document.createElement('span');
    interimSpan.className = 'transcript-interim';
    transcriptDiv.appendChild(interimSpan);
  }
}

// Cap DOM nodes in the Live Transcript Log — unlike Candidates/Live Queue
// (both trimmed to 50), this panel had no limit and grew for the whole
// service. Every interim update forces a scrollHeight reflow over the full
// list, so a long sermon made the UI progressively heavier until it felt
// frozen. Full text is still captured in sessionTranscriptParts for export.
const TRANSCRIPT_LOG_MAX_SPANS = 400;

// Interim transcript updates can arrive several times a second during
// continuous speech; forcing a scrollHeight reflow on every single one adds
// up. Coalesce into at most one scroll per rendered frame.
let _transcriptScrollScheduled = false;
function scheduleTranscriptScroll() {
  if (_transcriptScrollScheduled) return;
  _transcriptScrollScheduled = true;
  requestAnimationFrame(() => {
    _transcriptScrollScheduled = false;
    if (transcriptContent) transcriptContent.scrollTop = transcriptContent.scrollHeight;
  });
}

function handleTranscript(msg) {
  if (!transcriptDiv) showEmptyTranscript(false);
  if (msg.isFinal) {
    const span = document.createElement('span');
    span.className = 'transcript-final';
    span.textContent = msg.text + ' ';
    if (interimSpan) transcriptDiv.insertBefore(span, interimSpan);
    else transcriptDiv.appendChild(span);
    if (interimSpan) interimSpan.textContent = '';
    const finals = transcriptDiv.querySelectorAll('.transcript-final');
    if (finals.length > TRANSCRIPT_LOG_MAX_SPANS) {
      for (let i = 0; i < finals.length - TRANSCRIPT_LOG_MAX_SPANS; i++) finals[i].remove();
    }
    // Capture for Content Studio — finals only, never interim drafts.
    sessionTranscriptParts.push({ time: new Date().toLocaleTimeString(), text: msg.text });
    wordCount += msg.text.split(/\s+/).length;
    if (wordCountEl) wordCountEl.textContent = wordCount.toLocaleString();
    // Auto-scroll
    scheduleTranscriptScroll();
  } else {
    if (interimSpan) { interimSpan.textContent = msg.text; interimSpan.style.opacity = '0.5'; }
    scheduleTranscriptScroll();
  }
}

// ── Detection routing ──────────────────────────────────────────────────────
// Client-side score gate matches server — belt-and-suspenders so stale WS
// messages from a previous session can't populate SENT with low-confidence hits.
const CLIENT_VIEWER_MIN_SCORE = 0.80;

function handleDetection(msg) {
  const { verses, method, target, topScore, correctedFrom, look } = msg;
  if (!verses?.length) return;

  if (target === 'viewer' && (topScore == null || topScore >= CLIENT_VIEWER_MIN_SCORE)) {
    showInViewer(verses, method, topScore, correctedFrom, look);
  } else {
    showInSuggestions(verses, method);
  }
}

// Render the live preview screen. A sent item can carry its own theme (e.g. a
// ProPresenter import via Send/Flow) — when it does, paint it with the exact
// same layer renderer the playlist editor uses instead of the generic plain
// text, so the operator sees what the audience is actually about to see.
// Anything with no per-item theme (ordinary scripture detections/search-sends,
// or a playlist item explicitly left on "Output default") falls back to the
// primary output's assigned theme — the same fallback display.html already
// does for the real output window, so this preview stays truthful to it
// instead of always showing plain text regardless of that assignment.
// Guards handlePPSuccess below against clobbering a themed render. Keyed on
// reference+text (not reference alone) — slides items deliberately carry an
// empty reference, which used to collapse to the same falsy key for every
// slide and let the plain-render fallback win the race every time.
let lastPreviewKey = null;
let lastPreviewWasThemed = false;
let lastPreviewHadOwnLook = false; // true only when `look` itself was truthy, not the output-default fallback

// Bumped on every renderPreviewScreen() call so a delayed setTimeout paint()
// from an earlier call can tell it's been superseded and bail instead of
// flashing stale content over whatever the latest call already painted —
// two sends within one transition window used to race their own delayed
// paints, briefly showing the older (already-replaced) verse.
let previewRenderGen = 0;

// Which output the Live preview panel (right sidebar) is currently
// monitoring — matches ProPresenter's Preview Window, which has its own
// screen-selector dropdown independent of what's being edited. Defaults to
// the primary/External Display output.
let livePreviewOutputId = 'display-1';

function primaryOutputLook() {
  try {
    const map = (typeof outputThemeMap === 'function') ? outputThemeMap() : {};
    const id  = map[livePreviewOutputId] ?? ((typeof PRIMARY_DISPLAY !== 'undefined') ? map[PRIMARY_DISPLAY] : null);
    return (Array.isArray(looks) ? looks.find(l => l.id === id) : null) || null;
  } catch { return null; }
}

// Shapes the Live preview box to whichever output it's currently monitoring
// — its assigned physical screen's aspect ratio if one's been set (see
// outputScreenMap), otherwise the shared fixed 16:9 default.
function applyLivePreviewAspect() {
  const el = document.getElementById('slide-preview');
  if (!el) return;
  const s = (typeof outputScreenMap === 'function') ? outputScreenMap()[livePreviewOutputId] : null;
  el.style.aspectRatio = s ? `${s.width} / ${s.height}` : '';
}

// Keeps the panel's output dropdown in sync with configured outputs
// (renamed/added/removed extra displays) — called from renderDisplayOutputs.
function renderLivePreviewOutputSelect() {
  const sel = document.getElementById('live-preview-output-select');
  if (!sel || typeof displayOutputs !== 'function') return;
  const outputs = displayOutputs();
  if (!outputs.some(d => d.id === livePreviewOutputId)) livePreviewOutputId = outputs[0]?.id || 'display-1';
  sel.innerHTML = '';
  outputs.forEach(d => {
    const o = document.createElement('option');
    o.value = d.id; o.textContent = d.name;
    if (d.id === livePreviewOutputId) o.selected = true;
    sel.appendChild(o);
  });
  applyLivePreviewAspect();
}

document.getElementById('live-preview-output-select')?.addEventListener('change', (e) => {
  livePreviewOutputId = e.target.value;
  applyLivePreviewAspect();
  // Only the output-default fallback (no item-specific theme) is stale when
  // switching which output we're monitoring — an item with its own theme
  // stays exactly as sent, same guard applyOutputThemes() already uses.
  if (!lastPreviewHadOwnLook && previewVerseText) {
    renderPreviewScreen(
      previewVerseText.textContent === 'Nothing on display' ? '' : previewVerseText.textContent,
      previewVerseRef?.textContent || '',
      null
    );
  }
});

function renderPreviewScreen(text, reference, look, translatedText = '', image = null, fit = 'contain', styleByLayerId = {}) {
  const myGen = ++previewRenderGen;
  const effectiveLook = look || primaryOutputLook();
  const newPreviewKey = `${reference || ''} ${text || ''}`;
  // This panel (the sidebar Live Preview, not a separate display.html output
  // window) is what an operator watches while testing right in the main
  // window — it used to repaint instantly on every send regardless of the
  // theme's own animation/animationSpeed, which is exactly why a theme like
  // Lyrics — Motion looked completely inert unless you had a real output
  // window open elsewhere. Mirrors the same cut/fade/slide-up + speed
  // handling display.html's renderStage/showVerse already do.
  const contentChanged = newPreviewKey !== lastPreviewKey;
  lastPreviewKey = newPreviewKey;
  lastPreviewWasThemed = !!effectiveLook;
  lastPreviewHadOwnLook = !!look;
  const themed = document.getElementById('slide-preview-themed');
  const plain  = document.querySelector('#slide-preview .live-screen-inner');
  // Keep the plain text nodes current even in themed mode (just hidden) — the
  // NDI/Syphon output bridge (wireNdiBridge, above) watches them via
  // MutationObserver to know what to render on those outputs, which have no
  // concept of theme layers of their own. An image slide has no text to
  // bind (mirrors display.html's renderImageStage), so blank it here too.
  if (previewVerseText) previewVerseText.textContent = image ? '' : text;
  if (previewVerseRef)  previewVerseRef.textContent  = reference || '';

  const animType = (effectiveLook && effectiveLook.animation) || 'fade';
  const speedMs = Math.round(300 * ((effectiveLook && typeof effectiveLook.animationSpeed === 'number' && effectiveLook.animationSpeed > 0) ? effectiveLook.animationSpeed : 1));
  // Only animate an actual slide-to-slide change, on an already-painted
  // panel, when the theme asks for it — not the first paint (nothing to
  // transition from), not a same-content re-broadcast, not 'cut'. Text
  // Animation (Word/Activate/Karaoke/etc — a separate field from this
  // Transition, see KairoWordSplit's file header) runs independently
  // inside paintLookLayers regardless of what happens here; a theme is
  // free to combine a real Transition with a Text Animation on top.
  const shouldAnimate = contentChanged && animType !== 'cut' && themed && themed.hasChildNodes();

  const paint = () => {
    // Image slides bypass the theme's text layers entirely, full-frame — same
    // rule display.html's handleMessage applies before calling renderImageStage.
    // This preview panel never had that branch: it only ever called
    // paintLookLayers with the (empty, for an image slide) verse text, so a
    // sent image never appeared here even though the real output showed it.
    if (image && themed) {
      plain?.classList.add('hidden');
      themed.classList.remove('hidden');
      themed.innerHTML = '';
      const img = document.createElement('img');
      img.src = image;
      img.style.cssText = `position:absolute;inset:0;width:100%;height:100%;object-fit:${fit};`;
      themed.appendChild(img);
    } else if (effectiveLook && themed && window.KairoService?.paintLookLayers) {
      plain?.classList.add('hidden');
      themed.classList.remove('hidden');
      window.KairoService.paintLookLayers(themed, effectiveLook, styleByLayerId, { verseText: text, referenceText: reference || '', translatedText });
    } else {
      themed?.classList.add('hidden');
      plain?.classList.remove('hidden');
    }
  };

  if (!shouldAnimate) {
    paint();
    // Guards against a real, intermittent bug: if a PRIOR call was mid-fade
    // (opacity already animating toward 0, see below) and got preempted by
    // THIS one before its own setTimeout fired, that prior call's callback
    // bails via the myGen check below and never gets to restore opacity —
    // leaving it stuck at 0 forever, since paint() itself never touches
    // opacity. Content is correctly painted underneath, it's just invisible.
    // Only reproduces when a fast second send interrupts an in-flight themed
    // transition and the second one *doesn't* itself animate (e.g. a 'cut'
    // theme, or unchanged content) — intermittent by nature, which matches
    // "the preview sometimes goes blank" exactly. Cheap and always correct
    // to force opacity back to 1 here regardless of whether it was actually
    // orphaned.
    if (themed) themed.style.opacity = '1';
    return;
  }

  themed.style.transition = `opacity ${speedMs}ms ease, transform ${speedMs}ms ease`;
  themed.style.opacity    = '0';
  if (animType === 'slide-up') themed.style.transform = 'translateY(-10px)';

  setTimeout(() => {
    // A newer renderPreviewScreen() call landed while this one was still
    // mid-transition — that call already painted (or scheduled) the current
    // content; applying this stale one now would flash it back briefly.
    if (myGen !== previewRenderGen) return;
    paint();
    if (animType === 'slide-up') {
      // Double-rAF instead of a synchronous offsetHeight read to commit the
      // "jump to start" state before animating back to place. A forced
      // synchronous layout read here (the previous approach) is a documented
      // WebKit trigger for stale-compositor-layer bugs on unrelated stacked
      // siblings in the same document — this panel lives in the same page as
      // .top-bar (z-index:20), which is exactly the bug that kept reproducing
      // regardless of any CSS mitigation tried on .top-bar itself. rAF waits
      // for an actual committed frame instead of forcing one synchronously.
      themed.style.transition = 'none';
      themed.style.transform  = 'translateY(10px)';
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          themed.style.transition = `opacity ${speedMs}ms ease, transform ${speedMs}ms ease`;
          themed.style.transform  = 'none';
          themed.style.opacity    = '1';
        });
      });
    } else {
      themed.style.opacity = '1';
    }
  }, speedMs + 10);
}

// Mirrors the real output's independent media layer in this window's own
// preview — sending media had no feedback anywhere in the operator's own
// UI before this (nothing here ever changed on a media send), which made a
// working send look identical to a failed one.
function renderMediaPreview(src, kind) {
  const host = document.getElementById('slide-preview-media');
  if (!host) return;
  host.innerHTML = '';
  if (!src) {
    host.classList.add('hidden');
    // Restore the placeholder only if there's no real verse text either —
    // it's a stand-in for "nothing at all", not just "no media".
    if (previewVerseText && !previewVerseText.textContent) previewVerseText.textContent = 'Nothing on display';
    return;
  }
  host.classList.remove('hidden');
  // The placeholder was only ever covering for "nothing sent yet" — with
  // real media now showing, it would just sit as stray text over the
  // image/video. Actual verse text (if any is genuinely live) is untouched.
  if (previewVerseText?.textContent === 'Nothing on display') previewVerseText.textContent = '';
  if (kind === 'video') {
    const v = document.createElement('video');
    v.src = src; v.autoplay = true; v.loop = true; v.muted = true; v.playsInline = true;
    host.appendChild(v);
  } else {
    const img = document.createElement('img');
    img.src = src;
    host.appendChild(img);
  }
}
function clearMediaPreview() { renderMediaPreview(null); }

// Update only the viewer display (preview panel) without touching queue order.
// Use this for dblclick on already-queued cards so they don't reorder.
function updateViewerDisplay(v) {
  renderPreviewScreen(cleanVerseText(v.text), v.reference, null, v.translatedText || '');
}

function showInViewer(verses, method, topScore, correctedFrom = null, look = null) {
  const v = verses[0];

  // Update live preview screen
  renderPreviewScreen(cleanVerseText(v.text), v.reference, look, v.translatedText || '', v.image || null, v.fit || 'contain', v.slideStyle || {});

  // A playlist send (song/slide deck/announcement/scripture item run from
  // the service) isn't a scripture detection — the Bible tab's Live Queue,
  // Candidates panel, and session stats below all exist to track auto-
  // detect/search activity specifically, not "whatever got sent from the
  // playlist". The live preview above still updates either way.
  if (method === 'service') return;

  // Auto-correction: strip the mis-cited row so it doesn't linger above the fix.
  if (correctedFrom) {
    const stale = currentDisplayCard?.querySelector(`[data-ref="${CSS.escape(correctedFrom)}"]`);
    stale?.remove();
    const staleCand = queueList?.querySelector(`[data-ref="${CSS.escape(correctedFrom)}"]`);
    staleCand?.remove();
  }

  // ── Live Queue — the single list of sent + queued verses ──
  if (currentDisplayCard) {
    const isEmpty = currentDisplayCard.querySelector('.display-empty, .cs-queue-empty');
    if (isEmpty) isEmpty.remove();

    if (rangeRefs.has(v.reference)) {
      // Range verse auto-advancing — just shift the highlight
      handleRangeActive(v.reference);
    } else {
      // Regular sent verse — full-list dedup (not just top card)
      const existing = currentDisplayCard.querySelector(`[data-ref="${CSS.escape(v.reference)}"]`);
      if (existing) {
        // Already in list — pulse it and bring to top
        existing.classList.remove('sent-pulse');
        void existing.offsetWidth;
        existing.classList.add('sent-pulse');
        currentDisplayCard.insertBefore(existing, currentDisplayCard.firstChild);
      } else {
        const card = buildQueueRow(v, method, correctedFrom);
        currentDisplayCard.insertBefore(card, currentDisplayCard.firstChild);
        // Trim to keep session manageable (50 entries)
        const children = currentDisplayCard.children;
        if (children.length > 50) {
          const frag = document.createDocumentFragment();
          while (children.length > 50) frag.appendChild(children[children.length - 1]);
          // frag is discarded, removing all excess elements in one reflow
        }
      }
    }
  }

  verseCount++;
  if (verseCountEl) verseCountEl.textContent = verseCount;
  if (v.similarity) {
    confidenceSum += v.similarity;
    confidenceCount++;
    const avg = confidenceSum / confidenceCount;
    if (avgConfidenceEl) avgConfidenceEl.textContent = (avg * 100).toFixed(0) + '%';
  }
  sessionVerses.push({ ref: v.reference, text: v.text, time: new Date().toLocaleTimeString() });

  // ── Candidates panel stays candidates-only — auto-sent verses don't get
  // logged there. Previously every sent verse ALSO got written into the
  // Candidates panel (new record, or upgrading an existing suggestion card
  // green in place) as a permanent session log — the two panels showed
  // overlapping information and it wasn't clear which one to check for
  // "what's actually live" vs. "what's awaiting a decision". If this verse
  // was already sitting there as an unpromoted suggestion, it's no longer
  // a candidate now that it's live — remove it rather than leave a stale
  // (or now-misleading) card behind.
  if (queueList) {
    const existing = queueList.querySelector(`[data-ref="${CSS.escape(v.reference)}"]`);
    if (existing) existing.remove();
    updateSuggestionCount();
  }
}

function showInSuggestions(verses, method) {
  if (!queueList) return;
  queueList.querySelector('.display-empty')?.remove();

  const frag = document.createDocumentFragment();
  for (const v of verses) {
    if (queueList.querySelector(`[data-ref="${CSS.escape(v.reference)}"]`)) continue;
    frag.appendChild(buildCandidateCard(v, method));
  }
  if (frag.childNodes.length) queueList.insertBefore(frag, queueList.firstChild);

  const queueChildren = queueList.children;
  if (queueChildren.length > 50) {
    const trimFrag = document.createDocumentFragment();
    while (queueChildren.length > 50) trimFrag.appendChild(queueChildren[queueChildren.length - 1]);
    // trimFrag is discarded, removing all excess elements in one reflow
  }
  updateSuggestionCount();
}

// Purpose-built compact card for the Candidates panel
// Native 'dblclick' requires both clicks to land within the platform's own
// tight time+distance window — reliable in a plain browser tab, but real
// double-clicks in the packaged Tauri/WKWebView app were landing as two
// separate single clicks instead of one dblclick (same class of WebKit
// quirk as the drag-region compositing bug found earlier this session).
// This is a manual, more forgiving stand-in: two clicks on the SAME element
// within 500ms count as a double-click, regardless of the platform's own
// (stricter) dblclick detection. Ignores clicks on nested buttons — those
// already have their own single-click handlers.
function wireDoubleClickSend(el, handler) {
  let lastClickAt = 0;
  el.addEventListener('click', (e) => {
    if (e.target.closest('button')) return;
    const now = Date.now();
    if (now - lastClickAt < 500) {
      lastClickAt = 0;
      handler(e);
    } else {
      lastClickAt = now;
    }
  });
}

// method 'text' = a phrase/keyword search hit — the engine found the closest
// match(es) but isn't confident enough to call it a direct reference, so it
// lands here as a suggestion rather than auto-sending. Marked distinctly
// (amber) so it reads as "pick one of these", not "here's what's live" —
// visually different from fingerprint/context candidates, which are a
// passive by-product of the transcript rather than something explicitly
// searched for.
function buildCandidateCard(v, method, isSent = false) {
  const pct  = v.similarity != null ? Math.round(v.similarity * 100) : null;
  const conf = pct != null ? pct + '%' : '';
  const tier = pct == null ? '' : pct >= 90 ? 'conf-high' : pct >= 80 ? 'conf-good' : pct >= 60 ? 'conf-mid' : 'conf-low';
  const isSearchHit = method === 'text' || method === 'search';

  const card = document.createElement('div');
  card.className = 'cand-card' + (isSent ? ' cand-sent' : '') + (isSearchHit ? ' cand-search' : '');
  card.dataset.ref = v.reference;
  card.innerHTML = `
    <div class="cand-row">
      <span class="cand-ref">${v.reference}</span>
      ${conf ? `<span class="cand-badge ${tier}">${conf}</span>` : ''}
    </div>
    <div class="cand-text">${cleanVerseText(v.text)}</div>
    <div class="cand-actions">
      <button class="cand-send">Send to Air</button>
      <button class="cand-promote">Promote</button>
    </div>
  `;
  const sendBtn = card.querySelector('.cand-send');
  const promoteBtn = card.querySelector('.cand-promote');
  const sendThis = () => {
    // showInViewer now removes this card outright (Candidates is
    // candidates-only, no sent-item log) — no in-place "mark green" step
    // needed here anymore.
    showInViewer([v], method || 'direct', 1.0);
    sendVerseToServer(v);
  };
  sendBtn?.addEventListener('click', sendThis);
  promoteBtn?.addEventListener('click', () => {
    // Promote = send to viewer only (no PP), remove from candidates
    showInViewer([v], method || 'direct', 1.0);
    card.remove();
    updateSuggestionCount();
  });
  // Double-click anywhere on the card → same action as "Send to Air", so
  // Candidates matches the Live Queue/range-card shortcut instead of being
  // the one surface where you have to hit the button precisely.
  wireDoubleClickSend(card, sendThis);
  return card;
}

// Compact single-row card for the Live Queue section
function buildQueueRow(v, method, correctedFrom = null) {
  const card = document.createElement('div');
  card.dataset.ref = v.reference;
  card.className = 'locked-verse-card' + (correctedFrom ? ' corrected' : '');
  const abbr = refToBadgeAbbr(v.reference);
  const correctedChip = correctedFrom
    ? `<span class="corrected-chip" title="Auto-corrected from ${correctedFrom}">corrected from ${correctedFrom}</span>`
    : '';
  card.innerHTML = `
    <div class="history-book-badge">${abbr}</div>
    <div class="history-card-content">
      <div class="lvc-ref">${v.reference}${correctedChip}</div>
      <div class="lvc-text">${cleanVerseText(v.text)}</div>
    </div>
    <div class="lvc-actions">
      <button class="lvc-send-btn" title="Send to screen">Send</button>
    </div>
  `;
  // Send button → update viewer + ProPresenter
  const sendBtn = card.querySelector('.lvc-send-btn');
  sendBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    showInViewer([v], method || 'direct', 1.0);
    sendVerseToServer(v);
  });
  // Double-click anywhere on card → send to screen (no reorder)
  wireDoubleClickSend(card, () => {
    updateViewerDisplay(v);   // update preview only — card stays in place
    sendVerseToServer(v);
    // Flash feedback
    card.classList.add('sent-pulse');
    setTimeout(() => card.classList.remove('sent-pulse'), 600);
  });
  return card;
}

function updateSuggestionCount() {
  const count = queueList?.children.length ?? 0;
  if (suggestionCount) suggestionCount.textContent = count;
  const badge = document.getElementById('suggestion-count-badge');
  if (badge) badge.textContent = count;
}

// ── ProPresenter UI ────────────────────────────────────────────────────────
// ── Range navigation bar (docked below live screen) ────────────────────────
const rangeNavBar   = document.getElementById('range-nav-bar');
const rangeNavLabel = document.getElementById('range-nav-label');
const rangeNavRef   = document.getElementById('range-nav-ref');

// Wire the nav buttons once (they live in the HTML, not rebuilt per state)
document.getElementById('range-next-btn')?.addEventListener('click', async () => {
  try {
    const r = await fetch(`${SERVER}/api/range/next`, { method: 'POST' });
    const d = await r.json();
    if (!d.ok) toast(d.reason || 'Could not advance', 'error');
  } catch (err) { toast('Cannot reach server — is it running?', 'error'); }
});
document.getElementById('range-clear-btn')?.addEventListener('click', async () => {
  try {
    await fetch(`${SERVER}/api/range/clear`, { method: 'POST' });
  } catch (err) { toast('Cannot reach server — is it running?', 'error'); }
});

function handleRangeState({ remaining, total, next }) {
  // Range complete — hide nav bar, convert range cards to regular history
  // cards (keep them visible, just strip the range-specific styling).
  if (!remaining || !total) {
    if (rangeNavBar) rangeNavBar.style.display = 'none';
    currentDisplayCard?.querySelectorAll('.range-verse-card').forEach(el => {
      el.classList.remove('range-verse-card', 'range-active', 'range-queued');
      // Strip the blue range badge tint so it looks like a normal history card
      el.querySelector('.range-book-badge')?.classList.remove('range-book-badge');
    });
    rangeRefs = new Set();
    return;
  }

  // Show and update the nav bar docked below the live screen
  if (rangeNavBar) {
    rangeNavBar.style.display = 'flex';
    const current = total - remaining; // verses already shown (1-based)
    if (rangeNavLabel) rangeNavLabel.textContent = `Range  ${current} / ${total}`;
    if (rangeNavRef)   rangeNavRef.textContent   = next ? `→ ${next.reference}` : 'Last verse';
  }
}

// ── Range verse display ─────────────────────────────────────────────────────
// Called once when a range is first set — renders all verses into history grid
// with the active one highlighted. Subsequent 'range-active' events just shift
// the highlight as the sermon advances through the range.

function handleRangeVerses({ verses, activeRef }) {
  if (!currentDisplayCard || !verses?.length) return;

  // Mark all range refs so showInViewer dedup doesn't fight us
  rangeRefs = new Set(verses.map(v => v.reference));

  // Clear placeholders
  currentDisplayCard.querySelectorAll('.display-empty, .cs-queue-empty').forEach(el => el.remove());

  // Remove stale range cards from a previous range
  currentDisplayCard.querySelectorAll('.range-verse-card').forEach(el => el.remove());

  // Remove any existing sent/queue cards whose refs overlap with this range
  // (prevents duplicates when preacher calls a range that includes already-sent verses)
  if (rangeRefs.size) {
    currentDisplayCard.querySelectorAll('[data-ref]').forEach(el => {
      if (rangeRefs.has(el.dataset.ref)) el.remove();
    });
  }

  // Insert all range cards at the top, in their natural order. A single
  // insertBefore(fragment, firstChild) preserves the fragment's own child
  // order at the insertion point — unlike prepending nodes one at a time,
  // this does NOT need reversing to land verse 1 first; reversing here was
  // what put whole-chapter searches on screen highest-verse-first.
  const fragment = document.createDocumentFragment();
  for (const v of verses) {
    fragment.appendChild(buildRangeCard(v, v.reference === activeRef));
  }
  currentDisplayCard.insertBefore(fragment, currentDisplayCard.firstChild);

  // Update live preview to the active verse
  const active = verses.find(v => v.reference === activeRef) || verses[0];
  if (active) renderPreviewScreen(cleanVerseText(active.text), active.reference, null, active.translatedText || '');
}

function handleRangeActive(activeRef) {
  if (!currentDisplayCard || !activeRef) return;
  currentDisplayCard.querySelectorAll('.range-verse-card').forEach(card => {
    const isActive = card.dataset.ref === activeRef;
    card.classList.toggle('range-active', isActive);
    card.classList.toggle('range-queued', !isActive);
  });
  // Update live preview
  const activeCard = currentDisplayCard.querySelector(`.range-verse-card[data-ref="${activeRef}"]`);
  if (activeCard) {
    const refEl  = activeCard.querySelector('.lvc-ref');
    const textEl = activeCard.querySelector('.lvc-text');
    if (textEl) renderPreviewScreen(textEl.textContent, refEl?.textContent || '', null, activeCard.dataset.translatedText || '');
  }
}

function buildRangeCard(v, isActive) {
  const card = document.createElement('div');
  card.dataset.ref = v.reference;
  card.dataset.translatedText = v.translatedText || '';
  card.className   = 'range-verse-card locked-verse-card' + (isActive ? ' range-active' : ' range-queued');

  const abbr = refToBadgeAbbr(v.reference);

  card.innerHTML = `
    <div class="history-book-badge range-book-badge">${abbr}</div>
    <div class="history-card-content">
      <div class="lvc-ref">${v.reference}</div>
      <div class="lvc-text">${cleanVerseText(v.text || v.kjv_text || '')}</div>
    </div>
    <div class="lvc-actions">
      <button class="lvc-send-btn" title="Send to ProPresenter">Send</button>
    </div>
  `;

  const sendBtn = card.querySelector('.lvc-send-btn');
  sendBtn?.addEventListener('click', (e) => {
    e.stopPropagation();
    showInViewer([v], 'direct', 1.0);
    sendVerseToServer(v);
  });

  card.addEventListener('dblclick', (e) => {
    e.preventDefault();
    updateViewerDisplay(v);   // update preview only — card stays in place
    sendVerseToServer(v);
    card.classList.add('sent-pulse');
    setTimeout(() => card.classList.remove('sent-pulse'), 600);
  });

  return card;
}

function handlePPSuccess(verse) {
  updatePPStatus('Connected', 'connected');
  if (verse) {
    toast(`Sent: ${verse.reference || cleanVerseText(verse.text).slice(0, 40)}`, 'success');
    // This generic ProPresenter confirmation carries no theme/translation
    // info. If the preview already shows this exact content — almost
    // always because the 'detection' broadcast (which does carry the theme)
    // landed moments earlier for the same send — skip re-rendering plain
    // over it. Only actually update when this is telling us something new.
    const key = `${verse.reference || ''} ${verse.text || ''}`;
    if (lastPreviewWasThemed && key === lastPreviewKey) return;
    renderPreviewScreen(cleanVerseText(verse.text), verse.reference, null);
  }
}

function updatePPStatus(text, cls) {
  if (proPresenterStatus) proPresenterStatus.textContent = text;
  if (propresenterDot) {
    propresenterDot.className = 'bs-dot' + (cls ? ' ' + cls : '');
  }
}

async function checkPP() {
  try {
    const r = await fetch(`${SERVER}/api/propresenter/test`);
    const d = await r.json();
    if (d.success) updatePPStatus('Connected', 'connected');
    else           updatePPStatus('Not found', 'error');
  } catch { updatePPStatus('Offline', ''); }
}

async function sendVerseToServer(verse) {
  try {
    await fetch(`${SERVER}/api/propresenter/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verse }),
    });
  } catch (err) { toast('ProPresenter send failed: ' + err.message, 'error'); }
}

// ── Listening / Audio ──────────────────────────────────────────────────────
listenBtn?.addEventListener('click', async () => {
  if (isListening) {
    await stopListening();
  } else {
    await startListening();
  }
});

// Both engines use the same client-side audio capture: PCM16 over the
// existing WebSocket. Only the body of /api/start-listening differs —
// the server uses `engine` to choose between Deepgram (cloud) and whisper.cpp
// (offline, on-device).
async function startListening() {
  if (isListening) return;
  // New session — reset accumulators so Content Studio doesn't bundle the
  // previous sermon's transcript and verses into the next save. Counters and
  // timers are reset in handleConnectionState when we actually connect.
  sessionVerses = [];
  sessionTranscriptParts = [];
  confidenceSum   = 0;
  confidenceCount = 0;
  const engine = (settings.speechEngine || 'deepgram').toLowerCase();
  // Both the current 'offline' value and the legacy 'browser' value (the
  // Settings toggle's data-engine, kept as an alias for anyone with an old
  // saved setting) route to the server's whisper.cpp offline engine.
  const serverEngine = (engine === 'offline' || engine === 'browser') ? 'offline' : 'deepgram';
  try {
    const deviceId = audioSourceSettings?.value || '';
    const constraints = {
      audio: deviceId
        ? { deviceId: { exact: deviceId }, echoCancellation: true, noiseSuppression: true, sampleRate: 16000 }
        : { echoCancellation: true, noiseSuppression: true, sampleRate: 16000 },
    };
    mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
    if (micDisplay) micDisplay.textContent = mediaStream.getAudioTracks()[0]?.label || 'Microphone';

    // Start the server-side engine (Deepgram or whisper.cpp)
    const r = await fetch(`${SERVER}/api/start-listening`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ engine: serverEngine }),
    });
    const d = await r.json();
    if (d.error) { toast(d.error, 'error'); stopAudioCapture(); return; }

    // Stream PCM16 to server via WebSocket — same path for both engines.
    audioContext  = new AudioContext({ sampleRate: 16000 });
    const source  = audioContext.createMediaStreamSource(mediaStream);
    // 1024 samples @ 16 kHz = 64 ms of buffering latency (down from 256 ms
    // with the previous 4096 setting). Detection feels noticeably snappier
    // on direct citations. A future AudioWorklet migration would also move
    // this off the main UI thread, but 1024 is a safe drop-in.
    audioProcessor = audioContext.createScriptProcessor(1024, 1, 1);

    audioProcessor.onaudioprocess = (e) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const float32 = e.inputBuffer.getChannelData(0);
      const int16   = new Int16Array(float32.length);
      for (let i = 0; i < float32.length; i++) {
        int16[i] = Math.max(-32768, Math.min(32767, float32[i] * 32768));
      }
      ws.send(int16.buffer);
    };

    source.connect(audioProcessor);
    audioProcessor.connect(audioContext.destination);

    showEmptyTranscript(false);
  } catch (err) {
    toast('Mic error: ' + err.message, 'error');
    stopAudioCapture();
  }
}

async function stopListening() {
  await fetch(`${SERVER}/api/stop-listening`, { method: 'POST' }).catch(err => console.warn('[KAIRO] stop-listening request failed:', err.message));
  stopAudioCapture();
  clearInterval(elapsedInterval);
}

function stopAudioCapture() {
  if (audioProcessor) { try { audioProcessor.disconnect(); } catch {} audioProcessor = null; }
  if (audioContext)   { try { audioContext.close(); }       catch {} audioContext   = null; }
  if (mediaStream)    { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
}

// ── Custom Select Dropdowns ───────────────────────────────────────────────
// Replaces native <select> elements with a fully styled custom component.
// Usage: call initCustomSelects() after DOM is ready.
function buildCustomSelect(nativeSelect) {
  if (!nativeSelect || nativeSelect.dataset.customized) return;
  nativeSelect.dataset.customized = '1';
  nativeSelect.style.display = 'none';

  const wrapper = document.createElement('div');
  wrapper.className = 'cs-select-wrapper';

  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'cs-select-trigger setting-input';

  const triggerLabel = document.createElement('span');
  triggerLabel.className = 'cs-select-value';

  const triggerArrow = document.createElement('span');
  triggerArrow.className = 'cs-select-arrow';
  triggerArrow.innerHTML = `<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>`;

  trigger.appendChild(triggerLabel);
  trigger.appendChild(triggerArrow);

  const dropdown = document.createElement('div');
  dropdown.className = 'cs-select-dropdown';

  function buildOptions() {
    dropdown.innerHTML = '';
    Array.from(nativeSelect.options).forEach(opt => {
      const item = document.createElement('div');
      item.className = 'cs-select-option' + (opt.selected ? ' selected' : '');
      item.dataset.value = opt.value;
      item.textContent = opt.textContent;
      item.addEventListener('click', (e) => {
        e.stopPropagation();
        nativeSelect.value = opt.value;
        nativeSelect.dispatchEvent(new Event('change', { bubbles: true }));
        triggerLabel.textContent = opt.textContent;
        dropdown.querySelectorAll('.cs-select-option').forEach(o => o.classList.toggle('selected', o.dataset.value === opt.value));
        close();
      });
      dropdown.appendChild(item);
    });
    const sel = nativeSelect.options[nativeSelect.selectedIndex];
    if (sel) triggerLabel.textContent = sel.textContent;
  }

  function open() {
    dropdown.classList.add('open');
    trigger.classList.add('open');
    // Close all others
    document.querySelectorAll('.cs-select-dropdown.open').forEach(d => {
      if (d !== dropdown) { d.classList.remove('open'); d.closest('.cs-select-wrapper')?.querySelector('.cs-select-trigger')?.classList.remove('open'); }
    });
  }
  function close() {
    dropdown.classList.remove('open');
    trigger.classList.remove('open');
  }

  trigger.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.classList.contains('open') ? close() : open();
  });

  document.addEventListener('click', close);

  wrapper.appendChild(trigger);
  wrapper.appendChild(dropdown);
  nativeSelect.parentNode.insertBefore(wrapper, nativeSelect);
  nativeSelect.parentNode.insertBefore(nativeSelect, wrapper); // keep native before wrapper for form submit

  buildOptions();

  // Watch for programmatic changes to native select
  const observer = new MutationObserver(buildOptions);
  observer.observe(nativeSelect, { childList: true, attributes: true, subtree: true });
}

function initCustomSelects() {
  document.querySelectorAll('select.setting-input:not([data-customized])').forEach(buildCustomSelect);
}

// ── Toggle-group helpers (for .toggle-group in Settings) ─────────────────
function syncToggleGroup(groupId, dataKey, value) {
  const group = document.getElementById(groupId);
  if (!group || !value) return;
  group.querySelectorAll('.toggle-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset[dataKey] === value);
  });
  // Fire the change handler so dependent UI (hint text etc.) updates too.
  group.dispatchEvent(new CustomEvent('toggle-change', { detail: { value } }));
}
function readToggleGroup(groupId, dataKey) {
  const active = document.querySelector(`#${groupId} .toggle-btn.active`);
  return active?.dataset?.[dataKey] || null;
}

// ── Settings ───────────────────────────────────────────────────────────────
// Generic thumbnail/preview boxes (Stack/Grid cards, Media library cards,
// Full-scale edit's slide list — see var(--kairo-output-aspect, 16/9) in
// styles.css) always render at a fixed 16:9 (1920x1080) design default now,
// the same way ProPresenter's document canvas defaults to 1920x1080
// regardless of what's connected — they used to mirror whatever screen
// KAIRO's own UI happened to be running on, which made them misleading the
// moment a real projector or an odd-aspect LED wall was actually plugged in.
// The Live preview panel and Theme Studio's own canvas are the two places an
// operator legitimately wants to see a *specific* output's real shape — see
// applyLivePreviewAspect() and renderPreview()'s canvas-size handling, which
// set their own inline aspect-ratio rather than touching this shared
// default. Deliberately NOT the same thing as KAIRO_DESIGN_W/H
// (design_space.js) — that's the fixed 1920x1080 canvas Theme Studio
// authors layer positions against, and must stay fixed or every existing
// theme's layout would silently shift; this is purely the CSS box shape.

async function loadSettings() {
  try {
    const r = await fetch(`${SERVER}/api/settings`);
    settings = await r.json();
    // Populate UI
    // The server sends deepgramApiKey MASKED ("abcd1234…") for display, never
    // the real key. It used to go straight into the input's editable .value —
    // which meant ANY settings save (even for an unrelated field) round-
    // tripped that masked string back to the server and silently clobbered
    // the real stored key with 8 characters + an ellipsis, permanently
    // breaking Deepgram until the user re-entered it from scratch. Leaving
    // the field empty with a placeholder is the standard secret-field
    // pattern: shows a key is set without making the masked text itself
    // editable/save-able. saveCurrentSettings only sends deepgramApiKey when
    // this field is actually non-empty (i.e. the user typed a real one).
    if (deepgramKeyInput) {
      deepgramKeyInput.value = '';
      deepgramKeyInput.placeholder = settings.deepgramApiKey
        ? `Key saved (${settings.deepgramApiKey}) — leave blank to keep`
        : 'Paste your Deepgram API key';
    }
    if (ppUrlInput && settings.proPresenterUrl) ppUrlInput.value = settings.proPresenterUrl;
    if (translationSettings && settings.translation) translationSettings.value = settings.translation;
    if (translationSelect && settings.translation)   translationSelect.value   = settings.translation;
    if (autoSendCheckbox)  autoSendCheckbox.checked  = settings.autoSend  !== false;
    if (autoSendSettings)  autoSendSettings.checked  = settings.autoSend  !== false;
    if (showConfSettings)  showConfSettings.checked   = settings.showConfidence !== false;
    if (ppEnabledToggle)    ppEnabledToggle.checked    = settings.proPresenterEnabled !== false;
    if (obsEnabledToggle)   obsEnabledToggle.checked   = settings.obsEnabled === true;
    if (obsUrlInput && settings.obsUrl) obsUrlInput.value = settings.obsUrl;
    if (obsPasswordInput && settings.obsPassword) obsPasswordInput.value = settings.obsPassword;
    if (obsTextSourceInput && settings.obsTextSource) obsTextSourceInput.value = settings.obsTextSource;
    const ollamaUrlInput   = document.getElementById('ollama-url');
    const ollamaModelSel   = document.getElementById('ollama-model');
    if (ollamaUrlInput) ollamaUrlInput.value = settings.ollamaUrl || 'http://localhost:11434';
    populateOllamaModels(settings.ollamaModel || 'qwen2.5:7b-instruct');
    // Restore toggle-group state from persisted settings
    syncToggleGroup('speech-engine-toggle', 'engine', settings.speechEngine || 'deepgram');
    syncToggleGroup('audio-mode-toggle',    'mode',   settings.audioMode    || 'mic');
    updatePPTokenLabel();
    initCustomSelects();
    // Per-output theme pickers live inside each output card.
    renderOutputThemePickers();
    renderDisplayOutputs();
    // Language
    const sttLang = document.getElementById('stt-language');
    if (sttLang) sttLang.value = settings.sttLanguage || 'en-US';
    const bibleLang = document.getElementById('bible-language');
    if (bibleLang) bibleLang.value = settings.bibleLanguage || 'en';
    renderLangPacks();
    // First-run: no Deepgram key → show a nudge banner so the user knows what to do.
    showFirstRunBannerIfNeeded(settings);
  } catch (err) {
    console.warn('[Settings] Load failed:', err);
    toast('Could not load settings from server', 'error');
  }
}

// ── First-run onboarding modal ─────────────────────────────────────────────
// Dismissible centered overlay prompting for the Deepgram key. Dismissed (Skip
// or close) it stays hidden for the session; reappears next launch until a key
// is saved.
let firstRunDismissed = false;
function showFirstRunBannerIfNeeded(s) {
  const modal = document.getElementById('first-run-modal');
  if (!modal) return;
  if (s && s.deepgramApiKey) {
    // Key is set — make sure the modal is closed.
    modal.classList.add('hidden');
    return;
  }
  if (firstRunDismissed || !modal.classList.contains('hidden')) return; // dismissed or already showing
  modal.classList.remove('hidden');
  const input = document.getElementById('first-run-deepgram-key');
  if (input) input.value = '';
  // Defer focus so the overlay has laid out before we focus inside it.
  setTimeout(() => input?.focus(), 50);
}

function closeFirstRunModal() {
  firstRunDismissed = true;
  document.getElementById('first-run-modal')?.classList.add('hidden');
}

async function saveFirstRunKey() {
  const input = document.getElementById('first-run-deepgram-key');
  const key   = (input?.value || '').trim();
  if (!key) { closeFirstRunModal(); return; }
  // Mirror into the Settings field so the rest of the app stays in sync, then
  // persist through the same endpoint saveCurrentSettings uses.
  if (deepgramKeyInput) deepgramKeyInput.value = key;
  try {
    await fetch(`${SERVER}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...settings, deepgramApiKey: key }),
    });
    settings = { ...settings, deepgramApiKey: key };
    toast('Deepgram key saved', 'success');
  } catch {
    toast('Could not save key — try again in Settings', 'error');
  }
  closeFirstRunModal();
}

async function saveCurrentSettings() {
  const updated = {
    // Only include deepgramApiKey when the (now-blank-by-default) field
    // actually has something typed into it — an empty field means "keep
    // whatever's already saved", not "erase the key". See loadSettings for
    // why this field starts empty instead of pre-filled with the masked
    // value.
    ...(deepgramKeyInput?.value ? { deepgramApiKey: deepgramKeyInput.value } : {}),
    proPresenterUrl:   ppUrlInput?.value          || 'http://localhost:1025',
    translation:       translationSettings?.value || 'KJV',
    ppSwapTokenOrder:  settings.ppSwapTokenOrder  || false,
    autoSend:          autoSendSettings?.checked  !== false,
    showConfidence:    showConfSettings?.checked   !== false,
    proPresenterEnabled: ppEnabledToggle?.checked !== false,
    obsEnabled:          obsEnabledToggle?.checked === true,
    obsUrl:              obsUrlInput?.value        || 'ws://localhost:4455',
    obsPassword:         obsPasswordInput?.value   || '',
    obsTextSource:       obsTextSourceInput?.value || 'Scripture',
    speechEngine:        readToggleGroup('speech-engine-toggle', 'engine') || settings.speechEngine || 'deepgram',
    audioMode:           readToggleGroup('audio-mode-toggle',    'mode')   || settings.audioMode    || 'mic',
    ollamaUrl:           document.getElementById('ollama-url')?.value || 'http://localhost:11434',
    ollamaModel:         document.getElementById('ollama-model')?.value || settings.ollamaModel || 'qwen2.5:7b-instruct',
  };
  try {
    await fetch(`${SERVER}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updated),
    });
  } catch (err) {
    toast('Could not save settings: ' + err.message, 'error');
    return;
  }
  settings = { ...settings, ...updated };
  if (translationSelect && updated.translation) translationSelect.value = updated.translation;
  // Dismiss first-run banner now that a key may have been entered.
  showFirstRunBannerIfNeeded(settings);
  closeModal();
  toast('Settings saved', 'success');
  checkPP();
}

// Default recommended model — reflected in the status panel + first-run pulls.
const DEFAULT_OLLAMA_MODEL = 'qwen2.5:7b-instruct';

let activePullController = null; // AbortController for in-flight pull (so Cancel works)

async function populateOllamaModels(preferred) {
  const sel    = document.getElementById('ollama-model');
  const hint   = document.getElementById('ollama-status-hint');
  const panel  = document.getElementById('ollama-status-panel');
  if (!sel || !panel) return;

  let j = { ok: false };
  try {
    const r = await fetch(`${SERVER}/api/llm/status`);
    j = await r.json();
  } catch {}

  // ── Populate dropdown ────────────────────────────────────────────────
  sel.innerHTML = '';
  const desired = preferred || j.configuredModel || DEFAULT_OLLAMA_MODEL;
  const models  = j.ok ? (j.models || []) : [];
  if (!j.ok) {
    const opt = document.createElement('option');
    opt.value = desired;
    opt.textContent = 'Ollama not reachable';
    sel.appendChild(opt);
  } else if (!models.length) {
    const opt = document.createElement('option');
    opt.value = desired;
    opt.textContent = desired + ' (not installed)';
    sel.appendChild(opt);
  } else {
    for (const name of models) {
      const opt = document.createElement('option');
      opt.value = name;
      opt.textContent = name;
      if (name === desired) opt.selected = true;
      sel.appendChild(opt);
    }
    if (desired && !models.includes(desired)) {
      const opt = document.createElement('option');
      opt.value = desired;
      opt.textContent = desired + ' (not installed)';
      opt.selected = true;
      sel.appendChild(opt);
    }
  }
  if (hint) {
    hint.textContent = j.ok && models.length
      ? `${models.length} model${models.length === 1 ? '' : 's'} installed.`
      : `Recommended: ${DEFAULT_OLLAMA_MODEL}. Click Download in the panel above.`;
  }

  // ── Status panel (state-aware) ───────────────────────────────────────
  if (activePullController) return; // pull in progress — leave panel alone
  renderOllamaStatusPanel(j, desired, models);
}

function renderOllamaStatusPanel(status, model, models) {
  const panel = document.getElementById('ollama-status-panel');
  if (!panel) return;

  // State 1 — Ollama not running
  if (!status.ok) {
    panel.className = 'osp osp-err';
    panel.innerHTML = `
      <div class="osp-row">
        <span class="osp-dot"></span>
        <span class="osp-title">Ollama not running</span>
      </div>
      <p class="osp-msg">Install once — runs offline, no API key, no telemetry.</p>
      <div class="osp-actions">
        <a href="https://ollama.com/download" target="_blank" rel="noopener" class="osp-btn osp-btn-primary">Get Ollama →</a>
        <button class="osp-btn osp-btn-ghost" id="osp-recheck-btn">Re-check</button>
      </div>`;
    panel.querySelector('#osp-recheck-btn')?.addEventListener('click', () => populateOllamaModels(model));
    return;
  }

  // State 2 — Ollama running, model not installed
  if (!models.includes(model)) {
    const sizeHint = (model || '').includes('7b') ? '~4.5 GB' :
                     (model || '').includes('3b') ? '~2 GB'   :
                     (model || '').includes('13b')? '~7 GB'   : '';
    panel.className = 'osp osp-warn';
    panel.innerHTML = `
      <div class="osp-row">
        <span class="osp-dot"></span>
        <span class="osp-title">Ollama ready, model not installed</span>
      </div>
      <p class="osp-msg"><code>${escapeHtml(model)}</code> ${sizeHint ? `· ${sizeHint}` : ''} · download takes a few minutes the first time.</p>
      <div class="osp-actions">
        <button class="osp-btn osp-btn-primary" id="osp-pull-btn">Download model</button>
      </div>`;
    panel.querySelector('#osp-pull-btn')?.addEventListener('click', () => pullModel(model));
    return;
  }

  // State 3 — Ready
  panel.className = 'osp osp-ok';
  panel.innerHTML = `
    <div class="osp-row">
      <span class="osp-dot"></span>
      <span class="osp-title">Ready · <strong>${escapeHtml(model)}</strong></span>
    </div>
    <p class="osp-msg">Offline AI is set up. Open Content Studio to generate notes.</p>`;
}

async function pullModel(modelName) {
  const panel = document.getElementById('ollama-status-panel');
  if (!panel) return;
  if (activePullController) return; // already pulling

  panel.className = 'osp osp-progress';
  panel.innerHTML = `
    <div class="osp-row">
      <span class="osp-dot pulse"></span>
      <span class="osp-title">Downloading <strong>${escapeHtml(modelName)}</strong></span>
    </div>
    <div class="osp-progress-status" id="osp-progress-status">Connecting to Ollama…</div>
    <div class="osp-progress-bar"><div class="osp-progress-fill" id="osp-progress-fill" style="width:0%"></div></div>
    <div class="osp-progress-meta" id="osp-progress-meta"></div>
    <div class="osp-actions">
      <button class="osp-btn osp-btn-ghost" id="osp-cancel-btn">Cancel</button>
    </div>`;

  const statusEl = panel.querySelector('#osp-progress-status');
  const fillEl   = panel.querySelector('#osp-progress-fill');
  const metaEl   = panel.querySelector('#osp-progress-meta');
  const cancelBtn= panel.querySelector('#osp-cancel-btn');

  activePullController = new AbortController();
  cancelBtn.addEventListener('click', () => {
    if (activePullController) activePullController.abort();
  });

  // Track totals across the pull so we can show overall progress.
  // Ollama reports per-layer {digest, completed, total}; we track each digest.
  const layers = new Map(); // digest -> { total, completed }

  function fmtBytes(n) {
    if (!n && n !== 0) return '';
    if (n < 1024) return `${n} B`;
    if (n < 1024**2) return `${(n/1024).toFixed(1)} KB`;
    if (n < 1024**3) return `${(n/1024**2).toFixed(1)} MB`;
    return `${(n/1024**3).toFixed(2)} GB`;
  }

  function applyProgress(msg) {
    if (msg.error) { statusEl.textContent = 'Error: ' + msg.error; return; }
    if (msg.status) statusEl.textContent = msg.status.charAt(0).toUpperCase() + msg.status.slice(1);
    if (msg.digest && msg.total != null) {
      layers.set(msg.digest, { total: msg.total, completed: msg.completed || 0 });
    }
    let totalAll = 0, doneAll = 0;
    for (const { total, completed } of layers.values()) {
      totalAll += total;
      doneAll  += completed;
    }
    if (totalAll > 0) {
      const pct = Math.min(99.9, (doneAll / totalAll) * 100);
      fillEl.style.width = pct.toFixed(1) + '%';
      metaEl.textContent = `${fmtBytes(doneAll)} / ${fmtBytes(totalAll)} · ${pct.toFixed(0)}%`;
    }
    if (msg.status === 'success') {
      fillEl.style.width = '100%';
      metaEl.textContent = 'Done';
    }
  }

  try {
    const r = await fetch(`${SERVER}/api/llm/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: modelName }),
      signal: activePullController.signal,
    });
    if (!r.ok || !r.body) throw new Error('stream failed');
    const reader  = r.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try { applyProgress(JSON.parse(line)); } catch {}
      }
    }
    activePullController = null;
    toast('Model downloaded', 'success');
    populateOllamaModels(modelName);
  } catch (e) {
    activePullController = null;
    if (e.name === 'AbortError') {
      toast('Download cancelled', 'info');
    } else {
      toast('Download failed: ' + e.message, 'error');
    }
    populateOllamaModels(modelName);
  }
}

document.getElementById('refresh-ollama-btn')?.addEventListener('click', () => {
  const sel = document.getElementById('ollama-model');
  populateOllamaModels(sel?.value);
});

function updatePPTokenLabel() {
  if (!ppTokenOrderLabel) return;
  const swapped = settings.ppSwapTokenOrder;
  ppTokenOrderLabel.textContent = swapped
    ? 'Token[0] = Reference · Token[1] = Verse Text'
    : 'Token[0] = Verse Text · Token[1] = Reference';
}

settingsBtn?.addEventListener('click',    () => { settingsModal?.classList.remove('hidden'); showFirstSettingsPane(); });
closeSettingsBtn?.addEventListener('click', closeModal);
cancelSettingsBtn?.addEventListener('click', closeModal);
saveSettingsBtn?.addEventListener('click',  saveCurrentSettings);
document.querySelector('.modal-overlay')?.addEventListener('click', closeModal);

// First-run Deepgram modal wiring
document.getElementById('first-run-save')?.addEventListener('click', saveFirstRunKey);
document.getElementById('first-run-skip')?.addEventListener('click', closeFirstRunModal);
document.getElementById('close-first-run')?.addEventListener('click', closeFirstRunModal);
document.querySelector('#first-run-modal .modal-overlay')?.addEventListener('click', closeFirstRunModal);
document.getElementById('first-run-deepgram-key')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveFirstRunKey();
});

testPPBtn?.addEventListener('click', async () => {
  testPPBtn.textContent = 'Testing…';
  const r   = await fetch(`${SERVER}/api/propresenter/test`);
  const d   = await r.json();
  testPPBtn.textContent = 'Test';
  if (d.success) { updatePPStatus('Connected', 'connected'); toast('ProPresenter connected: ' + d.version, 'success'); }
  else           { updatePPStatus('Not found', 'error');     toast('ProPresenter: ' + d.error, 'error'); }
});

testObsBtn?.addEventListener('click', async () => {
  testObsBtn.textContent = 'Testing…';
  if (obsStatusEl) obsStatusEl.textContent = '';
  try {
    const r = await fetch(`${SERVER}/api/obs/test`);
    const d = await r.json();
    testObsBtn.textContent = 'Test';
    if (d.success) {
      if (obsStatusEl) { obsStatusEl.textContent = 'Connected (OBS ' + d.version + ')'; obsStatusEl.style.color = 'var(--green)'; }
      toast('OBS connected: v' + d.version, 'success');
    } else {
      if (obsStatusEl) { obsStatusEl.textContent = 'Failed: ' + d.error; obsStatusEl.style.color = 'var(--red)'; }
      toast('OBS: ' + d.error, 'error');
    }
  } catch (e) {
    testObsBtn.textContent = 'Test';
    if (obsStatusEl) { obsStatusEl.textContent = 'Error: ' + e.message; obsStatusEl.style.color = 'var(--red)'; }
  }
});

swapPPBtn?.addEventListener('click', async () => {
  settings.ppSwapTokenOrder = !settings.ppSwapTokenOrder;
  updatePPTokenLabel();
  try {
    await fetch(`${SERVER}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ppSwapTokenOrder: settings.ppSwapTokenOrder }),
    });
  } catch (err) { toast('Could not save setting: ' + err.message, 'error'); }
});

autoSendCheckbox?.addEventListener('change', async () => {
  settings.autoSend = autoSendCheckbox.checked;
  if (autoSendSettings) autoSendSettings.checked = autoSendCheckbox.checked;
  try {
    await fetch(`${SERVER}/api/settings`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ autoSend: settings.autoSend }) });
  } catch (err) { toast('Could not save setting: ' + err.message, 'error'); }
});

function closeModal() { settingsModal?.classList.add('hidden'); }

// ── Scripture Search ───────────────────────────────────────────────────────
scriptureSearchBtn?.addEventListener('click', runSearch);
scriptureSearchInput?.addEventListener('keydown', (e) => { if (e.key === 'Enter') runSearch(); });
scriptureSearchInput?.addEventListener('input', () => {
  if (scriptureSearchClear) scriptureSearchClear.style.display = scriptureSearchInput.value ? 'flex' : 'none';
});
scriptureSearchClear?.addEventListener('click', () => {
  if (scriptureSearchInput) scriptureSearchInput.value = '';
  if (scriptureSearchClear) scriptureSearchClear.style.display = 'none';
});

async function runSearch() {
  const raw = scriptureSearchInput?.value?.trim();
  if (!raw) return;

  // Visual feedback — dim the button while searching
  if (scriptureSearchBtn) scriptureSearchBtn.style.opacity = '0.5';

  try {
    const r = await fetch(`${SERVER}/api/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: raw }),
    });

    if (!r.ok) {
      // Server-side error (500, 400 etc.) — try text fallback
      const err = await r.json().catch(() => ({}));
      console.warn('[Search] Server error:', err);
      toast('Search error — try again', 'error');
      return;
    }

    const d = await r.json();
    console.log('[Search] response:', d.method, d.result?.reference ?? (d.results?.length + ' text hits'));

    if (d.result) {
      // Reference hit — send to viewer + ProPresenter immediately
      const allVerses = d.range?.length > 1 ? d.range : [d.result];
      if (allVerses.length > 1) {
        // Range — let the WS broadcast handle the range-verses event,
        // but also seed the viewer with the first verse right now
        showInViewer(allVerses, d.method || 'direct', 1.0);
      } else {
        showInViewer([d.result], d.method || 'direct', 1.0);
      }
      sendVerseToServer(d.result);
      // Keep the text so the user can quickly extend to a range (e.g. add "-18")
      if (scriptureSearchInput) {
        scriptureSearchInput.select(); // select all → ready to retype or append
      }

    } else if (d.results?.length) {
      // Phrase / keyword search → show as candidates
      showInSuggestions(d.results, d.method || 'search');

    } else {
      toast(`No match for "${raw}"`, 'error');
    }

  } catch (err) {
    console.error('[Search] fetch failed:', err);
    toast('Cannot reach server — is it running?', 'error');
  } finally {
    if (scriptureSearchBtn) scriptureSearchBtn.style.opacity = '';
  }
}


// ── Clear buttons ──────────────────────────────────────────────────────────
clearLockedBtn?.addEventListener('click', async () => {
  if (currentDisplayCard) {
    currentDisplayCard.innerHTML = '<div class="cs-queue-empty">Sent verses and range queues appear here…</div>';
  }
  rangeRefs = new Set();
  renderPreviewScreen('Nothing on display', '', null);
  await fetch(`${SERVER}/api/propresenter/clear`, { method: 'POST' }).catch(err => console.warn('[KAIRO] propresenter/clear request failed:', err.message));
});

clearSuggestionsBtn?.addEventListener('click', () => {
  if (queueList) queueList.innerHTML = '<div class="display-empty">Contextual detections appear here</div>';
  if (suggestionCount) suggestionCount.textContent = '0';
});

// ── Per-layer output clear ──────────────────────────────────────────────
// The output composites two independent layers (see display.html); each
// clears on its own without touching the other or the ProPresenter/NDI/
// Syphon outputs, which have their own clear via the Live Queue's button.
// A genuine clear, not "nothing sent yet" — renderPreviewScreen(text, ref,
// null) falls back to the output's own assigned theme (primaryOutputLook()),
// so the operator's status card kept showing that theme's background/layout
// behind "Nothing on display" instead of reading as unambiguously blank.
// This bypasses that fallback entirely: plain text, theme layer hidden, full
// stop — matching what "cleared" is supposed to communicate.
function clearPreviewScreen() {
  const themed = document.getElementById('slide-preview-themed');
  const plain  = document.querySelector('#slide-preview .live-screen-inner');
  themed?.classList.add('hidden');
  plain?.classList.remove('hidden');
  // Only show the placeholder if media isn't covering for it — otherwise
  // it'd sit as stray text over whatever image/video is currently showing.
  const mediaShowing = !document.getElementById('slide-preview-media')?.classList.contains('hidden');
  if (previewVerseText) previewVerseText.textContent = mediaShowing ? '' : 'Nothing on display';
  if (previewVerseRef)  previewVerseRef.textContent  = '';
  lastPreviewKey = ' ';
  lastPreviewWasThemed = false;
  lastPreviewHadOwnLook = false;
}

function clearOutputLayer(layer) {
  fetch(`${SERVER}/api/service/clear-layer`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ layer }),
  }).catch(err => console.warn('[KAIRO] clear-layer request failed:', err.message));
  if (layer === 'slide' || layer === 'all') clearPreviewScreen();
  if (layer === 'media' || layer === 'all') clearMediaPreview();
}
document.getElementById('clear-slide-layer-btn')?.addEventListener('click', () => clearOutputLayer('slide'));
document.getElementById('clear-media-layer-btn')?.addEventListener('click', () => clearOutputLayer('media'));
document.getElementById('clear-all-layers-btn')?.addEventListener('click', () => clearOutputLayer('all'));

clearTranscriptBtn?.addEventListener('click', () => {
  showEmptyTranscript(true);
  wordCount = 0;
  if (wordCountEl) wordCountEl.textContent = '0';
});

// ── Audio device enumeration ───────────────────────────────────────────────
async function populateAudioDevices() {
  if (!audioSourceSettings) return;
  try {
    await navigator.mediaDevices.getUserMedia({ audio: true });
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics    = devices.filter(d => d.kind === 'audioinput');
    audioSourceSettings.innerHTML = '';
    mics.forEach(d => {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || `Microphone ${d.deviceId.slice(0, 6)}`;
      audioSourceSettings.appendChild(o);
    });
  } catch {}
}

refreshDevicesBtn?.addEventListener('click', populateAudioDevices);

// ── Media layer audio output device ─────────────────────────────────────
// Applied in display.html via HTMLMediaElement.setSinkId() — this picker
// just enumerates 'audiooutput' devices and tells the display which one to
// use; the display falls back to the system default if setSinkId isn't
// supported by its WebView (e.g. WebKit doesn't implement it as of writing).
const mediaOutputSettings   = document.getElementById('media-output-settings');
const refreshOutputDevicesBtn = document.getElementById('refresh-output-devices-settings');
const MEDIA_OUTPUT_KEY = 'kairo-media-output-device';

async function populateAudioOutputDevices() {
  if (!mediaOutputSettings) return;
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const outputs = devices.filter(d => d.kind === 'audiooutput');
    const saved = localStorage.getItem(MEDIA_OUTPUT_KEY) || '';
    mediaOutputSettings.innerHTML = '';
    const dflt = document.createElement('option');
    dflt.value = ''; dflt.textContent = 'System default';
    mediaOutputSettings.appendChild(dflt);
    outputs.forEach(d => {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || `Output ${d.deviceId.slice(0, 6)}`;
      if (d.deviceId === saved) o.selected = true;
      mediaOutputSettings.appendChild(o);
    });
  } catch {}
}
refreshOutputDevicesBtn?.addEventListener('click', populateAudioOutputDevices);
mediaOutputSettings?.addEventListener('change', () => {
  const deviceId = mediaOutputSettings.value || '';
  localStorage.setItem(MEDIA_OUTPUT_KEY, deviceId);
  fetch(`${SERVER}/api/service/audio-output`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId: deviceId || null }),
  }).catch(() => {});
});
populateAudioOutputDevices();
// Re-apply the saved device to a freshly (re)connected display window —
// otherwise it only ever learns the choice from a change event, not on
// its own (re)connect.
(function reapplySavedAudioOutput() {
  const deviceId = localStorage.getItem(MEDIA_OUTPUT_KEY) || '';
  if (!deviceId) return;
  fetch(`${SERVER}/api/service/audio-output`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ deviceId }),
  }).catch(() => {});
})();

// ── Offline (whisper.cpp) model installer UI ─────────────────────────────
// Shown only when the Speech Engine toggle is set to "Offline". Streams
// NDJSON progress events from POST /api/whisper/install into a progress bar
// so the operator doesn't have to drop to a terminal to run npm scripts.
// Normally the startup bootstrap (bootstrapStartup()) already fetched this
// model before the operator ever opens Settings — this panel is the manual
// fallback for a first install that was skipped, interrupted, or run offline.
(function wireWhisperInstaller() {
  const group       = document.getElementById('whisper-installer-group');
  const statusLine  = document.getElementById('whisper-status-line');
  const installBtn  = document.getElementById('whisper-install-btn');
  const progressWrap = document.getElementById('whisper-progress-wrap');
  const progressBar  = document.getElementById('whisper-progress-bar');
  const progressText = document.getElementById('whisper-progress-text');
  const engineToggle = document.getElementById('speech-engine-toggle');
  if (!group || !installBtn) return;

  async function refreshStatus() {
    try {
      const r = await fetch(`${SERVER}/api/whisper/status`);
      const s = await r.json();
      if (s.installed) {
        statusLine.textContent = '✓ Offline model installed';
        statusLine.style.color = 'var(--accent)';
        installBtn.style.display = 'none';
      } else if (s.installing) {
        statusLine.textContent = 'Install in progress…';
        installBtn.style.display = 'none';
      } else {
        statusLine.textContent = 'Offline model not installed.';
        statusLine.style.color = '';
        installBtn.style.display = '';
      }
    } catch {
      statusLine.textContent = 'Cannot reach server.';
    }
  }

  // Show/hide the whole widget based on which engine is selected. The toggle
  // dispatches a custom click; we just react to any click inside it.
  function syncVisibility() {
    const active = engineToggle?.querySelector('.toggle-btn.active');
    const isOffline = active?.dataset.engine === 'browser';
    group.style.display = isOffline ? '' : 'none';
    if (isOffline) refreshStatus();
  }
  engineToggle?.addEventListener('click', () => setTimeout(syncVisibility, 0));
  syncVisibility();

  installBtn.addEventListener('click', async () => {
    installBtn.style.display = 'none';
    progressWrap.style.display = '';
    progressBar.style.width = '0%';
    progressText.textContent = 'Connecting…';

    let res;
    try {
      res = await fetch(`${SERVER}/api/whisper/install`, { method: 'POST' });
    } catch (err) {
      progressText.textContent = `Failed: ${err.message}`;
      installBtn.style.display = '';
      return;
    }
    if (!res.ok || !res.body) {
      progressText.textContent = `HTTP ${res.status}`;
      installBtn.style.display = '';
      return;
    }

    // Stream NDJSON lines — each line is one progress event from the
    // installer module. We keep a rolling buffer so partial lines stitch
    // back together at the next chunk boundary.
    const reader  = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop();   // last fragment may be incomplete
      for (const line of lines) {
        if (!line.trim()) continue;
        let evt;
        try { evt = JSON.parse(line); } catch { continue; }
        if (evt.phase === 'download' && typeof evt.pct === 'number') {
          progressBar.style.width = evt.pct + '%';
          progressText.textContent = `Downloading… ${evt.pct}%`;
        } else if (evt.phase === 'extract') {
          progressBar.style.width = '100%';
          progressText.textContent = 'Extracting…';
        } else if (evt.phase === 'done') {
          progressText.textContent = evt.already ? 'Already installed.' : 'Done.';
        } else if (evt.phase === 'complete') {
          if (evt.ok) {
            progressText.textContent = 'Installed.';
            setTimeout(() => { progressWrap.style.display = 'none'; refreshStatus(); }, 1500);
          } else {
            progressText.textContent = `Failed: ${evt.error || 'unknown error'}`;
            installBtn.style.display = '';
          }
        }
      }
    }
  });
})();

// ── Local translation-model installer UI ─────────────────────────────────
// Same NDJSON-progress pattern as the Whisper installer above, for the
// bundled Opus-MT/NLLB models translate.js uses for non-scripture slide text
// (see mt_engine.js/mt_installer.js). French/Spanish/Portuguese are three
// independent downloads — a French-only operator never pays for Portuguese
// — so this renders one row per language, each with its own status/button,
// mirroring the Scripture Packs list just above it in the same pane.
// Downloads can also have been started server-side already (translate.js
// kicks one off in the background the first time that language is actually
// needed), so each row polls while its own install is in progress instead
// of only reacting to its own button click.
const MT_LANGUAGES = [
  { code: 'fr', name: 'French' },
  { code: 'es', name: 'Spanish' },
  { code: 'pt', name: 'Portuguese' },
];
const _mtPollTimers = {};

function renderMtModelList() {
  const host = document.getElementById('mt-model-list');
  if (!host) return;
  host.innerHTML = '';
  MT_LANGUAGES.forEach(({ code, name }) => {
    const row = document.createElement('div');
    row.className = 'lang-pack-row';

    const meta = document.createElement('div');
    meta.className = 'lang-pack-meta';
    meta.innerHTML = `<div class="lang-pack-name">${name}</div><div class="lang-pack-sub" id="mt-sub-${code}">Checking…</div>`;

    const btn = document.createElement('button');
    btn.className = 'modal-btn secondary';
    btn.id = `mt-btn-${code}`;
    btn.style.display = 'none';
    btn.addEventListener('click', () => installMtModel(code));

    row.appendChild(meta);
    row.appendChild(btn);
    host.appendChild(row);

    refreshMtStatus(code);
  });
}

async function refreshMtStatus(code) {
  const sub = document.getElementById(`mt-sub-${code}`);
  const btn = document.getElementById(`mt-btn-${code}`);
  if (!sub || !btn) return;
  try {
    const r = await fetch(`${SERVER}/api/translate-model/status?lang=${code}`);
    const s = await r.json();
    if (s.installed) {
      sub.textContent = '✓ Installed';
      sub.style.color = 'var(--accent)';
      btn.style.display = 'none';
      clearInterval(_mtPollTimers[code]); delete _mtPollTimers[code];
    } else if (s.installing) {
      sub.textContent = 'Downloading in the background…';
      sub.style.color = '';
      btn.style.display = 'none';
      if (!_mtPollTimers[code]) _mtPollTimers[code] = setInterval(() => refreshMtStatus(code), 2000);
    } else {
      sub.textContent = `Not downloaded${s.approxMB ? ` (~${s.approxMB}MB)` : ''}`;
      sub.style.color = '';
      btn.textContent = 'Download';
      btn.style.display = '';
      clearInterval(_mtPollTimers[code]); delete _mtPollTimers[code];
    }
  } catch {
    sub.textContent = 'Cannot reach server.';
  }
}

async function installMtModel(code) {
  const sub = document.getElementById(`mt-sub-${code}`);
  const btn = document.getElementById(`mt-btn-${code}`);
  if (!sub || !btn) return;
  btn.style.display = 'none';
  sub.textContent = 'Connecting…';

  let res;
  try {
    res = await fetch(`${SERVER}/api/translate-model/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lang: code }),
    });
  } catch (err) {
    sub.textContent = `Failed: ${err.message}`;
    btn.style.display = '';
    return;
  }
  if (!res.ok || !res.body) {
    sub.textContent = `HTTP ${res.status}`;
    btn.style.display = '';
    return;
  }

  const reader  = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += decoder.decode(value, { stream: true });
    const lines = buf.split('\n');
    buf = lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      let evt;
      try { evt = JSON.parse(line); } catch { continue; }
      if (evt.phase === 'download' && typeof evt.pct === 'number') {
        sub.textContent = `Downloading… ${evt.pct}%`;
      } else if (evt.phase === 'done') {
        sub.textContent = evt.already ? 'Already installed.' : 'Done.';
      } else if (evt.phase === 'complete') {
        if (evt.ok) {
          setTimeout(() => refreshMtStatus(code), 800);
        } else {
          sub.textContent = `Failed: ${evt.error || 'unknown error'}`;
          btn.style.display = '';
        }
      }
    }
  }
}

renderMtModelList();

// Auto-refresh the mic list when a USB headset / interface is plugged in or
// out. The OS fires a single `devicechange` for the event but Chromium often
// emits 2-3 in quick succession during enumeration — debounce so we don't
// thrash the dropdown.
let _deviceChangeTimer = null;
navigator.mediaDevices?.addEventListener?.('devicechange', () => {
  clearTimeout(_deviceChangeTimer);
  _deviceChangeTimer = setTimeout(populateAudioDevices, 250);
});

// ── Top-bar download menu ──────────────────────────────────────────────────
// One canonical place for all downloadable content: AI-generated sermon
// note/points (PDF, opens print-window flow) and live-session transcript +
// verse list (.txt). Each handler decides whether the requested artifact is
// available right now and falls back to opening Content Studio if not.
(function wireDownloadMenu() {
  const menu = document.getElementById('download-menu');
  if (!exportBtn || !menu) return;

  function openMenu() {
    menu.classList.remove('hidden');
    exportBtn.setAttribute('aria-expanded', 'true');
    // Defer outside-click binding by a tick so this same click doesn't close it.
    setTimeout(() => document.addEventListener('click', outsideClickClose, { once: true }), 0);
  }
  function closeMenu() {
    menu.classList.add('hidden');
    exportBtn.setAttribute('aria-expanded', 'false');
  }
  function outsideClickClose(e) {
    if (e.target.closest('#download-menu') || e.target.closest('#export-btn')) {
      // Click was inside — re-arm the listener for the next outside click.
      setTimeout(() => document.addEventListener('click', outsideClickClose, { once: true }), 0);
      return;
    }
    closeMenu();
  }

  exportBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    if (menu.classList.contains('hidden')) openMenu();
    else closeMenu();
  });

  menu.addEventListener('click', async (e) => {
    const item = e.target.closest('.tb-menu-item');
    if (!item) return;
    closeMenu();
    const kind = item.dataset.download;
    try {
      if      (kind === 'verses')      downloadVersesTxt();
      else if (kind === 'transcript')  downloadTranscriptTxt();
      else if (kind === 'note')        await downloadAIContent('note');
      else if (kind === 'points')      await downloadAIContent('points');
      else if (kind === 'note-docx')   await downloadAIContentDocx('note');
      else if (kind === 'points-docx') await downloadAIContentDocx('points');
    } catch (err) {
      toast('Download failed: ' + (err.message || err), 'error');
    }
  });
})();

function downloadAsFile(content, filename, mime = 'text/plain') {
  const blob = new Blob([content], { type: mime });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function downloadVersesTxt() {
  if (!sessionVerses.length) { toast('No verses captured yet — start listening first', 'info'); return; }
  const lines = sessionVerses.map(v => `${v.time}  ${v.ref}\n${v.text}\n`).join('\n');
  downloadAsFile(lines, `KAIRO_verses_${new Date().toISOString().slice(0, 10)}.txt`);
}

function downloadTranscriptTxt() {
  if (!sessionTranscriptParts.length) { toast('No transcript captured yet — start listening first', 'info'); return; }
  const lines = sessionTranscriptParts.map(p => `[${p.time}] ${p.text}`).join('\n');
  downloadAsFile(lines, `KAIRO_transcript_${new Date().toISOString().slice(0, 10)}.txt`);
}

// AI content lives on saved sessions. Resolve the most recent saved session
// that has the requested type ('note'|'points') generated. Shared by both the
// PDF and Word export paths below, which otherwise repeated this fetch+find
// block verbatim. Returns { error: true } on a reachability failure (caller
// should just return — the toast is already shown), or { candidate } where
// candidate is null if nothing's been generated yet.
async function resolveGeneratedSession(type) {
  let sessions = [];
  try {
    const r = await fetch(`${SERVER}/api/sessions`);
    sessions = (await r.json()).sessions || [];
  } catch {
    toast('Could not reach Kairo server', 'error');
    return { error: true };
  }
  const want = type === 'note' ? 'hasNote' : 'hasPoints';
  return { candidate: sessions.find(s => s[want]) || null };
}

async function downloadAIContent(type) {
  const { error, candidate } = await resolveGeneratedSession(type);
  if (error) return;
  if (!candidate) {
    toast(`No saved sermon ${type === 'note' ? 'note' : 'points'} yet — opening Content Studio`, 'info');
    document.getElementById('settings-modal')?.classList.add('hidden');
    document.getElementById('content-studio-modal')?.classList.remove('hidden');
    document.getElementById('content-studio-btn')?.click();
    return;
  }
  const r = await fetch(`${SERVER}/api/sessions/${encodeURIComponent(candidate.id)}`);
  if (!r.ok) throw new Error('failed to load session');
  const session = await r.json();
  const content = session.generated?.[type];
  if (!content) throw new Error('content missing on session');
  // Use the existing render+print pipeline by dispatching a synthetic open
  // through Content Studio's renderers. We import them via a small bridge.
  if (typeof window.__cs_exportToPDF === 'function') {
    window.__cs_exportToPDF(session, type, content);
  } else {
    toast('Content Studio not ready', 'error');
  }
}

// Word export goes through the server, which renders the generated content
// as a real .docx (headings, scripture lines, quotes). Same session
// resolution as the PDF path.
async function downloadAIContentDocx(type) {
  const { error, candidate } = await resolveGeneratedSession(type);
  if (error) return;
  if (!candidate) {
    toast(`No saved sermon ${type === 'note' ? 'note' : 'points'} yet — opening Content Studio`, 'info');
    document.getElementById('settings-modal')?.classList.add('hidden');
    document.getElementById('content-studio-btn')?.click();
    return;
  }
  const r = await fetch(`${SERVER}/api/content/export?sessionId=${encodeURIComponent(candidate.id)}&type=${type}`);
  if (!r.ok) {
    const j = await r.json().catch(() => ({}));
    throw new Error(j.error || 'export failed');
  }
  const blob = await r.blob();
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement('a');
  a.href     = url;
  a.download = `KAIRO_${type}_${(candidate.date || candidate.id).replace(/[^A-Za-z0-9_\-]/g, '-')}.docx`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Elapsed timer ──────────────────────────────────────────────────────────
function updateElapsed() {
  if (!startTime) return;
  const s   = Math.floor((Date.now() - startTime) / 1000);
  const min = Math.floor(s / 60);
  const sec = s % 60;
  const str = `${min}:${sec.toString().padStart(2, '0')}`;
  if (elapsedTimeEl)   elapsedTimeEl.textContent   = str;
  if (elapsedMetricEl) elapsedMetricEl.textContent = str;
}

// ── Toast ──────────────────────────────────────────────────────────────────
// Disabled by explicit preference — every call site (~55+ of them, across
// app.js and service.js) still calls toast(msg, type) exactly as before,
// this just no-ops instead of rendering anything. Kept as a real function
// rather than deleting every call site so none of that surrounding logic
// needs touching.
function toast() {}

// ── Platform class ─────────────────────────────────────────────────────────
// Platform class is set on <html> by an inline script in index.html (before
// first paint). Mirror it onto <body> so existing `.platform-darwin .x` rules
// that were written against body keep matching.
if (document.documentElement.classList.contains('platform-darwin')) {
  document.body.classList.add('platform-darwin');
}

// ── Frameless-window dragging (JS-driven, not CSS app-region) ────────────
// See styles.css's comment on .top-bar-center for the history here: CSS
// `-webkit-app-region: drag` repeatedly caused the whole top bar to stop
// painting (a real WebKit/Chromium compositing bug), even after narrowing
// the region to a permanently-empty element. Driving the drag from Tauri's
// own startDragging() sidesteps the app-region/compositing path entirely —
// there's nothing left for that bug class to trigger on.
(function wireWindowDrag() {
  const region = document.querySelector('.top-bar-center');
  if (!region) return;
  region.addEventListener('mousedown', (e) => {
    if (e.button !== 0) return; // left-click only — matches native drag-region behavior
    // .top-bar-center now also hosts the Bible/Slides/Songs/Media/Theme
    // Studio tabs (centering them in the bar) — only start a window drag
    // when the empty space itself was clicked, not a tab button.
    if (e.target !== region) return;
    const win = window.__TAURI__?.window?.getCurrentWindow?.();
    win?.startDragging?.().catch(() => {});
  });
})();

// ── Boot ───────────────────────────────────────────────────────────────────
populateAudioDevices();

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
  { label: 'System UI',          value: 'system-ui',          google: false },
];

const loadedFonts = new Set(['Manrope', 'system-ui']);

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

function loadGoogleFont(family) {
  if (loadedFonts.has(family)) return;
  loadedFonts.add(family);
  const link = document.createElement('link');
  link.rel = 'stylesheet';
  link.href = `https://fonts.googleapis.com/css2?family=${encodeURIComponent(family)}:wght@100;200;300;400;500;600;700;800;900&display=swap`;
  document.head.appendChild(link);
}

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

const DEFAULT_LOOKS = [
  {
    id: 'full-bg', name: 'Full — Background', layout: 'fullscreen', animation: 'fade',
    groupId: 'grp-bible', groupName: 'Bible',
    layers: [
      { id: 'bg', type: 'background', name: 'Canvas', visible: true,
        fill: 'gradient', color: '#0b0b0f', opacity: 100, color2: '#1c1c30', angle: 160 },
      { id: 'verse', type: 'text', name: 'Verse', visible: true, binding: 'verse', customText: '',
        pos: { x: 210, y: 80, w: 1500, h: 440 },
        font: { family: 'Manrope', size: 64, weight: 500, italic: false, lineHeight: 1.35, letterSpacing: 0, transform: 'none' },
        color: '#ffffff', opacity: 100, align: 'center',
        shadow: { ...TXT_SHADOW_SOFT }, outline: { ...NO_OUTLINE } },
      { id: 'ref', type: 'text', name: 'Reference', visible: true, binding: 'reference', customText: '',
        pos: { x: 210, y: 560, w: 1500, h: 0 },
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
      { id: 'verse', type: 'text', name: 'Verse', visible: true, binding: 'verse', customText: '',
        pos: { x: 210, y: 80, w: 1500, h: 440 },
        font: { family: 'Manrope', size: 64, weight: 600, italic: false, lineHeight: 1.35, letterSpacing: 0, transform: 'none' },
        color: '#ffffff', opacity: 100, align: 'center',
        shadow: { enabled: true, color: '#000000', opacity: 85, blur: 18, x: 0, y: 4 },
        outline: { enabled: true, color: '#000000', width: 2 } },
      { id: 'ref', type: 'text', name: 'Reference', visible: true, binding: 'reference', customText: '',
        pos: { x: 210, y: 560, w: 1500, h: 0 },
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
      { id: 'verse', type: 'text', name: 'Lyrics', visible: true, binding: 'verse', customText: '',
        pos: { x: 140, y: 360, w: 1640, h: 380 },
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
        fill: 'gradient', color: '#0b0b0f', opacity: 100, color2: '#1c1c30', angle: 160, radius: 0,
        pos: { x: 0, y: 0, w: 960, h: 1080 } },
      { id: 'verse', type: 'text', name: 'Verse', visible: true, binding: 'verse', customText: '',
        pos: { x: 88, y: 300, w: 784, h: 430 },
        font: { family: 'Manrope', size: 44, weight: 500, italic: false, lineHeight: 1.4, letterSpacing: 0, transform: 'none' },
        color: '#ffffff', opacity: 100, align: 'left',
        shadow: { ...TXT_SHADOW_NONE }, outline: { ...NO_OUTLINE } },
      { id: 'ref', type: 'text', name: 'Reference', visible: true, binding: 'reference', customText: '',
        pos: { x: 88, y: 762, w: 784, h: 0 },
        font: { family: 'Manrope', size: 22, weight: 700, italic: false, lineHeight: 1.2, letterSpacing: 5, transform: 'uppercase' },
        color: '#ffffff', opacity: 65, align: 'left',
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
        fill: 'gradient', color: '#0b0b0f', opacity: 100, color2: '#1c1c30', angle: 160, radius: 0,
        pos: { x: 960, y: 0, w: 960, h: 1080 } },
      { id: 'verse', type: 'text', name: 'Verse', visible: true, binding: 'verse', customText: '',
        pos: { x: 1048, y: 300, w: 784, h: 430 },
        font: { family: 'Manrope', size: 44, weight: 500, italic: false, lineHeight: 1.4, letterSpacing: 0, transform: 'none' },
        color: '#ffffff', opacity: 100, align: 'left',
        shadow: { ...TXT_SHADOW_NONE }, outline: { ...NO_OUTLINE } },
      { id: 'ref', type: 'text', name: 'Reference', visible: true, binding: 'reference', customText: '',
        pos: { x: 1048, y: 762, w: 784, h: 0 },
        font: { family: 'Manrope', size: 22, weight: 700, italic: false, lineHeight: 1.2, letterSpacing: 5, transform: 'uppercase' },
        color: '#ffffff', opacity: 65, align: 'left',
        shadow: { ...TXT_SHADOW_NONE }, outline: { ...NO_OUTLINE } },
    ],
  },
  {
    // Same left/right split geometry as Split — Left/Right, but both halves
    // are filled (one screen, two languages) instead of one side keying out.
    // The right panel is a visibly darker version of the same gradient —
    // that's the only visual difference between the two sides, by design —
    // so the source language (left) and translation (right) read as two
    // distinct panels at a glance. Right side text uses the 'verse_translated'
    // / (shared) 'reference' bindings; the item's `translateTo` language code
    // decides what actually fills that binding — see getTranslatedText() in
    // service.js for the resolution + caching logic.
    id: 'multi-language', name: 'Multi-Language', layout: 'multi-language', animation: 'fade',
    groupId: 'grp-bible', groupName: 'Bible',
    layers: [
      { id: 'bg', type: 'background', name: 'Canvas', visible: true,
        fill: 'gradient', color: '#0b0b0f', opacity: 100, color2: '#1c1c30', angle: 160 },
      { id: 'panel-left', type: 'background', name: 'Left Panel', visible: true,
        fill: 'gradient', color: '#0b0b0f', opacity: 100, color2: '#1c1c30', angle: 160, radius: 0,
        pos: { x: 0, y: 0, w: 960, h: 1080 } },
      { id: 'panel-right', type: 'background', name: 'Right Panel (darker)', visible: true,
        fill: 'gradient', color: '#020203', opacity: 100, color2: '#0a0a12', angle: 160, radius: 0,
        pos: { x: 960, y: 0, w: 960, h: 1080 } },
      { id: 'verse', type: 'text', name: 'Verse (source)', visible: true, binding: 'verse', customText: '',
        pos: { x: 88, y: 300, w: 784, h: 430 },
        font: { family: 'Manrope', size: 40, weight: 500, italic: false, lineHeight: 1.4, letterSpacing: 0, transform: 'none' },
        color: '#ffffff', opacity: 100, align: 'left',
        shadow: { ...TXT_SHADOW_NONE }, outline: { ...NO_OUTLINE } },
      { id: 'ref', type: 'text', name: 'Reference (source)', visible: true, binding: 'reference', customText: '',
        pos: { x: 88, y: 762, w: 784, h: 0 },
        font: { family: 'Manrope', size: 20, weight: 700, italic: false, lineHeight: 1.2, letterSpacing: 5, transform: 'uppercase' },
        color: '#ffffff', opacity: 65, align: 'left',
        shadow: { ...TXT_SHADOW_NONE }, outline: { ...NO_OUTLINE } },
      { id: 'verse-translated', type: 'text', name: 'Verse (translated)', visible: true, binding: 'verse_translated', customText: '',
        pos: { x: 1048, y: 300, w: 784, h: 430 },
        font: { family: 'Manrope', size: 40, weight: 500, italic: false, lineHeight: 1.4, letterSpacing: 0, transform: 'none' },
        color: '#ffffff', opacity: 100, align: 'left',
        shadow: { ...TXT_SHADOW_NONE }, outline: { ...NO_OUTLINE } },
      { id: 'ref-translated', type: 'text', name: 'Reference (translated)', visible: true, binding: 'reference', customText: '',
        pos: { x: 1048, y: 762, w: 784, h: 0 },
        font: { family: 'Manrope', size: 20, weight: 700, italic: false, lineHeight: 1.2, letterSpacing: 5, transform: 'uppercase' },
        color: '#ffffff', opacity: 65, align: 'left',
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
      { id: 'bg', type: 'background', name: 'Canvas', visible: true,
        fill: 'gradient', color: '#0b0b0f', opacity: 100, color2: '#1c1c30', angle: 160 },
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
    stored.forEach(l => {
      const def = defaultsById.get(l.id);
      if (def && def.groupId && !l.groupId) { l.groupId = def.groupId; l.groupName = def.groupName; }
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
    });
    return missing.length ? [...stored, ...missing] : stored;
  }
  // First run on v3 — carry over the operator's own themes from v2, if any.
  // Also mark the Song Title migration as already applied: DEFAULT_LOOKS
  // already ships with that layer off, so a genuinely fresh install has
  // nothing to retroactively flip — without this, the FIRST save an operator
  // makes (e.g. deliberately turning Song Title back on) would look like a
  // pre-migration install on the next launch and get silently reverted by
  // the migration above.
  localStorage.setItem('kairo-migrated-songtitle-default-off', '1');
  const legacy = JSON.parse(localStorage.getItem('kairo-looks-v2') || 'null');
  const custom = Array.isArray(legacy) ? legacy.filter(l => l && !LEGACY_BUILTIN_IDS.has(l.id)) : [];
  return [...DEFAULT_LOOKS, ...custom];
})();
let activeLook  = looks[0];
let activeLayer = null; // currently selected layer object

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
// the whole theme. multiSelectedLayerIds is select-all's visual footprint;
// a plain single click still only ever sets activeLayer, so Copy after a
// normal click copies just that one layer.
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
let tsItemCtx = null; // { item, slideIndex, baseLook } — set only while tsMode === 'item'
let itemUndoStack = [], itemRedoStack = [], itemPendingCheckpoint = null, itemAutosaveTimer = null;

function saveLooks() {
  localStorage.setItem(LOOKS_KEY, JSON.stringify(looks));
  // Keep the Settings pickers and every live output in step with the edit.
  try { renderOutputThemePickers(); renderDisplayOutputs(); applyOutputThemes(); } catch {}
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
    activeLayer = null;
    resetThemeHistory();
  }
  saveLooks();
  renderLooksList(); renderLayersList(); syncMetaRow(); renderPreview(); renderProps();
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
  activeLook  = look;
  activeLayer = null;
  resetThemeHistory();
  renderLooksList();
  renderLayersList();
  syncMetaRow();
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
  activeLayer = null;
  resetThemeHistory();
  saveLooks();
  renderLooksList(); renderLayersList(); syncMetaRow(); renderPreview(); renderProps();
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
    activeLayer = null;
    resetThemeHistory();
  }
  saveLooks();
  renderLooksList();
  renderLayersList();
  syncMetaRow();
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

function syncMetaRow() {
  if (!activeLook) return;
  document.querySelectorAll('#ts-layout-picker .ts-chip').forEach(b =>
    b.classList.toggle('active', b.dataset.layout === activeLook.layout));
  document.querySelectorAll('#ts-anim-picker .ts-chip').forEach(b =>
    b.classList.toggle('active', b.dataset.anim === activeLook.animation));
  const speedSlider = document.getElementById('ts-anim-speed');
  if (speedSlider) {
    speedSlider.value = activeLook.animationSpeed || 1;
    speedSlider.classList.toggle('hidden', (activeLook.animation || 'fade') === 'cut');
  }
  const alphaBtn = document.getElementById('ts-alpha-toggle');
  if (alphaBtn) alphaBtn.classList.toggle('active', isAlphaCanvas());
  renderThemeCanvasSizeSelect();

  // Text Animation — how the verse text itself reveals, independent of the
  // Transition above (which is how the whole slide swaps). See
  // KairoWordSplit's file header for why these are two separate settings
  // rather than the single overloaded `animation` field this used to be.
  const textAnim = activeLook.textAnimation || 'none';
  const textAnimSelect = document.getElementById('ts-text-anim-select');
  if (textAnimSelect) textAnimSelect.value = textAnim;
  const textAnimSpeed = document.getElementById('ts-text-anim-speed');
  if (textAnimSpeed) {
    textAnimSpeed.value = activeLook.textAnimationSpeed || 1;
    textAnimSpeed.closest('.ts-prop-row')?.classList.toggle('hidden', textAnim === 'none');
  }
  // Highlight Color only means something to the animations that actually
  // read opts.color (see applyMotionText in word_split.js) — hidden for
  // every other choice rather than shown-but-inert.
  const colorRow = document.getElementById('ts-text-anim-color-row');
  if (colorRow) {
    colorRow.classList.toggle('hidden', !['impact', 'karaoke', 'highlight-box'].includes(textAnim));
    const colorInput = document.getElementById('ts-text-anim-color');
    if (colorInput) colorInput.value = activeLook.textHighlightColor || '#ffd23f';
  }
  // Same reasoning for Intensity — only Impact/Bold Caption read opts.intensity.
  const intensityRow = document.getElementById('ts-text-anim-intensity-row');
  if (intensityRow) {
    intensityRow.classList.toggle('hidden', !['impact', 'bold-caption'].includes(textAnim));
    const intensityInput = document.getElementById('ts-text-anim-intensity');
    if (intensityInput) intensityInput.value = activeLook.textAnimationIntensity ?? 1;
  }

  // Translate-to language — meaningful for ANY theme with a verse_translated
  // layer, not just the one built-in preset whose layout happens to be
  // literally named 'multi-language'. A custom theme built from scratch (or
  // duplicated and restyled) with its own translated-text layer needs this
  // picker just as much, so gate on the layer actually being present instead
  // of a hardcoded layout-name check that only ever matched that one preset.
  const translateGroup = document.getElementById('ts-translate-group');
  if (translateGroup) {
    const needsTranslation = (activeLook.layers || []).some(l => l.type === 'text' && l.binding === 'verse_translated');
    translateGroup.classList.toggle('hidden', !needsTranslation);
    document.querySelectorAll('#ts-translate-picker .ts-chip').forEach(b =>
      b.classList.toggle('active', b.dataset.lang === activeLook.translateTo));
  }
}

// The canvas is "transparent" when the base background layer is keyed out —
// the state operators want for chroma / alpha-key rigs.
function baseBgLayer() {
  return activeLook?.layers?.find(l => l.type === 'background' && !l.pos) || null;
}
function isAlphaCanvas() {
  return baseBgLayer()?.fill === 'transparent';
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
  activeLook.layers = activeLook.layers.filter(l => l.id !== layer.id);
  if (activeLayer?.id === layer.id) activeLayer = null;
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
  // Render in reverse so background is at bottom visually (like PP). Item
  // mode only ever lets an operator override TEXT layers of the theme for
  // one slide — the theme's own background/image stays fixed, so those
  // never appear in this list while tsMode === 'item' (still visible
  // read-only on the canvas itself, see renderPreview) — but a custom layer
  // the operator added to this slide (isItemCustomLayer) shows regardless
  // of its type, since it's the operator's own, not the theme's.
  const layers = tsMode === 'item' ? activeLook.layers.filter(l => l.type === 'text' || isItemCustomLayer(l)) : activeLook.layers;
  const rev = [...layers].reverse();
  rev.forEach(layer => {
    const row = document.createElement('div');
    row.className = 'ts-layer-row' + (layer.id === activeLayer?.id ? ' active' : '') + (multiSelectedLayerIds.has(layer.id) ? ' multi-selected' : '');
    row.dataset.layerId = layer.id;

    const isText = layer.type === 'text';
    const isBg   = layer.type === 'background' && !layer.pos;   // base canvas only

    // Visibility icon
    const visBtn = document.createElement('button');
    visBtn.className = 'ts-layer-vis' + (layer.visible ? '' : ' hidden');
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
    // too now: only text/custom layers ever show as rows there (the theme's
    // own background/image stay fixed, see the filter above), so this only
    // ever reorders this slide's own content — persisted per-slide via
    // __layerOrder (see writeItemSlideStyleFromSynthetic/buildSyntheticLook)
    // rather than touching the theme's order.
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

    row.addEventListener('click', () => {
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

// Reconciles a stored id order against the layers actually present — any id
// no longer present is dropped, any layer not mentioned (added since the
// order was last saved) keeps its natural relative position, appended after
// the ones the order does cover. Used by buildSyntheticLook to replay a
// per-slide reorder recorded in item.slideStyles[slideIndex].__layerOrder.
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

// ── Render preview ────────────────────────────────────────────────────────
const PREVIEW_TEXT_SAMPLE = 'For God so loved the world, that he gave his only begotten Son.';
const PREVIEW_REF_SAMPLE  = 'John 3:16 (KJV)';
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
      if (layer.binding === 'verse_translated') {
        return TS_TRANSLATE_SAMPLES[tsItemCtx.item.translateTo] || '[No translation language set for this item]';
      }
      return layer.customText || '[Custom Text]';
    }
  }
  if (layer.binding === 'verse')     return PREVIEW_TEXT_SAMPLE;
  if (layer.binding === 'reference') return PREVIEW_REF_SAMPLE;
  if (layer.binding === 'verse_translated') {
    return TS_TRANSLATE_SAMPLES[activeLook?.translateTo] || '[Pick a language below]';
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

  activeLook.layers.forEach(layer => {
    if (!layer.visible) return;

    if (layer.type === 'background') {
      const div = document.createElement('div');
      div.style.cssText = 'position:absolute;inset:0;';

      if (layer.fill === 'transparent') {
        stage.classList.add('ts-transparent-bg');
        return;
      }
      if (layer.fill === 'solid') {
        div.style.background = hexOpacity(layer.color, layer.opacity);
      } else if (layer.fill === 'gradient') {
        const c1 = hexOpacity(layer.color, layer.opacity);
        const c2 = hexOpacity(layer.color2, layer.opacity);
        div.style.background = `linear-gradient(${layer.angle}deg, ${c1}, ${c2})`;
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
        if (layer.radius) div.style.borderRadius = (layer.radius * pxScale).toFixed(1) + 'px';
        if (layer.rotation) div.style.transform = `rotate(${layer.rotation}deg)`;
      }

      stage.appendChild(div);
      // Full-stage backgrounds are select-only; positioned shapes are draggable.
      // Item mode still renders the theme's background for visual context
      // (contrast/positioning reference) but it belongs to the theme, not
      // the item — no selection/drag wiring at all in that mode. A custom
      // background-type layer the operator added to this slide is the
      // exception (isItemCustomLayer) — it's the operator's own, so it gets
      // full interactivity same as in theme mode.
      if (tsMode !== 'item' || isItemCustomLayer(layer)) tsDecorateLayerEl(div, layer, !!layer.pos);
      return;
    }

    if (layer.type === 'image') {
      const div = document.createElement('div');
      const p = layer.pos || { x: 0, y: 0, w: TS_DESIGN_W, h: TS_DESIGN_H };
      div.style.cssText = `
        position:absolute;
        left:${(p.x / TS_DESIGN_W * 100)}%;
        top:${(p.y / TS_DESIGN_H * 100)}%;
        width:${(p.w / TS_DESIGN_W * 100)}%;
        height:${(p.h / TS_DESIGN_H * 100)}%;
        background-image:url('${layer.src}');
        background-size:${layer.fit === 'fill' ? '100% 100%' : layer.fit};
        background-position:center;
        background-repeat:no-repeat;
        opacity:${(layer.opacity ?? 100) / 100};
        border-radius:${((layer.radius || 0) * pxScale).toFixed(1)}px;
        ${layer.rotation ? `transform: rotate(${layer.rotation}deg);` : ''}
      `;
      stage.appendChild(div);
      // Same exception as the background branch above — a custom image
      // layer added to this slide gets full interactivity even in item mode.
      if (tsMode !== 'item' || isItemCustomLayer(layer)) tsDecorateLayerEl(div, layer, true);
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
        if (layer.align === 'left') { div.style.textAlign = 'left'; }
      } else if (layout === 'lower-third') {
        div.style.left = '0'; div.style.right = '0'; div.style.bottom = '0';
        if (layer.binding === 'verse')     { div.style.bottom = '10%'; }
        if (layer.binding === 'reference') { div.style.bottom = '3%'; }
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
      }

      // Free-canvas override: explicit box wins over every layout rule.
      if (layer.pos) {
        div.style.left      = (layer.pos.x / TS_DESIGN_W * 100) + '%';
        div.style.top       = (layer.pos.y / TS_DESIGN_H * 100) + '%';
        div.style.width     = (layer.pos.w / TS_DESIGN_W * 100) + '%';
        div.style.right     = 'auto';
        div.style.bottom    = 'auto';
        div.style.transform = 'none';
        div.style.padding   = '0';
        if (layer.pos.h > 0) div.style.height = (layer.pos.h / TS_DESIGN_H * 100) + '%';
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
      } else {
        div.textContent = layerTextContent(layer);
      }
      stage.appendChild(div);
      tsDecorateLayerEl(div, layer, true);

      // Load font
      if (layer.font.family !== 'system-ui') loadGoogleFont(layer.font.family);
    }
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
  }
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
function tsEffectiveH(layer, p) {
  if (p.h > 0) return p.h;
  const stage = tsStageEl();
  const el = stage?.querySelector(`[data-layer-id="${CSS.escape(layer.id)}"]`);
  if (!el || !stage || !stage.clientHeight) return 100;
  return Math.round(el.getBoundingClientRect().height / stage.getBoundingClientRect().height * TS_DESIGN_H);
}

let tsDrag = null;   // { layer, mode:'move'|'resize', dir, startX, startY, start, stageRect }

// Active alignment guide, in design px along each axis — null when that axis
// isn't currently snapped. Read by renderPreview() to draw the guide lines;
// only ever non-null while tsDrag is set.
let tsSnapGuides = { x: null, y: null };

const TS_SNAP_TOLERANCE = 14; // design px — same feel as the old center-only snap

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
  if (activeLayer !== layer) { activeLayer = layer; renderLayersList(); renderProps(); }
  const stage = tsStageEl();
  if (!stage) return;
  const pos = ensurePos(layer);
  tsDrag = {
    layer, mode, dir: dir || 'se',
    startX: e.clientX, startY: e.clientY,
    start: { ...pos },
    stageRect: stage.getBoundingClientRect(),
  };
  document.addEventListener('mousemove', tsDragMove);
  document.addEventListener('mouseup', tsDragEnd);
  renderPreview();
}

function tsDragMove(e) {
  if (!tsDrag) return;
  const { layer, mode, start, stageRect } = tsDrag;
  const dx = (e.clientX - tsDrag.startX) / stageRect.width  * TS_DESIGN_W;
  const dy = (e.clientY - tsDrag.startY) / stageRect.height * TS_DESIGN_H;
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
  } else {
    // Resize from whichever handle was grabbed — the opposite edge stays put,
    // exactly like dragging a selection corner in a design tool.
    const d = tsDrag.dir;
    const MIN_W = 40, MIN_H = 24;
    // An auto-height text box gets a real height the moment it's stretched
    // vertically; horizontal-only drags leave it on auto.
    const vertical = d.includes('n') || d.includes('s');
    const baseH = start.h > 0 ? start.h : tsEffectiveH(layer, start);

    let nx = start.x, ny = start.y, nw = start.w, nh = start.h;

    if (d.includes('e')) nw = start.w + dx;
    if (d.includes('w')) { nw = start.w - dx; nx = start.x + dx; }
    if (vertical) {
      if (d.includes('s')) nh = baseH + dy;
      if (d.includes('n')) { nh = baseH - dy; ny = start.y + dy; }
    }

    // Snap only the edge(s) actually being dragged — the anchored edge on
    // the opposite side must never move.
    if (d.includes('e')) {
      const snap = tsClosestSnap(nx + nw, xTargets, TS_SNAP_TOLERANCE);
      if (snap != null) { nw = snap - nx; snappedX = snap; }
    } else if (d.includes('w')) {
      const rightEdge = start.x + start.w;
      const snap = tsClosestSnap(nx, xTargets, TS_SNAP_TOLERANCE);
      if (snap != null) { nx = snap; nw = rightEdge - nx; snappedX = snap; }
    }
    if (vertical) {
      if (d.includes('s')) {
        const snap = tsClosestSnap(ny + nh, yTargets, TS_SNAP_TOLERANCE);
        if (snap != null) { nh = snap - ny; snappedY = snap; }
      } else if (d.includes('n')) {
        const bottomEdge = start.y + baseH;
        const snap = tsClosestSnap(ny, yTargets, TS_SNAP_TOLERANCE);
        if (snap != null) { ny = snap; nh = bottomEdge - ny; snappedY = snap; }
      }
    }

    // Clamp without letting the anchored edge drift.
    if (nw < MIN_W) { if (d.includes('w')) nx = start.x + (start.w - MIN_W); nw = MIN_W; }
    if (vertical && nh < MIN_H) { if (d.includes('n')) ny = start.y + (baseH - MIN_H); nh = MIN_H; }

    layer.pos.x = Math.round(nx);
    layer.pos.y = Math.round(ny);
    layer.pos.w = Math.round(nw);
    layer.pos.h = Math.round(nh);
  }
  tsSnapGuides = { x: snappedX, y: snappedY };
  renderPreview();
  tsSyncPosInputs(layer);
}

function tsDragEnd() {
  document.removeEventListener('mousemove', tsDragMove);
  document.removeEventListener('mouseup', tsDragEnd);
  if (tsDrag) {
    tsDrag = null;
    tsSnapGuides = { x: null, y: null };
    renderProps();
    renderPreview();
    // Pre-existing gap in theme mode: a drag never called
    // scheduleThemeAutosave() either — out of scope to fix here (see plan's
    // "don't touch theme mode's behavior" note). Item mode needs this,
    // additively, since dragging IS the primary way to set a position
    // override.
    if (tsMode === 'item') tsSave();
  }
}

// Live-update the Position/Dimension inputs during a drag without a full
// (focus-stealing) renderProps rebuild.
function tsSyncPosInputs(layer) {
  if (!layer.pos) return;
  document.querySelectorAll('#ts-props-panel [data-pos-input]').forEach(inp => {
    const k = inp.dataset.posInput;
    if (document.activeElement !== inp) inp.value = layer.pos[k];
  });
}

// Selection outline + drag/resize wiring for a rendered preview element.
function tsDecorateLayerEl(div, layer, draggable) {
  div.dataset.layerId = layer.id;
  div.style.cursor = draggable ? 'move' : 'pointer';
  div.addEventListener('mousedown', (e) => {
    if (e.target.classList && e.target.classList.contains('ts-handle')) return;
    if (draggable) {
      tsBeginDrag(e, layer, 'move');
    } else {
      e.stopPropagation();
      if (activeLayer !== layer) { activeLayer = layer; renderLayersList(); renderProps(); renderPreview(); }
    }
  });
  if (activeLayer === layer) {
    div.classList.add('ts-el-selected');
    // Eight-point selection frame: four corners + four edge midpoints, each
    // resizing from the opposite anchor.
    ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach(dir => {
      const h = document.createElement('div');
      h.className = `ts-handle ts-handle-${dir}`;
      h.addEventListener('mousedown', (e) => tsBeginDrag(e, layer, 'resize', dir));
      div.appendChild(h);
    });
  }
}

// ── Render properties panel ───────────────────────────────────────────────
function renderProps() {
  const empty = document.getElementById('ts-props-empty');
  const panel = document.getElementById('ts-props-panel');
  if (!panel || !empty) return;

  if (!activeLayer) {
    empty.style.display = 'flex';
    panel.style.display = 'none';
    panel.innerHTML = '';
    return;
  }

  empty.style.display = 'none';
  panel.style.display = 'block';
  panel.innerHTML = '';

  if (activeLayer.type === 'background') {
    renderBgProps(panel, activeLayer);
  } else if (activeLayer.type === 'image') {
    renderImageProps(panel, activeLayer);
  } else {
    renderTextProps(panel, activeLayer);
  }
}

function prop(label, content) {
  const row = document.createElement('div');
  row.className = 'ts-prop-row';
  const lbl = document.createElement('span');
  lbl.className = 'ts-prop-label';
  lbl.textContent = label;
  row.appendChild(lbl);
  row.appendChild(content);
  return row;
}

function section(label, ...children) {
  const s = document.createElement('div');
  s.className = 'ts-props-section';
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

function makeSlider(val, min, max, onChange) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;align-items:center;gap:6px;flex:1;';
  const sl = document.createElement('input');
  sl.type = 'range'; sl.className = 'ts-prop-slider';
  sl.min = min; sl.max = max; sl.value = val;
  const lbl = document.createElement('span');
  lbl.className = 'ts-prop-val';
  lbl.textContent = val;
  sl.addEventListener('input', () => { lbl.textContent = sl.value; onChange(parseFloat(sl.value)); });
  wrap.appendChild(sl); wrap.appendChild(lbl);
  return wrap;
}

function makeFillChips(current, onChange) {
  const wrap = document.createElement('div');
  wrap.className = 'ts-fill-group';
  ['solid','transparent','blur','gradient'].forEach(f => {
    const btn = document.createElement('button');
    btn.className = 'ts-fill-chip' + (current === f ? ' active' : '');
    btn.textContent = f.charAt(0).toUpperCase() + f.slice(1);
    btn.addEventListener('click', () => {
      wrap.querySelectorAll('.ts-fill-chip').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      onChange(f);
    });
    wrap.appendChild(btn);
  });
  return wrap;
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
    btn.title = v;
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
  sel.className = 'ts-font-select';
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

function makeFontSelect(current, onChange) {
  const sel = document.createElement('select');
  sel.className = 'ts-font-select';
  FONTS.forEach(f => {
    const opt = document.createElement('option');
    opt.value = f.value;
    opt.textContent = f.label;
    opt.style.fontFamily = f.value;
    if (f.value === current) opt.selected = true;
    sel.appendChild(opt);
  });
  sel.addEventListener('change', () => {
    const fam = sel.value;
    if (fam !== 'system-ui') loadGoogleFont(fam);
    onChange(fam);
  });
  return sel;
}

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
      updateUndoRedoButtons();
    }
    lastThemeSnapshot = deepClone(activeLook); // burst settled — this is now the baseline for the next one
    saveLooks();
    renderLooksList();
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
  if (curLayer.visible === false) ov.visible = false; // only the hidden case is ever stored; visible is the assumed default
  return ov;
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
  const overrides = {};
  const customLayers = [];
  (activeLook.layers || []).forEach(layer => {
    const baseLayer = (baseLook.layers || []).find(l => l.id === layer.id);
    if (!baseLayer) { customLayers.push(deepClone(layer)); return; }
    if (layer.type !== 'text') return;
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
  const currentOrder = (activeLook.layers || []).map(l => l.id);
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
  activeLayer = null;
  renderLayersList(); renderPreview(); renderProps();
}
function itemRedo() {
  if (!tsItemCtx || !itemRedoStack.length) return;
  itemUndoStack.push(deepClone(tsItemCtx.item.slideStyles || {}));
  const snapshot = itemRedoStack.pop();
  tsItemCtx.item.slideStyles = snapshot;
  window.KairoService?.saveService?.();
  activeLook = buildSyntheticLook(tsItemCtx.item, tsItemCtx.slideIndex);
  activeLayer = null;
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
  updateUndoRedoButtons();
}

function updateUndoRedoButtons() {
  const undoBtn = document.getElementById('ts-undo-btn');
  const redoBtn = document.getElementById('ts-redo-btn');
  if (undoBtn) undoBtn.disabled = !themeUndoStack.length;
  if (redoBtn) redoBtn.disabled = !themeRedoStack.length;
}

// Replaces activeLook's contents in place (same object reference — other
// code holds onto `activeLook`/`looks[idx]` as that exact reference) rather
// than swapping in a new object, so nothing downstream goes stale.
function restoreLookSnapshot(snapshot) {
  const idx = looks.findIndex(l => l.id === activeLook.id);
  Object.keys(activeLook).forEach(k => delete activeLook[k]);
  Object.assign(activeLook, deepClone(snapshot));
  if (idx >= 0) looks[idx] = activeLook;
  activeLayer = null;
  lastThemeSnapshot = deepClone(activeLook); // the just-restored state is the new baseline
  saveLooks();
  renderLooksList(); renderLayersList(); syncMetaRow(); renderPreview(); renderProps();
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
  updateUndoRedoButtons();
}

function themeRedo() {
  if (!themeRedoStack.length || !activeLook) return;
  clearTimeout(autosaveTimer);
  themeUndoStack.push(deepClone(activeLook));
  pendingCheckpoint = null;
  const next = themeRedoStack.pop();
  restoreLookSnapshot(next);
  updateUndoRedoButtons();
}

document.getElementById('ts-undo-btn')?.addEventListener('click', themeUndo);
document.getElementById('ts-redo-btn')?.addEventListener('click', themeRedo);

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
function renderLayoutProps(panel, layer) {
  const cur = measurePos(layer);

  const posNum = (key, min, max) => {
    const inp = makeNumber(cur[key], min, max, 1, v => {
      ensurePos(layer)[key] = Math.round(v);
      renderPreview();
      // Pre-existing gap in theme mode: these inputs never called
      // scheduleThemeAutosave() either — out of scope to fix here. Item
      // mode needs this, additively — typing an exact position is one of
      // the two ways (with drag) to set a position override.
      if (tsMode === 'item') tsSave();
    });
    inp.dataset.posInput = key;
    return inp;
  };

  // Alignment: snap the box to canvas edges/center.
  const alignWrap = document.createElement('div');
  alignWrap.className = 'ts-align-group';
  [
    ['Left',   '<line x1="4" y1="4" x2="4" y2="20"/><rect x="8" y="9" width="12" height="6"/>',  p => { p.x = 0; }],
    ['Center', '<line x1="12" y1="4" x2="12" y2="20"/><rect x="5" y="9" width="14" height="6"/>', p => { p.x = Math.round((TS_DESIGN_W - p.w) / 2); }],
    ['Right',  '<line x1="20" y1="4" x2="20" y2="20"/><rect x="4" y="9" width="12" height="6"/>', p => { p.x = TS_DESIGN_W - p.w; }],
    ['Top',    '<line x1="4" y1="4" x2="20" y2="4"/><rect x="9" y="8" width="6" height="12"/>',  p => { p.y = 0; }],
    ['Middle', '<line x1="4" y1="12" x2="20" y2="12"/><rect x="9" y="5" width="6" height="14"/>', p => { p.y = Math.round((TS_DESIGN_H - tsEffectiveH(layer, p)) / 2); }],
    ['Bottom', '<line x1="4" y1="20" x2="20" y2="20"/><rect x="9" y="4" width="6" height="12"/>', p => { p.y = TS_DESIGN_H - tsEffectiveH(layer, p); }],
  ].forEach(([name, icon, act]) => {
    const btn = document.createElement('button');
    btn.className = 'ts-align-btn';
    btn.title = name;
    btn.innerHTML = `<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round">${icon}</svg>`;
    btn.addEventListener('click', () => {
      const p = ensurePos(layer);
      act(p);
      renderPreview();
      tsSyncPosInputs(layer);
      if (tsMode === 'item') tsSave(); // same pre-existing-gap note as posNum above
    });
    alignWrap.appendChild(btn);
  });

  const xyRow = document.createElement('div');
  xyRow.className = 'ts-prop-row'; xyRow.style.gap = '8px';
  const xl = document.createElement('span'); xl.className = 'ts-prop-label'; xl.textContent = 'X';
  const yl = document.createElement('span'); yl.className = 'ts-prop-label'; yl.textContent = 'Y';
  xyRow.appendChild(xl); xyRow.appendChild(posNum('x', -TS_DESIGN_W, TS_DESIGN_W));
  xyRow.appendChild(yl); xyRow.appendChild(posNum('y', -TS_DESIGN_H, TS_DESIGN_H));

  const whRow = document.createElement('div');
  whRow.className = 'ts-prop-row'; whRow.style.gap = '8px';
  const wl = document.createElement('span'); wl.className = 'ts-prop-label'; wl.textContent = 'W';
  const hl = document.createElement('span'); hl.className = 'ts-prop-label';
  hl.textContent = layer.type === 'text' ? 'H (0 = auto)' : 'H';
  whRow.appendChild(wl); whRow.appendChild(posNum('w', 40, TS_DESIGN_W));
  whRow.appendChild(hl); whRow.appendChild(posNum('h', 0, TS_DESIGN_H));

  const kids = [prop('Align', alignWrap), xyRow, whRow];

  // Escape hatch back to the layout preset once a layer has been freed.
  if (layer.pos) {
    const reset = document.createElement('button');
    reset.className = 'ts-fill-chip';
    reset.textContent = 'Use layout preset';
    reset.title = 'Clear free position — this layer follows the theme layout again';
    reset.addEventListener('click', () => {
      delete layer.pos;
      up();
      renderProps();
    });
    kids.push(prop('Position', reset));
  }

  panel.appendChild(section('Layout', ...kids));
}

// Background layer properties
function renderBgProps(panel, layer) {
  renderLayoutProps(panel, layer);

  // Fill type
  panel.appendChild(section('Fill',
    makeFillChips(layer.fill, v => { layer.fill = v; colorRow.style.display = v === 'transparent' ? 'none' : ''; grad2Row.style.display = v === 'gradient' ? '' : 'none'; up(); })
  ));

  // Color + opacity
  const colorRow = section('Color',
    prop('Color', makeColor(layer.color, v => { layer.color = v; up(); })),
    prop('Opacity', makeSlider(layer.opacity, 0, 100, v => { layer.opacity = v; up(); }))
  );
  if (layer.fill === 'transparent') colorRow.style.display = 'none';
  panel.appendChild(colorRow);

  // Gradient color 2
  const grad2Row = section('Gradient',
    prop('Color 2', makeColor(layer.color2 || '#1a1a2e', v => { layer.color2 = v; up(); })),
    prop('Angle', makeNumber(layer.angle || 160, 0, 360, 5, v => { layer.angle = v; up(); }))
  );
  if (layer.fill !== 'gradient') grad2Row.style.display = 'none';
  panel.appendChild(grad2Row);
}

// Image layer properties
function renderImageProps(panel, layer) {
  const nameInp = document.createElement('input');
  nameInp.type = 'text'; nameInp.className = 'ts-prop-input';
  nameInp.value = layer.name; nameInp.placeholder = 'Layer name';
  nameInp.addEventListener('input', () => { layer.name = nameInp.value; renderLayersList(); });
  panel.appendChild(section('Layer', prop('Name', nameInp)));

  renderLayoutProps(panel, layer);

  panel.appendChild(section('Image',
    prop('Fit', makeChips([
      { label: 'Contain', value: 'contain' },
      { label: 'Cover',   value: 'cover' },
      { label: 'Stretch', value: 'fill' },
    ], layer.fit || 'contain', v => { layer.fit = v; up(); })),
    prop('Opacity', makeSlider(layer.opacity ?? 100, 0, 100, v => { layer.opacity = v; up(); })),
    prop('Radius', makeSlider(layer.radius || 0, 0, 200, v => { layer.radius = v; up(); }))
  ));

  // Background removal — colour key. Keeps the original so it can be undone.
  const cutBtn = document.createElement('button');
  cutBtn.className = 'ts-fill-chip';
  cutBtn.textContent = layer.srcOriginal ? 'Re-cut background' : 'Remove background';
  cutBtn.title = 'Key out a flat backdrop (logos, graphics, green screen)';
  cutBtn.addEventListener('click', async () => {
    cutBtn.disabled = true;
    cutBtn.textContent = 'Working…';
    try {
      const original = layer.srcOriginal || layer.src;
      const out = await removeImageBackground({ src: original }, layer.cutTolerance || 40);
      layer.srcOriginal = original;
      layer.src = out;
      up(); renderProps();
      toast('Background removed', 'success');
    } catch {
      toast('Could not process that image', 'error');
      cutBtn.disabled = false;
      cutBtn.textContent = 'Remove background';
    }
  });

  const cutKids = [prop('Cutout', cutBtn)];
  if (layer.srcOriginal) {
    cutKids.push(prop('Tolerance', makeSlider(layer.cutTolerance || 40, 5, 160, async v => {
      layer.cutTolerance = v;
      try {
        layer.src = await removeImageBackground({ src: layer.srcOriginal }, v);
        up();
      } catch {}
    })));
    const undo = document.createElement('button');
    undo.className = 'ts-fill-chip';
    undo.textContent = 'Restore original';
    undo.addEventListener('click', () => {
      layer.src = layer.srcOriginal;
      delete layer.srcOriginal;
      up(); renderProps();
    });
    cutKids.push(prop('Undo', undo));
  }
  panel.appendChild(section('Background', ...cutKids));
}

// Text layer properties
function renderTextProps(panel, layer) {
  // Name + binding
  const nameInp = document.createElement('input');
  nameInp.type = 'text'; nameInp.className = 'ts-prop-input';
  nameInp.value = layer.name; nameInp.placeholder = 'Layer name';
  nameInp.addEventListener('input', () => { layer.name = nameInp.value; renderLayersList(); });

  panel.appendChild(section('Layer',
    prop('Name', nameInp),
    prop('Binds to', makeChips([
      { label: 'Verse', value: 'verse' },
      { label: 'Ref', value: 'reference' },
      { label: 'Custom', value: 'custom' },
    ], layer.binding, v => { layer.binding = v; customRow.style.display = v === 'custom' ? '' : 'none'; up(); }))
  ));

  renderLayoutProps(panel, layer);

  const customInp = document.createElement('input');
  customInp.type = 'text'; customInp.className = 'ts-prop-input';
  customInp.value = layer.customText || ''; customInp.placeholder = 'Custom text…';
  customInp.addEventListener('input', () => { layer.customText = customInp.value; up(); });
  const customRow = section(null, prop('Text', customInp));
  customRow.style.display = layer.binding === 'custom' ? '' : 'none';
  panel.appendChild(customRow);

  // Font
  panel.appendChild(section('Font',
    prop('Family', makeFontSelect(layer.font.family, v => { layer.font.family = v; up(); })),
    (() => {
      const row = document.createElement('div');
      row.className = 'ts-prop-row';
      row.style.gap = '8px';
      const szLabel = document.createElement('span'); szLabel.className = 'ts-prop-label'; szLabel.textContent = 'Size';
      const szInp = makeNumber(layer.font.size, 8, 300, 1, v => { layer.font.size = v; up(); });
      const wtLabel = document.createElement('span'); wtLabel.className = 'ts-prop-label'; wtLabel.textContent = 'Weight';
      const wtInp = makeWeightSelect(layer.font.weight, v => { layer.font.weight = v; up(); });
      row.appendChild(szLabel); row.appendChild(szInp);
      row.appendChild(wtLabel); row.appendChild(wtInp);
      return row;
    })(),
    (() => {
      const row = document.createElement('div');
      row.className = 'ts-prop-row'; row.style.gap = '8px';
      const itLabel = document.createElement('span'); itLabel.className = 'ts-prop-label'; itLabel.textContent = 'Italic';
      const itToggle = makeToggle(layer.font.italic, v => { layer.font.italic = v; up(); });
      const trLabel = document.createElement('span'); trLabel.className = 'ts-prop-label'; trLabel.style.marginLeft = '8px'; trLabel.textContent = 'Case';
      const trChips = makeChips([
        {label:'None',value:'none'},{label:'Upper',value:'uppercase'},{label:'Lower',value:'lowercase'}
      ], layer.font.transform, v => { layer.font.transform = v; up(); });
      row.appendChild(itLabel); row.appendChild(itToggle);
      row.appendChild(trLabel); row.appendChild(trChips);
      return row;
    })()
  ));

  // Spacing
  panel.appendChild(section('Spacing',
    prop('Line H', makeSlider(layer.font.lineHeight, 0.8, 3, v => { layer.font.lineHeight = parseFloat(v.toFixed(2)); up(); })),
    prop('Letter', makeSlider(layer.font.letterSpacing, -5, 30, v => { layer.font.letterSpacing = parseFloat(v.toFixed(1)); up(); }))
  ));

  // Color
  panel.appendChild(section('Color',
    prop('Color', makeColor(layer.color, v => { layer.color = v; up(); })),
    prop('Opacity', makeSlider(layer.opacity, 0, 100, v => { layer.opacity = v; up(); })),
    prop('Align', makeAlignBtns(layer.align, v => { layer.align = v; up(); }))
  ));

  // Shadow
  const shadowDetails = section(null,
    prop('Color', makeColor(layer.shadow.color, v => { layer.shadow.color = v; up(); })),
    prop('Opacity', makeSlider(layer.shadow.opacity, 0, 100, v => { layer.shadow.opacity = v; up(); })),
    prop('Blur', makeSlider(layer.shadow.blur, 0, 60, v => { layer.shadow.blur = v; up(); })),
    (() => {
      const row = document.createElement('div'); row.className = 'ts-prop-row'; row.style.gap = '8px';
      const xl = document.createElement('span'); xl.className = 'ts-prop-label'; xl.textContent = 'X';
      const yl = document.createElement('span'); yl.className = 'ts-prop-label'; yl.textContent = 'Y';
      const xi = makeNumber(layer.shadow.x, -50, 50, 1, v => { layer.shadow.x = v; up(); });
      const yi = makeNumber(layer.shadow.y, -50, 50, 1, v => { layer.shadow.y = v; up(); });
      row.appendChild(xl); row.appendChild(xi); row.appendChild(yl); row.appendChild(yi);
      return row;
    })()
  );
  shadowDetails.style.display = layer.shadow.enabled ? '' : 'none';

  const shadowHeader = document.createElement('div');
  shadowHeader.className = 'ts-prop-row';
  const shLabel = document.createElement('span'); shLabel.className = 'ts-prop-label'; shLabel.textContent = 'Shadow';
  const shToggle = makeToggle(layer.shadow.enabled, v => { layer.shadow.enabled = v; shadowDetails.style.display = v ? '' : 'none'; up(); });
  shadowHeader.appendChild(shLabel); shadowHeader.appendChild(shToggle);
  const shadowSection = section('Shadow', shadowHeader);
  panel.appendChild(shadowSection);
  panel.appendChild(shadowDetails);

  // Outline
  const outlineDetails = section(null,
    prop('Color', makeColor(layer.outline.color, v => { layer.outline.color = v; up(); })),
    prop('Width', makeSlider(layer.outline.width, 1, 10, v => { layer.outline.width = v; up(); }))
  );
  outlineDetails.style.display = layer.outline.enabled ? '' : 'none';

  const outlineHeader = document.createElement('div');
  outlineHeader.className = 'ts-prop-row';
  const olLabel = document.createElement('span'); olLabel.className = 'ts-prop-label'; olLabel.textContent = 'Outline';
  const olToggle = makeToggle(layer.outline.enabled, v => { layer.outline.enabled = v; outlineDetails.style.display = v ? '' : 'none'; up(); });
  outlineHeader.appendChild(olLabel); outlineHeader.appendChild(olToggle);
  panel.appendChild(section('Outline', outlineHeader));
  panel.appendChild(outlineDetails);

  // Scroll — continuous horizontal marquee (news-ticker / large-scroll
  // layers, see the Ticker and Scroll — Fill Screen presets). Independent of
  // layout: works on the Ticker preset's bottom strip or a free-canvas box
  // just as well. Speed is seconds per full loop — lower is faster.
  if (!layer.scroll) layer.scroll = { enabled: false, speed: 15 };
  const scrollDetails = section(null,
    prop('Speed', makeSlider(layer.scroll.speed, 3, 60, v => { layer.scroll.speed = v; up(); }))
  );
  scrollDetails.style.display = layer.scroll.enabled ? '' : 'none';

  const scrollHeader = document.createElement('div');
  scrollHeader.className = 'ts-prop-row';
  const scLabel = document.createElement('span'); scLabel.className = 'ts-prop-label'; scLabel.textContent = 'Scroll';
  const scToggle = makeToggle(layer.scroll.enabled, v => { layer.scroll.enabled = v; scrollDetails.style.display = v ? '' : 'none'; up(); });
  scrollHeader.appendChild(scLabel); scrollHeader.appendChild(scToggle);
  panel.appendChild(section('Scroll', scrollHeader));
  panel.appendChild(scrollDetails);
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
  if (tsMode === 'item') { tsMode = 'theme'; tsItemCtx = null; toggleItemModeChrome(false); }
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
  syncMetaRow();
  renderProps();
  // Render after layout settles so the stage has real dimensions — the preview
  // scale and verse auto-fit both measure the stage.
  requestAnimationFrame(() => renderPreview());
}

function closeThemeStudio() {
  looksModal?.classList.add('hidden');
  looksBtn?.classList.remove('active');
  document.querySelector('.main-layout')?.classList.remove('hidden-el');
}

// Item mode reuses this same modal shell (left/center/right three-pane
// layout) but has no use for whole-theme concerns: creating/importing/
// exporting/renaming/deleting themes, or the layout/transition/canvas/
// translate-to row. Hiding these wholesale (plain classList toggles, no
// per-control changes) is simpler and safer than threading tsMode checks
// into each of those unrelated render paths. Adding new layers IS supported
// in item mode (per-slide custom text/shape/image layers, stored on the
// item) — Text, Shape, Image and Library all stay visible; only the
// whole-theme meta row (layout/transition/canvas/translate-to) is hidden.
function toggleItemModeChrome(isItem) {
  document.querySelector('#ts-pane-themes .ts-col-header')?.classList.toggle('hidden', isItem);
  document.getElementById('ts-item-mode-header')?.classList.toggle('hidden', !isItem);
  document.getElementById('ts-item-theme-header')?.classList.toggle('hidden', !isItem);
  document.querySelector('.ts-meta-row')?.classList.toggle('hidden', isItem);
  // Canvas size is a whole-theme concern (like Layout/Transition/Canvas,
  // which the line above already hides) — floats over the preview instead
  // of living in that row, so it needs its own toggle here.
  document.querySelector('.ts-canvas-size-group')?.classList.toggle('hidden', isItem);
  const hint = document.querySelector('.ts-layers-hint');
  if (hint) hint.style.visibility = isItem ? 'hidden' : '';
  if (isItem) updateItemThemeLabel();
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
  return explicit || primaryOutputLook() || looks[0] || null;
}

// Builds the synthetic "look" item mode points activeLook at: a deep clone
// of the item's real base theme, namespaced so it can never collide with an
// actual theme id, with this specific slide's stored overrides (if any)
// merged field-by-field onto each text layer — a partial override (say, just
// font.size) must not blow away the rest of the base theme's settings.
function buildSyntheticLook(item, slideIndex) {
  const base = resolveItemBaseLook(item);
  const clone = deepClone(base) || { layers: [] };
  clone.id = `item-edit:${item.id}:${slideIndex}`;
  const overrides = item.slideStyles?.[slideIndex] || {};
  (clone.layers || []).forEach(layer => {
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
      if (window.KairoService.canDuplicateSlide(item, s)) {
        editGroup.push({ label: 'Duplicate', onClick: () => window.KairoService.duplicateSlide(item, i) });
      }
      const selection = window.KairoService.selectedSlideIndices.size
        ? window.KairoService.selectedSlideIndices : new Set([i]);
      if (window.KairoService.anySlidesDuplicable(item, selection)) {
        editGroup.push({
          label: selection.size > 1 ? `Copy ${selection.size} slides` : 'Copy',
          onClick: () => window.KairoService.copySlides(item, selection),
        });
      }
      if (window.KairoService.slideClipboard && item.type === 'slides') {
        editGroup.push({ label: 'Paste', onClick: () => window.KairoService.pasteSlides(item, i) });
      }
      if (editGroup.length) sections.push(editGroup);
      if (sections.length) window.KairoService.openContextMenu(e.clientX, e.clientY, sections);
    });
    el.appendChild(row);
  });

  el.querySelectorAll('.ts-item-slide-thumb').forEach(thumb => {
    const pending = thumb.__pendingPaint;
    if (!pending) return;
    const { s, i } = pending;
    window.KairoService.paintLookLayers(thumb, baseLook, item.slideStyles?.[i] || {}, {
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
}

// Mirrors selectLook()'s fan-out (swap the data-source, reset history, then
// the same five renders) — the established idiom in this file for "point
// the whole engine at something else."
function selectItemSlide(index) {
  if (!tsItemCtx) return;
  tsItemCtx.slideIndex = index;
  resetItemHistory();
  activeLayer = null;
  activeLook = buildSyntheticLook(tsItemCtx.item, index);
  renderItemSlidesList(); renderLayersList(); renderPreview(); renderProps();
}

// ── Item mode open/close (mirrors openThemeStudio/closeThemeStudio above) ──
function openItemStyleEditor(itemId, slideIndex = 0) {
  const item = window.KairoService?.service?.items.find(i => i.id === itemId);
  if (!item) return;
  tsMode = 'item';
  tsItemCtx = { item, slideIndex, baseLook: resolveItemBaseLook(item) };
  document.querySelector('.main-layout')?.classList.add('hidden-el');
  document.getElementById('service-view')?.classList.add('hidden');
  looksModal?.classList.remove('hidden');
  toggleItemModeChrome(true);
  resetItemHistory();
  activeLayer = null;
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
  activeLayer = null;
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
  activeLayer = null;
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

// Esc returns to the dashboard (unless a text field has focus). Item mode
// reuses this same modal, so route to its own close function instead.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || looksModal?.classList.contains('hidden')) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
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
  renderLayersList(); renderPreview(); renderProps(); syncMetaRow();
  toast(`Pasted ${pasted.length} layer${pasted.length === 1 ? '' : 's'}`, 'success');
}
document.addEventListener('keydown', (e) => {
  if (looksModal?.classList.contains('hidden') || !activeLook || tsMode === 'item') return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT')) return;
  if (!(e.metaKey || e.ctrlKey)) return;
  const key = e.key.toLowerCase();

  if (key === 'a') { e.preventDefault(); selectAllLayers(); }
  else if (key === 'c') { if (multiSelectedLayerIds.size || activeLayer) { e.preventDefault(); copyLayers(); } }
  else if (key === 'v') { if (layerClipboard.length) { e.preventDefault(); pasteLayers(); } }
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
    ids.forEach(id => deleteLayer(activeLook.layers.find(l => l.id === id)));
  } else if (activeLayer) {
    e.preventDefault();
    deleteLayer(activeLayer);
  }
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
  if (!activeLayer && !multiSelectedLayerIds.size) return;
  if (e.target !== e.currentTarget && e.target !== stage) return;
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

// Layout chips
document.getElementById('ts-layout-picker')?.addEventListener('click', e => {
  const btn = e.target.closest('.ts-chip');
  if (!btn || !activeLook) return;
  document.querySelectorAll('#ts-layout-picker .ts-chip').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  activeLook.layout = btn.dataset.layout;
  syncMetaRow();
  renderPreview();
  scheduleThemeAutosave();
});

// Translate-to language chips (Multi-Language layout only)
document.getElementById('ts-translate-picker')?.addEventListener('click', e => {
  const btn = e.target.closest('.ts-chip');
  if (!btn || !activeLook) return;
  const same = activeLook.translateTo === btn.dataset.lang;
  activeLook.translateTo = same ? null : btn.dataset.lang; // click again to clear
  syncMetaRow();
  renderPreview();
  scheduleThemeAutosave();
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

// Canvas alpha toggle — flips the base background between its fill and
// transparent, remembering the previous fill so it round-trips.
document.getElementById('ts-alpha-toggle')?.addEventListener('click', () => {
  const bg = baseBgLayer();
  if (!bg) { toast('This theme has no background layer', 'error'); return; }
  if (bg.fill === 'transparent') {
    bg.fill = bg.fillBefore || 'solid';
    delete bg.fillBefore;
  } else {
    bg.fillBefore = bg.fill;
    bg.fill = 'transparent';
  }
  syncMetaRow();
  up();
  renderProps();
});

// Animation chips
document.getElementById('ts-anim-picker')?.addEventListener('click', e => {
  const btn = e.target.closest('.ts-chip');
  if (!btn || !activeLook) return;
  document.querySelectorAll('#ts-anim-picker .ts-chip').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  activeLook.animation = btn.dataset.anim;
  document.getElementById('ts-anim-speed')?.classList.toggle('hidden', btn.dataset.anim === 'cut');
  scheduleThemeAutosave();
});

// Transition speed — a multiplier on display.html's base 300ms (see
// renderStage there), not a raw duration, so "1" always means exactly the
// original hardcoded speed regardless of what that baseline happens to be.
document.getElementById('ts-anim-speed')?.addEventListener('input', e => {
  if (!activeLook) return;
  activeLook.animationSpeed = parseFloat(e.target.value);
  scheduleThemeAutosave();
});

// Text Animation dropdown — a separate setting from the Transition chips
// above (see KairoWordSplit's file header for why these were split out of
// one overloaded `animation` field). A plain <select>, not a chip row like
// Transition/Layout — 10 options wrapped across rows of pill buttons read
// as a wall of buttons, a dropdown is the normal control once a list gets
// this long. 'none' clears it back to plain text.
document.getElementById('ts-text-anim-select')?.addEventListener('change', e => {
  if (!activeLook) return;
  activeLook.textAnimation = e.target.value === 'none' ? null : e.target.value;
  syncMetaRow();
  scheduleThemeAutosave();
  renderPreview();
});

document.getElementById('ts-text-anim-speed')?.addEventListener('input', e => {
  if (!activeLook) return;
  activeLook.textAnimationSpeed = parseFloat(e.target.value);
  scheduleThemeAutosave();
  renderPreview();
});

document.getElementById('ts-text-anim-color')?.addEventListener('input', e => {
  if (!activeLook) return;
  activeLook.textHighlightColor = e.target.value;
  scheduleThemeAutosave();
  renderPreview();
});

document.getElementById('ts-text-anim-intensity')?.addEventListener('input', e => {
  if (!activeLook) return;
  activeLook.textAnimationIntensity = parseFloat(e.target.value);
  scheduleThemeAutosave();
  renderPreview();
});

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
    const fit = Math.min(TS_DESIGN_W * 0.5 / w, TS_DESIGN_H * 0.5 / h, 1);
    const pw = Math.round(w * fit), ph = Math.round(h * fit);
    const layer = {
      id: 'image-' + Date.now(), type: 'image', name: (nameHint || 'Image').replace(/\.[^.]+$/, '').slice(0, 24),
      visible: true, src, fit: 'contain', opacity: 100, radius: 0,
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
  grid.textContent = 'Loading…';
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
document.getElementById('ts-add-image-btn')?.addEventListener('click', () => tsImageFile?.click());
tsImageFile?.addEventListener('change', async () => {
  const file = tsImageFile.files?.[0];
  tsImageFile.value = '';
  if (!file || !activeLook) return;
  try {
    const { src, w, h } = await loadImageFile(file);
    // Place it centred, scaled to fit comfortably inside the canvas.
    const fit = Math.min(TS_DESIGN_W * 0.5 / w, TS_DESIGN_H * 0.5 / h, 1);
    const pw = Math.round(w * fit), ph = Math.round(h * fit);
    const layer = {
      id: 'image-' + Date.now(), type: 'image', name: file.name.replace(/\.[^.]+$/, '').slice(0, 24) || 'Image',
      visible: true, src, fit: 'contain', opacity: 100, radius: 0,
      pos: { x: Math.round((TS_DESIGN_W - pw) / 2), y: Math.round((TS_DESIGN_H - ph) / 2), w: pw, h: ph },
    };
    activeLook.layers.push(layer);
    activeLayer = layer;
    // up() (not a bare render) — see the Add Text handler above for why.
    up();
    renderProps();
  } catch {
    toast('Could not load that image', 'error');
  }
});

// ── Background removal (colour key) ───────────────────────────────────────
// Removes a flat backdrop from an image layer by keying out every pixel within
// `tolerance` of a sample colour, then feathering the resulting edge. This is
// the reliable, dependency-free case: logos, graphics and anything shot on a
// flat/green backdrop. (Full AI subject cutout needs a segmentation model —
// tracked separately.) Sample colour defaults to the most common edge pixel,
// which is the backdrop in virtually every real image.
// Pixels processed per chunk before yielding back to the event loop — keeps
// a large background image (e.g. 4000x3000) from visibly freezing the whole
// UI for the entire duration of the keying pass.
const BG_REMOVE_CHUNK_PIXELS = 200_000;

function removeImageBackground(layer, tolerance = 40) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onerror = () => reject(new Error('decode failed'));
    img.onload = async () => {
      const w = img.naturalWidth, h = img.naturalHeight;
      const c = document.createElement('canvas');
      c.width = w; c.height = h;
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0);
      const imgData = ctx.getImageData(0, 0, w, h);
      const d = imgData.data;

      // Sample the border: the modal colour around the edge is the backdrop.
      const counts = new Map();
      const sample = (x, y) => {
        const i = (y * w + x) * 4;
        // Quantise to 8 levels/channel so near-identical pixels group together.
        const key = ((d[i] >> 5) << 10) | ((d[i + 1] >> 5) << 5) | (d[i + 2] >> 5);
        counts.set(key, (counts.get(key) || 0) + 1);
      };
      for (let x = 0; x < w; x++) { sample(x, 0); sample(x, h - 1); }
      for (let y = 0; y < h; y++) { sample(0, y); sample(w - 1, y); }
      let bestKey = 0, bestN = -1;
      for (const [k, n] of counts) if (n > bestN) { bestN = n; bestKey = k; }
      const kr = ((bestKey >> 10) & 31) * 8 + 4;
      const kg = ((bestKey >> 5)  & 31) * 8 + 4;
      const kb = ( bestKey        & 31) * 8 + 4;

      // Key out matching pixels; feather partial matches so edges don't jag.
      // Chunked with a yield every BG_REMOVE_CHUNK_PIXELS pixels rather than
      // one uninterrupted pass over the whole buffer.
      const hard = tolerance, soft = tolerance * 1.8;
      const chunkStride = BG_REMOVE_CHUNK_PIXELS * 4;
      for (let i = 0; i < d.length; i += 4) {
        const dist = Math.sqrt(
          (d[i] - kr) ** 2 + (d[i + 1] - kg) ** 2 + (d[i + 2] - kb) ** 2
        );
        if (dist <= hard) d[i + 3] = 0;
        else if (dist < soft) d[i + 3] = Math.round(d[i + 3] * ((dist - hard) / (soft - hard)));
        if (i % chunkStride === 0) await new Promise(r => setTimeout(r, 0));
      }
      ctx.putImageData(imgData, 0, 0);
      resolve(c.toDataURL('image/png'));   // PNG — alpha must survive
    };
    img.src = layer.src;
  });
}

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
  activeLayer = null;
  resetThemeHistory(); // a freshly-imported theme has no undo history of its own to inherit
  saveLooks();
  renderLooksList(); renderLayersList(); syncMetaRow(); renderPreview(); renderProps();
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
  looks.push(base);
  activeLook  = base;
  activeLayer = null;
  resetThemeHistory();
  saveLooks();
  renderLooksList();
  renderLayersList();
  syncMetaRow();
  renderPreview();
  renderProps();
  document.querySelector('.ts-theme-item.active .ts-theme-name')?.dispatchEvent(new Event('dblclick', { bubbles: true }));
});

// ── Per-output themes ─────────────────────────────────────────────────────
// Each destination renders with its own theme — the ProPresenter model where
// stage and audience screens show different designs from the same source. The
// assignment lives with the OUTPUT (in Settings), not with the theme.
// One card per output. The primary external display keeps its own card (its
// theme picker is injected inline like every other output); any *additional*
// screens a church drives — stage monitor, foyer — are appended inside that
// card as extra rows.
const PRIMARY_DISPLAY = 'display-1';
const OUTPUT_DEFS = [
  { key: PRIMARY_DISPLAY, card: 'card-external',     label: 'External Display' },
  { key: 'ndi',           card: 'card-ndi',          label: 'NDI' },
  { key: 'syphon',        card: 'card-syphon',       label: 'Syphon' },
  { key: 'obs',           card: 'card-obs',          label: 'OBS' },
  { key: 'propresenter',  card: 'card-propresenter', label: 'ProPresenter' },
];

// Extra screens beyond the primary one. Stored in settings; empty by default.
function extraDisplays() {
  const list = settings.extraDisplays;
  return Array.isArray(list) ? list : [];
}

// Every screen, primary first — used for theme assignment and broadcasting.
function displayOutputs() {
  return [{ id: PRIMARY_DISPLAY, name: 'External Display' }, ...extraDisplays()];
}

function allOutputKeys() {
  return [...OUTPUT_DEFS.map(d => d.key), ...extraDisplays().map(d => d.id)];
}

// ── Physical screen assignment ───────────────────────────────────────────
// Which real, detected screen each display output (External Display, extra
// display rows — NOT the broadcast-only outputs like NDI/Syphon) has been
// deliberately pointed at, keyed by output id. Populated from the Window
// Management API (see refreshDisplayStatus) and chosen explicitly per
// output, the same way ProPresenter's Hardware tab has the operator pick a
// device/resolution per screen rather than guessing from whatever's first
// in the OS's list. Used both to open a display window on the right
// physical screen (openDisplayOutput) and to shape the Live preview panel
// when it's monitoring that output (applyLivePreviewAspect).
let cachedScreens = [];

function outputScreenMap() {
  return (settings.outputScreens && typeof settings.outputScreens === 'object') ? settings.outputScreens : {};
}

function setOutputScreen(outputId, screen) {
  const map = { ...outputScreenMap() };
  if (screen) map[outputId] = screen; else delete map[outputId];
  settings.outputScreens = map;
  saveSettingsPatch({ outputScreens: map });
}

function populateScreenOptions(sel, outputId) {
  const current = outputScreenMap()[outputId];
  sel.innerHTML = '';
  const noneOpt = document.createElement('option');
  noneOpt.value = '';
  noneOpt.textContent = 'Not assigned — opens on this window’s screen';
  sel.appendChild(noneOpt);
  cachedScreens.forEach(s => {
    const o = document.createElement('option');
    o.value = String(s.index);
    o.textContent = `Screen ${s.index + 1}${s.isPrimary ? ' (this computer)' : ''} — ${s.width}×${s.height}`;
    if (current && current.width === s.width && current.height === s.height &&
        current.left === s.left && current.top === s.top) o.selected = true;
    sel.appendChild(o);
  });
}

function buildScreenSelect(outputId) {
  const sel = document.createElement('select');
  sel.className = 'setting-input output-screen-select';
  populateScreenOptions(sel, outputId);
  sel.addEventListener('change', () => {
    const s = cachedScreens[Number(sel.value)];
    setOutputScreen(outputId, s ? { width: s.width, height: s.height, left: s.left, top: s.top } : null);
    if (typeof livePreviewOutputId !== 'undefined' && livePreviewOutputId === outputId) applyLivePreviewAspect();
  });
  return sel;
}

// Inserted into the External Display card's body, right after the Theme
// picker renderOutputThemePickers already placed there.
function upsertPrimaryScreenPicker() {
  const body = document.querySelector('#card-external .output-card-body');
  if (!body) return;
  let group = body.querySelector('.output-screen-group');
  if (!group) {
    group = document.createElement('div');
    group.className = 'setting-group output-screen-group';
    const lbl = document.createElement('label');
    lbl.className = 'setting-label';
    lbl.textContent = 'Physical screen';
    group.appendChild(lbl);
    group.appendChild(buildScreenSelect(PRIMARY_DISPLAY));
    const themeGroup = body.querySelector('.output-theme-group');
    if (themeGroup) themeGroup.insertAdjacentElement('afterend', group);
    else body.insertBefore(group, body.firstChild);
  } else {
    populateScreenOptions(group.querySelector('select'), PRIMARY_DISPLAY);
  }
}

function outputThemeMap() {
  const map = settings.outputThemes && typeof settings.outputThemes === 'object'
    ? { ...settings.outputThemes } : {};
  // Carry the pre-multi-display assignment onto the first screen.
  if (map.external && !map['display-1']) map['display-1'] = map.external;
  // Any output without a valid choice falls back to the first theme.
  for (const key of allOutputKeys()) {
    if (!map[key] || !looks.some(l => l.id === map[key])) map[key] = looks[0]?.id;
  }
  return map;
}

// ── Language ──────────────────────────────────────────────────────────────
// Spoken language drives transcription; scripture language selects which verse
// corpus detection runs against. Packs are downloaded once and cached locally,
// same pattern as the offline speech model.
const LANG_PACKS = [
  { code: 'en', name: 'English',    translations: 'KJV · NIV · NLT · ESV · NASB · NKJV', bundled: true },
  { code: 'es', name: 'Spanish',    translations: 'Reina-Valera 1960' },
  { code: 'pt', name: 'Portuguese', translations: 'Almeida' },
  { code: 'fr', name: 'French',     translations: 'Louis Segond' },
  { code: 'de', name: 'German',     translations: 'Luther' },
  { code: 'yo', name: 'Yoruba',     translations: 'Bíbélì Mímọ́' },
  { code: 'ig', name: 'Igbo',       translations: 'Baịbụl Nsọ' },
  { code: 'ha', name: 'Hausa',      translations: 'Littafi Mai Tsarki' },
  { code: 'sw', name: 'Swahili',    translations: 'Biblia Habari Njema' },
];

function installedLangs() {
  const v = settings.installedLangs;
  return Array.isArray(v) && v.length ? v : ['en'];
}

function renderLangPacks() {
  const host = document.getElementById('lang-pack-list');
  const bibleSel = document.getElementById('bible-language');
  if (!host) return;
  const installed = installedLangs();

  host.innerHTML = '';
  LANG_PACKS.forEach(p => {
    const row = document.createElement('div');
    row.className = 'lang-pack-row';

    const meta = document.createElement('div');
    meta.className = 'lang-pack-meta';
    meta.innerHTML = `<div class="lang-pack-name">${p.name}</div><div class="lang-pack-sub">${p.translations}</div>`;

    const btn = document.createElement('button');
    btn.className = 'modal-btn secondary';
    const isIn = installed.includes(p.code);
    if (p.bundled) {
      btn.textContent = 'Included';
      btn.disabled = true;
    } else if (isIn) {
      btn.textContent = 'Remove';
      btn.classList.add('lang-pack-remove');
      btn.addEventListener('click', () => {
        settings.installedLangs = installed.filter(c => c !== p.code);
        if (settings.bibleLanguage === p.code) settings.bibleLanguage = 'en';
        saveSettingsPatch({ installedLangs: settings.installedLangs, bibleLanguage: settings.bibleLanguage });
        renderLangPacks();
      });
    } else {
      // /api/lang/install has never had a real source wired up (it 503s
      // without KAIRO_LANG_PACK_BASE_URL, which nothing ever sets) — and
      // even a successful install wouldn't do anything yet, since the
      // detection worker never reads settings.bibleLanguage to switch which
      // verse corpus it indexes against. Showing "Install" as if this
      // already worked was misleading; be honest that it's not built yet
      // rather than leaving a button that always fails.
      btn.textContent = 'Coming soon';
      btn.disabled = true;
      btn.title = 'Live detection in this language isn’t available yet.';
    }

    row.appendChild(meta); row.appendChild(btn);
    host.appendChild(row);
  });

  // Scripture-language dropdown lists only what's actually installed.
  if (bibleSel) {
    const want = settings.bibleLanguage || 'en';
    bibleSel.innerHTML = '';
    LANG_PACKS.filter(p => installed.includes(p.code)).forEach(p => {
      const o = document.createElement('option');
      o.value = p.code; o.textContent = p.name;
      if (p.code === want) o.selected = true;
      bibleSel.appendChild(o);
    });
  }
}

document.getElementById('stt-language')?.addEventListener('change', (e) => {
  settings.sttLanguage = e.target.value;
  saveSettingsPatch({ sttLanguage: e.target.value });
});
document.getElementById('bible-language')?.addEventListener('change', (e) => {
  settings.bibleLanguage = e.target.value;
  saveSettingsPatch({ bibleLanguage: e.target.value });
});

// ── Extra display rows ────────────────────────────────────────────────────
async function renderDisplayOutputs() {
  await refreshDisplayStatus();
  upsertPrimaryScreenPicker();

  const host = document.getElementById('extra-displays-list');
  if (host) {
    const map = outputThemeMap();
    host.innerHTML = '';

    extraDisplays().forEach((d, i) => {
      const row = document.createElement('div');
      row.className = 'display-output-row';

      const name = document.createElement('input');
      name.type = 'text';
      name.className = 'setting-input';
      name.value = d.name || `Display ${i + 2}`;
      name.placeholder = 'Screen name';
      name.addEventListener('change', () => {
        const list = extraDisplays().map(x => x.id === d.id ? { ...x, name: name.value.trim() || x.name } : x);
        settings.extraDisplays = list;
        saveSettingsPatch({ extraDisplays: list });
        renderDisplayOutputs();
      });

      const sel = document.createElement('select');
      sel.className = 'setting-input';
      looks.forEach(l => {
        const o = document.createElement('option');
        o.value = l.id; o.textContent = l.name;
        if (l.id === map[d.id]) o.selected = true;
        sel.appendChild(o);
      });
      sel.addEventListener('change', () => {
        settings.outputThemes = { ...outputThemeMap(), [d.id]: sel.value };
        saveSettingsPatch({ outputThemes: settings.outputThemes });
        applyOutputThemes();
      });

      const screenSel = buildScreenSelect(d.id);

      const open = document.createElement('button');
      open.className = 'modal-btn secondary';
      open.textContent = 'Open';
      open.addEventListener('click', () => openDisplayOutput(d));

      const del = document.createElement('button');
      del.className = 'modal-btn secondary display-output-del';
      del.innerHTML = `<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>`;
      del.title = 'Remove this display';
      del.addEventListener('click', () => {
        settings.extraDisplays = extraDisplays().filter(x => x.id !== d.id);
        const map2 = { ...outputScreenMap() }; delete map2[d.id];
        settings.outputScreens = map2;
        saveSettingsPatch({ extraDisplays: settings.extraDisplays, outputScreens: map2 });
        renderDisplayOutputs();
        applyOutputThemes();
      });

      row.appendChild(name); row.appendChild(sel); row.appendChild(screenSel); row.appendChild(open); row.appendChild(del);
      host.appendChild(row);
    });
  }

  renderLivePreviewOutputSelect();
}

// Report whether a second screen is actually attached, so the operator knows
// whether "Open" will land on a projector or just stack on this monitor.
// Also refreshes cachedScreens from the Window Management API when
// available, which the per-output screen pickers (upsertPrimaryScreenPicker,
// buildScreenSelect) read synchronously once this resolves — resolution
// itself is no longer captured here; each output's screen is chosen
// explicitly instead (see outputScreenMap).
async function refreshDisplayStatus() {
  const hint = document.getElementById('display-status-hint');
  if (!hint) return;
  const extras = extraDisplays().length;
  const configured = 1 + extras;
  let detected = null;
  // Real OS-level enumeration first — the Window Management API
  // (getScreenDetails/isExtended) this used to rely on exclusively is
  // Chromium-only and WebKit has never implemented it, so it silently
  // never detected anything in the packaged macOS app (see list_monitors
  // in src-tauri/src/lib.rs for the full story). Only fall back to the
  // web APIs when not running inside Tauri at all (e.g. testing app.js
  // directly in a plain browser tab).
  const tauriInvoke = window.__TAURI__?.core?.invoke || window.__TAURI__?.invoke;
  if (tauriInvoke) {
    try {
      const screens = await tauriInvoke('list_monitors');
      if (Array.isArray(screens) && screens.length) {
        cachedScreens = screens;
        detected = screens.length;
      }
    } catch (err) { console.warn('[KAIRO] list_monitors failed:', err); }
  }
  if (detected == null) {
    try {
      if (window.getScreenDetails) {
        const d = await window.getScreenDetails();
        const screens = d.screens || [];
        cachedScreens = screens.map((s, i) => ({
          index: i, width: s.width, height: s.height, left: s.left, top: s.top, isPrimary: !!s.isPrimary,
        }));
        detected = screens.length;
      } else if (typeof window.screen?.isExtended === 'boolean') {
        detected = window.screen.isExtended ? 2 : 1;
      }
    } catch { /* permission denied — leave cachedScreens as last known, fall back below */ }
    if (detected == null && typeof window.screen?.isExtended === 'boolean') {
      detected = window.screen.isExtended ? 2 : 1;
    }
  }

  if (detected == null) {
    hint.innerHTML = `${configured} display output${configured > 1 ? 's' : ''} configured. Open each one and move it to its screen, or assign a detected screen to it below.`;
    return;
  }
  if (detected <= 1) {
    hint.innerHTML = `<span style="color:var(--orange)">No external display detected.</span> The window will open on this screen — connect a projector or second monitor first.`;
    return;
  }
  hint.innerHTML = `<span style="color:var(--blue)">${detected} screens connected.</span> ${configured} output${configured > 1 ? 's' : ''} configured — assign each to a screen below so Open lands in the right place.`;
}

// Primary external display keeps its original button.
document.getElementById('open-external-btn')?.addEventListener('click', () => {
  openDisplayOutput({ id: PRIMARY_DISPLAY, name: 'External Display' });
});

// Open a window for one screen. It identifies itself via ?output= so it renders
// with that screen's assigned theme. The explicitly-assigned physical screen
// (outputScreenMap) always wins over the old d.screen/window.screen guesses,
// which only apply when nothing's been assigned yet.
function openDisplayOutput(d) {
  const url = `/display.html?output=${encodeURIComponent(d.id)}`;
  const assigned = outputScreenMap()[d.id];
  const scr = assigned || d.screen || {};
  const w = scr.width  || window.screen.width;
  const h = scr.height || window.screen.height;
  const x = scr.left   != null ? scr.left : window.screen.width;
  const y = scr.top    != null ? scr.top  : 0;
  if (typeof openDisplayWindow === 'function') {
    openDisplayWindow(`kairo-${d.id}`, url, { width: w, height: h, x, y, fullscreen: true });
  } else {
    window.open(url, `kairo-${d.id}`, `width=${w},height=${h},left=${x},top=${y}`);
  }
}

document.getElementById('add-display-btn')?.addEventListener('click', () => {
  const list = extraDisplays();
  const next = [...list, { id: `display-${Date.now().toString(36)}`, name: `Display ${list.length + 2}` }];
  settings.extraDisplays = next;
  saveSettingsPatch({ extraDisplays: next });
  renderDisplayOutputs();
  applyOutputThemes();
});

// Inject a Theme picker into each output card body. Rebuilt whenever the theme
// list changes so newly created themes appear without reopening Settings.
function renderOutputThemePickers() {
  const map = outputThemeMap();
  OUTPUT_DEFS.forEach(({ key, card }) => {
    const body = document.querySelector(`#${card} .output-card-body`);
    if (!body) return;

    let group = body.querySelector('.output-theme-group');
    if (!group) {
      group = document.createElement('div');
      group.className = 'setting-group output-theme-group';
      const lbl = document.createElement('label');
      lbl.className = 'setting-label';
      lbl.textContent = 'Theme';
      const sel = document.createElement('select');
      sel.className = 'setting-input output-theme-select';
      sel.dataset.outputKey = key;
      sel.addEventListener('change', () => {
        settings.outputThemes = { ...outputThemeMap(), [key]: sel.value };
        saveSettingsPatch({ outputThemes: settings.outputThemes });
        applyOutputThemes();
      });
      const hint = document.createElement('div');
      hint.style.cssText = 'font-size:11px;color:var(--text-3);margin-top:4px;';
      hint.textContent = 'Design this output uses. Edit designs in Theme Studio.';
      group.appendChild(lbl); group.appendChild(sel); group.appendChild(hint);
      body.insertBefore(group, body.firstChild);
    }

    const sel = group.querySelector('select');
    const want = map[key];
    sel.innerHTML = '';
    looks.forEach(l => {
      const o = document.createElement('option');
      o.value = l.id; o.textContent = l.name;
      if (l.id === want) o.selected = true;
      sel.appendChild(o);
    });

    // Mirror the assignment into the card header so the output→theme mapping
    // is readable without expanding every card.
    const header = document.querySelector(`#${card} .output-card-header`);
    if (header) {
      let badge = header.querySelector('.output-theme-badge');
      if (!badge) {
        badge = document.createElement('span');
        badge.className = 'output-theme-badge';
        const chevron = header.querySelector('.output-card-chevron');
        header.insertBefore(badge, chevron || null);
      }
      badge.textContent = looks.find(l => l.id === want)?.name || '—';
    }
  });
}

// Push the current per-output assignment to every display client.
async function applyOutputThemes() {
  const map = outputThemeMap();
  const themes = {};
  for (const [key, id] of Object.entries(map)) {
    const look = looks.find(l => l.id === id);
    if (look) themes[key] = look;
  }
  // Same-origin display windows pick this up via the storage event.
  localStorage.setItem('kairo-output-themes', JSON.stringify(themes));
  localStorage.setItem('kairo-active-look-ts', Date.now().toString());
  // Keep the legacy single-look key in sync so any display window opened
  // without an ?output= tag still shows the primary screen's theme.
  const primary = themes[displayOutputs()[0]?.id] || themes.external;
  if (primary) localStorage.setItem('kairo-active-look', JSON.stringify(primary));

  try {
    await fetch(`${SERVER}/api/look/apply`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ themes, look: primary || null }),
    });
  } catch (err) {
    console.warn('[Look] per-output broadcast failed:', err.message);
  }

  // Whatever's already showing in the in-app preview only carries its own
  // look when the sent item had one — anything using the output-default
  // fallback (renderPreviewScreen's primaryOutputLook()) is now stale the
  // instant the assignment changes. Re-paint it immediately instead of
  // leaving the operator staring at yesterday's theme until the next send.
  if (!lastPreviewHadOwnLook && previewVerseText && previewVerseText.textContent !== 'Nothing on display') {
    renderPreviewScreen(previewVerseText.textContent, previewVerseRef?.textContent || '', null);
  }
}

// Persist a partial settings change without clobbering unrelated fields.
async function saveSettingsPatch(patch) {
  try {
    await fetch(`${SERVER}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    });
  } catch (err) {
    console.warn('[Settings] save failed:', err.message);
  }
}

// ── Auto-update listener (Tauri only) ─────────────────────────────────────
// The Rust side emits `update-available` after a background check on startup.
// We show a dismissible banner; clicking it calls install_update() in Rust,
// which downloads the package and restarts the app.
(function initUpdater() {
  if (!window.__TAURI__) return; // not running inside Tauri shell

  window.__TAURI__.event.listen('update-available', (event) => {
    const { version, notes } = event.payload || {};
    showUpdateBanner(version, notes);
  });

  // Only fired for an explicit "Check for Updates…" (Help menu) — the
  // silent startup check never emits this event, so there's no risk of an
  // unprompted "you're up to date" toast on every launch.
  window.__TAURI__.event.listen('update-check-result', (event) => {
    const { upToDate, error } = event.payload || {};
    if (upToDate) toast('KAIRO is up to date.', 'success');
    else if (error) toast('Could not check for updates: ' + error, 'error');
  });

  function showUpdateBanner(version, notes) {
    const existing = document.getElementById('update-banner');
    if (existing) existing.remove();

    const banner = document.createElement('div');
    banner.id = 'update-banner';
    banner.innerHTML = `
      <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <polyline points="16 3 21 3 21 8"/><line x1="4" y1="20" x2="21" y2="3"/>
        <polyline points="21 16 21 21 16 21"/><line x1="15" y1="4" x2="21" y2="10"/>
      </svg>
      <span>KAIRO <strong>${version || 'update'}</strong> is available${notes ? ' — ' + notes.split('\n')[0] : ''}.</span>
      <button class="upd-btn" id="upd-install-btn">Update &amp; Restart</button>
      <button class="upd-snooze" id="upd-snooze-btn" aria-label="Dismiss">Later</button>
    `;
    document.body.insertBefore(banner, document.body.firstChild);

    document.getElementById('upd-install-btn').addEventListener('click', async () => {
      document.getElementById('upd-install-btn').textContent = 'Downloading…';
      document.getElementById('upd-install-btn').disabled = true;
      try {
        await window.__TAURI__.core.invoke('install_update');
      } catch (e) {
        toast('Update failed: ' + e, 'error');
        banner.remove();
      }
    });

    document.getElementById('upd-snooze-btn').addEventListener('click', () => banner.remove());
  }
})();

// ── Native app menu bridge (Tauri only) ───────────────────────────────────
// File > New Theme/Import…/Export Current Theme dispatch here as plain
// window events (see build_app_menu/on_menu_event in src-tauri/src/lib.rs)
// rather than Rust reimplementing any of those flows — every one of them
// already exists as a toolbar button in Theme Studio (file pickers,
// unsaved-state handling, toasts and all), so the menu just opens Theme
// Studio if it isn't already open and clicks that same button.
(function initNativeMenuBridge() {
  if (!window.__TAURI__) return;
  const clickWhenReady = (btnId) => {
    if (looksModal?.classList.contains('hidden')) openThemeStudio();
    document.getElementById(btnId)?.click();
  };
  window.__TAURI__.event.listen('menu-new-theme',     () => clickWhenReady('new-look-btn'));
  window.__TAURI__.event.listen('menu-import',        () => clickWhenReady('import-look-btn'));
  window.__TAURI__.event.listen('menu-export-theme',  () => clickWhenReady('export-look-btn'));
  // KAIRO > Settings… (Cmd+,) — same panel the toolbar gear icon opens.
  window.__TAURI__.event.listen('menu-settings',      () => { settingsModal?.classList.remove('hidden'); showFirstSettingsPane(); });
})();

// ═══════════════════════════════════════════════════════════════════════════
// CONTENT STUDIO — capture, save, generate, export
// ═══════════════════════════════════════════════════════════════════════════
(function () {
  const openBtn       = document.getElementById('content-studio-btn');
  const modal         = document.getElementById('content-studio-modal');
  if (!openBtn || !modal) return;

  const closeBtn      = modal.querySelector('#close-content-studio');
  const sessionList   = modal.querySelector('#cs-session-list');
  const saveCurrentBtn= modal.querySelector('#cs-save-current-btn');
  const llmStatusEl   = modal.querySelector('#cs-llm-status');
  const detailPane    = modal.querySelector('#cs-detail-pane');
  const emptyPane     = modal.querySelector('#cs-empty-pane');

  const detailTitleEl = modal.querySelector('#cs-detail-title');
  const detailMetaEl  = modal.querySelector('#cs-detail-meta');
  const tabNoteBtn    = modal.querySelector('#cs-tab-note');
  const tabPointsBtn  = modal.querySelector('#cs-tab-points');
  const tabSourceBtn  = modal.querySelector('#cs-tab-source');
  const generateBtn   = modal.querySelector('#cs-generate-btn');
  // exportBtn2 removed — top-bar download menu handles all exports now.
  const deleteBtn2    = modal.querySelector('#cs-delete-session-btn');
  const previewWrap   = modal.querySelector('#cs-preview');
  const generateLabel = modal.querySelector('#cs-generate-label');

  let activeSessionId = null;
  let activeSession   = null;
  let activeTab       = 'note'; // 'note' | 'points' | 'source'

  function snapshotCurrentSession() {
    const transcript = sessionTranscriptParts.map(p => p.text).join(' ').replace(/\s+/g, ' ').trim();
    const durationMin = startTime ? Math.max(1, Math.round((Date.now() - startTime) / 60000)) : 0;
    const verses = sessionVerses.map(v => ({ ref: v.ref, text: cleanVerseText(v.text), time: v.time }));
    return {
      title: `Sermon — ${new Date().toLocaleString()}`,
      date: new Date().toISOString().slice(0, 10),
      durationMin,
      transcript,
      transcriptParts: sessionTranscriptParts.slice(),
      verses,
    };
  }

  async function fetchSessions() {
    try {
      const r = await fetch(`${SERVER}/api/sessions`);
      const j = await r.json();
      return j.sessions || [];
    } catch { return []; }
  }

  async function fetchLLMStatus() {
    try {
      const r = await fetch(`${SERVER}/api/llm/status`);
      return await r.json();
    } catch { return { ok: false, error: 'unreachable' }; }
  }

  function renderLLMStatus(s) {
    if (!llmStatusEl) return;
    if (s.ok) {
      const has = s.models?.includes(s.configuredModel);
      llmStatusEl.innerHTML = has
        ? `<span class="cs-pill cs-pill-ok">●</span> Ollama ready · <strong>${s.configuredModel}</strong>`
        : `<span class="cs-pill cs-pill-warn">●</span> Ollama running, but <strong>${s.configuredModel}</strong> not installed. Run <code>ollama pull ${s.configuredModel}</code>`;
    } else {
      llmStatusEl.innerHTML = `<span class="cs-pill cs-pill-err">●</span> Ollama not reachable at ${s.url || 'localhost:11434'} — install from <a href="https://ollama.com" target="_blank" rel="noopener">ollama.com</a>`;
    }
  }

  function renderSessionList(items) {
    if (!sessionList) return;
    if (!items.length) {
      sessionList.innerHTML = `<div class="cs-empty-list">No saved sessions yet. Click <strong>Save current session</strong> while listening.</div>`;
      return;
    }
    sessionList.innerHTML = '';
    for (const s of items) {
      const row = document.createElement('div');
      row.className = 'cs-session-row' + (s.id === activeSessionId ? ' active' : '');
      row.dataset.id = s.id;
      row.innerHTML = `
        <div class="cs-session-row-main">
          <div class="cs-session-row-title">${escapeHtml(s.title)}</div>
          <div class="cs-session-row-meta">${s.date || ''} · ${s.verseCount} verses · ${s.wordCount.toLocaleString()} words</div>
        </div>
        <div class="cs-session-row-tags">
          ${s.hasNote ? '<span class="cs-tag">Note</span>' : ''}
          ${s.hasPoints ? '<span class="cs-tag">Points</span>' : ''}
        </div>`;
      row.addEventListener('click', () => loadSessionIntoDetail(s.id));
      sessionList.appendChild(row);
    }
  }

  async function refreshList() {
    const [items, status] = await Promise.all([fetchSessions(), fetchLLMStatus()]);
    renderLLMStatus(status);
    renderSessionList(items);
  }

  async function loadSessionIntoDetail(id) {
    try {
      const r = await fetch(`${SERVER}/api/sessions/${encodeURIComponent(id)}`);
      if (!r.ok) throw new Error('not found');
      activeSession = await r.json();
      activeSessionId = id;
    } catch { toast('Failed to load session', 'error'); return; }

    detailPane.style.display = '';
    emptyPane.style.display  = 'none';
    detailTitleEl.textContent = activeSession.title || activeSession.id;
    detailMetaEl.textContent  =
      `${activeSession.date || ''}  ·  ${activeSession.durationMin || 0} min  ·  ` +
      `${(activeSession.verses || []).length} verses  ·  ` +
      `${(activeSession.transcript || '').split(/\s+/).filter(Boolean).length.toLocaleString()} words`;

    sessionList.querySelectorAll('.cs-session-row').forEach(r => {
      r.classList.toggle('active', r.dataset.id === id);
    });
    setTab(activeTab);
  }

  function setTab(tab) {
    activeTab = tab;
    [tabNoteBtn, tabPointsBtn, tabSourceBtn].forEach(b => b?.classList.remove('active'));
    ({ note: tabNoteBtn, points: tabPointsBtn, source: tabSourceBtn })[tab]?.classList.add('active');

    if (tab === 'source') {
      generateBtn.style.display = 'none';
      generateLabel.textContent = '';
    } else {
      generateBtn.style.display = '';
      const has = !!(activeSession?.generated?.[tab]);
      generateLabel.textContent = has ? 'Regenerate' : 'Generate';
    }
    // Export PDF lives on the top-bar download menu now; no per-tab toggle.
    renderPreview();
  }

  function renderPreview() {
    if (!activeSession) { previewWrap.innerHTML = ''; return; }
    if (activeTab === 'source') {
      previewWrap.innerHTML = renderSourceHTML(activeSession);
      return;
    }
    const content = activeSession.generated?.[activeTab];
    if (!content) {
      previewWrap.innerHTML = `<div class="cs-preview-empty">
        <p>No ${activeTab === 'note' ? 'sermon note' : 'sermon points'} generated yet.</p>
        <p class="cs-hint">Click <strong>Generate</strong> — the local model reads the transcript and produces a structured output. Nothing leaves your machine.</p>
      </div>`;
      return;
    }
    previewWrap.innerHTML = activeTab === 'note'
      ? renderNoteHTML(activeSession, content)
      : renderPointsHTML(activeSession, content);
  }

  function renderSourceHTML(s) {
    const verses = (s.verses || []).map(v =>
      `<li><strong>${escapeHtml(v.ref)}</strong> <span class="cs-source-time">${escapeHtml(v.time || '')}</span><br>${escapeHtml(v.text || '')}</li>`
    ).join('') || '<li class="cs-source-empty">No verses recorded.</li>';
    const transcript = escapeHtml(s.transcript || '').replace(/\n/g, '<br>') || '<em>No transcript captured.</em>';
    return `
      <section class="cs-doc">
        <h2 class="cs-h2">Verses cited</h2>
        <ul class="cs-verse-list">${verses}</ul>
        <h2 class="cs-h2">Transcript</h2>
        <p class="cs-transcript">${transcript}</p>
      </section>`;
  }

  function renderNoteHTML(s, n) {
    const sections = (n.sections || []).map(sec => `
      <section class="cs-section">
        <h3 class="cs-h3">${escapeHtml(sec.heading)}</h3>
        ${sec.scriptures?.length ? `<div class="cs-scripture-row">${sec.scriptures.map(r => `<span class="cs-scripture-chip">${escapeHtml(r)}</span>`).join('')}</div>` : ''}
        <p class="cs-body">${escapeHtml(sec.body)}</p>
      </section>`).join('') || '<p class="cs-preview-empty">Model returned no sections.</p>';
    return `
      <article class="cs-doc">
        <header class="cs-doc-header">
          <h1 class="cs-h1">${escapeHtml(n.title || s.title)}</h1>
          <div class="cs-doc-meta">${escapeHtml(s.date || '')} · ${s.durationMin || 0} min</div>
          ${n.summary ? `<p class="cs-summary">${escapeHtml(n.summary)}</p>` : ''}
        </header>
        ${sections}
        ${n.closing ? `<footer class="cs-closing"><h3 class="cs-h3">Closing</h3><p class="cs-body">${escapeHtml(n.closing)}</p></footer>` : ''}
      </article>`;
  }

  function renderPointsHTML(s, p) {
    const items = (p.points || []).map((it, i) => `
      <li class="cs-point">
        <div class="cs-point-num">${i + 1}</div>
        <div class="cs-point-body">
          <div class="cs-point-title">${escapeHtml(it.point)}</div>
          ${it.scripture ? `<div class="cs-point-scripture">${escapeHtml(it.scripture)}</div>` : ''}
          <p class="cs-body">${escapeHtml(it.explanation)}</p>
          ${it.supportingQuote ? `<blockquote class="cs-quote">“${escapeHtml(it.supportingQuote)}”</blockquote>` : ''}
        </div>
      </li>`).join('') || '<p class="cs-preview-empty">Model returned no points.</p>';
    return `
      <article class="cs-doc">
        <header class="cs-doc-header">
          <h1 class="cs-h1">${escapeHtml(p.title || s.title)}</h1>
          <div class="cs-doc-meta">${escapeHtml(s.date || '')} · ${s.durationMin || 0} min</div>
          ${p.mainTheme ? `<p class="cs-summary"><strong>Theme — </strong>${escapeHtml(p.mainTheme)}</p>` : ''}
        </header>
        <ol class="cs-points">${items}</ol>
      </article>`;
  }

  // ── Actions ──────────────────────────────────────────────────────────────
  saveCurrentBtn?.addEventListener('click', async () => {
    const snap = snapshotCurrentSession();
    if (!snap.transcript && !snap.verses.length) {
      toast('Nothing to save — start a session first', 'info');
      return;
    }
    saveCurrentBtn.disabled = true;
    try {
      const r = await fetch(`${SERVER}/api/sessions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(snap),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'save failed');
      toast('Session saved', 'success');
      await refreshList();
      loadSessionIntoDetail(j.id);
    } catch (e) {
      toast('Save failed: ' + e.message, 'error');
    } finally {
      saveCurrentBtn.disabled = false;
    }
  });

  generateBtn?.addEventListener('click', async () => {
    if (!activeSessionId || activeTab === 'source') return;
    generateBtn.disabled = true;
    const orig = generateLabel.textContent;
    generateLabel.textContent = 'Generating…';
    previewWrap.classList.add('cs-loading');
    try {
      const r = await fetch(`${SERVER}/api/content/generate`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: activeSessionId, type: activeTab }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || 'generate failed');
      activeSession.generated = activeSession.generated || {};
      activeSession.generated[activeTab] = j.content;
      setTab(activeTab);
      refreshList();
    } catch (e) {
      toast('Generation failed: ' + e.message, 'error');
      generateLabel.textContent = orig;
    } finally {
      previewWrap.classList.remove('cs-loading');
      generateBtn.disabled = false;
    }
  });

  // Old in-modal Export PDF button is hidden; downloads live on the top-bar
  // menu now (window.__cs_exportToPDF reuses this module's render+print fns).

  deleteBtn2?.addEventListener('click', async () => {
    if (!activeSessionId) return;
    if (!(await confirmDialog('Delete this session? This cannot be undone.', { title: 'Delete session', confirmLabel: 'Delete', danger: true }))) return;
    try {
      await fetch(`${SERVER}/api/sessions/${encodeURIComponent(activeSessionId)}`, { method: 'DELETE' });
      activeSessionId = null;
      activeSession = null;
      detailPane.style.display = 'none';
      emptyPane.style.display  = '';
      refreshList();
    } catch (e) { toast('Delete failed: ' + e.message, 'error'); }
  });

  tabNoteBtn  ?.addEventListener('click', () => setTab('note'));
  tabPointsBtn?.addEventListener('click', () => setTab('points'));
  tabSourceBtn?.addEventListener('click', () => setTab('source'));

  // Background pre-flight: while the Content Studio modal is open, re-ping
  // Ollama every 15 s so the operator sees the service come back up live
  // (e.g. they realised it wasn't running, launched it, and the badge flips
  // green without having to close & reopen the modal). Stopped on close so
  // we don't poll the LLM endpoint forever in the background.
  let llmPollTimer = null;
  function startLlmPoll() {
    clearInterval(llmPollTimer);
    llmPollTimer = setInterval(async () => {
      renderLLMStatus(await fetchLLMStatus());
    }, 15_000);
  }
  function stopLlmPoll() { clearInterval(llmPollTimer); llmPollTimer = null; }

  function closeModal() { modal.classList.add('hidden'); stopLlmPoll(); }

  openBtn.addEventListener('click', () => {
    // Close Settings first — the launcher lives inside it now, and stacking
    // two modals leaves the dimmed Settings overlay behind Content Studio.
    document.getElementById('settings-modal')?.classList.add('hidden');
    modal.classList.remove('hidden');
    refreshList();
    startLlmPoll();
  });
  closeBtn?.addEventListener('click', closeModal);
  modal.querySelector('.modal-overlay')?.addEventListener('click', closeModal);

  // Bridge so the top-bar download menu can reuse this module's render+print
  // pipeline without duplicating templates. Window-scoped because the IIFE
  // closes over openPrintWindow / renderNoteHTML / renderPointsHTML.
  window.__cs_exportToPDF = function (session, type, content) {
    const html = type === 'note'
      ? renderNoteHTML(session, content)
      : renderPointsHTML(session, content);
    openPrintWindow(html, session.title || session.id);
  };

  // ── Print → Save as PDF ─────────────────────────────────────────────────
  function openPrintWindow(bodyHTML, title) {
    const w = window.open('', '_blank', 'width=900,height=1100');
    if (!w) { toast('Pop-up blocked — allow pop-ups to export PDF', 'error'); return; }
    w.document.write(`<!doctype html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<link href="https://fonts.googleapis.com/css2?family=Manrope:wght@300;400;500;600;700;800&display=swap" rel="stylesheet">
<style>
  @page { size: A4; margin: 22mm 20mm; }
  * { box-sizing: border-box; }
  body { font-family: 'Manrope', -apple-system, sans-serif; color: #111; background: #fff; line-height: 1.55; font-size: 11.5pt; }
  .cs-doc { max-width: 720px; margin: 0 auto; }
  .cs-doc-header { border-bottom: 1.5px solid #111; padding-bottom: 10px; margin-bottom: 18px; }
  .cs-h1 { font-size: 22pt; font-weight: 800; letter-spacing: -0.01em; margin: 0 0 4px; }
  .cs-doc-meta { font-size: 9.5pt; color: #666; text-transform: uppercase; letter-spacing: 1px; }
  .cs-summary { margin-top: 10px; font-style: italic; color: #333; }
  .cs-section { margin-bottom: 16px; page-break-inside: avoid; }
  .cs-h2 { font-size: 13pt; font-weight: 700; margin: 18px 0 8px; }
  .cs-h3 { font-size: 12pt; font-weight: 700; margin: 0 0 6px; }
  .cs-body { margin: 0 0 6px; }
  .cs-scripture-row { margin: 4px 0 8px; }
  .cs-scripture-chip { display: inline-block; font-size: 9.5pt; font-weight: 600; background: #f4f4f4; border: 1px solid #ddd; border-radius: 3px; padding: 2px 8px; margin-right: 6px; }
  .cs-points { list-style: none; padding: 0; margin: 0; counter-reset: pt; }
  .cs-point { display: flex; gap: 14px; margin-bottom: 16px; page-break-inside: avoid; }
  .cs-point-num { flex: 0 0 28px; font-size: 14pt; font-weight: 800; color: #999; }
  .cs-point-body { flex: 1; }
  .cs-point-title { font-size: 12.5pt; font-weight: 700; margin-bottom: 2px; }
  .cs-point-scripture { font-size: 9.5pt; font-weight: 600; color: #555; margin-bottom: 6px; }
  .cs-quote { border-left: 3px solid #ccc; padding: 4px 12px; margin: 8px 0; color: #555; font-style: italic; font-size: 10.5pt; }
  .cs-closing { margin-top: 18px; padding-top: 12px; border-top: 1px solid #ddd; }
  @media print { body { -webkit-print-color-adjust: exact; print-color-adjust: exact; } }
</style></head><body>${bodyHTML}
<script>window.onload = function(){ setTimeout(function(){ window.print(); }, 200); };</script>
</body></html>`);
    w.document.close();
  }
})();

// ── Startup bootstrap ───────────────────────────────────────────────────────
// Runs behind the branded overlay before the operator touches the app:
//   1. Requests microphone permission up front (so the OS prompt appears at
//      launch, not mid-service when they hit Start).
//   2. Downloads required resources — the offline speech model — when the
//      offline engine is selected and it isn't present yet, with progress.
// Always resolves (and always removes the overlay) so a slow/failed step can
// never trap the operator on the loading screen.
async function bootstrapStartup() {
  const overlay = document.getElementById('bootstrap-overlay');
  const statusEl = document.getElementById('bootstrap-status');
  const barFill  = document.getElementById('bootstrap-bar-fill');
  const setStatus = (t) => { if (statusEl) statusEl.textContent = t; };
  const setBar = (pct) => {
    if (!barFill) return;
    if (pct == null) { barFill.classList.add('indeterminate'); }
    else { barFill.classList.remove('indeterminate'); barFill.style.width = Math.max(0, Math.min(100, pct)) + '%'; }
  };
  const finish = () => {
    setBar(100);
    if (overlay) { overlay.classList.add('done'); setTimeout(() => overlay.remove(), 500); }
  };
  // Hard safety valve — never keep the overlay up longer than 90s.
  const safety = setTimeout(finish, 90000);

  try {
    // 1) Microphone permission
    setStatus('Requesting microphone access');
    setBar(15);
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach(t => t.stop());
    } catch { /* denied or unavailable — app still works; user can grant later */ }
    setBar(35);

    // 2) Required resources — offline model when the offline engine is chosen
    setStatus('Checking resources');
    let engine = 'deepgram';
    try {
      const r = await fetch(`${SERVER}/api/settings`);
      if (r.ok) { const s = await r.json(); engine = (s.speechEngine || 'deepgram').toLowerCase(); }
    } catch {}

    if (engine === 'offline' || engine === 'browser') {
      try {
        const st = await (await fetch(`${SERVER}/api/whisper/status`)).json();
        if (!st.installed) {
          setStatus('Downloading offline model');
          setBar(null); // indeterminate — the install endpoint doesn't stream byte progress
          fetch(`${SERVER}/api/whisper/install`, { method: 'POST' }).catch(() => {});
          for (let i = 0; i < 600; i++) {          // up to ~10 min — the whisper model (~182MB) is bigger than Vosk's was
            await new Promise(r => setTimeout(r, 1000));
            const s2 = await (await fetch(`${SERVER}/api/whisper/status`)).json().catch(() => ({}));
            if (s2.installed) break;
          }
        }
      } catch { /* model status unavailable — proceed; Start will surface any real error */ }
    }

    setBar(90);
    setStatus('Ready');
  } finally {
    clearTimeout(safety);
    finish();
  }
}

// Init — load the auth token from Tauri FIRST so all subsequent fetch / WS
// traffic carries the bearer header. Static assets and /health are exempt on
// the server side, so the page itself loads even before this resolves — but
// bootstrapStartup() and connectWS() both call authenticated endpoints, so
// they must genuinely wait rather than just being kicked off alongside it
// (that gap was the actual bug: bootstrapStartup() used to fire in parallel,
// so its own settings fetch silently 401'd on a cold Tauri launch before the
// IPC round-trip finished, and if the token never arrived at all, every
// later action — including "Start Listening" — kept failing all session).
renderLooksList();
(async () => {
  await loadAuthToken();
  connectWS();
  bootstrapStartup();
  // Tell Rust it's safe to reveal the main window now — our CSS is applied
  // and there's a real frame painted behind it. Rust used to show the window
  // right after dispatching navigate(), which raced the new page's own load
  // and could flash WebKit's default white background before this script (and
  // our dark styles) ever ran.
  //
  // This used to wait on a double requestAnimationFrame instead of the
  // setTimeout below — reads as more "correct" (wait for an actual paint,
  // not just a fixed delay), but it deadlocked every single launch: the
  // window is created with `visible: false`, and WebKit never runs a
  // compositing/paint pass for a surface that was never made visible — so
  // rAF's callback had nothing to synchronize against and simply never
  // fired. Confirmed via a boot trace: execution reached this exact point
  // every time, then nothing — the app only ever appeared via Rust's 12s
  // "frontend never signalled ready" fallback. A short timer doesn't depend
  // on compositing/visibility at all, so it can't deadlock the same way;
  // ~50ms is plenty for the DOM/CSSOM to settle after bootstrapStartup()
  // returns. No-ops harmlessly outside Tauri (plain-browser dev).
  setTimeout(() => {
    const inv = window.__TAURI__?.core?.invoke || window.__TAURI__?.invoke;
    inv?.('signal_main_ready').catch(() => {});
  }, 50);
})();
