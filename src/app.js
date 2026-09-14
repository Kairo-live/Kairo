// KAIRO v2 — Frontend App
// Communicates with the Node.js server via WebSocket (live events)
// and fetch (commands). No Electron IPC.
'use strict';

// The frontend is served BY the Node sidecar, so window.location is always
// the right origin — no need to hardcode the port. Tauri picks a free port
// at launch and may not be 7777.
const SERVER = `${location.protocol}//${location.host}`;
const WS_URL = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`;

// The id of Kairo's one non-removable output (see outputScreenMap/extraDisplays
// far below, ~line 6067) — hoisted up here because wireExternalDisplayStatus's
// IIFE calls refresh() synchronously at load, well before that later const
// would otherwise execute. A `const` isn't hoisted the way `var`/`function`
// are, so referencing it before its original declaration line threw a
// ReferenceError on every single launch (confirmed already broken in the
// last commit, not something introduced just now) — silently killing the
// "auto-reopen display on launch" feature's very first run every time.
const PRIMARY_DISPLAY = 'display-1';

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
// Real, sustained silence reaching Kairo while listening — owner: "are you
// going to do something about hymn not coming through, or will you keep
// gaslighting me." Confirmed live (databases/debug.log's own audio-peak
// diagnostic): 43 straight seconds of a genuine flat 0 on the raw captured
// mic buffer during a real test, no exception thrown anywhere, so nothing
// existing surfaced it — the only way to know was reading the log after
// the fact. This makes it visible the MOMENT it happens instead, and
// self-heals the one client-side cause that's cheap and safe to guard
// against regardless of root cause: the AudioContext getting suspended by
// the browser mid-session (only ever checked once, at startup, before
// this — see startAudioCapture's own resume() call).
let lastRealAudioAt = 0;
let audioSilenceWatchdog = null;
let audioSilenceWarning = false;
const AUDIO_SILENCE_WARN_MS = 15000;
const AUDIO_PEAK_NOISE_FLOOR = 50; // int16 units — well above dither/pure-zero, well below real speech (typically 2000-18000 in this app's own logged peaks)
let workerReady    = false;
let settings       = {};
// True once loadSettings() has actually populated `settings` from the
// server at least once. loadSettings() only runs inside ws.onopen (after
// auth + the WebSocket connects), so `settings` stays `{}` for a real
// stretch of app startup — code that reads settings-derived state (like
// wireExternalDisplayStatus's auto-reopen below) must wait for this, not
// just for its own script line to run. See that IIFE's own comment for the
// real incident this flag fixes.
let settingsLoaded = false;
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
const settingsBtn        = document.getElementById('settings-btn');
const settingsModal      = document.getElementById('settings-modal');
const closeSettingsBtn   = document.getElementById('close-settings');
const cancelSettingsBtn  = document.getElementById('cancel-settings');
const saveSettingsBtn    = document.getElementById('save-settings');
const testPPBtn          = document.getElementById('test-propresenter-btn');
const autoSendCheckbox   = document.getElementById('auto-send-checkbox');
const autoSendSettings   = document.getElementById('auto-send-settings');

// The Live Queue's "Auto-Deploy" badge used to be static markup — always
// claimed auto-send was live regardless of the real Settings > Bible >
// "Auto-send high confidence verses" checkbox (owner: "I think this isn't
// connected to the settings auto send" — it never was). Safety-relevant,
// not just cosmetic: an operator needs to know whether a matching verse
// is about to hit the screen on its own or sit in Candidates waiting for
// a manual send. Called on load and from both autoSend change handlers.
function updateAutoDeployBadge() {
  const badge = document.getElementById('cs-auto-badge');
  const label = document.getElementById('cs-auto-badge-label');
  if (!badge) return;
  const on = settings.autoSend !== false;
  badge.classList.toggle('off', !on);
  if (label) label.textContent = on ? 'Auto-Deploy' : 'Auto-Deploy Off';
}
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
const previewSectionBadge = document.getElementById('preview-section-badge');

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

// ── Action/trigger dispatch ──────────────────────────────────────────────
// Server-side triggers.js broadcasts one envelope shape for every trigger
// type: {type:'action', actionId, target, triggerId, payload}. Rather than
// growing handleServerMessage's switch by one case per trigger type, this
// is the one case it needs — dispatch by actionId through a small
// registry, so a new trigger type only needs a registerActionHandler call
// somewhere, not a switch-statement edit here.
const _actionHandlers = new Map();
function registerActionHandler(actionId, fn) { _actionHandlers.set(actionId, fn); }

function handleServerMessage(msg) {
  switch (msg.type) {

    case 'action':
      _actionHandlers.get(msg.actionId)?.(msg);
      break;

    case 'worker-ready':
      workerReady = true;
      if (workerStatusEl) { workerStatusEl.textContent = 'Engine ready'; workerStatusEl.style.color = 'var(--green)'; }
      break;

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
      if (msg.target === 'viewer') renderMediaPreview(msg.src, msg.kind, msg.fit);
      break;

    // A live segment's themed countdown — mirror it into the Monitoring
    // panel's own timer layer, exactly the way the real output does.
    case 'timer-slide':
      window.KairoService?.onTimerSlide?.(msg);
      break;

    case 'clear-layer':
      if (msg.layer === 'media' || msg.layer === 'all') clearMediaPreview();
      if (msg.layer === 'timer' || msg.layer === 'all') window.KairoService?.onTimerSlide?.({ clear: true });
      break;

    // Same broadcast display.html's real output listens for (see its own
    // comment) — keeps this window's own outputAnimation/outputAnimationSpeed
    // (used by renderPreviewScreen, the sidebar Live Preview panel) in sync
    // live, the same way the picker's own POST already updates the real
    // output immediately, no reload.
    case 'output-transition':
      if (msg.animation) outputAnimation = msg.animation;
      if (typeof msg.speed === 'number' && msg.speed > 0) outputAnimationSpeed = msg.speed;
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
    // Owner: "Start Listening [should be] the universal control" — scripture
    // detection was already unconditional the moment audio starts; the
    // hymn/song lookup + auto-advance engines (content_lookup.js/
    // lyrics_follow.js/sermon_follow.js) used to need a SEPARATE "Auto-
    // follow" toggle remembered on top of this, which is exactly the kind
    // of silently-off state this whole product's philosophy has been
    // fighting all session ("a wrong send is worse than a missed one" cuts
    // both ways — a MISSED auto-advance because a second switch was
    // forgotten is its own real failure mode). Tying it directly to the
    // same control that already gates everything else.
    window.KairoService?.setAutoFollow?.(true);
  } else if (state === 'disconnected' || state === 'error') {
    isListening = false;
    if (listenText) listenText.textContent = 'Start Listening';
    listenBtn?.classList.remove('active');
    if (micLabel) micLabel.classList.remove('pulse');
    if (lsBcastDot) lsBcastDot.classList.remove('broadcasting');
    if (lsBcastLbl) { lsBcastLbl.classList.remove('broadcasting'); lsBcastLbl.textContent = 'Idle'; }
    stopAudioCapture();
    window.KairoService?.setAutoFollow?.(false);
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
  // Lyric follower (service.js) — every transcript segment, final or interim,
  // feeds the aligner; it only looks at the tail so interim churn is fine.
  window.KairoService?.onTranscript?.(msg);
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

// Display-level Transition (Fade/Slide/Cut + speed) — this window's own copy
// of the same state display.html keeps (see its own comment), so the sidebar
// Live Preview panel (renderPreviewScreen, below) matches the real output
// instead of falling back to whatever the live item's THEME still carries in
// its now-legacy look.animation/animationSpeed fields. Fetched once at boot
// and kept live off the same 'output-transition' broadcast the real output
// listens for (see handleServerMessage's case below) — no per-file polling.
let outputAnimation = 'fade';
let outputAnimationSpeed = 1;
fetch(`${SERVER}/api/settings`).then(r => r.json()).then(s => {
  if (s.outputAnimation) outputAnimation = s.outputAnimation;
  if (typeof s.outputAnimationSpeed === 'number' && s.outputAnimationSpeed > 0) outputAnimationSpeed = s.outputAnimationSpeed;
}).catch(() => {});

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

// ProPresenter-style song section annotation — mirrors slide_import.js's
// own SECTION_LABEL_RE (server-side, applied at import time) so a block's
// label ("Verse 1", "Chorus", "Bridge · 2" when split across multiple
// slides) maps onto the same CSS color classes here. Kept as a separate,
// looser client-side match (not shared code with the server) since this
// only needs to classify an ALREADY-derived label for display, not detect
// one from raw scanned text.
const SECTION_TYPE_RE = /^(verse|chorus|refrain|solo|pre-?chorus|bridge|tag|intro|outro|ending)/i;
function sectionTypeClass(label) {
  const m = SECTION_TYPE_RE.exec(String(label || '').trim());
  if (!m) return null;
  const t = m[1].toLowerCase().replace(/-/g, '');
  if (t === 'prechorus') return 'sec-prechorus';
  if (t === 'ending') return 'sec-outro';
  return `sec-${t}`;
}
// Cycling the label itself needs playlists/activeItemId/liveSlideKey/
// slidesFor/sendSlide, all private to service.js's own IIFE closure — this
// file (app.js) runs as a separate top-level script and can't reach into
// them directly. window.KairoService is the existing, established bridge
// for exactly this (see its own definition at the bottom of service.js —
// slidesFor/sendSlide/renderStack and friends are already exposed there
// for other app.js callers); the real implementation lives there, this is
// just the click entry point.
previewSectionBadge?.addEventListener('click', () => window.KairoService?.cycleSectionLabel?.());

function renderPreviewScreen(text, reference, look, translatedText = '', image = null, fit = 'contain', styleByLayerId = {}, timerText = '', sectionLabel = '') {
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
  if (previewSectionBadge) {
    const cls = sectionTypeClass(sectionLabel);
    previewSectionBadge.textContent = sectionLabel || '';
    previewSectionBadge.className = 'live-screen-section-badge' + (cls ? ` ${cls}` : '') + (sectionLabel ? '' : ' hidden');
  }

  // Display-level Transition now (this file's own outputAnimation/
  // outputAnimationSpeed, kept live off the 'output-transition' broadcast —
  // see handleServerMessage), not read off the theme anymore. This used to
  // read effectiveLook.animation/animationSpeed, which is why a song's own
  // (older, per-theme) Lyrics look kept animating here exactly as it always
  // had regardless of what the Transition picker was set to.
  const animType = outputAnimation;
  const speedMs = Math.round(300 * outputAnimationSpeed);
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
      window.KairoService.paintLookLayers(themed, effectiveLook, styleByLayerId, { verseText: text, referenceText: reference || '', translatedText, timerText });
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
function renderMediaPreview(src, kind, fit) {
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
  // .live-screen-media's CSS hardcodes object-fit:contain — this mirror
  // never carried the actual chosen Fit Mode at all, so picking Cover or
  // Stretch (Fit Mode's fill) sent correctly to the real output (see
  // display.html's renderMediaStage, which always has) but never showed
  // that way here, which read as "Stretch doesn't actually stretch".
  const objectFit = fit === 'fill' ? 'fill' : (fit || 'contain');
  if (kind === 'video') {
    const v = document.createElement('video');
    v.src = src; v.autoplay = true; v.loop = true; v.muted = true; v.playsInline = true;
    v.style.objectFit = objectFit;
    host.appendChild(v);
  } else {
    const img = document.createElement('img');
    img.src = src;
    img.style.objectFit = objectFit;
    host.appendChild(img);
  }
}
// The transport bar (mute/play/seek/volume) is normally only shown/hidden
// reactively via onMediaStatus's WS round-trip from the actual output
// display reporting what it's rendering (see service.js's setMediaTransportVisible).
// That round-trip only fires off real video events (timeupdate/play/pause/
// loadedmetadata) — clearing the layer produces none of those from a
// display that's just gone blank, so the bar was silently left showing,
// frozen at its last position, with nothing left to control. sendMediaItem
// already optimistically shows the bar the moment a video is sent, without
// waiting on that same round-trip; this is the symmetric optimistic hide.
function clearMediaPreview() {
  renderMediaPreview(null);
  window.KairoService?.setMediaTransportVisible?.(false);
}

// Update only the viewer display (preview panel) without touching queue order.
// Use this for dblclick on already-queued cards so they don't reorder.
function updateViewerDisplay(v) {
  renderPreviewScreen(cleanVerseText(v.text), v.reference, null, v.translatedText || '', null, 'contain', {}, '', v.label || '');
}

function showInViewer(verses, method, topScore, correctedFrom = null, look = null) {
  const v = verses[0];

  // Update live preview screen — v.timerText is set for a timer-segment send
  // (service.js sendTimerSegmentToSlideLayer); the per-second countdown then
  // updates that same [data-binding="timer"] element via onTimerAction, the
  // same split display.html uses (renderStage seeds it, handleActionBadge ticks it).
  renderPreviewScreen(cleanVerseText(v.text), v.reference, look, v.translatedText || '', v.image || null, v.fit || 'contain', v.slideStyle || {}, v.timerText || '', v.label || '');

  // A playlist send (song/slide deck/announcement/scripture item run from
  // the service) isn't a scripture detection — the Bible tab's Live Queue,
  // Candidates panel, and session stats below all exist to track auto-
  // detect/search activity specifically, not "whatever got sent from the
  // playlist". The live preview above still updates either way.
  if (method === 'service') return;

  // A real scripture detection just painted over whatever was on screen —
  // including a live song/slide item, if content_lookup.js's own auto-swap
  // had one up. service.js's liveSlideKey never learns about this on its
  // own (this whole path is scripture-only, service.js has no listener for
  // 'detection' messages at all), so it kept believing that item was still
  // live: the Stack/Sidebar showed a stale "live" badge on it, AND
  // content_lookup's own candidate pool kept excluding it from future
  // matches — a preacher returning to the SAME song after a scripture
  // interlude could never get it auto-detected again. Release it the same
  // way the manual "Clear Slide" button already does (clearLive is a no-op
  // if nothing was live, safe to call unconditionally here).
  window.KairoService?.clearLive?.();

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
    // Already live in the Live Queue (showInViewer's own dedup, lines above,
    // only removes an EXISTING candidate card when something NEW goes live —
    // it can't help the reverse: a re-detection of a verse that's already
    // been live for a while, after enough time/narrative has passed that the
    // continuity gate no longer treats it as "sequential", landing here as a
    // seemingly-fresh candidate for something the operator is already
    // looking at. Real incident: re-reading Psalm 1:3 aloud a second time
    // (after the SAME_BOOK_WINDOW_MS gap) demoted straight back to
    // Candidates as "non-sequential" even though it was still the exact verse
    // on screen. Matches the owner's own framing: "if any from the candidate
    // already live, they shouldn't remain in candidate."
    if (currentDisplayCard?.querySelector(`[data-ref="${CSS.escape(v.reference)}"]`)) continue;
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

// Manually sending an arbitrary verse from the Live Queue (not the next
// sequential one) needs to tell the SERVER where the range now stands, not
// just update this client's own preview — the range nav bar's "N / total"
// count and "Next" target are driven by the server's own rangeCurrentVerse/
// rangeQueue, which showInViewer/sendVerseToServer never touch. Real
// incident: sending verse 8 out of a loaded 25-verse Matthew 1 range left
// the nav bar stuck reporting "3/25 → verse 4", disconnected from what was
// actually on screen. Only fires when the sent verse is actually part of
// the currently active range — a normal one-off citation has nothing to
// sync.
function syncRangeJumpIfNeeded(v) {
  if (!rangeRefs.has(v.reference)) return;
  fetch(`${SERVER}/api/range/jump-to`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ book: v.book, chapter: v.chapter, verse: v.verse }),
  }).catch(err => console.warn('[KAIRO] range jump-to failed:', err.message));
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
    syncRangeJumpIfNeeded(v);
  });
  // Double-click anywhere on card → send to screen (no reorder)
  wireDoubleClickSend(card, () => {
    updateViewerDisplay(v);   // update preview only — card stays in place
    sendVerseToServer(v);
    syncRangeJumpIfNeeded(v);
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
    syncRangeJumpIfNeeded(v);
  });

  card.addEventListener('dblclick', (e) => {
    e.preventDefault();
    updateViewerDisplay(v);   // update preview only — card stays in place
    sendVerseToServer(v);
    syncRangeJumpIfNeeded(v);
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
  if (!proPresenterStatus) return;
  proPresenterStatus.textContent = text;
  // Colored text only — no separate dot. It used to sit right next to the
  // sync toggle, which is ALSO red when on (this app's --green is red by
  // brand, not literal green), so two red shapes touching read as visual
  // clutter rather than two distinct pieces of information. The toggle
  // already conveys on/off; the text alone conveys connection state,
  // matching how OBS/Syphon/NDI's own status text already works (colored
  // text, no dot).
  proPresenterStatus.style.color =
    cls === 'connected' ? 'var(--green)' :
    cls === 'error'     ? 'var(--red)'   : 'var(--text-3)';
}

async function checkPP() {
  try {
    const r = await fetch(`${SERVER}/api/propresenter/test`);
    const d = await r.json();
    if (d.success) updatePPStatus('Connected', 'connected');
    else           updatePPStatus('Not found', 'error');
  } catch { updatePPStatus('Offline', ''); }
}

// Despite the name, this is the shared "push this verse everywhere" call
// for every manual send in the app (Candidates, Live Queue, range cards,
// direct search hits — 6 call sites). It used to hit ONLY
// /api/propresenter/send, which — true to its name — only ever pushes to
// ProPresenter. Nothing about a manual send ever reached KAIRO's own
// external display window (display.html), which only updates via the
// server's 'detection' WS broadcast — the exact thing this endpoint never
// sent. Real incident: double-clicking a verse (or clicking Send) updated
// the operator's own local preview and ProPresenter, but the actual output
// screen just sat on whatever the last automatic detection or Next/
// Previous range-advance had put there, because those are the only paths
// that were ever wired to /api/service/send's broadcast.
//
// /api/service/send does the full job (broadcasts 'detection' with
// method:'service' AND calls sendToOutputs, which covers ProPresenter +
// OBS together) — same endpoint the Playlist/Send-slide flow already used
// correctly. method:'service' is deliberate: showInViewer() skips its
// Live-Queue-list bookkeeping for that method, since the caller here
// already did that update directly and locally before this call — the
// broadcast only needs to reach OTHER surfaces (the real display window),
// not redundantly re-touch the panel that triggered the send.
// Media Bin "set as background" for Bible mode (see service.js's Media
// Bin) — scripture has no discrete "item" to hang a per-slide bgMedia
// override on the way a Slides/Timer entry does (buildSyntheticLook,
// above), so this applies to whichever theme is currently assigned to the
// primary output for scripture instead. Only takes effect starting with
// the NEXT manual send below — sendVerseToServer is "the shared 'push this
// verse everywhere' call for every manual send" per its own comment (Send
// button, double-click, Candidates promote, range cards, direct search
// hits), so this reaches all of those. It does NOT reach the fully-
// automatic live-listening path, which broadcasts through server.js's own
// detection pipeline and relies on the display window's own stored theme
// rather than a look sent per-request — a real limitation of this
// interpretation, not yet covered.
async function sendVerseToServer(verse, look = null) {
  try {
    await fetch(`${SERVER}/api/service/send`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ verse, look }),
    });
  } catch (err) { toast('Send failed: ' + err.message, 'error'); }
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
// the server uses `engine` to choose between Deepgram (cloud) and the
// offline (sherpa-onnx, on-device) engine.
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
  // saved setting) route to the server's sherpa-onnx offline engine.
  const serverEngine = (engine === 'offline' || engine === 'browser') ? 'offline' : 'deepgram';
  try {
    const deviceId = audioSourceSettings?.value || '';
    // echoCancellation/noiseSuppression/autoGainControl are voice-call DSP
    // effects tuned for a real mic in a real room. A confirmed incident:
    // applied to BlackHole (a pure virtual loopback), they crushed real,
    // strong signal (independent ffmpeg capture showed -2.9dB peaks at the
    // same moment) down to a peak of ~1/32767 — near total silence,
    // explaining "input level shows something, transcript shows nothing"
    // exactly. The app is line-in-first now (a board/interface feed, not a
    // room mic) — a fixed sound-desk output that these effects only harm,
    // never help — and autoGainControl in particular is a plausible cause
    // of intermittent "audio just stopped" reports as it hunts the level.
    // So: DSP off, unconditionally. A room-mic user loses noise
    // suppression, an acceptable trade for never silently crushing a clean
    // line feed.
    const constraints = {
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        echoCancellation: false,
        noiseSuppression: false,
        autoGainControl: false,
        sampleRate: 16000,
      },
    };
    mediaStream = await navigator.mediaDevices.getUserMedia(constraints);
    if (micDisplay) micDisplay.textContent = mediaStream.getAudioTracks()[0]?.label || 'Microphone';

    // Start the server-side engine (Deepgram or the offline sherpa-onnx engine)
    const r = await fetch(`${SERVER}/api/start-listening`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ engine: serverEngine }),
    });
    const d = await r.json();
    if (d.error) {
      stopAudioCapture();
      // toast() is a permanent no-op in this app (see its own comment) — this
      // used to be the ONLY thing that ran here, so "no Deepgram key" and "no
      // offline model" both failed completely silently: the button just
      // reverted with zero explanation of what was wrong or how to fix it.
      // Both of these are pure missing-configuration cases with one correct
      // fix (go set it up in Settings), unlike a genuine runtime error (a
      // rejected/invalid key, a real network failure) which a redirect
      // wouldn't actually resolve — so only these two specific, well-known
      // error strings (from startDeepgram/startWhisper in server.js) trigger
      // the jump; anything else just logs, matching the previous behavior's
      // (silent) fallback rather than guessing at what an unknown error needs.
      const missingKey   = serverEngine === 'deepgram' && /no deepgram api key/i.test(d.error);
      const missingModel = serverEngine === 'offline'  && /model missing/i.test(d.error);
      if (missingKey || missingModel) {
        settingsModal?.classList.remove('hidden');
        showSettingsPane('audio');
        const field = document.getElementById(missingKey ? 'deepgram-key' : 'offline-install-btn');
        field?.scrollIntoView({ block: 'center' });
        field?.focus?.();
      } else {
        console.error('[StartListening]', d.error);
      }
      return;
    }

    // Stream PCM16 to server via WebSocket — same path for both engines.
    audioContext  = new AudioContext({ sampleRate: 16000 });
    // This runs several `await`s deep in an async click handler (getUserMedia,
    // then a fetch, above) — well outside the synchronous user-gesture window
    // WebKit requires to auto-start an AudioContext. Without an explicit
    // resume(), WebKit can silently create it already 'suspended': the audio
    // graph never actually runs, onaudioprocess below never fires, and ZERO
    // bytes ever reach the server — no error, nothing to catch, it just looks
    // like "connected but no audio" forever (confirmed: this is what was
    // happening — Deepgram genuinely never received a single byte, every
    // single reconnect attempt).
    if (audioContext.state === 'suspended') await audioContext.resume();
    if (audioContext.state !== 'running') console.error('[KAIRO] AudioContext still not running after resume():', audioContext.state);
    // Diagnostic: WebKit doesn't always honor the requested sampleRate above
    // (a device's own native rate — BlackHole is 48kHz — can silently win),
    // and every sample here gets declared to Deepgram as 16kHz regardless of
    // what it actually is. A mismatch would still send real, non-throwing
    // bytes (so nothing else here would catch it) but produce a garbled
    // stream Deepgram can't recognize as valid audio at all. Posted to
    // /api/debug-log (server/server.js) — same mechanism service.js's own
    // debugLog uses — so it lands in databases/debug.log, not just this
    // window's own devtools console, which nobody may have open.
    const _trackSettings = mediaStream.getAudioTracks()[0]?.getSettings() || {};
    console.log('[KAIRO] AudioContext.sampleRate:', audioContext.sampleRate, '| track settings:', JSON.stringify(_trackSettings));
    fetch(`${SERVER}/api/debug-log`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'audio-context-info', data: { contextSampleRate: audioContext.sampleRate, trackSettings: _trackSettings } }),
    }).catch(() => {});
    const source  = audioContext.createMediaStreamSource(mediaStream);
    watchAudioTrackHealth();   // OS-level "track died" → immediate rebuild
    // 1024 samples @ 16 kHz = 64 ms of buffering latency (down from 256 ms
    // with the previous 4096 setting). Detection feels noticeably snappier
    // on direct citations. A future AudioWorklet migration would also move
    // this off the main UI thread, but 1024 is a safe drop-in.
    audioProcessor = audioContext.createScriptProcessor(1024, 1, 1);

    let _lastLevelLogAt = 0;
    audioProcessor.onaudioprocess = (e) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const float32 = e.inputBuffer.getChannelData(0);
      const int16   = new Int16Array(float32.length);
      let peak = 0;
      for (let i = 0; i < float32.length; i++) {
        const s = Math.max(-32768, Math.min(32767, float32[i] * 32768));
        int16[i] = s;
        peak = Math.max(peak, Math.abs(s));
      }
      if (peak > AUDIO_PEAK_NOISE_FLOOR) lastRealAudioAt = Date.now();
      // Diagnostic — rate-limited: confirms real (non-zero) samples are
      // actually being read off the captured device, separately from
      // whether the bytes reach the server/Deepgram correctly. 32767 = max.
      // Also posted to /api/debug-log — see the sampleRate diagnostic above
      // for why (nobody may have this window's devtools console open).
      const now = performance.now();
      if (now - _lastLevelLogAt > 3000) {
        _lastLevelLogAt = now;
        console.log('[KAIRO] audio peak this frame:', peak, '/ 32767');
        fetch(`${SERVER}/api/debug-log`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ event: 'audio-peak', data: { peak, bufferLength: float32.length } }),
        }).catch(() => {});
      }
      ws.send(int16.buffer);
    };

    source.connect(audioProcessor);
    audioProcessor.connect(audioContext.destination);

    lastRealAudioAt = Date.now(); // don't warn before real audio has had a chance to arrive at all
    audioSilenceWarning = false;
    clearInterval(audioSilenceWatchdog);
    audioSilenceWatchdog = setInterval(checkAudioSilence, 5000);

    showEmptyTranscript(false);
  } catch (err) {
    // toast() is a deliberate no-op (see its own definition) — without
    // this, a mic-acquisition failure (a stale/invalid selected device,
    // permission denied, device unplugged) was completely invisible: no
    // popup, no console line, nothing. Doesn't touch toast() itself.
    console.error('[KAIRO] Mic error:', err.name, err.message);
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
  clearInterval(audioSilenceWatchdog);
  audioSilenceWatchdog = null;
  setAudioSilenceWarning(false);
}

// Real, sustained silence on the raw captured buffer, made immediately
// visible on the same status pill the operator already watches for
// "Broadcasting"/"Idle" (handleConnectionState) — not a popup (toast()
// stays a deliberate no-op — see feedback_no_toasts). Also self-heals the
// one client-side cause that's cheap and safe to guard against regardless
// of root cause: startAudioCapture only ever called audioContext.resume()
// once, at the very start — if the browser suspends it again later for any
// reason, nothing before this ever noticed or retried.
function setAudioSilenceWarning(on) {
  if (audioSilenceWarning === on) return;
  audioSilenceWarning = on;
  const dot = document.getElementById('ls-bcast-dot');
  const lbl = document.getElementById('ls-bcast-label');
  if (on) {
    dot?.classList.remove('broadcasting');
    dot?.classList.add('warning');
    if (lbl) { lbl.classList.remove('broadcasting'); lbl.classList.add('warning'); lbl.textContent = 'No audio!'; }
  } else {
    dot?.classList.remove('warning');
    dot?.classList.add('broadcasting');
    if (lbl) { lbl.classList.remove('warning'); lbl.classList.add('broadcasting'); lbl.textContent = 'Broadcasting'; }
  }
}

let _audioHealAt = 0;
let _audioHealing = false;
function _healLog(msg, extra) {
  console.warn('[KAIRO]', msg);
  fetch(`${SERVER}/api/debug-log`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'audio-heal', data: { msg, ...(extra || {}) } }),
  }).catch(() => {});
}

function checkAudioSilence() {
  if (!isListening) return;
  if (audioContext && audioContext.state !== 'running') {
    audioContext.resume().catch(() => {});
  }
  const silentMs = Date.now() - lastRealAudioAt;
  setAudioSilenceWarning(silentMs > AUDIO_SILENCE_WARN_MS);

  // getUserMedia tracks on WKWebView (Tauri's macOS webview) silently go to
  // exact zero and stay there — no 'ended'/'mute' event — after working for
  // a few seconds, which is precisely the "it stopped after a few words"
  // report. The context is still 'running', onaudioprocess still fires,
  // just with all-zero buffers. Only a full re-acquire recovers it. Heal
  // after 12s of dead air (a long time to lose in a live service already),
  // throttled to once per 20s so a genuinely unplugged input doesn't thrash.
  if (silentMs > 12000 && audioContext && audioContext.state === 'running'
      && !_audioHealing && Date.now() - _audioHealAt > 20000) {
    _audioHealAt = Date.now();
    restartAudioCapture('silence-watchdog');
  }
}

// Fires the moment the OS reports a captured track died/muted — faster than
// waiting for the silence watchdog. Attached fresh on every (re)build.
function watchAudioTrackHealth() {
  const track = mediaStream?.getAudioTracks?.()[0];
  if (!track) return;
  const onDead = () => {
    if (!isListening || _audioHealing) return;
    if (Date.now() - _audioHealAt < 5000) return;
    _audioHealAt = Date.now();
    restartAudioCapture('track-' + (track.muted ? 'muted' : 'ended'));
  };
  track.addEventListener('ended', onDead);
  track.addEventListener('mute', onDead);
}

// Tear down just the capture graph (NOT the WS or the server-side engine,
// which are both still fine) and rebuild it. Self-contained — does not touch
// startListening()'s session-reset / start-listening POST / WS setup, only
// the getUserMedia + AudioContext + ScriptProcessor chain that stalls. Falls
// back to the system-default input if the explicitly-selected device keeps
// coming back silent.
async function restartAudioCapture(reason, allowDeviceFallback = true) {
  if (_audioHealing || !isListening) return;
  _audioHealing = true;
  try {
    _healLog('rebuilding audio capture', { reason });
    try { if (audioProcessor) { audioProcessor.disconnect(); audioProcessor.onaudioprocess = null; } } catch {}
    audioProcessor = null;
    try { mediaStream?.getTracks().forEach(t => t.stop()); } catch {}
    try { await audioContext?.close(); } catch {}
    audioContext = null; mediaStream = null;

    const deviceId = audioSourceSettings?.value || '';
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        echoCancellation: false, noiseSuppression: false, autoGainControl: false, sampleRate: 16000,
      },
    });
    audioContext = new AudioContext({ sampleRate: 16000 });
    if (audioContext.state === 'suspended') await audioContext.resume();
    const source = audioContext.createMediaStreamSource(mediaStream);
    watchAudioTrackHealth();
    audioProcessor = audioContext.createScriptProcessor(1024, 1, 1);
    audioProcessor.onaudioprocess = (e) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) return;
      const float32 = e.inputBuffer.getChannelData(0);
      const int16 = new Int16Array(float32.length);
      let peak = 0;
      for (let i = 0; i < float32.length; i++) {
        const s = Math.max(-32768, Math.min(32767, float32[i] * 32768));
        int16[i] = s;
        peak = Math.max(peak, Math.abs(s));
      }
      if (peak > AUDIO_PEAK_NOISE_FLOOR) lastRealAudioAt = Date.now();
      ws.send(int16.buffer);
    };
    source.connect(audioProcessor);
    audioProcessor.connect(audioContext.destination);
    lastRealAudioAt = Date.now();
    _healLog('audio capture rebuilt', { reason, device: deviceId || 'default' });

    // Verify it's actually producing audio. If the explicitly-selected
    // device still comes back dead after 3s, retry once on the default.
    if (deviceId && allowDeviceFallback) {
      const checkpoint = lastRealAudioAt;
      setTimeout(() => {
        if (isListening && lastRealAudioAt === checkpoint && !_audioHealing) {
          _healLog('selected device still silent after rebuild — falling back to default input');
          audioSourceSettings.value = '';
          _audioHealAt = Date.now();
          restartAudioCapture('device-fallback', false);
        }
      }, 3000);
    }
  } catch (err) {
    _healLog('audio capture rebuild FAILED', { reason, error: err.message });
  } finally {
    _audioHealing = false;
  }
}

// ── Range slider fill ─────────────────────────────────────────────────────
// Native `accent-color` alone only paints the FILLED portion + thumb of a
// <input type="range"> — the unfilled remainder stays the OS/browser's own
// light-gray default regardless, which read as unstyled/default against
// this app's fully dark UI (owner feedback, live). The CSS track gradient
// (::-webkit-slider-runnable-track in styles.css) needs a --progress custom
// property to know where the fill/unfilled split falls; this keeps it in
// sync on load and on every drag. Covers every <input type="range"> in the
// document (svc-scale, media-seek/volume, Theme Studio's transition speed/
// intensity sliders) — one wiring point rather than one per slider.
function wireRangeSliders() {
  const setProgress = (el) => {
    const min = parseFloat(el.min) || 0;
    const max = parseFloat(el.max) || 100;
    const val = parseFloat(el.value) || 0;
    const pct = max > min ? ((val - min) / (max - min)) * 100 : 0;
    el.style.setProperty('--progress', Math.max(0, Math.min(100, pct)) + '%');
  };
  document.querySelectorAll('input[type="range"]').forEach((el) => {
    setProgress(el);
    el.addEventListener('input', () => setProgress(el));
  });
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
    const versionEl = document.getElementById('settings-nav-version');
    if (versionEl) versionEl.textContent = settings.appVersion ? `KAIRO v${settings.appVersion}` : '';
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
    updateAutoDeployBadge();
    if (showConfSettings)  showConfSettings.checked   = settings.showConfidence !== false;
    if (ppEnabledToggle)    ppEnabledToggle.checked    = settings.proPresenterEnabled !== false;
    if (obsEnabledToggle)   obsEnabledToggle.checked   = settings.obsEnabled === true;
    if (obsUrlInput && settings.obsUrl) obsUrlInput.value = settings.obsUrl;
    if (obsPasswordInput && settings.obsPassword) obsPasswordInput.value = settings.obsPassword;
    if (obsTextSourceInput && settings.obsTextSource) obsTextSourceInput.value = settings.obsTextSource;
    // NDI/Syphon: their start/stop/status logic lives in index.html's inline
    // scripts (native Tauri outputs, wired independently since that script
    // runs before app.js loads) — but neither toggle's checked state was
    // ever persisted to settings or restored on relaunch, so both silently
    // reset to off every session even if the operator had them broadcasting
    // last time. This only adds the missing persistence layer as a SECOND
    // listener alongside the inline script's own — addEventListener doesn't
    // replace, so its start/stop handling is untouched. Auto-resume
    // dispatches a real 'change' event (not a direct function call — those
    // are scoped inside the inline script's own IIFE) so the inline
    // script's existing startNdi()/startSyphon() fires exactly as if the
    // operator had just clicked the toggle themselves.
    const ndiToggleEl    = document.getElementById('ndi-enabled-toggle');
    const syphonToggleEl = document.getElementById('syphon-enabled-toggle');
    [['ndiEnabled', ndiToggleEl], ['syphonEnabled', syphonToggleEl]].forEach(([key, el]) => {
      if (!el) return;
      el.addEventListener('change', () => saveSettingsPatch({ [key]: el.checked }));
      if (settings[key] && !el.disabled) {
        el.checked = true;
        el.dispatchEvent(new Event('change'));
      }
    });
    // Restore toggle-group state from persisted settings
    syncToggleGroup('speech-engine-toggle', 'engine', settings.speechEngine || 'deepgram');
    updatePPTokenLabel();
    initCustomSelects();
    // Per-output theme pickers live inside each output card.
    renderOutputThemePickers();
    renderDisplayOutputs();
    // Push the resolved per-output theme map to the server now, not just
    // whenever a theme/display setting is next touched — applyOutputThemes()
    // was previously only ever called as a side effect of the operator
    // changing something in Settings, so the server's currentOutputThemes
    // stayed {} for an entire session on a fresh launch. Anything server-
    // side that depends on knowing the primary output's theme (e.g.
    // attachBibleTranslations gating on the Multi-Language layout — see
    // primaryOutputTranslateLang in server.js) silently did nothing until
    // the operator happened to open Settings and touch a picker, which is
    // exactly why the Multi-Language theme looked like it "worked sometimes
    // and not others."
    applyOutputThemes();
    // Language
    const sttLang = document.getElementById('stt-language');
    if (sttLang) sttLang.value = settings.sttLanguage || 'en-US';
    const bibleLang = document.getElementById('bible-language');
    if (bibleLang) bibleLang.value = settings.bibleLanguage || 'en';
    renderLangPacks();
    // First-run: no Deepgram key → show a nudge banner so the user knows what to do.
    showFirstRunBannerIfNeeded(settings);
    if (typeof renderHotkeysList === 'function') renderHotkeysList(); // now that settings.hotkeys is real, not defaults
    settingsLoaded = true;
  } catch (err) {
    console.warn('[Settings] Load failed:', err);
    toast('Could not load settings from server', 'error');
  }
}

// ── First-run onboarding modal ─────────────────────────────────────────────
// Dismissible centered overlay prompting for a speech-engine choice —
// Deepgram (paste a key) or fully offline (download the local model, no key
// needed). Dismissed (Skip or close) it stays hidden for the session;
// reappears next launch until a real choice has been made either way.
let firstRunDismissed = false;
function showFirstRunBannerIfNeeded(s) {
  const modal = document.getElementById('first-run-modal');
  if (!modal) return;
  // "Configured" means either a Deepgram key is saved, OR the operator has
  // deliberately chosen Offline (the toggle here, same 'browser' value
  // Settings itself uses) — owner: "this should be deepgram and local if no
  // model is downloaded for offline". Offline doesn't NEED a key, so
  // requiring one here would leave a genuinely-offline setup nagged forever.
  const configured = !!(s && (s.deepgramApiKey || s.speechEngine === 'browser' || s.speechEngine === 'offline'));
  if (configured) {
    modal.classList.add('hidden');
    return;
  }
  if (firstRunDismissed || !modal.classList.contains('hidden')) return; // dismissed or already showing
  modal.classList.remove('hidden');
  const input = document.getElementById('first-run-deepgram-key');
  if (input) input.value = '';
  syncToggleGroup('first-run-engine-toggle', 'engine', 'deepgram'); // always starts on the Deepgram tab
  // Defer focus so the overlay has laid out before we focus inside it.
  setTimeout(() => input?.focus(), 50);
}

function closeFirstRunModal() {
  firstRunDismissed = true;
  document.getElementById('first-run-modal')?.classList.add('hidden');
}

async function saveFirstRunChoice() {
  const engine = readToggleGroup('first-run-engine-toggle', 'engine') || 'deepgram';

  if (engine === 'browser') {
    // Offline chosen — no key needed. Persist the engine choice so it
    // sticks (and so bootstrapStartup()/Settings both see it), then, if the
    // model isn't already installed, kick off the same download this
    // modal's own #first-run-offline-install-btn would (wireOfflineModelInstaller
    // already fully owns its progress UI) rather than silently leaving the
    // resilience path unfetched until the operator happens to revisit
    // Settings. The download runs server-side regardless of whether this
    // modal stays open, so closing it early (Skip/X) never interrupts it.
    try {
      await fetch(`${SERVER}/api/settings`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...settings, speechEngine: 'browser' }),
      });
      settings = { ...settings, speechEngine: 'browser' };
      syncToggleGroup('speech-engine-toggle', 'engine', 'browser'); // keep Settings' own toggle in sync
    } catch {
      toast('Could not save — try again in Settings', 'error');
      return;
    }
    const installBtn = document.getElementById('first-run-offline-install-btn');
    if (installBtn && installBtn.style.display !== 'none') installBtn.click();
    else closeFirstRunModal();
    return;
  }

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
  if (autoSendCheckbox) autoSendCheckbox.checked = updated.autoSend;
  updateAutoDeployBadge();
  // Dismiss first-run banner now that a key may have been entered.
  showFirstRunBannerIfNeeded(settings);
  closeModal();
  toast('Settings saved', 'success');
  checkPP();
}

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

// First-run onboarding modal wiring
document.getElementById('first-run-save')?.addEventListener('click', saveFirstRunChoice);
document.getElementById('first-run-skip')?.addEventListener('click', closeFirstRunModal);
document.getElementById('close-first-run')?.addEventListener('click', closeFirstRunModal);
document.querySelector('#first-run-modal .modal-overlay')?.addEventListener('click', closeFirstRunModal);
document.getElementById('first-run-deepgram-key')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') saveFirstRunChoice();
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

// ── OBS: lightweight periodic status → header indicator ────────────────────
// Separate from the Test button's /api/obs/test (which opens a FRESH
// connection each click) — this just reads the server's already-tracked
// obsConnected state, cheap enough to poll on an interval.
function updateOBSHeaderStatus(connected, enabled) {
  const dot = document.getElementById('obs-header-dot');
  const txt = document.getElementById('obs-header-status');
  if (!dot || !txt) return;
  dot.className = 'bs-dot' + (connected ? ' connected' : enabled ? ' error' : '');
  txt.textContent = connected ? 'Connected' : enabled ? 'Not connected' : 'Off';
}
async function pollOBSStatus() {
  try {
    const r = await fetch(`${SERVER}/api/obs/status`);
    const d = await r.json();
    updateOBSHeaderStatus(d.connected, d.enabled);
  } catch { updateOBSHeaderStatus(false, false); }
}
pollOBSStatus();
setInterval(pollOBSStatus, 5000);

// ── External Display: no toggle, no "Open" button — picking a monitor in
// upsertPrimaryMonitorPicker's dropdown IS the action (see buildScreenSelect).
// This IIFE just keeps the header status + the dropdown's own option list
// live while Settings is open: header status reports whether a physical
// external display is actually plugged in right now (not window-open
// state — you can have a window open on your own laptop screen with
// nothing external connected at all). Reuses the same list_monitors Tauri
// command refreshDisplayStatus() already calls (real OS-level monitor
// enumeration, not the Window Management API WebKit doesn't support).
(function wireExternalDisplayStatus() {
  const headerDot = document.getElementById('external-header-dot');
  const headerTxt = document.getElementById('external-header-status');
  let autoResumeDone = false;

  // Shares refreshDisplayStatus()'s own list_monitors call (and its
  // cachedScreens result) rather than making a second, separate one here.
  async function refresh() {
    // Auto-reopen whatever monitor was previously selected, once, the
    // first time this runs after launch — a picker that only opens a
    // window on its OWN change event means every app restart (or a
    // display-server crash mid-dev-session, which happened repeatedly
    // while debugging this exact feature) silently loses the output
    // window with no way back short of manually re-touching the
    // dropdown, even though the assignment itself was never lost.
    // Matches how every other presentation app restores its output on
    // launch instead of requiring the operator to re-pick it.
    //
    // Gated on settingsLoaded, not just "has refresh() run yet" — this
    // IIFE's own refresh() call below fires SYNCHRONOUSLY at script load,
    // well before loadSettings() (which only runs inside ws.onopen, after
    // auth + the WebSocket connects) has populated `settings` at all. The
    // old code marked itself "done" on that very first, always-empty
    // attempt — outputScreenMap()[PRIMARY_DISPLAY] read from settings={},
    // so primaryScreen was always undefined, the real auto-reopen never
    // fired, and the one-shot flag then permanently blocked every later
    // retry (including the 3s poll below, by which point settings HAD
    // loaded) — the exact real incident: "I have to reset the output
    // every time [the app restarts]." Now the attempt itself is what gets
    // consumed, not just the opportunity to try.
    if (!autoResumeDone && settingsLoaded) {
      autoResumeDone = true;
      const primaryScreen = outputScreenMap()[PRIMARY_DISPLAY];
      if (primaryScreen && typeof openDisplayOutput === 'function') {
        openDisplayOutput({ id: PRIMARY_DISPLAY, name: PRIMARY_DISPLAY });
      }
      extraDisplays().forEach(d => {
        if (outputScreenMap()[d.id] && typeof openDisplayOutput === 'function') {
          openDisplayOutput(d);
        }
      });
    }
    await refreshDisplayStatus();
    upsertPrimaryMonitorPicker();
    const connected = cachedScreens.length > 1;
    if (headerDot) headerDot.className = 'bs-dot' + (connected ? ' connected' : '');
    if (headerTxt) headerTxt.textContent = connected ? 'External display connected' : 'No external display connected';
  }
  refresh();
  // Real incident this fixes: a display plugged in AFTER the app was
  // already running never got picked up, because nothing re-queried
  // list_monitors once the settings panel's initial render had already
  // happened. Polling here keeps both this status line and the dropdown's
  // option list genuinely live while Settings is open.
  setInterval(refresh, 3000);
})();

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
  updateAutoDeployBadge();
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
      // Keep the text so the user can quickly extend to a range (e.g. add "-18").
      // Explicit focus() before select() — this runs after an await, outside
      // the original click/Enter keypress's own call stack, and WebKit (the
      // packaged app's actual renderer, unlike a plain Chromium tab) is
      // stricter about honoring a bare .select() once that user-gesture
      // context has lapsed. Without the focus() first, .select() can
      // silently fail to actually move keyboard focus into the box — the
      // text still shows selected, but the NEXT keystroke goes nowhere,
      // which reads as "search stopped working" right after a send.
      if (scriptureSearchInput) {
        scriptureSearchInput.focus();
        scriptureSearchInput.select();
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
  if (layer === 'slide' || layer === 'all') { clearPreviewScreen(); window.KairoService?.clearLive?.(); }
  if (layer === 'media' || layer === 'all') clearMediaPreview();
}
document.getElementById('clear-slide-layer-btn')?.addEventListener('click', () => clearOutputLayer('slide'));
document.getElementById('clear-media-layer-btn')?.addEventListener('click', () => clearOutputLayer('media'));
// 'timer' has no client-side preview to clear (unlike slide/media, the
// countdown only ever exists on the actual output) — the server-side stop
// is the whole effect; see clear-layer's handling in server.js.
document.getElementById('clear-timer-layer-btn')?.addEventListener('click', () => clearOutputLayer('timer'));
document.getElementById('clear-all-layers-btn')?.addEventListener('click', () => clearOutputLayer('all'));

clearTranscriptBtn?.addEventListener('click', () => {
  showEmptyTranscript(true);
  wordCount = 0;
  if (wordCountEl) wordCountEl.textContent = '0';
});

// ── Audio device enumeration ───────────────────────────────────────────────
// Same persistence pattern populateAudioOutputDevices (below) already uses
// correctly for the media-output picker — this one had NONE: the dropdown
// was rebuilt from scratch on every call with no restored selection, so it
// silently fell back to whichever device enumerates first (typically the
// built-in mic) on every app relaunch. A real, confirmed incident: an
// operator explicitly selected BlackHole 2ch, then a later relaunch (a
// server restart, closing and reopening the app — anything that reloads
// this script) silently reverted capture to the built-in mic with the
// dropdown never visibly indicating anything changed, and the transcript
// picked up ambient room audio instead of the intended source.
const AUDIO_INPUT_KEY = 'kairo-audio-input-device';
async function populateAudioDevices() {
  if (!audioSourceSettings) return;
  try {
    await navigator.mediaDevices.getUserMedia({ audio: true });
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics    = devices.filter(d => d.kind === 'audioinput');
    const saved   = localStorage.getItem(AUDIO_INPUT_KEY) || '';
    audioSourceSettings.innerHTML = '';
    mics.forEach(d => {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || `Microphone ${d.deviceId.slice(0, 6)}`;
      if (d.deviceId === saved) o.selected = true;
      audioSourceSettings.appendChild(o);
    });
    // The saved device may no longer be present (unplugged, driver
    // reinstalled — BlackHole's own deviceId can change across a reinstall)
    // — flag it loudly instead of silently capturing the wrong source.
    if (saved && !mics.some(d => d.deviceId === saved)) {
      console.error('[KAIRO] Saved audio input device not found among current devices — falling back to', audioSourceSettings.value);
    }
  } catch {}
}

audioSourceSettings?.addEventListener('change', () => {
  localStorage.setItem(AUDIO_INPUT_KEY, audioSourceSettings.value || '');
});

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

// ── Offline (sherpa-onnx) model installer UI ──────────────────────────────
// Shown only when the Speech Engine toggle is set to "Offline". Streams
// NDJSON progress events from POST /api/whisper/install into a progress bar
// so the operator doesn't have to drop to a terminal to run npm scripts.
// Normally the startup bootstrap (bootstrapStartup()) already fetched this
// model before the operator ever opens Settings — this panel is the manual
// fallback for a first install that was skipped, interrupted, or run offline.
//
// Parametrized (not a single fixed IIFE) so the exact same install/progress
// logic can drive a SECOND instance of this widget in the first-run modal
// (its own engine choice, not just Settings) without duplicating any of the
// NDJSON-streaming logic below — only the element ids differ per instance.
function wireOfflineModelInstaller(ids) {
  const group       = document.getElementById(ids.group);
  const statusLine  = document.getElementById(ids.statusLine);
  const installBtn  = document.getElementById(ids.installBtn);
  const progressWrap = document.getElementById(ids.progressWrap);
  const progressBar  = document.getElementById(ids.progressBar);
  const progressText = document.getElementById(ids.progressText);
  const engineToggle = document.getElementById(ids.engineToggle);
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

  // Show/hide the whole widget based on which engine is selected. Reacts to
  // both a real click (bubbles up before the .active class updates, hence
  // the setTimeout) AND syncToggleGroup's 'toggle-change' event, which fires
  // when loadSettings() restores a previously-saved "Offline" engine
  // programmatically on startup — that path never dispatches a real click,
  // so without this listener the panel stayed hidden (and the download
  // button with it) any time Offline was already the saved engine when
  // Settings was opened, not just when the operator toggled it live.
  function syncVisibility() {
    const active = engineToggle?.querySelector('.toggle-btn.active');
    const isOffline = active?.dataset.engine === 'browser';
    group.style.display = isOffline ? '' : 'none';
    if (isOffline) refreshStatus();
  }
  engineToggle?.addEventListener('click', () => setTimeout(syncVisibility, 0));
  engineToggle?.addEventListener('toggle-change', syncVisibility);
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
        } else if (evt.phase === 'retry') {
          progressText.textContent = `Connection dropped — resuming (attempt ${evt.attempt + 1}/${evt.maxAttempts})…`;
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
}
wireOfflineModelInstaller({
  group: 'offline-installer-group', statusLine: 'offline-status-line', installBtn: 'offline-install-btn',
  progressWrap: 'offline-progress-wrap', progressBar: 'offline-progress-bar', progressText: 'offline-progress-text',
  engineToggle: 'speech-engine-toggle',
});
wireOfflineModelInstaller({
  group: 'first-run-offline-group', statusLine: 'first-run-offline-status-line', installBtn: 'first-run-offline-install-btn',
  progressWrap: 'first-run-offline-progress-wrap', progressBar: 'first-run-offline-progress-bar', progressText: 'first-run-offline-progress-text',
  engineToggle: 'first-run-engine-toggle',
});

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

// Core NDJSON-install-stream reader, shared by the Settings row above and
// the inline point-of-use upsell below (renderInlineTranslateUpsell) —
// they only differ in how they *render* progress, not in how the install
// itself is kicked off or read. POSTing while the server already has this
// language installing returns 409 (surfaces via onError) — callers that
// want to just watch an already-running install should poll status
// instead of calling this a second time.
async function streamMtInstall(code, { onProgress, onDone, onComplete, onError } = {}) {
  let res;
  try {
    res = await fetch(`${SERVER}/api/translate-model/install`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lang: code }),
    });
  } catch (err) {
    onError?.(err.message);
    return;
  }
  if (!res.ok || !res.body) {
    onError?.(`HTTP ${res.status}`);
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
        onProgress?.(evt.pct);
      } else if (evt.phase === 'done') {
        onDone?.(!!evt.already);
      } else if (evt.phase === 'complete') {
        onComplete?.(!!evt.ok, evt.error);
      }
    }
  }
}

async function installMtModel(code) {
  const sub = document.getElementById(`mt-sub-${code}`);
  const btn = document.getElementById(`mt-btn-${code}`);
  if (!sub || !btn) return;
  btn.style.display = 'none';
  sub.textContent = 'Connecting…';
  await streamMtInstall(code, {
    onProgress: (pct) => { sub.textContent = `Downloading… ${pct}%`; },
    onDone: (already) => { sub.textContent = already ? 'Already installed.' : 'Done.'; },
    onComplete: (ok, error) => {
      if (ok) setTimeout(() => refreshMtStatus(code), 800);
      else { sub.textContent = `Failed: ${error || 'unknown error'}`; btn.style.display = ''; }
    },
    onError: (msg) => { sub.textContent = `Failed: ${msg}`; btn.style.display = ''; },
  });
}

// ── Inline "you need this translation pack" upsell ─────────────────────
// Point-of-use counterpart to the Settings row above — same backend
// (/api/translate-model/status + /install), heavier .osp-family styling
// (matches Ollama's status panel) since a mid-workflow upsell needs more
// visual weight than a Settings list row. `container` is any element the
// caller owns (e.g. a popover) that this fully takes over via className/
// innerHTML — callers just need to give it a home and re-render on
// re-open, the same way the Settings row re-polls on its own.
const _inlineMtPollTimers = new WeakMap(); // container -> interval id

function _inlineMtTitle(container, dotClass, text) {
  return `<div class="osp-row"><span class="osp-dot${dotClass ? ' ' + dotClass : ''}"></span><span class="osp-title">${text}</span></div>`;
}

async function renderInlineTranslateUpsell(container, code) {
  if (!container) return;
  clearInterval(_inlineMtPollTimers.get(container));
  const name = (MT_LANGUAGES.find(l => l.code === code) || {}).name || code;
  container.className = 'osp osp-loading';
  container.innerHTML = _inlineMtTitle(container, '', `Checking ${escapeHtml(name)}…`);

  let status;
  try {
    status = await fetch(`${SERVER}/api/translate-model/status?lang=${code}`).then(r => r.json());
  } catch {
    container.className = 'osp osp-err';
    container.innerHTML = _inlineMtTitle(container, '', `Could not check ${escapeHtml(name)}`);
    return;
  }

  if (status.installed) {
    container.className = 'osp osp-ok';
    container.innerHTML = _inlineMtTitle(container, '', `${escapeHtml(name)} is installed`);
    return;
  }

  if (status.installing) {
    // Started elsewhere (Settings, or translate.js's own background
    // kick-off) — watch it instead of firing a second install (the server
    // 409s a concurrent POST for the same language). No live % is
    // available for an install we didn't start ourselves, same as the
    // Settings row in this state.
    container.className = 'osp osp-progress';
    container.innerHTML = _inlineMtTitle(container, 'pulse', `Downloading ${escapeHtml(name)}…`) +
      '<p class="osp-msg">Started elsewhere — installing in the background.</p>';
    _inlineMtPollTimers.set(container, setInterval(() => renderInlineTranslateUpsell(container, code), 2000));
    return;
  }

  container.className = 'osp osp-warn';
  container.innerHTML =
    _inlineMtTitle(container, '', `${escapeHtml(name)} isn't downloaded yet`) +
    `<p class="osp-msg">${status.approxMB ? `~${status.approxMB}MB · ` : ''}Runs offline once installed.</p>` +
    `<div class="osp-actions"><button class="osp-btn osp-btn-primary" id="osp-inline-install">Download ${escapeHtml(name)}</button></div>`;
  container.querySelector('#osp-inline-install')?.addEventListener('click', () => _startInlineTranslateInstall(container, code, name));
}

