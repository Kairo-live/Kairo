// KAIRO v2 — Frontend App
// Communicates with the Node.js server via WebSocket (live events)
// and fetch (commands). No Electron IPC.
'use strict';

// The frontend is served BY the Node sidecar, so window.location is always
// the right origin — no need to hardcode the port. Tauri picks a free port
// at launch and may not be 7777.
const SERVER = `${location.protocol}//${location.host}`;
const WS_URL = `${location.protocol === 'https:' ? 'wss:' : 'ws:'}//${location.host}`;

// The id of Kairo's one non-removable output. Declared first because boot-time
// code (app_startup.js's wireExternalDisplayStatus, the outputs code in
// app_outputs.js) reads it — referencing a `const` before its declaration line
// has run throws, which once silently killed the "auto-reopen display on
// launch" feature on every launch.
const PRIMARY_DISPLAY = 'display-1';

// Auth token shared between Tauri and the Node sidecar. Fetched once at boot
// via Tauri IPC, then injected into every fetch (Authorization header) and
// WebSocket URL (?token=…). In a non-Tauri context (e.g. opening index.html
// in a stock browser during dev) the IPC call fails and we run unauthenticated
// — the server also treats auth as optional when its env var is absent.

// Wrap fetch so every call automatically carries the token. All existing
// `fetch(${SERVER}/api/...)` call sites work unchanged.
const _origFetch = window.fetch.bind(window);
window.fetch = (input, init = {}) => {
  if (!AUTH_TOKEN) return _origFetch(input, init);
  const headers = new Headers(init.headers || (typeof input !== 'string' && input?.headers) || {});
  if (!headers.has('Authorization')) headers.set('Authorization', `Bearer ${AUTH_TOKEN}`);
  return _origFetch(input, { ...init, headers });
};


// ── Helpers ────────────────────────────────────────────────────────────────

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
const AUDIO_SILENCE_WARN_MS = 45000;   // an ordinary pause must not flash "No audio!"
const AUDIO_PEAK_NOISE_FLOOR = 50; // int16 units — well above dither/pure-zero, well below real speech (typically 2000-18000 in this app's own logged peaks)
let workerReady    = false;
let settings       = {};
// True once loadSettings() has actually populated `settings` from the
// server at least once. loadSettings() only runs inside ws.onopen (after
// auth + the WebSocket connects), so `settings` stays `{}` for a real
// stretch of app startup — code that reads settings-derived state (like
// wireExternalDisplayStatus's auto-reopen, in app_startup.js) must wait for
// this, not just for its own script line to run. See that IIFE's own comment
// for the real incident this flag fixes.
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
const settingsBtn        = document.getElementById('settings-btn');
const settingsModal      = document.getElementById('settings-modal');
const closeSettingsBtn   = document.getElementById('close-settings');
const cancelSettingsBtn  = document.getElementById('cancel-settings');
const saveSettingsBtn    = document.getElementById('save-settings');
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


const currentDisplayCard = document.getElementById('current-display-card');
const queueList          = document.getElementById('queue-list');
const suggestionCount    = document.getElementById('suggestion-count');

// Search
const scriptureSearchInput = document.getElementById('scripture-search-input');
const scriptureSearchClear = document.getElementById('scripture-search-clear');
const translationSelect    = document.getElementById('translation-select');
const bibleTranslateToSelect = document.getElementById('bible-translate-to-select');

// Settings inputs
const deepgramKeyInput    = document.getElementById('deepgram-key');
const translationSettings = document.getElementById('translation-select-settings');
const showConfSettings    = document.getElementById('show-confidence-settings');
const audioSourceSettings = document.getElementById('audio-source-settings');
const refreshDevicesBtn   = document.getElementById('refresh-devices-settings');
// OBS's own fields (URL/password/text-source/enable/test) are built
// dynamically now, inside the Outputs master-detail redesign's OBS detail
// panel (renderObsDetail) — see testObsConnection's own comment for why a
// fixed obs-status/test-obs-btn id no longer makes sense.

// ── WebSocket ──────────────────────────────────────────────────────────────
function connectWS() {
  if (ws && ws.readyState < 2) return;
  ws = new WebSocket(authedWsUrl(WS_URL));

  ws.onopen = () => {
    console.log('[WS] Connected');
    clearTimeout(wsReconnectTimer);
    wsReconnectAttempts = 0;
    flushPendingAudio();   // audio captured while this socket was reconnecting
    loadSettings();
    initCustomSelects();
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

    case 'range-state':
      handleRangeState(msg);
      break;

    case 'layer-state':
      handleLayerState(msg);
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
      if (msg.layer === 'slide' || msg.layer === 'all') clearPreviewScreen();
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
    if (listenText && !isListening) listenText.textContent = 'Connecting…';
    if (lsBcastLbl) lsBcastLbl.textContent = 'Connecting…';
  } else if (state === 'reconnecting') {
    // The server re-establishing Deepgram mid-session. The listening session
    // is still on: keep the microphone running (the server holds and replays
    // the audio). Only Stop — or a fatal error — ends it.
    if (lsBcastLbl) lsBcastLbl.textContent = 'Reconnecting…';
  }
}

// ── Transcript ─────────────────────────────────────────────────────────────
let transcriptDiv = null;
let interimSpan   = null;

// Brand-color highlighting for scripture references inside the raw transcript
// text — "so users can see in one glance the scripture called" (owner). Deliberately
// a lightweight client-side pattern match on digit-form citations ("John 3:16",
// "Genesis 24"), not a call into the real spoken-reference parser (server-side
// only, and tuned for noisy ASR word forms like "chapter three verse sixteen") —
// this is a glanceable visual aid over the live words, not a second detection
// path; the actual detection/auto-send pipeline is entirely unaffected by it.
const SCRIPTURE_NUMBERED_BOOKS = ['Samuel', 'Kings', 'Chronicles', 'Corinthians', 'Thessalonians', 'Timothy', 'Peter'];
const SCRIPTURE_PLAIN_BOOKS = [
  'Song of Solomon',
  'Genesis', 'Exodus', 'Leviticus', 'Numbers', 'Deuteronomy', 'Joshua', 'Judges', 'Ruth',
  'Ezra', 'Nehemiah', 'Esther', 'Job', 'Psalms', 'Psalm', 'Proverbs', 'Ecclesiastes',
  'Isaiah', 'Jeremiah', 'Lamentations', 'Ezekiel', 'Daniel', 'Hosea', 'Joel', 'Amos',
  'Obadiah', 'Jonah', 'Micah', 'Nahum', 'Habakkuk', 'Zephaniah', 'Haggai', 'Zechariah', 'Malachi',
  'Matthew', 'Mark', 'Luke', 'John', 'Acts', 'Romans', 'Galatians', 'Ephesians',
  'Philippians', 'Colossians', 'Titus', 'Philemon', 'Hebrews', 'James',
  'Jude', 'Revelation', 'Revelations',
];
const SCRIPTURE_REF_RE = new RegExp(
  `\\b(?:(?:1st|2nd|3rd|First|Second|Third|[123])\\s+(?:${SCRIPTURE_NUMBERED_BOOKS.join('|')}|John)|${SCRIPTURE_PLAIN_BOOKS.join('|')})` +
  `\\s+\\d{1,3}(?::\\d{1,3}(?:[-–]\\d{1,3})?)?\\b`,
  'g'
);
function escapeHtml(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
// Escape FIRST, then match/wrap on the escaped string — book names and digits
// are untouched by HTML-escaping, so matches are identical either way, and this
// ordering means the highlight spans are never built from unescaped raw text.
function highlightScriptureRefs(text) {
  return escapeHtml(text).replace(SCRIPTURE_REF_RE, (m) => `<span class="transcript-ref">${m}</span>`);
}

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
// "Stick to bottom" threshold — an operator scrolling up mid-service to
// review something they might have missed used to get yanked straight back
// to the bottom by the very next interim update (several times a second
// during continuous speech), making manual review impossible. Only force-
// scroll when they were already at/near the bottom (i.e. actually
// following along), same pattern any chat/log UI needs.
const TRANSCRIPT_SCROLL_STICK_PX = 40;
function isTranscriptAtBottom() {
  if (!transcriptContent) return true;
  return transcriptContent.scrollHeight - transcriptContent.scrollTop - transcriptContent.clientHeight <= TRANSCRIPT_SCROLL_STICK_PX;
}
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
  // Checked BEFORE any DOM mutation below — appending content grows
  // scrollHeight regardless of where the operator's scrolled to, so this
  // has to reflect whether they were following along prior to this
  // update, not be skewed by how much new content just arrived.
  const wasAtBottom = isTranscriptAtBottom();
  if (msg.isFinal) {
    const span = document.createElement('span');
    span.className = 'transcript-final';
    span.innerHTML = highlightScriptureRefs(msg.text) + ' ';
    if (interimSpan) transcriptDiv.insertBefore(span, interimSpan);
    else transcriptDiv.appendChild(span);
    if (interimSpan) interimSpan.textContent = '';
    const finals = transcriptDiv.querySelectorAll('.transcript-final');
    if (finals.length > TRANSCRIPT_LOG_MAX_SPANS) {
      for (let i = 0; i < finals.length - TRANSCRIPT_LOG_MAX_SPANS; i++) finals[i].remove();
    }
    // Capture for Content Studio — finals only, never interim drafts.
    sessionTranscriptParts.push({ time: new Date().toLocaleTimeString(), at: Date.now(), text: msg.text });
    wordCount += msg.text.split(/\s+/).length;
    if (wordCountEl) wordCountEl.textContent = wordCount.toLocaleString();
    // Auto-scroll — only if the operator was already following along.
    if (wasAtBottom) scheduleTranscriptScroll();
  } else {
    if (interimSpan) { interimSpan.innerHTML = highlightScriptureRefs(msg.text); interimSpan.style.opacity = '0.5'; }
    if (wasAtBottom) scheduleTranscriptScroll();
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

  // Back (server screenBack) re-sends what was on screen before: repaint and
  // move its card back to the top, without counting it as a new send.
  if (msg.restoredByBack) {
    const v = verses[0];
    renderPreviewScreen(cleanVerseText(v.text), v.reference, look, v.translatedText || '', v.image || null, v.fit || 'contain', v.slideStyle || {}, v.timerText || '', v.label || '');
    const card = currentDisplayCard?.querySelector(`[data-ref="${CSS.escape(v.reference || '')}"]`);
    if (card && card !== currentDisplayCard.firstChild) currentDisplayCard.insertBefore(card, currentDisplayCard.firstChild);
    return;
  }

  if (target === 'viewer' && (topScore == null || topScore >= CLIENT_VIEWER_MIN_SCORE)) {
    showInViewer(verses, method, topScore, correctedFrom, look);
    if (method !== 'service') noteTranscriptSend(verses[0].reference);
  } else {
    showInSuggestions(verses, method);
  }
}

// ── Transcript log: which words sent which verse ────────────────────────────
// A small chip after the line being spoken when a verse went up; double-click
// any line to search it (a miss is usually right there in the words).
function noteTranscriptSend(reference) {
  if (!transcriptDiv || !reference) return;
  const finals = transcriptDiv.querySelectorAll('.transcript-final');
  const line = finals[finals.length - 1];
  if (!line || line.querySelector(`.transcript-sent-chip[data-ref="${CSS.escape(reference)}"]`)) return;
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'transcript-sent-chip';
  chip.dataset.ref = reference;
  chip.title = `Send ${reference} to the screen`;
  chip.textContent = `→ ${reference}`;
  chip.addEventListener('click', (e) => { e.stopPropagation(); sendReferenceToScreen(reference); });
  line.appendChild(chip);
}

// Send a verse by reference: through its Live Queue card when it's there
// (the same path as that card's Send), otherwise by looking it up.
function sendReferenceToScreen(reference) {
  const card = currentDisplayCard?.querySelector(`[data-ref="${CSS.escape(reference)}"] .lvc-send-btn`);
  if (card) { card.click(); return; }
  fetch(`${SERVER}/api/search`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query: reference }),
  }).catch(err => console.warn('[KAIRO] Send failed:', err.message));
}
document.addEventListener('dblclick', (e) => {
  if (e.target.closest?.('.transcript-sent-chip')) return;
  const line = e.target.closest?.('.transcript-final');
  if (!line || !scriptureSearchInput) return;
  // textContent alone would also pull in the sent-chip's "→ Reference" label;
  // strip it from a clone rather than filtering to text nodes only, since a
  // highlighted .transcript-ref span (see highlightScriptureRefs) is itself an
  // element node and would otherwise be silently dropped from the search text.
  const clone = line.cloneNode(true);
  clone.querySelectorAll('.transcript-sent-chip').forEach(el => el.remove());
  const words = clone.textContent
    .split(/\s+/).filter(Boolean).slice(-14).join(' ');
  if (!words) return;
  window.getSelection?.()?.removeAllRanges();
  scriptureSearchInput.value = words;
  scriptureSearchInput.focus();
  scriptureSearchInput.dispatchEvent(new Event('input', { bubbles: true }));
});

