// KAIRO — Consolidated detection scoring model
//
// Replaces server.js's parallel state variables (lastSentBook, lastOutputVerse,
// lastDirectSentVerse, lastDetectedRef, staleOverrideCandidate,
// bookMomentumCandidate, ensembleCache) and post-hoc guard logic
// (broadcastDetection's continuity gate, maybeCorrectMiscitation's five
// exemption clauses) with one additive score per candidate verse:
//
//   finalScore = clamp01( B(method, rawResult) + D(candidate, activeContext) + A(candidate, ledger) )
//
//   B — per-method calibrated base certainty (five methods return
//       incomparable raw scores today: direct is a constant 1.0, verbatim is
//       IDF-coverage math, stream is a hand-tuned lookup table, fingerprint
//       is signature-coverage, semantic is raw cosine).
//   D — continuous distance from the current reading position, replacing
//       the boolean "is this sequential" gate.
//   A — cross-method / repeated-detection corroboration, replacing
//       ensembleScore + staleOverrideCandidate + bookMomentumCandidate.
//
// Core design principle (the whole point of this module): the quoted
// SCRIPTURE TEXT is ground truth — a preacher reading aloud is always
// reading real words, even when they misspeak the verse number. A spoken
// CITATION is a strong hint, not unconditional authority. That's why
// B(direct)=0.93, not 1.0 — a citation still clears VIEWER_MIN_SCORE and
// auto-sends normally on its own, it just isn't unoverridable by strong,
// independently-arrived-at textual evidence the way it used to be.
//
// Pure, dependency-free — no worker, no WS, no I/O. Loaded by server.js
// (the main process), not detection_worker.js: fusion needs results from
// five separately-dispatched, differently-throttled workerCall()s reasoned
// about together over a rolling time window, plus main-process-only session
// state (lastOutputVerse, sentVerseKeysThisBook, sermon context) — moving
// it into the worker thread would mean duplicating that state across the
// thread boundary for zero compute benefit (fusion itself is a few dozen
// arithmetic ops over candidates the worker already returned, not a new
// full-corpus pass).
'use strict';

// ── Shared constants (reused, not reinvented — see each one's source) ──────

// server.js's VIEWER_MIN_SCORE — the auto-send bar. Duplicated as a literal
// here (not required from server.js, to keep this module dependency-free
// and independently unit-testable) but MUST stay in sync; both are 0.80.
const VIEWER_MIN_SCORE = 0.80;

// detection_worker.js's IDF_FULL_CONFIDENCE (verbatim's own length-score
// denominator) and server.js's VERBATIM_CERTAIN_IDF (the absolute-evidence
// bar verbatim's "certain despite partial coverage" path uses).
const IDF_FULL_CONFIDENCE = 8;
const VERBATIM_CERTAIN_IDF = 18;

// Below VERBATIM_CERTAIN_IDF (auto-send trust), but a real, non-trivial
// amount of matched distinguishing content — enough that a short, genuine
// excerpt of a longer verse shouldn't vanish with zero trace just because
// coverage-diluted raw similarity alone doesn't clear the suggestions
// floor. Calibrated against the real "come and let us reason together"
// incident (matchedIdf=12.7, comfortably above this) — see
// calibrateMethodScore's own comment for the full story.
const VERBATIM_MODERATE_IDF = 10;

// server.js's STREAM_IDF_FULL_CONFIDENCE — the IDF-weight bar a df=1
// (Bible-wide-unique) anchor needs before its uniqueness-as-a-combination
// is trusted as real identifying content, not 4 ordinary words that only
// happen to co-occur once (see processStreamText's own incident comment).
const STREAM_IDF_FULL_CONFIDENCE = 12;

// server.js's ENSEMBLE_BOOST — reused directly as A()'s per-method
// agreement bonus.
const ENSEMBLE_BOOST = 0.08;

// server.js's SAME_BOOK_WINDOW_MS / STALE_OVERRIDE_WINDOW_MS — D()'s decay
// window and A()'s ledger window, respectively. Same values, continuous
// decay instead of a step function for the former.
const SAME_BOOK_WINDOW_MS = 60000;
const LEDGER_WINDOW_MS = 20000;

// Named-entity corroboration — a real spoken proper name (e.g. "Isaac")
// recently heard, cross-checked (in server.js, via nameChapterIndex)
// against whether the CANDIDATE's own chapter actually mentions that name
// anywhere. Real incident this targets: "Genesis 26:14" — a stream hit
// whose own B is deliberately hard-capped at 0.55-0.60 (see
// calibrateMethodScore's own stream-case comment for exactly why that cap
// is hard, not soft — a prior fix that let this same evidence shape
// through unconditionally caused a real false positive). This bonus is
// DELIBERATELY smaller than what it'd take to single-handedly rescue that
// hard-capped floor — B(0.60) + this alone still lands under
// VIEWER_MIN_SCORE once D()'s different-chapter penalty applies, since
// namedEntityCorroborated doesn't participate in the selfSufficient check
// below (B alone still decides that). It's meant to work ALONGSIDE other
// real evidence (cross-method agreement, momentum), not replace the need
// for it — the same "additional, not sufficient alone" shape as every
// other A() term. Starting value, not yet harness-validated — same
// "principled, not data-derived" caveat this file's own design doc gives
// every other coefficient.
const NAMED_ENTITY_BOOST = 0.15;

