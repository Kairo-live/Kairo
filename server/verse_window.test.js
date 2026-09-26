// KAIRO — verse_window.js must give exactly the original brute-force answer.
//   node --test server/verse_window.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { longestWindow, bruteForceWindow } = require('./verse_window');

test('matches the brute-force search on 20,000 random verse/transcript pairs (incl. partial-word boundaries)', () => {
  const vocab = ['lord', 'god', 'love', 'lov', 'loved', 'the', 'and', 'of', 'shall', 'be', 'a', 'an', 'man', 'men', 'is', 'his', 'this', 'thi', 's', 'faith', 'fait', 'hope'];
  let seed = 42; const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let trial = 0; trial < 20000; trial++) {
    const V = 1 + rnd(30), T = 1 + rnd(30);
    const verse = Array.from({ length: V }, () => vocab[rnd(vocab.length)]);
    let t = Array.from({ length: T }, () => vocab[rnd(vocab.length)]);
    if (rnd(2)) { const s = rnd(V), l = 1 + rnd(V - s); t.splice(rnd(T), 0, ...verse.slice(s, s + l)); }   // plant a real run
    const minWords = 1 + rnd(7), cap = 1 + rnd(45);
    assert.deepEqual(longestWindow(verse, t, minWords, cap), bruteForceWindow(verse, t, minWords, cap), JSON.stringify({ verse, t, minWords, cap }));
  }
});
