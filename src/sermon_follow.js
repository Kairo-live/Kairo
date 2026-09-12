// KAIRO — Sermon slide follower (speech-driven auto-advance for a plain
// slide deck — the "300 slides for one sermon" case)
//
// Same job as lyrics_follow.js (keep a cursor on a live speech transcript,
// advance the slide when the speaker crosses into the next one) but for a
// fundamentally noisier signal: hymn lyrics are SUNG verbatim from a known
// script, so the aligner can chase an exact token position. A sermon is
// PARAPHRASED — a slide titled "3 Keys to Faith" might be introduced as
// "there are three things I want you to understand about faith today", with
// zero literal token overlap on the number or the connecting words. Chasing
// an exact position doesn't work here; what DOES carry across is the
// DISTINCTIVE VOCABULARY — names, key nouns, the words a preacher actually
// reaches for when they're on that specific point.
//
// So this is deliberately NOT a port of the lyrics aligner's token-position
// state machine. It's closer to the scripture-detection engine's own idea
// (match a rolling transcript window against known text by vocabulary
// overlap, weighted by how distinctive each word is) but scoped down to a
// FORWARD WINDOW of upcoming slides instead of the whole 31,000-verse
// corpus — a sermon deck is already roughly in delivery order (the operator
// built it to preach through top to bottom), so the search only needs to
// ask "which of the next ~N slides are we on", not "which of all 300".
// That keeps it cheap per transcript update and, just as importantly, keeps
// a stray keyword match on slide 240 from yanking the cursor there while
// the sermon is actually on slide 12.
//
// Same operating principle as the lyrics follower: this only ever moves
// FORWARD, and degrades by FREEZING (stop advancing, wait for a real
// signal) rather than guessing — a wrong auto-advance mid-sermon is glaring
// on a real screen behind the preacher; a missed one costs the operator one
// click, exactly the asymmetry lyrics_follow.js is built around too.
//
// Runs client-side (service.js already receives {type:'transcript'} over
// the WS and already has the slide-send path). Reuses lyrics_follow.js's
// own tokenizer/STT-confusion table (window.KairoLyricsFollow) rather than
// duplicating it — the "thee/thou/oh" folding matters just as much for
// spoken sermon text as sung lyrics, and there's no reason for the two
// engines to drift on what counts as the same word.
'use strict';

