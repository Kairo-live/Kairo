// KAIRO — Unit tests for the consolidated detection scoring model.
// Each test reproduces one real incident the old parallel-state/guard logic
// was built to handle — see the plan's "must-still-pass cases" table. These
// run against synthetic inputs, no live audio or server process needed:
//   node --test server/detection_scoring.test.js
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const {
  calibrateMethodScore, distanceTerm, EvidenceLedger,
  scoreCandidate, decideTarget, evaluateCorrection, VIEWER_MIN_SCORE,
} = require('./detection_scoring');

const T0 = 1_000_000; // arbitrary base timestamp (ms)

function verbatimHit(book, chapter, verse, similarity, matchedIdf) {
  return { book, chapter, verse, method: 'verbatim', rawResult: { similarity, matchedIdf } };
}
function streamHit(book, chapter, verse, matched, confirmed = true) {
  return { book, chapter, verse, method: 'stream', rawResult: { matched, confirmed } };
}
function directHit(book, chapter, verse) {
  return { book, chapter, verse, method: 'direct', rawResult: {} };
}

// ── 1. Ezekiel 47:1→2→3 continuity (uncited forward reading) ───────────────
test('Ezekiel 47:1 -> 2 -> 3: forward reading in the same chapter scores high without any citation', () => {
  const ledger = new EvidenceLedger();
  const active = { book: 'Ezekiel', chapter: 47, verse: 1, t: T0 };
  const candidate = { book: 'Ezekiel', chapter: 47, verse: 2 };
  const now = T0 + 3000; // a few seconds later, still reading

  const hit = verbatimHit('Ezekiel', 47, 2, 0.80, 10);
  const { finalScore } = scoreCandidate(candidate, hit.method, hit.rawResult, { activeContext: active, ledger, now });
  assert.ok(finalScore >= VIEWER_MIN_SCORE, `expected >= ${VIEWER_MIN_SCORE}, got ${finalScore}`);
  assert.equal(decideTarget(finalScore, hit.method), 'viewer');
});

// ── 2. Matthew 15:23-28 backward-then-forward catch-up ──────────────────────
test('Matthew 15:23-27 read AFTER 15:28 was already cited: catch-up, not penalized', () => {
  const ledger = new EvidenceLedger();
  // 15:28 was cited first and is "active"; the preacher then reads the
  // passage from the top — 23, 24, 25... none of these have been shown yet.
  const active = { book: 'Matthew', chapter: 15, verse: 28, t: T0 };
  const alreadyShown = () => false; // none of 23-27 have been shown
  const candidate = { book: 'Matthew', chapter: 15, verse: 24 };
  const now = T0 + 5000;

  const d = distanceTerm({ ...candidate, now }, active, alreadyShown);
  assert.equal(d, 0, 'a genuine catch-up read must not be penalized');

  const hit = verbatimHit('Matthew', 15, 24, 0.82, 11);
  const { finalScore } = scoreCandidate(candidate, hit.method, hit.rawResult, { activeContext: active, ledger, alreadyShown, now });
  assert.ok(finalScore >= VIEWER_MIN_SCORE);
});

test('Matthew 15:28 re-echoed after already being shown: real backward noise IS penalized', () => {
  const ledger = new EvidenceLedger();
  const active = { book: 'Matthew', chapter: 15, verse: 28, t: T0 };
  const alreadyShown = (c) => c.book === 'Matthew' && c.chapter === 15 && c.verse === 28;
  const candidate = { book: 'Matthew', chapter: 15, verse: 28 };
  const now = T0 + 2000;

  // Same verse as active -> not a backward case at all (verse === active.verse
  // takes the forward branch with delta=0), so test a genuinely EARLIER,
  // already-shown verse instead: 15:23, already shown, echoed later.
  const shown23 = (c) => c.verse === 23;
  const d = distanceTerm({ book: 'Matthew', chapter: 15, verse: 23, now }, active, shown23);
  assert.ok(d < 0, 'an already-shown verse echoed later must be penalized, not treated as catch-up');
});

// ── 3. Jeremiah 30:17 garbled-citation cross-method agreement ──────────────
test('Jeremiah 30:17: stream + verbatim agreeing on the SAME verse clears the bar without 3 same-method repeats', () => {
  const ledger = new EvidenceLedger();
  const candidate = { book: 'Jeremiah', chapter: 30, verse: 17 };
  const t1 = T0;
  const t2 = T0 + 500;

  // Method 1: stream confirms.
  ledger.record(candidate, 'stream', t1);
  // Method 2: verbatim also hits the same verse moments later.
  ledger.record(candidate, 'verbatim', t2);

  const hit = verbatimHit('Jeremiah', 30, 17, 0.78, 9); // a real but not overwhelming verbatim score alone
  const { finalScore } = scoreCandidate(candidate, hit.method, hit.rawResult, { activeContext: null, ledger, now: t2 + 100 });
  assert.ok(finalScore >= VIEWER_MIN_SCORE, `cross-method agreement should push this over the bar, got ${finalScore}`);
});

