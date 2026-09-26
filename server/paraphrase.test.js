// KAIRO — paraphrase windows and the offer/send decision.
//   node --test server/paraphrase.test.js
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { paraphraseWindows, hasQuoteSignal, decideParaphrase, PARAPHRASE_THRESHOLDS: T } = require('./paraphrase');

test('the words after a quote signal are searched on their own', () => {
  const w = paraphraseWindows('so many of you are tired this morning. But the Bible says come to me all you who are weary and I will give you rest.');
  assert.equal(w[0], 'come to me all you who are weary and I will give you rest.');
  assert.ok(w.length <= 4);
});

test('the last sentence and the last few seconds are searched', () => {
  const w = paraphraseWindows('we were talking about the offering earlier. God is able to do far more than all we ask or imagine by his power in us');
  assert.ok(w.some(x => x.startsWith('God is able')), JSON.stringify(w));
});

test('too little speech gives no window', () => {
  assert.deepEqual(paraphraseWindows('amen amen'), []);
});

test('quote signals', () => {
  assert.ok(hasQuoteSignal('and Jesus said to them'));
  assert.ok(hasQuoteSignal('as it is written'));
  assert.ok(hasQuoteSignal('Paul wrote to the Philippians'));
  assert.ok(!hasQuoteSignal('he said he would come back later'));
});

const cand = (ref, cos, rr, lexIdf) => ({ reference: ref, book: ref.split(' ')[0], chapter: 1, verse: 1, cos, rerankScore: rr, lexIdf });

test('every signal agreeing strongly goes to the screen', () => {
  const d = decideParaphrase([cand('Matthew 11:28', T.send.cos + 0.02, 0.995, T.send.lex + 10), cand('Numbers 11:17', 0.8, 0.02, 10)]);
  assert.equal(d.target, 'viewer');
  assert.equal(d.verse.reference, 'Matthew 11:28');
  assert.equal(d.key, 'Matthew|1|1');
});

test('little shared wording is only offered, never sent', () => {
  const d = decideParaphrase([cand('Matthew 11:28', T.send.cos + 0.02, 0.995, T.offer.lex + 1), cand('Numbers 11:17', 0.8, 0.02, 0)]);
  assert.equal(d.target, 'suggestions');
});

test('a passage already in play is offered on a lower bar', () => {
  const c = [cand('Genesis 24:63', 0.79, 0.96, 9)];
  assert.equal(decideParaphrase(c), null);
  assert.equal(decideParaphrase(c, { affinity: () => 2 }).target, 'suggestions');
});

test('two candidates the cross-encoder likes equally are not sent', () => {
  const d = decideParaphrase([cand('Matthew 6:33', 0.86, 0.99, 30), cand('Luke 12:31', 0.85, 0.98, 30)]);
  assert.equal(d.target, 'suggestions');
});

test('a weak match is not offered at all', () => {
  assert.equal(decideParaphrase([cand('Psalms 119:93', 0.77, 0.1, 5)]), null);
});

test('without a cross-encoder (non-English service) only offers, and needs shared wording', () => {
  assert.equal(decideParaphrase([cand('John 3:16', 0.9, null, 20)]).target, 'suggestions');
  assert.equal(decideParaphrase([cand('John 3:16', 0.9, null, 2)]), null);
});
