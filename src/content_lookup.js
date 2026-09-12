// KAIRO — Content lookup ("what's being said matches a song/slide deck
// that's staged and ready — bring it up automatically")
//
// Scripture detection already does the "listen cold, no live item needed,
// send what matches" job for Bible verses (server/detection_worker.js
// against the ~31,000-verse corpus). This is the SAME idea scoped to the
// operator's OWN playlist: if what's being sung/preached clearly matches
// the OPENING of a song or slide deck that's staged in the current
// service but not yet live, bring it up — the same way a verse just gets
// sent the moment it's recognised.
//
// Deliberately separate from src/lyrics_follow.js and src/sermon_follow.js,
// which is a different job: THIS decides WHICH item should be live; THOSE
// two track position WITHIN an item that already is. Once this brings a
// song or sermon deck up, the existing per-item auto-follow machinery
// (already wired in service.js's sendSlide) takes over from there exactly
// as if the operator had clicked it themselves.
//
// A wrong autonomous send here is worse than a missed one — it visibly
// interrupts whatever's live on a real screen behind the platform, not
// just a slow slide flip. So this leans hard toward silence: a genuinely
// confident match (real vocabulary overlap, a real lead over any other
// candidate, sustained for a moment rather than a one-word blip) fires;
// anything less just does nothing and waits for the operator.
'use strict';

(function (root) {

  const LF = (typeof window !== 'undefined' && window.KairoLyricsFollow)
    || (typeof require === 'function' ? require('./lyrics_follow.js') : null);
  if (!LF) throw new Error('content_lookup.js requires lyrics_follow.js to be loaded first');
  const { tokenizeKeys, keyMatch } = LF;

  const DEFAULTS = {
    tailWords: 30,       // recent transcript window scored each ingest
    confMatch: 0.55,     // a candidate needs at least this fraction of its opening line's
                          // distinctive words heard before it's even considered
    leadMargin: 1.5,     // ...and must beat the SECOND-best candidate by this multiplier —
                          // a close call between two songs stays silent, not a coin flip
    minHits: 4,          // never fire on fewer than this many distinct keyword hits —
                          // rules out a false positive from one or two common words
    sustainMs: 1500,     // the same candidate must stay the clear best for this long
                          // before firing — one lucky transcript window isn't enough
    missGraceMs: 800,    // a single below-threshold partial (Whisper revising its
                          // window, a short pause) doesn't reset the sustain clock —
                          // only losing the lead for longer than this does
    cooldownMs: 20000,   // minimum gap between two autonomous sends, so a burst of
                          // matching speech can't fire twice in quick succession
  };

  // Mirrors service.js's own imageTriggerPhrase() — kept as a small
  // duplicate rather than a cross-module call since this file is a
  // standalone module loaded independently of service.js's closure. An
  // image block has no typed text of its own to match against; the owner's
  // own rule for that case ("if they name the image a custom name, or even
  // the image file name is called, it goes up") already governs the SAME
  // gap for within-item advance (service.js's announcementShapeForFollow) —
  // reused here so a slide deck that's entirely images isn't invisible to
  // auto-lookup just because it has no typed lyric text. Without this, a
  // real hymn's slides added as images (e.g. via the Media Bin drag-and-
  // drop) could never be found by content-lookup at all, regardless of how
  // well the transcript matched what's actually being sung.
  function imageTriggerPhrase(b) {
    if (b.label && !/^slide\s+\d+$/i.test(b.label)) return b.label;
    if (b.imageFileName) return b.imageFileName.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ');
    return '';
  }

  // A candidate's fingerprint is its OPENING content — the first block of a
  // song (verse 1) or the first slide of a deck — because that's what's
  // actually being said the MOMENT it needs to be caught. Matching against
  // the whole item would just as often light up on a chorus repeated from
  // whatever's already live.
  function openingText(item) {
    if (item.type === 'song') return (item.blocks || []).slice(0, 1).map(b => (b.lines || []).join(' ')).join(' ');
    if (item.type === 'slides') {
      return (item.blocks || []).slice(0, 1).map(b => b.text || (b.image ? imageTriggerPhrase(b) : '')).join(' ');
    }
    return '';
  }

  function buildCandidate(item) {
    const keys = tokenizeKeys(openingText(item));
    return { id: item.id, item, keys, keySet: new Set(keys) };
  }

  function ContentLookup(opts) {
    opts = opts || {};
    this.cfg = Object.assign({}, DEFAULTS, opts.config || {});
    this.candidates = [];
    this.onMatch = opts.onMatch || function () {};
    this._bestId = null;
    this._bestSince = 0;
    this._bestLastSeenAt = 0;
    this._lastFireAt = 0;
    this.enabled = true;
  }

  // Rebuild the pool of "available, not-yet-live" items to watch for.
  // Cheap — tokenizing one short opening line per item, not a whole song/
  // deck — safe to call on every playlist change.
  ContentLookup.prototype.setCandidates = function (items) {
    this.candidates = (items || [])
      .map(buildCandidate)
      .filter(c => c.keys.length >= this.cfg.minHits);
  };

  ContentLookup.prototype.ingest = function (text, meta) {
    if (!this.enabled || !this.candidates.length) return;
    const now = (meta && meta.now) || Date.now();
    if (now - this._lastFireAt < this.cfg.cooldownMs) return;
    const keys = tokenizeKeys(text).slice(-this.cfg.tailWords);
    if (!keys.length) return;

    let best = null, secondScore = 0;
    for (const c of this.candidates) {
      const seen = new Set();
      for (const r of keys) {
        for (const k of c.keySet) {
          if (seen.has(k)) continue;
          if (keyMatch(r, k)) { seen.add(k); break; }
        }
      }
      if (seen.size < this.cfg.minHits) continue;
      const score = seen.size / Math.max(1, c.keys.length);
      if (!best || score > best.score) {
        if (best) secondScore = Math.max(secondScore, best.score);
        best = { c, score };
      } else {
        secondScore = Math.max(secondScore, score);
      }
    }

    if (!best || best.score < this.cfg.confMatch
      || (secondScore > 0 && best.score < secondScore * this.cfg.leadMargin)) {
      // No qualifying candidate this window — a single jittery partial (a
      // dropped word, Whisper revising its tail) shouldn't discard a real
      // run in progress, only an actual gap longer than missGraceMs should.
      if (this._bestId && now - this._bestLastSeenAt > this.cfg.missGraceMs) this._bestId = null;
      return;
    }

    if (this._bestId !== best.c.id) {
      this._bestId = best.c.id;
      this._bestSince = now;
      this._bestLastSeenAt = now;
      return; // seen it once — needs to hold before it's trusted
    }
    this._bestLastSeenAt = now;
    if (now - this._bestSince < this.cfg.sustainMs) return;

    this._lastFireAt = now;
    this._bestId = null;
    this.onMatch({ item: best.c.item, confidence: best.score });
  };

  const API = { ContentLookup };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root) root.KairoContentLookup = API;

})(typeof window !== 'undefined' ? window : null);