// Owner's explicit product decision: "When they are high confident matches,
// they should auto send, but ideally 95% upward." Semantic and fingerprint
// were POLICY-CAPPED to suggestions-only regardless of score (see each
// case's own comment below) — deliberately, since neither has an absolute-
// evidence signal the way verbatim/stream's matchedIdf does. This is a real,
// scoped exception to that policy, not a removal of it: when the method's
// own RAW score (rawResult.similarity/.confidence — what the UI badge
// actually shows, NOT the calibrated/capped B this file computes) clears
// this bar, it's trusted enough to auto-send alone. Exactly what "the
// metric" is, per method (see isVeryHighRawConfidence):
//   - semantic: rawResult.similarity (cosine similarity) alone.
//   - fingerprint: rawResult.similarity (coverage ratio) AND
//     rawResult.confidence === 'high' — coverage alone isn't enough without
//     the qualitative confidence tier also agreeing; a "high coverage, low
//     confidence" result is exactly the shape a coincidental match takes.
const VERY_HIGH_RAW_CONFIDENCE = 0.95;

// Cross-encoder reranker score (reranker_engine.js) — DISABLED as an
// auto-send exemption after real live testing, same night it shipped.
// Built and validated against hand-picked near-exact paraphrases (Genesis
// 24:63/Isaac: true match 0.999 vs. closest false-positive 0.0002 — looked
// like a huge, safe margin) — but real, unscripted sermon speech produced a
// flood of confirmed wrong auto-sends at 88-100% rerank confidence
// (Deuteronomy 17:5, Acts 9:6, John 8:7/8, Proverbs 22:3, and more, all
// unrelated to what was actually being said, all reaching the live screen
// within minutes of shipping). This cross-encoder (MS-MARCO-trained, i.e.
// "is this passage relevant to this query" web-search relevance) isn't
// calibrated for "is this an actual quote/citation," and ordinary
// unscripted speech is far looser than the clean test phrases that
// validated it. Same pattern this codebase has hit before (see the
// backward-extension anchor-trie experiment in the plan log — looked safe
// isolated, unsafe on real audio) — kept in code, scoring still computed
// and logged, but no longer trusted to promote anything to viewer alone
// until it's properly re-validated against the eval harness on real
// transcripts, not hand-picked phrases.
const RERANK_AUTOSEND_MIN = 2; // impossible to clear (scores are 0-1) — disabled, see comment above

function isVeryHighRawConfidence(method, rawResult) {
  const r = rawResult || {};
  if (typeof r.rerankScore === 'number' && r.rerankScore >= RERANK_AUTOSEND_MIN) return true;
  if (method === 'semantic') {
    return typeof r.similarity === 'number' && r.similarity >= VERY_HIGH_RAW_CONFIDENCE;
  }
  if (method === 'fingerprint') {
    return typeof r.similarity === 'number' && r.similarity >= VERY_HIGH_RAW_CONFIDENCE && r.confidence === 'high';
  }
  return false;
}

// ── B(method, rawResult) — per-method calibration ───────────────────────────

function clamp01(x) { return Math.max(0, Math.min(1, x)); }

/**
 * Maps each method's own incomparable raw score onto one common 0-1 scale.
 * `rawResult` is whatever detection_worker.js / server.js already computed
 * for this candidate (similarity, matchedIdf, confidence, etc.) — this
 * function does not re-derive anything from scratch, it recalibrates.
 */
