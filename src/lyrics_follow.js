// KAIRO — Lyric follower ("karaoke" auto-advance)
//
// Given the song that's live and a rolling speech transcript of what's being
// sung, keep a cursor on the current position in the lyrics and advance the
// slide when the singers cross into the next block.
//
// This is ALIGNMENT, not transcription. We already know the song — we're
// tracking a position in a known token stream, not recognising open
// vocabulary. That's a far easier and more robust problem than STT, and it's
// why bad transcript words don't sink it: the aligner only needs a few of
// the recent words to land in the expected place.
//
// Runs client-side (service.js already knows the live song + block index,
// already receives {type:'transcript'} over the WS, and already has the
// slide-advance call). The same engine is import-able in Node for the replay
// harness (scripts/follow-replay.js) — see the dual export at the bottom.
//
// Design notes:
//  • The cursor only moves FORWARD. A repeated chorus is just "stay put";
//    a chorus repeated out of the arrangement stops aligning, confidence
//    decays, and the follower FREEZES rather than guessing — a wrong
//    auto-advance mid-worship is glaring, a missed one is one click.
//  • "Last 2–3 words of the block" ARMS an advance (anticipation, so the
//    slide flips as the last word lands). "First words of the next block
//    heard" is the CATCH-UP trigger. Both feed the same cursor.
//  • Whisper re-transcribes its whole growing window each partial and can
//    revise earlier words, so we never build incremental state from a
//    partial — every ingest re-aligns only the RECENT TAIL of the
//    transcript against a forward window of the lyrics. Stateless per call,
//    immune to the window being rewritten underneath us.
'use strict';

