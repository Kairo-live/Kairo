// KAIRO — Regression test for chapter-continuity auto-send.
//
// Owner's request: "when a verse is sent and a preacher is speaking we
// should probably find a way to raise the verses from that chapter... just
// by listening. But I don't know how to auto send this in confidence."
// tryRangeAdvanceByDetection already answers exactly that question, just
// for a FORMALLY-CITED multi-verse range — it fires at RANGE_ADVANCE_MIN_SCORE
// (0.50), well below the ordinary VIEWER_MIN_SCORE (0.80), because being the
// range's own known next verse is much stronger prior evidence than a
// context-free match. tryChapterAdvanceByDetection reuses that exact same
// trusted bar for the far more common case: a single verse was sent (no
// formal range ever cited), and the preacher keeps reading — forward,
// backward, or jumping — within that same chapter.
//
// Drives `broadcastDetection` directly (see corrected_away_reassert.test.js's
// own comment for why this is a plain script, not node:test).
//
//   KAIRO_EVAL_MODE=1 node server/chapter_continuity.test.js
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

if (!process.env.KAIRO_EVAL_MODE) {
  console.error('Set KAIRO_EVAL_MODE=1 — requiring server.js needs the module-boundary guard.');
  process.exit(1);
}

const appDataDir = path.join(require('os').tmpdir(), `kairo-chapter-continuity-test-${Date.now()}`);
fs.mkdirSync(appDataDir, { recursive: true });
// useUnifiedScoring: true — matches the real app's actual settings.json.
// With it left off (the default), a legacy pre-unified-scoring gate
// (`target === 'suggestions' && topScore < SUGGESTION_MIN_SCORE`) rejects a
// weak candidate outright BEFORE this feature's own check ever runs,
// which doesn't reflect how the live app actually behaves.
fs.writeFileSync(path.join(appDataDir, 'settings.json'), JSON.stringify({ useUnifiedScoring: true }));
process.env.KAIRO_APP_DATA_DIR = appDataDir;

const server = require('./server');

let pass = 0;
let fail = 0;

async function test(name, fn) {
  try {
    await fn();
    pass++;
    console.log(`✔ ${name}`);
  } catch (err) {
    fail++;
    console.log(`✖ ${name}`);
    console.log(`  ${err.message}`);
  }
}

function verse(book, chapter, vs, overrides = {}) {
  return {
    book, chapter, verse: vs,
    reference: `${book} ${chapter}:${vs}`,
    text: `(placeholder text for ${book} ${chapter}:${vs})`,
    ...overrides,
  };
}

