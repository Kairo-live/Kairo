// KAIRO — Regression test for context-based correction of an invalid verse
// number in an otherwise-valid citation.
//
// Real incident (live test, 2026-09-07, real Deepgram Nova-3 transcription
// of a real sermon): the preacher paraphrased "Isaac went to the field to
// meditate there" then cited "Genesis 24 and verse 83" — Genesis 24 only
// has 67 verses, so directLookup failed and the citation was silently
// dropped, even though the surrounding paraphrase clearly identifies the
// real verse (24:63: "And Isaac went out to meditate in the field"). Fixed
// with resolveInvalidVerseByContext (server.js): when a citation's chapter
// is valid but its own verse number isn't, search that chapter's own text
// against the recent transcript buffer instead of giving up.
//
// Plain script, not node:test — see ambiguous_refs.test.js's own comment
// for why (server.js's orphan-parent-process watchdog setInterval defeats
// node:test's process-isolation teardown even though every assertion
// passes).
//
//   KAIRO_EVAL_MODE=1 node server/invalid_verse_context.test.js
'use strict';

const assert = require('node:assert/strict');

if (!process.env.KAIRO_EVAL_MODE) {
  console.error('Set KAIRO_EVAL_MODE=1 — requiring server.js needs the module-boundary guard.');
  process.exit(1);
}

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

  await test('an invalid verse number ("Genesis 24:83", no such verse) resolves via surrounding context to the real verse (24:63)', async () => {
    server.resetDetectionSession();
    const broadcasts = [];
    server.onBroadcast((msg) => { if (msg.type === 'detection') broadcasts.push(msg); });

    const segments = [
      'art of thinking through scriptures in search of the way out of issues of concern in our lives',
      'and Isaac went to the field to meditate there',
      'Genesis 24 and verse 83.',
    ];
    for (const seg of segments) {
      await server.handleTranscriptSegment(seg, true, 0.9, true);
      await new Promise(r => setTimeout(r, 20));
    }

    const sent = broadcasts.filter(b => b.target === 'viewer').flatMap(b => (b.verses || []).map(v => v.reference));
    assert.ok(sent.includes('Genesis 24:63'), `expected "Genesis 24:63" among viewer sends, got ${JSON.stringify(sent)}`);
    assert.ok(!sent.includes('Genesis 24:83'), 'the invalid verse number itself must never be sent (it does not exist)');
  });

  await test('a genuinely valid verse number is never overridden by the context-correction fallback', async () => {
    server.resetDetectionSession();
    const broadcasts = [];
    server.onBroadcast((msg) => { if (msg.type === 'detection') broadcasts.push(msg); });

    await server.handleTranscriptSegment('For God so loved the world, John 3 and verse 16.', true, 0.9, true);
    await new Promise(r => setTimeout(r, 20));

    const sent = broadcasts.filter(b => b.target === 'viewer').flatMap(b => (b.verses || []).map(v => v.reference));
    assert.ok(sent.includes('John 3:16'), `a valid citation must resolve normally without going through the fallback at all, got ${JSON.stringify(sent)}`);
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch(err => { console.error(err); process.exit(1); });