// Render the live preview screen. A sent item can carry its own theme (e.g. a
// ProPresenter import via Send/Flow) — when it does, paint it with the exact
// same layer renderer the playlist editor uses instead of the generic plain
// text, so the operator sees what the audience is actually about to see.
// Anything with no per-item theme (ordinary scripture detections/search-sends,
// or a playlist item explicitly left on "Output default") falls back to the
// primary output's assigned theme — the same fallback display.html already
// does for the real output window, so this preview stays truthful to it
// instead of always showing plain text regardless of that assignment.
// Reference+text of what the preview last painted (not reference alone — slides
// items deliberately carry an empty reference, which used to collapse to the
// same falsy key for every slide). renderPreviewScreen skips an identical repaint.
let lastPreviewKey = null;
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
// 'main' is the composite — every layer in order (media, slide, Bible, timer)
// with the primary display's look; any other value is one real output.
let livePreviewOutputId = 'main';

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
  const s = (typeof outputScreenMap === 'function') ? outputScreenMap()[livePreviewOutputId === 'main' ? PRIMARY_DISPLAY : livePreviewOutputId] : null;
  el.style.aspectRatio = s ? `${s.width} / ${s.height}` : '';
}

// ── Monitor: what each output is actually showing ─────────────────────────
// The dropdown and the grid list Main plus every output that's ON (an output
// that's off shows nothing, so it isn't monitored). Main is the operator's own
// composite preview (#slide-preview). A specific output is shown by a live copy
// of that output's real page — display.html?output=<id>&monitor=1, the exact
// page its screen runs, so its theme and its own layers (e.g. a screen that
// only carries the timer) are what you see — rendered at the output's real
// resolution and scaled down. Picking a tile in the grid, or an entry in the
// dropdown, shows that one output alone.
const MONITOR_MAIN = { id: 'main', type: 'main', name: 'Main' };

function monitorTargets() {
  const outputs = (typeof allConfiguredOutputs === 'function') ? allConfiguredOutputs() : [];
  const on = outputs.filter(o => o.type !== 'obs' && (typeof isOutputEnabled !== 'function' || isOutputEnabled(o)));
  return [MONITOR_MAIN, ...on];
}

// The output's real resolution — what its page lays itself out for.
function monitorResolution(o) {
  if (o.type === 'display' || o.type === 'main') {
    const scr = (typeof outputScreenMap === 'function') ? outputScreenMap()[o.type === 'main' ? PRIMARY_DISPLAY : o.id] : null;
    if (scr?.width && scr?.height) return { w: scr.width, h: scr.height };
  }
  if (o.raw?.width && o.raw?.height) return { w: o.raw.width, h: o.raw.height };
  return { w: 1920, h: 1080 };
}

// A scaled live copy of one output. Rebuilt only when the output (or its
// resolution) changes, so it isn't reloaded on every refresh.
const _monitorScaleObservers = new WeakMap();
function buildMonitorFrame(o) {
  const { w, h } = monitorResolution(o);
  const box = document.createElement('div');
  box.className = 'monitor-frame';
  box.style.aspectRatio = `${w} / ${h}`;
  box.dataset.key = `${o.id}|${w}x${h}`;
  const frame = document.createElement('iframe');
  frame.src = `/display.html?output=${encodeURIComponent(o.type === 'main' ? 'main' : o.id)}&monitor=1`;
  frame.title = `${o.name} — live`;
  frame.setAttribute('tabindex', '-1');
  frame.style.width = `${w}px`;
  frame.style.height = `${h}px`;
  box.appendChild(frame);
  const ro = new ResizeObserver(() => { frame.style.transform = `scale(${box.clientWidth / w})`; });
  ro.observe(box);
  _monitorScaleObservers.set(box, ro);
  return box;
}

function renderLivePreviewOutputSelect() {
  const sel = document.getElementById('live-preview-output-select');
  if (!sel) return;
  const targets = monitorTargets();
  if (!targets.some(t => t.id === livePreviewOutputId)) livePreviewOutputId = 'main';
  sel.innerHTML = '';
  targets.forEach(t => {
    const opt = document.createElement('option');
    opt.value = t.id; opt.textContent = t.name;
    if (t.id === livePreviewOutputId) opt.selected = true;
    sel.appendChild(opt);
  });
  applyLivePreviewAspect();
  showMonitorSelection();
  if (monitorGridActive) renderMonitorGrid();
}

// Single view: Main -> the composite preview; an output -> its live copy.
function disposeMonitorFrames(container) {
  container?.querySelectorAll('.monitor-frame').forEach(box => { _monitorScaleObservers.get(box)?.disconnect(); });
}

function showMonitorSelection() {
  const single = document.getElementById('slide-preview');
  const host = document.getElementById('monitor-single');
  if (!single || !host) return;
  const target = monitorTargets().find(t => t.id === livePreviewOutputId) || MONITOR_MAIN;
  const isMain = target.id === 'main';
  single.classList.toggle('hidden', monitorGridActive || !isMain);
  host.classList.toggle('hidden', monitorGridActive || isMain);
  if (isMain) { disposeMonitorFrames(host); host.replaceChildren(); return; }
  const { w, h } = monitorResolution(target);
  if (host.firstChild?.dataset.key !== `${target.id}|${w}x${h}`) { disposeMonitorFrames(host); host.replaceChildren(buildMonitorFrame(target)); }
}

function selectMonitorTarget(id) {
  livePreviewOutputId = id;
  const sel = document.getElementById('live-preview-output-select');
  if (sel) sel.value = id;
  applyLivePreviewAspect();
  repaintPreviewWithOutputLook();
  setMonitorGrid(false);
}

// Grid: Main plus every output that's on, each a live copy; click to open one.
let monitorGridActive = false;
function renderMonitorGrid() {
  const host = document.getElementById('outputs-monitor-grid');
  if (!host) return;
  const targets = monitorTargets();
  const existing = new Map([...host.children].map(tile => [tile.dataset.key, tile]));
  const layersMap = typeof outputLayerMap === 'function' ? outputLayerMap() : {};
  const tiles = targets.map(t => {
    const { w, h } = monitorResolution(t);
    const key = `${t.id}|${w}x${h}`;
    if (existing.has(key)) return existing.get(key);
    const tile = document.createElement('button');
    tile.type = 'button';
    tile.className = 'monitor-grid-tile';
    tile.dataset.key = key;
    tile.title = `Show ${t.name} alone`;
    const header = document.createElement('div');
    header.className = 'monitor-grid-tile-header';
    header.textContent = t.name;
    tile.appendChild(header);
    if (t.type !== 'main' && typeof buildOutputLayersSummary === 'function') tile.appendChild(buildOutputLayersSummary(t.id, layersMap));
    tile.appendChild(buildMonitorFrame(t));
    tile.addEventListener('click', () => selectMonitorTarget(t.id));
    return tile;
  });
  [...host.children].filter(t => !tiles.includes(t)).forEach(disposeMonitorFrames);
  host.replaceChildren(...tiles);
  host.querySelectorAll('.monitor-grid-tile').forEach(tile => tile.classList.toggle('is-selected', tile.dataset.key.startsWith(`${livePreviewOutputId}|`)));
}

function setMonitorGrid(on) {
  monitorGridActive = on;
  const btn = document.getElementById('monitor-grid-toggle-btn');
  btn?.classList.toggle('active', on);
  btn?.setAttribute('aria-pressed', String(on));
  document.getElementById('outputs-monitor-grid')?.classList.toggle('hidden', !on);
  if (on) renderMonitorGrid();
  else { const g = document.getElementById('outputs-monitor-grid'); disposeMonitorFrames(g); g?.replaceChildren(); }   // stop the copies while hidden
  showMonitorSelection();
}
document.getElementById('monitor-grid-toggle-btn')?.addEventListener('click', () => setMonitorGrid(!monitorGridActive));

// Pop the monitor out: what it shows now (Main or one output) in its own
// normal window — title bar, resizable, movable to any screen. Same live copy
// of the output page the monitor uses; one pop-out at a time.
const MONITOR_WINDOW_LABEL = 'kairo-monitor';
async function openMonitorWindow() {
  const target = monitorTargets().find(t => t.id === livePreviewOutputId) || MONITOR_MAIN;
  // About the size of the Settings panel (880 wide, 78% of the app's height),
  // resizable. It opens in front without taking focus, so the operator keeps
  // working in the main window; it's a normal window, not always-on-top, so
  // clicking the app brings the app forward.
  const width = Math.min(880, Math.round(window.screen.availWidth * 0.9));
  const height = Math.max(420, Math.round(window.innerHeight * 0.78));
  // The grid pops out as the grid (monitor.html: every output that's on, plus
  // Main); the single view pops out that one output.
  const tiles = monitorTargets().map(t => { const { w, h } = monitorResolution(t); return { id: t.type === 'main' ? 'main' : t.id, name: t.name, w, h }; });
  const path = monitorGridActive
    ? `/monitor.html?tiles=${encodeURIComponent(JSON.stringify(tiles))}`
    : `/display.html?output=${encodeURIComponent(target.type === 'main' ? 'main' : target.id)}&monitor=1`;
  const title = monitorGridActive ? 'KAIRO Monitor — all outputs' : `KAIRO Monitor — ${target.name}`;
  const WebviewWindow = window.__TAURI__?.webviewWindow?.WebviewWindow;
  if (!WebviewWindow) { window.open(path, MONITOR_WINDOW_LABEL, `width=${width},height=${height}`); return; }
  try {
    const existing = await WebviewWindow.getByLabel(MONITOR_WINDOW_LABEL);
    if (existing) { await existing.close(); await new Promise(r => setTimeout(r, 150)); }
    new WebviewWindow(MONITOR_WINDOW_LABEL, {
      url: location.origin + path, title, width, height, minWidth: 320, minHeight: 200, center: true,
      resizable: true, decorations: true, focus: false, fullscreen: false,
    });
  } catch (err) { console.warn('[KAIRO] Monitor window failed:', err); }
}
document.getElementById('monitor-popout-btn')?.addEventListener('click', openMonitorWindow);