function calibrateMethodScore(method, rawResult) {
  const r = rawResult || {};
  switch (method) {
    case 'direct':
      // Flat, not 1.0 — the literal encoding of "citation is a strong hint,
      // not unconditional ground truth." Still clears VIEWER_MIN_SCORE on
      // its own (0.93 > 0.80), so a plain citation auto-sends exactly as
      // expected; it just isn't unoverridable by strong contradicting text
      // evidence anymore (see evaluateCorrection below).
      return 0.93;

    case 'direct-partial':
      // A bare "verse N" resolved from stale context (no fresh book/chapter
      // spoken). Deliberately kept BELOW VIEWER_MIN_SCORE (0.80) on its
      // own — this is exactly the method the real Esther 6:1 incident fired
      // through (an STT-hallucinated book context), so unlike a fresh full
      // citation, it must NOT be trusted to auto-send alone; it needs D()
      // continuity support from a genuinely still-active book, or A()
      // corroboration, to cross the bar.
      return 0.75;

    case 'verbatim': {
      // Reuses the existing formula unchanged (already well-tuned per the
      // real "Psalms 92:13" incident it was built for) — folds today's ad
      // hoc `viaIdf ? max(similarity,0.90) : similarity` hack (server.js
      // processVerbatim) into B itself, so callers don't need a side-channel
      // adjustment after calibration.
      const raw = typeof r.similarity === 'number' ? r.similarity : 0;
      if (typeof r.matchedIdf === 'number' && r.matchedIdf >= VERBATIM_CERTAIN_IDF) {
        const idfFloor = 0.90 + Math.min(0.07, (r.matchedIdf - 18) * 0.005);
        return Math.max(raw, idfFloor);
      }
      // Graduated CANDIDATES-only floor for real-but-not-yet-certain
      // matchedIdf. Owner's own framing, live: "if it understands context,
      // a preacher saying 'come and let us reason together' will show up
      // immediately in the candidates section as Isaiah 1:18... either
      // said in isolation or between a long speech." Real incident this
      // closes: that exact phrase — a genuine, short excerpt of a longer
      // verse — scores matchedIdf=12.7 here but raw similarity=0.37 (badly
      // diluted by coverage, since it's only ~6 of the verse's ~30 words),
      // and raw alone never cleared decideTarget's 0.50 'suggestions'
      // floor — it vanished with zero trace instead of at least reaching
      // Candidates for a human to see. VERBATIM_MODERATE_IDF sits well
      // below VERBATIM_CERTAIN_IDF (18, the bar that's earned real
      // AUTO-SEND trust) — this path is capped at 0.60, comfortably under
      // VIEWER_MIN_SCORE (0.80), so it can NEVER auto-send on its own no
      // matter how the curve is read; it can only ever earn a look, not a
      // decision. A rejected earlier attempt at the SAME underlying "fill
      // gaps" goal (backward extension in the stream anchor-trie, tried
      // and reverted the same session) targeted the AUTO-SEND bar directly
      // and the harness showed that was unsafe — this is deliberately the
      // opposite, safer half of the same idea: be generous about what
      // reaches a human, stay strict about what reaches the screen alone.
      if (typeof r.matchedIdf === 'number' && r.matchedIdf >= VERBATIM_MODERATE_IDF) {
        const t = clamp01((r.matchedIdf - VERBATIM_MODERATE_IDF) / (VERBATIM_CERTAIN_IDF - VERBATIM_MODERATE_IDF));
        const candidateFloor = 0.55 + t * 0.05; // 0.55 .. 0.60, always well under VIEWER_MIN_SCORE
        return Math.max(raw, candidateFloor);
      }
      return raw;
    }

    case 'stream':
      // Confirmed alignments (6+ words aligned in sequence).
      if (r.confirmed) return Math.min(0.97, 0.90 + Math.min(0.07, ((r.matched || 6) - 6) * 0.01));
      // Unconfirmed anchor, but df===1 (this exact 4-word run is unique to
      // ONE verse in the whole Bible) with real IDF weight — mirrors
      // server.js's own "Unique-phrase fast-share" policy (processStreamText),
      // which already trusts this case at Math.max(0.90, similarity) alone.
      // Real gap this closes (live test, 2026-09-07): a preacher who quotes
      // just the opening of a verse (5-6 words) then pivots straight into
      // paraphrase/exposition — very common — never reaches the 6-word
      // confirm threshold, so a genuinely unique, high-IDF match sat at B=0
      // and never had a chance to auto-send, EVEN AT SESSION COLD-START
      // where nothing has corroborated it yet (server.js's continuity guard
      // deliberately withholds cold-start free passes for weak hits, per
      // the Esther 6:1/Acts 3:6 incidents — but a df=1+high-IDF anchor is
      // exactly the strong-evidence case that guard was never meant to
      // catch). Any other unconfirmed anchor (df>=2, or df=1 without
      // enough IDF weight) still scores 0 here — those are genuinely
      // ambiguous/weak and stay suggestions-only, same as before.
      //
      // Real wrong-send found live (2026-09-07, same session, minutes
      // after this exemption first shipped): "Acts 1:14" auto-sent with
      // idf=12.2 — barely past the original STREAM_IDF_FULL_CONFIDENCE
      // (12) bar — and the owner confirmed directly it was never actually
      // read or cited. That threshold is server.js's own ANCHOR_CONFIRM_IDF
      // floor, tuned for a 6-WORD confirmed alignment's worth of
      // structural evidence; reusing it for a 4-word UNCONFIRMED anchor
      // (strictly less structural evidence) was never actually validated
      // at this lower word count and proved too permissive on real audio.
      // Raised to VERBATIM_CERTAIN_IDF (18) — the same bar this codebase
      // already trusts as "certain enough to override coverage concerns"
      // for verbatim matches — rather than inventing a new number.
      if (r.df === 1 && typeof r.idf === 'number' && r.idf >= VERBATIM_CERTAIN_IDF) {
        return Math.max(0.90, typeof r.similarity === 'number' ? r.similarity : 0.90);
      }
      // Graduated CANDIDATES-only floor, mirroring verbatim's own
      // VERBATIM_MODERATE_IDF fix directly above — same owner ask ("show up
      // immediately in the candidates section... in isolation or between a
      // long speech"), same real gap, just on the stream anchor side of the
      // engine. Real incident this closes: "Genesis 26:14" (df=1,
      // idf=13.7 — real, non-trivial identifying content, past
      // STREAM_IDF_FULL_CONFIDENCE's own 12 bar) landed here with B=0 and
      // vanished with zero trace, because the auto-send bar was raised to
      // VERBATIM_CERTAIN_IDF (18) above without leaving anything underneath
      // it for the 12-18 range — the exact same shape of gap the verbatim
      // fix closed, just never mirrored to this method. Capped at 0.60,
      // comfortably under VIEWER_MIN_SCORE — can never auto-send alone.
      if (r.df === 1 && typeof r.idf === 'number' && r.idf >= STREAM_IDF_FULL_CONFIDENCE) {
        const t = clamp01((r.idf - STREAM_IDF_FULL_CONFIDENCE) / (VERBATIM_CERTAIN_IDF - STREAM_IDF_FULL_CONFIDENCE));
        // Deliberately NOT Math.max'd against r.similarity — unlike verbatim's
        // raw (a real per-word-coverage metric already trusted as a legitimate
        // base score), this anchor's own `similarity` is the trie's internal
        // 4-gram overlap ratio, routinely 0.85-1.0 for a short match with weak
        // IDF — taking the max with it would silently let a weak-IDF anchor
        // straight through to viewer via that raw number, reopening exactly
        // the bug #14 (Acts 1:14) false-positive this graduated floor is
        // supposed to stay clear of. Real bug caught live, same night, before
        // the owner had to: "Genesis 26:14" at idf=13.7 reached viewer
        // directly off Math.max(candidateFloor, similarity) in the first cut
        // of this fix. The fixed cap here is the ENTIRE score for this path.
        return 0.55 + t * 0.05; // 0.55 .. 0.60, hard cap — never auto-sends alone
      }
      return 0;

    case 'fingerprint': {
      // Hard ceiling of 0.75 — below VIEWER_MIN_SCORE, so fingerprint alone
      // can never auto-send. This preserves today's "fingerprint is
      // suggestions-only" behavior as an explicit policy (decideTarget's
      // own ceiling below is the actual enforcement; this cap is belt-and-
      // suspenders so the number itself never implies otherwise). Still
      // feeds A() as corroboration for a verbatim/stream candidate on the
      // same verse.
      //
      // EXCEPTION: isVeryHighRawConfidence (own comment above) — a genuine
      // 95%+ raw match, at 'high' confidence, earns 0.85, clearing
      // VIEWER_MIN_SCORE on its own via the existing self-sufficient
      // mechanism in scoreCandidate (no change needed there).
      if (isVeryHighRawConfidence('fingerprint', r)) return 0.85;
      const coverage = typeof r.similarity === 'number' ? r.similarity : 0;
      const confMult = { high: 1.0, medium: 0.85, low: 0.65, none: 0 }[r.confidence] ?? 0.65;
      return Math.min(0.75, 0.35 + coverage * 0.5) * confMult;
    }

    case 'semantic':
      // Hard policy: suggestions-only regardless of score — no absolute-
      // evidence analogue to matchedIdf exists yet for cosine similarity.
      // decideTarget enforces this as a real ceiling, not an accident of
      // threshold arithmetic; this calibration intentionally returns
      // something that can never clear VIEWER_MIN_SCORE on its own.
      //
      // EXCEPTION: isVeryHighRawConfidence (own comment above) — a genuine
      // 95%+ cosine similarity earns 0.85. decideTarget still has its own
      // explicit gate for semantic (this B alone isn't sufficient there —
      // see decideTarget's own comment for why it checks the flag directly
      // rather than trusting B implicitly).
      if (isVeryHighRawConfidence('semantic', r)) return 0.85;
      return Math.min(0.60, clamp01(typeof r.similarity === 'number' ? r.similarity : 0) * 0.7);

    default:
      return 0;
  }
}

