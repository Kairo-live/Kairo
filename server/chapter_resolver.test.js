// KAIRO — chapter_resolver.js: verse recovery inside a chapter the preacher named.
//   node --test server/chapter_resolver.test.js
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createChapterResolver, textAfterBookMention } = require('./chapter_resolver');

function fakeWorker(verseCount, scored = []) {
  return async (type, payload) => {
    if (type === 'chapterLookup') {
      return { results: Array.from({ length: verseCount }, (_, i) => ({ book: payload.book, chapter: payload.chapter, verse: i + 1, reference: `${payload.book} ${payload.chapter}:${i + 1}` })) };
    }
    if (type === 'scoreChapterText') return { results: scored };
    return {};
  };
}

test('the callout scan starts after the spoken book name, including the singular "Psalm" for Psalms', () => {
  assert.equal(textAfterBookMention('Point number two. 3, we must pray. Turn to Psalm 91. He that dwelleth', 'Psalms', 91).trim(), '91. He that dwelleth');
});

test('a number said BEFORE the citation is never taken as its verse (Psalm 91 after "3, we must pray")', async () => {
  const r = createChapterResolver({ workerCall: fakeWorker(16), getRecentText: () => '' });
  const got = await r.resolveChapterByKeywords('Psalms', 91, 'Point number two. 3, we must pray. Turn to Psalm 91. He that dwelleth in the secret place');
  assert.deepEqual(got, []);
});

test('a verse callout AFTER the citation is still found (Matthew 11, "28, all you that ...")', async () => {
  const r = createChapterResolver({ workerCall: fakeWorker(30), getRecentText: () => '' });
  const got = await r.resolveChapterByKeywords('Matthew', 11, 'In Matthew 11, say come to me. 28, all you that labour');
  assert.equal(got[0]?.verse, 28);
});

test('the IDF pick needs both a floor and a clear margin over the runner-up', async () => {
  const close = createChapterResolver({ workerCall: fakeWorker(10, [{ verse: 3, idfSum: 20, hit: 4, total: 9 }, { verse: 4, idfSum: 19, hit: 4, total: 9 }]), getRecentText: () => '' });
  assert.deepEqual(await close.resolveChapterByKeywords('Genesis', 1, 'no callout here'), []);
  const clear = createChapterResolver({ workerCall: fakeWorker(10, [{ verse: 3, idfSum: 20, hit: 4, total: 9 }, { verse: 4, idfSum: 5, hit: 1, total: 9 }]), getRecentText: () => '' });
  assert.equal((await clear.resolveChapterByKeywords('Genesis', 1, 'no callout here'))[0]?.verse, 3);
});
