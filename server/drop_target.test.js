// KAIRO — Regression test for the 'drop' target bypass bug.
//
// Real incident (live test, 2026-09-07): with useUnifiedScoring=true, the
// new B+D+A model correctly classifies many weak detections as 'drop' (its
// OWN, stricter-than-'suggestions' floor) — but server.js's only score gate
// only ever fired `if (target === 'suggestions' && topScore < ...)`. Once
// useUnifiedScoring overwrote `target` to 'drop', that check's own
// condition was simply false, so nothing rejected it — execution fell
// straight through to a real broadcast() call regardless of how low the
// score was. Confirmed directly: the owner's own Candidates panel
// screenshot showed 33%/39%/40% entries that should never have been
// visible at all (far below SUGGESTION_MIN_SCORE=0.87).
//
// Plain script, not node:test — see ambiguous_refs.test.js's own comment
// for why (server.js's orphan-parent-process watchdog setInterval defeats
// node:test's process-isolation teardown even though every assertion
// passes).
//
//   KAIRO_EVAL_MODE=1 node server/drop_target.test.js
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

if (!process.env.KAIRO_EVAL_MODE) {
  console.error('Set KAIRO_EVAL_MODE=1 — requiring server.js needs the module-boundary guard.');
  process.exit(1);
}

// Force useUnifiedScoring=true for this test regardless of the real
// settings.json, via an isolated app-data dir — same pattern the eval
// harness itself uses, so this test doesn't depend on (or mutate) the
// owner's actual settings.
const appDataDir = path.join(require('os').tmpdir(), `kairo-drop-target-test-${Date.now()}`);
fs.mkdirSync(appDataDir, { recursive: true });
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

async function main() {
  server.spawnDetectionWorker();
  await server.workerReadyPromise;

  await test('a weak, unrelated verbatim near-miss (well below SUGGESTION_MIN_SCORE) never reaches the Candidates panel under useUnifiedScoring=true', async () => {
    server.resetDetectionSession();
    const broadcasts = [];
    server.onBroadcast((msg) => { if (msg.type === 'detection') broadcasts.push(msg); });

    // Real incident text — a weak, coincidental partial overlap with
    // "2 Kings 7:18" (raw similarity ~33%, per the live log), nowhere near
    // a real quote of it.
    await server.handleTranscriptSegment(
      'so we are going to look at what happened next in the story of the king and his servants',
      true, 0.9, true
    );
    await new Promise(r => setTimeout(r, 20));

    const suggestionRefs = broadcasts.filter(b => b.target === 'suggestions').flatMap(b => (b.verses || []).map(v => v.reference));
    const weakOnes = broadcasts.filter(b => b.target === 'suggestions').flatMap(b => b.verses || []).filter(v => v.similarity != null && v.similarity < 0.87);
    assert.equal(weakOnes.length, 0, `no suggestion below 87% may ever reach the panel, but found: ${JSON.stringify(weakOnes.map(v => ({ ref: v.reference, sim: v.similarity })))}`);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  fs.rmSync(appDataDir, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