document.getElementById('live-preview-output-select')?.addEventListener('change', (e) => {
  livePreviewOutputId = e.target.value;
  applyLivePreviewAspect();
  // Only the output-default fallback (no item-specific theme) is stale when
  // switching which output we're monitoring — an item with its own theme
  // stays exactly as sent, same guard applyOutputThemes() already uses.
  repaintPreviewWithOutputLook();
  if (monitorGridActive) setMonitorGrid(false); else showMonitorSelection();
});

// ProPresenter-style song section annotation — mirrors slide_import.js's
// own SECTION_LABEL_RE (server-side, applied at import time) so a block's
// label ("Verse 1", "Chorus", "Bridge · 2" when split across multiple
// slides) maps onto the same CSS color classes here. Kept as a separate,
// looser client-side match (not shared code with the server) since this
// only needs to classify an ALREADY-derived label for display, not detect
// one from raw scanned text.
// Cycling the label itself needs playlists/activeItemId/liveSlideKey/
// slidesFor/sendSlide, all private to service.js's own IIFE closure — this
// file (app.js) runs as a separate top-level script and can't reach into
// them directly. window.KairoService is the existing, established bridge
// for exactly this (see its own definition at the bottom of service.js —
// slidesFor/sendSlide/renderStack and friends are already exposed there
// for other app.js callers); the real implementation lives there, this is
// just the click entry point.
previewSectionBadge?.addEventListener('click', () => window.KairoService?.cycleSectionLabel?.());

let lastPreviewPaintSig = null;
// Everything renderPreviewScreen last painted, so an output-look change can
// repaint it faithfully (translation, image, timer, label) — see
// repaintPreviewWithOutputLook. Null after a clear.
let lastPreviewArgs = null;

// Long strings (embedded data-URI images, long translations) enter the paint
// signature as a full-content hash instead of verbatim: cheap to compare, and
// memoized per string so an unchanged multi-MB look costs a Map lookup rather
// than a rescan on every render.
const previewStrHash = new Map();
function hashLongString(v) {
  let h = previewStrHash.get(v);
  if (h === undefined) {
    let x = 0x811c9dc5;
    for (let i = 0; i < v.length; i++) { x ^= v.charCodeAt(i); x = Math.imul(x, 0x01000193); }
    h = `${v.length}:${(x >>> 0).toString(36)}`;
    if (previewStrHash.size > 64) previewStrHash.clear();
    previewStrHash.set(v, h);
  }
  return h;
}

// Re-apply the output's default look to whatever the preview is showing (the
// operator switched which output it monitors, or that output's theme changed).
// Content sent with its own theme stays exactly as sent.
function repaintPreviewWithOutputLook() {
  if (lastPreviewHadOwnLook || !lastPreviewArgs) return;
  const a = lastPreviewArgs;
  renderPreviewScreen(a.text, a.reference, null, a.translatedText, a.image, a.fit, a.styleByLayerId, a.timerText, a.sectionLabel);
}

// Exactly one Live Queue card is marked LIVE — the verse on screen now (none
// while a slide is up or the screen is clear).
function markLiveInQueue(reference) {
  currentDisplayCard?.querySelectorAll('.is-live').forEach(c => c.classList.remove('is-live'));
  if (!reference) return;
  currentDisplayCard?.querySelector(`[data-ref="${CSS.escape(reference)}"]`)?.classList.add('is-live');
}

function renderPreviewScreen(text, reference, look, translatedText = '', image = null, fit = 'contain', styleByLayerId = {}, timerText = '', sectionLabel = '') {
  queueMicrotask(() => markLiveInQueue(reference));   // after showInViewer has placed the card
  const effectiveLook = look || primaryOutputLook();
  const newPreviewKey = `${reference || ''} ${text || ''}`;
  // Identical content + look already painted: re-running paint() tears down
  // and rebuilds the themed layers (and restarts any text animation), which
  // reads as a flicker on a verse that is already on screen. This happens on
  // every duplicate broadcast for the same send (interim + final, range
  // established then activated, ProPresenter ack). Returns BEFORE bumping
  // previewRenderGen so an in-flight transition of the same content isn't
  // cancelled. lastPreviewKey is reset to ' ' by the clear path, so a
  // clear-then-resend of the same verse still repaints.
  const paintSig = JSON.stringify(
    [translatedText, image, fit, styleByLayerId, timerText, sectionLabel, effectiveLook],
    (_k, v) => (typeof v === 'string' && v.length > 256 ? hashLongString(v) : v));
  // Recorded even when the paint is skipped: they describe the latest request.
  lastPreviewHadOwnLook = !!look;
  lastPreviewArgs = { text, reference, translatedText, image, fit, styleByLayerId, timerText, sectionLabel };
  if (newPreviewKey === lastPreviewKey && paintSig === lastPreviewPaintSig) return;
  lastPreviewPaintSig = paintSig;
  const myGen = ++previewRenderGen;
  // This panel (the sidebar Live Preview, not a separate display.html output
  // window) is what an operator watches while testing right in the main
  // window — it used to repaint instantly on every send regardless of the
  // theme's own animation/animationSpeed, which is exactly why a theme like
  // Lyrics — Motion looked completely inert unless you had a real output
  // window open elsewhere. Mirrors the same cut/fade/slide-up + speed
  // handling display.html's renderStage/showVerse already do.
  const contentChanged = newPreviewKey !== lastPreviewKey;
  lastPreviewKey = newPreviewKey;
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
      // Motion layers move here as on the output; build-ins play when the
      // content is new, not on a repaint of what's already showing.
      window.KairoService.paintLookLayers(themed, effectiveLook, styleByLayerId, { verseText: text, referenceText: reference || '', translatedText, timerText }, { motion: 'live', builds: contentChanged });
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
  // Output Looks — Media layer parity for NDI/Syphon (see wireNdiBridge's
  // own comment for why this call lives here specifically). `kind ===
  // 'video'` is silently skipped inside pushMedia itself (Phase 2, not this
  // change) rather than here, so a video clearing back to no-media still
  // correctly clears the native senders' Media layer too.
  window.KairoNativeOutputs?.pushMedia(kind === 'video' ? null : src);
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

  // A scripture now covers the output; a live song/slide stays live underneath
  // (the server's output-layer rule — Clear Bible brings it back), so the
  // playlist keeps showing it as live and the operator's view doesn't change.

  // Auto-correction: strip the mis-cited row so it doesn't linger above the fix.
  if (correctedFrom) {
    const stale = currentDisplayCard?.querySelector(`[data-ref="${CSS.escape(correctedFrom)}"]`);
    stale?.remove();
    const staleCand = queueList?.querySelector(`[data-ref="${CSS.escape(correctedFrom)}"]`);
    staleCand?.remove();
    // A corrected-away verse was never really part of the message.
    sessionVerses = sessionVerses.filter(x => x.ref !== correctedFrom);
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
        // Already the top (live) card — nothing to change; re-pulsing or
        // re-inserting it only makes an on-screen verse flicker.
        if (existing !== currentDisplayCard.firstChild) {
          existing.classList.remove('sent-pulse');
          void existing.offsetWidth;
          existing.classList.add('sent-pulse');
          currentDisplayCard.insertBefore(existing, currentDisplayCard.firstChild);
        }
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
  // A cited range counts as every verse of it (the notes list "Matthew 6:6-8").
  const sentAt = Date.now(), sentTime = new Date().toLocaleTimeString();
  for (const x of (verses.length > 1 ? verses : [v])) sessionVerses.push({ ref: x.reference, text: x.text, time: sentTime, at: sentAt });

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

// Owner, live, looking at the real panel: "hide anything less than 80" —
// Possible Matches was showing real but weak entries (Proverbs 4:7 75%,
// 1 John 4:5 79%) cluttering the panel. Deliberately a client-side display
// filter, not a server-side score-floor change: several server-side
// mechanisms (VERBATIM_MODERATE_IDF, the named-entity/contextual-scoped
// semantic floor, etc.) exist specifically to surface a weak-but-real match
// for a human to glance at — raising the SERVER floor to 80 would silently
// undo those tonight's earlier fixes were built for. This only hides them
// from the list; they're still detected and still logged.
const SUGGESTION_DISPLAY_MIN = 0.80;

function showInSuggestions(verses, method) {
  if (!queueList) return;
  queueList.querySelector('.display-empty')?.remove();

  const frag = document.createDocumentFragment();
  for (const v of verses) {
    if (v.similarity != null && v.similarity < SUGGESTION_DISPLAY_MIN) continue;
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
  card.dataset.at = String(Date.now());
  card.innerHTML = `
    <div class="cand-row">
      <span class="cand-ref">${v.reference}</span>
      ${conf ? `<span class="cand-badge ${tier}">${conf}</span>` : ''}
    </div>
    <div class="cand-text">${cleanVerseText(v.text)}</div>
    <div class="cand-actions">
      <button class="cand-send">Send to Air</button>
    </div>
  `;
  const sendBtn = card.querySelector('.cand-send');
  const sendThis = () => {
    // showInViewer now removes this card outright (Candidates is
    // candidates-only, no sent-item log) — no in-place "mark green" step
    // needed here anymore.
    showInViewer([v], method || 'direct', 1.0);
    sendVerseToServer(v);
  };
  sendBtn?.addEventListener('click', sendThis);
  // Promote used to mean "send to viewer only, skip ProPresenter" — a
  // meaningless distinction now that the ProPresenter message-push
  // integration is gone entirely (ProPresenter picks Kairo up as an NDI/
  // Syphon source instead, see Settings → Outputs). Send to Air is the
  // only real action left.
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

// Possible Matches shows now, not history: a suggestion fades after a minute
// and leaves after five.
const SUGGESTION_FADE_MS = 60000, SUGGESTION_DROP_MS = 300000;
setInterval(() => {
  const now = Date.now();
  let dropped = false;
  queueList?.querySelectorAll('.cand-card[data-at]').forEach(card => {
    const age = now - Number(card.dataset.at);
    if (age > SUGGESTION_DROP_MS) { card.remove(); dropped = true; }
    else card.classList.toggle('is-stale', age > SUGGESTION_FADE_MS);
  });
  if (dropped) updateSuggestionCount();
}, 10000);

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

  // Same range re-announced (e.g. repeated broadcast): keep the existing
  // cards and just move the highlight — tearing down and rebuilding every
  // card is a visible flicker for verses already on screen.
  const existingRange = [...currentDisplayCard.querySelectorAll('.range-verse-card')].map(el => el.dataset.ref);
  if (existingRange.length === verses.length && existingRange.every((r, i) => r === verses[i].reference)) {
    handleRangeActive(activeRef);
    return;
  }

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
// ── Audio capture ──────────────────────────────────────────────────────────
// Frames go to the local server over the app socket. While that socket is
// reconnecting they are held (~20s) and sent the moment it reopens — the
// server keeps the Deepgram session up the whole time, so a socket hiccup no
// longer drops what was said.
const PENDING_AUDIO_MAX_FRAMES = 16 * 20;   // 1024-sample frames at 16 kHz
let pendingAudioFrames = [];
function sendAudioFrame(buf) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    if (pendingAudioFrames.length) flushPendingAudio();
    ws.send(buf);
  } else if (isListening) {
    pendingAudioFrames.push(buf);
    if (pendingAudioFrames.length > PENDING_AUDIO_MAX_FRAMES) pendingAudioFrames.shift();
  }
}
function flushPendingAudio() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return;
  const frames = pendingAudioFrames; pendingAudioFrames = [];
  for (const f of frames) ws.send(f);
}

// Virtual/loopback inputs (BlackHole and friends) output exact digital
// silence whenever nothing is playing — for them "all zeros" is normal, not a
// dead device, and must never trigger a rebuild or a fallback to another mic.
const VIRTUAL_INPUT_RE = /blackhole|loopback|soundflower|vb-?cable|virtual|aggregate|ishowu/i;
// Pure digital loopbacks, with nothing analog in the path: no hiss for the
// level control to raise, so it may go further for them (audio_level.js).
// Narrower than the above: an aggregate or "virtual" device can include a mic.
const LOOPBACK_INPUT_RE = /blackhole|loopback|soundflower|vb-?cable|ishowu/i;
function captureIsVirtualInput() {
  return VIRTUAL_INPUT_RE.test(mediaStream?.getAudioTracks?.()[0]?.label || '');
}

// ── Input level, in Settings → Audio ───────────────────────────────────────
// What the selected input is delivering: its raw level (before the automatic
// level control, audio_level.js) on a dB scale so ordinary speech sits
// mid-bar, and a one-line verdict. While listening it reads the live capture;
// with Settings open on Audio and not listening, it previews the selected
// input on its own, so the feed can be checked before a service.
const inputLevel = { recent: [], clippedAt: 0, gain: null, meterPeak: 0 };
function noteInputLevel(peak, clipped, gain) {
  const now = Date.now();
  inputLevel.recent.push({ at: now, peak });
  while (inputLevel.recent.length && inputLevel.recent[0].at < now - 3000) inputLevel.recent.shift();
  if (clipped) inputLevel.clippedAt = now;
  inputLevel.gain = gain;
  if (peak > inputLevel.meterPeak) inputLevel.meterPeak = peak;
}
setInterval(() => {
  const wrap = document.getElementById('input-level');
  if (!wrap || settingsModal?.classList.contains('hidden')) { inputLevel.meterPeak = 0; return; }
  const bar = wrap.querySelector('.input-level-meter i');
  const status = document.getElementById('input-level-status');
  if (!isListening && !inputPreview?.ctx) {
    bar.style.width = '0%';
    wrap.dataset.state = 'idle';
    status.textContent = inputPreviewFailed ? 'This input isn’t available' : '';
    return;
  }
  const p = Math.min(1, inputLevel.meterPeak);
  inputLevel.meterPeak = 0;
  const db = p > 0 ? 20 * Math.log10(p) : -90;
  bar.style.width = `${Math.max(0, Math.min(100, ((db + 60) / 60) * 100))}%`;
  const recentPeak = inputLevel.recent.reduce((m, x) => Math.max(m, x.peak), 0);
  const verdict = window.KairoLevel.describeLevel({
    peak: recentPeak, clipped: Date.now() - inputLevel.clippedAt < 2000, gain: inputLevel.gain,
  });
  wrap.dataset.state = verdict.state;
  status.textContent = verdict.text;
}, 100);

// The Settings preview: its own short-lived capture of the selected input,
// only while Settings shows Audio and nothing is listening.
let inputPreview = null;         // { deviceId, stream, ctx, timer }
let inputPreviewFailed = null;   // { deviceId, at } — retried after 3 s
async function startInputPreview(deviceId) {
  stopInputPreview();
  const p = { deviceId };
  inputPreview = p;
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
        echoCancellation: false, noiseSuppression: false, autoGainControl: false,
      },
    });
    if (inputPreview !== p) { stream.getTracks().forEach(t => t.stop()); return; }
    const ctx = new AudioContext();
    if (ctx.state === 'suspended') await ctx.resume().catch(() => {});
    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;
    ctx.createMediaStreamSource(stream).connect(analyser);
    const buf = new Float32Array(analyser.fftSize);
    p.timer = setInterval(() => {
      analyser.getFloatTimeDomainData(buf);
      let peak = 0;
      for (let i = 0; i < buf.length; i++) { const a = buf[i] < 0 ? -buf[i] : buf[i]; if (a > peak) peak = a; }
      noteInputLevel(peak, peak >= 0.999, null);
    }, 100);
    p.stream = stream; p.ctx = ctx;
    inputPreviewFailed = null;
    if (inputPreview !== p) stopPreviewCapture(p);
  } catch (err) {
    console.warn('[KAIRO] Input level preview unavailable:', err.name, err.message);
    if (inputPreview === p) { inputPreview = null; inputPreviewFailed = { deviceId, at: Date.now() }; }
  }
}
function stopPreviewCapture(p) {
  clearInterval(p.timer);
  try { p.stream?.getTracks().forEach(t => t.stop()); } catch {}
  try { p.ctx?.close(); } catch {}
}
function stopInputPreview() {
  const p = inputPreview;
  inputPreview = null;
  if (p) stopPreviewCapture(p);
}
setInterval(() => {
  const showing = settingsModal && !settingsModal.classList.contains('hidden')
    && document.querySelector('.settings-pane[data-pane="audio"]')?.classList.contains('active');
  if (!showing || isListening || mediaStream) {
    stopInputPreview();
    inputPreviewFailed = null;
    return;
  }
  const deviceId = audioSourceSettings?.value || '';
  if (inputPreview?.deviceId === deviceId) return;
  if (inputPreviewFailed?.deviceId === deviceId && Date.now() - inputPreviewFailed.at < 3000) return;
  startInputPreview(deviceId);
}, 500);

