// KAIRO — Regression test for ambiguous numbered-book citation resolution.
// Real incident: "Timothy three one to five" (no "first"/"second") used to
// send BOTH "1 Timothy 3:1-5" and "2 Timothy 3:1-5" straight to the live
// viewer, one guaranteed wrong — confirmed directly in a real eval-harness
// run against real sermon audio. reference_parser.js's parseAllSpokenReferences
// correctly tags both as an `ambiguousGroup`; server.js's resolveAmbiguousRefs
// is what actually decides what to do with that ambiguity.
//
// Plain script, not node:test — requiring server.js pulls in its
// orphan-parent-process watchdog `setInterval`, which node:test's process
// isolation/teardown cannot reconcile ("Promise resolution is still pending
// but the event loop has already resolved"), even though every assertion
// passes. A plain script with explicit process.exit(0) sidesteps that
// entirely and was verified to run clean (exit code 0) beforehand.
//
//   KAIRO_EVAL_MODE=1 node server/ambiguous_refs.test.js
'use strict';

const assert = require('node:assert/strict');

if (!process.env.KAIRO_EVAL_MODE) {
  console.error('Set KAIRO_EVAL_MODE=1 — requiring server.js needs the module-boundary guard.');
  process.exit(1);
}

const { parseAllSpokenReferences, referenceContext } = require('./reference_parser');
const server = require('./server');

let pass = 0;
let fail = 0;

function test(name, fn) {
  try {
    fn();
    pass++;
    console.log(`✔ ${name}`);
  } catch (err) {
    fail++;
    console.log(`✖ ${name}`);
    console.log(`  ${err.message}`);
  }
}

test('bare "Timothy" with no active context: both variants held back, neither auto-sends', () => {
  referenceContext.reset();
  const refs = server.resolveAmbiguousRefs(parseAllSpokenReferences('timothy three one to five'));
  assert.equal(refs.length, 2);
  assert.ok(refs.every(r => r.ambiguousUnresolved === true));
  assert.deepEqual(refs.map(r => r.book).sort(), ['1 Timothy', '2 Timothy']);
});

test('bare "Timothy" with "2 Timothy" recently active: resolves to exactly one, the active one', () => {
  referenceContext.reset();
  referenceContext.update('2 Timothy', 2);
  const refs = server.resolveAmbiguousRefs(parseAllSpokenReferences('timothy three one to five'));
  assert.equal(refs.length, 1);
  assert.equal(refs[0].book, '2 Timothy');
  assert.equal(refs[0].ambiguousUnresolved, undefined);
});

test('bare "Timothy" with an UNRELATED book active (Romans): still held back, does not false-resolve', () => {
  referenceContext.reset();
  referenceContext.update('Romans', 8);
  const refs = server.resolveAmbiguousRefs(parseAllSpokenReferences('timothy three one to five'));
  assert.equal(refs.length, 2);
  assert.ok(refs.every(r => r.ambiguousUnresolved === true));
});

test('an explicit "first Timothy" (has its own prefix) is never treated as ambiguous', () => {
  referenceContext.reset();
  const refs = server.resolveAmbiguousRefs(parseAllSpokenReferences('first timothy three one to five'));
  assert.equal(refs.length, 1);
  assert.equal(refs[0].book, '1 Timothy');
  assert.equal(refs[0].ambiguousGroup, undefined);
});

test('non-ambiguous refs pass through resolveAmbiguousRefs unchanged', () => {
  referenceContext.reset();
  const refs = server.resolveAmbiguousRefs(parseAllSpokenReferences('john three sixteen'));
  assert.equal(refs.length, 1);
  assert.equal(refs[0].book, 'John');
});

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