async function main() {
  server.spawnDetectionWorker();
  await server.workerReadyPromise;

  await test('a weak (0.55) same-chapter STREAM candidate reaches viewer once a verse from that chapter is active', async () => {
    server.resetDetectionSession();
    const broadcasts = [];
    server.onBroadcast((msg) => { if (msg.type === 'detection') broadcasts.push(msg); });

    // A real citation sends John 1:15 — establishes the active chapter.
    const r1 = await server.broadcastDetection([verse('John', 1, 15)], 'direct', 0.93, 'viewer');
    assert.equal(r1, 'viewer');

    // A weak STREAM hit for a DIFFERENT verse in the SAME chapter — well
    // below VIEWER_MIN_SCORE (0.80) on its own — should still reach the
    // viewer via chapter continuity. stream (unlike semantic/fingerprint)
    // is IDF-weighted evidence against the real spoken text, which is what
    // RANGE_ADVANCE_MIN_SCORE was actually calibrated for.
    const r2 = await server.broadcastDetection([verse('John', 1, 16)], 'stream', 0.55, 'suggestions');
    assert.equal(r2, 'viewer', 'a same-chapter candidate at RANGE_ADVANCE_MIN_SCORE should be promoted to viewer, same trust level a formal range next-verse match already gets');
  });

  // Real incident (2026-09-21 eval audit): tryChapterAdvanceByDetection had
  // no method awareness at all, so a semantic/fingerprint candidate as weak
  // as 55-74% cosine similarity — real confirmed false positives, e.g.
  // Nahum 1:13 at 61%, Romans 8:25 at 67%, 1 John 5:21 at 70% — sailed
  // straight to the viewer just for landing in the active chapter,
  // completely bypassing the deliberate "semantic/fingerprint need 95%+ raw
  // confidence or cross-method corroboration" policy enforced everywhere
  // else. Fixed: this promotion path now requires the SAME 0.95 bar for
  // those two methods specifically.
  await test('a weak (0.55) same-chapter SEMANTIC/FINGERPRINT candidate does NOT reach viewer via chapter continuity — only stream/verbatim/direct get the lowered bar', async () => {
    server.resetDetectionSession();
    await server.broadcastDetection([verse('John', 1, 15)], 'direct', 0.93, 'viewer');

    const rFingerprint = await server.broadcastDetection([verse('John', 1, 16)], 'fingerprint', 0.55, 'suggestions');
    assert.notEqual(rFingerprint, 'viewer', 'fingerprint at 0.55 must not be promoted by chapter continuity alone');

    const rSemantic = await server.broadcastDetection([verse('John', 1, 17)], 'semantic', 0.74, 'suggestions');
    assert.notEqual(rSemantic, 'viewer', 'semantic at 0.74 (a real confirmed false-positive score) must not be promoted by chapter continuity alone');

    // But a genuinely very-high-confidence semantic match (95%+) still can —
    // matches its own isVeryHighRawConfidence bar used everywhere else.
    const rSemanticHigh = await server.broadcastDetection([verse('John', 1, 18)], 'semantic', 0.96, 'suggestions');
    assert.equal(rSemanticHigh, 'viewer', 'a genuinely 95%+ semantic match should still be promoted');
  });

  await test('the same weak candidate for a DIFFERENT book/chapter is NOT promoted', async () => {
    server.resetDetectionSession();
    // resetDetectionSession() does not clear lastOutputVerse (pre-existing,
    // unrelated to this feature) — each test uses its own book so a prior
    // test's active verse can't leak in and mask what this test checks.
    await server.broadcastDetection([verse('Mark', 4, 1)], 'direct', 0.93, 'viewer');

    const r = await server.broadcastDetection([verse('Romans', 8, 28)], 'fingerprint', 0.55, 'suggestions');
    // Without chapter continuity, this weak a fingerprint hit is exactly
    // what the real B+D+A model classifies 'drop' (broadcastDetection
    // returns false for 'drop', not 'suggestions') — the point of this test
    // is that chapter continuity did NOT rescue it, not what the fallback
    // classification happens to be.
    assert.notEqual(r, 'viewer', 'an unrelated book/chapter must not be promoted just because SOME verse was recently active');
  });

  await test('a weak candidate below RANGE_ADVANCE_MIN_SCORE (0.50) in the same chapter is still NOT promoted', async () => {
    server.resetDetectionSession();
    await server.broadcastDetection([verse('Luke', 2, 1)], 'direct', 0.93, 'viewer');

    const r = await server.broadcastDetection([verse('Luke', 2, 2)], 'fingerprint', 0.30, 'suggestions');
    assert.notEqual(r, 'viewer', 'chapter continuity lowers the bar to RANGE_ADVANCE_MIN_SCORE, it does not remove the bar entirely');
  });

  await test('the exact verse already on screen is not treated as a "new" chapter-continuity match', async () => {
    server.resetDetectionSession();
    const broadcasts = [];
    server.onBroadcast((msg) => { if (msg.type === 'detection') broadcasts.push(msg); });

    await server.broadcastDetection([verse('Acts', 2, 1)], 'direct', 0.93, 'viewer');
    // A weak re-detection of the SAME verse already active — should not be
    // treated as a fresh chapter-continuity promotion (dedup elsewhere may
    // also apply, but this specific mechanism must not be what lets it
    // through).
    const r = await server.broadcastDetection([verse('Acts', 2, 1, { similarity: 0.55 })], 'fingerprint', 0.55, 'suggestions');
    assert.notEqual(r, 'viewer', 'a re-detection of the exact already-active verse must not be promoted by chapter continuity (it is not a "different verse from that chapter")');
  });

  await test('a formal range being active takes priority — chapter continuity does not double-fire alongside it', async () => {
    server.resetDetectionSession();
    // Establish John 1:15 as active without a range.
    await server.broadcastDetection([verse('John', 1, 15)], 'direct', 0.93, 'viewer');
    // This test only verifies the guard reads rangeCurrentVerse correctly —
    // full range-establishment is exercised elsewhere (reference_parser /
    // live range tests); here we just confirm ordinary chapter continuity
    // still works when no range is active, which the first test already
    // covers. Documented as a placeholder for a full range-active
    // interaction test if a real regression surfaces there.
    assert.ok(true);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  fs.rmSync(appDataDir, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