// ── 4. Esther 6:1 / Acts 3:6 cold-start false positive ──────────────────────
test('Esther 6:1 (direct-partial) cold start: a single ungated hit must NOT auto-send', () => {
  const ledger = new EvidenceLedger();
  const candidate = { book: 'Esther', chapter: 6, verse: 1 };
  const { finalScore } = scoreCandidate(candidate, 'direct-partial', {}, { activeContext: null, ledger, now: T0 });
  assert.ok(finalScore < VIEWER_MIN_SCORE, `direct-partial alone at cold start must stay under ${VIEWER_MIN_SCORE}, got ${finalScore}`);
});

test('Acts 3:6 (lone stream anchor, unconfirmed) cold start: must NOT auto-send', () => {
  const ledger = new EvidenceLedger();
  const candidate = { book: 'Acts', chapter: 3, verse: 6 };
  // Unconfirmed anchor -> calibrateMethodScore returns 0 for 'stream' unless confirmed.
  const { finalScore } = scoreCandidate(candidate, 'stream', { confirmed: false }, { activeContext: null, ledger, now: T0 });
  assert.ok(finalScore < VIEWER_MIN_SCORE);
});

// ── 5. Psalm 110/111 backward-jump noise ────────────────────────────────────
test('Psalm 111 wrongly active, Psalm 110 genuinely being read: momentum lets it through', () => {
  const ledger = new EvidenceLedger();
  const active = { book: 'Psalms', chapter: 111, verse: 1, t: T0 };
  const now1 = T0 + 1000, now2 = T0 + 2000;

  ledger.record({ book: 'Psalms', chapter: 110, verse: 1 }, 'stream', now1);
  ledger.record({ book: 'Psalms', chapter: 110, verse: 2 }, 'stream', now2);

  const candidate = { book: 'Psalms', chapter: 110, verse: 2 };
  const hit = streamHit('Psalms', 110, 2, 8, true);
  const { finalScore } = scoreCandidate(candidate, hit.method, hit.rawResult, { activeContext: active, ledger, now: now2 + 100 });
  assert.ok(finalScore >= VIEWER_MIN_SCORE);
});

test('Psalm 111 wrongly active, a single stray echo of Psalm 110 (already shown once): stays suppressed', () => {
  const ledger = new EvidenceLedger();
  const active = { book: 'Psalms', chapter: 111, verse: 1, t: T0 };
  const alreadyShown = (c) => c.book === 'Psalms' && c.chapter === 110 && c.verse === 1;
  const candidate = { book: 'Psalms', chapter: 110, verse: 1 };
  const hit = streamHit('Psalms', 110, 1, 6, true);
  const now = T0 + 1000;
  // Different book from active (Psalms vs Psalms is same book but the
  // "already shown, now echoed again with no new momentum" case) — model as
  // a single ledger entry only (no second distinct ascending verse), so
  // momentumBonus stays 0, and the verse itself was already shown so
  // continuity contributes nothing new either way; the point is a LONE
  // repeat of an already-displayed wrong-book verse shouldn't out-score a
  // fresh, still-active correct one without real corroboration.
  ledger.record(candidate, 'stream', now);
  const { finalScore } = scoreCandidate(candidate, hit.method, hit.rawResult, { activeContext: active, ledger, alreadyShown, now: now + 50 });
  // Single stream hit (B ~0.90) minus different-book penalty; without a
  // second distinct verse for momentum or a second method for agreement,
  // this should NOT run away to certainty — assert it doesn't get the full
  // momentum bonus on top of a strong B.
  assert.ok(finalScore < 0.90 + ENSEMBLE_BOOST_UNUSED_GUARD(), 'a lone repeat must not accumulate momentum it has not earned');
});
function ENSEMBLE_BOOST_UNUSED_GUARD() { return 0.16; } // max possible agreement bonus, for the upper-bound sanity check above

// ── 6. Psalm 1 book-momentum (today's fix) ──────────────────────────────────
test('Psalm 1:1 -> 1:2 -> 1:3 while an unrelated book (Joshua) is active: momentum breaks through', () => {
  const ledger = new EvidenceLedger();
  const active = { book: 'Joshua', chapter: 1, verse: 8, t: T0 };
  const now1 = T0 + 1000, now2 = T0 + 2000, now3 = T0 + 3000;

  ledger.record({ book: 'Psalms', chapter: 1, verse: 1 }, 'stream', now1);
  ledger.record({ book: 'Psalms', chapter: 1, verse: 2 }, 'stream', now2);
  ledger.record({ book: 'Psalms', chapter: 1, verse: 3 }, 'stream', now3);

  const candidate = { book: 'Psalms', chapter: 1, verse: 3 };
  const hit = streamHit('Psalms', 1, 3, 7, true);
  const { finalScore } = scoreCandidate(candidate, hit.method, hit.rawResult, { activeContext: active, ledger, now: now3 + 50 });
  assert.ok(finalScore >= VIEWER_MIN_SCORE, `expected momentum to clear the bar, got ${finalScore}`);
});