function _startInlineTranslateInstall(container, code, name) {
  container.className = 'osp osp-progress';
  container.innerHTML =
    _inlineMtTitle(container, 'pulse', `Downloading <strong>${escapeHtml(name)}</strong>`) +
    '<div class="osp-progress-bar"><div class="osp-progress-fill" id="osp-inline-fill" style="width:0%"></div></div>' +
    '<div class="osp-progress-meta" id="osp-inline-meta"></div>';
  const fillEl = container.querySelector('#osp-inline-fill');
  const metaEl = container.querySelector('#osp-inline-meta');
  streamMtInstall(code, {
    onProgress: (pct) => { if (fillEl) fillEl.style.width = `${pct}%`; if (metaEl) metaEl.textContent = `${pct}%`; },
    onDone: () => { if (metaEl) metaEl.textContent = 'Finishing…'; },
    onComplete: (ok, error) => {
      if (ok) {
        container.className = 'osp osp-ok';
        container.innerHTML = _inlineMtTitle(container, '', `${escapeHtml(name)} is installed`);
      } else {
        container.className = 'osp osp-err';
        container.innerHTML = _inlineMtTitle(container, '', `Failed: ${escapeHtml(error || 'unknown error')}`);
      }
    },
    onError: (msg) => {
      container.className = 'osp osp-err';
      container.innerHTML = _inlineMtTitle(container, '', `Failed: ${escapeHtml(msg)}`);
    },
  });
}

