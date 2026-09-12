// KAIRO — Regression test for bug #25: a chain of successful bare "verse N"
// resolutions must refresh referenceContext's own expiry timer, not just
// spend down the timer set by the ORIGINAL explicit citation.
//
// Real incident (live, 2026-09-07), the SAME sermon this whole mechanism
// was built for: "1 Kings 19 and verse 4" (explicit citation) ... "verse
// 12" (resolves fine) ... "verse 15" (MISSED) — each individual gap was
// well within CONTEXT_EXPIRE_MS (45s), but cumulative elapsed time since
// the ORIGINAL citation exceeded it by the third hop, because nothing had
// ever refreshed the clock. referenceContext.update was only ever called
// from a full citation, never from a successful bare-verse resolution.
//
// Plain script, not node:test — see ambiguous_refs.test.js's own comment
// for why (server.js's orphan-parent-process watchdog setInterval defeats
// node:test's process-isolation teardown even though every assertion
// passes).
//
//   KAIRO_EVAL_MODE=1 node server/context_refresh_chain.test.js
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

if (!process.env.KAIRO_EVAL_MODE) {
  console.error('Set KAIRO_EVAL_MODE=1 — requiring server.js needs the module-boundary guard.');
  process.exit(1);
}

const appDataDir = path.join(require('os').tmpdir(), `kairo-context-refresh-test-${Date.now()}`);
fs.mkdirSync(appDataDir, { recursive: true });
fs.writeFileSync(path.join(appDataDir, 'settings.json'), JSON.stringify({ useUnifiedScoring: true }));
process.env.KAIRO_APP_DATA_DIR = appDataDir;

const server = require('./server');
const { referenceContext } = require('./reference_parser');

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

  await test('a 3-hop bare-verse chain (verse 4 -> 12 -> 15), each gap real but cumulative time exceeding CONTEXT_EXPIRE_MS from the ORIGINAL citation alone, still resolves every hop', async () => {
    server.resetDetectionSession();
    const broadcasts = [];
    server.onBroadcast((msg) => { if (msg.type === 'detection') broadcasts.push(msg); });

    // Hop 0: the explicit citation. Establishes referenceContext for real.
    await server.handleTranscriptSegment('First Kings 19 and verse four.', true, 0.9, true);
    await new Promise(r => setTimeout(r, 20));
    const t0 = referenceContext._updatedAt;
    assert.ok(t0 > 0, 'citation must set referenceContext._updatedAt');

    // Unrelated narration in between (matches the real incident — the
    // preacher narrated the wind/earthquake/fire passage between citing
    // "verse 4" and later saying "verse 12"). Also breaks
    // PREV_FINAL_JOIN_WINDOW_MS's join-retry so this test doesn't
    // accidentally mis-combine the citation with the next hop's text the
    // way an artificially-fast back-to-back call would.
    await server.handleTranscriptSegment('And a great wind rent the mountains, but God was not there.', true, 0.9, true);
    await new Promise(r => setTimeout(r, 20));

    // Simulate 40s of real elapsed time (well within the 45s window on its
    // own, but leaves little room to spare).
    referenceContext._updatedAt = t0 - 40000;

    // Hop 1: bare "verse 12" — must resolve.
    await server.handleTranscriptSegment('And verse 12 say, then a still small voice.', true, 0.9, true);
    await new Promise(r => setTimeout(r, 20));
    const hop1Sent = broadcasts.some(b => b.target === 'viewer' && b.verses?.[0]?.reference === '1 Kings 19:12');
    assert.ok(hop1Sent, 'hop 1 ("verse 12") must resolve and reach viewer');

    // THE ACTUAL BUG: without the fix, referenceContext._updatedAt would
    // STILL be t0-40000 here (never refreshed by the successful hop 1
    // resolution) — simulating another 40s from THAT stale timestamp would
    // put us 80s past the ORIGINAL citation, past CONTEXT_EXPIRE_MS, and
    // hop 2 would silently fail. With the fix, _updatedAt was refreshed
    // by hop 1's own success, so this simulated 40s is measured from THAT
    // fresh point instead.
    const afterHop1 = referenceContext._updatedAt;
    assert.ok(afterHop1 > t0 - 40000, 'referenceContext._updatedAt must have been refreshed by the successful bare-verse resolution, not left stale');

    // Break the join-retry window again before the next hop, same reason as above.
    await server.handleTranscriptSegment('And God paved the way forward for a man who would have killed himself.', true, 0.9, true);
    await new Promise(r => setTimeout(r, 20));

    referenceContext._updatedAt = afterHop1 - 40000;

    // Hop 2: bare "verse 15" — the exact real incident. Must STILL resolve,
    // even though 80s has now cumulatively elapsed since the ORIGINAL
    // citation (hop 0), because hop 1's success refreshed the clock.
    await server.handleTranscriptSegment('On verse 15, and God began to tell him what to do.', true, 0.9, true);
    await new Promise(r => setTimeout(r, 20));
    const hop2Sent = broadcasts.some(b => b.target === 'viewer' && b.verses?.[0]?.reference === '1 Kings 19:15');
    assert.ok(hop2Sent, 'hop 2 ("verse 15") must resolve and reach viewer — the real incident this test reproduces');
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  fs.rmSync(appDataDir, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