(function (root) {

  // ── normalisation ──────────────────────────────────────────────────────
  // Common sung-worship / STT confusions — folded so "thee"/"the",
  // "o"/"oh", "'tis"/"it is" don't cost a match. Kept small on purpose:
  // over-folding erases the distinctive words the aligner leans on.
  const STT_SWAP = {
    thee: 'the', thou: 'the', thy: 'the', thine: 'the', ye: 'you',
    o: 'oh', ah: 'oh', tis: 'itis', twas: 'itwas', ere: 'before',
    unto: 'to', upon: 'on', art: 'are', hath: 'has', doth: 'does',
    'gonna': 'goingto', 'wanna': 'wantto',
  };

  function norm(w) {
    return String(w || '').toLowerCase().replace(/[^a-z0-9]/g, '');
  }

  // Cheap phonetic-ish key: fold the swap table, collapse doubled letters,
  // a few digraph reductions, drop a trailing "e", "-ing" → "-in". Good
  // enough to absorb the bulk of STT noise on English hymn/worship text
  // without a real metaphone implementation.
  function key(raw) {
    let w = norm(raw);
    if (!w) return '';
    if (STT_SWAP[w]) w = STT_SWAP[w];
    w = w.replace(/(.)\1+/g, '$1');
    w = w.replace(/ph/g, 'f').replace(/wr/g, 'r').replace(/kn/g, 'n').replace(/gh/g, '');
    w = w.replace(/ing$/, 'in');
    if (w.length > 3) w = w.replace(/e$/, '');
    return w;
  }

  function tokenizeKeys(text) {
    return String(text || '').split(/\s+/).map(key).filter(Boolean);
  }

  // Same key() folding as tokenizeKeys, but keeps each surviving key's real
  // audio-relative start/end (seconds) alongside it. Fed from Deepgram's own
  // `words` array (always present on a transcript event, no config needed)
  // or Whisper's word-level timestamps — threaded through server.js -> WS ->
  // onTranscript's meta.words. Built directly from the source `words` array
  // (not a separate map-then-filter pass against tokenizeKeys' own output),
  // so a dropped empty-key word can never desync a key from the wrong
  // timestamp the way two independently-filtered parallel arrays could.
  function tokenizeKeysWithTimes(words) {
    const out = [];
    for (const w of (words || [])) {
      const k = key(w && w.word);
      if (k) out.push({ key: k, start: w.start, end: w.end });
    }
    return out;
  }

  // Two keys "match" if equal, or one is a prefix of the other and the
  // shorter is at least 4 chars (catches "believ"/"believed", "sing"/
  // "singing" that survived the -ing fold, etc.) — never for short keys,
  // where a prefix collision is usually coincidence.
  function keyMatch(a, b) {
    if (!a || !b) return false;
    if (a === b) return true;
    const [s, l] = a.length <= b.length ? [a, b] : [b, a];
    return s.length >= 4 && l.startsWith(s);
  }

  // Words that carry no positional information in worship lyrics — a match
  // on one of these must never, on its own, move the cursor.
  const STOP = new Set(('the a an and or but of to in on at is are be am was were '
    + 'i you he she it we they me my your his her our their this that with for as '
    + 'oh yeah now all we\'ll i\'ll so do did done have has had will would can could '
    + 'lord god jesus christ holy hallelujah hosanna amen').split(/\s+/).map(key));

  // ── flatten a song into a token stream with block boundaries ────────────
  // song.blocks: [{ label, lines: [string] }]  (Kairo's hymn/song shape)
  function flattenSong(song, cfg) {
    const tailN = (cfg && cfg.tailN) || 3;
    const headN = (cfg && cfg.headN) || 3;
    const tokens = [];
    const blocks = [];
    (song && song.blocks || []).forEach((b, bi) => {
      const words = tokenizeKeys((b.lines || []).join(' '));
      const start = tokens.length;
      words.forEach((k) => tokens.push({ key: k, blockIdx: bi }));
      const end = tokens.length; // exclusive
      blocks.push({ idx: bi, label: b.label || ('Part ' + (bi + 1)), start, end, len: end - start });
    });
    // Per-song "distinctiveness" of each key — a word repeated across the
    // whole song (a refrain hook, "grace", "holy") localises far less than
    // one that appears once. weight ∈ (0,1]; stopwords are floored low so a
    // run of them can't drag the cursor.
    const freq = new Map();
    tokens.forEach(t => freq.set(t.key, (freq.get(t.key) || 0) + 1));
    const weightOf = (k) => {
      if (STOP.has(k)) return 0.12;
      const f = freq.get(k) || 1;
      return 1 / (1 + Math.log2(f));
    };
    tokens.forEach(t => { t.w = weightOf(t.key); });

    blocks.forEach((b) => {
      for (let i = Math.max(b.start, b.end - tailN); i < b.end; i++) if (tokens[i]) tokens[i].tail = true;
      for (let i = b.start; i < Math.min(b.end, b.start + headN); i++) if (tokens[i]) tokens[i].head = true;
      // headKeys: the distinctive words that open the block — the catch-up
      // signal ("we're clearly singing the next verse now") keys off these,
      // not off raw cursor position, which repeated vocabulary inflates.
      b.headKeys = [];
      for (let i = b.start; i < Math.min(b.end, b.start + 6); i++) {
        if (tokens[i] && !STOP.has(tokens[i].key)) b.headKeys.push(tokens[i].key);
      }
    });
    return { tokens, blocks, weightOf };
  }

  // ── the follower ───────────────────────────────────────────────────────
  const DEFAULTS = {
    tailWords: 10,       // how many recent transcript words to re-align each ingest
    windowBase: 16,      // forward lyric span = windowBase + what's left of this block
    maxSkip: 3,          // max lyric tokens skipped between two matched words
    minDwellMs: 2500,    // floor; the real dwell scales with block length (see _dwell)
    dwellFrac: 0.35,     // ...to at least this fraction of the block's expected duration
    lookaheadSec: 1.1,   // fire this far before the predicted block end (anticipation)
    tailN: 3, headN: 3,  // block tail / head token counts
    confAdvance: 0.42,   // min confidence for an anticipation advance
    confHold: 0.25,      // below this, freeze — do not advance at all
    minRun: 3,           // a position lock needs a contiguous run of >= this many matches
    minRunWeight: 1.1,   // ...whose distinctiveness weight sums to >= this
    headHitsToCatchUp: 2,// this many of the next block's head keys, heard recently → advance
    emitThrottleMs: 200,
    // How many blocks ahead of the immediate next one a catch-up may skip
    // past in one jump. 1 (the historical, unconfigurable behavior — only
    // blockIdx+2 was ever considered) is right for songs: a verse genuinely
    // dropped live is the rare case, and a real arrangement change further
    // out is much more likely to be an unrelated word collision than a
    // deliberate multi-verse skip. A caller tracking a deck presented in
    // whatever order the presenter chooses (announcement slides, not sung
    // in a fixed arrangement) sets this higher to search the whole rest of
    // the deck instead.
    maxBlockSkip: 1,
  };

  function LyricsFollower(song, opts) {
    opts = opts || {};
    const cfg = Object.assign({}, DEFAULTS, opts.config || {});
    const flat = flattenSong(song, cfg);

    this.cfg = cfg;
    this.tokens = flat.tokens;
    this.blocks = flat.blocks;
    this.pos = 0;            // cursor: index into tokens of the next word expected
    this.blockIdx = 0;       // the block currently DISPLAYED (only moves via _advance)
    this.confidence = 0;     // 0..1, EMA of recent alignment quality
    this.rate = 2.3;         // tokens/sec, EMA
    this.armed = false;
    this._lastMatchAt = 0;
    // null, not 0 — this class is fed either real Date.now() or (see
    // scripts/follow-replay.js) a synthetic clock starting near 0, and
    // there's no absolute timestamp that's safely "in the past" for both
    // domains. null is a sentinel _maybeAdvance checks for explicitly:
    // the dwell floor simply doesn't apply until a real advance/resync has
    // actually set this once, in whatever clock domain ingest() is being
    // called with — fixes the very first advance being either completely
    // dwell-unprotected (a literal 0 under a real epoch) or permanently
    // dwell-BLOCKED (0 under a synthetic clock that starts near 0 itself).
    this._lastAdvanceAt = null;
    this._lastEmitAt = 0;
    this.onPosition = opts.onPosition || function () {};
    this.onAdvance = opts.onAdvance || function () {};
    this.enabled = true;
  }

  // Operator override — snap the cursor to a block (manual next/prev, or a
  // direct slide click). Auto-follow continues from there.
  LyricsFollower.prototype.resync = function (blockIdx, now) {
    const b = this.blocks[blockIdx];
    if (!b) return;
    this.pos = b.start;
    this.blockIdx = blockIdx;
    this.armed = false;
    this._lastAdvanceAt = now || Date.now();
    this.confidence = Math.max(this.confidence, 0.5); // trust the human
  };

  LyricsFollower.prototype.snapshot = function () {
    const b = this.blocks[this.blockIdx];
    return {
      blockIdx: this.blockIdx,
      blockLabel: b ? b.label : null,
      confidence: Math.round(this.confidence * 100) / 100,
      rate: Math.round(this.rate * 100) / 100,
      posInBlock: b ? Math.max(0, Math.min(1, (this.pos - b.start) / Math.max(1, b.len))) : 0,
      armed: this.armed,
      frozen: this.confidence < this.cfg.confHold,
    };
  };

  // Align the recent transcript tail against a forward span of the lyrics.
  // A "lock" is a CONTIGUOUS run of matches (small skips allowed for dropped
  // STT words) whose distinctiveness weight clears a floor — scattered
  // matches on repeated/common words don't count, which is what stops the
  // cursor leaping ahead on "holy / lord / grace". Returns
  // { endPos, run, weight, score } or null.
  LyricsFollower.prototype._alignForward = function (recent) {
    const { maxSkip, minRun, minRunWeight } = this.cfg;
    const toks = this.tokens;
    const b = this.blocks[this.blockIdx];
    const blockLeft = b ? Math.max(0, b.end - this.pos) : 0;
    const hi = Math.min(toks.length, this.pos + this.cfg.windowBase + blockLeft + 8);
    let best = null;

    for (let s = this.pos; s < hi; s++) {
      // Only start a run where the first recent-ish word actually lands —
      // find which recent word matches toks[s], then walk both forward.
      for (let r0 = 0; r0 < recent.length; r0++) {
        if (!keyMatch(recent[r0], toks[s].key)) continue;
        let li = s, ri = r0, run = 0, weight = 0, lastLi = s - 1, gaps = 0;
        while (ri < recent.length && li < hi) {
          if (keyMatch(recent[ri], toks[li].key)) {
            run++; weight += toks[li].w; lastLi = li; ri++; li++;
          } else {
            let hop = 0;
            for (let k = 1; k <= maxSkip && li + k < hi; k++) {
              if (keyMatch(recent[ri], toks[li + k].key)) { hop = k; break; }
            }
            if (hop) { li += hop; gaps += hop; }   // STT dropped a lyric word
            else break;                            // run ends
          }
        }
        if (run < 2) continue;
        // A contiguity + weight score; long clean runs of distinctive words win.
        const score = weight / (1 + gaps * 0.5);
        // r0/riEnd: the [start, end) span of THIS call's `recent` array that
        // the winning run actually matched — lets ingest() look up the real
        // audio timestamps of exactly those words (see tokenizeKeysWithTimes)
        // rather than the lyric tokens, which have no timestamps of their own.
        if (!best || score > best.score) best = { endPos: lastLi + 1, run, weight, gaps, score, r0, riEnd: ri };
        break; // first landing point for this s is enough
      }
    }
    if (!best) return null;
    best.locked = best.run >= minRun && best.weight >= minRunWeight;
    return best;
  };

  // Recent distinctive words that match a block's head keys — the catch-up
  // signal. Returns how many head keys were heard.
  LyricsFollower.prototype._headHits = function (recent, blockIdx) {
    const b = this.blocks[blockIdx];
    if (!b || !b.headKeys.length) return 0;
    let hits = 0;
    for (const hk of b.headKeys) if (recent.some(r => keyMatch(r, hk))) hits++;
    return hits;
  };

  LyricsFollower.prototype._dwell = function () {
    const b = this.blocks[this.blockIdx];
    const expMs = b ? (b.len / Math.max(0.6, this.rate)) * 1000 : 0;
    return Math.max(this.cfg.minDwellMs, expMs * this.cfg.dwellFrac);
  };

  LyricsFollower.prototype._maybeAdvance = function (now, recent) {
    const b = this.blocks[this.blockIdx];
    const next = this.blocks[this.blockIdx + 1];
    if (!b || !next) return;
    if (this._lastAdvanceAt !== null && now - this._lastAdvanceAt < this._dwell()) return;

    // A block's own distinctive opening words being clearly heard is
    // checked BEFORE the frozen/confidence gate below, and can override it
    // — deliberately, for BOTH the immediate next block and any farther one
    // maxBlockSkip allows. Confidence is built entirely by _alignForward's
    // windowed search against blocks NEAR the current position (see its own
    // `hi` bound), so it structurally can never rise on its own from a
    // presenter/singer who's jumped ahead without ever touching the blocks
    // in between, OR from real ASR noise degrading the in-block alignment
    // right at a transition (Whisper re-transcribing its whole growing
    // window can revise/drop earlier words between calls — see this file's
    // own top-of-file note — which the smooth, always-appending replay
    // harness doesn't fully exercise). A direct headHits hit against a
    // specific block is independent, self-contained evidence either way —
    // the same "trust this strong automatic signal" reasoning resync()
    // already applies for a manual operator jump (which also bumps
    // confidence directly rather than waiting for the normal path to earn
    // it), now leaned on more than the fragile continuous-tracking
    // confidence path, closer to how a music app trusts a confirmed lyric
    // match over guessed playback position. Farthest first, so a block
    // that's genuinely been skipped past wins over a partial coincidence on
    // a nearer one; blockIdx+1 is checked last (maxBlockSkip defaults to 1,
    // so ordinarily this only ever considers +1 — the loop still runs for
    // it, just with a single iteration).
    // far ranges maxBlockSkip .. 0 so idx covers blockIdx+1+maxBlockSkip down
    // to blockIdx+1 itself (far=0) — farthest-first throughout, the same
    // order the original code used for its own blockIdx+2-before-blockIdx+1
    // tie-break, just unified into one sweep instead of two separate checks.
    let target = null;
    for (let far = this.cfg.maxBlockSkip; far >= 0; far--) {
      const idx = this.blockIdx + 1 + far;
      if (!this.blocks[idx]) continue;
      if (this._headHits(recent, idx) >= this.cfg.headHitsToCatchUp) { target = idx; break; }
    }
    if (target != null) this.confidence = Math.max(this.confidence, 0.5); // trust it, like resync()

    if (target == null) {
      if (this.confidence < this.cfg.confHold) return; // frozen — wait for lock

      if (this.pos >= b.end - this.cfg.tailN) this.armed = true;

      // Anticipation only — armed, confident, predicted block end is near.
      // The ordinary next-block catch-up is already covered by the
      // anchor-confirm loop above; this is genuinely the only path left
      // that depends on the continuous position/rate estimate.
      const secsToEnd = Math.max(0, b.end - this.pos) / Math.max(0.6, this.rate);
      const anticipate = this.armed
        && this.confidence >= this.cfg.confAdvance
        && secsToEnd <= this.cfg.lookaheadSec;

      if (!anticipate) return;
      target = this.blockIdx + 1;
    }

    this.blockIdx = target;
    if (this.pos < this.blocks[target].start) this.pos = this.blocks[target].start;
    this.armed = false;
    this._lastAdvanceAt = now;
    this.onAdvance({ toBlockIdx: target, label: this.blocks[target].label, confidence: this.confidence });
  };

  LyricsFollower.prototype._emit = function (now) {
    if (now - this._lastEmitAt < this.cfg.emitThrottleMs) return;
    this._lastEmitAt = now;
    this.onPosition(this.snapshot());
  };

  // text: the transcript segment (full text of the current window is fine —
  // we only look at its tail). isFinal is accepted for parity with the WS
  // payload but doesn't change handling: every call re-aligns the tail.
  // meta.words (optional): [{word, start, end}] real per-word timestamps
  // (seconds) — Deepgram always includes these; Whisper can via word/token
  // timestamps. When present, `rate` is updated from the actual elapsed
  // AUDIO time of the matched words instead of wall-clock arrival timing,
  // which is a poor proxy since ASR delivers text in irregular bursts, not
  // smoothly. Falls back to the previous wall-clock estimate when absent.
  LyricsFollower.prototype.ingest = function (text, meta) {
    if (!this.enabled) return;
    const now = (meta && meta.now) || Date.now();
    const timed = meta && Array.isArray(meta.words) && meta.words.length
      ? tokenizeKeysWithTimes(meta.words) : null;
    const keys = timed ? timed.map(t => t.key) : tokenizeKeys(text);
    if (!keys.length) { this._emit(now); return; }
    const recent = keys.slice(-this.cfg.tailWords);
    const recentTimes = timed ? timed.slice(-this.cfg.tailWords) : null;
    const curBlock = this.blocks[this.blockIdx];

    const m = this._alignForward(recent);
    if (m) {
      // Move the cursor to the run's end. Crossing OUT of the current block
      // needs a real lock (contiguous run of distinctive words) — inside the
      // block, a soft match is enough to track along the line.
      const crossesOut = curBlock && m.endPos > curBlock.end;
      const mayMove = m.endPos > this.pos && (m.locked || !crossesOut);
      if (mayMove) {
        let usedRealTime = false;
        if (recentTimes) {
          const startT = recentTimes[m.r0] && recentTimes[m.r0].start;
          const endT = recentTimes[m.riEnd - 1] && recentTimes[m.riEnd - 1].end;
          if (startT != null && endT != null && endT > startT) {
            const elapsed = endT - startT;
            if (elapsed > 0.15) {
              const inst = (m.endPos - this.pos) / elapsed;
              if (inst > 0 && inst < 12) { this.rate = this.rate * 0.7 + inst * 0.3; usedRealTime = true; }
            }
          }
        }
        if (!usedRealTime && this._lastMatchAt) {
          const dt = (now - this._lastMatchAt) / 1000;
          if (dt > 0.15) {
            const inst = (m.endPos - this.pos) / dt;
            if (inst > 0 && inst < 12) this.rate = this.rate * 0.7 + inst * 0.3;
          }
        }
        this.pos = m.endPos;
        this._lastMatchAt = now;
      }
      const target = m.locked ? 0.92 : 0.5;
      this.confidence = this.confidence * (m.locked ? 0.5 : 0.72) + target * (m.locked ? 0.5 : 0.28);
    } else {
      this.confidence *= 0.8; // nothing lined up — decay toward freeze
    }

    this._maybeAdvance(now, recent);
    this._emit(now);
  };

  const API = { LyricsFollower, flattenSong, key, keyMatch, tokenizeKeys, tokenizeKeysWithTimes, DEFAULTS };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root) root.KairoLyricsFollow = API;

})(typeof window !== 'undefined' ? window : null);