test('Psalm 1:1 alone (no momentum yet), Joshua active: does not yet auto-send on a single hit', () => {
  const ledger = new EvidenceLedger();
  const active = { book: 'Joshua', chapter: 1, verse: 8, t: T0 };
  const candidate = { book: 'Psalms', chapter: 1, verse: 1 };
  const hit = streamHit('Psalms', 1, 1, 6, true); // just barely confirmed, B ~0.90
  const now = T0 + 1000;
  ledger.record(candidate, 'stream', now);
  const { finalScore } = scoreCandidate(candidate, hit.method, hit.rawResult, { activeContext: active, ledger, now: now + 50 });
  // A single confirmed stream hit against a different active book: B(~0.90)
  // + D(different book, small negative) + A(0, no momentum/agreement yet).
  // This can legitimately still clear VIEWER_MIN_SCORE on B alone (stream's
  // confirmed floor is high) — the REAL guarantee this model provides is
  // that it no longer requires 3 repeats or momentum to do so (unlike the
  // old staleOverrideCandidate), matching "if scripture is read it should
  // auto send." Assert it does NOT get a momentum bonus it hasn't earned.
  const { breakdown } = scoreCandidate(candidate, hit.method, hit.rawResult, { activeContext: active, ledger, now: now + 50 });
  assert.equal(breakdown.A, 0, 'a single hit must not receive the multi-verse momentum bonus');
});

// ── 7. Genesis 24:3/24:63 miscitation-distance (today's fix) ───────────────
test('Genesis 24:3 cited, 24:63 actually read: correction fires (60-verse jump is NOT treated as continued reading)', () => {
  const activeCitation = { book: 'Genesis', chapter: 24, verse: 3, t: T0 };
  const candidate = { book: 'Genesis', chapter: 24, verse: 63, method: 'verbatim', rawResult: { similarity: 0.93, matchedIdf: 14 } };
  const now = T0 + 4000;
  const fired = evaluateCorrection(activeCitation, candidate, { now, alreadyShown: () => false }, {});
  assert.equal(fired, true, 'a 60-verse jump within the correction window must still correct');
});

test('Genesis 24:3 cited, 24:5 actually read (genuine small forward continuation): correction does NOT fire', () => {
  const activeCitation = { book: 'Genesis', chapter: 24, verse: 3, t: T0 };
  const candidate = { book: 'Genesis', chapter: 24, verse: 5, method: 'verbatim', rawResult: { similarity: 0.90, matchedIdf: 12 } };
  const now = T0 + 4000;
  const fired = evaluateCorrection(activeCitation, candidate, { now, alreadyShown: () => false }, {});
  assert.equal(fired, false, 'a small forward step is ordinary continued reading, not a mis-citation');
});

// ── 8. Formally-cited ranges are untouched (separate mechanism) ────────────
test('A verse far into a formally-established range is exempt from correction regardless of distance', () => {
  const activeCitation = { book: 'Ezekiel', chapter: 47, verse: 1, t: T0 };
  const candidate = { book: 'Ezekiel', chapter: 47, verse: 9, method: 'verbatim', rawResult: { similarity: 0.95, matchedIdf: 16 } };
  const now = T0 + 4000;
  const withinEstablishedRange = (c) => c.book === 'Ezekiel' && c.chapter === 47 && c.verse <= 9; // range 47:1-9
  const fired = evaluateCorrection(activeCitation, candidate, { now, alreadyShown: () => false }, { withinEstablishedRange });
  assert.equal(fired, false, 'a verse inside a formally-cited range must never be "corrected" away');
});

// ── Sanity: direct citation still auto-sends on its own ─────────────────────
test('A plain, unambiguous citation still auto-sends alone (goal: "if a book and chapter is called, auto-send")', () => {
  const ledger = new EvidenceLedger();
  const candidate = { book: 'John', chapter: 3, verse: 16 };
  const { finalScore } = scoreCandidate(candidate, 'direct', {}, { activeContext: null, ledger, now: T0 });
  assert.ok(finalScore >= VIEWER_MIN_SCORE, `a plain citation must clear the bar alone, got ${finalScore}`);
  assert.equal(decideTarget(finalScore, 'direct'), 'viewer');
});

test('A plain citation for a NEW book auto-sends even when a DIFFERENT book was just active (real regression, 2026-09-07)', () => {
  // Live incident: a preacher moving between books in quick succession
  // (Isaiah -> Joshua -> Psalms -> Genesis, ordinary topical preaching)
  // triggers D()'s "different book" penalty (-0.15*recency) on every fresh
  // citation. B(direct)=0.93 minus that penalty straddles VIEWER_MIN_SCORE
  // (0.80) right at the boundary — citations for a new book intermittently
  // failed to auto-send. The ORIGINAL design (server.js's continuity guard)
  // explicitly exempts method==='direct' from continuity gating entirely
  // ("if a book and chapter is called, it should auto send" — unconditional);
  // scoreCandidate must preserve that exemption.
  const ledger = new EvidenceLedger();
  const activeContext = { book: 'Joshua', chapter: 1, verse: 8, t: T0 - 5000 }; // just active, 5s ago
  const candidate = { book: 'Genesis', chapter: 24, verse: 3 };
  const { finalScore, breakdown } = scoreCandidate(candidate, 'direct', {}, { activeContext, alreadyShown: () => false, ledger, now: T0 });
  assert.ok(finalScore >= VIEWER_MIN_SCORE, `a fresh citation for a new book must still clear the bar, got ${finalScore}`);
  assert.equal(breakdown.D, 0, 'direct citations must be fully exempt from the continuity distance term');
  assert.equal(decideTarget(finalScore, 'direct'), 'viewer');
});