let lastNonZeroAudioAt = 0;   // any non-zero sample at all (a real mic always has some noise)
let _lastLevelLogAt = 0;
// One capture graph: getUserMedia stream -> 16 kHz AudioContext -> frames to
// the server. Shared by Start and every rebuild (they used to be two copies).
async function buildCaptureGraph(deviceId, existingStream = null) {
  const stream = existingStream || await navigator.mediaDevices.getUserMedia({
    audio: {
      ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
      echoCancellation: false, noiseSuppression: false, autoGainControl: false, sampleRate: 16000,
    },
  });
  const ctx = new AudioContext({ sampleRate: 16000 });
  if (ctx.state === 'suspended') await ctx.resume();
  if (ctx.state !== 'running') console.error('[KAIRO] AudioContext still not running after resume():', ctx.state);
  const source = ctx.createMediaStreamSource(stream);
  // The level control's settings for this input: how far it may raise
  // (further for a digital loopback) and where it starts (what this input
  // needed last time — see audio_level.js).
  const inputLabel = stream.getAudioTracks?.()[0]?.label || '';
  const levelOptions = { digital: LOOPBACK_INPUT_RE.test(inputLabel), initialGain: rememberedInputGain(inputLabel) };
  // On the audio thread, sent by a worker — the page's main thread never
  // handles the audio (see audio_capture_worklet.js for the live-test stalls
  // this ends). The main-thread processor below is the fallback.
  if (ctx.audioWorklet && typeof AudioWorkletNode === 'function') {
    try {
      await ctx.audioWorklet.addModule('audio_level.js');   // the level control, shared into the worklet's scope
      await ctx.audioWorklet.addModule('audio_capture_worklet.js');
      const node = new AudioWorkletNode(ctx, 'kairo-capture', { numberOfInputs: 1, numberOfOutputs: 1, outputChannelCount: [1], processorOptions: levelOptions });
      node.port.onmessage = (e) => {
        const d = e.data;
        if (d instanceof ArrayBuffer) sendAudioFrame(d);          // only until the worker's port is in place
        else if (d && typeof d.peak === 'number') noteCaptureLevel(d.peak, 1024, d.gain, d.clipped);
      };
      const worker = captureSenderWorker();
      if (worker) {
        const channel = new MessageChannel();
        worker.postMessage({ type: 'port', port: channel.port2 }, [channel.port2]);
        node.port.postMessage({ port: channel.port1 }, [channel.port1]);
      }
      source.connect(node);
      node.connect(ctx.destination);   // keeps the graph pulling (the node outputs silence)
      return { stream, ctx, proc: node };
    } catch (err) {
      console.warn('[KAIRO] Audio-thread capture unavailable, using the main-thread fallback:', err);
    }
  }
  const proc = ctx.createScriptProcessor(1024, 1, 1);
  const level = window.KairoLevel ? new window.KairoLevel.LevelControl(ctx.sampleRate, levelOptions) : null;
  const block = new Float32Array(1024);
  proc.onaudioprocess = (e) => {
    const float32 = e.inputBuffer.getChannelData(0);
    const out = block.length === float32.length ? block : new Float32Array(float32.length);
    let peak = 0, clipped = false;
    if (level) ({ peak, clipped } = level.apply(float32, out));
    else {
      for (let i = 0; i < float32.length; i++) {
        const v = float32[i], a = v < 0 ? -v : v;
        if (a > peak) peak = a;
        out[i] = v > 1 ? 1 : v < -1 ? -1 : v;
      }
      clipped = peak >= 0.999;
    }
    const int16 = new Int16Array(out.length);
    for (let i = 0; i < out.length; i++) int16[i] = out[i] * 32767;
    noteCaptureLevel(peak * 32768, float32.length, level ? level.gain : 1, clipped);
    sendAudioFrame(int16.buffer);
  };
  source.connect(proc);
  proc.connect(ctx.destination);
  return { stream, ctx, proc };
}

// The capture level — the meter, the dead-device checks and a debug-log line
// every 3 s. From the worklet ten times a second, or per fallback frame. The
// peak is the raw input (int16 scale, before the level control); gain is what
// the level control applied.
function noteCaptureLevel(peak, bufferLength, gain = 1, clipped = false) {
  const now = Date.now();
  noteInputLevel(peak / 32768, clipped, gain);
  noteInputSummary(peak / 32768, clipped, gain);
  if (peak > 0) rememberInputGain(mediaStream?.getAudioTracks?.()[0]?.label || '', gain);
  if (peak > 0) lastNonZeroAudioAt = now;
  if (peak > AUDIO_PEAK_NOISE_FLOOR) lastRealAudioAt = now;
  if (now - _lastLevelLogAt > 3000) {
    _lastLevelLogAt = now;
    fetch(`${SERVER}/api/debug-log`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ event: 'audio-peak', data: { peak, bufferLength, gain: Math.round(gain * 100) / 100, clipped } }),
    }).catch(() => {});
  }
}

// The gain the level control settled on, per input, so the next session — or
// a rebuilt capture — starts there instead of catching up from scratch (a
// quiet feed used to lose the first seconds of every session to the ramp).
const INPUT_GAIN_KEY = 'kairo-input-gain';
const inputGains = (() => {
  try { return JSON.parse(localStorage.getItem(INPUT_GAIN_KEY) || '{}') || {}; } catch { return {}; }
})();
let _inputGainSavedAt = 0;
function rememberedInputGain(label) {
  const g = Number(inputGains[label]);
  return g > 0 ? g : 1;
}
function rememberInputGain(label, gain) {
  if (!label || !(gain > 0)) return;
  inputGains[label] = Math.round(gain * 100) / 100;
  const now = Date.now();
  if (now - _inputGainSavedAt < 5000) return;
  _inputGainSavedAt = now;
  try { localStorage.setItem(INPUT_GAIN_KEY, JSON.stringify(inputGains)); } catch {}
}