renderMtModelList();

// ── Semantic layer ("meaning-based Candidates") installer ────────────────
// Same state-aware .osp card the Ollama status panel used to use (that
// feature's gone — see Content Studio removal — but the card shape fit
// this just as well): idle/checking → not-installed-with-a-download-button
// → downloading (two phases, model then verse index) → ready. Backed by
// /api/semantic-model/status + /install (server.js), which install into
// server/semantic_installer.js.
let _semanticPollTimer = null;

function _semRow(dotClass, text) {
  return `<div class="osp-row"><span class="osp-dot${dotClass ? ' ' + dotClass : ''}"></span><span class="osp-title">${text}</span></div>`;
}

async function refreshSemanticStatus() {
  const panel = document.getElementById('semantic-status-panel');
  if (!panel) return;
  let s;
  try {
    s = await fetch(`${SERVER}/api/semantic-model/status`).then(r => r.json());
  } catch {
    panel.className = 'osp osp-err';
    panel.innerHTML = _semRow('', 'Could not reach server');
    return;
  }

  if (s.installed) {
    clearInterval(_semanticPollTimer); _semanticPollTimer = null;
    panel.className = 'osp osp-ok';
    panel.innerHTML = _semRow('', 'Ready — meaning-based Candidates are active');
    return;
  }

  if (s.installing) {
    if (!_semanticPollTimer) _semanticPollTimer = setInterval(refreshSemanticStatus, 2000);
    panel.className = 'osp osp-progress';
    panel.innerHTML = _semRow('pulse', 'Installing — see progress below') +
      '<div class="osp-progress-bar"><div class="osp-progress-fill" style="width:50%"></div></div>';
    return;
  }

  clearInterval(_semanticPollTimer); _semanticPollTimer = null;
  panel.className = 'osp osp-warn';
  panel.innerHTML = _semRow('', 'Not installed (~300MB, one-time)') +
    '<div class="osp-actions"><button class="osp-btn osp-btn-primary" id="semantic-install-btn">Download</button></div>';
  document.getElementById('semantic-install-btn')?.addEventListener('click', installSemanticLayer);
}