// ── D(candidate, activeContext) — continuity as a continuous term ──────────

/**
 * activeContext: { book, chapter, verse, t } | null — the unified "what's
 * currently on screen" struct. Replaces today's two separately-updated
 * variables (lastOutputVerse + lastSentBookTime) that had to stay in sync
 * by convention — a latent bug surface in itself.
 *
 * `alreadyShown(candidate)` — caller-supplied predicate, backed by the
 * existing sentVerseKeysThisBook Set (unchanged) — true if this exact verse
 * has already been shown this book, distinguishing a genuine "catch-up" read
 * (a verse skipped earlier, now being reached — never penalized) from real
 * backward noise (an echo of something already displayed, penalized).
 */
function distanceTerm(candidate, activeContext, alreadyShown) {
  if (!activeContext) return 0; // cold start — no bonus, no penalty

  const recency = clamp01(1 - (candidate.now - activeContext.t) / SAME_BOOK_WINDOW_MS);
  if (recency <= 0) return 0;

  const sameBook = candidate.book === activeContext.book;
  const sameChapter = sameBook && candidate.chapter === activeContext.chapter;

  if (sameChapter && candidate.verse >= activeContext.verse) {
    const delta = candidate.verse - activeContext.verse;
    return 0.15 * recency * Math.max(0, 1 - delta / 40);
  }
  if (sameChapter && candidate.verse < activeContext.verse) {
    // Matches the ORIGINAL isBackwardInSameBook polarity exactly (server.js):
    // penalized ONLY when this exact verse was already shown before (a stray
    // echo of something already on screen) — NOT shown yet means this is a
    // genuine catch-up read (Matthew 15:23-27, cited by its last verse 28
    // first, then read from the top) and must not be penalized at all.
    const shown = alreadyShown ? alreadyShown(candidate) : false;
    return shown ? -0.20 * recency : 0;
  }
  if (sameBook) return -0.10 * recency;
  return -0.15 * recency;
}