// Every 30 s of listening, one line in server.log on what the input delivered
// (next to the server's own frame counts): which input, its typical level,
// how much of it was silent or clipped, and the gain the level control used.
// Enough to tell a feed problem from anything else without a re-test.
const inputSummary = { since: 0, reports: 0, silent: 0, clipped: 0, peaks: [], gainDbSum: 0 };
function noteInputSummary(peak, clipped, gain) {
  const now = Date.now();
  const s = inputSummary;
  if (!s.since) s.since = now;
  s.reports++;
  if (clipped) s.clipped++;
  if (peak <= 0.001) s.silent++;
  else { s.peaks.push(peak); s.gainDbSum += 20 * Math.log10(gain || 1); }
  if (now - s.since < 30000) return;
  const sorted = s.peaks.sort((a, b) => a - b);
  const typical = sorted.length ? sorted[sorted.length >> 1] : 0;
  const data = {
    device: mediaStream?.getAudioTracks?.()[0]?.label || '',
    typicalPeakDb: typical > 0 ? Math.round(20 * Math.log10(typical)) : null,
    silentPct: Math.round((s.silent / s.reports) * 100),
    clippedPct: Math.round((s.clipped / s.reports) * 1000) / 10,
    gainDb: sorted.length ? Math.round(s.gainDbSum / sorted.length) : 0,
  };
  Object.assign(s, { since: now, reports: 0, silent: 0, clipped: 0, peaks: [], gainDbSum: 0 });
  fetch(`${SERVER}/api/debug-log`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'audio-input', data }),
  }).catch(() => {});
}

// One sender worker for the session (audio_sender_worker.js): its own
// connection to the server, started when capture starts, stopped on Stop.
let _captureWorker = null;
function captureSenderWorker() {
  try {
    if (!_captureWorker) _captureWorker = new Worker('audio_sender_worker.js');
    _captureWorker.postMessage({ type: 'start', url: authedWsUrl(`${WS_URL}/?audio=1`) });
    return _captureWorker;
  } catch (err) {
    console.warn('[KAIRO] Audio sender worker unavailable:', err);
    return null;
  }
}
function stopCaptureSender() { try { _captureWorker?.postMessage({ type: 'stop' }); } catch {} }
function teardownCaptureGraph(g) {
  try { if (g.proc) { g.proc.disconnect(); g.proc.onaudioprocess = null; if (g.proc.port) { g.proc.port.postMessage({ port: null }); g.proc.port.onmessage = null; } } } catch {}
  try { g.stream?.getTracks().forEach(t => t.stop()); } catch {}
  try { g.ctx?.close(); } catch {}
}

async function startListening() {
  if (isListening) return;
  // New session — reset accumulators so Content Studio doesn't bundle the
  // previous sermon's transcript and verses into the next save. Counters and
  // timers are reset in handleConnectionState when we actually connect.
  sessionVerses = [];
  sessionTranscriptParts = [];
  // A previous session's fallback shouldn't carry into this one — always
  // start a fresh session on whatever Settings actually has configured.
  capturingFallbackDevice = false;
  confidenceSum   = 0;
  confidenceCount = 0;
  const engine = (settings.speechEngine || 'deepgram').toLowerCase();
  // Both the current 'offline' value and the legacy 'browser' value (the
  // Settings toggle's data-engine, kept as an alias for anyone with an old
  // saved setting) route to the server's sherpa-onnx offline engine.
  const serverEngine = (engine === 'offline' || engine === 'browser') ? 'offline' : 'deepgram';
  stopInputPreview();   // the Settings meter's own capture of the same input
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
      // error strings (from startDeepgram/startOffline in server.js) trigger
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
    const g = await buildCaptureGraph(null, mediaStream);
    audioContext = g.ctx; audioProcessor = g.proc;
    watchAudioTrackHealth();   // OS-level "track died" → immediate rebuild

    lastRealAudioAt = lastNonZeroAudioAt = Date.now(); // don't warn before real audio has had a chance to arrive at all
    audioSilenceWarning = false;
    clearInterval(audioSilenceWatchdog);
    resetSleepCheck();
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
  pendingAudioFrames = [];
  Object.assign(inputSummary, { since: 0, reports: 0, silent: 0, clipped: 0, peaks: [], gainDbSum: 0 });
  stopCaptureSender();
  if (audioProcessor) { try { audioProcessor.disconnect(); if (audioProcessor.port) audioProcessor.port.onmessage = null; } catch {} audioProcessor = null; }
  if (audioContext)   { try { audioContext.close(); }       catch {} audioContext   = null; }
  if (mediaStream)    { mediaStream.getTracks().forEach(t => t.stop()); mediaStream = null; }
  clearInterval(audioSilenceWatchdog);
  audioSilenceWatchdog = null;
  resetSleepCheck();
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
    // Back to the listening state — or Idle when this clears because
    // listening just stopped (it used to leave "Broadcasting" up after Stop).
    dot?.classList.remove('warning');
    dot?.classList.toggle('broadcasting', isListening);
    if (lbl) {
      lbl.classList.remove('warning');
      lbl.classList.toggle('broadcasting', isListening);
      lbl.textContent = isListening ? 'Broadcasting' : 'Idle';
    }
  }
}

let _audioHealAt = 0;
let _audioHealing = false;
// True while capture is running on the SYSTEM DEFAULT device as a transient
// stand-in for the operator's own explicitly-configured Audio Input,
// because that device recently looked silent. Real incident: BlackHole
// (a loopback device) briefly had nothing playing through it right as the
// silence checks fired, so the old code below overwrote the Settings
// dropdown itself to blank — which resolves to the room mic — with no
// visible sign anything changed, and no way back to BlackHole short of the
// operator noticing and manually reselecting it. This flag keeps the
// fallback purely internal to capture: audioSourceSettings.value (what
// Settings actually shows, and what gets persisted) is never touched, and
// checkAudioSilence periodically retries the operator's real choice below
// so a loopback device that starts carrying real audio again is picked
// back up automatically.
let capturingFallbackDevice = false;
let _fallbackRetryAt = 0;
function _healLog(msg, extra) {
  console.warn('[KAIRO]', msg);
  fetch(`${SERVER}/api/debug-log`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'audio-heal', data: { msg, ...(extra || {}) } }),
  }).catch(() => {});
}

