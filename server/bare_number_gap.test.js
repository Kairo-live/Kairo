// KAIRO — Regression test for maybeHandleBareVerseNumber's recency gate
// (BARE_NUMBER_MAX_GAP_MS, server.js).
//
// Real incident (2026-09-20/21 eval audit, shiloh2025-love-mystery.json):
// "And the fruit of the spirit has nine seeds" got split by the STT into
// "Is one of the nine" as its own final segment — its trailing "nine"
// coincidentally equalled lastOutputVerse.verse+1 (John 3:8 -> 9), a full
// 37 REAL seconds after John 3:8 was actually shown, in completely
// unrelated commentary. maybeHandleBareVerseNumber had no recency check at
// all on lastOutputVerse, so it fired and auto-sent "John 3:9".
//
// The offline eval harness (server/eval/run_eval.js) cannot validate this
// fix — it paces chunks with only a flat 15ms real delay, not real speech
// timing, so Date.now() barely advances across what's many "sermon
// seconds" of content; a wall-clock gap gate is effectively inert under
// that compression even though it's real, load-bearing logic in live use
// (confirmed directly: the harness still reproduced the wrong send with
// this fix in place). This test uses REAL elapsed time instead (it's slow,
// ~16s, by necessity) so the gate's actual behavior is genuinely exercised,
// not just theorized about.
//
// Plain script, not node:test — see ambiguous_refs.test.js's own comment
// for why (server.js's orphan-parent-process watchdog setInterval defeats
// node:test's process-isolation teardown even though every assertion
// passes).
//
//   KAIRO_EVAL_MODE=1 node server/bare_number_gap.test.js
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

if (!process.env.KAIRO_EVAL_MODE) {
  console.error('Set KAIRO_EVAL_MODE=1 — requiring server.js needs the module-boundary guard.');
  process.exit(1);
}

const appDataDir = path.join(require('os').tmpdir(), `kairo-bare-number-gap-test-${Date.now()}`);
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

  await test('a bare trailing number matching verse+1 does NOT auto-send once real time has moved well past BARE_NUMBER_MAX_GAP_MS (the real incident)', async () => {
    server.resetDetectionSession();
    const broadcasts = [];
    server.onBroadcast((msg) => { if (msg.type === 'detection') broadcasts.push(msg); });

    // Establish John 3:8 as the active verse via a real, confident citation.
    await server.handleTranscriptSegment('John chapter 3 verse 8.', true, 0.9, true);
    await new Promise(r => setTimeout(r, 200));
    const establishedJohn38 = broadcasts.some(b => b.target === 'viewer' && b.verses?.[0]?.reference === 'John 3:8');
    assert.ok(establishedJohn38, 'setup: John 3:8 must actually be established as the active verse first');

    // Real gap: BARE_NUMBER_MAX_GAP_MS is 15000ms — wait comfortably past it.
    await new Promise(r => setTimeout(r, 16000));

    broadcasts.length = 0;
    // Completely unrelated sentence whose trailing word happens to be "nine"
    // (=verse 8 + 1) — real incident's own shape.
    await server.handleTranscriptSegment('Is one of the nine', true, 0.9, true);
    await new Promise(r => setTimeout(r, 200));
    const wrongSend = broadcasts.some(b => b.target === 'viewer' && b.verses?.[0]?.reference === 'John 3:9');
    assert.ok(!wrongSend, 'must NOT auto-send "John 3:9" from a stale, coincidental trailing number');
  });

  await test('a genuine back-to-back bare-numbered verse continuation still works within the gap window (regression check)', async () => {
    server.resetDetectionSession();
    const broadcasts = [];
    server.onBroadcast((msg) => { if (msg.type === 'detection') broadcasts.push(msg); });

    await server.handleTranscriptSegment('Acts chapter 7 verse 50.', true, 0.9, true);
    await new Promise(r => setTimeout(r, 200));
    const established = broadcasts.some(b => b.target === 'viewer' && b.verses?.[0]?.reference === 'Acts 7:50');
    assert.ok(established, 'setup: Acts 7:50 must actually be established first');

    // Real, quick continuation — well within BARE_NUMBER_MAX_GAP_MS, but
    // past PREV_FINAL_JOIN_WINDOW_MS (8000ms) so the joined-segment retry
    // can't intercept it first — this isolates maybeHandleBareVerseNumber
    // specifically, rather than the citation parser's own separate
    // continuation logic.
    await new Promise(r => setTimeout(r, 8500));
    broadcasts.length = 0;
    await server.handleTranscriptSegment('so do you, 51', true, 0.9, true);
    await new Promise(r => setTimeout(r, 200));
    const rightSend = broadcasts.some(b => b.target === 'viewer' && b.verses?.[0]?.reference === 'Acts 7:51');
    assert.ok(rightSend, 'a genuine quick bare-number continuation must still auto-send');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  fs.rmSync(appDataDir, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
