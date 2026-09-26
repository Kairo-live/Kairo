// KAIRO — A preacher reading a modern translation aloud (the church's selected
// Bible) is matched against THAT wording, not only the KJV.
//   KAIRO_EVAL_MODE=1 node server/translation_matching.test.js
'use strict';
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
if (!process.env.KAIRO_EVAL_MODE) { console.error('Set KAIRO_EVAL_MODE=1'); process.exit(1); }
const dir = path.join(os.tmpdir(), `kairo-translation-${Date.now()}`);
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ translation: process.env.KAIRO_TEST_TRANSLATION || 'NIV' }));
process.env.KAIRO_APP_DATA_DIR = dir;
const server = require('./server');
const { referenceContext } = require('./reference_parser');
let pass = 0, fail = 0;
async function test(name, fn) { try { await fn(); pass++; console.log(`✔ ${name}`); } catch (e) { fail++; console.log(`✖ ${name}\n  ${e.message}`); } }
const wait = ms => new Promise(r => setTimeout(r, ms));
let sent = [];
server.onBroadcast(m => { if (m.type === 'detection') sent.push({ ref: m.verses[0].reference, target: m.target, method: m.method }); });
async function say(text) {
  const w = text.split(' ');
  for (let i = 3; i < w.length; i += 3) { await server.handleTranscriptSegment(w.slice(0, i).join(' '), false, 0.9, false); await wait(15); }
  await server.handleTranscriptSegment(text, true, 0.9, true); await wait(200);
}
(async () => {
  server.spawnDetectionWorker(); await server.workerReadyPromise; await wait(1500);
  const quotes = {
    'Philippians 4:6': 'Do not be anxious about anything, but in every situation, by prayer and petition, with thanksgiving, present your requests to God.',
    'Isaiah 41:10': 'So do not fear, for I am with you; do not be dismayed, for I am your God. I will strengthen you and help you; I will uphold you with my righteous right hand.',
  };
  for (const [ref, text] of Object.entries(quotes)) {
    await test(`an NIV reading of ${ref} reaches the screen when the church reads NIV`, async () => {
      server.resetDetectionSession(); referenceContext.reset(); sent = [];
      await say(text);
      const shown = sent.filter(s => s.target === 'viewer').map(s => s.ref);
      assert.ok(shown.includes(ref), `got ${JSON.stringify(sent)}`);
    });
  }
  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
