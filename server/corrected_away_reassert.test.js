// KAIRO — Regression test for the Joshua 1:18/1:8 correction-override bug.
//
// Real incident, from a real sermon eval run: a garbled interim 'direct'
// citation ("Joshua 1:18", really "1:8") sends to the viewer immediately
// ('direct' always bypasses every continuity/dedup guard by design). Two
// independent methods (stream+verbatim) then agree on the TRUE verse
// ("Joshua 1:8") and correctly override the stale active reference via the
// `[Guard] Overriding stale active reference...` mechanism. Moments later, a
// FINAL transcript segment re-parses the exact SAME underlying garbled words
// (a joined-segment reconstruction retry) and produces a FRESH 'direct' hit
// for "Joshua 1:18" again — same mishearing, not a new citation — which
// blindly bypassed every gate 'direct' is entitled to bypass and overwrote
// the correction that had just landed.
//
// The fix: `recentlyCorrectedAway` remembers the OLD reference a correction
// just superseded; a fresh 'direct' hit for that EXACT same reference, while
// the replacement is still the active one and within a short window, is
// demoted to Candidates instead of blindly overwriting the correction.
//
// Drives `broadcastDetection` directly (exported for exactly this kind of
// surgical test) rather than reconstructing real garbled ASR text through
// the full transcript pipeline — plain script, not node:test, matching this
// repo's other server.js-dependent tests (see ambiguous_refs.test.js's own
// comment for why: server.js's orphan-parent-process watchdog setInterval
// defeats node:test's process-isolation teardown even though every
// assertion passes).
//
//   KAIRO_EVAL_MODE=1 node server/corrected_away_reassert.test.js
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

if (!process.env.KAIRO_EVAL_MODE) {
  console.error('Set KAIRO_EVAL_MODE=1 — requiring server.js needs the module-boundary guard.');
  process.exit(1);
}

const appDataDir = path.join(require('os').tmpdir(), `kairo-corrected-away-test-${Date.now()}`);
fs.mkdirSync(appDataDir, { recursive: true });
// Deliberately NOT useUnifiedScoring — this fix operates on the shared
// dedup/gating state (recentlyCorrectedAway, lastDetectedRef) regardless of
// which scoring model decided `target`; testing against the OLD gate logic
// (the default) keeps the synthetic verse objects below simple, since they
// don't need to carry every field calibrateMethodScore's B+D+A model reads.
fs.writeFileSync(path.join(appDataDir, 'settings.json'), JSON.stringify({}));
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

  await test('a fresh direct re-parse of an already-corrected-away reference is demoted, not allowed to overwrite the correction', async () => {
    server.resetDetectionSession();
    const broadcasts = [];
    server.onBroadcast((msg) => { if (msg.type === 'detection') broadcasts.push(msg); });

    // Step 1: the garbled interim citation sends immediately (direct always
    // bypasses every gate).
    const r1 = await server.broadcastDetection(
      [verse('Joshua', 1, 18)], 'direct', 0.93, 'viewer'
    );
    assert.equal(r1, 'viewer', 'the initial garbled direct citation must reach the viewer, matching real behavior');
    assert.equal(broadcasts.at(-1).target, 'viewer');
    assert.equal(broadcasts.at(-1).verses[0].reference, 'Joshua 1:18');

    // Step 2: two independent methods agree on the TRUE verse, triggering
    // the cross-method stale-override guard. First hit alone: demoted
    // (methods.size still 1).
    const r2 = await server.broadcastDetection(
      [verse('Joshua', 1, 8, { similarity: 0.90 })], 'stream', 0.90, 'viewer'
    );
    assert.equal(r2, 'suggestions', 'a single non-direct hit against a freshly-active different reference must still be demoted first');

    // Second, independent method agreeing: this is what actually fires the
    // `[Guard] Overriding stale active reference` path and corrects the
    // display to Joshua 1:8.
    const r3 = await server.broadcastDetection(
      [verse('Joshua', 1, 8, { similarity: 0.90, matchedIdf: 19.8 })], 'verbatim', 0.90, 'viewer'
    );
    assert.equal(r3, 'viewer', 'cross-method agreement (stream+verbatim) must override the stale active reference and correct the display');
    assert.equal(broadcasts.at(-1).verses[0].reference, 'Joshua 1:8');

    // Step 3: THE ACTUAL BUG. A final-transcript re-parse of the SAME
    // underlying garbled words produces a fresh 'direct' hit for the exact
    // OLD reference again. Without the fix, this blindly overwrites the
    // correction that had just landed one call ago.
    const r4 = await server.broadcastDetection(
      [verse('Joshua', 1, 18)], 'direct', 0.93, 'viewer'
    );
    assert.equal(r4, 'suggestions', 'the fresh direct re-parse of the just-corrected-away reference must be demoted, not sent straight to the viewer');
    assert.equal(broadcasts.at(-1).verses[0].reference, 'Joshua 1:18', 'the demoted candidate is still broadcast (visible to the operator), just not auto-sent');
    assert.equal(broadcasts.at(-1).target, 'suggestions');
  });

  await test('a genuinely later direct citation for a DIFFERENT reference is completely unaffected', async () => {
    server.resetDetectionSession();
    const broadcasts = [];
    server.onBroadcast((msg) => { if (msg.type === 'detection') broadcasts.push(msg); });

    await server.broadcastDetection([verse('Joshua', 1, 18)], 'direct', 0.93, 'viewer');
    await server.broadcastDetection([verse('Joshua', 1, 8, { matchedIdf: 19.8 })], 'stream', 0.90, 'viewer');
    await server.broadcastDetection([verse('Joshua', 1, 8, { matchedIdf: 19.8 })], 'verbatim', 0.90, 'viewer');

    // A brand-new, unrelated direct citation must sail through exactly as
    // 'direct' always has — this fix must not over-reach into ordinary
    // citations that have nothing to do with a just-corrected reference.
    const r = await server.broadcastDetection([verse('Genesis', 1, 1)], 'direct', 0.93, 'viewer');
    assert.equal(r, 'viewer', 'an ordinary, unrelated direct citation must still auto-send immediately');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  fs.rmSync(appDataDir, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