// ── A(candidate, ledger) — corroboration ────────────────────────────────────

/**
 * One rolling ledger replacing three separate mechanisms: ensembleCache
 * (cross-method agreement), staleOverrideCandidate (same-verse repeat
 * count), bookMomentumCandidate (ascending verses in a new book/chapter).
 * Entries are pruned by LEDGER_WINDOW_MS (20s, same as today's
 * STALE_OVERRIDE_WINDOW_MS).
 */
class EvidenceLedger {
  constructor() {
    this._byVerse = new Map();   // verseKey -> { methods: Set, count, lastSeenAt }
    this._byChapter = new Map(); // "book|chapter" -> { verses: Set<number>, lastSeenAt }
  }

  static verseKey(c) { return `${c.book}|${c.chapter}|${c.verse}`; }
  static chapterKey(c) { return `${c.book}|${c.chapter}`; }

  /** Record a detection hit; call once per candidate per detection pass. */
  record(candidate, method, now) {
    this.prune(now);
    const vKey = EvidenceLedger.verseKey(candidate);
    let v = this._byVerse.get(vKey);
    if (!v) { v = { methods: new Set(), count: 0, lastSeenAt: now }; this._byVerse.set(vKey, v); }
    v.methods.add(method);
    v.count++;
    v.lastSeenAt = now;

    const cKey = EvidenceLedger.chapterKey(candidate);
    let c = this._byChapter.get(cKey);
    if (!c) { c = { verses: new Set(), lastSeenAt: now }; this._byChapter.set(cKey, c); }
    c.verses.add(candidate.verse);
    c.lastSeenAt = now;
  }

  /**
   * +0.08 per distinct method beyond the first, up to 2 counted (+0.16 max)
   * — matches the ORIGINAL ensembleScore exactly: a single method hitting
   * alone earns nothing here (it's just its own B score), the bonus is
   * specifically for two-or-more INDEPENDENT methods agreeing.
   */
  agreementBonus(candidate) {
    const v = this._byVerse.get(EvidenceLedger.verseKey(candidate));
    if (!v || v.methods.size < 2) return 0;
    return Math.min(2, v.methods.size) * ENSEMBLE_BOOST;
  }

  /** Soft version of STALE_OVERRIDE_COUNT=3 — additive, not a hard branch. */
  repeatBonus(candidate) {
    const v = this._byVerse.get(EvidenceLedger.verseKey(candidate));
    if (!v) return 0;
    return 0.05 * Math.min(3, v.count - 1);
  }

  /** +0.06 if >=2 distinct ascending verses hit in this book+chapter recently. */
  momentumBonus(candidate) {
    const c = this._byChapter.get(EvidenceLedger.chapterKey(candidate));
    if (!c) return 0;
    return c.verses.size >= 2 ? 0.06 : 0;
  }

  total(candidate) {
    return this.agreementBonus(candidate) + this.repeatBonus(candidate) + this.momentumBonus(candidate);
  }

