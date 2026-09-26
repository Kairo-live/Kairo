// KAIRO — search-box suggestions while the operator types (worker suggestPhrase).
// The right verse first whether the phrase is typed in order, in any order, or
// in other words; and nothing at all for phrases that don't identify a verse.
//   node --test server/search_suggest.test.js
'use strict';
const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { Worker } = require('worker_threads');
const path = require('path');

let worker, id = 0;
const pending = new Map();
const call = (type, p) => new Promise(r => { const i = ++id; pending.set(i, r); worker.postMessage({ type, id: i, ...p }); });
const suggest = async (query) => ((await call('suggestPhrase', { query, limit: 6 })).results || []).map(r => r.reference);

before(async () => {
  worker = new Worker(path.join(__dirname, 'detection_worker.js'), { workerData: { dataDir: path.join(__dirname, '..', 'databases', 'bibles') } });
  const ready = new Set();
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('worker not ready (semantic/reranker installed?)')), 240000);
    worker.on('message', (m) => {
      if (['ready', 'semanticReady', 'rerankerReady'].includes(m.type)) { ready.add(m.type); if (ready.size === 3) { clearTimeout(t); resolve(); } }
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
    });
  });
});
after(() => worker?.terminate());

const FIRST = [
  ['God so lov', 'John 3:16'],                         // half-typed last word
  ['loved world gave son', 'John 3:16'],               // any order
  ['weary heavy laden rest', 'Matthew 11:28'],
  ['renew strength eagles wings', 'Isaiah 40:31'],
  ['no weapon formed against', 'Isaiah 54:17'],
  ['things work together good', 'Romans 8:28'],        // a word missing in between
  ['do not worry about anything', 'Philippians 4:6'],  // modern wording (NLT)
  ['be still and know', 'Psalms 46:10'],               // common words, rare order
  ['I can do all', 'Philippians 4:13'],
  ['the lord is my shepherd', 'Psalms 23:1'],
  ['cast your cares on him', '1 Peter 5:7'],           // paraphrase
];
for (const [q, want] of FIRST) {
  test(`"${q}" suggests ${want} first`, async () => {
    const got = await suggest(q);
    assert.equal(got[0], want, JSON.stringify(got));
  });
}

test('a clear winner is shown alone, not with loosely related verses', async () => {
  assert.deepEqual(await suggest('the lord is my shepherd'), ['Psalms 23:1']);
  assert.deepEqual(await suggest('renew strength eagles wings'), ['Isaiah 40:31']);
});

for (const q of ['the lord is', 'thank you Jesus', 'welcome to church today', 'good morning church family']) {
  test(`"${q}" identifies no verse — nothing is suggested`, async () => {
    assert.deepEqual(await suggest(q), []);
  });
}

test('fewer than three words suggests nothing yet', async () => {
  assert.deepEqual(await suggest('God so'), []);
});