let _lastSilenceCheckAt = 0;
let _lastSilenceCheckAudioTime = 0;
// A new session or a rebuilt capture brings a new audio clock: start over.
function resetSleepCheck() { _lastSilenceCheckAt = 0; _lastSilenceCheckAudioTime = 0; }
function checkAudioSilence() {
  if (!isListening) return;
  const now = Date.now();
  // This runs every 5s — a much longer gap can mean the machine was asleep,
  // and waking from sleep is what leaves a WKWebView capture delivering zeros.
  // But a long gap alone isn't sleep: the page's timers are throttled while
  // Kairo sits behind another window, and the previous session's last check
  // is long past when listening starts again — both rebuilt the capture for
  // nothing (live: a "woke-from-sleep" rebuild with no sleep in the Mac's
  // power log), resetting the level control mid-sermon. During real sleep the
  // audio clock stops too, so it counts as sleep only when the audio clock
  // fell well behind the wall clock.
  const audioTime = audioContext?.currentTime ?? 0;
  const wallGap = (now - _lastSilenceCheckAt) / 1000;
  const audioGap = audioTime - _lastSilenceCheckAudioTime;
  const wokeFromSleep = _lastSilenceCheckAt > 0 && wallGap > 20 && audioGap < wallGap - 10;
  _lastSilenceCheckAt = now;
  _lastSilenceCheckAudioTime = audioTime;
  if (audioContext && audioContext.state !== 'running') {
    audioContext.resume().catch(() => {});
  }
  setAudioSilenceWarning(now - lastRealAudioAt > AUDIO_SILENCE_WARN_MS);
  // Rebuild the capture ONLY when it is actually broken: after sleep, or a
  // real microphone stuck at exact zeros for 45s (a real mic always has a
  // noise floor). Quiet audio — a pause, prayer, BlackHole with nothing
  // playing — is never a reason: silence used to trigger a rebuild, which the
  // operator saw as the mic "reconnecting". The Deepgram connection is never
  // touched here either way.
  const stuckAtZero = !captureIsVirtualInput() && now - lastNonZeroAudioAt > 45000;
  if ((wokeFromSleep || stuckAtZero) && audioContext && !_audioHealing && now - _audioHealAt > 20000) {
    _audioHealAt = now;
    restartAudioCapture(wokeFromSleep ? 'woke-from-sleep' : 'microphone-stuck-at-zero');
    return;
  }
  // Self-recovery: while parked on the fallback device, periodically retry
  // the operator's actually-configured one — otherwise a loopback device
  // that only LOOKED silent for a moment (content hadn't started, a brief
  // pause) stays abandoned for the rest of the service even once it's
  // carrying real audio again, and the operator has to notice and manually
  // reselect it. Independent of the 20s heal throttle above (this isn't a
  // "something's broken" heal, just a routine re-check) but still gated on
  // !_audioHealing so it can't overlap an unrelated rebuild in progress.
  const configuredDeviceId = audioSourceSettings?.value || '';
  if (capturingFallbackDevice && configuredDeviceId && !_audioHealing
      && Date.now() - _fallbackRetryAt > 30000) {
    _fallbackRetryAt = Date.now();
    _healLog('retrying operator-configured device after fallback', { device: configuredDeviceId });
    capturingFallbackDevice = false;
    restartAudioCapture('fallback-retry');
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
    const configuredDeviceId = audioSourceSettings?.value || '';
    const deviceId = capturingFallbackDevice ? '' : configuredDeviceId;
    // Build the NEW capture first and only then retire the old one, so the
    // swap has no gap and nothing on screen changes. (The old code tore the
    // capture down first — every rebuild was an audible, visible reconnect.)
    const next = await buildCaptureGraph(deviceId);
    const prev = { stream: mediaStream, ctx: audioContext, proc: audioProcessor };
    mediaStream = next.stream; audioContext = next.ctx; audioProcessor = next.proc;
    resetSleepCheck();
    teardownCaptureGraph(prev);
    watchAudioTrackHealth();
    lastRealAudioAt = lastNonZeroAudioAt = Date.now();
    if (micDisplay) micDisplay.textContent = mediaStream.getAudioTracks()[0]?.label || 'Microphone';
    _healLog('audio capture rebuilt', { reason, device: deviceId || 'default' });

    // A REAL microphone that still delivers exact zeros right after a fresh
    // capture is dead (a real mic always has a noise floor) — fall back to
    // the default input. Never for a virtual input like BlackHole: its
    // digital silence just means nothing is playing, and switching the
    // service over to the room mic (then back, every 30s) is exactly the
    // "mic keeps reconnecting" loop this used to cause.
    if (deviceId && allowDeviceFallback && !captureIsVirtualInput()) {
      const checkpoint = lastNonZeroAudioAt;
      setTimeout(() => {
        if (isListening && lastNonZeroAudioAt === checkpoint && !_audioHealing) {
          _healLog('selected microphone still outputs exact zeros after rebuild — falling back to default input');
          capturingFallbackDevice = true;
          _fallbackRetryAt = Date.now();
          _audioHealAt = Date.now();
          restartAudioCapture('device-fallback', false);
        }
      }, 3000);
    }
  } catch (err) {
    // The old capture is still running (nothing was torn down) — keep it.
    _healLog('audio capture rebuild FAILED — keeping the current capture', { reason, error: err.message });
    // The selected device may have gone away (unplugged, renamed): only then
    // fall back to the default input.
    const failedDeviceId = audioSourceSettings?.value || '';
    if (failedDeviceId && allowDeviceFallback && !capturingFallbackDevice) {
      _healLog('selected device unavailable — falling back to default input');
      capturingFallbackDevice = true;
      _fallbackRetryAt = Date.now();
      setTimeout(() => { if (isListening) { _audioHealing = false; restartAudioCapture('device-fallback-after-error', false); } }, 500);
    }
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
    if (versionEl) versionEl.textContent = settings.appVersion ? `v${settings.appVersion}` : '';
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
    if (translationSettings && settings.translation) translationSettings.value = settings.translation;
    if (translationSelect && settings.translation)   translationSelect.value   = settings.translation;
    if (bibleTranslateToSelect) bibleTranslateToSelect.value = settings.bibleTranslateTo || '';
    if (autoSendSettings)  autoSendSettings.checked  = settings.autoSend  !== false;
    updateAutoDeployBadge();
    if (showConfSettings)  showConfSettings.checked   = settings.showConfidence !== false;
    // Restore toggle-group state from persisted settings
    syncToggleGroup('speech-engine-toggle', 'engine', settings.speechEngine || 'deepgram');
    initCustomSelects();
    // Outputs — one unified master-detail render (see renderOutputsPane's
    // own comment for the full list of what this replaced).
    renderOutputsPane();
    // Push the resolved per-output theme/layer maps to the server now, not
    // just whenever a theme/display setting is next touched —
    // applyOutputThemes() was previously only ever called as a side effect
    // of the operator changing something in Settings, so the server's
    // currentOutputThemes stayed {} for an entire session on a fresh
    // launch. Anything server-side that depends on knowing the primary
    // output's theme (e.g. attachBibleTranslations gating on the Multi-
    // Language layout — see primaryOutputTranslateLang in server.js)
    // silently did nothing until the operator happened to open Settings
    // and touch a picker, which is exactly why the Multi-Language theme
    // looked like it "worked sometimes and not others."
    applyOutputThemes();
    applyOutputLayers();
    // Language
    const sttLang = document.getElementById('stt-language');
    if (sttLang) sttLang.value = settings.sttLanguage || 'en-US';
    const vocab = document.getElementById('custom-keyterms');
    if (vocab) vocab.value = settings.customKeyterms || '';
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

// ── First-run onboarding wizard ─────────────────────────────────────────────
// Multi-step tour (speech engine, Playlist, Slides, Timer, Themes, Outputs,
// done) — see index.html's own "FIRST-RUN ONBOARDING WIZARD" comment for the
// step markup. Shown once per install (settings.onboardingCompleted),
// independent of whether speech-engine setup happens to already be done —
// a returning user who configured Deepgram via some other path still gets
// the tour once, since the tour is about the whole app, not just that one
// step. Re-openable anytime from Settings → Help ("Take the tour again").
let firstRunDismissed = false;
const ONBOARDING_STEP_COUNT = 7; // steps 0..6, see the step panels' data-step
let onboardingStep = 0;

function showFirstRunBannerIfNeeded(s) {
  const modal = document.getElementById('first-run-modal');
  if (!modal) return;
  if (s?.onboardingCompleted) {
    modal.classList.add('hidden');
    return;
  }
  if (firstRunDismissed || !modal.classList.contains('hidden')) return; // dismissed or already showing
  openOnboardingWizard();
}

function openOnboardingWizard() {
  const modal = document.getElementById('first-run-modal');
  if (!modal) return;
  modal.classList.remove('hidden');
  const input = document.getElementById('first-run-deepgram-key');
  if (input) input.value = '';
  syncToggleGroup('first-run-engine-toggle', 'engine', 'deepgram'); // always starts on the Deepgram tab
  goToOnboardingStep(0);
  // Defer focus so the overlay has laid out before we focus inside it.
  setTimeout(() => input?.focus(), 50);
}

const ONBOARDING_STEP_TITLES = [
  'Welcome to KAIRO', 'Playlist', 'Slides', 'Timer', 'Themes', 'Outputs', "You're all set",
];

function renderOnboardingProgress() {
  const host = document.getElementById('onboarding-progress');
  if (!host) return;
  host.innerHTML = '';
  for (let i = 0; i < ONBOARDING_STEP_COUNT; i++) {
    const dot = document.createElement('span');
    dot.style.cssText = `height:4px;flex:1;border-radius:2px;background:${i <= onboardingStep ? 'var(--accent,#6aa6ff)' : 'var(--surface-2)'};`;
    host.appendChild(dot);
  }
}

function goToOnboardingStep(n) {
  onboardingStep = Math.max(0, Math.min(ONBOARDING_STEP_COUNT - 1, n));
  document.querySelectorAll('.onboarding-step').forEach(el => {
    el.classList.toggle('hidden', Number(el.dataset.step) !== onboardingStep);
  });
  const title = document.getElementById('onboarding-step-title');
  if (title) title.textContent = ONBOARDING_STEP_TITLES[onboardingStep] || 'Welcome to KAIRO';
  renderOnboardingProgress();
  document.getElementById('onboarding-back')?.classList.toggle('hidden', onboardingStep === 0);
  const isLast = onboardingStep === ONBOARDING_STEP_COUNT - 1;
  document.getElementById('onboarding-next')?.classList.toggle('hidden', isLast);
  document.getElementById('first-run-save')?.classList.toggle('hidden', !isLast);
}

// Real, non-blocking validation on the way OUT of the speech-engine step —
// owner: "if no deepgram key exist and no offline model is found, prompt
// the user to download the model in settings or add a deepgram key." This
// is the proactive, tour-time version; startListening's own missingKey/
// missingModel handling is the reactive one that fires later if this got
// skipped. Async because "is the offline model actually installed" is a
// real filesystem check on the server, not something the client already
// knows — checked fresh each time so downloading it mid-tour clears the
// warning without needing to leave and re-enter this step.
async function checkOnboardingSpeechSetup() {
  const warning = document.getElementById('onboarding-speech-warning');
  if (!warning) return;
  const engine = readToggleGroup('first-run-engine-toggle', 'engine') || 'deepgram';
  if (engine === 'browser') {
    let installed = false;
    try {
      const r = await fetch(`${SERVER}/api/offline/status`);
      installed = !!(await r.json())?.installed;
    } catch { /* treat as not installed — same fail-safe the reactive check uses */ }
    warning.classList.toggle('hidden', installed);
  } else {
    const key = (document.getElementById('first-run-deepgram-key')?.value || '').trim();
    warning.classList.toggle('hidden', !!(key || settings.deepgramApiKey));
  }
}

async function markOnboardingComplete() {
  try {
    await fetch(`${SERVER}/api/settings`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...settings, onboardingCompleted: true }),
    });
    settings = { ...settings, onboardingCompleted: true };
  } catch { /* best-effort — worst case the tour just reappears next launch */ }
}

function closeFirstRunModal() {
  firstRunDismissed = true;
  document.getElementById('first-run-modal')?.classList.add('hidden');
  markOnboardingComplete();
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
    translation:       translationSettings?.value || 'KJV',
    autoSend:          autoSendSettings?.checked  !== false,
    showConfidence:    showConfSettings?.checked   !== false,
    // obsEnabled/obsUrl/obsPassword/obsTextSource are NOT collected here —
    // the OBS detail panel (Outputs master-detail redesign) self-persists
    // each field immediately on change, the same pattern NDI/Syphon
    // outputs already use, since its fields only exist in the DOM while
    // OBS happens to be the selected output. Reading them here (assuming
    // they're always present) would silently overwrite real saved values
    // with fallback defaults every time Save is clicked while a DIFFERENT
    // output is selected.
    speechEngine:        readToggleGroup('speech-engine-toggle', 'engine') || settings.speechEngine || 'deepgram',
    // No Ollama inputs exist in the UI anymore — carry the saved values through
    // (reading the missing inputs used to overwrite a custom URL with the default on every save).
    ollamaUrl:           settings.ollamaUrl || 'http://localhost:11434',
    ollamaModel:         settings.ollamaModel || 'qwen2.5:7b-instruct',
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
  updateAutoDeployBadge();
  // Dismiss first-run banner now that a key may have been entered.
  showFirstRunBannerIfNeeded(settings);
  closeModal();
  toast('Settings saved', 'success');
}

settingsBtn?.addEventListener('click',    () => { settingsModal?.classList.remove('hidden'); showFirstSettingsPane(); });
closeSettingsBtn?.addEventListener('click', closeModal);
cancelSettingsBtn?.addEventListener('click', closeModal);
saveSettingsBtn?.addEventListener('click',  saveCurrentSettings);
document.querySelector('.modal-overlay')?.addEventListener('click', closeModal);

// First-run onboarding wizard wiring
document.getElementById('first-run-save')?.addEventListener('click', saveFirstRunChoice);
document.getElementById('first-run-skip')?.addEventListener('click', closeFirstRunModal);
document.getElementById('close-first-run')?.addEventListener('click', closeFirstRunModal);
document.querySelector('#first-run-modal .modal-overlay')?.addEventListener('click', closeFirstRunModal);
document.getElementById('first-run-deepgram-key')?.addEventListener('keydown', (e) => {
  if (e.key === 'Enter') document.getElementById('onboarding-next')?.click();
});
document.getElementById('onboarding-next')?.addEventListener('click', async () => {
  if (onboardingStep === 0) await checkOnboardingSpeechSetup();
  goToOnboardingStep(onboardingStep + 1);
});
document.getElementById('onboarding-back')?.addEventListener('click', () => goToOnboardingStep(onboardingStep - 1));
// Settings → Help's "Take the tour again" — re-runs the exact same wizard,
// not a separate/lesser version of it.
document.getElementById('replay-onboarding-btn')?.addEventListener('click', () => {
  closeModal(); // Settings itself is open when this is clicked — close it first, same as any modal handoff
  openOnboardingWizard();
});