  /**
   * True when 2+ DISTINCT methods have independently hit this exact verse
   * within the window — the same test agreementBonus already uses, exposed
   * on its own for decideTarget's semantic-corroboration exemption (see
   * there for why). Call this BEFORE record()-ing the current candidate, so
   * it reflects prior independent evidence, not the candidate corroborating
   * itself.
   */
  hasCorroboration(candidate) {
    const v = this._byVerse.get(EvidenceLedger.verseKey(candidate));
    return !!v && v.methods.size >= 2;
  }

  prune(now) {
    for (const [k, v] of this._byVerse) if (now - v.lastSeenAt > LEDGER_WINDOW_MS) this._byVerse.delete(k);
    for (const [k, c] of this._byChapter) if (now - c.lastSeenAt > LEDGER_WINDOW_MS) this._byChapter.delete(k);
  }
}

// ── scoreCandidate / decideTarget — the fused decision ──────────────────────

/**
 * ctx: { activeContext, alreadyShown, ledger, now }
 * Returns { finalScore, breakdown } — breakdown is for shadow-mode logging,
 * not behavior.
 */
function scoreCandidate(candidate, method, rawResult, ctx) {
  const B = calibrateMethodScore(method, rawResult);
  // A full, explicit citation ("book chapter:verse" actually spoken) never
  // goes through continuity gating at all in the original design — see
  // server.js's `if (target === 'viewer' && method !== 'direct' && ...)`,
  // which excludes 'direct' from the whole guard block outright. That's the
  // literal encoding of the owner's core requirement: "if a book and
  // chapter is called, it should auto send" — unconditionally, regardless
  // of what book was active a moment ago.
  //
  // Real regression found live (owner testing, 2026-09-07): a preacher who
  // jumps between books in quick succession (Isaiah → Joshua → Psalms →
  // Genesis, typical topical preaching) triggers the "different book" D()
  // penalty (-0.15*recency) on EVERY fresh citation. B(direct)=0.93 minus
  // that penalty lands at ~0.78-0.93 — straddling VIEWER_MIN_SCORE (0.80)
  // right at the boundary, so citations for a new book intermittently (or
  // in a fast-moving sermon, almost always) got demoted to Candidates
  // instead of auto-sending. `direct-partial` (a bare "verse N" resolved
  // from stale context, no fresh book/chapter spoken) is deliberately NOT
  // exempted here — that's exactly the method the real Esther 6:1 incident
  // fired through, and it still needs D()/A() support to earn the bar.
  // SECOND real regression found live (owner testing, 2026-09-07, same
  // session): a preacher citing "Genesis 24:83" (an invalid, garbled verse
  // number — Genesis 24 only has 67 verses) immediately transitioned into
  // paraphrasing Genesis 26's Isaac-and-the-Philistines account. The
  // 'stream' layer correctly matched "Genesis 26:14" at 90% confirmed-
  // alignment — real, distinctive textual evidence — but it was still
  // subject to the full D() penalty (Psalms was the recently-active book),
  // and got demoted to Candidates instead of shown. A near-identical case
  // (Joshua 1:8, also 'stream') survived only by a 0.0002 margin earlier
  // the same session — not a fluke, a structural gap: only 'direct' was
  // exempted from continuity gating, but a CONFIRMED stream alignment (6+
  // words aligned against real KJV/NLT text) or a high-certainty verbatim
  // match (matchedIdf past VERBATIM_CERTAIN_IDF) is exactly the kind of
  // absolute textual evidence this whole redesign's philosophy says should
  // outrank a citation, not merely equal one — it should be under LESS
  // suspicion from D(), not the same amount.
  //
  // Generalized the exemption instead of special-casing another method
  // name: D() is skipped whenever B() ALONE already clears
  // VIEWER_MIN_SCORE — i.e., whenever the method's own calibrated evidence
  // is already self-sufficient. This is method-agnostic by construction:
  // direct (0.93) and any stream/verbatim hit whose own certainty already
  // reaches 0.80 both qualify; direct-partial (capped at 0.75) and
  // fingerprint/semantic (hard-capped well under 0.80 by design, see
  // calibrateMethodScore) never can, so Esther 6:1-class incidents and the
  // suggestions-only policy ceilings are both still fully intact — D() can
  // still only ever be the thing that VETOES a candidate that needed help
  // to clear the bar in the first place, never one that didn't.
  // THIRD real regression found live (owner testing, 2026-09-07, same
  // session, moments after the self-sufficient exemption above went live):
  // once that exemption applied to EVERY confirmed stream/verbatim hit, two
  // near-duplicate-phrasing collisions with Psalm 1 ("Jeremiah 17:8" shares
  // "tree planted by the waters"; "Romans 7:22" shares "delight in the
  // law") hijacked the live display mid-reading — both landed right at the
  // bare confirm floor (matchedIdf just above ANCHOR_CONFIRM_IDF=12), not
  // comfortably past it. Owner's own diagnosis, exactly right: "the
  // preacher called a range, it should have stuck there." A formally-
  // established range (`rangeActiveBook`, set only when the preacher
  // explicitly cited a multi-verse passage — the range-queue mechanism
  // stays completely separate/untouched otherwise) is a much stronger
  // "stay here" signal than ordinary continuity: while one is active, the
  // self-sufficient exemption is withheld from every method except
  // 'direct' (a genuinely new explicit citation must still always win
  // immediately, unconditionally, per the original rule) for any candidate
  // in a DIFFERENT book than the range — falling through to the full D()
  // penalty gives it exactly the scrutiny the continuity guard always gave
  // a different-book switch, closing the collision window without
  // touching the Genesis 26:14 / Joshua 1:8 cases that motivated the
  // exemption in the first place (both were same-or-no-range situations).
  const inDifferentBookDuringRange =
    ctx.rangeActiveBook && candidate.book !== ctx.rangeActiveBook;
  // A genuine re-detection of an already-shown verse (same book+chapter,
  // behind the active verse, alreadyShown true) used to be carved out of
  // this exemption entirely — first as a decaying penalty (bug #12: "Daniel
  // 10:12" punched through it once enough time had passed), then hardened
  // into an absolute hard ceiling once that leak was found. Owner's own
  // explicit direction later overrides both: "If it's echoed again, it
  // means that's what the preacher is spotlighting, it should be back up"
  // / "If we sent it previously and the preacher goes back, we should go
  // back too" — a deliberate re-read (real, strong textual evidence, not a
  // stray coincidental collision — that's what B>=VIEWER_MIN_SCORE already
  // requires) should redisplay immediately, the same as any other strong
  // new evidence, not be blocked or merely allowed to leak through after a
  // delay. So a backward-already-shown candidate is no longer special-cased
  // out of the self-sufficient exemption at all — it's treated exactly
  // like any other candidate whose own B clears the bar on its own.
  const selfSufficient = B >= VIEWER_MIN_SCORE
    && !(inDifferentBookDuringRange && method !== 'direct');
  const D = selfSufficient
    ? 0
    : distanceTerm({ ...candidate, now: ctx.now }, ctx.activeContext, ctx.alreadyShown);
  const A = (ctx.ledger ? ctx.ledger.total(candidate) : 0)
    + (ctx.namedEntityCorroborated ? NAMED_ENTITY_BOOST : 0);
  let finalScore = clamp01(B + D + A);
  // FIFTH real regression in this exact area, found live (owner testing,
  // 2026-09-07): the range-collision fix above (inDifferentBookDuringRange)
  // made the SAME mistake bug #12 already named and fixed for the backward-
  // reshow case — it correctly identified the right condition, but routed
  // it into distanceTerm, an ordinary PENALTY that trades off against B and
  // decays with recency. Real data from `databases/debug.log`: "Jeremiah
  // 17:8" (the exact collision this mechanism exists to stop) landed
  // B=0.90, D=-0.0897 (the recency-decayed different-book penalty, not a
  // block), finalScore=0.8103 — just over VIEWER_MIN_SCORE, reaching the
  // viewer mid-range exactly as before. Owner: "I thought it was solved."
  // The owner's own original diagnosis was already the absolute-rule
  // wording — "the preacher called a range, it should have stuck there" —
  // not "should have stuck there unless enough time passes or the evidence
  // is strong enough." Same fix shape as #12: a hard ceiling, not a bigger
  // penalty. A genuinely NEW citation for a different book (method
  // === 'direct') still always wins immediately, unconditionally,
  // untouched — only a same-range-lifetime coincidental collision from a
  // non-citation method is capped.
  if (inDifferentBookDuringRange && method !== 'direct') {
    finalScore = Math.min(finalScore, VIEWER_MIN_SCORE - 0.05);
  }
  return {
    finalScore,
    breakdown: {
      B, D, A, method,
      namedEntityCorroborated: !!ctx.namedEntityCorroborated,
      veryHighConfidence: isVeryHighRawConfidence(method, rawResult),
    },
  };
}