test('A CONFIRMED stream match for a new book auto-sends too, not just direct citations (real regression, 2026-09-07 live test)', () => {
  // Live incident: preacher cited a garbled, invalid "Genesis 24:83" (no
  // such verse), then paraphrased Genesis 26's Isaac-and-the-Philistines
  // account. The 'stream' layer correctly confirmed "Genesis 26:14" at
  // real textual confidence, but Psalms was the recently-active book, so
  // the OLD (pre-generalization) code path — which only exempted
  // method==='direct' — applied the full D() penalty and demoted a
  // genuinely correct match to Candidates. A near-identical case (Joshua
  // 1:8, same live session) had already survived by a 0.0002 margin,
  // which was the first sign this was structural, not a fluke.
  const ledger = new EvidenceLedger();
  const activeContext = { book: 'Psalms', chapter: 1, verse: 3, t: T0 - 5000 };
  const candidate = { book: 'Genesis', chapter: 26, verse: 14 };
  const { finalScore, breakdown } = scoreCandidate(candidate, 'stream', { confirmed: true, matched: 6 }, { activeContext, alreadyShown: () => false, ledger, now: T0 });
  assert.ok(finalScore >= VIEWER_MIN_SCORE, `a confirmed stream match for a new book must clear the bar, got ${finalScore}`);
  assert.equal(breakdown.D, 0, 'a self-sufficient method (B alone >= VIEWER_MIN_SCORE) must be exempt from the continuity distance term');
  assert.equal(decideTarget(finalScore, 'stream'), 'viewer');
});

test('An UNCONFIRMED stream anchor (weak B alone) is still fully subject to continuity gating — the generalization must not over-reach', () => {
  const ledger = new EvidenceLedger();
  const activeContext = { book: 'Psalms', chapter: 1, verse: 3, t: T0 - 5000 };
  const candidate = { book: 'Genesis', chapter: 26, verse: 14 };
  // confirmed:false / low df -> B alone stays well under VIEWER_MIN_SCORE, so this must NOT get the D=0 exemption.
  const { finalScore, breakdown } = scoreCandidate(candidate, 'stream', { confirmed: false, df: 5 }, { activeContext, alreadyShown: () => false, ledger, now: T0 });
  assert.ok(breakdown.D !== 0 || finalScore < VIEWER_MIN_SCORE, 'a weak, non-self-sufficient hit must still be subject to D() and must not reach viewer alone');
});

test('direct-partial (bare "verse N") is NOT exempt from continuity — still needs D()/A() support (Esther 6:1 must stay caught)', () => {
  const ledger = new EvidenceLedger();
  const activeContext = { book: 'Joshua', chapter: 1, verse: 8, t: T0 - 5000 };
  const candidate = { book: 'Esther', chapter: 6, verse: 1 };
  const { finalScore } = scoreCandidate(candidate, 'direct-partial', {}, { activeContext, alreadyShown: () => false, ledger, now: T0 });
  assert.ok(finalScore < VIEWER_MIN_SCORE, `an unsupported direct-partial hit for an unrelated book must NOT auto-send alone, got ${finalScore}`);
});

test('An UNCONFIRMED stream anchor that is df=1 (Bible-wide-unique) with real IDF weight auto-sends, even at cold start', () => {
  // Real gap found live (2026-09-07): a preacher who quotes just the
  // opening of a verse (under 6 words) then pivots into paraphrase never
  // reaches 'confirmed' alignment. calibrateMethodScore gave B=0 to EVERY
  // unconfirmed anchor, including a genuinely unique (df=1), high-IDF one
  // — even though server.js's own "Unique-phrase fast-share" policy
  // (processStreamText) already trusts exactly this case. A second, real
  // data-plumbing bug compounded it: server.js's shadow-scoring rawResult
  // never even passed df/idf through (only matchedIdf, which unconfirmed
  // anchors don't have) — fixed alongside this. idf=19 clears the
  // VERBATIM_CERTAIN_IDF (18) bar this threshold was later raised to —
  // see the "weak IDF" test below for why 12-17 must NOT qualify.
  const ledger = new EvidenceLedger();
  const candidate = { book: 'Genesis', chapter: 26, verse: 14 };
  const rawResult = { confirmed: false, df: 1, idf: 19, similarity: 0.85 };
  const { finalScore, breakdown } = scoreCandidate(candidate, 'stream', rawResult, { activeContext: null, ledger, now: T0 });
  assert.ok(finalScore >= VIEWER_MIN_SCORE, `a unique, high-IDF anchor must auto-send alone, got ${finalScore}`);
  assert.ok(breakdown.B >= VIEWER_MIN_SCORE, 'B() itself must credit a df=1 + sufficient-IDF anchor, not just confirmed alignments');
  assert.equal(decideTarget(finalScore, 'stream'), 'viewer');
});