// Settings → Help's search: only the sections that mention every word typed
// stay, opened, with the words marked. Words like "how" or "the" don't have to
// appear ("how do I clear the screen" looks for clear + screen). Enter steps
// through the marks (Shift+Enter back); Escape clears. Clearing puts every
// section back open or closed the way it was.
(function initHelpSearch() {
  const input = document.getElementById('help-search');
  const groupsEl = document.querySelector('.help-groups');
  if (!input || !groupsEl) return;
  const countEl = document.getElementById('help-search-count');
  const noneEl = document.getElementById('help-no-results');
  const groups = [...groupsEl.querySelectorAll('.help-group')];
  // A summary is a flex row: its title goes in one span so marked words stay
  // inline with the rest of it.
  groups.forEach(g => {
    const s = g.querySelector('summary');
    if (s && !s.querySelector('.help-summary-text')) {
      const span = document.createElement('span');
      span.className = 'help-summary-text';
      while (s.firstChild) span.appendChild(s.firstChild);
      s.appendChild(span);
    }
  });
  const STOP = new Set(['a', 'an', 'and', 'are', 'be', 'can', 'do', 'does', 'for', 'how', 'i', 'if', 'in',
    'is', 'it', 'me', 'my', 'of', 'on', 'or', 'the', 'to', 'what', 'when', 'where', 'why', 'with', 'you', 'your']);
  const openBefore = new Map();
  let marks = [], current = -1, timer = 0;

  function unmark() {
    groupsEl.querySelectorAll('mark.help-hit').forEach(m => {
      const parent = m.parentNode;
      parent.replaceChild(document.createTextNode(m.textContent), m);
      parent.normalize();
    });
    marks = []; current = -1;
  }
  function mark(root, re) {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const text = node.nodeValue;
      re.lastIndex = 0;
      if (!re.test(text)) continue;
      re.lastIndex = 0;
      const frag = document.createDocumentFragment();
      let last = 0, m;
      while ((m = re.exec(text))) {
        if (m.index > last) frag.appendChild(document.createTextNode(text.slice(last, m.index)));
        const el = document.createElement('mark');
        el.className = 'help-hit';
        el.textContent = m[0];
        frag.appendChild(el);
        last = m.index + m[0].length;
      }
      if (last < text.length) frag.appendChild(document.createTextNode(text.slice(last)));
      node.parentNode.replaceChild(frag, node);
    }
  }
  function search() {
    const q = input.value.trim().toLowerCase().replace(/\s+/g, ' ');
    unmark();
    if (!q) {
      groups.forEach(g => { g.hidden = false; if (openBefore.has(g)) g.open = openBefore.get(g); });
      openBefore.clear();
      countEl.textContent = '';
      noneEl.hidden = true;
      return;
    }
    if (!openBefore.size) groups.forEach(g => openBefore.set(g, g.open));
    // Words match from their start ("clip" finds clipping, "ndi" finds NDI but
    // not "finding").
    const esc = (w) => (/^\w/.test(w) ? '\\b' : '') + w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const textOf = new Map(groups.map(g => [g, g.textContent.replace(/\s+/g, ' ')]));
    const words = q.split(' ');
    const terms = words.filter(w => !STOP.has(w));
    const find = terms.length ? terms : words;
    // Several words said as a phrase somewhere ("next verse", "clear bible")
    // find just that phrase; otherwise every word, anywhere in the section.
    const phraseRe = new RegExp(words.map(esc).join('\\s+'), 'i');
    const phrase = words.length > 1 && groups.some(g => phraseRe.test(textOf.get(g)));
    const termRes = find.map(w => new RegExp(esc(w), 'i'));
    const re = phrase
      ? new RegExp(words.map(esc).join('\\s+'), 'gi')
      : new RegExp(find.map(esc).sort((a, b) => b.length - a.length).join('|'), 'gi');
    let shown = 0;
    for (const g of groups) {
      const text = textOf.get(g);
      const hit = phrase ? phraseRe.test(text) : termRes.every(r => r.test(text));
      g.hidden = !hit;
      g.open = hit;
      if (hit) { shown++; mark(g, re); }
    }
    marks = [...groupsEl.querySelectorAll('mark.help-hit')];
    countEl.textContent = shown ? `${shown} ${shown === 1 ? 'section' : 'sections'}` : '';
    noneEl.hidden = shown > 0;
  }
  function step(dir) {
    if (!marks.length) return;
    marks[current]?.classList.remove('is-current');
    current = (current + dir + marks.length) % marks.length;
    marks[current].classList.add('is-current');
    // Scroll the Settings pane itself — scrollIntoView() can shift the whole
    // page in WebKit and fold the top bar away (see focusInStack in service.js).
    const pane = document.getElementById('settings-panes');
    if (pane) {
      const p = pane.getBoundingClientRect(), m = marks[current].getBoundingClientRect();
      pane.scrollTo({ top: pane.scrollTop + (m.top - p.top) - p.height / 2, behavior: 'smooth' });
    }
  }
  input.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(() => { timer = 0; search(); }, 120); });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      if (timer) { clearTimeout(timer); timer = 0; search(); }
      step(e.shiftKey ? -1 : 1);
    } else if (e.key === 'Escape' && input.value) {
      e.preventDefault();
      e.stopPropagation();
      input.value = '';
      search();
    }
  });
})();

// Called from the OBS detail panel's own Test button (renderObsDetail,
// built dynamically now — see the Outputs master-detail redesign) — takes
// the status element + button to update directly rather than assuming a
// single fixed DOM location the way the old static card did.
async function testObsConnection(statusEl, btn) {
  if (btn) btn.textContent = 'Testing…';
  if (statusEl) statusEl.textContent = '';
  try {
    const r = await fetch(`${SERVER}/api/obs/test`);
    const d = await r.json();
    if (btn) btn.textContent = 'Test';
    if (d.success) {
      if (statusEl) { statusEl.textContent = 'Connected (OBS ' + d.version + ')'; statusEl.style.color = 'var(--green)'; }
      toast('OBS connected: v' + d.version, 'success');
    } else {
      if (statusEl) { statusEl.textContent = 'Failed: ' + d.error; statusEl.style.color = 'var(--red)'; }
      toast('OBS: ' + d.error, 'error');
    }
  } catch (e) {
    if (btn) btn.textContent = 'Test';
    if (statusEl) { statusEl.textContent = 'Error: ' + e.message; statusEl.style.color = 'var(--red)'; }
  }
}

// ── OBS: lightweight periodic status → header indicator ────────────────────
// Separate from the Test button's /api/obs/test (which opens a FRESH
// connection each click) — this just reads the server's already-tracked
// obsConnected state, cheap enough to poll on an interval.
function updateOBSHeaderStatus(connected, enabled) {
  // Two possible locations: the list row (dot only — no paired text
  // element there, just the row's own name/type) and the detail panel's
  // own header (dot AND text, only present while OBS happens to be the
  // selected output) — both re-queried fresh every call, never cached,
  // since renderOutputsList/renderOutputsDetail rebuild their hosts via
  // innerHTML='' regularly. Dot and text are updated independently, NOT
  // gated behind both existing together — a real bug this replaced: the
  // list row's dot never updated at all, because the old code required
  // BOTH to be found before touching either, and the list row never had
  // an 'obs-header-status' text element to begin with.
  const cls = 'bs-dot' + (connected ? ' connected' : enabled ? ' error' : '');
  const text = connected ? 'Connected' : enabled ? 'Not connected' : 'Off';
  for (const dotId of ['obs-header-dot', 'obs-detail-dot']) {
    const dot = document.getElementById(dotId);
    if (dot) dot.className = cls;
  }
  // The detail header's status text lives in its own nested span
  // (obs-detail-status-text), NOT directly on the wrapper that also holds
  // the dot — a real bug this fixes: setting .textContent on a wrapper
  // that has a prepended <span class="bs-dot"> child wipes the dot out
  // entirely, since textContent assignment replaces ALL child nodes.
  const txt = document.getElementById('obs-detail-status-text');
  if (txt) txt.textContent = text;
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


function closeModal() { settingsModal?.classList.add('hidden'); }

// ── Scripture Search ───────────────────────────────────────────────────────
// From the 3rd word typed, verses that contain or mean the phrase appear in a
// dropdown under the field (server: /api/search/suggest — exact order, the
// same words in any order, or the same meaning; only what clearly identifies
// a verse). One click, or arrows + Enter, sends it to the screen.
const scriptureSuggest = document.getElementById('scripture-suggest');
const SUGGEST_MIN_WORDS = 3;
const SUGGEST_DEBOUNCE_MS = 220;
const SUGGEST_WHY = { reference: 'reference', exact: 'exact phrase', words: 'same words', meaning: 'same meaning' };
let suggestSeq = 0, suggestTimer = null, suggestItems = [], suggestActive = -1;

function hideSuggest() {
  suggestSeq++;                     // any response still in flight is stale now
  clearTimeout(suggestTimer);
  suggestItems = []; suggestActive = -1;
  if (scriptureSuggest) { scriptureSuggest.hidden = true; scriptureSuggest.replaceChildren(); }
}

function renderSuggest(list) {
  suggestItems = list; suggestActive = -1;
  if (!scriptureSuggest) return;
  scriptureSuggest.replaceChildren(...list.map((v, i) => {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'cs-suggest-item';
    item.setAttribute('role', 'option');
    const head = document.createElement('div'); head.className = 'cs-suggest-head';
    const ref = document.createElement('span'); ref.className = 'cs-suggest-ref'; ref.textContent = v.reference;
    const why = document.createElement('span'); why.className = 'cs-suggest-why'; why.textContent = SUGGEST_WHY[v.match] || '';
    const text = document.createElement('div'); text.className = 'cs-suggest-text'; text.textContent = cleanVerseText(v.text || '');
    head.append(ref, why); item.append(head, text);
    // mousedown, not click: fires before the field's blur hides the list.
    item.addEventListener('mousedown', (e) => { e.preventDefault(); sendSuggestion(i); });
    return item;
  }));
  scriptureSuggest.hidden = !list.length;
}

function highlightSuggest(i) {
  suggestActive = i;
  scriptureSuggest?.querySelectorAll('.cs-suggest-item').forEach((el, k) => el.classList.toggle('active', k === i));
  scriptureSuggest?.children[i]?.scrollIntoView({ block: 'nearest' });
}

function sendSuggestion(i) {
  const v = suggestItems[i];
  if (!v) return;
  hideSuggest();
  showInViewer([v], 'search', 1.0);
  sendVerseToServer(v);
  scriptureSearchInput?.focus();
  scriptureSearchInput?.select();
}

async function fetchSuggest(query) {
  const seq = ++suggestSeq;
  try {
    const r = await fetch(`${SERVER}/api/search/suggest`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query }),
    });
    const d = await r.json();
    if (seq !== suggestSeq) return;   // the operator kept typing
    renderSuggest(d.results || []);
  } catch { if (seq === suggestSeq) renderSuggest([]); }
}

scriptureSearchInput?.addEventListener('keydown', (e) => {
  const open = scriptureSuggest && !scriptureSuggest.hidden && suggestItems.length;
  if (e.key === 'ArrowDown' && open) { e.preventDefault(); highlightSuggest((suggestActive + 1) % suggestItems.length); return; }
  if (e.key === 'ArrowUp' && open) { e.preventDefault(); highlightSuggest((suggestActive - 1 + suggestItems.length) % suggestItems.length); return; }
  if (e.key === 'Escape' && open) { e.preventDefault(); hideSuggest(); return; }
  if (e.key === 'Enter') {
    if (open && suggestActive >= 0) { e.preventDefault(); sendSuggestion(suggestActive); return; }
    hideSuggest();
    runSearch();
  }
});
scriptureSearchInput?.addEventListener('input', () => {
  const value = scriptureSearchInput.value;
  if (scriptureSearchClear) scriptureSearchClear.style.display = value ? 'flex' : 'none';
  clearTimeout(suggestTimer);
  if (value.trim().split(/\s+/).filter(Boolean).length < SUGGEST_MIN_WORDS) { hideSuggest(); return; }
  suggestTimer = setTimeout(() => fetchSuggest(value.trim()), SUGGEST_DEBOUNCE_MS);
});
scriptureSearchInput?.addEventListener('blur', () => setTimeout(hideSuggest, 120));
scriptureSearchClear?.addEventListener('click', () => {
  if (scriptureSearchInput) scriptureSearchInput.value = '';
  if (scriptureSearchClear) scriptureSearchClear.style.display = 'none';
  hideSuggest();
});

async function runSearch() {
  const raw = scriptureSearchInput?.value?.trim();
  if (!raw) return;

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
  markLiveInQueue(null);
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
  lastPreviewArgs = null;
  lastPreviewHadOwnLook = false;
}