/**
 * Policy ceilings live here, not just in the raw score — fingerprint and
 * semantic are structurally incapable of reaching 'viewer' even if B+D+A
 * arithmetic alone would clear VIEWER_MIN_SCORE, matching today's explicit
 * "these two are suggestions-only" design.
 *
 * TWO exemptions to that, both requiring finalScore to also actually clear
 * VIEWER_MIN_SCORE (an exemption only removes the EXTRA semantic-specific
 * gate below, it never substitutes for the score bar itself):
 *
 * 1. Cross-method corroboration. B(semantic) alone is hard-capped at 0.60 —
 *    cosine similarity alone is never trusted. But a semantic hit that's
 *    ALSO independently caught by a different method on the exact same
 *    verse (even if that other hit was itself too weak to auto-send alone)
 *    is a different, stronger kind of evidence: two independent signals
 *    agreeing is real corroboration, not a coincidental cosine-similarity
 *    collision. `opts.corroborated` (EvidenceLedger.hasCorroboration) gates
 *    this.
 * 2. Very high raw confidence (owner's explicit request: "when they are
 *    high confident matches, they should auto send... ideally 95% upward").
 *    `opts.veryHighConfidence` — sourced from scoreCandidate's own
 *    breakdown.veryHighConfidence (isVeryHighRawConfidence, see its own
 *    comment for exactly what's checked per method) — is a genuine, single-
 *    method 95%+ raw match, trusted on its own without needing a second
 *    method to agree.
 *
 * Fingerprint gets no explicit branch here at all: calibrateMethodScore's
 * own isVeryHighRawConfidence exception is the ONLY way its B can reach
 * VIEWER_MIN_SCORE (ordinary fingerprint B is hard-capped at 0.75), so the
 * generic finalScore >= VIEWER_MIN_SCORE check below already enforces the
 * exact same "95%+ raw, or stay suggestions-only" policy without needing
 * its own opts flag.
 */