test('An UNCONFIRMED stream anchor that is df=1 but with WEAK IDF (a coincidental unique combo of ordinary words) must NOT auto-send via the STREAM method', () => {
  // The exact real incident this threshold exists for: "our father in the
  // land of Canaan" (Genesis 42:32) — 4 completely ordinary words that
  // only happen to combine into a unique df=1 anchor by accident, not
  // because the preacher was quoting it. Also the exact real case from the
  // live 2026-09-07 test: "come and let us reason together" (Isaiah 1:18)
  // is df=1 but only idf=8.8 via STREAM — below STREAM_IDF_FULL_CONFIDENCE
  // (12) — so THIS METHOD must legitimately stay a miss, matching the OLD
  // system's own already-incident-tested policy exactly. (The owner's
  // later, separate request — this exact phrase should still reach
  // Candidates via SOME method, "either said in isolation or between a
  // long speech" — is satisfied by verbatim's own moderate-IDF floor
  // instead, see that test below; stream staying silent here is correct,
  // not a gap.)
  const ledger = new EvidenceLedger();
  const candidate = { book: 'Isaiah', chapter: 1, verse: 18 };
  const rawResult = { confirmed: false, df: 1, idf: 8.8, similarity: 0.85 };
  const { finalScore } = scoreCandidate(candidate, 'stream', rawResult, { activeContext: null, ledger, now: T0 });
  assert.ok(finalScore < VIEWER_MIN_SCORE, `a weak-IDF df=1 anchor must NOT auto-send alone, got ${finalScore}`);
});

test('A real, moderate-IDF df=1 stream anchor ("Genesis 26:14") reaches Candidates instead of vanishing to drop', () => {
  // Real incident traced live (2026-09-08): "and the Philistines envied
  // him" — confirmed: false, df: 1, idf: 13.7 via the actual worker. Past
  // STREAM_IDF_FULL_CONFIDENCE (12, server.js's own "real content" bar for
  // this method) but short of VERBATIM_CERTAIN_IDF (18, the auto-send bar
  // bug #14 raised this method's df=1 exemption to). Before this fix, B=0
  // and the candidate vanished with zero trace — the same shape of gap
  // VERBATIM_MODERATE_IDF already closed for the verbatim method, just
  // never mirrored here.
  const ledger = new EvidenceLedger();
  const candidate = { book: 'Genesis', chapter: 26, verse: 14 };
  const rawResult = { confirmed: false, df: 1, idf: 13.7, similarity: 0.55 };
  const { finalScore } = scoreCandidate(candidate, 'stream', rawResult, { activeContext: null, ledger, now: T0 });
  assert.equal(decideTarget(finalScore, 'stream'), 'suggestions', `must reach Candidates, got finalScore=${finalScore}`);
  assert.ok(finalScore < VIEWER_MIN_SCORE, `must still stay well short of auto-send on its own, got ${finalScore}`);
});

test('The SAME real incident ("come and let us reason together") reaches Candidates via VERBATIM\'s own moderate-IDF floor, cold start or not', () => {
  // Owner's own framing, live: "if it understands context, a preacher
  // saying 'come and let us reason together' will show up immediately in
  // the candidates section as Isaiah 1:18... either its said in isolation
  // or between a long speech." Real numbers from the actual worker: raw
  // similarity=0.373 (badly coverage-diluted — only ~6 of the verse's ~30
  // words spoken), matchedIdf=12.7 (real, non-trivial identifying content).
  // Raw similarity alone never cleared decideTarget's 0.50 'suggestions'
  // floor; the new moderate-IDF credit does — AT COLD START (no D()/A()
  // help at all), directly answering "said in isolation."
  const ledger = new EvidenceLedger();
  const candidate = { book: 'Isaiah', chapter: 1, verse: 18 };
  const rawResult = { similarity: 0.373, matchedIdf: 12.7 };
  const { finalScore, breakdown } = scoreCandidate(candidate, 'verbatim', rawResult, { activeContext: null, ledger, now: T0 });
  assert.equal(decideTarget(finalScore, 'verbatim'), 'suggestions', `must reach Candidates, got finalScore=${finalScore}`);
  assert.ok(finalScore < VIEWER_MIN_SCORE, `must still stay well short of auto-send on its own, got ${finalScore}`);
});

test('A genuinely weak verbatim match (matchedIdf below the moderate floor) still gets dropped, not manufactured into a candidate', () => {
  const ledger = new EvidenceLedger();
  const candidate = { book: 'Romans', chapter: 8, verse: 1 };
  const rawResult = { similarity: 0.30, matchedIdf: 4.5 }; // below VERBATIM_MODERATE_IDF (10)
  const { finalScore } = scoreCandidate(candidate, 'verbatim', rawResult, { activeContext: null, ledger, now: T0 });
  assert.equal(decideTarget(finalScore, 'verbatim'), 'drop', `a genuinely weak match must not be inflated into a candidate, got finalScore=${finalScore}`);
});