(function (root) {

  const LF = (typeof window !== 'undefined' && window.KairoLyricsFollow)
    || (typeof require === 'function' ? require('./lyrics_follow.js') : null);
  if (!LF) throw new Error('sermon_follow.js requires lyrics_follow.js to be loaded first');
  const { tokenizeKeys, keyMatch } = LF;

  // Slightly different stopword set from the lyrics one — sermon speech
  // leans harder on a handful of connective/filler words a worship lyric
  // rarely uses ("today", "really", "going", "just", "think"), which would
  // otherwise falsely inflate matches against ANY slide.
  const STOP = new Set((
    'the a an and or but of to in on at is are be am was were i you he she it we they '
    + 'me my your his her our their this that with for as so do did done have has had '
    + 'will would can could should just really very now today going want know think say '
    + 'said look see get got one two three thing things want going gonna about all right '
    + 'well like when what who how why lord god jesus christ church amen'
  ).split(/\s+/).map(w => tokenizeKeys(w)[0]).filter(Boolean));

  // A key counts as a "hit" only if it's at least this distinctive —
  // generalises the STOP list (whose words are floored to weight 0.08,
  // always under this) to ANY near-universal word (e.g. a connector phrase
  // repeated on most slides), which is just as uninformative about WHICH
  // slide is live and shouldn't count toward minSlideHits or the match
  // fraction either.
  const HIT_WEIGHT_FLOOR = 0.15;

  // ── flatten a deck into per-slide keyword sets ──────────────────────────
  // deck.slides: [string] — plain slide text (title + body, whatever's on
  // it), same shape as a 'slides'-type item's own blocks after joining.
  function flattenDeck(deck) {
    const slides = (deck && deck.slides || []).map((text, i) => {
      const keys = tokenizeKeys(text);
      return { idx: i, keys, keySet: new Set(keys) };
    });
    // Per-deck distinctiveness, same idea as flattenSong's weightOf — a
    // word that shows up on 40 of 300 slides ("faith", "grace") localises
    // almost nothing; one that appears on a single slide is a strong
    // signal the moment it's heard.
    const freq = new Map();
    slides.forEach(s => s.keys.forEach(k => freq.set(k, (freq.get(k) || 0) + 1)));
    const weightOf = (k) => {
      if (STOP.has(k)) return 0.08;
      const f = freq.get(k) || 1;
      return 1 / (1 + Math.log2(f));
    };
    // Per-slide keyWeight (for _score's hit-eligibility floor) and a count
    // of its DISTINCT distinctive keys — over keySet, not the raw `keys`
    // array, since _score's hit count is also deduped (a repeated word in
    // a slide's own bullets shouldn't inflate the "fraction of vocabulary
    // heard" denominator).
    slides.forEach(s => {
      s.keyWeight = new Map();
      s.distinctiveKeys = 0;
      s.keySet.forEach(k => {
        const w = weightOf(k);
        s.keyWeight.set(k, w);
        if (w >= HIT_WEIGHT_FLOOR) s.distinctiveKeys++;
      });
    });
    return { slides, weightOf };
  }

  const DEFAULTS = {
    tailWords: 24,        // recent transcript window scored each ingest — wider than the
                           // lyrics follower's, since sermon speech is far less dense with
                           // on-slide vocabulary per word spoken.
    forwardWindow: 20,     // only score the next N slides from the current position —
    backWindow: 1,         // ...plus this many BEHIND, so a slide just barely missed can
                           // still register without opening the whole deck back up.
    minDwellMs: 4000,       // floor between advances — a sermon slide is on screen far
    dwellSecPerWord: 0.9,   // longer than a hymn line; scale with how much distinctive
                             // vocabulary the slide actually carries (a denser slide implies
                             // more being said about it).
    // confAdvance/confHold retuned for the _score rewrite below — score is
    // now a plain hits/distinctiveKeys fraction (bounded, no weight-cap
    // inflation), which sits in a lower natural range than the old
    // fraction×min(2,weight): replay-harness sweeps (scratch/followers/
    // sermon-replay.js) across paraphrased speech at WER 0..0.4 land
    // confident real matches around 0.35-0.6 and pure chance-overlap noise
    // well under that, with premature (wrong-slide) advances near zero.
    confAdvance: 0.35,      // min confidence to advance to the current best-scoring FORWARD slide
    confHold: 0.15,         // below this, freeze entirely
    leadMargin: 1.35,       // the best forward slide's score must beat the CURRENT slide's own
                             // score, AND the next-best forward candidate's, by at least this
                             // multiplier before advancing — a close or ambiguous call stays put
                             // rather than flipping on noise or a shared-vocabulary coincidence.
    minSlideHits: 2,        // a candidate needs at least this many distinct keyword hits,
                             // never a single coincidental word, to be eligible at all.
    emitThrottleMs: 200,
  };

  function SermonFollower(deck, opts) {
    opts = opts || {};
    const cfg = Object.assign({}, DEFAULTS, opts.config || {});
    const flat = flattenDeck(deck);

    this.cfg = cfg;
    this.slides = flat.slides;
    this.index = 0;          // the slide currently DISPLAYED
    this.confidence = 0;     // 0..1, EMA of recent match quality
    // null, not 0 or Date.now() — this class is fed either real Date.now()
    // (service.js's own calls) or a synthetic replay-harness clock
    // starting near 0, and no single absolute timestamp is safely "in the
    // past" for both domains (Date.now() here would permanently block the
    // first advance under a synthetic clock, the mirror image of the
    // literal-0 bug this replaced). null is a sentinel _maybeAdvance
    // checks for explicitly: the dwell floor doesn't apply until a real
    // advance/resync has actually set this once, in whichever clock
    // domain ingest() is being called with.
    this._lastAdvanceAt = null;
    this._lastEmitAt = 0;
    this.onPosition = opts.onPosition || function () {};
    this.onAdvance = opts.onAdvance || function () {};
    this.enabled = true;
  }

  // Operator override — manual next/prev or a direct slide click. Auto-
  // follow continues from there, same contract as the lyrics follower's
  // own resync.
  SermonFollower.prototype.resync = function (index, now) {
    if (!this.slides[index]) return;
    this.index = index;
    this._lastAdvanceAt = now || Date.now();
    this.confidence = Math.max(this.confidence, 0.5); // trust the human
  };

  SermonFollower.prototype.snapshot = function () {
    return {
      index: this.index,
      confidence: Math.round(this.confidence * 100) / 100,
      frozen: this.confidence < this.cfg.confHold,
    };
  };

  // Keyword-overlap score of `recent` transcript keys against one slide's
  // keyword set — what fraction of the slide's DISTINCTIVE words were just
  // heard, not a position/order match (unlike the lyrics follower;
  // paraphrased speech has no reliable word order to lean on).
  //
  // Only words at/above HIT_WEIGHT_FLOOR count as hits — stopwords AND any
  // other near-universal word ("today", "just", a connector phrase on most
  // slides) say nothing about which slide is live, so they can't clear
  // minSlideHits or pad the fraction either.
  //
  // score = hits / slide.distinctiveKeys, bounded [0,1] with no
  // length-dependent saturation. The previous `fraction × min(2,
  // slide.weight)` capped its multiplier at 2 for almost any real slide
  // (slide.weight was a raw SUM over every word), so long/dense and
  // short/sparse slides alike hit the same ceiling — a thin 2-word match
  // could trivially out-score an 18/20-word match.
  SermonFollower.prototype._score = function (recent, slide) {
    if (!slide.keys.length) return { score: 0, hits: 0 };
    let hits = 0;
    const seen = new Set();
    for (const r of recent) {
      for (const k of slide.keySet) {
        if (seen.has(k)) continue;
        if (keyMatch(r, k)) {
          seen.add(k);
          if (slide.keyWeight.get(k) >= HIT_WEIGHT_FLOOR) hits++;
          break;
        }
      }
    }
    const score = hits / Math.max(1, slide.distinctiveKeys);
    return { score, hits };
  };

  SermonFollower.prototype._dwell = function (slide) {
    const words = slide ? slide.keys.length : 6;
    return Math.max(this.cfg.minDwellMs, words * this.cfg.dwellSecPerWord * 1000);
  };

  SermonFollower.prototype.ingest = function (text, meta) {
    if (!this.enabled) return;
    const now = (meta && meta.now) || Date.now();
    const keys = tokenizeKeys(text);
    if (!keys.length) { this._emit(now); return; }
    const recent = keys.slice(-this.cfg.tailWords);

    const cur = this.slides[this.index];
    const curScore = cur ? this._score(recent, cur).score : 0;

    const lo = Math.max(0, this.index - this.cfg.backWindow);
    const hi = Math.min(this.slides.length, this.index + this.cfg.forwardWindow + 1);
    let best = null, secondBest = 0;
    for (let i = lo; i < hi; i++) {
      if (i === this.index) continue;
      const { score, hits } = this._score(recent, this.slides[i]);
      if (hits < this.cfg.minSlideHits) continue;
      if (!best || score > best.score) {
        if (best) secondBest = Math.max(secondBest, best.score);
        best = { index: i, score, hits };
      } else {
        secondBest = Math.max(secondBest, score);
      }
    }

    // Confidence tracks how well SOMETHING in the window matched — the
    // better of "we're still clearly on the current slide" or "a forward
    // slide just lit up" — decaying toward freeze when neither happens.
    const bestScore = Math.max(curScore, best ? best.score : 0);
    const target = Math.min(1, bestScore);
    this.confidence = this.confidence * 0.72 + target * 0.28;

    this._maybeAdvance(now, best, curScore, secondBest);
    this._emit(now);
  };

  SermonFollower.prototype._maybeAdvance = function (now, best, curScore, secondBest) {
    if (!best) return;
    if (this._lastAdvanceAt !== null && now - this._lastAdvanceAt < this._dwell(this.slides[this.index])) return;
    if (this.confidence < this.cfg.confHold) return; // frozen — wait for a real lock
    if (best.score < this.cfg.confAdvance) return;
    // Only actually move forward — a back-window "hit" just means "don't
    // over-trust a forward guess when we're clearly still on this slide",
    // never rewinds the live output.
    if (best.index <= this.index) return;
    if (best.score < curScore * this.cfg.leadMargin) return; // not a clear enough lead over staying put
    // ...nor a clear enough lead over the next-best FORWARD candidate — with
    // a wide forward window and shared vocabulary (many slides mention
    // "faith", "grace"), several slides can tie or nearly tie by chance;
    // an ambiguous winner should wait rather than pick one.
    if (secondBest > 0 && best.score < secondBest * this.cfg.leadMargin) return;

    this.index = best.index;
    this._lastAdvanceAt = now;
    this.onAdvance({ toIndex: best.index, confidence: this.confidence });
  };

  SermonFollower.prototype._emit = function (now) {
    if (now - this._lastEmitAt < this.cfg.emitThrottleMs) return;
    this._lastEmitAt = now;
    this.onPosition(this.snapshot());
  };

  const API = { SermonFollower, flattenDeck, DEFAULTS };

  if (typeof module !== 'undefined' && module.exports) module.exports = API;
  if (root) root.KairoSermonFollow = API;

})(typeof window !== 'undefined' ? window : null);
