// KAIRO — Regression tests for the mis-citation corrector (maybeCorrectMiscitation):
// a citation whose number was garbled is corrected toward the verse actually
// being read, but ordinary forward reading and formally-established ranges are
// never "corrected". (These cases used to be unit-tested against a parallel
// evaluateCorrection implementation that production never called; they now run
// against the real function.)
//
// Plain script, not node:test — see ambiguous_refs.test.js for why.
//   KAIRO_EVAL_MODE=1 node server/miscitation_correction.test.js
'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');

if (!process.env.KAIRO_EVAL_MODE) {
  console.error('Set KAIRO_EVAL_MODE=1 — requiring server.js needs the module-boundary guard.');
  process.exit(1);
}

const appDataDir = path.join(require('os').tmpdir(), `kairo-miscitation-test-${Date.now()}`);
fs.mkdirSync(appDataDir, { recursive: true });
fs.writeFileSync(path.join(appDataDir, 'settings.json'), JSON.stringify({}));
process.env.KAIRO_APP_DATA_DIR = appDataDir;

const server = require('./server');

let pass = 0;
let fail = 0;
async function test(name, fn) {
  try { await fn(); pass++; console.log(`✔ ${name}`); }
  catch (err) { fail++; console.log(`✖ ${name}`); console.log(`  ${err.message}`); }
}

const verse = (book, chapter, vs, extra = {}) => ({
  book, chapter, verse: vs, reference: `${book} ${chapter}:${vs}`, text: `placeholder ${book} ${chapter}:${vs}`, ...extra,
});
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const CORRECTION_IMMUNITY_WAIT_MS = 3200;   // maybeCorrectMiscitation ignores the first 3s after a citation

async function main() {
  server.spawnDetectionWorker();
  await server.workerReadyPromise;

  await test('Genesis 24:3 cited, 24:63 actually read: correction fires (a 60-verse jump is NOT continued reading)', async () => {
    server.resetDetectionSession();
    await server.broadcastDetection([verse('Genesis', 24, 3)], 'direct', 0.93, 'viewer');
    await sleep(CORRECTION_IMMUNITY_WAIT_MS);
    const fired = server.maybeCorrectMiscitation(verse('Genesis', 24, 63, { similarity: 0.97, matchedIdf: 20 }), null, []);
    assert.equal(!!fired, true);
  });

  await test('Genesis 24:3 cited, 24:5 actually read (small forward continuation): correction does NOT fire', async () => {
    server.resetDetectionSession();
    await server.broadcastDetection([verse('Genesis', 24, 3)], 'direct', 0.93, 'viewer');
    await sleep(CORRECTION_IMMUNITY_WAIT_MS);
    const fired = server.maybeCorrectMiscitation(verse('Genesis', 24, 5, { similarity: 0.97, matchedIdf: 20 }), null, []);
    assert.equal(!!fired, false);
  });

  await test('a verse inside a formally-established range is never "corrected" away, however far into it', async () => {
    server.resetDetectionSession();
    const range = Array.from({ length: 9 }, (_, i) => verse('Ezekiel', 47, i + 1));
    server.setRangeQueue(range);
    await server.broadcastDetection([range[0]], 'direct', 0.93, 'viewer');
    await sleep(CORRECTION_IMMUNITY_WAIT_MS);
    const fired = server.maybeCorrectMiscitation(verse('Ezekiel', 47, 9, { similarity: 0.98, matchedIdf: 20 }), null, []);
    assert.equal(!!fired, false);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  fs.rmSync(appDataDir, { recursive: true, force: true });
  process.exit(fail === 0 ? 0 : 1);
}
main().catch(err => { console.error(err); process.exit(1); });