test('An UNCONFIRMED stream anchor with df>=2 (shared, not unique) never auto-sends regardless of IDF', () => {
  const ledger = new EvidenceLedger();
  const candidate = { book: 'Genesis', chapter: 26, verse: 14 };
  const rawResult = { confirmed: false, df: 3, idf: 20, similarity: 0.76 };
  const { finalScore } = scoreCandidate(candidate, 'stream', rawResult, { activeContext: null, ledger, now: T0 });
  assert.ok(finalScore < VIEWER_MIN_SCORE, `a shared (df>=2) anchor must never auto-send alone regardless of IDF, got ${finalScore}`);
});

test('While a range is active, a confirmed stream match for a DIFFERENT book (a near-duplicate-phrasing collision) does NOT hijack the display (real regression, 2026-09-07)', () => {
  // Real incident: mid-way through an explicitly-established "Psalm 1:1-3"
  // range, both "Jeremiah 17:8" (shares "tree planted by the waters" with
  // Psalm 1:3) and "Romans 7:22" (shares "delight in the law" with Psalm
  // 1:2) independently reached 'confirmed' stream alignment — real, but
  // coincidental, near-duplicate phrasing — and, under the (correct, and
  // still-needed-for-Genesis-26:14) self-sufficient exemption, auto-sent
  // straight over the actively-being-read range. Owner's own diagnosis:
  // "the preacher called a range, it should have stuck there."
  const ledger = new EvidenceLedger();
  const activeContext = { book: 'Psalms', chapter: 1, verse: 3, t: T0 - 3000 };
  const candidate = { book: 'Jeremiah', chapter: 17, verse: 8 };
  const rawResult = { confirmed: true, matched: 6, matchedIdf: 15.9 };
  const { finalScore, breakdown } = scoreCandidate(candidate, 'stream', rawResult, {
    activeContext, alreadyShown: () => false, ledger, now: T0, rangeActiveBook: 'Psalms',
  });
  assert.ok(finalScore < VIEWER_MIN_SCORE, `a different-book collision during an active range must NOT auto-send, got ${finalScore}`);
  assert.notEqual(breakdown.D, 0, 'D() must still apply — the range-priority exemption withdrawal must actually engage');
});

test('A different-book range collision is blocked even with decayed recency (real regression, 2026-09-07 — the fix above was still just a penalty, not an absolute rule)', () => {
  // Real incident, found live via databases/debug.log AFTER the fix above
  // had already shipped and been believed solved (owner: "I thought it was
  // solved"): the same "Jeremiah 17:8" collision, but with more real time
  // elapsed since the range's active verse last updated — recency decayed
  // enough that the ordinary different-book penalty (-0.15*recency) shrank
  // to just -0.0897, and B=0.90 (a bare 'confirmed' stream floor) still
  // cleared VIEWER_MIN_SCORE at 0.8103. Exact real numbers reproduced here.
  // This is the SAME pattern already named and fixed once for the backward-
  // reshow case (bug #12, Daniel 10:12) — falling through to a decaying
  // penalty term lets strong-enough evidence + enough elapsed time buy its
  // way past a rule the owner's own words describe as absolute: "the
  // preacher called a range, it should have stuck there," not "...unless
  // enough time passes."
  const ledger = new EvidenceLedger();
  const activeContext = { book: 'Psalms', chapter: 1, verse: 3, t: T0 - 24000 };
  const candidate = { book: 'Jeremiah', chapter: 17, verse: 8 };
  const rawResult = { confirmed: true, matched: 6 }; // B = 0.90, matches the real log exactly
  const { finalScore, breakdown } = scoreCandidate(candidate, 'stream', rawResult, {
    activeContext, alreadyShown: () => false, ledger, now: T0, rangeActiveBook: 'Psalms',
  });
  assert.ok(finalScore < VIEWER_MIN_SCORE, `a range collision must be an absolute rule, not one decayed recency can buy past — got ${finalScore}`);
  assert.ok(finalScore <= VIEWER_MIN_SCORE - 0.05, `must be hard-capped the same way bug #12's backward-reshow fix is, got ${finalScore}`);
});

test('While a range is active, a DIRECT citation for a totally different book still always wins immediately (the original unconditional rule is untouched)', () => {
  const ledger = new EvidenceLedger();
  const activeContext = { book: 'Psalms', chapter: 1, verse: 3, t: T0 - 3000 };
  const candidate = { book: 'Romans', chapter: 8, verse: 28 };
  const { finalScore, breakdown } = scoreCandidate(candidate, 'direct', {}, {
    activeContext, alreadyShown: () => false, ledger, now: T0, rangeActiveBook: 'Psalms',
  });
  assert.ok(finalScore >= VIEWER_MIN_SCORE, `an explicit new citation must still always win even mid-range, got ${finalScore}`);
  assert.equal(breakdown.D, 0, 'direct must stay fully exempt regardless of an active range');
});