async function installSemanticLayer() {
  const panel = document.getElementById('semantic-status-panel');
  if (!panel) return;
  panel.className = 'osp osp-progress';
  panel.innerHTML = _semRow('pulse', 'Connecting…') +
    '<div class="osp-progress-bar"><div class="osp-progress-fill" id="semantic-progress-fill" style="width:0%"></div></div>' +
    '<div class="osp-progress-meta" id="semantic-progress-meta"></div>';
  const fillEl = document.getElementById('semantic-progress-fill');
  const metaEl = document.getElementById('semantic-progress-meta');

  let res;
  try {
    res = await fetch(`${SERVER}/api/semantic-model/install`, { method: 'POST' });
  } catch (err) {
    panel.className = 'osp osp-err';
    panel.innerHTML = _semRow('', `Failed: ${escapeHtml(err.message)}`);
    return;
  }
  if (res.status === 409) {
    // Another install is already running (e.g. a previous attempt whose
    // stream got dropped, still going server-side) — that's not a failure,
    // refreshSemanticStatus's own 'installing' branch already knows how to
    // show real progress and poll, so defer to it instead of a scary error.
    await refreshSemanticStatus();
    return;
  }
  if (!res.ok || !res.body) {
    panel.className = 'osp osp-err';
    panel.innerHTML = _semRow('', `Failed: HTTP ${res.status}`);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  let failed = null;
  // This stream can run 30-90 minutes (see the 'embed' phase note below) —
  // long enough for a real network drop or laptop sleep. Unhandled, that's
  // a rejected reader.read() with no on-screen recovery short of reloading
  // the whole app window.
  try {
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
          if (fillEl) fillEl.style.width = evt.pct + '%';
          if (metaEl) metaEl.textContent = `Downloading model… ${evt.pct}%`;
        } else if (evt.phase === 'embed' && typeof evt.pct === 'number') {
          if (fillEl) fillEl.style.width = evt.pct + '%';
          // Measured against a real run: ~10% in 9 minutes of wall time on
          // this dev machine, i.e. on the order of an hour total, not the
          // "a couple minutes" a first guess (based on a single short-query
          // benchmark, not this actual 31k-verse batched workload) suggested.
          // Give a real range rather than repeat that mistake in the UI.
          if (metaEl) metaEl.textContent = `Indexing every verse… ${evt.pct}% (can take 30-90 min depending on your machine, one time only)`;
        } else if (evt.phase === 'complete' && !evt.ok) {
          failed = evt.error || 'unknown error';
        }
      }
    }
  } catch (err) {
    panel.className = 'osp osp-err';
    panel.innerHTML = _semRow('', `Connection lost: ${escapeHtml(err.message)}`) +
      '<div class="osp-actions"><button class="osp-btn osp-btn-primary" id="semantic-retry-btn">Retry</button></div>';
    document.getElementById('semantic-retry-btn')?.addEventListener('click', installSemanticLayer);
    return;
  }
  if (failed) {
    panel.className = 'osp osp-err';
    panel.innerHTML = _semRow('', `Failed: ${escapeHtml(failed)}`);
  } else {
    await refreshSemanticStatus();
  }
}

refreshSemanticStatus();

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

