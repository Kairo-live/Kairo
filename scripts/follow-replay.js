#!/usr/bin/env node
// Replay harness for the lyric follower (src/lyrics_follow.js) — the
// song-following equivalent of the sermon transcript replay used for
// scripture detection.
//
// It takes a song and a stream of "heard" words, feeds them to a
// LyricsFollower the way service.js will (growing partial windows, ~1s
// cadence), and prints every slide advance it decides on plus a final
// score against the ground truth (the block boundaries, in order).
//
// Usage:
//   node scripts/follow-replay.js --hymn "Amazing Grace" [options]
//   node scripts/follow-replay.js --song path/to/song.json [options]
//   node scripts/follow-replay.js --hymn "Holy, Holy, Holy" --transcript heard.txt
//
//   --wer 0.25        garble this fraction of words (drop / swap / dupe) —
//                     simulates sung-audio STT error. Default 0.15.
//   --wpm 80          words-per-minute the singers move at. Default 80.
//   --repeat-chorus   sing every "Chorus"/"Refrain" block twice (a real
//                     arrangement the follower has to not trip over).
//   --seed 1          RNG seed for reproducible WER. Default 1.
//   --transcript f    use f (one line = whatever was heard) instead of
//                     deriving the transcript from the song's own lyrics.
//   --verbose         print the position track, not just advances.
'use strict';

const fs = require('fs');
const path = require('path');
const { LyricsFollower, tokenizeKeys } = require('../src/lyrics_follow');

// ── args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flag = (n, d) => { const i = args.indexOf('--' + n); return i >= 0 && args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : d; };
const has = (n) => args.includes('--' + n);

const WER = parseFloat(flag('wer', '0.15'));
const WPM = parseFloat(flag('wpm', '80'));
const REPEAT_CHORUS = has('repeat-chorus');
const VERBOSE = has('verbose');
let seed = parseInt(flag('seed', '1'), 10);
function rnd() { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; }

// ── load the song ───────────────────────────────────────────────────────
let song;
if (flag('song')) {
  song = JSON.parse(fs.readFileSync(path.resolve(flag('song')), 'utf8'));
} else {
  const name = flag('hymn', 'Amazing Grace');
  const { HYMNS } = require('../src/hymns');
  song = HYMNS.find(h => h.title.toLowerCase().includes(name.toLowerCase()));
  if (!song) {
    console.error(`no built-in hymn matching "${name}". Available:\n  ` +
      HYMNS.map(h => h.title).join('\n  '));
    process.exit(1);
  }
}
console.log(`song: "${song.title}"  (${song.blocks.length} blocks)`);
song.blocks.forEach((b, i) => console.log(`  [${i}] ${b.label}  (${tokenizeKeys((b.lines || []).join(' ')).length} words)`));

// ── build the "sung" word stream ────────────────────────────────────────
// Each entry: { word, blockIdx }. Ground truth = the blockIdx sequence.
const sung = [];
const order = [];
song.blocks.forEach((b, bi) => {
  order.push(bi);
  if (REPEAT_CHORUS && /chorus|refrain/i.test(b.label)) order.push(bi);
});
if (flag('transcript')) {
  // Explicit transcript: we can't know true block boundaries, so score is
  // advance-count only.
  const raw = fs.readFileSync(path.resolve(flag('transcript')), 'utf8').split(/\s+/).filter(Boolean);
  raw.forEach(w => sung.push({ word: w, blockIdx: null }));
} else {
  order.forEach(bi => {
    (song.blocks[bi].lines || []).join(' ').split(/\s+/).filter(Boolean)
      .forEach(w => sung.push({ word: w, blockIdx: bi }));
  });
}

// ── inject word error ───────────────────────────────────────────────────
const GARBLE = ['yeah', 'oh', 'the', 'and', 'lord', 'we', 'now', 'come', 'sing'];
const heard = [];
for (const t of sung) {
  const r = rnd();
  if (r < WER * 0.4) continue;                                   // drop
  if (r < WER * 0.7) { heard.push({ ...t, word: GARBLE[(rnd() * GARBLE.length) | 0] }); continue; } // swap
  if (r < WER) { heard.push(t); heard.push({ ...t, word: GARBLE[(rnd() * GARBLE.length) | 0] }); continue; } // dupe+noise
  heard.push(t);
}

// ── run the follower the way service.js will ────────────────────────────
// service.js gets {type:'transcript', text, isFinal} where `text` is the
// current (growing) whisper window. Emulate: a window of the last ~14 words,
// pushed ~every (60/WPM * wordsPerTick) seconds.
const advances = [];
const track = [];
let clock = 0;
const follower = new LyricsFollower(song, {
  onAdvance: (e) => advances.push({ t: Math.round(clock), ...e }),
  onPosition: (s) => { if (VERBOSE) track.push({ t: Math.round(clock), ...s }); },
});

const WORDS_PER_TICK = 3;
const MS_PER_WORD = 60000 / WPM;
const WINDOW_WORDS = 14;
for (let i = 0; i < heard.length; i += WORDS_PER_TICK) {
  const upto = Math.min(heard.length, i + WORDS_PER_TICK);
  clock += MS_PER_WORD * (upto - i);
  const windowText = heard.slice(Math.max(0, upto - WINDOW_WORDS), upto).map(h => h.word).join(' ');
  follower.ingest(windowText, { now: clock, isFinal: false });
}

// ── report ──────────────────────────────────────────────────────────────
console.log(`\nfed ${heard.length} words @ ${WPM} wpm, WER≈${WER}` + (REPEAT_CHORUS ? ', chorus repeated' : ''));
console.log(`\nadvances (${advances.length}):`);
advances.forEach(a => console.log(`  ${(a.t / 1000).toFixed(1)}s  → block ${a.toBlockIdx} "${a.label}"  conf ${a.confidence.toFixed(2)}`));

if (sung.some(t => t.blockIdx !== null)) {
  // Ground truth: the distinct blocks in `order`, in order. The follower
  // should visit each in sequence. Score = how many boundaries it got,
  // and how many spurious ones it added.
  const wantSeq = order.filter((b, i) => i === 0 || b !== order[i - 1]); // collapse repeats
  const gotSeq = [0, ...advances.map(a => a.toBlockIdx)];
  let i = 0, hit = 0;
  for (const g of gotSeq) { if (g === wantSeq[i]) { hit++; i++; } }
  const recall = (i) / wantSeq.length;
  const spurious = gotSeq.length - hit;
  console.log(`\nground truth blocks in order: [${wantSeq.join(', ')}]`);
  console.log(`follower slide sequence:      [${gotSeq.join(', ')}]`);
  console.log(`\nboundaries reached in order: ${i - 1}/${wantSeq.length - 1}  (${((recall * 100) | 0)}%)`);
  console.log(`spurious / out-of-order advances: ${Math.max(0, spurious)}`);
}

if (VERBOSE) {
  console.log('\nposition track:');
  track.filter((_, i) => i % 3 === 0).forEach(s =>
    console.log(`  ${(s.t / 1000).toFixed(1)}s  b${s.blockIdx} ${(s.posInBlock * 100 | 0)}%  conf ${s.confidence.toFixed(2)}${s.armed ? ' [armed]' : ''}${s.frozen ? ' [frozen]' : ''}`));
}
