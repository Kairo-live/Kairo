// KAIRO — Behavior of the multi-stream citation voting (handleSecondaryFinal).
// Real basis (2026-09-24): identical audio transcribes ~15% differently per stream
// alignment, so extra streams rescue citations the primary stream missed — but a
// single extra stream is never trusted onto the live screen by itself.
//
//   KAIRO_EVAL_MODE=1 node server/stt_ensemble.test.js
'use strict';
const assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
if (!process.env.KAIRO_EVAL_MODE) { console.error('Set KAIRO_EVAL_MODE=1'); process.exit(1); }
const d = path.join(os.tmpdir(), `kairo-ensemble-test-${Date.now()}`);
fs.mkdirSync(d, { recursive: true });
fs.writeFileSync(path.join(d, 'settings.json'), JSON.stringify({ useUnifiedScoring: true }));
process.env.KAIRO_APP_DATA_DIR = d;
const server = require('./server');
const { referenceContext } = require('./reference_parser');
let pass = 0, fail = 0;
async function test(name, fn) { try { await fn(); pass++; console.log(`✔ ${name}`); } catch (e) { fail++; console.log(`✖ ${name}\n  ${e.message}`); } }
const fresh = () => { server.resetDetectionSession(); referenceContext.reset(); const out = []; server.onBroadcast(m => { if (m.type === 'detection' && m.verses?.length) out.push({ ref: m.verses[0].reference, target: m.target }); }); return out; };
const wait = ms => new Promise(r => setTimeout(r, ms));
(async () => {
  server.spawnDetectionWorker(); await server.workerReadyPromise; await wait(2500);

  await test('a citation only ONE extra stream heard goes to Candidates, never the live screen', async () => {
    const out = fresh();
    await server.handleSecondaryFinal('Deuteronomy 31 verse six. It says fear not.', 's1');
    await wait(200);
    assert.ok(out.some(o => o.ref === 'Deuteronomy 31:6' && o.target === 'suggestions'), JSON.stringify(out));
    assert.ok(!out.some(o => o.target === 'viewer'), 'must not reach the live screen: ' + JSON.stringify(out));
  });

  await test('two extra streams agreeing on the identical verse promotes it to the live screen', async () => {
    const out = fresh();
    await server.handleSecondaryFinal('Deuteronomy 31 verse six. It says fear not.', 's1');
    await server.handleSecondaryFinal('Deuteronomy thirty one verse six, fear not.', 's2');
    await wait(300);
    assert.ok(out.some(o => o.ref === 'Deuteronomy 31:6' && o.target === 'viewer'), JSON.stringify(out));
  });

  await test('a citation the primary stream already produced is ignored (no duplicate send)', async () => {
    const out = fresh();
    server.recordPrimaryCitation({ book: 'Deuteronomy', chapter: 31, verse: 6 });
    await server.handleSecondaryFinal('Deuteronomy 31 verse six.', 's1');
    await server.handleSecondaryFinal('Deuteronomy 31 verse six.', 's2');
    await wait(200);
    assert.equal(out.length, 0, JSON.stringify(out));
  });

  await test('a DIFFERENT chapter/verse from one extra stream never reaches the live screen (primary wins)', async () => {
    const out = fresh();
    server.recordPrimaryCitation({ book: 'Psalms', chapter: 125, ranges: [{ verseStart: 1, verseEnd: 1 }, { verseStart: 2, verseEnd: 2 }] });
    await server.handleSecondaryFinal('Psalm 120 verse five.', 's1');
    await wait(300);
    assert.ok(!out.some(o => o.target === 'viewer'), JSON.stringify(out));
  });

  await test('an extra stream hearing no citation does nothing', async () => {
    const out = fresh();
    await server.handleSecondaryFinal('When you understand who you are in Christ the devils become afraid.', 's1');
    await wait(200);
    assert.equal(out.length, 0, JSON.stringify(out));
  });

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})();