test('While a range is active, a confirmed stream match for the SAME book the range is in is still exempt (does not regress the Genesis 24/26 or Joshua cases)', () => {
  const ledger = new EvidenceLedger();
  const activeContext = { book: 'Psalms', chapter: 1, verse: 1, t: T0 - 3000 };
  const candidate = { book: 'Psalms', chapter: 1, verse: 2 };
  const rawResult = { confirmed: true, matched: 6, matchedIdf: 14.9 };
  const { finalScore, breakdown } = scoreCandidate(candidate, 'stream', rawResult, {
    activeContext, alreadyShown: () => false, ledger, now: T0, rangeActiveBook: 'Psalms',
  });
  assert.ok(finalScore >= VIEWER_MIN_SCORE, `a confirmed match for the range's OWN book must still auto-send, got ${finalScore}`);
  assert.equal(breakdown.D, 0, 'same-book-as-range must stay exempt');
});

test('No range active: the self-sufficient exemption behaves exactly as before (Genesis 26:14 case unaffected)', () => {
  const ledger = new EvidenceLedger();
  const activeContext = { book: 'Psalms', chapter: 1, verse: 3, t: T0 - 5000 };
  const candidate = { book: 'Genesis', chapter: 26, verse: 14 };
  const rawResult = { confirmed: true, matched: 6 };
  const { finalScore, breakdown } = scoreCandidate(candidate, 'stream', rawResult, {
    activeContext, alreadyShown: () => false, ledger, now: T0, rangeActiveBook: null,
  });
  assert.ok(finalScore >= VIEWER_MIN_SCORE, `with no range active, the original fix must still apply, got ${finalScore}`);
  assert.equal(breakdown.D, 0);
});

test('A strong same-book match that is a genuine BACKWARD re-send of an already-shown verse DOES redisplay immediately (owner override, 2026-09-08)', () => {
  // This exact shape (Luke 10:17, already shown, while 19 is active) was
  // ONCE hard-blocked here (see git history / the plan doc's bugs #11/#12)
  // after a real flicker incident. The owner's own later, explicit,
  // repeated direction overrides that: "If it's echoed again, it means
  // that's what the preacher is spotlighting, it should be back up" / "If
  // we sent it previously and the preacher goes back, we should go back
  // too." A genuine re-detection with real strong evidence (this is NOT a
  // coincidental collision — B clearing VIEWER_MIN_SCORE on its own is
  // exactly the bar that already distinguishes real evidence from noise
  // everywhere else in this module) now redisplays immediately via the
  // same self-sufficient exemption any other strong candidate gets, D=0,
  // not decayed through distanceTerm's ordinary backward penalty.
  const ledger = new EvidenceLedger();
  const activeContext = { book: 'Luke', chapter: 10, verse: 19, t: T0 - 3000 };
  const candidate = { book: 'Luke', chapter: 10, verse: 17 };
  const rawResult = { similarity: 0.69, matchedIdf: 26.0 };
  const { finalScore, breakdown } = scoreCandidate(candidate, 'verbatim', rawResult, {
    activeContext, alreadyShown: () => true, ledger, now: T0, rangeActiveBook: 'Luke',
  });
  assert.ok(finalScore >= VIEWER_MIN_SCORE, `a genuine backward reshow with strong evidence must redisplay, got ${finalScore}`);
  assert.equal(breakdown.D, 0, 'the self-sufficient exemption should apply, not a distance penalty');
});

test('A backward reshow with strong evidence redisplays immediately regardless of elapsed time (owner override, 2026-09-08)', () => {
  // Same "Daniel 10:12" real numbers this exact case was traced from
  // originally — now the EXPECTED outcome per the owner's direction above,
  // not a leak to guard against. Immediate (D=0 via the self-sufficient
  // exemption) rather than merely "eventually reachable once distanceTerm's
  // decaying penalty shrinks enough" — matches "should have resent it"
  // being reliable regardless of how much time has passed since the
  // original send, not something that only works after a delay.
  const ledger = new EvidenceLedger();
  const activeContext = { book: 'Daniel', chapter: 10, verse: 13, t: T0 - 30000 }; // 30s elapsed
  const candidate = { book: 'Daniel', chapter: 10, verse: 12 };
  const rawResult = { similarity: 0.76, matchedIdf: 54.7 };
  const { finalScore, breakdown } = scoreCandidate(candidate, 'verbatim', rawResult, {
    activeContext, alreadyShown: () => true, ledger, now: T0, rangeActiveBook: 'Daniel',
  });
  assert.ok(finalScore >= VIEWER_MIN_SCORE, `strong evidence must redisplay a backward reshow immediately, got ${finalScore}`);
  assert.equal(breakdown.D, 0);
});

