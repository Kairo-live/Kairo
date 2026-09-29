// Tests for src/motion_graphics.js: the editable settings of motion layers,
// the countdown state timer graphics follow, and how a pre-service countdown
// paces its scenes.
'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const M = require('./motion_graphics.js');

test('every kind has defaults that survive normalizing', () => {
  for (const k of M.kinds()) {
    const g = M.normalize(M.create(k.id));
    assert.equal(g.kind, k.id);
    assert.ok(g.colors.length >= k.colors.min && g.colors.length <= k.colors.max, `${k.id} colours`);
    for (const p of k.params) assert.notEqual(g[p.key], undefined, `${k.id}.${p.key}`);
  }
});

test('a hand-edited or older graphic is repaired, never thrown on', () => {
  const g = M.normalize({ kind: 'bokeh', colors: ['#fff', 'nope', 42], count: 9999, speed: -3, direction: 'sideways' });
  assert.deepEqual(g.colors, ['#fff']);
  assert.equal(g.count, 60);                 // clamped to the range
  assert.equal(g.speed, 0.1);
  assert.equal(g.direction, 'up');           // unknown option → default
  assert.equal(M.normalize(null).kind, 'aurora');
  assert.equal(M.normalize({ kind: 'no-such-kind' }).kind, 'aurora');
  // Too few colours for the kind: topped up from its defaults
  assert.equal(M.normalize({ kind: 'flow', colors: ['#000000'] }).colors.length, 3);
});

test('switching kind keeps the colours an operator chose', () => {
  const aurora = { ...M.create('aurora'), colors: ['#111111', '#222222', '#333333'] };
  assert.deepEqual(M.switchKind(aurora, 'bokeh').colors, ['#111111', '#222222', '#333333']);
  assert.deepEqual(M.switchKind(aurora, 'rays').colors, ['#111111', '#222222']);   // rays take two
  // Timer kinds keep their own fixed slots (progress, track, last minute, overtime)
  assert.equal(M.switchKind(aurora, 'ring').colors.length, 4);
});

test('countdown state: last minute, overtime and a cleared timer', () => {
  assert.deepEqual(M.timerState({ remainingMs: 300000, totalMs: 600000 }), { overtime: false, warning: false, remaining: 0.5, cleared: false });
  assert.equal(M.timerState({ remainingMs: 45000, totalMs: 600000 }).warning, true);
  const over = M.timerState({ remainingMs: -5000, totalMs: 600000 });
  assert.equal(over.overtime, true);
  assert.equal(over.warning, false);
  assert.equal(M.timerState({ remainingMs: 0, totalMs: 0, cleared: true }).remaining, 1);
});

test('build-ins default to none and keep delays and durations in range', () => {
  assert.deepEqual(M.normalizeBuild(undefined), { type: 'none', delay: 0, duration: 0.8 });
  assert.deepEqual(M.normalizeBuild({ type: 'blur', delay: 99, duration: 0 }), { type: 'blur', delay: 20, duration: 0.1 });
  assert.equal(M.normalizeBuild({ type: 'explode' }).type, 'none');
});

const scenes = (n) => Array.from({ length: n }, (_, i) => ({ id: 's' + i, durationSec: 20, layers: [] }));
const pace = { mode: 'countdown', maxSec: 30, finaleSec: 60 };

test('fixed pace: each scene runs its own duration, the last one holds', () => {
  const s = scenes(3);
  assert.equal(M.sceneAt(s, { mode: 'fixed' }, 5000, 600000).index, 0);
  assert.equal(M.sceneAt(s, { mode: 'fixed' }, 25000, 600000).index, 1);
  assert.equal(M.sceneAt(s, { mode: 'fixed' }, 500000, 600000).index, 2);
  assert.equal(M.sceneAt(s, undefined, 45000, 600000).index, 2);   // no pace saved: the original behaviour
});

test('countdown pace: the countdown sets how fast the scenes change', () => {
  // 12 scenes, the last one the finale. 6 minutes: 5 minutes shared by 11
  // scenes is about 27 s each, under the 30 s cap, so one pass.
  const s = scenes(12);
  const six = M.sceneAt(s, pace, 0, 360000);
  assert.equal(six.index, 0);
  assert.ok(Math.abs(six.slotMs - 300000 / 11) < 1, `slot ${six.slotMs}`);
  // Half the time: a 3-minute countdown moves twice as fast
  const three = M.sceneAt(s, pace, 0, 180000);
  assert.ok(three.slotMs < six.slotMs / 1.9, 'a shorter countdown changes scenes faster');
  // Every scene appears, in order, before the finale
  const seen = [];
  for (let e = 0; e < 300000; e += 1000) {
    const { index } = M.sceneAt(s, pace, e, 360000);
    if (seen[seen.length - 1] !== index) seen.push(index);
  }
  assert.deepEqual(seen, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
  // The final minute (and overtime) is the finale scene
  assert.equal(M.sceneAt(s, pace, 310000, 360000).index, 11);
  assert.equal(M.sceneAt(s, pace, 400000, 360000).index, 11);
});

test('countdown pace: a long countdown repeats the set instead of stalling', () => {
  // 30 minutes, 4 rotating scenes + finale: 29 min / (4 × 30 s) → 15 passes
  const s = scenes(5);
  const first = M.sceneAt(s, pace, 0, 1800000);
  assert.ok(first.slotMs <= 30000 && first.slotMs > 25000, `slot ${first.slotMs}`);
  const later = M.sceneAt(s, pace, first.slotMs * 4 + 10, 1800000);
  assert.equal(later.index, 0, 'back to the first scene after one pass');
  assert.equal(later.slot, 4, 'but counted as a new showing');
});

test('countdown pace: a short countdown never gives the finale more than a quarter', () => {
  const s = scenes(4);
  // 2 minutes: the finale gets 30 s (a quarter), not 60 s
  assert.equal(M.sceneAt(s, pace, 89000, 120000).index !== 3, true);
  assert.equal(M.sceneAt(s, pace, 91000, 120000).index, 3);
  // No finale: every scene rotates to the very end
  const noFinale = { ...pace, finaleSec: 0 };
  assert.notEqual(M.sceneAt(s, noFinale, 119000, 120000).index, undefined);
  assert.ok(M.sceneAt(s, noFinale, 119000, 120000).index < 4);
});