// Output layers, bottom to top: media, slide, Bible. Clear Bible reveals the
// slide live underneath (the server re-sends it, which repaints the preview);
// Clear Slide while a scripture is up removes only the slide underneath.
async function clearOutputLayer(layer) {
  let result = {};
  try {
    const res = await fetch(`${SERVER}/api/service/clear-layer`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ layer }),
    });
    result = await res.json().catch(() => ({}));
  } catch (err) { console.warn('[KAIRO] clear-layer request failed:', err.message); }
  if (layer === 'bible') { if (!result.restored) clearPreviewScreen(); return; }
  if (layer === 'slide' || layer === 'all') {
    if (!result.keptBible) clearPreviewScreen();
    window.KairoService?.clearLive?.();
  }
  if (layer === 'media' || layer === 'all') clearMediaPreview();
}
document.getElementById('clear-bible-layer-btn')?.addEventListener('click', () => clearOutputLayer('bible'));
// Back — undo the last change to the screen (server keeps the history).
// Debounced: a menu accelerator and the in-app hotkey may both fire.
let _lastBackAt = 0;
document.getElementById('output-back-btn')?.addEventListener('click', () => {
  const now = Date.now();
  if (now - _lastBackAt < 400) return;
  _lastBackAt = now;
  fetch(`${SERVER}/api/output/back`, { method: 'POST' }).catch(err => console.warn('[KAIRO] Back failed:', err.message));
});
// Lit while a scripture covers a live slide — Clear Bible is the way back to it.
function handleLayerState(msg) {
  const btn = document.getElementById('clear-bible-layer-btn');
  if (!btn) return;
  const covering = !!(msg.bibleOnTop && msg.slideUnderneath);
  btn.classList.toggle('is-covering', covering);
  btn.title = covering ? 'A scripture is covering the live slide — clear it to return to the slide' : 'Clear the Bible layer';
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
const AUDIO_INPUT_LABEL_KEY = 'kairo-audio-input-label';
async function populateAudioDevices() {
  if (!audioSourceSettings) return;
  try {
    await navigator.mediaDevices.getUserMedia({ audio: true });
    const devices = await navigator.mediaDevices.enumerateDevices();
    const mics    = devices.filter(d => d.kind === 'audioinput');
    const saved   = localStorage.getItem(AUDIO_INPUT_KEY) || '';
    const savedLabel = localStorage.getItem(AUDIO_INPUT_LABEL_KEY) || '';
    // A device's id can change (a reinstall, the app's web data reset) while
    // its name doesn't: find the operator's input by id, then by name, rather
    // than falling back to whichever device happens to be listed first —
    // that is how a service ends up transcribing the room mic.
    const chosen = mics.find(d => d.deviceId === saved)
      || (savedLabel ? mics.find(d => d.label === savedLabel) : null);
    audioSourceSettings.innerHTML = '';
    mics.forEach(d => {
      const o = document.createElement('option');
      o.value = d.deviceId;
      o.textContent = d.label || `Microphone ${d.deviceId.slice(0, 6)}`;
      o.dataset.label = d.label || '';
      if (d === chosen) o.selected = true;
      audioSourceSettings.appendChild(o);
    });
    if (chosen) {
      localStorage.setItem(AUDIO_INPUT_KEY, chosen.deviceId);
      if (chosen.label) localStorage.setItem(AUDIO_INPUT_LABEL_KEY, chosen.label);
    }
    // The saved input isn't connected at all — say so under the picker
    // instead of silently capturing something else.
    const missing = document.getElementById('audio-input-missing');
    if (missing) {
      missing.hidden = !!chosen || !(saved || savedLabel);
      missing.textContent = `${savedLabel || 'Your saved input'} isn’t connected. Listening uses the input selected above.`;
    }
    if ((saved || savedLabel) && !chosen) {
      console.error('[KAIRO] Saved audio input device not found among current devices — falling back to', audioSourceSettings.value);
    }
  } catch {}
}

audioSourceSettings?.addEventListener('change', () => {
  localStorage.setItem(AUDIO_INPUT_KEY, audioSourceSettings.value || '');
  const label = audioSourceSettings.selectedOptions?.[0]?.dataset.label || '';
  if (label) localStorage.setItem(AUDIO_INPUT_LABEL_KEY, label);
  const missing = document.getElementById('audio-input-missing');
  if (missing) missing.hidden = true;
  // A fresh explicit choice always wins over a stale fallback from before.
  capturingFallbackDevice = false;
  // Picking a different source while a service is already live used to only
  // persist the choice for the NEXT session — the running capture kept
  // silently using the OLD device until something else (the silence
  // watchdog, a track ending) happened to trigger an unrelated rebuild.
  // Take effect immediately, same as every other live audio-recovery path.
  if (isListening) restartAudioCapture('operator-changed-source');
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
// NDJSON progress events from POST /api/offline/install into a progress bar
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

  // Original "Download offline model…" label, captured once — reused as-is
  // for a fresh install; the update case below gets its own, shorter label
  // rather than trying to keep an exact byte-size annotation in sync with
  // whatever the update download actually is.
  const downloadLabel = installBtn.textContent;

  async function refreshStatus() {
    try {
      const r = await fetch(`${SERVER}/api/offline/status`);
      const s = await r.json();
      if (s.installing) {
        statusLine.textContent = 'Install in progress…';
        installBtn.style.display = 'none';
      } else if (s.needsUpdate) {
        // A model IS present and working (isModelPresent) — just not the
        // MODEL_VERSION this build ships (see sherpa_installer.js's own
        // comment). Distinct from "not installed" so it doesn't read as a
        // fresh operator never having set this up at all.
        statusLine.textContent = 'Update available for the offline model.';
        statusLine.style.color = '';
        installBtn.textContent = 'Update offline model';
        installBtn.style.display = '';
      } else if (s.installed) {
        statusLine.textContent = '✓ Offline model installed';
        statusLine.style.color = 'var(--accent)';
        installBtn.style.display = 'none';
      } else {
        statusLine.textContent = 'Offline model not installed.';
        statusLine.style.color = '';
        installBtn.textContent = downloadLabel;
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
      res = await fetch(`${SERVER}/api/offline/install`, { method: 'POST' });
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
// Same NDJSON-progress pattern as the offline-model installer above, for the
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

// ── Bible tab toolbar: Primary + Translation dropdowns ──────────────────
// Owner: "in bible menu, there should be 2 dropdowns, 1 for primary and
// translation... let the dropdowns be beside each other." Translation
// drives the SAME settings.bibleTranslateTo the Multi-Language theme's own
// "Translate to" popover (service.js) already used — surfaced directly
// here instead of requiring Theme → Multi-Language → Translate to. Options
// populated from MT_LANGUAGES so it can't drift from every other
// translate-language picker in the app.
if (bibleTranslateToSelect) {
  MT_LANGUAGES.forEach(({ code, name }) => {
    const opt = document.createElement('option');
    opt.value = code;
    opt.textContent = name;
    bibleTranslateToSelect.appendChild(opt);
  });
  bibleTranslateToSelect.value = settings.bibleTranslateTo || '';
  bibleTranslateToSelect.addEventListener('change', () => {
    settings.bibleTranslateTo = bibleTranslateToSelect.value || null;
    saveSettingsPatch({ bibleTranslateTo: settings.bibleTranslateTo });
  });
}

// Primary — real incident found while wiring the new dropdown alongside it:
// this toolbar select (#translation-select) has existed for a while but
// never actually had a live change listener of its own; it only ever
// mirrored settings.translation FROM elsewhere (loadSettings above), so
// changing it here silently did nothing until a full Settings-modal Save
// happened to read the SEPARATE #translation-select-settings dropdown
// instead. Wired for real now, matching every other toolbar control's
// live-apply behavior.
translationSelect?.addEventListener('change', () => {
  settings.translation = translationSelect.value;
  if (translationSettings) translationSettings.value = translationSelect.value;
  saveSettingsPatch({ translation: settings.translation });
});

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

  // Owner: "when a user clicks on french translation, it should
  // retroactively download the french bible... so the translation can be
  // correct." Investigated — there was never actually a missing download:
  // every MT_LANGUAGES entry has a real, already-bundled Bible translation
  // (databases/i18n/{code}.json — server.js's translate() tries this FIRST,
  // before ever touching the MT model), so scripture on the Multi-Language
  // split theme already works the instant a language is picked, zero
  // setup. This model download is only for translating NON-scripture slide/
  // announcement text (translate.js's own header comment: "Anything else...
  // run it through a dedicated translation model"). The copy below used to
  // just say "isn't downloaded yet", reading as if the language itself
  // wasn't ready — misleading for exactly the scripture use case this app
  // is built around.
  container.className = 'osp osp-warn';
  container.innerHTML =
    _inlineMtTitle(container, '', `Scripture in ${escapeHtml(name)} is ready — no download needed`) +
    `<p class="osp-msg">To also translate non-scripture slides/announcements into ${escapeHtml(name)}, install the local model${status.approxMB ? ` (~${status.approxMB}MB)` : ''} — runs offline once installed.</p>` +
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

// The semantic layer ("meaning-based Candidates") used to have its own
// install/download UI+polling here — owner, 2026-09-22: "this is part of
// our engine, it should be bundled up with the app... users should not
// know it's there." The model is already a bundled resource
// (tauri.conf.json) and loads automatically on startup — there was never
// really anything for a user to install. Removed; see index.html's own
// comment at the former "Meaning-Based Candidates" settings section for
// the full explanation.

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
      if (kind === 'notes') openSermonNotesDialog();
      else if (kind === 'verses' || kind === 'transcript') await exportSession(kind);
    } catch (err) {
      toast('Download failed: ' + (err.message || err), 'error');
    }
  });
})();

// Exports are written to Downloads by the server and opened there — the app's
// webview can't save a page-side download (see /api/export).
async function exportSession(kind, name = '') {
  const res = await fetch(`${SERVER}/api/export`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kind, name, transcript: sessionTranscriptParts, verses: sessionVerses }),
  });
  const out = await res.json().catch(() => ({}));
  if (!res.ok || !out.ok) throw new Error(out.error || `HTTP ${res.status}`);
  return out;
}

// Export → Sermon notes: ask for the sermon's name, then build the PDF.
function openSermonNotesDialog() {
  const modal = document.getElementById('sermon-notes-modal');
  const input = document.getElementById('sn-name');
  const status = document.getElementById('sn-status');
  const btn = document.getElementById('sn-download');
  if (!modal) return;
  const hint = 'The key things said, each point of the sermon and the scriptures under it — saved as a PDF in Downloads.';
  status.textContent = sessionTranscriptParts.length ? hint : 'Nothing captured yet — start listening first, then come back here.';
  btn.disabled = !sessionTranscriptParts.length;
  modal.classList.remove('hidden');
  setTimeout(() => input.focus(), 0);
}
(function wireSermonNotesDialog() {
  const modal = document.getElementById('sermon-notes-modal');
  if (!modal) return;
  const input = document.getElementById('sn-name');
  const status = document.getElementById('sn-status');
  const btn = document.getElementById('sn-download');
  const close = () => { modal.classList.add('hidden'); btn.textContent = 'Download PDF'; };
  document.getElementById('close-sermon-notes')?.addEventListener('click', close);
  document.getElementById('sn-cancel')?.addEventListener('click', close);
  modal.querySelector('.modal-overlay')?.addEventListener('click', close);
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') btn.click(); if (e.key === 'Escape') close(); });
  btn.addEventListener('click', async () => {
    btn.disabled = true; btn.textContent = 'Preparing…';
    try {
      const out = await exportSession('notes', input.value.trim());
      status.textContent = `Saved to Downloads: ${out.file}`;
      setTimeout(close, 1400);
    } catch (err) {
      status.textContent = `Couldn't create the notes: ${err.message}`;
      btn.textContent = 'Download PDF';
    } finally {
      btn.disabled = false;
    }
  });
})();

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
