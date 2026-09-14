// Regression tests for src/lyrics_follow.js — plain node:test, no server.js
// dependency (this module is pure client-side JS with a Node-compatible
// module.exports fallback), so no orphan-watchdog teardown issue.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { LyricsFollower } = require('./lyrics_follow.js');

// "Blessed Assurance" — the exact hymn used in tonight's live audio tests.
const SONG = {
  title: 'Blessed Assurance',
  blocks: [
    { label: 'Verse 1', lines: [
      'Blessed assurance, Jesus is mine!',
      'Oh, what a foretaste of glory divine!',
      'Heir of salvation, purchase of God,',
      'Born of His Spirit, washed in His blood.',
    ] },
    { label: 'Refrain', lines: [
      'This is my story, this is my song,',
      'Praising my Saviour all the day long.',
    ] },
  ],
};

// Builds a meta.words array (the {word, start, end} shape real STT engines
// use) for a line of text, spaced at wordsPerSec — i.e. REAL per-word
// timestamps, not wall-clock arrival time, matching what
// tokenizeKeysWithTimes/ingest expect.
function wordsFor(text, startAt, wordsPerSec) {
  const words = text.split(/\s+/).filter(Boolean);
  const dur = 1 / wordsPerSec;
  return words.map((w, i) => ({ word: w, start: startAt + i * dur, end: startAt + (i + 1) * dur }));
}

test('meta.words drives a real advance across a genuine hymn, using timestamp-based rate instead of wall-clock estimation', () => {
  const advances = [];
  const positions = [];
  const follower = new LyricsFollower(SONG, {
    onAdvance: (e) => advances.push(e),
    onPosition: (s) => positions.push(s),
  });

  // Verse 1, sung at a real ~2.5 words/sec — fed as one growing utterance,
  // the way a real streaming engine's words array would arrive.
  const v1 = 'Blessed assurance Jesus is mine oh what a foretaste of glory divine heir of salvation purchase of God born of his spirit washed in his blood';
  const w1 = wordsFor(v1, 0, 2.5);
  // Two ingest calls at real wall-clock times that DON'T match the real
  // audio pacing at all (simulating bursty/irregular ASR delivery) — if the
  // old wall-clock-estimation path were still driving `rate`, this would
  // badly mis-estimate tempo; the real per-word timestamps should keep it
  // accurate regardless of when ingest() happens to be called.
  follower.ingest(v1, { now: 50000, words: w1 });
  follower.ingest(v1, { now: 50050, words: w1 }); // arrives 50ms later in wall-clock, but same real audio

  const afterV1 = positions[positions.length - 1];
  assert.ok(afterV1.rate > 1.5 && afterV1.rate < 4, `rate should reflect the real ~2.5 wps pacing, got ${afterV1.rate}`);

  // Now sing the Refrain's real opening words — should catch up/advance.
  const ref = 'this is my story this is my song';
  const wref = wordsFor(ref, 10, 2.5);
  follower.ingest(v1 + ' ' + ref, { now: 50100, words: w1.concat(wref) });

  assert.equal(advances.length, 1, 'should have advanced exactly once, into the Refrain');
  assert.equal(advances[0].toBlockIdx, 1);
  assert.equal(advances[0].label, 'Refrain');
});

test('without meta.words, behavior is unchanged (falls back to wall-clock estimation)', () => {
  const advances = [];
  const follower = new LyricsFollower(SONG, { onAdvance: (e) => advances.push(e) });

  let clock = 0;
  const feed = (text) => { follower.ingest(text, { now: clock }); clock += 900; };
  const words = 'blessed assurance jesus is mine oh what a foretaste of glory divine heir of salvation purchase of god born of his spirit washed in his blood this is my story this is my song'.split(' ');
  for (let i = 3; i <= words.length; i += 3) feed(words.slice(0, i).join(' '));

  assert.equal(advances.length, 1);
  assert.equal(advances[0].toBlockIdx, 1);
});

test('a strong headHits match on the immediate next block advances even while confidence is frozen (anchor-confirm, no longer gated behind the continuous-tracking confidence check)', () => {
  const advances = [];
  const follower = new LyricsFollower(SONG, { onAdvance: (e) => advances.push(e) });

  // Feed pure noise first so confidence decays to 0 / frozen — this is the
  // exact failure mode from tonight's manual browser testing.
  follower.ingest('the quick brown fox jumps over the lazy dog nothing matches here at all', { now: 1000 });
  follower.ingest('completely unrelated words with zero overlap whatsoever today', { now: 2000 });
  assert.ok(follower.confidence < follower.cfg.confHold, 'confidence should be frozen after pure noise');

  // Now hear the Refrain's own distinctive opening words clearly, twice
  // (headHitsToCatchUp default is 2) — this alone should be enough to
  // advance, even though confidence never recovered from the noise above.
  follower.ingest('this is my story this is my song', { now: 3000 });

  assert.equal(advances.length, 1, 'a confirmed head-word anchor should advance regardless of frozen confidence');
  assert.equal(advances[0].toBlockIdx, 1);
});
