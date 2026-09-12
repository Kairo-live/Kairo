// KAIRO — Regression test for the Isaiah 1:18/1:19 backward-reshow bug.
//
// Real live incident: "Isaiah 1:18" cited, sent to viewer. The preacher
// keeps reading and says "...verse 19" — the bare number correctly advances
// the display to Isaiah 1:19 via resolvePartialReference (method
// 'direct-partial'). Moments later the FINAL transcript's joined-segment
// reconstruction re-parses the WHOLE utterance — which still opens with
// "...verse 18..." — and extracts "Isaiah 1:18" as a fresh 'direct' hit (the
// first citation the parser finds in that joined text). Being 'direct', it
// unconditionally bypassed every gate, including the backward-already-shown
// hard cap every OTHER method is already subject to (bugs #11/#12) — so it
// silently dragged the display back to the verse BEFORE the one the
// preacher had already progressed past.
//
// The fix: a 'direct' hit for a verse BEHIND the currently active one, in
// the same book/chapter, where that behind verse was ALSO already shown
// before, is demoted rather than blindly trusted — the same accepted
// tradeoff bugs #11/#12 already apply to every non-direct method.
//
// Drives broadcastDetection directly (exported for exactly this kind of
// surgical test) — plain script, not node:test, matching this repo's other
// server.js-dependent tests (see ambiguous_refs.test.js's own comment for
// why: server.js's orphan-parent-process watchdog setInterval defeats
// node:test's process-isolation teardown even though every assertion
// passes).
//
//   KAIRO_EVAL_MODE=1 node server/direct_backward_reshow.test.js
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

if (!process.env.KAIRO_EVAL_MODE) {
  console.error('Set KAIRO_EVAL_MODE=1 — requiring server.js needs the module-boundary guard.');
  process.exit(1);
}

const appDataDir = path.join(require('os').tmpdir(), `kairo-direct-backward-test-${Date.now()}`);
fs.mkdirSync(appDataDir, { recursive: true });
// Deliberately NOT useUnifiedScoring — see corrected_away_reassert.test.js's
// own comment for why: this fix operates on the shared dedup/gating state
// (sentVerseKeysThisBook, lastOutputVerse) regardless of which scoring
// model decided `target`.
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

  await test('a joined-segment direct re-parse of an earlier, already-superseded verse does not drag the display backward', async () => {
    server.resetDetectionSession();
    const broadcasts = [];
    server.onBroadcast((msg) => { if (msg.type === 'detection') broadcasts.push(msg); });

    // Step 1: "Isaiah 1:18" cited explicitly, sent to viewer.
    const r1 = await server.broadcastDetection([verse('Isaiah', 1, 18)], 'direct', 0.93, 'viewer');
    assert.equal(r1, 'viewer');

    // Step 2: the preacher keeps reading, "...verse 19" bare-resolves and
    // correctly advances the display — this is direct-partial's own real
    // live path (server.js's interim bare-verse handler), reproduced here
    // directly against broadcastDetection the same way that call site does.
    const r2 = await server.broadcastDetection([verse('Isaiah', 1, 19)], 'direct-partial', 0.90, 'viewer');
    assert.equal(r2, 'viewer', 'the bare "verse 19" resolution must correctly advance the display');
    assert.equal(broadcasts.at(-1).verses[0].reference, 'Isaiah 1:19');

    // Step 3: THE ACTUAL BUG. A final-transcript joined-segment re-parse of
    // the whole utterance (which still opens with "...verse 18...") produces
    // a fresh 'direct' hit for the EARLIER verse again. Without the fix,
    // 'direct' blindly bypasses everything and drags the display back.
    const r3 = await server.broadcastDetection([verse('Isaiah', 1, 18)], 'direct', 0.93, 'viewer');
    assert.equal(r3, 'suggestions', 'a direct re-parse of an already-superseded EARLIER verse must be demoted, not drag the display backward');
    assert.equal(broadcasts.at(-1).verses[0].reference, 'Isaiah 1:18', 'the demoted candidate is still broadcast (visible to the operator), just not auto-sent');
    assert.equal(broadcasts.at(-1).target, 'suggestions');
  });

  await test('a genuinely later, fresh direct re-citation of a verse NOT yet shown is completely unaffected', async () => {
    server.resetDetectionSession();
    const broadcasts = [];
    server.onBroadcast((msg) => { if (msg.type === 'detection') broadcasts.push(msg); });

    await server.broadcastDetection([verse('Isaiah', 1, 18)], 'direct', 0.93, 'viewer');

    // A DIFFERENT, never-shown verse behind the active one (e.g. the
    // preacher backing up to re-read from an earlier point that was never
    // actually displayed) must still go through normally — this fix only
    // ever fires for a verse that was ALREADY shown before.
    const r = await server.broadcastDetection([verse('Isaiah', 1, 10)], 'direct', 0.93, 'viewer');
    assert.equal(r, 'viewer', 'a direct citation for a verse that was never shown before must not be blocked');
  });

  await test('a direct re-citation of a DIFFERENT book entirely is completely unaffected', async () => {
    server.resetDetectionSession();
    const broadcasts = [];
    server.onBroadcast((msg) => { if (msg.type === 'detection') broadcasts.push(msg); });

    await server.broadcastDetection([verse('Isaiah', 1, 18)], 'direct', 0.93, 'viewer');
    await server.broadcastDetection([verse('Isaiah', 1, 19)], 'direct-partial', 0.90, 'viewer');

    const r = await server.broadcastDetection([verse('Genesis', 1, 1)], 'direct', 0.93, 'viewer');
    assert.equal(r, 'viewer', 'an ordinary, unrelated direct citation for a different book must still auto-send immediately');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  fs.rmSync(appDataDir, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