const DEFAULT_LOOKS = [
  {
    id: 'full-bg', name: 'Full — Background', layout: 'fullscreen', animation: 'fade',
    groupId: 'grp-bible', groupName: 'Bible',
    layers: [
      { id: 'bg', type: 'background', name: 'Canvas', visible: true,
        fill: 'gradient', color: '#0b0b0f', opacity: 100, color2: '#1c1c30', angle: 160 },
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
        fill: 'gradient', color: '#0b0b0f', opacity: 100, color2: '#1c1c30', angle: 160, radius: 0,
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
        fill: 'gradient', color: '#0b0b0f', opacity: 100, color2: '#1c1c30', angle: 160, radius: 0,
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
      { id: 'bg', type: 'background', name: 'Canvas', visible: true,
        fill: 'gradient', color: '#0b0b0f', opacity: 100, color2: '#1c1c30', angle: 160 },
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
      { id: 'bg', type: 'background', name: 'Canvas', visible: true,
        fill: 'gradient', color: '#0b0b0f', opacity: 100, color2: '#1c1c30', angle: 160 },
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
      { id: 'bg', type: 'background', name: 'Canvas', visible: true,
        fill: 'gradient', color: '#0b0b0f', opacity: 100, color2: '#1c1c30', angle: 160 },
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
    stored.forEach(l => {
      const def = defaultsById.get(l.id);
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
    if (cycleSampleMigrated || alignMigrated || textHeightMigrated) {
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
    activeLayer = null; multiSelectedLayerIds.clear();
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
  tsCommitActiveEdit(null);
  activeLook  = look;
  activeLayer = null; multiSelectedLayerIds.clear();
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
  activeLayer = null; multiSelectedLayerIds.clear();
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
    activeLayer = null; multiSelectedLayerIds.clear();
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
  const alphaBtn = document.getElementById('ts-alpha-toggle');
  if (alphaBtn) alphaBtn.classList.toggle('active', isAlphaCanvas());
  const chromaBtn = document.getElementById('ts-chroma-toggle');
  if (chromaBtn) chromaBtn.classList.toggle('active', isChromaCanvas());
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
// Standard chroma-green — see the Chroma Key button's own tooltip for why
// this exists as a distinct option from Transparent: real per-pixel alpha
// only survives through Syphon/NDI output; a plain OBS/vMix "Window
// Capture" of the display window does NOT preserve any app's transparency,
// so a solid, keyable color is the reliable default for that far more
// common setup.
const CHROMA_KEY_COLOR = '#00FF00';
function isChromaCanvas() {
  const bg = baseBgLayer();
  return bg?.fill === 'solid' && (bg.color || '').toUpperCase() === CHROMA_KEY_COLOR;
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
      if (layer.binding === 'timer') return s.timerText || PREVIEW_TIMER_SAMPLE;
      if (layer.binding === 'timer-h') return '00';
      if (layer.binding === 'timer-m') return '12';
      if (layer.binding === 'timer-s') return '34';
      if (layer.binding === 'verse_translated') {
        return TS_TRANSLATE_SAMPLES[tsItemCtx.item.translateTo] || '[No translation language set for this item]';
      }
      if (layer.binding === 'custom' && typeof layer.customText === 'string' && layer.customText.includes('{timer}')) {
        return layer.customText.replace('{timer}', s.timerText || PREVIEW_TIMER_SAMPLE);
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
      } else if (layer.motion === 'kenburns') {
        // Live in the editor too, not just the real output — the whole
        // point of a "does this feel dynamic" judgment call is seeing the
        // motion while picking colors/copy, not only after starting a
        // live countdown and switching to the actual display to check.
        // Same outer-wrapper/inner-art split as display.html's own
        // startCycleMotion, for the same clipping reason.
        div.style.cssText = posCss + 'overflow:hidden;';
        const art = document.createElement('div');
        art.style.cssText = `position:absolute;inset:0;background-repeat:no-repeat;background-position:center;background-image:url('${layer.src}');background-size:${fit === 'fill' ? '100% 100%' : fit};animation:kairo-kenburns 18s ease-in-out infinite alternate;`;
        div.appendChild(art);
      } else {
        div.style.cssText = posCss + `
          background-image:url('${layer.src}');
          background-size:${fit === 'fill' ? '100% 100%' : fit};
          background-position:center;
          background-repeat:no-repeat;
        `;
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
        ${kenBurns ? 'overflow:hidden;' : (first ? `background-image:url('${first}');` : 'background:#1a1a1e;')}
        ${kenBurns ? '' : `background-size:${fit === 'fill' ? '100% 100%' : fit};background-position:center;background-repeat:no-repeat;`}
        ${layer.rotation ? `transform: rotate(${layer.rotation}deg);` : ''}
      `;
      // Live in the editor too — same reasoning as the plain 'image'
      // branch above.
      if (kenBurns) {
        const art = document.createElement('div');
        art.style.cssText = `position:absolute;inset:0;background-repeat:no-repeat;background-position:center;background-image:url('${first}');background-size:${fit === 'fill' ? '100% 100%' : fit};animation:kairo-kenburns 18s ease-in-out infinite alternate;`;
        div.appendChild(art);
      }
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
        div.style.transform = 'none';
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
      if (layer.pos && div.scrollWidth > div.clientWidth + 1) {
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

    // Corner-drag on an image with known natural dimensions: lock the box's
    // aspect ratio to the image's own rather than letting nw/nh drift apart
    // (independently derived from raw dx/dy above). That drift is exactly
    // what made a contain-fit image look like it was zooming while being
    // resized — the box's constraining dimension kept flipping between
    // width and height as its aspect ratio wandered away from the image's.
    // Edge-midpoint handles (a single character in `d`, e.g. just 'e' or
    // 's') stay free-form — only corners scale as a unit, the same
    // convention design tools use for image resize handles.
    if (layer.type === 'image' && layer.naturalW && layer.naturalH && d.length === 2) {
      const aspect = layer.naturalW / layer.naturalH;
      nh = nw / aspect;
      if (d.includes('n')) ny = start.y + baseH - nh; // bottom edge stays anchored
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
    if (document.activeElement !== inp) inp.value = layer.pos[k];
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
      e.stopPropagation();
      if (activeLayer !== layer) { activeLayer = layer; renderLayersList(); renderProps(); renderPreview(); }
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
    // Eight-point selection frame: four corners + four edge midpoints,
    // each resizing from the opposite anchor.
    ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'].forEach(dir => {
      const h = document.createElement('div');
      h.className = `ts-handle ts-handle-${dir}`;
      h.addEventListener('mousedown', (e) => tsBeginDrag(e, layer, 'resize', dir));
      div.appendChild(h);
    });
  }
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
function tsGroupBounds(layers) {
  if (!layers.length) return { x: 0, y: 0, w: 0, h: 0 };
  const boxes = layers.map(l => { const pos = ensurePos(l); return { pos, h: tsEffectiveH(l, pos) }; });
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
  background:  ['layout', 'style'],
  image:       ['layout', 'style'],
  'image-cycle': ['layout', 'style'],
  text:        ['layout', 'style', 'effects'],
};
// Persists across layer switches within one Edit/Theme Studio session
// (picking a different layer doesn't jump you back to Layout every time) —
// reset only when it lands on a tab the newly-selected layer doesn't have.
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
  if (!panel || !empty) return;

  if (!activeLayer) {
    empty.style.display = 'flex';
    panel.style.display = 'none';
    panel.innerHTML = '';
    tabs?.classList.add('hidden');
    lastPropsLayerId = null;
    // Text Animation lives under the Style tab now (see below) — with
    // nothing selected there's no tab bar to gate it, so it should just
    // show, same as it always did before it moved in here.
    document.getElementById('ts-text-anim-section')?.classList.remove('ts-tab-hidden');
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
    panel.appendChild(section(null, 'Align', alignWrap));

    // Transform — the group's own bounding box as one X/Y/W/H, same fields
    // a single layer gets. X/Y moves every selected layer by the same
    // delta (same as dragging one of them). W/H, with the chain link
    // locked (default), SCALES every layer's position and size together
    // relative to the group's own top-left, instead of only ever being
    // able to resize members one at a time.
    const bounds = tsGroupBounds(tsSelectedLayers());
    const groupLinked = layerAspectLock.get('__group__') ?? true;
    const numField = (label, val, min, max, onChange) => {
      const inp = document.createElement('input');
      inp.type = 'number'; inp.className = 'ts-prop-number';
      inp.value = Math.round(val); inp.min = min; inp.max = max;
      inp.addEventListener('input', () => onChange(parseFloat(inp.value) || 0));
      const lbl = document.createElement('span'); lbl.className = 'ts-prop-label'; lbl.textContent = label;
      const g = document.createElement('span'); g.className = 'ts-field-group';
      g.appendChild(lbl); g.appendChild(inp);
      return g;
    };
    const xyRow = document.createElement('div');
    xyRow.className = 'ts-prop-row'; xyRow.style.gap = '8px';
    xyRow.appendChild(numField('X', bounds.x, -TS_DESIGN_W, TS_DESIGN_W, (v) => {
      const b = tsGroupBounds(tsSelectedLayers());
      tsTransformSelection(tsSelectedLayers(), b, { dx: v - b.x });
      up();
    }));
    xyRow.appendChild(numField('Y', bounds.y, -TS_DESIGN_H, TS_DESIGN_H, (v) => {
      const b = tsGroupBounds(tsSelectedLayers());
      tsTransformSelection(tsSelectedLayers(), b, { dy: v - b.y });
      up();
    }));
    const whRow = document.createElement('div');
    whRow.className = 'ts-prop-row'; whRow.style.gap = '8px';
    whRow.appendChild(numField('W', bounds.w, 4, TS_DESIGN_W, (v) => {
      const b = tsGroupBounds(tsSelectedLayers());
      const sx = v / Math.max(1, b.w);
      const linked = layerAspectLock.get('__group__') ?? true;
      tsTransformSelection(tsSelectedLayers(), b, { sx, sy: linked ? sx : 1 });
      up(); renderProps();
    }));
    const linkBtn = document.createElement('button');
    linkBtn.type = 'button';
    linkBtn.className = 'ts-aspect-link' + (groupLinked ? ' active' : '');
    linkBtn.title = groupLinked ? 'Width/Height are linked — click to unlink' : 'Width/Height are unlinked — click to link';
    linkBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 15l6-6"/><path d="M11 6l1.5-1.5a3.54 3.54 0 0 1 5 5L16 11"/><path d="M13 18l-1.5 1.5a3.54 3.54 0 0 1-5-5L8 13"/></svg>';
    linkBtn.addEventListener('click', () => {
      const now = !(layerAspectLock.get('__group__') ?? true);
      layerAspectLock.set('__group__', now);
      linkBtn.classList.toggle('active', now);
      linkBtn.title = now ? 'Width/Height are linked — click to unlink' : 'Width/Height are unlinked — click to link';
    });
    whRow.appendChild(linkBtn);
    whRow.appendChild(numField('H', bounds.h, 4, TS_DESIGN_H, (v) => {
      const b = tsGroupBounds(tsSelectedLayers());
      const sy = v / Math.max(1, b.h);
      const linked = layerAspectLock.get('__group__') ?? true;
      tsTransformSelection(tsSelectedLayers(), b, { sy, sx: linked ? sy : 1 });
      up(); renderProps();
    }));
    panel.appendChild(section(null, 'Transform', xyRow, whRow));

    document.getElementById('ts-text-anim-section')?.classList.add('ts-tab-hidden');
    return;
  }

  // Text is what an operator almost always opens Full-scale edit/Theme
  // Studio to actually change (a font, a color, a size) — landing on
  // Layout for a freshly-selected text layer meant an extra click to get
  // anywhere useful nearly every time. Only fires on an actual NEW
  // selection, not every re-render of the panel for the layer already open.
  if (activeLayer.id !== lastPropsLayerId && activeLayer.type === 'text') activePropsTab = 'style';
  lastPropsLayerId = activeLayer.id;

  empty.style.display = 'none';
  panel.style.display = 'block';
  panel.innerHTML = '';

  if (activeLayer.type === 'background') {
    renderBgProps(panel, activeLayer);
  } else if (activeLayer.type === 'image') {
    renderImageProps(panel, activeLayer);
  } else if (activeLayer.type === 'image-cycle') {
    renderImageCycleProps(panel, activeLayer);
  } else {
    renderTextProps(panel, activeLayer);
  }

  const available = PROPS_TABS_BY_LAYER_TYPE[activeLayer.type] || PROPS_TABS_BY_LAYER_TYPE.text;
  if (!available.includes(activePropsTab)) activePropsTab = available[0];
  if (tabs) {
    tabs.classList.remove('hidden');
    tabs.querySelectorAll('.ts-tab-btn').forEach(btn => {
      const has = available.includes(btn.dataset.tab);
      btn.classList.toggle('hidden', !has);
      btn.classList.toggle('active', btn.dataset.tab === activePropsTab);
    });
  }
  // A class, not a direct style write — see the .ts-tab-hidden comment in
  // styles.css for why this has to compose with, not clobber, each
  // section's own enabled/disabled inline display (Shadow/Outline/Scroll).
  // #ts-text-anim-section lives outside `panel` (a static, always-in-DOM
  // theme-level control, not one of the per-layer sections panel.innerHTML
  // rebuilds every render) but still opts into the exact same tab gating —
  // included explicitly since panel.querySelectorAll can't reach it.
  panel.querySelectorAll('[data-tab]').forEach(el => {
    el.classList.toggle('ts-tab-hidden', el.dataset.tab !== activePropsTab);
  });
  document.getElementById('ts-text-anim-section')?.classList.toggle('ts-tab-hidden', activePropsTab !== 'style');
}

document.querySelectorAll('#ts-props-tabs .ts-tab-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    if (btn.classList.contains('hidden')) return;
    activePropsTab = btn.dataset.tab;
    renderProps();
  });
});

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

function makeSlider(val, min, max, onChange) {
  const wrap = document.createElement('div');
  wrap.style.cssText = 'display:flex;align-items:center;gap:6px;flex:1;';
  const sl = document.createElement('input');
  sl.type = 'range'; sl.className = 'ts-prop-slider';
  sl.min = min; sl.max = max; sl.value = val;
  const lbl = document.createElement('span');
  lbl.className = 'ts-prop-val';
  lbl.textContent = val;
  // The label updates on every 'input' event (cheap, instant feedback) —
  // but onChange always ends in up(), a full canvas teardown/rebuild.
  // Dragging a slider fires dozens of 'input' events a second; calling
  // onChange synchronously for every single one rebuilt the whole canvas
  // that often, which is exactly what read as "Opacity flickers while
  // dragging" (or any other slider). Coalesced to at most once per
  // animation frame instead — same fix as the position-drag throttle.
  let queued = false, pendingValue = null;
  sl.addEventListener('input', () => {
    lbl.textContent = sl.value;
    pendingValue = parseFloat(sl.value);
    if (queued) return;
    queued = true;
    requestAnimationFrame(() => { queued = false; onChange(pendingValue); });
  });
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

// A real <select> for a small fixed set of choices — same shape as
// makeWeightSelect/makeFontSelect, generalized. Chips read fine for a
// handful of options with room to spare (Fit Mode, alignment), but for
// something like text Case, a dropdown reads as the more standard control
// (matches Canva/ProPresenter's own text panels) and takes less width.
function makeSelect(options, current, onChange) {
  const sel = document.createElement('select');
  sel.className = 'ts-select';
  options.forEach(({ label, value }) => {
    const opt = document.createElement('option');
    opt.value = value;
    opt.textContent = label;
    if (value === current) opt.selected = true;
    sel.appendChild(opt);
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
      updateUndoRedoButtons();
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
  activeLayer = null; multiSelectedLayerIds.clear();
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

  const posNum = (key, min, max, { aspect = false } = {}) => {
    const inp = makeNumber(cur[key], min, max, 1, v => {
      const p = ensurePos(layer);
      const before = { w: p.w, h: p.h };
      p[key] = Math.round(v);
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
    });
    inp.dataset.posInput = key;
    return inp;
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
      if (tsMode === 'item') tsSave(); // same pre-existing-gap note as posNum above
    }));
  });

  // Groups a label with its input so .ts-prop-row's own flex-wrap (needed
  // so a crowded row doesn't clip against the panel edge) can only ever
  // break BETWEEN whole pairs, never in the middle of one — that's exactly
  // what was leaving the H field stranded on its own line with no visible
  // "H" next to it: five separate flex children (W label, W input, the
  // link button, H label, H input) in one row meant the row could wrap
  // right between the H label and the H input, same as it could between
  // any other two of those five.
  const fieldGroup = (...children) => {
    const g = document.createElement('span');
    g.className = 'ts-field-group';
    children.forEach(c => g.appendChild(c));
    return g;
  };

  const xyRow = document.createElement('div');
  xyRow.className = 'ts-prop-row'; xyRow.style.gap = '8px';
  const xl = document.createElement('span'); xl.className = 'ts-prop-label'; xl.textContent = 'X';
  const yl = document.createElement('span'); yl.className = 'ts-prop-label'; yl.textContent = 'Y';
  xyRow.appendChild(fieldGroup(xl, posNum('x', -TS_DESIGN_W, TS_DESIGN_W)));
  xyRow.appendChild(fieldGroup(yl, posNum('y', -TS_DESIGN_H, TS_DESIGN_H)));

  const whRow = document.createElement('div');
  whRow.className = 'ts-prop-row'; whRow.style.gap = '8px';
  const wl = document.createElement('span'); wl.className = 'ts-prop-label'; wl.textContent = 'W';
  const hl = document.createElement('span'); hl.className = 'ts-prop-label';
  hl.textContent = layer.type === 'text' ? 'H (0 = auto)' : 'H';
  // Chain link — locked (default) means typing W or H scales the other
  // dimension to keep the box's current proportions; unlinked scales just
  // that one field. Per-layer, not persisted (see layerAspectLock's own
  // comment above).
  const linked = layerAspectLock.get(layer.id) ?? true;
  const linkBtn = document.createElement('button');
  linkBtn.type = 'button';
  linkBtn.className = 'ts-aspect-link' + (linked ? ' active' : '');
  linkBtn.title = linked ? 'Width/Height are linked — click to unlink' : 'Width/Height are unlinked — click to link';
  linkBtn.innerHTML = '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><path d="M9 15l6-6"/><path d="M11 6l1.5-1.5a3.54 3.54 0 0 1 5 5L16 11"/><path d="M13 18l-1.5 1.5a3.54 3.54 0 0 1-5-5L8 13"/></svg>';
  linkBtn.addEventListener('click', () => {
    const now = !(layerAspectLock.get(layer.id) ?? true);
    layerAspectLock.set(layer.id, now);
    linkBtn.classList.toggle('active', now);
    linkBtn.title = now ? 'Width/Height are linked — click to unlink' : 'Width/Height are unlinked — click to link';
  });
  whRow.appendChild(fieldGroup(wl, posNum('w', 40, TS_DESIGN_W, { aspect: true }), linkBtn));
  whRow.appendChild(fieldGroup(hl, posNum('h', 0, TS_DESIGN_H, { aspect: true })));

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

  panel.appendChild(section('layout', 'Layout', ...kids));
}

// Background layer properties
function renderBgProps(panel, layer) {
  renderLayoutProps(panel, layer);

  // Shape — "Add Shape" only ever made a plain rectangle; layer.shape picks
  // from the same set applyShapeGeometry renders (this file, service.js's
  // thumbnails, and display.html's real output all read it the same way).
  // Corner Radius only means anything for 'rect' (the other shapes ignore
  // layer.radius entirely — pill/ellipse/triangle/diamond are already fully
  // rounded or already have their own hard edges), so it's hidden otherwise
  // rather than left sitting there doing nothing.
  panel.appendChild(section('style', 'Shape',
    makeChips([
      { label: 'Rectangle', value: 'rect' },
      { label: 'Ellipse',   value: 'ellipse' },
      { label: 'Pill',      value: 'pill' },
      { label: 'Triangle',  value: 'triangle' },
      { label: 'Diamond',   value: 'diamond' },
    ], layer.shape || 'rect', v => { layer.shape = v; radiusRow.style.display = v === 'rect' ? '' : 'none'; up(); })
  ));
  const radiusRow = section('style', 'Corner Radius',
    prop('Radius', makeSlider(layer.radius || 0, 0, 200, v => { layer.radius = v; up(); }))
  );
  if ((layer.shape || 'rect') !== 'rect') radiusRow.style.display = 'none';
  panel.appendChild(radiusRow);

  // Fill type
  panel.appendChild(section('style', 'Fill',
    makeFillChips(layer.fill, v => { layer.fill = v; colorRow.style.display = v === 'transparent' ? 'none' : ''; grad2Row.style.display = v === 'gradient' ? '' : 'none'; up(); })
  ));

  // Color + opacity
  const colorRow = section('style', 'Color',
    prop('Color', makeColor(layer.color, v => { layer.color = v; up(); })),
    prop('Opacity', makeSlider(layer.opacity, 0, 100, v => { layer.opacity = v; up(); }))
  );
  if (layer.fill === 'transparent') colorRow.style.display = 'none';
  panel.appendChild(colorRow);

  // Gradient color 2
  const grad2Row = section('style', 'Gradient',
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
  panel.appendChild(section('layout', 'Layer', prop('Name', nameInp)));

  renderLayoutProps(panel, layer);

  panel.appendChild(section('style', 'Image',
    prop('Fit', makeChips([
      { label: 'Contain', value: 'contain' },
      { label: 'Cover',   value: 'cover' },
      { label: 'Stretch', value: 'fill' },
    ], layer.fit || 'contain', v => { layer.fit = v; up(); })),
    prop('Opacity', makeSlider(layer.opacity ?? 100, 0, 100, v => { layer.opacity = v; up(); })),
    prop('Radius', makeSlider(layer.radius || 0, 0, 200, v => { layer.radius = v; up(); })),
    // A slow continuous zoom/pan while this image sits on screen — same
    // option Image Cycle has, and the same reason it's a plain CSS
    // animation rather than anything frame-rendered (see display.html's
    // matching branch): a single still background still benefits from
    // feeling alive, not just a slideshow of several.
    prop('Motion', makeSelect([
      { label: 'None', value: 'none' }, { label: 'Ken Burns (slow zoom)', value: 'kenburns' },
    ], layer.motion || 'none', v => { layer.motion = v; up(); }))
  ));

  // The color-key "Remove background" cutout used to live here — pulled per
  // operator report that it doesn't key cleanly (a flat-color-tolerance
  // keyer can't handle a real photo background, only a true flat backdrop),
  // so it did more harm than good. removeImageBackground() itself is gone
  // too; if a real cutout tool comes back, it should be an actual
  // segmentation model, not this.
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
  const nameInp = document.createElement('input');
  nameInp.type = 'text'; nameInp.className = 'ts-prop-input';
  nameInp.value = layer.name; nameInp.placeholder = 'Layer name';
  nameInp.addEventListener('input', () => { layer.name = nameInp.value; renderLayersList(); });
  panel.appendChild(section('layout', 'Layer', prop('Name', nameInp)));

  renderLayoutProps(panel, layer);

  panel.appendChild(section('style', 'Image',
    prop('Fit', makeChips([
      { label: 'Contain', value: 'contain' },
      { label: 'Cover',   value: 'cover' },
      { label: 'Stretch', value: 'fill' },
    ], layer.fit || 'cover', v => { layer.fit = v; up(); })),
    prop('Opacity', makeSlider(layer.opacity ?? 100, 0, 100, v => { layer.opacity = v; up(); })),
    prop('Radius', makeSlider(layer.radius || 0, 0, 200, v => { layer.radius = v; up(); }))
  ));

  // Timing/transition — only meaningful for a scene's own Image Cycle
  // layer (a segment's "Scenes" list, see renderItemTimerControls); the
  // plain single-theme case ignores intervalSec entirely and keeps
  // spacing sources evenly across the whole countdown instead (see
  // display.html's handleActionBadge for exactly which of the two applies
  // and why). 0/blank = "use the whole-countdown spacing", not "instant".
  panel.appendChild(section('style', 'Timing',
    prop('Seconds/image', makeNumber(layer.intervalSec || '', 0, 600, 1, v => { layer.intervalSec = v > 0 ? v : undefined; up(); })),
    prop('Change', makeSelect([
      { label: 'Cut', value: 'cut' }, { label: 'Slide (left to right)', value: 'slide' },
      { label: 'Crossfade', value: 'crossfade' },
    ], layer.transition || 'cut', v => { layer.transition = v; up(); })),
    // A continuous slow zoom/pan while the image sits there — the same
    // idea Remotion/HyperFrames-style motion primitives are built for,
    // reimplemented here as a plain CSS animation (see display.html's
    // startCycleMotion) so it keeps running live against a countdown that
    // can be re-timed at any moment, instead of a pre-rendered timeline.
    prop('Motion', makeSelect([
      { label: 'None', value: 'none' }, { label: 'Ken Burns (slow zoom)', value: 'kenburns' },
    ], layer.motion || 'none', v => { layer.motion = v; up(); }))
  ));

  const listWrap = document.createElement('div');
  listWrap.className = 'ts-cycle-list';
  const addBtns = document.createElement('div');
  addBtns.className = 'ts-cycle-add-row';
  const uploadBtn = document.createElement('button');
  uploadBtn.className = 'modal-btn'; uploadBtn.textContent = 'Upload…';
  const libBtn = document.createElement('button');
  libBtn.className = 'modal-btn'; libBtn.textContent = 'From Library…';
  const fileInp = document.createElement('input');
  fileInp.type = 'file'; fileInp.accept = 'image/*'; fileInp.multiple = true; fileInp.style.display = 'none';
  uploadBtn.addEventListener('click', () => fileInp.click());
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
  libBtn.addEventListener('click', () => openCycleImagePicker(layer));
  addBtns.appendChild(uploadBtn); addBtns.appendChild(libBtn); addBtns.appendChild(fileInp);
  // Only offered while empty — once there are real images, loading the
  // sample set on top would just be clutter, not a preview aid anymore.
  if (!(layer.sources || []).length) {
    const sampleBtn = document.createElement('button');
    sampleBtn.className = 'modal-btn secondary';
    sampleBtn.textContent = 'Load sample images';
    sampleBtn.title = 'Placeholder frames so you can see the cycle in action before adding your own';
    sampleBtn.addEventListener('click', () => {
      layer.sources = [...SAMPLE_CYCLE_IMAGES];
      up();
      renderProps();
    });
    addBtns.appendChild(sampleBtn);
  }
  listWrap.appendChild(addBtns);

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
  panel.appendChild(section('style', `Images (${(layer.sources || []).length})`, listWrap));
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
  grid.textContent = 'Loading…';
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

// Text layer properties
function renderTextProps(panel, layer) {
  // Name + binding
  const nameInp = document.createElement('input');
  nameInp.type = 'text'; nameInp.className = 'ts-prop-input';
  nameInp.value = layer.name; nameInp.placeholder = 'Layer name';
  nameInp.addEventListener('input', () => { layer.name = nameInp.value; renderLayersList(); });

  panel.appendChild(section('layout', 'Layer',
    prop('Name', nameInp),
    prop('Binds to', makeChips([
      { label: 'Verse', value: 'verse' },
      { label: 'Ref', value: 'reference' },
      { label: 'Timer', value: 'timer' },
      // Hour/Minute/Second — the individual zero-padded pieces (see
      // display.html's timeParts) instead of one fixed "H:MM:SS" string,
      // so the countdown can be laid out as separately positioned/sized/
      // styled elements — e.g. the hour stacked directly above the
      // minute — rather than only ever one text box with no layout
      // control over its own pieces.
      { label: 'Hour', value: 'timer-h' },
      { label: 'Minute', value: 'timer-m' },
      { label: 'Second', value: 'timer-s' },
      { label: 'Custom', value: 'custom' },
    ], layer.binding, v => { layer.binding = v; customRow.style.display = v === 'custom' ? '' : 'none'; up(); }))
  ));

  renderLayoutProps(panel, layer);

  const customInp = document.createElement('input');
  customInp.type = 'text'; customInp.className = 'ts-prop-input';
  customInp.value = layer.customText || ''; customInp.placeholder = 'Custom text…';
  customInp.addEventListener('input', () => { layer.customText = customInp.value; up(); });
  const customRow = section('layout', null, prop('Text', customInp));
  customRow.style.display = layer.binding === 'custom' ? '' : 'none';
  panel.appendChild(customRow);

  // Font
  panel.appendChild(section('style', 'Font',
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
      const trSelect = makeSelect([
        { label: 'None', value: 'none' }, { label: 'UPPERCASE', value: 'uppercase' }, { label: 'lowercase', value: 'lowercase' },
      ], layer.font.transform, v => { layer.font.transform = v; up(); });
      row.appendChild(itLabel); row.appendChild(itToggle);
      row.appendChild(trLabel); row.appendChild(trSelect);
      return row;
    })()
  ));

  // Spacing — both as plain number entries, same row (mirrors the
  // Size+Weight row above), not sliders. An exact value like 1.15 line
  // height or -0.5 letter spacing is what people actually reach for; a
  // slider makes hitting one precisely more fiddly, not less, and two
  // separate rows for two related, similarly-sized numbers was just
  // taking up more vertical space than the content needed.
  panel.appendChild(section('style', 'Spacing',
    (() => {
      const row = document.createElement('div');
      row.className = 'ts-prop-row'; row.style.gap = '8px';
      const lhLabel = document.createElement('span'); lhLabel.className = 'ts-prop-label'; lhLabel.textContent = 'Line H';
      const lhInp = makeNumber(layer.font.lineHeight, 0.5, 4, 0.05, v => { layer.font.lineHeight = parseFloat(v.toFixed(2)); up(); });
      const ltLabel = document.createElement('span'); ltLabel.className = 'ts-prop-label'; ltLabel.textContent = 'Letter';
      const ltInp = makeNumber(layer.font.letterSpacing, -5, 30, 0.5, v => { layer.font.letterSpacing = parseFloat(v.toFixed(1)); up(); });
      row.appendChild(lhLabel); row.appendChild(lhInp);
      row.appendChild(ltLabel); row.appendChild(ltInp);
      return row;
    })()
  ));

  // Color
  panel.appendChild(section('style', 'Color',
    prop('Color', makeColor(layer.color, v => { layer.color = v; up(); })),
    prop('Opacity', makeSlider(layer.opacity, 0, 100, v => { layer.opacity = v; up(); })),
    prop('Align', makeAlignBtns(layer.align, v => { layer.align = v; up(); }))
  ));

  // Effects (Shadow/Outline/Scroll) — each one used to be TWO separate
  // .ts-props-section blocks (a header-only section, then a second section
  // for its detail rows), which meant two full padding+border-bottom
  // boxes per effect: an unwanted divider splitting a toggle from the
  // very controls it toggles, and double the visual weight for one
  // logical group. Building an on/off effect's row now merges both into
  // one real section, with just an inner wrapper (not a section of its
  // own) collapsing for the detail rows.
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

  // Shadow
  panel.appendChild(effectSection('Shadow', layer.shadow.enabled, v => { layer.shadow.enabled = v; }, [
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
    })(),
  ]));

  // Outline
  panel.appendChild(effectSection('Outline', layer.outline.enabled, v => { layer.outline.enabled = v; }, [
    prop('Color', makeColor(layer.outline.color, v => { layer.outline.color = v; up(); })),
    prop('Width', makeSlider(layer.outline.width, 1, 10, v => { layer.outline.width = v; up(); })),
  ]));

  // Scroll — continuous horizontal marquee (news-ticker / large-scroll
  // layers, see the Ticker and Scroll — Fill Screen presets). Independent of
  // layout: works on the Ticker preset's bottom strip or a free-canvas box
  // just as well. Speed is seconds per full loop — lower is faster.
  if (!layer.scroll) layer.scroll = { enabled: false, speed: 15 };
  panel.appendChild(effectSection('Scroll', layer.scroll.enabled, v => { layer.scroll.enabled = v; }, [
    prop('Speed', makeSlider(layer.scroll.speed, 3, 60, v => { layer.scroll.speed = v; up(); })),
  ]));

  // Entrance — a one-time fade + rise the moment this slide/scene first
  // shows, not a continuous effect like Ken Burns (Image/Image Cycle's own
  // Motion option). Plays in every render context (real output, editor
  // canvas, operator preview) the same simple way: a CSS animation added
  // when the element is first created, since "the slide just appeared" IS
  // "this element was just created" in all three.
  panel.appendChild(effectSection('Entrance', (layer.entrance || 'none') !== 'none',
    v => { layer.entrance = v ? 'fade-up' : 'none'; }, [
      prop('Style', makeSelect([
        { label: 'Fade + Rise', value: 'fade-up' },
      ], layer.entrance === 'fade-up' ? 'fade-up' : 'fade-up', v => { layer.entrance = v; up(); })),
    ]));
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
  tsCommitActiveEdit(null);
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
  // .ts-meta-row doesn't exist anywhere in the DOM (a stale selector from
  // before these became individual .ts-props-section blocks — this was a
  // silent no-op, so Layout/Transition/Text Animation/Canvas/Translate-to
  // never actually hid in item mode at all). .ts-theme-meta is the real,
  // current marker shared by all of them (Transition now lives next to the
  // canvas instead of in this column, but it's still theme-level and still
  // tagged the same way).
  document.querySelectorAll('.ts-theme-meta').forEach(el => el.classList.toggle('hidden', isItem));
  // Canvas size is a whole-theme concern too — floats over the preview
  // instead of living among the others, so it needs its own toggle here.
  document.querySelector('.ts-canvas-size-group')?.classList.toggle('hidden', isItem);
  const hint = document.querySelector('.ts-layers-hint');
  if (hint) hint.style.visibility = isItem ? 'hidden' : '';
  if (isItem) { updateItemThemeLabel(); renderItemTimerControls(); }
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

  const label = document.createElement('div');
  label.className = 'ts-props-section-label';
  label.textContent = 'Timer';
  host.appendChild(label);

  const modeRow = document.createElement('div');
  modeRow.className = 'ts-prop-row';
  modeRow.appendChild(makeChips([
    { label: 'Ends at', value: 'endAt' },
    { label: 'Duration', value: 'duration' },
  ], mode, (v) => { save({ mode: v }); renderItemTimerControls(); }));
  host.appendChild(modeRow);

  const fieldRow = document.createElement('div');
  fieldRow.className = 'ts-prop-row';
  if (mode === 'duration') {
    const minutes = document.createElement('input');
    minutes.type = 'number'; minutes.min = '1'; minutes.className = 'ts-prop-number';
    minutes.placeholder = 'Minutes';
    minutes.value = params.durationSec ? Math.round(params.durationSec / 60) : '';
    minutes.addEventListener('change', () => {
      const min = parseFloat(minutes.value);
      if (min > 0) save({ mode: 'duration', durationSec: Math.round(min * 60) });
    });
    fieldRow.appendChild(minutes);
    const suffix = document.createElement('span');
    suffix.className = 'ts-prop-label';
    suffix.textContent = 'minutes';
    fieldRow.appendChild(suffix);
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
    timeInp.type = 'text'; timeInp.inputMode = 'numeric'; timeInp.placeholder = 'HH:MM or H:MM AM/PM'; timeInp.maxLength = 8;
    timeInp.className = 'ts-prop-input';
    timeInp.value = params.endAtTime || '';
    timeInp.addEventListener('input', () => {
      if (/^[0-9:]*$/.test(timeInp.value)) {
        const digits = timeInp.value.replace(/\D/g, '').slice(0, 4);
        timeInp.value = digits.length > 2 ? `${digits.slice(0, 2)}:${digits.slice(2)}` : digits;
      }
    });
    timeInp.addEventListener('change', () => {
      const resolved = resolveFlexibleTime(timeInp.value);
      if (resolved) save({ mode: 'endAt', endAtTime: resolved });
    });
    fieldRow.appendChild(timeInp);
  }
  host.appendChild(fieldRow);

  // Warning / overtime colours — the countdown recolours through these as it
  // runs down (last minute → warning, past zero → overtime). The base colour
  // is the timer text layer's own colour, edited on the canvas like any layer.
  const timerLayer = (resolveItemBaseLook(item)?.layers || []).find(l => l.binding === 'timer');
  const colorRow = document.createElement('div');
  colorRow.className = 'ts-prop-row';
  const warnLbl = document.createElement('span');
  warnLbl.className = 'ts-prop-label'; warnLbl.textContent = 'Warning';
  colorRow.appendChild(warnLbl);
  colorRow.appendChild(makeColor(params.warnColor || timerLayer?.warnColor || '#e8a64a',
    (v) => save({ warnColor: v })));
  const otLbl = document.createElement('span');
  otLbl.className = 'ts-prop-label'; otLbl.textContent = 'Overtime';
  otLbl.style.marginLeft = '10px';
  colorRow.appendChild(otLbl);
  colorRow.appendChild(makeColor(params.overtimeColor || timerLayer?.overtimeColor || '#e8404a',
    (v) => save({ overtimeColor: v })));
  host.appendChild(colorRow);

  // Scenes (segment.scenes — a storyboard, see segments.js) are managed
  // as real SLIDES in the Slides panel to the left now (renderItemSlidesList/
  // addTimerSlide) — one thumbnail per scene, click to edit its layers,
  // "+ Add Slide" to add another, a duration field right on each slide's
  // own row for "the player controls speed" — rather than a separate list
  // tucked away in here. This section used to hold that whole list.
  if (item.scenes && item.scenes.length) {
    const scenesNote = document.createElement('p');
    scenesNote.className = 'setting-hint';
    scenesNote.style.margin = '4px 0 0';
    scenesNote.textContent = `Playing ${item.scenes.length} slide${item.scenes.length === 1 ? '' : 's'} in sequence — manage them in the Slides panel to the left.`;
    host.appendChild(scenesNote);
  }

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
    // slide itself rather than in a separate list somewhere else.
    if (s.isScene) {
      const durRow = document.createElement('div');
      durRow.className = 'ts-item-slide-duration';
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
      if (s.isScene) {
        editGroup.push({ label: 'Duplicate', onClick: () => duplicateTimerScene(item, s.sceneIndex) });
      } else if (window.KairoService.canDuplicateSlide(item, s)) {
        editGroup.push({ label: 'Duplicate', onClick: () => window.KairoService.duplicateSlide(item, i) });
      }
      const selection = window.KairoService.selectedSlideIndices.size
        ? window.KairoService.selectedSlideIndices : new Set([i]);
      if (!s.isScene && window.KairoService.anySlidesDuplicable(item, selection)) {
        editGroup.push({
          label: selection.size > 1 ? `Copy ${selection.size} slides` : 'Copy',
          onClick: () => window.KairoService.copySlides(item, selection),
        });
      }
      if (!s.isScene && window.KairoService.slideClipboard && item.type === 'slides') {
        editGroup.push({ label: 'Paste', onClick: () => window.KairoService.pasteSlides(item, i) });
      }
      if (editGroup.length) sections.push(editGroup);
      // Delete was missing entirely from this menu — the Stack/Grid view's
      // own slide right-click (slideCard, service.js) already has it as
      // its own danger-styled section; this thumbnail list had nothing
      // beyond the scene case's small standalone X button, so a regular
      // (non-timer) slide couldn't be deleted from Full-scale edit's own
      // Slides panel at all without leaving to the Stack view first.
      if (s.isScene) {
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
    // override painting it always had.
    const look = s.isScene ? { layers: item.scenes[s.sceneIndex]?.layers || [] } : baseLook;
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
    addBtn.addEventListener('click', () => addTimerSlide(item));
    el.appendChild(addBtn);
  }
}

// A fresh slide starts with one full-bleed background layer and a
// centered Countdown, matching timer-big's own defaults — a real, visible
// starting point rather than a blank canvas with nothing to select. The
// operator's own Image Cycle layer(s)/captions get added from inside the
// slide editor the same way any theme's do (the "Cycle"/Text/Image
// buttons in Theme Studio's add-content bar).
function defaultSceneLayers() {
  return [
    { id: 'bg', type: 'background', name: 'Canvas', visible: true,
      fill: 'gradient', color: '#0b0b0f', opacity: 100, color2: '#1c1c30', angle: 160 },
    { id: 'timer', type: 'text', name: 'Countdown', visible: true, binding: 'timer', customText: '',
      pos: { x: 160, y: 380, w: 1600, h: 320 },
      font: { family: 'Manrope', size: 180, weight: 800, italic: false, lineHeight: 1, letterSpacing: 0, transform: 'none' },
      color: '#ffffff', opacity: 100, align: 'center',
      shadow: { ...TXT_SHADOW_SOFT }, outline: { ...NO_OUTLINE } },
  ];
}
function addTimerSlide(item) {
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
  item.scenes.push({ id: 'scene-' + (Date.now() + 1), name: `Slide ${item.scenes.length + 1}`, durationSec: 60, layers: defaultSceneLayers() });
  window.KairoService.saveTimerScenes(item);
  renderItemSlidesList();
  selectItemSlide(item.scenes.length - 1);
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

// Esc returns to the dashboard (unless a text field has focus). Item mode
// reuses this same modal, so route to its own close function instead.
document.addEventListener('keydown', (e) => {
  if (e.key !== 'Escape' || looksModal?.classList.contains('hidden')) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
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

// Chroma Key — one click to a solid, reliably-keyable green, same
// fillBefore round-trip as Transparent above. A distinct button rather
// than a third click-state on Transparent since they're genuinely
// different setups (see both buttons' own tooltips): this one just needs
// a normal solid-fill background layer, no OS-level window transparency
// involved at all, which is exactly why it works through a plain OBS/vMix
// Window Capture where Transparent does not.
document.getElementById('ts-chroma-toggle')?.addEventListener('click', () => {
  const bg = baseBgLayer();
  if (!bg) { toast('This theme has no background layer', 'error'); return; }
  if (isChromaCanvas()) {
    bg.fill = bg.fillBefore || 'solid';
    bg.color = bg.colorBefore || bg.color;
    delete bg.fillBefore;
    delete bg.colorBefore;
  } else {
    bg.fillBefore = bg.fill;
    bg.colorBefore = bg.color;
    bg.fill = 'solid';
    bg.color = CHROMA_KEY_COLOR;
  }
  syncMetaRow();
  up();
  renderProps();
});

// Transition (Fade/Slide/Cut + speed) moved from a per-theme setting here
// to a display-level one — see the Monitoring panel's own quick picker
// (service.js) and display.html's outputAnimation. activeLook.animation/
// animationSpeed are no longer read anywhere; left as harmless unused
// fields on already-saved themes rather than migrating every stored look
// just to strip them.

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

// Starts empty — the operator adds frames afterward from the Style tab's
// "Images" list (renderImageCycleProps) rather than picking a first file
// upfront, since a cycle only makes sense with 2+ images anyway. Defaults
// to the left 75% of the canvas (the requested pre-service split), sized
// like any other layer via Layout after — not locked to that split.
document.getElementById('ts-add-cycle-btn')?.addEventListener('click', () => {
  if (!activeLook) return;
  const layer = {
    id: 'cycle-' + Date.now(), type: 'image-cycle', name: 'Image Cycle',
    visible: true, sources: [], fit: 'cover', opacity: 100, radius: 0,
    pos: { x: 0, y: 0, w: Math.round(TS_DESIGN_W * 0.75), h: TS_DESIGN_H },
  };
  activeLook.layers.push(layer);
  activeLayer = layer;
  up();
  renderProps();
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
  activeLayer = null; multiSelectedLayerIds.clear();
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
// card as extra rows. PRIMARY_DISPLAY itself is declared near the top of
// the file now (see the comment there) — it has to exist before
// wireExternalDisplayStatus's IIFE runs at load.
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
  const prevValue = sel.value;
  sel.innerHTML = '';
  const noneOpt = document.createElement('option');
  noneOpt.value = '';
  noneOpt.textContent = 'None — don’t output here';
  sel.appendChild(noneOpt);
  cachedScreens.forEach(s => {
    const o = document.createElement('option');
    o.value = String(s.index);
    o.textContent = `${s.isPrimary ? 'This Mac’s screen' : 'Display ' + (s.index + 1)} — ${s.width}×${s.height}`;
    if (current && current.width === s.width && current.height === s.height &&
        current.left === s.left && current.top === s.top) o.selected = true;
    sel.appendChild(o);
  });
  // Keep whatever was selected a moment ago if it's still a valid option —
  // this runs on every 3s poll (see wireExternalDisplayOutput), so without
  // this the dropdown would silently reset selection out from under an
  // operator mid-interaction every time cachedScreens refreshes.
  if (prevValue && sel.querySelector(`option[value="${prevValue}"]`)) sel.value = prevValue;
}

// Picking a monitor here IS the action — no separate "enable" toggle, no
// "Open" button. Matches every other presentation app: select where it
// should go, and it goes there immediately. Selecting "None" closes
// whatever window was open for this output.
// Every "nothing happened" display-window bug this session traced back to
// a silent failure with zero error surface — a duck-typed cross-file
// guard failing quietly, a fallback nobody saw. This makes that class of
// failure visible in the debug log the moment it happens, instead of only
// once an operator reports "the display isn't working."
function logDisplayLifecycleFallback(where, detail) {
  // /api/debug-log only reads {event, data} off the body (see server.js) —
  // anything else silently gets dropped, which would have been a fittingly
  // ironic way for this exact hardening to go silent itself.
  fetch(`${SERVER}/api/debug-log`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'display-lifecycle-fallback', data: { where, ...detail } }),
  }).catch(() => {});
}

function buildScreenSelect(outputId) {
  const sel = document.createElement('select');
  sel.className = 'setting-input output-screen-select';
  populateScreenOptions(sel, outputId);
  sel.addEventListener('change', () => {
    // Real incident: `Number('')` evaluates to 0 in JS (not NaN) — the
    // "None — don't output here" option's own value IS '' (see
    // populateScreenOptions' noneOpt.value = ''), so selecting it silently
    // resolved to cachedScreens[0] (whatever monitor happens to be first
    // in the list — typically the operator's own main screen) instead of
    // "no screen at all". Owner: "display output is set to none, but it's
    // showing up on my machine." Explicit empty-string check first, rather
    // than trusting Number() to produce NaN for invalid input the way it
    // does for every OTHER non-numeric string.
    const s = sel.value === '' ? null : cachedScreens[Number(sel.value)];
    setOutputScreen(outputId, s ? { width: s.width, height: s.height, left: s.left, top: s.top } : null);
    if (typeof livePreviewOutputId !== 'undefined' && livePreviewOutputId === outputId) applyLivePreviewAspect();
    const label = `kairo-${outputId}`;
    if (s) {
      if (typeof openDisplayOutput === 'function') openDisplayOutput({ id: outputId, name: outputId });
    } else if (typeof closeDisplayWindow === 'function') {
      closeDisplayWindow(label);
    } else {
      logDisplayLifecycleFallback('buildScreenSelect', { outputId, reason: 'closeDisplayWindow not a function' });
    }
  });
  return sel;
}

// Inserted into #external-picker-row, alongside the theme picker
// (renderOutputThemePickers) — half-width each, see .output-picker-row.
function upsertPrimaryMonitorPicker() {
  const row = document.getElementById('external-picker-row');
  if (!row) return;
  let group = row.querySelector('.output-screen-group');
  if (!group) {
    group = document.createElement('div');
    group.className = 'setting-group output-screen-group';
    const lbl = document.createElement('label');
    lbl.className = 'setting-label';
    lbl.textContent = 'Output Display';
    group.appendChild(lbl);
    group.appendChild(buildScreenSelect(PRIMARY_DISPLAY));
    row.insertBefore(group, row.firstChild);
  } else {
    populateScreenOptions(group.querySelector('select'), PRIMARY_DISPLAY);
  }
}

// Briefly numbers just the monitor CURRENTLY SELECTED in the Output
// Display picker (not every connected screen) — this confirms "yes, this
// dropdown's choice really is that physical monitor" for the one output
// actually being configured, rather than a generic all-screens overview
// that doesn't say which number corresponds to which dropdown entry.
let identifyWindowsOpen = false;
document.getElementById('identify-displays-btn')?.addEventListener('click', async () => {
  if (identifyWindowsOpen) return;
  if (typeof openDisplayWindow !== 'function') {
    logDisplayLifecycleFallback('identify-displays-btn', { reason: 'openDisplayWindow not a function' });
    return;
  }
  const sel = document.querySelector('#external-picker-row .output-screen-select');
  const idx = sel ? Number(sel.value) : NaN;
  const s = Number.isInteger(idx) ? cachedScreens[idx] : null;
  if (!s) { toast('Select a display first', 'error'); return; }
  identifyWindowsOpen = true;
  const label = 'kairo-identify-0';
  await openDisplayWindow(
    label,
    `/identify.html?n=${idx + 1}&label=${encodeURIComponent(s.isPrimary ? 'This Mac’s screen' : `Display ${idx + 1}`)}`,
    { width: s.width, height: s.height, x: s.left, y: s.top, fullscreen: false }
  );
  setTimeout(() => {
    if (typeof closeDisplayWindow === 'function') closeDisplayWindow(label);
    else logDisplayLifecycleFallback('identify-displays-btn/auto-close', { label, reason: 'closeDisplayWindow not a function' });
    identifyWindowsOpen = false;
  }, 3000);
});

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
// Spoken language drives transcription; scripture language selects which
// text a detected/displayed verse shows in (server.js's applyScriptureLanguage,
// a real lookup against databases/bibles/packs/*.json — sourced 2026-09-13
// from public-domain/CC-BY-SA editions, real text, not placeholders).
//
// Important scope note, same honesty precedent as the old "Coming soon"
// this replaced: LIVE AUDIO DETECTION still only runs against the English
// KJV corpus — these packs change what a resolved reference DISPLAYS as,
// not what language the app listens for. A second language's own
// detection index (anchor trie, IDF map, embeddings) is real infrastructure
// that doesn't exist yet. `hasPack: true` means real bundled verse text;
// it does not mean "detects speech in this language."
const LANG_PACKS = [
  { code: 'en', name: 'English',    translations: 'KJV · NIV · NLT · ESV · NASB · NKJV', bundled: true },
  { code: 'es', name: 'Spanish',    translations: 'Reina-Valera 1909 (public domain)', hasPack: true },
  { code: 'pt', name: 'Portuguese', translations: 'Almeida Atualizada 1911 (GPL)', hasPack: true },
  { code: 'fr', name: 'French',     translations: 'Louis Segond 1910 (public domain)', hasPack: true },
  { code: 'de', name: 'German',     translations: 'Luther 1545 (public domain)', hasPack: true },
  { code: 'yo', name: 'Yoruba',     translations: 'Bíbélì Mímọ́ (Biblica, CC BY-SA 4.0)', hasPack: true },
  { code: 'ig', name: 'Igbo',       translations: 'Baịbụl Nsọ (Biblica, CC BY-SA 4.0)', hasPack: true },
  { code: 'ha', name: 'Hausa',      translations: 'Littafi Mai Tsarki (Biblica, CC BY-SA 4.0)', hasPack: true },
  { code: 'sw', name: 'Swahili',    translations: 'New Testament only (public domain)', hasPack: true },
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
    } else if (p.hasPack) {
      // Real verse text now, bundled in the app (databases/bibles/packs/,
      // sourced 2026-09-13 — see LANG_PACKS' own comment for exactly what
      // this does and doesn't cover) rather than a remote download, so
      // there's no real fetch to wait on — "installing" just switches it
      // on locally. Still true, and still worth saying out loud: live
      // audio DETECTION stays English-only; this only changes what a
      // resolved verse displays as.
      btn.textContent = 'Install';
      btn.title = 'Adds real verse text for this language. Live audio detection still only listens for English.';
      btn.addEventListener('click', () => {
        settings.installedLangs = [...new Set([...installed, p.code])];
        saveSettingsPatch({ installedLangs: settings.installedLangs });
        renderLangPacks();
      });
    } else {
      // No real source found/verified for this language yet — be honest
      // rather than showing a button that would just fail or fake it.
      btn.textContent = 'Coming soon';
      btn.disabled = true;
      btn.title = 'No verified scripture-text source found for this language yet.';
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
  upsertPrimaryMonitorPicker();

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

      // buildScreenSelect's own change handler opens/moves/closes the
      // window immediately — no separate "Open" button needed, same as
      // the primary External Display picker.
      const screenSel = buildScreenSelect(d.id);

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

      row.appendChild(name); row.appendChild(sel); row.appendChild(screenSel); row.appendChild(del);
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
// Populates cachedScreens (read by populateScreenOptions/buildScreenSelect
// for the monitor pickers). Real incident: this used to bail out entirely
// via an early `if (!hint) return` guarding a status-text element that got
// deleted from the External Display card during its redesign to the
// monitor-picker layout — cachedScreens silently never populated again,
// no error anywhere, the picker just always showed "None" regardless of
// how many real displays were connected. Removed the dependency outright
// rather than re-adding UI the new minimal design doesn't need — the
// header status dot/text and the picker's own option list already say
// everything this used to render into a separate hint line.
async function refreshDisplayStatus() {
  // Real OS-level enumeration first — the Window Management API
  // (getScreenDetails/isExtended) this used to rely on exclusively is
  // Chromium-only and WebKit has never implemented it, so it silently
  // never detected anything in the packaged macOS app (see list_monitors
  // in src-tauri/src/lib.rs for the full story). Only fall back to the
  // web APIs when not running inside Tauri at all (e.g. testing app.js
  // directly in a plain browser tab).
  const tauriInvoke = window.__TAURI__?.core?.invoke || window.__TAURI__?.invoke;
  let detected = null;
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
    } catch { /* permission denied — leave cachedScreens as last known */ }
  }
}

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
    const label = `kairo-${d.id}`;
    openDisplayWindow(label, url, { width: w, height: h, x, y, fullscreen: true });
    verifyDisplayWindowOpened(label);
  } else {
    // This exact fallback — silently opening the system browser instead
    // of a real positioned output window — was the actual root cause
    // behind an entire session of "nothing sends to the display" reports
    // (openDisplayWindow existed but wasn't attached to `window` yet).
    // The underlying bug is fixed, but the fallback itself still needs to
    // never be silent again if it's ever hit for some other reason.
    logDisplayLifecycleFallback('openDisplayOutput', { outputId: d.id, reason: 'openDisplayWindow not a function — falling back to window.open()' });
    window.open(url, `kairo-${d.id}`, `width=${w},height=${h},left=${x},top=${y}`);
  }
}

// A targeted assertion on exactly the operation that broke 5 times this
// session, not a general health-check subsystem: give the window a
// second to actually come up, then confirm it did. Every prior bug here
// left an operator finding out mid-service, from an empty screen, that
// nothing had actually opened — this surfaces it immediately instead.
async function verifyDisplayWindowOpened(label) {
  const getWin = window.__TAURI__?.webviewWindow?.WebviewWindow;
  if (!getWin) return; // not running inside Tauri (plain dev preview) — nothing to verify
  await new Promise(r => setTimeout(r, 1000));
  try {
    const win = await getWin.getByLabel(label);
    const visible = win ? await win.isVisible().catch(() => null) : null;
    if (!win || visible === false) {
      logDisplayLifecycleFallback('verifyDisplayWindowOpened', { label, exists: !!win, visible });
      toast('Display window may not have opened — check the monitor picker in Settings', 'error');
    }
  } catch (err) {
    logDisplayLifecycleFallback('verifyDisplayWindowOpened threw', { label, error: String(err) });
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
      // External Display pairs its theme picker half-width with the
      // monitor picker (populateMonitorPicker) instead of taking the full
      // card width on its own row — both live in #external-picker-row.
      const pickerRow = document.getElementById('external-picker-row');
      if (card === 'card-external' && pickerRow) pickerRow.appendChild(group);
      else body.insertBefore(group, body.firstChild);
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

  // File > Import's chooser — see the comment on the 'menu-import' listener
  // below and #import-options-modal in index.html. Each row just hands off
  // to a flow that already exists and is already tested (the Slides add-
  // menu's quick file/clipboard import, and Theme Studio's own importer),
  // this is only ever the front door that picks which one "Import" meant.
  const importOptionsModal = document.getElementById('import-options-modal');
  function openImportOptionsModal() { importOptionsModal?.classList.remove('hidden'); }
  function closeImportOptionsModal() { importOptionsModal?.classList.add('hidden'); }
  document.getElementById('close-import-options')?.addEventListener('click', closeImportOptionsModal);
  importOptionsModal?.querySelector('.modal-overlay')?.addEventListener('click', closeImportOptionsModal);

  const triggerQuickFile = (destination) => {
    const input = document.getElementById('quick-import-file');
    if (input) { input.dataset.destination = destination; input.click(); }
  };
  document.getElementById('import-opt-file')?.addEventListener('click', () => {
    closeImportOptionsModal();
    triggerQuickFile('playlist');
  });
  document.getElementById('import-opt-clipboard')?.addEventListener('click', () => {
    closeImportOptionsModal();
    window.KairoService?.quickImportClipboard?.('playlist');
  });
  document.getElementById('import-opt-song')?.addEventListener('click', () => {
    closeImportOptionsModal();
    triggerQuickFile('library');
  });
  document.getElementById('import-opt-theme')?.addEventListener('click', () => {
    closeImportOptionsModal();
    clickWhenReady('import-look-btn');
  });
  window.__TAURI__.event.listen('menu-new-theme',     () => clickWhenReady('new-look-btn'));
  // File > Import used to go straight to clickWhenReady('import-look-btn')
  // — silently jumping into Theme Studio's own theme importer, with nothing
  // telling the operator that's what "Import" even meant. Import is almost
  // always about CONTENT (slides/a song), not a theme file, so this now
  // opens a small chooser instead of guessing — see #import-options-modal.
  window.__TAURI__.event.listen('menu-import',        () => openImportOptionsModal());
  window.__TAURI__.event.listen('menu-export-theme',  () => clickWhenReady('export-look-btn'));
  // KAIRO > Settings… (Cmd+,) — same panel the toolbar gear icon opens.
  window.__TAURI__.event.listen('menu-settings',      () => { settingsModal?.classList.remove('hidden'); showFirstSettingsPane(); });

  // Controls menu — every item here is just a click on an existing
  // dashboard button (see src-tauri/src/lib.rs's controls_menu), no modal
  // to open first, unlike the Theme Studio items above.
  const clickDirect = (btnId) => document.getElementById(btnId)?.click();
  window.__TAURI__.event.listen('menu-toggle-listening', () => clickDirect('listen-btn'));
  window.__TAURI__.event.listen('menu-range-next',       () => clickDirect('range-next-btn'));
  window.__TAURI__.event.listen('menu-range-end',        () => clickDirect('range-clear-btn'));
  window.__TAURI__.event.listen('menu-clear-slide',      () => clickDirect('clear-slide-layer-btn'));
  window.__TAURI__.event.listen('menu-clear-media',      () => clickDirect('clear-media-layer-btn'));
  window.__TAURI__.event.listen('menu-clear-timer',      () => clickDirect('clear-timer-layer-btn'));
  window.__TAURI__.event.listen('menu-clear-all',        () => clickDirect('clear-all-layers-btn'));
})();

// ── Remappable in-app hotkeys ───────────────────────────────────────────
// Independent of the native menu's own accelerators (src-tauri/src/lib.rs)
// — those are fixed OS-level defaults and never change; this is a
// separate, operator-customizable layer for the same action set,
// persisted as a plain {actionId: comboString} map in settings.hotkeys
// via the existing saveSettingsPatch. Same actions the Controls menu
// drives, on purpose — one list, two independent ways to trigger it.
const HOTKEY_ACTIONS = [
  { id: 'toggle-listening', label: 'Start/Stop Listening', btnId: 'listen-btn',            default: 'cmd+l' },
  { id: 'range-next',       label: 'Next',                 btnId: 'range-next-btn',        default: 'cmd+arrowright' },
  { id: 'range-end',        label: 'End Range',            btnId: 'range-clear-btn',       default: '' },
  { id: 'clear-slide',      label: 'Clear Slide',          btnId: 'clear-slide-layer-btn', default: 'cmd+k' },
  { id: 'clear-media',      label: 'Clear Media',          btnId: 'clear-media-layer-btn', default: '' },
  { id: 'clear-timer',      label: 'Clear Timer',          btnId: 'clear-timer-layer-btn', default: '' },
  { id: 'clear-all',        label: 'Clear All',            btnId: 'clear-all-layers-btn',  default: 'cmd+shift+k' },
];

function hotkeyFor(actionId) {
  const action = HOTKEY_ACTIONS.find(a => a.id === actionId);
  const stored = settings.hotkeys?.[actionId];
  return stored !== undefined ? stored : (action?.default || '');
}

// Normalized as ctrl+alt+shift+cmd+<key>, always that modifier order, key
// lowercased — capture and lookup both go through this so they can never
// silently disagree on formatting.
function comboFromEvent(e) {
  const parts = [];
  if (e.ctrlKey) parts.push('ctrl');
  if (e.altKey) parts.push('alt');
  if (e.shiftKey) parts.push('shift');
  if (e.metaKey) parts.push('cmd');
  const key = e.key.toLowerCase();
  if (!['control', 'alt', 'shift', 'meta'].includes(key)) parts.push(key);
  return parts.join('+');
}

const COMBO_SYMBOLS = { cmd: '⌘', shift: '⇧', alt: '⌥', ctrl: '⌃', arrowright: '→', arrowleft: '←', arrowup: '↑', arrowdown: '↓' };
function comboDisplay(combo) {
  if (!combo) return 'Not set';
  return combo.split('+').map(p => COMBO_SYMBOLS[p] || p.toUpperCase()).join('');
}

let capturingHotkeyId = null;

function renderHotkeysList() {
  const host = document.getElementById('hotkeys-list');
  if (!host) return;
  host.innerHTML = '';
  HOTKEY_ACTIONS.forEach(action => {
    const combo = hotkeyFor(action.id);
    const row = document.createElement('div');
    row.className = 'lang-pack-row';
    row.innerHTML = `<div class="lang-pack-meta"><div class="lang-pack-name">${escapeHtml(action.label)}</div>` +
      `<div class="lang-pack-sub">${escapeHtml(comboDisplay(combo))}</div></div>`;
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;gap:6px;';
    const changeBtn = document.createElement('button');
    changeBtn.className = 'modal-btn secondary';
    changeBtn.textContent = 'Change';
    changeBtn.addEventListener('click', () => startHotkeyCapture(action.id, changeBtn));
    actions.appendChild(changeBtn);
    if (combo) {
      const clearBtn = document.createElement('button');
      clearBtn.className = 'modal-btn secondary';
      clearBtn.textContent = 'Clear';
      clearBtn.addEventListener('click', () => saveHotkey(action.id, ''));
      actions.appendChild(clearBtn);
    }
    row.appendChild(actions);
    host.appendChild(row);
  });
}

function startHotkeyCapture(actionId, btn) {
  if (capturingHotkeyId) return; // one capture at a time
  capturingHotkeyId = actionId;
  const original = btn.textContent;
  btn.textContent = 'Press keys… (Esc cancels)';
  const onKey = (e) => {
    e.preventDefault(); e.stopPropagation();
    if (e.key === 'Escape') { finish(); return; }
    if (['Control', 'Alt', 'Shift', 'Meta'].includes(e.key)) return; // a bare modifier isn't a combo yet
    saveHotkey(actionId, comboFromEvent(e));
    finish();
  };
  function finish() {
    document.removeEventListener('keydown', onKey, true);
    capturingHotkeyId = null;
    renderHotkeysList();
  }
  // Captured on the way down (capture:true), ahead of anything else on
  // the page, so recording a shortcut never also fires whatever it's
  // about to be bound to.
  document.addEventListener('keydown', onKey, true);
}

async function saveHotkey(actionId, combo) {
  settings.hotkeys = { ...(settings.hotkeys || {}), [actionId]: combo };
  await saveSettingsPatch({ hotkeys: settings.hotkeys });
  renderHotkeysList();
}

// Global dispatcher. Skips text inputs (typing "l" shouldn't toggle
// listening) and gets out of the way entirely while a new combo is being
// recorded — startHotkeyCapture's own capture-phase listener already
// claims the keydown first in that case, but the guard here is cheap
// insurance against ever double-firing on the same keystroke.
document.addEventListener('keydown', (e) => {
  if (capturingHotkeyId) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  const combo = comboFromEvent(e);
  if (!combo) return;
  const action = HOTKEY_ACTIONS.find(a => hotkeyFor(a.id) === combo);
  if (!action) return;
  e.preventDefault();
  document.getElementById(action.btnId)?.click();
});

renderHotkeysList();

// ═══════════════════════════════════════════════════════════════════════════
// TRIGGERS — dispatch into the Timer tab (server/triggers.js, service.js)
//   The actual UI lives in service.js as a top-bar tab (segment cards,
//   see showTimerLibrary/onTimerAction) — this just forwards the two
//   built-in trigger types' broadcasts there, same bridge pattern as
//   'media-status'/'media-folder-changed' above.
// ═══════════════════════════════════════════════════════════════════════════
registerActionHandler('stage-timer',   (msg) => window.KairoService?.onTimerAction?.(msg));
registerActionHandler('clock-message', (msg) => window.KairoService?.onClockAction?.(msg));

// ── Startup bootstrap ───────────────────────────────────────────────────────
// Runs behind the branded #bootstrap-overlay before the operator touches the
// app:
//   1. Requests microphone permission up front (so the OS prompt appears at
//      launch, not mid-service when they hit Start).
//   2. Downloads required resources — the offline speech model — when the
//      offline engine is selected and it isn't present yet, with progress.
// Always resolves (and always removes the overlay) so a slow/failed step can
// never trap the operator on the loading screen.
//
// This briefly went through a "remove the overlay, it's redundant with the
// native splash.html window" pass — wrong call, corrected right after. Owner:
// "I wanted to retain the full large one with the brand mark and logo." The
// native window (since removed entirely, see src-tauri/src/lib.rs) was a
// small 440x300 fixed-size window, not this large full-page treatment — they
// were never really the same screen. This overlay is the app's one splash now.
async function bootstrapStartup() {
  const overlay = document.getElementById('bootstrap-overlay');
  const finish = () => {
    if (overlay) { overlay.classList.add('done'); setTimeout(() => overlay.remove(), 500); }
  };
  // Hard safety valve — never keep the overlay up longer than 90s.
  const safety = setTimeout(finish, 90000);
  // Minimum time the brand lockup stays on screen. Without this the overlay
  // could disappear well under a second after launch (mic permission already
  // granted, deepgram engine needs no offline-model download) — too fast to
  // actually register the brand mark/wordmark that's the whole point of this
  // screen. Real startup work below still happens at its own pace; this only
  // holds the screen on a little longer, never makes it wait longer than it
  // already would.
  const MIN_DISPLAY_MS = 8500;
  const startedAt = Date.now();

  try {
    // 1) Microphone permission
    try {
      const s = await navigator.mediaDevices.getUserMedia({ audio: true });
      s.getTracks().forEach(t => t.stop());
    } catch { /* denied or unavailable — app still works; user can grant later */ }

    // 2) Required resources — offline model when the offline engine is chosen
    let engine = 'deepgram';
    try {
      const r = await fetch(`${SERVER}/api/settings`);
      if (r.ok) { const s = await r.json(); engine = (s.speechEngine || 'deepgram').toLowerCase(); }
    } catch {}

    if (engine === 'offline' || engine === 'browser') {
      try {
        const st = await (await fetch(`${SERVER}/api/whisper/status`)).json();
        if (!st.installed) {
          fetch(`${SERVER}/api/whisper/install`, { method: 'POST' }).catch(() => {});
          for (let i = 0; i < 600; i++) {          // up to ~10 min — the offline (sherpa-onnx) model is a sizable download
            await new Promise(r => setTimeout(r, 1000));
            const s2 = await (await fetch(`${SERVER}/api/whisper/status`)).json().catch(() => ({}));
            if (s2.installed) break;
          }
        }
      } catch { /* model status unavailable — proceed; Start will surface any real error */ }
    }

    const elapsed = Date.now() - startedAt;
    if (elapsed < MIN_DISPLAY_MS) await new Promise(r => setTimeout(r, MIN_DISPLAY_MS - elapsed));
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
wireRangeSliders();
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