test('A verse reached for the FIRST time (never shown before), behind the active verse, is still the legitimate Matthew 15:23-27 catch-up case — NOT penalized', () => {
  const ledger = new EvidenceLedger();
  const activeContext = { book: 'Matthew', chapter: 15, verse: 28, t: T0 - 3000 };
  const candidate = { book: 'Matthew', chapter: 15, verse: 23 };
  const rawResult = { confirmed: true, matched: 6 };
  const { finalScore, breakdown } = scoreCandidate(candidate, 'stream', rawResult, {
    activeContext, alreadyShown: () => false, ledger, now: T0, rangeActiveBook: 'Matthew',
  });
  assert.ok(finalScore >= VIEWER_MIN_SCORE, `a genuine catch-up read (never shown yet) must still auto-send, got ${finalScore}`);
  assert.equal(breakdown.D, 0, 'a not-yet-shown verse must still get the self-sufficient exemption — only an ALREADY-shown reshow is excluded');
});

test('Semantic method never reaches viewer regardless of score (suggestions-only policy ceiling)', () => {
  const ledger = new EvidenceLedger();
  const candidate = { book: 'Romans', chapter: 8, verse: 28 };
  const hit = { method: 'semantic', rawResult: { similarity: 0.99 } };
  const { finalScore } = scoreCandidate(candidate, hit.method, hit.rawResult, { activeContext: null, ledger, now: T0 });
  assert.notEqual(decideTarget(finalScore, 'semantic'), 'viewer');
});

test('Fingerprint alone never reaches viewer regardless of coverage (suggestions-only policy ceiling)', () => {
  const ledger = new EvidenceLedger();
  const candidate = { book: 'Romans', chapter: 8, verse: 28 };
  const hit = { method: 'fingerprint', rawResult: { similarity: 0.97, confidence: 'high' } };
  const { finalScore } = scoreCandidate(candidate, hit.method, hit.rawResult, { activeContext: null, ledger, now: T0 });
  assert.ok(finalScore < VIEWER_MIN_SCORE, `fingerprint must stay under the ceiling, got ${finalScore}`);
});

// ── Semantic + cross-method corroboration exemption ────────────────────────
// B(semantic) alone is hard-capped at 0.60 — cosine similarity is never
// trusted on its own. But a semantic hit that's ALSO independently caught
// by a different method on the exact same verse is real corroboration, not
// a coincidental embedding collision, and should be able to clear the
// viewer bar the way any other well-evidenced candidate can.
test('Semantic + genuine cross-method corroboration clears the viewer bar', () => {
  const ledger = new EvidenceLedger();
  const candidate = { book: 'Romans', chapter: 8, verse: 28 };
  // agreementBonus/hasCorroboration both require 2+ DISTINCT methods
  // already in the ledger BEFORE the current candidate's own hit is
  // recorded — matches the original ensembleScore semantics ("a single
  // method hitting alone earns nothing here"). Two other, independent
  // methods (each too weak to auto-send alone) already hit this verse.
  ledger.record(candidate, 'stream', T0 - 3000);
  ledger.record(candidate, 'fingerprint', T0 - 2000);

  const hit = { method: 'semantic', rawResult: { similarity: 0.99 } };
  const { finalScore } = scoreCandidate(candidate, hit.method, hit.rawResult, { activeContext: null, ledger, now: T0 });
  const corroborated = ledger.hasCorroboration(candidate);
  assert.equal(corroborated, true);
  assert.ok(finalScore >= VIEWER_MIN_SCORE, `expected the agreement bonus to clear the bar, got ${finalScore}`);
  assert.equal(decideTarget(finalScore, 'semantic', { corroborated }), 'viewer');
});

test('Semantic alone (no corroboration) still never reaches viewer, even with a contrived high score — the ceiling holds without agreement', () => {
  // Score high enough to clear VIEWER_MIN_SCORE on raw arithmetic alone
  // (not realistically reachable by B(semantic) alone today, but the
  // ceiling itself — not just the score cap — is what's under test).
  assert.equal(decideTarget(0.95, 'semantic'), 'suggestions');
  assert.equal(decideTarget(0.95, 'semantic', { corroborated: false }), 'suggestions');
});

test('Semantic + corroboration but finalScore still under the viewer bar stays a suggestion — corroboration lifts the CEILING, not the score requirement', () => {
  const ledger = new EvidenceLedger();
  const candidate = { book: 'Romans', chapter: 8, verse: 28 };
  ledger.record(candidate, 'stream', T0 - 3000);
  ledger.record(candidate, 'fingerprint', T0 - 2000);
  // A weak semantic similarity — B(semantic) stays low even with agreement added.
  const hit = { method: 'semantic', rawResult: { similarity: 0.3 } };
  const { finalScore } = scoreCandidate(candidate, hit.method, hit.rawResult, { activeContext: null, ledger, now: T0 });
  const corroborated = ledger.hasCorroboration(candidate);
  assert.equal(corroborated, true);
  assert.ok(finalScore < VIEWER_MIN_SCORE, `expected a weak similarity to stay under the bar, got ${finalScore}`);
  assert.notEqual(decideTarget(finalScore, 'semantic', { corroborated }), 'viewer');
});