function decideTarget(finalScore, method, opts) {
  if (method === 'semantic') {
    if (finalScore >= VIEWER_MIN_SCORE && (opts?.corroborated || opts?.veryHighConfidence)) return 'viewer';
    return finalScore >= 0.50 ? 'suggestions' : 'drop';
  }
  if (finalScore >= VIEWER_MIN_SCORE) return 'viewer';
  if (finalScore >= 0.50) return 'suggestions'; // matches today's SUGGESTION_MIN_SCORE-ish floor
  return 'drop';
}

// ── evaluateCorrection — replaces maybeCorrectMiscitation's core test ──────

/**
 * activeCitation: { book, chapter, verse, t, alreadySentAt } — the citation
 * currently on screen that might need correcting.
 * candidate: the verbatim/stream match under consideration as the "real"
 * verse being read.
 * opts: { withinEstablishedRange, immunityMs = 1000, windowMs = 35 } —
 * withinEstablishedRange is a caller-supplied predicate backed by the
 * EXISTING, UNCHANGED rangeAllVerses membership check (server.js) — a verse
 * that's part of a formally-established range is never distance-limited,
 * regardless of how far into the range it is. This is a separate hard
 * exemption, not folded into distanceTerm, because a formal range is a
 * different kind of evidence than implicit continuation.
 *
 * Returns true if candidate should replace activeCitation on screen.
 */
function evaluateCorrection(activeCitation, candidate, ctx, opts = {}) {
  const immunityMs = opts.immunityMs ?? 1000; // down from server.js's CORRECTION_IMMUNITY_MS=3000 —
                                                // short explicit floor kept deliberately (see plan risk 4),
                                                // not fully replaced by the emergent ledger alone.
  if (ctx.now - activeCitation.t < immunityMs) return false;

  const sameVerse = candidate.book === activeCitation.book
    && candidate.chapter === activeCitation.chapter
    && candidate.verse === activeCitation.verse;
  if (sameVerse) return false; // agrees with what's on screen — nothing to correct

  if (opts.withinEstablishedRange && opts.withinEstablishedRange(candidate)) return false;

  // Shares the SAME distance function continuity uses — this is the exact
  // fix for the Genesis 24:3/24:63 bug, where the old exemption
  // (MISCITATION_FORWARD_EXEMPT_VERSES) was an independently-tuned constant
  // that could drift from whatever "forward reading" meant elsewhere. One
  // number now, can't drift apart again.
  const activeAsContext = { book: activeCitation.book, chapter: activeCitation.chapter, verse: activeCitation.verse, t: activeCitation.t };
  const d = distanceTerm({ ...candidate, now: ctx.now }, activeAsContext, ctx.alreadyShown);
  // A small positive D (genuine nearby forward continuation) means "don't
  // correct, this is just reading on" — the same forward-decay curve
  // distanceTerm already computes, so a jump far enough to have decayed to
  // ~0 credit is treated as suspicious enough to allow correction.
  if (d > 0.02) return false;

  const B = calibrateMethodScore(candidate.method, candidate.rawResult);
  return B >= (opts.correctionMinScore ?? 0.90);
}

module.exports = {
  VIEWER_MIN_SCORE,
  VERY_HIGH_RAW_CONFIDENCE,
  RERANK_AUTOSEND_MIN,
  isVeryHighRawConfidence,
  calibrateMethodScore,
  distanceTerm,
  EvidenceLedger,
  scoreCandidate,
  decideTarget,
  evaluateCorrection,
  clamp01,
};
